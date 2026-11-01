"""Общие средства для тестов: изолированный сервер на временной папке (HTTPS), клиент, проверки."""
import atexit
import hashlib
import http.client
import json
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
import uuid

if os.name == "nt":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        if stream is not None:
            try:
                stream.reconfigure(encoding="utf-8")
            except (AttributeError, ValueError):
                pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE
PIN = "48291"
_cache = {"dir": None, "n": 0}


def cert_cache():
    if _cache["dir"] is None:
        import server
        import socket
        import certgen
        d = tempfile.mkdtemp(prefix="pivo-cert-")
        _cleanup.dirs.append(d)
        certgen.ensure(d, ["127.0.0.1", server.lan_ip()], ["localhost", socket.gethostname()])
        _cache["dir"] = d
    return _cache["dir"]


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def needs_rid(path, body):
    return path == "/api/customers" or path.endswith("/purchase") or path.endswith("/redeem") or (path.endswith("/undo") and body.get("confirm"))


class Client:
    def __init__(self, port):
        self.port, self.cookie, self.last_headers = port, "", {}

    def call(self, method, path, body=None, headers=None, raw=False, timeout=20):
        if method == "POST" and isinstance(body, dict) and needs_rid(path, body) and "request_id" not in body:
            body = dict(body, request_id=uuid.uuid4().hex)
        c = http.client.HTTPSConnection("127.0.0.1", self.port, timeout=timeout, context=CTX)
        h = {"X-Requested-With": "pivo", "Content-Type": "application/json"}
        if self.cookie:
            h["Cookie"] = self.cookie
        h.update(headers or {})
        c.request(method, path, json.dumps(body) if body is not None else None, h)
        r = c.getresponse()
        data = r.read()
        self.last_headers = {k.lower(): v for k, v in r.getheaders()}
        sc = r.getheader("Set-Cookie")
        if sc and sc.startswith("sid=") and "Max-Age=0" not in sc:
            self.cookie = sc.split(";")[0]
        c.close()
        if raw:
            return r.status, data
        return r.status, (json.loads(data) if data else {})

    def send_and_drop(self, method, path, body):
        """отправить запрос и не дождаться ответа (потеря ответа по дороге)"""
        c = http.client.HTTPSConnection("127.0.0.1", self.port, timeout=20, context=CTX)
        h = {"X-Requested-With": "pivo", "Content-Type": "application/json", "Cookie": self.cookie}
        c.request(method, path, json.dumps(body), h)
        time.sleep(0.05)
        c.sock.setsockopt(__import__("socket").SOL_SOCKET, __import__("socket").SO_LINGER, __import__("struct").pack("ii", 1, 0))
        c.close()


class Env:
    n = 0

    def __init__(self):
        Env.n += 1
        self.root = tempfile.mkdtemp(prefix="pivo-")
        _cleanup.dirs.append(self.root)
        self.data = os.path.join(self.root, "data")
        os.makedirs(self.data)
        shutil.copytree(cert_cache(), os.path.join(self.data, "cert"))
        self.settings = os.path.join(self.root, "settings.json")
        shutil.copy(os.path.join(HERE, "settings.example.json"), self.settings)
        self.fault = os.path.join(self.root, "fault.json")
        self.port = 19100 + (os.getpid() % 500) * 5 + Env.n % 5 + Env.n * 7 % 3000 // 3
        self.proc = None

    @property
    def data_file(self):
        return os.path.join(self.data, "data.json")

    def start(self):
        env = dict(os.environ, PIVO_PORT=str(self.port), PIVO_DATA=self.data, PIVO_SETTINGS=self.settings, PIVO_FAULT_FILE=self.fault)
        self.proc = subprocess.Popen([sys.executable, os.path.join(HERE, "server.py")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(150):
            if self.proc.poll() is not None:
                raise RuntimeError("сервер завершился при запуске: " + self.proc.stderr.read().decode()[-400:])
            try:
                c = http.client.HTTPSConnection("127.0.0.1", self.port, timeout=1, context=CTX)
                c.request("GET", "/api/state")
                c.getresponse().read()
                c.close()
                return self
            except OSError:
                time.sleep(0.1)
        raise RuntimeError("сервер не запустился")

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait()

    def died(self, wait=3.0):
        t = time.time()
        while time.time() - t < wait:
            if self.proc.poll() is not None:
                return True
            time.sleep(0.05)
        return False

    def set_fault(self, stage, once=True):
        with open(self.fault, "w") as f:
            json.dump({"stage": stage, "once": once}, f)

    def client(self):
        return Client(self.port)

    def login(self, first=False):
        c = self.client()
        if first:
            c.call("POST", "/api/setup", {"pin": PIN})
        st, _ = c.call("POST", "/api/login", {"pin": PIN})
        assert st == 200, f"вход не удался ({st})"
        return c


def check(cond, msg):
    print(("OK   " if cond else "FAIL ") + msg)
    if not cond:
        check.failed += 1


check.failed = 0


@atexit.register
def _cleanup():
    for d in list(_cleanup.dirs):
        shutil.rmtree(d, ignore_errors=True)


_cleanup.dirs = []
