#!/usr/bin/env python3
"""Prueft tools/nas_deploy.sh gegen einen Schein-Node-RED auf 127.0.0.1 (ohne Netz, ohne NAS): lehnt Node-RED das Einspielen ab
(HTTP 4xx/5xx), muss das Skript mit Exit != 0 enden. Eine curl-Attrappe biegt jede http://host:port-Adresse auf den Schein-Server um.
Usage: python3 tools/nas_deploy_test.py"""
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading


class NodeRed(http.server.BaseHTTPRequestHandler):
    post_status = 200

    def antwort(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        self.antwort(200, {"rev": "r1", "flows": []})

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.antwort(NodeRed.post_status, {"rev": "r2"} if NodeRed.post_status == 200 else {"code": "version_mismatch", "message": "abgelehnt"})

    def log_message(self, *a):
        pass


srv = http.server.HTTPServer(("127.0.0.1", 0), NodeRed)
threading.Thread(target=srv.serve_forever, daemon=True).start()
d = tempfile.mkdtemp()
fehler = 0
try:
    echt = shutil.which("curl")
    with open(os.path.join(d, "curl"), "w") as f:
        f.write("#!%s\nimport os, re, sys\nos.execv(%r, [%r] + [re.sub(r'^http://[^/]+', 'http://127.0.0.1:%d', a) for a in sys.argv[1:]])\n"
                % (sys.executable, echt, echt, srv.server_port))
    os.chmod(os.path.join(d, "curl"), 0o755)
    flow = os.path.join(d, "flow.json")
    with open(flow, "w") as f:
        json.dump({"rev": "r1", "flows": []}, f)
    env = dict(os.environ, PATH=d + os.pathsep + os.environ["PATH"],
               HEISHAMONR_LOKAL=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lokal.example.json"))
    skript = os.path.join(os.path.dirname(os.path.abspath(__file__)), "nas_deploy.sh")
    for status, soll_ok in ((200, True), (409, False), (500, False)):
        NodeRed.post_status = status
        rc = subprocess.run(["sh", skript, flow], env=env, capture_output=True).returncode
        gut = (rc == 0) == soll_ok
        fehler += not gut
        print("%s POST %d -> Exit %d (erwartet %s)" % ("OK  " if gut else "FAIL", status, rc, "0" if soll_ok else "!= 0"))
finally:
    srv.shutdown()
    shutil.rmtree(d, ignore_errors=True)
print("\nERGEBNIS nas_deploy_test: %d FAIL" % fehler)
sys.exit(1 if fehler else 0)
