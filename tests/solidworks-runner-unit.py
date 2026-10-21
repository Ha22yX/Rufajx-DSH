"""Offline lifecycle/path checks; does not launch or attach to SolidWorks."""
import os
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from contextlib import nullcontext

source = Path(__file__).resolve().parents[1] / 'preinstalled/solidworks/runtime/solidworks_runner.py'
sdk = runpy.run_path(str(source))
Cad, Cancelled, BoundedLog = sdk['Cad'], sdk['Cancelled'], sdk['BoundedLog']


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='rufa-sw-helper-unit-')
        self.root = Path(self.temp.name)
        self.cwd, self.state = self.root / 'work', self.root / 'state'
        self.cwd.mkdir(); self.state.mkdir()
        self.cad = Cad({'cwd': str(self.cwd), 'state': str(self.state), 'cancel': str(self.root / 'cancel')})

    def tearDown(self):
        self.temp.cleanup()

    def test_paths_are_resolved_inside_authoritative_workdir(self):
        self.assertEqual(self.cad.path('零件/支架.SLDPRT'), self.cwd / '零件/支架.SLDPRT')
        for name in ['../outside.SLDPRT', str(self.root / 'outside.SLDPRT'), '.', 'part.SLDPRT:stream']:
            with self.assertRaises(ValueError):
                self.cad.path(name)

    def test_cancel_interrupts_reviewed_python_loop(self):
        self.cad.cancel.write_text('stop')
        code = compile('while True:\n pass\n', '<reviewed-solidworks-tool-call>', 'exec')
        try:
            sys.settrace(self.cad.trace)
            with self.assertRaises(Cancelled):
                exec(code, {})
        finally:
            sys.settrace(None)

    def start_fixture(self, *, returned_pid=101, documents=(), revision='24.5.0', starting=False):
        original = SimpleNamespace(Visible=False, unsaved='user model')
        owned = SimpleNamespace(Visible=False, GetProcessID=lambda: returned_pid,
            GetDocuments=lambda: list(documents), RevisionNumber=lambda: revision,
            StartupProcessCompleted=not starting)
        bound = []
        def moniker(pid):
            return SimpleNamespace(GetDisplayName=lambda *_: 'SolidWorks_PID_' + str(pid))
        def bind(item):
            bound.append(item.GetDisplayName())
            return SimpleNamespace(QueryInterface=lambda _: owned)
        rot = SimpleNamespace(EnumRunning=lambda: [moniker(42), moniker(101)], GetObject=bind)
        com = SimpleNamespace(GetRunningObjectTable=lambda: rot, CreateBindCtx=lambda _: None, IID_IDispatch=0)
        process = SimpleNamespace(pid=101, poll=lambda: None)
        self.cad.configure_recovery = lambda: None
        self.cad.restore_recovery = lambda: None
        self.fixture = (original, owned, bound)
        def startup_tick(_):
            self.assertFalse(owned.Visible, 'Visibility changed before SW finished startup')
            owned.StartupProcessCompleted = True
        with patch.dict(Cad.start.__globals__, {'installation': lambda: self.root / 'SLDWORKS.exe',
                'process_ids': lambda: {42}, 'process_creation': lambda _: 'unique-creation',
                'active_marker': lambda: self.root / 'active.json', 'pythoncom': com,
                'win32com': SimpleNamespace(client=SimpleNamespace(Dispatch=lambda obj: obj))}), \
                patch('subprocess.Popen', return_value=process), patch('threading.Thread'), \
                patch('time.sleep', side_effect=startup_tick):
            self.cad.start()

    def test_only_pid_bound_verified_instance_is_shown(self):
        self.start_fixture()
        original, owned, bound = self.fixture
        self.assertEqual(bound, ['SolidWorks_PID_101'])
        self.assertTrue(owned.Visible)
        self.assertFalse(original.Visible)
        self.assertEqual(original.unsaved, 'user model')
        self.assertFalse(hasattr(owned, 'UserControl'))

    def test_rot_registration_does_not_mean_startup_is_ready(self):
        self.start_fixture(starting=True)
        _, owned, _ = self.fixture
        self.assertTrue(owned.StartupProcessCompleted)
        self.assertTrue(owned.Visible)

    def test_unowned_nonempty_or_wrong_version_is_never_shown(self):
        for kwargs, check in [({'returned_pid': 42}, 'owned_process'),
                ({'documents': ['unsaved']}, 'empty_owned_instance'),
                ({'revision': '25.0.0'}, 'SW2016')]:
            with self.subTest(check=check):
                with self.assertRaisesRegex(RuntimeError, check):
                    self.start_fixture(**kwargs)
                original, owned, _ = self.fixture
                self.assertFalse(owned.Visible)
                self.assertFalse(original.Visible)
                self.assertEqual(original.unsaved, 'user model')

    def test_log_is_bounded_and_retains_unicode(self):
        log = BoundedLog()
        log.write('前' * 17000); log.write('结束')
        self.assertEqual(len(log.value), 16000)
        self.assertTrue(log.truncated)
        self.assertTrue(log.value.endswith('结束'))

    def test_concurrent_batch_is_rejected_without_starting_sw(self):
        previous = os.environ.get('LOCALAPPDATA')
        os.environ['LOCALAPPDATA'] = str(self.root)
        try:
            with sdk['exclusive_lock']():
                with self.assertRaisesRegex(RuntimeError, '已有SolidWorks建模步骤'):
                    with sdk['exclusive_lock']():
                        self.fail('Second owner acquired lock')
        finally:
            if previous is None: os.environ.pop('LOCALAPPDATA', None)
            else: os.environ['LOCALAPPDATA'] = previous

    def test_exit_writeback_is_restored_without_overwriting_external_changes(self):
        entry = {'key': 'synthetic', 'name': 'journal', 'previous': 'original', 'temporary': 'temporary', 'kind': 1, 'existed': True}
        self.cad.registry = [entry]
        values = {'journal': ('temporary', 1)}
        registry = SimpleNamespace(HKEY_CURRENT_USER=0, KEY_READ=1, KEY_SET_VALUE=2, REG_SZ=1,
            OpenKey=lambda *args: nullcontext(None), QueryValueEx=lambda key, name: values[name],
            SetValueEx=lambda key, name, reserved, kind, value: values.update({name: (value, kind)}))
        with patch.dict(sys.modules, {'winreg': registry}):
            self.cad.restore_recovery()
            self.assertEqual(values['journal'], ('original', 1))
            self.assertEqual(self.cad.registry, [entry])
            values['journal'] = ('temporary', 1)  # ExitApp persists its cache.
            self.cad.restore_recovery()
            self.assertEqual(values['journal'], ('original', 1))
            self.assertTrue(self.cad.report['registryRestored'])
            values['journal'] = ('user-changed', 1)
            self.cad.restore_recovery()
            self.assertEqual(values['journal'], ('user-changed', 1))
            self.assertFalse(self.cad.report['registryRestored'])


if __name__ == '__main__':
    unittest.main()
