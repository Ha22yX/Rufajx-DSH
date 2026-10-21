"""Offline SW2016 batch host. Python supplied in the native reviewed tool call.

This is not a Python/OS sandbox. Native tool approval remains the security
boundary, exactly as for approved shell scripts. The SDK owns one fresh SW
process; it never attaches to a user's existing application.
"""
import contextlib
import io
import json
import math
import os
import queue
from pathlib import Path
import subprocess
import sys
import threading
import time
import traceback
import uuid

for stream in (sys.stdin, sys.stdout, sys.stderr):
    if hasattr(stream, 'reconfigure'):
        stream.reconfigure(encoding='utf-8')

ROOT = Path(__file__).resolve().parent
_dll_handles = []
for directory in [ROOT / 'lib', ROOT / 'lib/win32', ROOT / 'lib/win32/lib', ROOT / 'lib/pywin32_system32']:
    sys.path.insert(0, str(directory))
    if directory.is_dir() and hasattr(os, 'add_dll_directory'):
        _dll_handles.append(os.add_dll_directory(str(directory)))


def load_com():
    global pythoncom, win32com, VARIANT, NULL
    import pythoncom
    import win32com.client
    from win32com.client import VARIANT
    NULL = VARIANT(pythoncom.VT_DISPATCH, None)


def get(obj, name, *args):
    value = getattr(obj, name)
    return value if hasattr(value, '_oleobj_') and not args else value(*args) if callable(value) else value


def installation():
    import winreg
    candidates = []
    # Version-specific COM registration is authoritative; never activate COM just
    # to detect installation and never fall back silently to a newer SW release.
    try:
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, r'SldWorks.Application.24\CLSID') as key:
            clsid = winreg.QueryValueEx(key, None)[0]
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, 'CLSID\\' + clsid + r'\LocalServer32') as key:
            value = winreg.QueryValueEx(key, None)[0].strip()
        if value.startswith('"'):
            candidates.append(value.split('"')[1])
        elif '.exe' in value.lower():
            candidates.append(value[:value.lower().index('.exe') + 4])
    except FileNotFoundError:
        pass
    for hive in [winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER]:
        try:
            with winreg.OpenKey(hive, r'Software\SolidWorks\SOLIDWORKS 2016\Setup') as key:
                candidates.append(str(Path(winreg.QueryValueEx(key, 'SolidWorks Folder')[0]) / 'SLDWORKS.exe'))
        except FileNotFoundError:
            pass
    for value in candidates:
        path = Path(value)
        if path.is_file() and path.name.lower() == 'sldworks.exe':
            return path.resolve()
    raise RuntimeError('未检测到已注册的 SolidWorks 2016。请先完成其安装并确认能够正常启动。')


