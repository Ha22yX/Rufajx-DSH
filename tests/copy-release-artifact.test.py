import base64
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('copy_release', Path(__file__).resolve().parent.parent / 'scripts/copy-release-artifact.py')
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class CopyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / 'source'
        self.target = self.root / 'target'
        self.data = b'fixed release artifact\0\xff'
        self.source.write_bytes(self.data)
        self.sha = base64.b64encode(hashlib.sha512(self.data).digest()).decode()

    def test_exact_copy(self):
        tool.copy_verified(self.source, self.target, len(self.data), self.sha)
        self.assertEqual(self.target.read_bytes(), self.data)
        self.assertEqual(self.target.stat().st_nlink, 1)

    def test_size_or_digest_failure_removes_only_own_output(self):
        for size, sha in [(len(self.data)+1, self.sha), (len(self.data), base64.b64encode(bytes(64)).decode())]:
            with self.assertRaises(ValueError):
                tool.copy_verified(self.source, self.target, size, sha)
            self.assertFalse(self.target.exists())
        self.assertEqual(self.source.read_bytes(), self.data)

    def test_existing_destination_never_overwritten(self):
        self.target.write_bytes(b'preserve')
        with self.assertRaises(FileExistsError):
            tool.copy_verified(self.source, self.target, len(self.data), self.sha)
        self.assertEqual(self.target.read_bytes(), b'preserve')

    def test_source_hardlink_rejected(self):
        import os
        os.link(str(self.source), str(self.root / 'alias'))
        with self.assertRaises(ValueError):
            tool.copy_verified(self.source, self.target, len(self.data), self.sha)
        self.assertFalse(self.target.exists())


if __name__ == '__main__':
    unittest.main()
