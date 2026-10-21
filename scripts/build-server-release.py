"""Repackage a compiled server using the unchanged, verified production dependency bundle."""
import argparse
import hashlib
import json
from pathlib import Path
import stat
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--base', required=True)
parser.add_argument('--workspace', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
workspace = Path(args.workspace).resolve()
destination = Path(args.output).resolve()
if destination.exists():
    raise ValueError('Output already exists; choose a new release name.')

with zipfile.ZipFile(args.base) as previous:
    old_package = json.loads(previous.read('apps/server/package.json'))
    new_package = json.loads((workspace / 'apps/server/package.json').read_text(encoding='utf-8-sig'))
    if old_package.get('dependencies') != new_package.get('dependencies'):
        raise ValueError('Production dependencies changed; build a fresh dependency bundle instead.')
    old_lock = json.loads(previous.read('package-lock.json'))
    new_lock = json.loads((workspace / 'package-lock.json').read_text(encoding='utf-8-sig'))
    comparable_lock = json.loads(json.dumps(new_lock))
    # A desktop version-only bump does not change this verified server bundle.
    # Every dependency, integrity field and all other lock metadata remain equal.
    if 'apps/client' in old_lock.get('packages', {}) and 'apps/client' in comparable_lock.get('packages', {}):
        comparable_lock['packages']['apps/client']['version'] = old_lock['packages']['apps/client']['version']
    if old_lock != comparable_lock:
        raise ValueError('Lockfile changed; build a fresh dependency bundle instead.')
    compiled = workspace / 'apps/server/dist'
    if not (compiled / 'main.js').is_file() or not (compiled / 'app.js').is_file():
        raise ValueError('Compile the server before packaging.')
    payload = {entry.filename: previous.read(entry) for entry in previous.infolist()
               if not entry.is_dir() and not entry.filename.startswith(('apps/server/dist/', 'apps/server/migrations/'))}
    for directory in ('apps/server/dist', 'apps/server/migrations'):
        for path in (workspace / directory).rglob('*'):
            if path.is_file():
                payload[path.relative_to(workspace).as_posix()] = path.read_bytes()
    for name in ('apps/server/package.json', 'docs/server.md', 'infra/.env.example', 'infra/client-update-public.pem', 'package-lock.json'):
        payload[name] = (workspace / name).read_bytes()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
        for name, data in sorted(payload.items()):
            if name.startswith('/') or '..' in Path(name).parts or '\\' in name:
                raise ValueError('Unsafe bundle member path.')
            entry = zipfile.ZipInfo(name)
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            output.writestr(entry, data)
print(json.dumps({'archive': str(destination), 'bytes': destination.stat().st_size,
                  'sha256': hashlib.sha256(destination.read_bytes()).hexdigest()}))