def process_ids():
    wmi = win32com.client.GetObject('winmgmts:')
    return {int(row.ProcessId) for row in wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='SLDWORKS.exe'")}


def process_creation(pid):
    wmi = win32com.client.GetObject('winmgmts:')
    for row in wmi.ExecQuery('SELECT CreationDate FROM Win32_Process WHERE ProcessId=' + str(int(pid))):
        return str(row.CreationDate)
    return None


def active_marker():
    return Path(os.environ['LOCALAPPDATA']) / 'RufaDSH/locks/solidworks-2016.active.json'


class Cancelled(RuntimeError):
    pass


class BoundedLog(io.TextIOBase):
    def __init__(self):
        self.value = ''
        self.truncated = False

    def write(self, text):
        self.truncated = self.truncated or len(self.value) + len(text) > 16000
        self.value = (self.value + text)[-16000:]
        return len(text)


class Cad:
    def __init__(self, request):
        self.request = request
        self.cwd = Path(request['cwd']).resolve(strict=True)
        self.state = Path(request['state']).resolve(strict=True)
        self.cancel = Path(request['cancel'])
        self.run_id = uuid.uuid4().hex
        self.run_dir = self.state / self.run_id
        self.run_dir.mkdir()
        self.report = {'schema': 1, 'runId': self.run_id, 'status': 'starting', 'checks': [], 'files': [], 'recoveryFiles': [], 'cleanup': False}
        self.app = None
        self.process = None
        self.registry = []
        self.finished = threading.Event()
        self.force_stop = False
        self.deadline = time.monotonic() + min(900, max(30, int(request.get('timeoutSeconds', 300))))

    def flush(self):
        pending = self.run_dir / 'report.pending'
        pending.write_text(json.dumps(self.report, ensure_ascii=False, indent=2), encoding='utf-8')
        pending.replace(self.run_dir / 'report.json')

    def check_cancel(self):
        if self.cancel.exists() or time.monotonic() >= self.deadline:
            raise Cancelled('任务已停止或超时；请核对已保存文件，不要自动重放。')

    def check(self, name, passed, **details):
        self.check_cancel()
        self.report['checks'].append({'name': name, 'passed': bool(passed), **details})
        self.flush()
        if not passed:
            raise RuntimeError('建模核对未通过：' + name)

    def path(self, value):
        path = Path(value)
        if not path.is_absolute():
            path = self.cwd / path
        path = path.resolve()
        if not path.is_relative_to(self.cwd) or path == self.cwd or ':' in str(path.relative_to(self.cwd)):
            raise ValueError('建模文件必须位于当前会话工作文件夹。')
        # resolve() follows junctions/symlinks; check before creating parents.
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.parent.resolve().is_relative_to(self.cwd):
            raise ValueError('文件目录已改变。')
        return path

    def configure_recovery(self):
        import winreg
        for subkey, name, folder in [('ExtReferences', 'SolidWorks Journal Folders', 'journal'), ('General', 'AutoRecover Directory', 'recovery')]:
            keypath = r'Software\SolidWorks\SOLIDWORKS 2016' + '\\' + subkey
            destination = self.run_dir / folder
            destination.mkdir()
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, keypath, 0, winreg.KEY_READ | winreg.KEY_SET_VALUE) as key:
                try:
                    previous, kind = winreg.QueryValueEx(key, name)
                    existed = True
                except FileNotFoundError:
                    previous, kind, existed = '', winreg.REG_SZ, False
                entry = dict(key=keypath, name=name, previous=previous, kind=kind, existed=existed, temporary=str(destination))
                self.registry.append(entry)
                # Durable backup before changing the narrow startup setting.
                self.report['registryBackup'] = list(self.registry)
                self.flush()
                winreg.SetValueEx(key, name, 0, winreg.REG_SZ, str(destination))

    def restore_recovery(self):
        import winreg
        checks = []
        for entry in self.registry:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, entry['key'], 0, winreg.KEY_READ | winreg.KEY_SET_VALUE) as key:
                try:
                    value, kind = winreg.QueryValueEx(key, entry['name'])
                except FileNotFoundError:
                    value, kind = None, None
                normalize = lambda p: os.path.normcase(os.path.normpath(str(p).replace('CURRENT_USER', Path.home().name)))
                if kind == winreg.REG_SZ and normalize(value) == normalize(entry['temporary']):
                    if entry['existed']:
                        winreg.SetValueEx(key, entry['name'], 0, entry['kind'], entry['previous'])
                    else:
                        winreg.DeleteValue(key, entry['name'])
                try:
                    value, kind = winreg.QueryValueEx(key, entry['name'])
                    restored = entry['existed'] and kind == entry['kind'] and value == entry['previous']
                except FileNotFoundError:
                    restored = not entry['existed']
                checks.append({'name': entry['name'], 'restored': restored, 'externalChangePreserved': not restored})
        # Keep the originals until ExitApp: SW writes its cached startup paths
        # back on exit even after an early registry restoration.
        self.report['registryRestoreChecks'] = checks
        self.report['registryRestored'] = all(row['restored'] for row in checks)
        self.flush()

    def watchdog(self):
        while not self.finished.wait(.25):
            if self.cancel.exists() or time.monotonic() >= self.deadline:
                # Give Python/API cleanup a chance first. Only the exact Popen
                # handle we created may be terminated if COM is wedged.
                if not self.finished.wait(8):
                    self.force_stop = True
                    if self.process and self.process.poll() is None:
                        self.process.terminate()
                return

    def trace(self, frame, event, arg):
        if event == 'line' and frame.f_code.co_filename == '<reviewed-solidworks-tool-call>':
            self.check_cancel()
        return self.trace

    def arm(self):
        threading.Thread(target=self.watchdog, daemon=True).start()

    def start(self):
        self.exe = installation()
        self.before = process_ids()
        self.report['preexistingPids'] = sorted(self.before)
        self.configure_recovery()
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        # Show the newly launched process without activating another window.
        # SW_HIDE can also conceal startup/licensing dialogs and override the
        # application's first ShowWindow call, even after setting Visible.
        startup.wShowWindow = 4  # SW_SHOWNOACTIVATE
        self.process = subprocess.Popen([str(self.exe)], startupinfo=startup)
        self.report['ownedPid'] = self.process.pid
        self.created = process_creation(self.process.pid)
        active_marker().write_text(json.dumps({'pid': self.process.pid, 'created': self.created}), encoding='utf-8')
        self.flush()
        self.arm()
        startup_deadline = min(self.deadline, time.monotonic() + 180)
        while time.monotonic() < startup_deadline:
            self.check_cancel()
            rot, bind = pythoncom.GetRunningObjectTable(), pythoncom.CreateBindCtx(0)
            for moniker in rot.EnumRunning():
                try:
                    if moniker.GetDisplayName(bind, None) == 'SolidWorks_PID_' + str(self.process.pid):
                        self.app = win32com.client.Dispatch(rot.GetObject(moniker).QueryInterface(pythoncom.IID_IDispatch))
                        break
                except pythoncom.com_error:
                    pass
            if self.app is not None or self.process.poll() is not None:
                break
            time.sleep(.25)
        if self.app is None:
            raise RuntimeError('独立 SolidWorks 2016 实例未就绪；可能有试用、许可或启动提示。未操作用户原来的窗口。')
        self.check('owned_process', int(get(self.app, 'GetProcessID')) == self.process.pid and self.process.pid not in self.before)
        # A ROT entry can appear before the UI/add-ins finish starting. Do not
        # change visibility or create documents while startup is still running.
        while time.monotonic() < startup_deadline and not bool(get(self.app, 'StartupProcessCompleted')):
            self.check_cancel()
            time.sleep(.25)
        self.check('startup_completed', bool(get(self.app, 'StartupProcessCompleted')))
        self.check('empty_owned_instance', not list(get(self.app, 'GetDocuments') or []))
        self.report['revision'] = str(get(self.app, 'RevisionNumber'))
        self.check('SW2016', self.report['revision'].startswith('24.'))
        # Set visibility only on the fresh SW2016 instance whose PID we verified.
        # Keep automation ownership: UserControl / existing user windows are
        # untouched, and finish() still cleans up only this batch's process.
        self.app.Visible = True
        self.check('visible_owned_instance', bool(get(self.app, 'Visible')))
        # SW reads its journal settings at startup; do not leave a global
        # preference changed during the rest of a potentially long CAD job.
        self.restore_recovery()
        self.report['status'] = 'running'
        self.flush()

    def template(self, kind):
        extensions = {'part': '.prtdot', 'assembly': '.asmdot', 'drawing': '.drwdot'}
        if kind not in extensions:
            raise ValueError('文档类型应为part、assembly或drawing。')
        ext = extensions[kind]
        directories = [Path(os.environ.get('PROGRAMDATA', 'C:/ProgramData')) / 'SolidWorks/SOLIDWORKS 2016/templates']
        directories += list((self.exe.parent / 'lang').glob('*/Tutorial'))
        names = {'part': ['gb_part.prtdot', 'Part.prtdot'], 'assembly': ['gb_assembly.asmdot', 'Assembly.asmdot', 'assem.asmdot'], 'drawing': ['gb_a4.drwdot', 'Drawing.drwdot', 'draw.drwdot']}[kind]
        for directory in directories:
            for name in names:
                if (directory / name).is_file():
                    return directory / name
            for path in sorted(directory.glob('*' + ext)):
                return path
        raise RuntimeError('未找到SW2016文档模板。请在SolidWorks中配置模板后重试。')

    def new(self, kind='part'):
        self.check_cancel()
        doc = self.app.NewDocument(str(self.template(kind)), 0, 0., 0.)
        self.check('new_' + kind, doc is not None)
        return doc

    def open(self, filename):
        path = self.path(filename)
        kind = {'.sldprt': 1, '.sldasm': 2, '.slddrw': 3}.get(path.suffix.lower())
        if not kind or not path.is_file():
            raise ValueError('open需要当前工作文件夹内已存在的SolidWorks零件、装配或工程图。')
        opened = get(self.app, 'GetOpenDocumentByName', str(path))
        if opened is not None:
            return opened
        e, w = VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0), VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)
        doc = self.app.OpenDoc6(str(path), kind, 1, '', e, w)
        self.check('open', doc is not None and e.value == 0, errors=e.value, warnings=w.value)
        self.check('opened_path', Path(get(doc, 'GetPathName')).resolve() == path)
        return doc

    def save(self, doc, filename, copy=False):
        self.check_cancel()
        path = self.path(filename)
        e, w = VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0), VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)
        ok = doc.Extension.SaveAs(str(path), 0, 3 if copy else 1, NULL, e, w)
        self.check('save', ok and e.value == 0 and path.is_file() and path.stat().st_size > 0, file=str(path), errors=e.value, warnings=w.value)
        self.report['files'].append(str(path))
        self.flush()
        return str(path)

    def reopen(self, doc, filename):
        self.app.CloseDoc(get(doc, 'GetPathName') or get(doc, 'GetTitle'))
        return self.open(filename)

    def features(self, doc):
        feature = get(doc, 'FirstFeature')
        while feature is not None:
            yield feature
            feature = get(feature, 'GetNextFeature')

    def sketch(self, doc, draw, name='Rufa_Profile', plane=0):
        doc.ClearSelection2(True)
        planes = [feature for feature in self.features(doc) if get(feature, 'GetTypeName2') == 'RefPlane']
        if isinstance(plane, int):
            self.check('select_plane', planes[plane].Select2(False, 0))
        else:
            self.check('select_plane', doc.Extension.SelectByID2(plane, 'PLANE', 0., 0., 0., False, 0, NULL, 0))
        doc.SketchManager.InsertSketch(True)
        entities = draw(doc.SketchManager)
        doc.ClearSelection2(True)
        doc.SketchManager.InsertSketch(True)
        feature = doc.FeatureByPositionReverse(0)
        self.check('sketch_created', feature is not None and get(feature, 'GetTypeName2') == 'ProfileFeature')
        feature.Name = name
        doc.ClearSelection2(True)
        feature.Select2(False, 0)
        return feature, entities

    def feature(self, feature, name):
        self.check(name + '_created', feature is not None)
        feature.Name = name
        warning = VARIANT(pythoncom.VT_BYREF | pythoncom.VT_BOOL, False)
        code = feature.GetErrorCode2(warning)
        self.check(name + '_valid', code == 0, error=code, warning=warning.value)
        return feature

    def extrude(self, doc, depth_mm, name='Rufa_Extrusion', merge=True):
        return self.feature(doc.FeatureManager.FeatureExtrusion3(True, False, False, 0, 0, depth_mm / 1000, 0., False, False, False, False, 0., 0., False, False, False, False, merge, False, True, 0, 0., False), name)

    def volume(self, doc):
        doc.ClearSelection2(True)
        doc.ForceRebuild3(False)
        return float(get(get(doc.Extension, 'CreateMassProperty'), 'Volume')) * 1e9

    def preview(self, doc, filename='preview.bmp'):
        path = self.path(filename)
        doc.ShowNamedView2('*Isometric', 7)
        get(doc, 'ViewZoomtofit2')
        self.check('preview', doc.SaveBMP(str(path), 1000, 700) and path.is_file())
        self.report['files'].append(str(path))
        return str(path)

    def active(self):
        """Resolve again after a rebuild/reopen; never consult another instance."""
        self.check_cancel()
        doc = get(self.app, 'ActiveDoc')
        if doc is None:
            raise RuntimeError('专属窗口没有活动模型；请核对状态后新建或打开工作目录中的文件。')
        return doc

    def finish(self):
        try:
            if self.app is not None and self.process.poll() is None:
                if int(get(self.app, 'GetProcessID')) != self.process.pid or self.process.pid in self.before:
                    raise RuntimeError('实例所有权不一致，拒绝关闭。')
                for doc in sorted(list(get(self.app, 'GetDocuments') or []), key=lambda d: int(get(d, 'GetType')), reverse=True):
                    if not get(doc, 'GetPathName') or get(doc, 'GetSaveFlag'):
                        # Preserve partial work before closing only our own app.
                        ext = {1: '.SLDPRT', 2: '.SLDASM', 3: '.SLDDRW'}[int(get(doc, 'GetType'))]
                        path = self.path('.rufa-sw-recovery/' + self.run_id + '/' + str(len(self.report['recoveryFiles']) + 1) + ext)
                        e, w = VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0), VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)
                        if not doc.Extension.SaveAs(str(path), 0, 3, NULL, e, w) or e.value:
                            raise RuntimeError('无法保存独立实例的未完成模型。')
                        self.report['recoveryFiles'].append(str(path))
                    self.app.CloseDoc(get(doc, 'GetPathName') or get(doc, 'GetTitle'))
                get(self.app, 'ExitApp')
                self.process.wait(timeout=12)
            elif self.process and self.process.poll() is None and self.app is None:
                # The activation helper is a child of this failed blank launch;
                # do not leave it behind, and never touch a preexisting helper.
                wmi = win32com.client.GetObject('winmgmts:')
                for child in wmi.ExecQuery("SELECT * FROM Win32_Process WHERE Name='swactwiz.exe'"):
                    if int(child.ParentProcessId) == self.process.pid:
                        get(child, 'Terminate')
                self.process.terminate()
                self.process.wait(timeout=10)
            self.report['cleanup'] = not self.process or self.process.poll() is not None
            if self.report['cleanup']:
                active_marker().unlink(missing_ok=True)
            self.report['preexistingPidsStillRunning'] = sorted(self.before & process_ids()) if hasattr(self, 'before') else []
        except Exception as error:
            self.report['cleanupError'] = str(error)
            self.report['status'] = 'incomplete'
        finally:
            self.finished.set()
            try:
                self.restore_recovery()
            except Exception as error:
                self.report['registryRestored'] = False
                self.report['registryRestoreError'] = str(error)
                self.report['status'] = 'incomplete'
            self.report['forcedStop'] = self.force_stop
            if self.force_stop:
                self.report['status'] = 'incomplete'
                self.report['notice'] = '原生接口未及时返回，已结束本任务独立实例。仅已保存文件可确认，未保存操作结果未知。'
            self.flush()


