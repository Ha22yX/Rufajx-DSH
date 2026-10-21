"""Copy a private server staging artifact, verifying the published digest again.

Publication transport only. This does not activate a feed or touch an app install.
Compatible with the deployment host's Python 3.6.
"""
import argparse
import base64
import hashlib
import os
from pathlib import Path
import stat


def checked_parent(path):
    path = Path(path).absolute()
    for item in list(reversed(path.parents)) + [path]:
        entry = item.lstat()
        if not stat.S_ISDIR(entry.st_mode) or stat.S_ISLNK(entry.st_mode):
            raise ValueError('Artifact parent must be a real directory')
    return path


def copy_verified(source, destination, size, sha512):
    source, destination = Path(source).absolute(), Path(destination).absolute()
    if type(size) is not int or size < 0 or len(base64.b64decode(sha512, validate=True)) != 64:
        raise ValueError('Invalid expected artifact metadata')
    checked_parent(source.parent)
    checked_parent(destination.parent)
    source_fd = os.open(str(source), os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    target_fd = None
    created = None
    try:
        before = os.fstat(source_fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != size:
            raise ValueError('Staged artifact is not a matching single-link regular file')
        target_fd = os.open(str(destination), os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o644)
        created = os.fstat(target_fd)
        digest = hashlib.sha512()
        count = 0
        with os.fdopen(source_fd, 'rb') as incoming, os.fdopen(target_fd, 'wb') as output:
            source_fd, target_fd = None, None
            for chunk in iter(lambda: incoming.read(1024 * 1024), b''):
                count += len(chunk)
                if count > size:
                    raise ValueError('Staged artifact grew')
                digest.update(chunk)
                output.write(chunk)
            after = os.fstat(incoming.fileno())
            if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError('Staged artifact changed during copying')
            if count != size or base64.b64encode(digest.digest()).decode('ascii') != sha512:
                raise ValueError('Staged artifact digest mismatch')
            output.flush()
            os.fsync(output.fileno())
        created = None
    finally:
        if source_fd is not None:
            os.close(source_fd)
        if target_fd is not None:
            os.close(target_fd)
        if created is not None:
            try:
                current = destination.lstat()
                if (current.st_dev, current.st_ino) == (created.st_dev, created.st_ino):
                    destination.unlink()
            except FileNotFoundError:
                pass


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--destination', required=True)
    parser.add_argument('--size', type=int, required=True)
    parser.add_argument('--sha512', required=True)
    args = parser.parse_args()
    copy_verified(args.source, args.destination, args.size, args.sha512)
