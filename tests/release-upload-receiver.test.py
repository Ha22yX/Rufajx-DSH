import hashlib
from concurrent.futures import ThreadPoolExecutor
import http.client
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

with tempfile.TemporaryDirectory(prefix='rufa-release-receiver-') as temporary:
    root = Path(temporary).resolve()
    payload = b'MZ isolated upload'
    config = {'path': '/fixture', 'token': 'synthetic-only', 'size': len(payload),
              'sha512hex': hashlib.sha512(payload).hexdigest(),
              'destination': str(root / 'artifact.exe'), 'ready': str(root / 'ready.json')}
    file = root / 'config.json'
    file.write_text(json.dumps(config), encoding='utf-8')
    receiver = Path(__file__).resolve().parents[1] / 'scripts/release-upload-receiver.py'
    child = subprocess.Popen([sys.executable, '-B', str(receiver), str(file)],
                             creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    try:
        for _ in range(100):
            if Path(config['ready']).exists():
                break
            time.sleep(.05)
        port = json.loads(Path(config['ready']).read_text())['port']
        def put(data, token='synthetic-only'):
            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
            try:
                connection.request('PUT', '/fixture', data, {'Authorization': 'Bearer ' + token})
                response = connection.getresponse()
                response.read()
                return response.status
            finally:
                connection.close()
        assert put(b'', 'wrong') == 401
        assert not Path(config['destination']).exists()
        assert put(b'wrong-size') == 400
        assert put(b'X' * len(payload)) == 400
        assert not Path(config['destination']).exists()
        assert put(payload) == 200
        assert Path(config['destination']).read_bytes() == payload
        assert put(payload) == 400
        assert Path(config['destination']).read_bytes() == payload
        print('Receiver checks passed: authentication, length, checksum, exact bytes, no replacement.')
    finally:
        child.terminate()
        child.wait(timeout=10)

with tempfile.TemporaryDirectory(prefix='rufa-chunk-receiver-') as temporary:
    root = Path(temporary).resolve()
    payload = bytes(range(256)) * 8192 + b'final'
    chunks = root / 'chunks'
    chunks.mkdir()
    config = {'path': '/fixture', 'token': 'synthetic-only', 'size': len(payload),
              'sha512hex': hashlib.sha512(payload).hexdigest(), 'chunkSize': 131072,
              'chunks': str(chunks), 'destination': str(root / 'artifact.exe'),
              'ready': str(root / 'ready.json')}
    file = root / 'config.json'
    file.write_text(json.dumps(config), encoding='utf-8')
    child = subprocess.Popen([sys.executable, '-B', str(receiver), str(file)],
                             creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    try:
        for _ in range(100):
            if Path(config['ready']).exists():
                break
            time.sleep(.05)
        port = json.loads(Path(config['ready']).read_text())['port']
        def send(path, data=b'', token='synthetic-only', checksum=None):
            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
            try:
                connection.request('PUT', '/fixture' + path, data, {
                    'Authorization': 'Bearer ' + token,
                    'X-Chunk-Sha256': checksum or hashlib.sha256(data).hexdigest()})
                response = connection.getresponse()
                response.read()
                return response.status
            finally:
                connection.close()
        assert send('/chunks/0', b'', 'wrong') == 401
        assert send('/complete') == 400
        assert send('/chunks/../artifact.exe') == 400
        assert send('/chunks/99999') == 400
        first = payload[:config['chunkSize']]
        assert send('/chunks/0', first, checksum='0'*64) == 400
        assert not list(chunks.iterdir())
        def part(index):
            start = index * config['chunkSize']
            return send('/chunks/' + str(index), payload[start:start+config['chunkSize']])
        count = (len(payload) + config['chunkSize'] - 1) // config['chunkSize']
        with ThreadPoolExecutor(max_workers=8) as pool:
            assert all(status == 200 for status in pool.map(part, range(count)))
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
        connection.request('GET', '/fixture/chunks/0', headers={'Authorization': 'Bearer synthetic-only'})
        receipt = connection.getresponse()
        assert receipt.status == 200
        assert json.loads(receipt.read()) == {'size': len(first), 'sha256': hashlib.sha256(first).hexdigest()}
        connection.close()
        assert send('/chunks/0', first) == 409
        assert send('/complete') == 200
        assert Path(config['destination']).read_bytes() == payload
        assert send('/complete') == 409
        print('Parallel receiver checks passed: auth, paths, bounds, chunk checksum, concurrent assembly, final bytes, no replacement.')
    finally:
        child.terminate()
        child.wait(timeout=10)
