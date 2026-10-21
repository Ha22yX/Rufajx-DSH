"""Opt-in SW2016 continuity acceptance. New synthetic models only.

No attachments to actual preexisting SW instances. All cleanup uses known
test-owned handles; production runtime/profile is never replaced.
"""
import json
import os
from pathlib import Path
import queue
import runpy
import subprocess
import sys
import threading
import time
from unittest.mock import patch

runtime, root = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
root.mkdir(parents=True, exist_ok=False)
helper = runtime / 'company-tools/solidworks/solidworks_runner.py'
sdk = runpy.run_path(str(helper)); sdk['load_com']()
Cad, get = sdk['Cad'], sdk['get']
pythoncom = Cad.start.__globals__['pythoncom']
import win32gui
import win32process
report = {'synthetic': True, 'paidModelCalls': 0, 'steps': []}

def persist():
    (root / 'acceptance.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')

def visible(pid):
    rows = []
    def visit(hwnd, _):
        if win32process.GetWindowThreadProcessId(hwnd)[1] == pid and win32gui.IsWindowVisible(hwnd):
            rows.append({'hwnd': hwnd, 'rect': list(win32gui.GetWindowRect(hwnd)),
                'minimized': bool(win32gui.IsIconic(hwnd))})
    win32gui.EnumWindows(visit, None)
    return sorted(rows, key=lambda r: r['hwnd'])

def config(name):
    folder = root / name
    (folder / 'work').mkdir(parents=True); (folder / 'state').mkdir()
    return {'cwd': str(folder / 'work'), 'state': str(folder / 'state'),
        'cancel': str(folder / 'state/cancel'), 'timeoutSeconds': 900}

base = config('owned-worker')
worker = None; cad_pid = None; sentinel = None; doc = None
sentinel_marker = root / 'sentinel-active.json'
answers = queue.Queue()
counter = 0

def request(operation, code='', title='', stop=False):
    global counter, cad_pid
    counter += 1
    state = root / 'calls' / str(counter); state.mkdir(parents=True)
    value = {**base, 'state': str(state), 'cancel': str(state / 'cancel'),
        'operation': operation, 'persistent': True, 'requestId': str(counter),
        'ownerKey': 'live-synthetic-account', 'sessionKey': 'live-synthetic-session',
        'stepTitle': title, 'code': code}
    worker.stdin.write(json.dumps(value) + '\n'); worker.stdin.flush()
    if stop:
        ready = Path(base['cwd']) / 'cancel-ready'
        until = time.monotonic() + 20
        while not ready.exists() and time.monotonic() < until:
            time.sleep(.1)
        assert ready.exists(), 'Cancel probe never entered its code'
        (state / 'cancel').write_text('stop')
    line = answers.get(timeout=240)
    if line is None: raise RuntimeError('Worker exited without response; see stderr')
    result = json.loads(line)
    report['steps'].append({'operation': operation, 'title': title, 'result': result})
    persist()
    assert result.get('requestId') == str(counter), result
    if result.get('ownedPid'):
        if cad_pid is None: cad_pid = result['ownedPid']
        assert cad_pid == result['ownedPid'], 'Worker launched a replacement SW'
    return result

def protected():
    return {'pid': sentinel.process.pid, 'windows': visible(sentinel.process.pid),
        'path': get(doc, 'GetPathName'), 'title': get(doc, 'GetTitle'),
        'dirty': bool(get(doc, 'GetSaveFlag')), 'volume': sentinel.volume(doc),
        'documents': len(list(get(sentinel.app, 'GetDocuments') or []))}