class PersistentCad(Cad):
    """One STA and one owned window for a real company session.

    A completed tool step releases execution, not the model or application.
    No script or uncertain COM call is retried by this host.
    """
    def __init__(self, request, disconnected=None):
        self.session_key = request.get('sessionKey')
        self.owner_key = request.get('ownerKey')
        if not all(isinstance(v, str) and 0 < len(v) <= 512 for v in (self.session_key, self.owner_key)):
            raise ValueError('缺少真实会话与账号实例标识。')
        super().__init__(request)
        self.instance_id = uuid.uuid4().hex
        self.disconnected = disconnected or threading.Event()
        self.scope = {}
        self.last_recovery = []
        self.lost = False
        self.released = False
        self.ready = False
        self.created = None
        self.seen_requests = set()
        self.worker = None

    def check_cancel(self):
        if self.disconnected.is_set():
            raise Cancelled('客户端连接已断开；停止执行并保留模型。')
        super().check_cancel()

    def begin(self, request):
        if request.get('sessionKey') != self.session_key or request.get('ownerKey') != self.owner_key or Path(request['cwd']).resolve(strict=True) != self.cwd:
            raise ValueError('会话、账号或工作目录已改变，拒绝复用SolidWorks实例。')
        request_id = request.get('requestId')
        if not isinstance(request_id, str) or not request_id or len(request_id) > 128 or request_id in self.seen_requests:
            raise ValueError('无效或重复的请求；不会重放建模操作。')
        self.seen_requests.add(request_id)
        if self.worker:
            self.finished.set()
            self.worker.join(timeout=1)
        self.request = request
        self.state = Path(request['state']).resolve(strict=True)
        self.cancel = Path(request['cancel']).resolve()
        if self.cancel.parent != self.state:
            raise ValueError('停止标识必须位于当前调用目录。')
        self.run_id = uuid.uuid4().hex
        self.run_dir = self.state / self.run_id
        self.run_dir.mkdir()
        self.finished = threading.Event()
        self.force_stop = False
        seconds = request.get('timeoutSeconds', 300)
        if not isinstance(seconds, int) or not 30 <= seconds <= 900:
            raise ValueError('任务时限须为30至900秒。')
        self.deadline = time.monotonic() + seconds
        self.report = {'schema': 2, 'requestId': request_id, 'instanceId': self.instance_id,
            'runId': self.run_id, 'status': 'starting', 'checks': [], 'files': [],
            'recoveryFiles': [], 'previousRecoveryFiles': self.last_recovery,
            'cleanup': False, 'stepComplete': False, 'retained': False,
            'ownedPid': self.process.pid if self.process else None}
        title = request.get('stepTitle', '')
        if not isinstance(title, str) or len(title) > 120:
            raise ValueError('步骤名称须为120字以内的简短说明。')
        self.report['stepTitle'] = title
        self.flush()

    def watchdog(self):
        # Capture step-local state: a later call must never be cancelled by an
        # earlier timer. No COM object crosses the owning STA thread.
        finished, cancel, deadline = self.finished, self.cancel, self.deadline
        while not finished.wait(.1):
            if cancel.exists() or self.disconnected.is_set() or time.monotonic() >= deadline:
                if not finished.wait(8):
                    self.force_stop = True
                    if self.process and self.process.poll() is None:
                        self.process.terminate()  # exact owned Popen handle only
                return

    def arm(self):
        if self.worker and self.worker.is_alive():
            return
        self.worker = threading.Thread(target=self.watchdog, daemon=True)
        self.worker.start()

    def start(self):
        # Base startup already arms the overridden watchdog. UserControl keeps
        # the visible owned window alive even if this host unexpectedly exits.
        if self.process is not None or self.lost or self.released:
            raise RuntimeError('此会话已分配专属窗口，不能通过脚本重新启动或接管实例。')
        super().start()
        self.created = process_creation(self.process.pid)
        self.app.UserControl = True
        self.ready = True
        self.scope = {'cad': self, 'sw': self.app, 'get': get, 'VARIANT': VARIANT,
            'NULL': NULL, 'pythoncom': pythoncom, 'math': math, 'Path': Path}

    def finish(self):
        raise RuntimeError('连续建模不使用旧批次finish关闭窗口；保留模型，明确关闭时使用经过审查的close操作。')

    def assert_owned(self):
        if self.lost or self.released or not self.ready or not self.process or self.process.poll() is not None:
            self.lost = True
            raise RuntimeError('专属SolidWorks窗口已退出或连接不可用；未重新启动或重放步骤。请先核对恢复副本。')
        if int(get(self.app, 'GetProcessID')) != self.process.pid or self.process.pid in self.before:
            self.lost = True
            raise RuntimeError('SolidWorks实例所有权不一致，已拒绝继续操作。')

    def documents(self):
        self.assert_owned()
        result = []
        for doc in list(get(self.app, 'GetDocuments') or []):
            result.append({'title': str(get(doc, 'GetTitle')), 'path': str(get(doc, 'GetPathName')),
                'type': int(get(doc, 'GetType')), 'unsaved': bool(get(doc, 'GetSaveFlag'))})
        return result

    def checkpoint(self, phase):
        """Save unique recovery copies; do not rename/close/overwrite originals."""
        self.assert_owned()
        rows = []
        for index, doc in enumerate(list(get(self.app, 'GetDocuments') or [])):
            if get(doc, 'GetPathName') and not get(doc, 'GetSaveFlag'):
                continue
            ext = {1: '.SLDPRT', 2: '.SLDASM', 3: '.SLDDRW'}[int(get(doc, 'GetType'))]
            path = self.path('.rufa-sw-recovery/' + self.run_id + '/' + phase + '-' + str(index + 1) + ext)
            e, w = VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0), VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)
            ok = doc.Extension.SaveAs(str(path), 0, 3, NULL, e, w)
            if not ok or e.value or not path.is_file() or not path.stat().st_size:
                raise RuntimeError('恢复副本未保存成功；模型仍保留在窗口，请先手动另存。')
            rows.append(str(path))
            self.report['recoveryFiles'].append(str(path))
            self.flush()
        if rows:
            self.last_recovery = rows

    def execute_step(self, request):
        self.begin(request)
        self.arm()
        log = BoundedLog()
        try:
            code = request.get('code')
            if not isinstance(code, str) or not code.strip() or len(code) > 60000:
                raise ValueError('建模代码不能为空或超过60000字。')
            compiled = compile(code, '<reviewed-solidworks-tool-call>', 'exec')
            self.check_cancel()
            if self.process is None and not self.lost:
                self.start()
            else:
                self.assert_owned()
            self.checkpoint('before')
            self.report['status'] = 'running'
            self.flush()
            os.chdir(self.cwd)
            # Protect protocol stdout and retain ordinary Python variables.
            with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                sys.settrace(self.trace)
                try:
                    exec(compiled, self.scope, self.scope)
                finally:
                    sys.settrace(None)
            self.check_cancel()
            self.report['status'] = 'completed'
        except BaseException as error:
            self.report['status'] = 'stopped' if isinstance(error, Cancelled) else 'failed'
            self.report['error'] = str(error)
            self.report['traceback'] = traceback.format_exc(limit=8)
        finally:
            # The cancellation timer remains armed while saving. A wedged COM
            # call is bounded, but is never reported as a successful rollback.
            try:
                if self.ready and self.process.poll() is None and not self.force_stop:
                    self.checkpoint('after')
                    self.report['documents'] = self.documents()
                    self.report['stepComplete'] = True
                    self.report['retained'] = True
                    self.report['instanceAlive'] = True
                elif self.process is not None:
                    self.lost = True
                    self.report['instanceAlive'] = self.process.poll() is None
                    self.report['outcomeUnknown'] = True
                    self.report['status'] = 'unknown'
                else:
                    self.report['instanceAlive'] = False
                    self.report['launched'] = False
                    self.report['stepComplete'] = True  # compile/cancel before launch
            except BaseException as error:
                self.report['checkpointError'] = str(error)
                self.report['status'] = 'incomplete'
                self.report['outcomeUnknown'] = True
                self.report['instanceAlive'] = bool(self.process and self.process.poll() is None)
                self.report['retained'] = self.report['instanceAlive']
                if not self.report['instanceAlive']:
                    self.lost = True
            finally:
                self.finished.set()
            try:
                self.restore_recovery()
            except Exception as error:
                self.report['registryRestoreError'] = str(error)
                self.report['status'] = 'incomplete'
            self.report['forcedStop'] = self.force_stop
            if self.force_stop:
                self.lost = True
                self.report.update(status='unknown', outcomeUnknown=True, stepComplete=False, retained=False)
                self.report['notice'] = '原生接口停止后仍未返回，已结束本任务专属实例。未保存结果未知，不得自动重做。'
            self.report['log'], self.report['logTruncated'] = log.value, log.truncated
            self.flush()
        return self.report

    def status(self, request):
        self.begin(request)
        self.arm()
        try:
            if self.process is None and not self.lost:
                self.report.update(documents=[], status='not-started', instanceAlive=False,
                    retained=False, launched=False, stepComplete=True)
            else:
                self.report.update(documents=self.documents(), status='ready', instanceAlive=True,
                    retained=True, stepComplete=True, recoveryFiles=self.last_recovery)
        except Exception as error:
            self.report.update(status='unavailable', error=str(error), instanceAlive=bool(self.process and self.process.poll() is None), outcomeUnknown=True)
        finally:
            self.finished.set()
        self.flush()
        return self.report

    def release(self, request=None):
        if request is not None:
            self.begin(request)
        self.finished.set()
        # No checkpoint here: the last reviewed step already captured copies.
        # EOF/logout must not silently save over a user's later manual edits.
        alive = bool(self.process and self.process.poll() is None)
        try:
            # UserControl was set once at verified startup. Do not make more
            # possibly blocking COM calls during logout or a broken transport.
            self.restore_recovery()
            if alive and self.registry:
                # SW can write cached startup paths on a much later user exit.
                # A process-handle waiter only restores values still equal to
                # our temporary ones. It never controls documents or windows.
                job = self.run_dir / 'restore-on-exit.json'
                job.write_text(json.dumps({'pid': self.process.pid, 'created': self.created,
                    'registry': self.registry}), encoding='utf-8')
                subprocess.Popen([sys.executable, '-I', '-B', str(ROOT / 'solidworks_runner.py'), '--restore-on-exit', str(job)],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    creationflags=subprocess.CREATE_NO_WINDOW, close_fds=True)
                self.report['registryExitRestoreScheduled'] = True
            marker = active_marker()
            if marker.exists():
                value = json.loads(marker.read_text(encoding='utf-8'))
                if self.process and value.get('pid') == self.process.pid:
                    marker.unlink()
            self.released = True
            self.report.update(status='released', released=True, instanceAlive=alive,
                retained=alive, stepComplete=True, cleanup=not alive)
        except BaseException as error:
            self.report.update(status='incomplete', error=str(error), outcomeUnknown=True,
                instanceAlive=alive, retained=alive, released=False)
        self.flush()
        return self.report

    def close_window(self, request):
        """Explicit reviewed close only; dirty documents veto before ExitApp."""
        self.begin(request)
        try:
            self.check_cancel()
            docs = self.documents()
            self.report['documents'] = docs
            if any(doc['unsaved'] or not doc['path'] for doc in docs):
                self.report.update(status='failed', error='窗口中有未保存模型，已保留窗口；请先保存到工作目录，再明确关闭。',
                    instanceAlive=True, retained=True, stepComplete=True)
            else:
                self.assert_owned()
                # Let SW itself handle any last-moment manual edits/prompts.
                # Never use the forced-stop watchdog for a close request.
                get(self.app, 'ExitApp')
                self.process.wait(timeout=15)
                self.restore_recovery()
                marker = active_marker()
                if marker.exists() and json.loads(marker.read_text(encoding='utf-8')).get('pid') == self.process.pid:
                    marker.unlink()
                self.released = True
                self.report.update(status='closed', closed=True, released=True, instanceAlive=False,
                    retained=False, stepComplete=True, cleanup=True)
        except BaseException as error:
            self.report.update(status='incomplete', error=str(error), outcomeUnknown=True,
                instanceAlive=bool(self.process and self.process.poll() is None))
        finally:
            self.finished.set()
        self.flush()
        return self.report


