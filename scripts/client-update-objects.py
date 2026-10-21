"""Release-only CAS transport. No endpoint executes this utility or user input."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tarfile
import uuid

HASH = re.compile(r'^[a-f0-9]{64}$')

def inventory(release):
    descriptor = json.loads((release / 'manifest.json').read_text(encoding='utf-8'))['incremental']
    raw = (release / 'incremental-manifest.json').read_bytes()
    if len(raw) != descriptor['size'] or base64.b64encode(hashlib.sha512(raw).digest()).decode() != descriptor['sha512']:
        raise ValueError('Incremental inventory transport checksum mismatch')
    body = json.loads(raw)
    if body['schema'] != 1 or body['version'] != release.name and not release.name.startswith('.incoming-'):
        raise ValueError('Invalid incremental inventory identity')
    objects = {}
    for item in body['files']:
        key = item['sha256']
        if not HASH.fullmatch(key) or not isinstance(item['size'], int) or isinstance(item['size'], bool) or item['size'] < 0:
            raise ValueError('Invalid object declaration')
        digest = base64.b64decode(item['sha512'], validate=True)
        if len(digest) != 64:
            raise ValueError('Invalid object checksum')
        value = {'size': item['size'], 'sha512': item['sha512']}
        if key in objects and objects[key] != value:
            raise ValueError('Conflicting object declaration')
        objects[key] = value
    return objects

def safe_directory(path, create=False):
    path = Path(os.path.abspath(path))
    if create:
        # Check every existing ancestor before making missing directories.
        if not path.exists():
            safe_directory(path.parent, True)
            try:
                path.mkdir(mode=0o755)
            except FileExistsError:
                pass
    for parent in [*reversed(path.parents), path]:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('Object directory contains a link or unexpected entry')
    return path

def checked_object(root, key, expected):
    safe_directory(root / key[:2])
    file = root / key[:2] / key
    before = file.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != expected['size']:
        raise ValueError('Unexpected object file')
    a, b = hashlib.sha256(), hashlib.sha512()
    with file.open('rb') as stream:
        opened = os.fstat(stream.fileno())
        if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
            raise ValueError('Object replaced before reading')
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            a.update(chunk)
            b.update(chunk)
        after = os.fstat(stream.fileno())
    final = file.lstat()
    # Python 3.12 Windows exposes different ctime semantics for path stat and
    # fstat. Compare it within each API, while matching file identity across APIs.
    identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_nlink)
    if identity(before) != identity(after) or identity(before) != identity(final) or before.st_ctime_ns != final.st_ctime_ns or opened.st_ctime_ns != after.st_ctime_ns or a.hexdigest() != key or base64.b64encode(b.digest()).decode() != expected['sha512']:
        raise ValueError('Object checksum or identity mismatch')
    return file

def missing_objects(root, objects):
    safe_directory(root, True)
    missing = []
    for key, value in objects.items():
        try:
            checked_object(root, key, value)
        except FileNotFoundError:
            missing.append(key)
    return missing

def pack_objects(root, objects, missing, archive):
    if len(missing) != len(set(missing)) or any(key not in objects for key in missing):
        raise ValueError('Transport includes undeclared objects')
    with tarfile.open(archive, 'x:gz', compresslevel=6, format=tarfile.USTAR_FORMAT) as output:
        for key in sorted(missing):
            file = checked_object(root, key, objects[key])
            entry = tarfile.TarInfo(key[:2] + '/' + key)
            entry.size, entry.mode, entry.mtime = objects[key]['size'], 0o644, 0
            with file.open('rb') as stream:
                output.addfile(entry, stream)

def apply_objects(root, objects, archive):
    safe_directory(root, True)
    seen = set()
    with tarfile.open(archive, 'r:gz') as source:
        for entry in source:
            parts = entry.name.split('/')
            key = parts[-1]
            if len(parts) != 2 or not HASH.fullmatch(key) or parts[0] != key[:2] or key not in objects or key in seen or not entry.isfile() or entry.size != objects[key]['size']:
                raise ValueError('Invalid object archive member')
            seen.add(key)
            folder = safe_directory(root / key[:2], True)
            temporary = folder / ('.pending-' + uuid.uuid4().hex)
            target = folder / key
            a, b, count = hashlib.sha256(), hashlib.sha512(), 0
            try:
                with temporary.open('xb') as output, source.extractfile(entry) as incoming:
                    for chunk in iter(lambda: incoming.read(1024 * 1024), b''):
                        output.write(chunk)
                        a.update(chunk)
                        b.update(chunk)
                        count += len(chunk)
                    output.flush()
                    os.fsync(output.fileno())
                if count != entry.size or a.hexdigest() != key or base64.b64encode(b.digest()).decode() != objects[key]['sha512']:
                    raise ValueError('Received object failed checksum')
                os.chmod(temporary, 0o644)
                try:
                    os.link(temporary, target)
                except FileExistsError:
                    checked_object(root, key, objects[key])
            finally:
                try:
                    temporary.unlink()
                except FileNotFoundError:
                    pass
    remaining = missing_objects(root, objects)
    if remaining:
        raise ValueError('Release still has missing objects')
    return {'verifiedObjects': len(objects), 'receivedObjects': len(seen), 'bytes': sum(item['size'] for item in objects.values())}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['missing', 'apply'], required=True)
    parser.add_argument('--release', required=True)
    parser.add_argument('--objects', required=True)
    parser.add_argument('--archive')
    args = parser.parse_args()
    objects, root = inventory(Path(args.release)), Path(args.objects)
    if args.mode == 'missing':
        print(json.dumps({'missing': missing_objects(root, objects)}))
    else:
        print(json.dumps(apply_objects(root, objects, args.archive)))

if __name__ == '__main__':
    main()
