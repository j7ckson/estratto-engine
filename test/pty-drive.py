#!/usr/bin/env python3
# Drives a CLI in a pseudo-terminal: pty-drive.py <json steps> -- cmd args...   steps = [[regex, answer], ...]; prints {"output":..., "code":n}
import os, sys, pty, re, json, select, time
steps = json.loads(sys.argv[1]); cmd = sys.argv[3:]
env = dict(os.environ)
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(cmd[0], cmd, env)
buf = ''; i = 0; deadline = time.time() + 60; sent = {}
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try: data = os.read(fd, 4096).decode('utf8', 'replace')
        except OSError: break
        if not data: break
        buf += data
        while i < len(steps) and re.search(steps[i][0], buf):
            time.sleep(0.15)
            os.write(fd, (steps[i][1] + '\n').encode()); buf += '<<SENT %d>>' % i; i += 1
    else:
        try:
            p, status = os.waitpid(pid, os.WNOHANG)
            if p: 
                code = os.waitstatus_to_exitcode(status); print(json.dumps({'output': buf, 'code': code, 'steps': i})); sys.exit(0)
        except ChildProcessError: break
try:
    _, status = os.waitpid(pid, 0); code = os.waitstatus_to_exitcode(status)
except Exception: code = -1
print(json.dumps({'output': buf, 'code': code, 'steps': i}))