def restore_after_exit(job_path):
    """Bound to the exact launched process; safe if PID is reused later."""
    import ctypes
    from ctypes import wintypes
    job = Path(job_path).resolve(strict=True)
    data = json.loads(job.read_text(encoding='utf-8'))
    load_com()
    pythoncom.CoInitialize()
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x100000, False, data['pid'])  # SYNCHRONIZE only
    try:
        if handle and data.get('created') and process_creation(data['pid']) == data['created']:
            kernel.WaitForSingleObject(handle, 0xffffffff)
        cad = Cad.__new__(Cad)
        cad.registry, cad.report, cad.run_dir = data['registry'], {}, job.parent
        cad.flush = lambda: None  # preserve the original modeling/release report
        cad.restore_recovery()
        (job.parent / 'registry-after-exit.json').write_text(json.dumps(cad.report), encoding='utf-8')
    finally:
        if handle:
            kernel.CloseHandle(handle)
        pythoncom.CoUninitialize()


def serve(first):
    requests, disconnected = queue.Queue(), threading.Event()
    def reader():
        try:
            for line in sys.stdin:
                if len(line) > 1_000_000:
                    break
                requests.put(json.loads(line))
        finally:
            disconnected.set()
            requests.put(None)
    threading.Thread(target=reader, daemon=True).start()
    pythoncom.CoInitialize()
    cad = PersistentCad(first, disconnected)
    try:
        request = first
        while request is not None:
            try:
                # Hold the machine execution lock only for a real operation.
                # Idle sessions keep their own window without blocking another
                # session forever. A stale active marker still fails closed.
                operation = request.get('operation')
                # Handoff is COM-free and touches only this owner's marker and
                # compare-and-restore preferences; another step must not block
                # logout or turn a harmless handoff into an uncertain operation.
                with contextlib.nullcontext() if operation == 'release' else exclusive_lock(cad):
                    result = cad.execute_step(request) if operation == 'run' else cad.status(request) if operation == 'status' else cad.release(request) if operation == 'release' else cad.close_window(request) if operation == 'close' else None
                    if result is None:
                        raise ValueError('无效的持久实例操作。')
                    if result.get('stepComplete') and not result.get('outcomeUnknown'):
                        clear_active_marker(cad)
            except ExecutionBusy as error:
                alive = bool(cad.process and cad.process.poll() is None)
                result = {'schema': 2, 'requestId': request.get('requestId'), 'status': 'failed',
                    'error': str(error), 'stepComplete': True, 'cleanup': False,
                    'launched': cad.process is not None, 'instanceAlive': alive,
                    'retained': alive, 'executionBusy': True}
            except BaseException as error:
                result = {'schema': 2, 'requestId': request.get('requestId'), 'status': 'failed', 'error': str(error), 'stepComplete': False}
            try:
                print(json.dumps(result, ensure_ascii=False), flush=True)
            except (BrokenPipeError, OSError):
                disconnected.set()
                break
            operation = request.get('operation')
            if (operation == 'release' and result.get('released')) or (operation == 'close' and result.get('status') == 'closed') or disconnected.is_set():
                break
            while True:
                try:
                    request = requests.get(timeout=.1)
                    break
                except queue.Empty:
                    pythoncom.PumpWaitingMessages()
    finally:
        if not cad.released:
            cad.release()
        cad.scope.clear()
        cad.app = None
        pythoncom.CoUninitialize()


