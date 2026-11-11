#!/usr/bin/python3
"""Hash an inherited descriptor once in an already-restricted process."""
import errno
import fcntl
import hashlib
import json
import os
import re
import select
import socket
import stat
import subprocess
import sys
import time


def signature(st):
    return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_mode, st.st_uid, st.st_gid)


def fail(code):
    raise RuntimeError(code)


def verify_sandbox(canary):
    try:
        with open(canary, 'rb'):
            fail('SANDBOX_UNVERIFIED')
    except OSError as error:
        if error.errno not in (errno.EPERM, errno.EACCES):
            fail('SANDBOX_UNVERIFIED')
    for kind, address in ((socket.SOCK_STREAM, ('127.0.0.1', 1)), (socket.SOCK_DGRAM, ('192.0.2.1', 9))):
        try:
            with socket.socket(socket.AF_INET, kind) as sock:
                sock.settimeout(2)
                sock.connect(address)
            fail('SANDBOX_UNVERIFIED')
        except OSError as error:
            if error.errno not in (errno.EPERM, errno.EACCES):
                fail('SANDBOX_UNVERIFIED')


def main():
    if sys.platform != 'darwin' or len(sys.argv) != 2 or not hasattr(fcntl, 'F_NOCACHE'):
        fail('MODEL_NOCACHE_UNAVAILABLE')
    fd, canary = 3, sys.argv[1]
    before = os.fstat(fd)
    if (fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE) != os.O_RDONLY:
        fail('MODEL_NOCACHE_FAILED')
    if not stat.S_ISREG(before.st_mode) or os.lseek(fd, 0, os.SEEK_CUR) != 0:
        fail('MODEL_NOCACHE_FAILED')
    verify_sandbox(canary)
    try:
        if fcntl.fcntl(fd, fcntl.F_NOCACHE, 1) != 0:
            fail('MODEL_NOCACHE_UNAVAILABLE')
    except OSError:
        fail('MODEL_NOCACHE_UNAVAILABLE')
    worker = subprocess.Popen(['/usr/bin/shasum', '-a', '256', '-b', '-'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None, close_fds=True, env={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
    try:
        digest, count = hashlib.sha256(), 0
        while True:
            data = os.read(fd, 65536)
            if not data:
                break
            digest.update(data)
            count += len(data)
            view = memoryview(data)
            while view:
                written = os.write(worker.stdin.fileno(), view)
                if written <= 0:
                    fail('MODEL_NOCACHE_FAILED')
                view = view[written:]
        worker.stdin.close()
        worker.stdin = None
        deadline = time.monotonic() + 10
        output = bytearray()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([worker.stdout], [], [], remaining)[0]:
                fail('MODEL_NOCACHE_FAILED')
            part = os.read(worker.stdout.fileno(), 257 - len(output))
            if not part:
                break
            output.extend(part)
            if len(output) > 256:
                fail('MODEL_NOCACHE_FAILED')
        status = worker.wait(timeout=max(0.001, deadline - time.monotonic()))
        match = re.fullmatch(rb'([a-f0-9]{64})[ \t]+\*?-[\r\n]*', output)
        if status != 0 or not match or match.group(1).decode() != digest.hexdigest():
            fail('MODEL_NOCACHE_FAILED')
        offset = os.lseek(fd, 0, os.SEEK_CUR)
        if count != before.st_size or offset != count or signature(os.fstat(fd)) != signature(before):
            fail('MODEL_CHANGED')
        print(json.dumps({'version': 1, 'digest': digest.hexdigest(), 'bytes': count, 'offset': offset, 'sandboxVerified': True, 'nocache': True, 'hashesAgree': True}, separators=(',', ':')))
    finally:
        if worker.stdin is not None:
            try:
                worker.stdin.close()
            except OSError:
                pass
        if worker.poll() is None:
            worker.terminate()
            try:
                worker.wait(timeout=5)
            except subprocess.TimeoutExpired:
                worker.kill()
                worker.wait(timeout=5)
        worker.stdout.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        allowed = {'MODEL_NOCACHE_UNAVAILABLE', 'MODEL_NOCACHE_FAILED', 'MODEL_CHANGED', 'SANDBOX_UNVERIFIED'}
        reason = str(error) if str(error) in allowed else 'MODEL_NOCACHE_FAILED'
        print(json.dumps({'error': reason}, separators=(',', ':')), file=sys.stderr)
        sys.exit(1)