pythoncom.CoInitialize()
try:
    sentinel = Cad(config('protected-unsaved'))
    # Reject immediately if a real modeling task holds the desktop lock.
    with sdk['exclusive_lock']():
        with patch.dict(Cad.start.__globals__, {'active_marker': lambda: sentinel_marker}):
            sentinel.start()
    sentinel.finished.set()
    doc = sentinel.new('part')
    sentinel.sketch(doc, lambda s: s.CreateCornerRectangle(0., 0., 0., .017, .019, 0.))
    sentinel.extrude(doc, 3)
    report['protectedBefore'] = protected()
    persist()
    errors = (root / 'worker-stderr.txt').open('w', encoding='utf-8')
    worker = subprocess.Popen([sys.executable, '-I', '-B', '-u', str(helper)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors,
        text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW)
    def reader():
        for line in worker.stdout: answers.put(line)
        answers.put(None)
    threading.Thread(target=reader, daemon=True).start()
    r = request('run', 'doc = cad.new("part")\ncad.sketch(doc, lambda s: s.CreateCornerRectangle(0.,0.,0.,.05,.03,0.), name="BaseSketch")', 'Create sketch')
    assert r['status'] == 'completed' and r['retained'] and not r['cleanup'], r
    # An idle session must keep its model without holding the execution lock.
    with sdk['exclusive_lock']():
        report['idleExecutionLockReleased'] = True
    r = request('run', 'doc = cad.active()\ndoc.ClearSelection2(True)\ncad.check("select existing sketch", doc.FeatureByName("BaseSketch").Select2(False,0))\ncad.extrude(doc,10,name="BaseBody")\ncad.check("volume",abs(cad.volume(doc)-15000)<.001)', 'Extrude existing sketch')
    assert r['status'] == 'completed', r
    r = request('run', 'doc = cad.active()\ndoc.Parameter("D1@BaseBody").SystemValue = .012\ncad.check("partial volume",abs(cad.volume(doc)-18000)<.001)\ncad.check("intentional test failure",False)', 'Keep partial change on failure')
    assert r['status'] == 'failed' and r['retained'] and r['stepComplete'], r
    r = request('run', 'doc = cad.active()\ncad.check("retained partial result",abs(cad.volume(doc)-18000)<.001)\ndoc.Parameter("D1@BaseBody").SystemValue=.014\ncad.check("new volume",abs(cad.volume(doc)-21000)<.001)\ncad.preview(doc,"continuous.bmp")', 'Continue same model')
    assert r['status'] == 'completed', r
    r = request('run', 'import time\ncad.path("cancel-ready").write_text("ready")\nwhile True:\n time.sleep(.05)', 'Cooperative stop', stop=True)
    assert r['status'] == 'stopped' and r['retained'] and not r['forcedStop'], r
    r = request('status', title='Inspect retained model')
    assert r['status'] == 'ready' and len(r['documents']) == 1, r
    r = request('close', title='Refuse unsaved close')
    assert r['status'] == 'failed' and r['retained'], r
    r = request('run', 'doc=cad.active()\ncad.check("after stop",abs(cad.volume(doc)-21000)<.001)\ncad.save(doc,"continuous-model.SLDPRT")', 'Save after explicit resume')
    assert r['status'] == 'completed', r
    report['ownedWindows'] = visible(cad_pid)
    assert report['ownedWindows'], 'Owned model is not visible'
    report['protectedAfter'] = protected()
    assert report['protectedAfter'] == report['protectedBefore'], 'Protected unsaved model changed'
    if '--close' in sys.argv[3:]:
        r = request('close', title='Explicitly close saved owned window')
        assert r['status'] == 'closed' and r['closed'] and r['cleanup'], r
        worker.wait(timeout=10)
        assert cad_pid not in sdk['process_ids'](), 'Explicit close left window running'
        report['explicitCloseVerified'] = True
    else:
        r = request('release', title='Leave completed model visible')
        assert r['status'] == 'released' and r['retained'], r
        worker.wait(timeout=10)
        assert cad_pid in sdk['process_ids']() and visible(cad_pid), 'Release closed the model'
    report['passed'] = True
finally:
    # Clean only the synthetic application we launched, after the handoff test.
    # Never select a user's existing window by active-object lookup.
    if worker and worker.poll() is None:
        worker.stdin.close()
        try: worker.wait(timeout=35)
        except subprocess.TimeoutExpired: worker.kill()
    if cad_pid:
        try:
            rot, bind = pythoncom.GetRunningObjectTable(), pythoncom.CreateBindCtx(0)
            for moniker in rot.EnumRunning():
                if moniker.GetDisplayName(bind,None) == 'SolidWorks_PID_' + str(cad_pid):
                    app = sdk['Cad'].start.__globals__['win32com'].client.Dispatch(rot.GetObject(moniker).QueryInterface(pythoncom.IID_IDispatch))
                    assert int(get(app,'GetProcessID')) == cad_pid
                    for model in list(get(app,'GetDocuments') or []):
                        # Test-only models, saved as copies before explicit cleanup.
                        path = root / ('test-cleanup-' + str(int(get(model,'GetType'))) + '.SLDPRT')
                        model.SaveAs3(str(path),0,1)
                        app.CloseDoc(get(model,'GetTitle'))
                    get(app,'ExitApp')
                    break
        except Exception as error: report['testCleanupError'] = str(error)
    if sentinel and sentinel.process:
        with patch.dict(Cad.start.__globals__, {'active_marker': lambda: sentinel_marker}):
            sentinel.finish()
        if not sentinel.report.get('cleanup'):
            try:
                sentinel.process.wait(timeout=30)
                sentinel.report['testCleanupEventuallyExited'] = True
            except subprocess.TimeoutExpired:
                sentinel.report['testCleanupEventuallyExited'] = False
        report['sentinelCleanup'] = sentinel.report
    pythoncom.CoUninitialize()
    persist()
print(json.dumps({'passed': report.get('passed',False), 'steps':len(report['steps']), 'report':str(root/'acceptance.json')}))
