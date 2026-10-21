"""Temporary loopback-only receiver for one checksummed release artifact."""
import hashlib
import hmac
import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

with open(sys.argv[1], encoding='utf-8') as source:
    config = json.load(source)
locks = {}
lock_guard = threading.Lock()

def chunk_lock(index):
    with lock_guard:
        return locks.setdefault(index, threading.Lock())

class Receiver(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, status, value):
        data = json.dumps(value).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def do_PUT(self):
        if not hmac.compare_digest(
                self.headers.get('Authorization', '').encode('utf-8'), ('Bearer ' + config['token']).encode('utf-8')):
            return self.respond(401, {'error': 'unauthorized'})
        if config.get('chunkSize'):
            return self.put_chunked()
        if self.path != config['path']:
            return self.respond(404, {'error': 'path'})
        if self.headers.get('Content-Length') != str(config['size']):
            return self.respond(400, {'error': 'size'})
        self.connection.settimeout(90)
        created = False
        try:
            digest, remaining = hashlib.sha512(), config['size']
            with open(config['destination'], 'xb') as target:
                created = True
                while remaining:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError('incomplete')
                    target.write(chunk)
                    digest.update(chunk)
                    remaining -= len(chunk)
                target.flush()
                os.fsync(target.fileno())
            if digest.hexdigest() != config['sha512hex']:
                raise ValueError('checksum')
            os.chmod(config['destination'], 0o644)
            return self.respond(200, {'size': config['size'], 'sha512hex': digest.hexdigest()})
        except Exception:
            if created:
                os.unlink(config['destination'])
            self.respond(400, {'error': 'transfer-failed'})

    def do_GET(self):
        if not hmac.compare_digest(self.headers.get('Authorization', '').encode('utf-8'),
                                   ('Bearer ' + config['token']).encode('utf-8')):
            return self.respond(401, {'error': 'unauthorized'})
        match = re.fullmatch(re.escape(config['path']) + r'/chunks/(0|[1-9][0-9]{0,5})', self.path)
        if not config.get('chunkSize') or not match:
            return self.respond(404, {'error': 'path'})
        index = int(match.group(1))
        if index >= (config['size'] + config['chunkSize'] - 1) // config['chunkSize']:
            return self.respond(404, {'error': 'index'})
        with chunk_lock(index):
            target = os.path.join(config['chunks'], str(index))
            if not os.path.isfile(target):
                return self.respond(404, {'error': 'missing'})
            digest = hashlib.sha256()
            with open(target, 'rb') as source:
                for data in iter(lambda: source.read(65536), b''):
                    digest.update(data)
            return self.respond(200, {'size': os.path.getsize(target), 'sha256': digest.hexdigest()})

    def put_chunked(self):
        match = re.fullmatch(re.escape(config['path']) + r'/chunks/(0|[1-9][0-9]{0,5})', self.path)
        count = (config['size'] + config['chunkSize'] - 1) // config['chunkSize']
        if match:
            index = int(match.group(1))
            length = min(config['chunkSize'], config['size'] - index * config['chunkSize'])
            expected = self.headers.get('X-Chunk-Sha256', '')
            if index >= count or self.headers.get('Content-Length') != str(length) or not re.fullmatch('[a-f0-9]{64}', expected):
                return self.respond(400, {'error': 'chunk'})
            target = os.path.join(config['chunks'], str(index))
            with chunk_lock(index):
                if os.path.exists(target):
                    return self.respond(409, {'error': 'exists'})
                self.connection.settimeout(90)
                try:
                    digest, remaining = hashlib.sha256(), length
                    with open(target + '.partial', 'xb') as output:
                        while remaining:
                            data = self.rfile.read(min(65536, remaining))
                            if not data:
                                raise ValueError('incomplete')
                            output.write(data)
                            digest.update(data)
                            remaining -= len(data)
                        output.flush()
                        os.fsync(output.fileno())
                    if digest.hexdigest() != expected:
                        raise ValueError('checksum')
                    os.rename(target + '.partial', target)
                    return self.respond(200, {'index': index, 'size': length})
                except Exception:
                    if os.path.isfile(target + '.partial'):
                        os.unlink(target + '.partial')
                    return self.respond(400, {'error': 'chunk-failed'})
        if self.path != config['path'] + '/complete' or self.headers.get('Content-Length') != '0':
            return self.respond(400, {'error': 'path'})
        with chunk_lock('complete'):
            if os.path.exists(config['destination']):
                return self.respond(409, {'error': 'exists'})
            for index in range(count):
                part = os.path.join(config['chunks'], str(index))
                if not os.path.isfile(part) or os.path.getsize(part) != min(config['chunkSize'], config['size'] - index * config['chunkSize']):
                    return self.respond(400, {'error': 'missing-chunk'})
            created = False
            try:
                digest = hashlib.sha512()
                with open(config['destination'], 'xb') as output:
                    created = True
                    for index in range(count):
                        with open(os.path.join(config['chunks'], str(index)), 'rb') as source:
                            for data in iter(lambda: source.read(1024 * 1024), b''):
                                digest.update(data)
                                output.write(data)
                    output.flush()
                    os.fsync(output.fileno())
                if digest.hexdigest() != config['sha512hex']:
                    raise ValueError('checksum')
                os.chmod(config['destination'], 0o644)
                return self.respond(200, {'size': config['size'], 'sha512hex': digest.hexdigest()})
            except Exception:
                if created:
                    os.unlink(config['destination'])
                return self.respond(400, {'error': 'assemble-failed'})

class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    request_queue_size = 128

server = Server(('127.0.0.1', 0), Receiver)
with open(config['ready'], 'x', encoding='utf-8') as ready:
    json.dump({'port': server.server_address[1]}, ready)
server.serve_forever()
