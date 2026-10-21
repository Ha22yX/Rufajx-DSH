"""Persistent STA lifecycle regression without starting any Windows CAD app."""
import json
import os
from pathlib import Path
import runpy
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sdk = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'preinstalled/solidworks/runtime/solidworks_runner.py'))
PersistentCad = sdk['PersistentCad']


class Document:
    def __init__(self):
        self.value, self.path, self.dirty = 0, '', True
        self.Extension = SimpleNamespace(SaveAs=self.copy)
    def copy(self, path, version, options, null, errors, warnings):
        assert options == 3  # copy + silent; original is not renamed or closed
        Path(path).write_text(str(self.value))
        return True
    def GetTitle(self): return 'Synthetic unsaved model'
    def GetPathName(self): return self.path
    def GetSaveFlag(self): return self.dirty
    def GetType(self): return 1


class SyntheticCad(PersistentCad):
    def start(self):
        self.starts = getattr(self, 'starts', 0) + 1
        self.before = {42}
        self.process = SimpleNamespace(pid=101, exited=False)
        self.process.poll = lambda: 0 if self.process.exited else None
        self.process.wait = lambda **kwargs: 0
        self.app = SimpleNamespace(GetProcessID=lambda: 101, docs=[Document()], Visible=True)
        self.app.GetDocuments = lambda: self.app.docs
        self.app.ExitApp = lambda: setattr(self.process, 'exited', True)
        self.ready = True
        self.scope = {'cad': self, 'sw': self.app}
        self.report['ownedPid'] = 101
    def restore_recovery(self): pass
    def arm(self): pass


