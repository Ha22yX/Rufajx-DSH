"""Fetch locked SW Python dependencies on the build machine, without installing them."""
import hashlib
import json
from pathlib import Path
import re
import tempfile
import urllib.request


def prepare():
    source = Path(__file__).resolve().parent.parent / 'preinstalled/solidworks'
    lock = json.loads((source / 'dependencies.lock.json').read_text(encoding='utf-8'))
    target = source / 'wheels'
    target.mkdir(parents=True, exist_ok=True)
    for entry in lock['wheels']:
        name, url, expected = entry['file'], entry['url'], entry['sha256']
        if not re.fullmatch(r'[A-Za-z0-9_.-]+\.whl', name) or not re.fullmatch(r'[0-9a-f]{64}', expected):
            raise ValueError('Invalid locked artifact')
        if not url.startswith('https://files.pythonhosted.org/'):
            raise ValueError('Unexpected dependency host')
        destination = target / name
        if destination.exists():
            if hashlib.sha256(destination.read_bytes()).hexdigest() != expected:
                raise ValueError(f'Existing artifact checksum mismatch: {name}')
            print(f'Verified {name}')
            continue
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=target, suffix='.download', delete=False) as output:
                temporary = Path(output.name)
                digest = hashlib.sha256()
                with urllib.request.urlopen(url, timeout=120) as response:
                    while block := response.read(1024 * 1024):
                        digest.update(block)
                        output.write(block)
            if digest.hexdigest() != expected:
                raise ValueError(f'Download checksum mismatch: {name}')
            # rename on Windows refuses to overwrite a concurrently created destination.
            temporary.rename(destination)
            print(f'Downloaded and verified {name}')
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    prepare()
