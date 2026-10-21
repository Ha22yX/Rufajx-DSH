import base64
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('objects',Path(__file__).resolve().parents[1]/'scripts/client-update-objects.py')
objects=importlib.util.module_from_spec(spec)
spec.loader.exec_module(objects)

class ObjectTransportTests(unittest.TestCase):
    def fixture(self):
        root=Path(tempfile.mkdtemp(prefix='rufa-cas-transport-'))
        source,target=root/'source',root/'target'
        source.mkdir()
        inventory={}
        for data in (b'',b'unchanged offline runtime',b'changed application'):
            key=hashlib.sha256(data).hexdigest()
            inventory[key]={'size':len(data),'sha512':base64.b64encode(hashlib.sha512(data).digest()).decode()}
            (source/key[:2]).mkdir(exist_ok=True)
            (source/key[:2]/key).write_bytes(data)
        return root,source,target,inventory

    def test_roundtrip_reuse_and_zero_byte(self):
        root,source,target,inventory=self.fixture()
        missing=objects.missing_objects(target,inventory)
        archive=root/'objects.tar.gz'
        objects.pack_objects(source,inventory,missing,archive)
        receipt=objects.apply_objects(target,inventory,archive)
        self.assertEqual(receipt['verifiedObjects'],3)
        self.assertEqual(objects.missing_objects(target,inventory),[])
        for key,item in inventory.items():
            file=objects.checked_object(target,key,item)
            self.assertEqual(file.read_bytes(),(source/key[:2]/key).read_bytes())
            self.assertEqual(file.stat().st_nlink,1)
        key=next(iter(inventory))
        (target/key[:2]/key).write_bytes(b'bad')
        with self.assertRaises(ValueError):objects.missing_objects(target,inventory)

    def test_malicious_or_corrupt_archive_never_installs_outside_target(self):
        root,source,target,inventory=self.fixture()
        archive=root/'traversal.tar.gz'
        with tarfile.open(archive,'w:gz') as output:
            entry=tarfile.TarInfo('../outside');entry.size=3
            output.addfile(entry,io.BytesIO(b'bad'))
        with self.assertRaises(ValueError):objects.apply_objects(target,inventory,archive)
        self.assertFalse((root/'outside').exists())
        key=next(k for k,v in inventory.items() if v['size'])
        damaged=root/'damaged.tar.gz'
        with tarfile.open(damaged,'w:gz') as output:
            entry=tarfile.TarInfo(key[:2]+'/'+key);entry.size=inventory[key]['size']
            output.addfile(entry,io.BytesIO(b'X'*entry.size))
        with self.assertRaises(ValueError):objects.apply_objects(target,inventory,damaged)
        self.assertFalse((target/key[:2]/key).exists())

if __name__=='__main__':unittest.main()