class PersistentTests(unittest.TestCase):
    def setUp(self):
        self.original_cwd = Path.cwd()
        self.temp = tempfile.TemporaryDirectory(prefix='rufa-sw-continuous-unit-')
        self.root = Path(self.temp.name)
        self.work = self.root / 'work'; self.work.mkdir()
        self.count = 0
        self.globals = patch.dict(PersistentCad.checkpoint.__globals__, {
            'pythoncom': SimpleNamespace(VT_BYREF=1, VT_I4=2),
            'VARIANT': lambda _, value: SimpleNamespace(value=value), 'NULL': None,
            'active_marker': lambda: self.root / 'active.json'})
        self.globals.start()
        self.cad = SyntheticCad(self.request('pass'))
    def tearDown(self):
        os.chdir(self.original_cwd)
        self.globals.stop()
        self.temp.cleanup()
    def request(self, code, **extra):
        self.count += 1
        state = self.root / str(self.count); state.mkdir()
        return {'persistent': True, 'operation': 'run', 'sessionKey': 'synthetic-session',
            'ownerKey': 'synthetic-account', 'cwd': str(self.work), 'state': str(state),
            'cancel': str(state / 'cancel'), 'requestId': str(self.count),
            'code': code, 'timeoutSeconds': 30, **extra}
    def run_step(self, code, **extra): return self.cad.execute_step(self.request(code, **extra))

    def test_three_calls_keep_instance_objects_and_unsaved_document(self):
        one = self.run_step('doc = sw.docs[0]; doc.value = 10', stepTitle='Create base')
        two = self.run_step('doc.value += 3')
        three = self.run_step('cad.check("value", doc.value == 13)')
        self.assertEqual(self.cad.starts, 1)
        self.assertEqual(len({r['instanceId'] for r in [one, two, three]}), 1)
        self.assertEqual([r['ownedPid'] for r in [one, two, three]], [101] * 3)
        self.assertTrue(all(r['status'] == 'completed' and r['retained'] and not r['cleanup'] for r in [one, two, three]))
        self.assertEqual(self.cad.app.docs[0].path, '')
        self.assertTrue(self.cad.app.docs[0].dirty)
        self.assertEqual(Path(three['recoveryFiles'][-1]).read_text(), '13')

    def test_failed_check_preserves_partial_state_then_correction_continues(self):
        result = self.run_step('doc = sw.docs[0]; doc.value = 7; cad.check("intentional", False)')
        self.assertEqual(result['status'], 'failed')
        self.assertTrue(result['stepComplete'] and result['retained'])
        corrected = self.run_step('cad.check("partial retained", doc.value == 7); doc.value += 1')
        self.assertEqual(corrected['status'], 'completed')
        self.assertEqual(self.cad.starts, 1)
        self.assertEqual(self.cad.app.docs[0].value, 8)

    def test_cooperative_cancel_retains_window_and_can_resume_explicitly(self):
        result = self.run_step('doc = sw.docs[0]; doc.value = 4; cad.cancel.write_text("stop"); cad.check_cancel()')
        self.assertEqual(result['status'], 'stopped')
        self.assertTrue(result['retained'])
        self.assertEqual(self.run_step('cad.check("retained", doc.value == 4)')['status'], 'completed')
        self.assertEqual(self.cad.starts, 1)

    def test_disconnect_stops_without_discarding_last_checkpoint(self):
        self.run_step('doc = sw.docs[0]; doc.value = 5')
        self.cad.disconnected.set()
        result = self.run_step('doc.value = 99')
        self.assertEqual(result['status'], 'stopped')
        self.assertEqual(self.cad.app.docs[0].value, 5)
        self.assertTrue(result['retained'])

    def test_identity_change_and_duplicate_ids_rejected_before_mutation(self):
        r = self.request('doc = sw.docs[0]; doc.value = 1')
        self.cad.execute_step(r)
        with self.assertRaisesRegex(ValueError, '重复'):
            self.cad.execute_step(r)
        for change in [{'ownerKey': 'other'}, {'sessionKey': 'other'}, {'cwd': str(self.root)}]:
            with self.assertRaisesRegex(ValueError, '改变'):
                self.cad.execute_step(self.request('doc.value = 99', **change))
        self.assertEqual(self.cad.app.docs[0].value, 1)

    def test_closed_application_is_not_automatically_restarted(self):
        self.run_step('doc = sw.docs[0]; doc.value = 2')
        self.cad.process.exited = True
        result = self.run_step('doc.value = 99')
        self.assertEqual(result['status'], 'unknown')
        self.assertTrue(result['outcomeUnknown'])
        self.assertEqual(self.cad.starts, 1)
        self.assertEqual(self.cad.app.docs[0].value, 2)

    def test_close_refuses_dirty_then_closes_only_saved_owned_instance(self):
        self.run_step('doc = sw.docs[0]; doc.value = 3')
        rejected = self.cad.close_window(self.request('', operation='close'))
        self.assertEqual(rejected['status'], 'failed')
        self.assertIsNone(self.cad.process.poll())
        self.cad.app.docs[0].dirty = False
        self.cad.app.docs[0].path = str(self.work / 'saved.SLDPRT')
        closed = self.cad.close_window(self.request('', operation='close'))
        self.assertTrue(closed['closed'] and closed['cleanup'])
        self.assertFalse(closed['retained'])

    def test_release_keeps_dirty_model_alive_without_saving_or_exit(self):
        self.run_step('doc = sw.docs[0]; doc.value = 3')
        before = list(self.work.rglob('*'))
        result = self.cad.release(self.request('', operation='release'))
        self.assertEqual(result['status'], 'released')
        self.assertTrue(result['retained'] and result['instanceAlive'])
        self.assertEqual(list(self.work.rglob('*')), before)
        self.assertTrue(self.cad.app.docs[0].dirty)

    def test_status_reports_live_documents_without_running_code(self):
        self.run_step('doc = sw.docs[0]; doc.value = 3')
        state = self.cad.status(self.request('doc.value = 99', operation='status'))
        self.assertEqual(state['status'], 'ready')
        self.assertEqual(state['documents'][0]['title'], 'Synthetic unsaved model')
        self.assertEqual(self.cad.app.docs[0].value, 3)

    def test_recovery_failure_does_not_claim_saved_or_close_model(self):
        self.run_step('doc = sw.docs[0]')
        self.cad.app.docs[0].Extension.SaveAs = lambda *args: False
        result = self.run_step('doc.value = 99')
        self.assertEqual(result['status'], 'incomplete')
        self.assertTrue(result['outcomeUnknown'] and result['retained'])
        self.assertFalse(result['stepComplete'])
        self.assertEqual(self.cad.app.docs[0].value, 0)

    def test_prelaunch_failure_is_explicit_and_status_does_not_poison_session(self):
        result = self.run_step('if broken syntax')
        self.assertEqual(result['status'], 'failed')
        self.assertFalse(result['launched'])
        self.assertFalse(result['instanceAlive'])
        self.assertTrue(result['stepComplete'])
        state = self.cad.status(self.request('', operation='status'))
        self.assertEqual(state['status'], 'not-started')
        self.assertFalse(self.cad.lost)
        self.assertEqual(self.run_step('doc = sw.docs[0]')['status'], 'completed')

    def test_execution_lock_releases_between_steps_and_rejects_unresolved_other_owner(self):
        lock = sdk['exclusive_lock']
        marker = self.root / 'active.json'
        with patch.dict(os.environ, {'LOCALAPPDATA': str(self.root)}), patch.dict(lock.__wrapped__.__globals__, {'process_creation': lambda pid: 'created'}):
            with lock():
                with self.assertRaises(sdk['ExecutionBusy']):
                    with lock(): pass
            with lock(): pass
            marker.write_text(json.dumps({'pid': 42, 'created': 'created'}))
            with self.assertRaises(sdk['ExecutionBusy']):
                with lock(): pass
            self.assertTrue(marker.exists())
            self.run_step('doc = sw.docs[0]')
            self.cad.created = 'created'
            marker.write_text(json.dumps({'pid': 101, 'created': 'created'}))
            with lock(self.cad):
                sdk['clear_active_marker'](self.cad)
            self.assertFalse(marker.exists())
            with lock(): pass


if __name__ == '__main__': unittest.main()