class ExecutionBusy(RuntimeError):
    pass


def clear_active_marker(cad):
    marker = active_marker()
    if marker.is_file() and cad.process:
        value = json.loads(marker.read_text(encoding='utf-8'))
        if value.get('pid') == cad.process.pid and value.get('created') == cad.created:
            marker.unlink()


@contextlib.contextmanager
def exclusive_lock(cad=None):
    import msvcrt
    folder = Path(os.environ['LOCALAPPDATA']) / 'RufaDSH/locks'
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / 'solidworks-2016.lock').open('a+b') as handle:
        if handle.tell() == 0:
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise ExecutionBusy('本电脑已有SolidWorks建模步骤正在执行，等待该步骤结束后再试。')
        try:
            if active_marker().is_file():
                previous = json.loads(active_marker().read_text(encoding='utf-8'))
                if previous.get('created') and process_creation(previous['pid']) == previous['created']:
                    if not (cad and cad.process and cad.process.poll() is None and previous.get('pid') == cad.process.pid and previous['created'] == cad.created):
                        raise ExecutionBusy('上次专属SolidWorks操作尚未确认结束；请先核对该任务，不接管或结束用户原窗口。')
                active_marker().unlink()
            if cad and cad.process and cad.process.poll() is None:
                active_marker().write_text(json.dumps({'pid': cad.process.pid, 'created': cad.created}), encoding='utf-8')
            yield
        finally:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def main():
    request = json.loads(sys.stdin.readline())
    load_com()
    if request['operation'] == 'detect':
        exe = installation()
        return {'installed': True, 'executable': str(exe), 'target': 'SolidWorks 2016', 'python': sys.version.split()[0], 'notice': '安装检测不表示已通过许可、模板或建模验收；未启动SolidWorks。'}
    if request.get('persistent') is True:
        serve(request)
        return None
    if request['operation'] != 'run' or not isinstance(request.get('code'), str) or len(request['code']) > 60000:
        raise ValueError('无效的建模任务。')
    code = compile(request['code'], '<reviewed-solidworks-tool-call>', 'exec')
    with exclusive_lock():
        pythoncom.CoInitialize()
        cad = Cad(request)
        log = BoundedLog()
        try:
            cad.start()
            scope = {'cad': cad, 'sw': cad.app, 'get': get, 'VARIANT': VARIANT, 'NULL': NULL, 'pythoncom': pythoncom, 'math': math, 'Path': Path}
            os.chdir(cad.cwd)
            with contextlib.redirect_stdout(log):
                sys.settrace(cad.trace)
                try:
                    exec(code, scope, scope)
                finally:
                    sys.settrace(None)
            cad.check_cancel()
            cad.report['status'] = 'completed'
        except BaseException as error:
            cad.report['status'] = 'stopped' if isinstance(error, Cancelled) else 'failed'
            cad.report['error'] = str(error)
            cad.report['traceback'] = traceback.format_exc(limit=8)
        finally:
            cad.finish()
            pythoncom.CoUninitialize()
        cad.report['log'] = log.value
        cad.report['logTruncated'] = log.truncated
        cad.flush()
        return cad.report


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--restore-on-exit':
        restore_after_exit(sys.argv[2])
        raise SystemExit
    try:
        result = main()
    except BaseException as error:
        result = {'status': 'failed', 'error': str(error)}
    if result is not None:
        print(json.dumps(result, ensure_ascii=False), flush=True)
