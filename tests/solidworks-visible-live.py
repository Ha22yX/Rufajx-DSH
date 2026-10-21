"""Opt-in real SW2016 visibility/isolation acceptance; synthetic files only.

Uses a known, test-owned unsaved document to represent an existing user window.
Never attaches to or inspects documents in actual preexisting SW processes.
"""
import json
from pathlib import Path
import runpy
import subprocess
import sys
import time
from unittest.mock import patch

runtime, root = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
root.mkdir(parents=True, exist_ok=False)
helper = runtime / 'company-tools/solidworks/solidworks_runner.py'
sdk = runpy.run_path(str(helper))
sdk['load_com']()
Cad, get = sdk['Cad'], sdk['get']
pythoncom = Cad.start.__globals__['pythoncom']
import win32gui
import win32process


def windows(pid):
    found = []
    def visit(hwnd, _):
        if win32process.GetWindowThreadProcessId(hwnd)[1] == pid and win32gui.IsWindowVisible(hwnd):
            found.append({'hwnd': hwnd, 'rect': win32gui.GetWindowRect(hwnd),
                'minimized': bool(win32gui.IsIconic(hwnd)), 'title': win32gui.GetWindowText(hwnd)})
    win32gui.EnumWindows(visit, None)
    return sorted(found, key=lambda row: row['hwnd'])


def request(name):
    folder = root / name
    (folder / 'work').mkdir(parents=True)
    (folder / 'state').mkdir()
    return {'operation': 'run', 'cwd': str(folder / 'work'), 'state': str(folder / 'state'),
        'cancel': str(folder / 'cancel'), 'timeoutSeconds': 300}


worker_visibility = '''
import win32gui, win32process
visible_windows = []
def collect(hwnd, _):
    if win32process.GetWindowThreadProcessId(hwnd)[1] == cad.process.pid and win32gui.IsWindowVisible(hwnd) and not win32gui.IsIconic(hwnd):
        visible_windows.append(hwnd)
win32gui.EnumWindows(collect, None)
cad.check("actual_owned_window_visible", bool(visible_windows), windows=visible_windows)
'''


def batch(name, code, *, stop=False):
    payload = request(name)
    payload['code'] = code
    process = subprocess.Popen([sys.executable, '-I', '-B', '-u', str(helper)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW)
    if not stop:
        out, err = process.communicate(json.dumps(payload) + '\n', timeout=360)
    else:
        process.stdin.write(json.dumps(payload) + '\n')
        process.stdin.close()
        process.stdin = None
        until = time.monotonic() + 240
        ready = Path(payload['cwd']) / 'ready'
        while not ready.exists() and process.poll() is None and time.monotonic() < until:
            time.sleep(.2)
        Path(payload['cancel']).write_text('stop')
        out, err = process.communicate(timeout=45)
        assert ready.exists(), 'Cancellation test never reached visible modeling'
    assert process.returncode == 0, err
    result = json.loads(out)
    assert result['status'] == ('stopped' if stop else 'completed'), result
    assert result['cleanup'] and result['registryRestored'], result
    assert result['ownedPid'] != sentinel.process.pid
    assert sentinel.process.pid in result['preexistingPidsStillRunning']
    assert all(row['passed'] for row in result['checks']), result
    assert any(row['name'] == 'actual_owned_window_visible' for row in result['checks'])
    after = snapshot()
    report[name] = result
    report[name + 'ProtectedAfter'] = after
    (root / 'visibility-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    assert after == before, 'Existing unsaved model/window changed: ' + json.dumps({'before': before, 'after': after})
    if stop:
        assert result['recoveryFiles'] and all(Path(file).is_file() for file in result['recoveryFiles'])
    report[name] = result
    (root / 'visibility-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')


def snapshot():
    return {'pid': sentinel.process.pid, 'windows': windows(sentinel.process.pid),
        'title': get(document, 'GetTitle'), 'path': get(document, 'GetPathName'),
        'volume': sentinel.volume(document), 'dirty': bool(get(document, 'GetSaveFlag')),
        'documents': len(list(get(sentinel.app, 'GetDocuments') or [])),
        'visible': bool(get(sentinel.app, 'Visible'))}


sentinel = Cad(request('existing-unsaved-window'))
sentinel_marker = root / 'sentinel-active.json'
report = {'synthetic': True, 'modelCalls': 0}
pythoncom.CoInitialize()
try:
    # Respect the real DSH lock before opening the test-owned sentinel. Give it
    # its own marker so the production child treats it as an existing window.
    with sdk['exclusive_lock']():
        with patch.dict(Cad.start.__globals__, {'active_marker': lambda: sentinel_marker}):
            sentinel.start()
    document = sentinel.new('part')
    sentinel.sketch(document, lambda s: s.CreateCornerRectangle(0., 0., 0., .017, .019, 0.))
    sentinel.extrude(document, 3)
    before = snapshot()
    assert before['path'] == '' and before['dirty'] and before['visible'] and before['windows']
    assert abs(before['volume'] - 969) < .001
    report['protectedBefore'] = before
    batch('completed', '''
doc = cad.new("part")
cad.sketch(doc, lambda s: s.CreateCornerRectangle(0., 0., 0., .05, .03, 0.))
cad.extrude(doc, 10)
''' + worker_visibility + '''
cad.check("volume_15000mm3", abs(cad.volume(doc) - 15000) < .001)
saved = cad.save(doc, "visible-model.SLDPRT")
doc = cad.reopen(doc, saved)
cad.check("reopened_volume", abs(cad.volume(doc) - 15000) < .001)
cad.preview(doc, "visible-model.bmp")
''')
    batch('stopped', '''
import time
doc = cad.new("part")
cad.sketch(doc, lambda s: s.CreateCornerRectangle(0., 0., 0., .01, .02, 0.))
cad.extrude(doc, 5)
''' + worker_visibility + '''
cad.path("ready").write_text("visible")
while True:
    time.sleep(.1)
''', stop=True)
    report['protectedAfter'] = snapshot()
    assert report['protectedAfter'] == before
    report['passed'] = True
finally:
    with patch.dict(Cad.start.__globals__, {'active_marker': lambda: sentinel_marker}):
        sentinel.finish()
    report['sentinelCleanup'] = sentinel.report
    pythoncom.CoUninitialize()
    (root / 'visibility-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
assert sentinel.report['cleanup'] and sentinel.report['registryRestored']
print(json.dumps({'passed': report['passed'], 'protectedUnsavedModelUnchanged': report['protectedBefore'] == report['protectedAfter'],
    'completedChecks': len(report['completed']['checks']), 'stoppedChecks': len(report['stopped']['checks']),
    'report': str(root / 'visibility-report.json')}))
