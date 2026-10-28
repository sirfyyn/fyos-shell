#!/usr/bin/env python3
"""Tests für tools/begleiter_shim.py (python3 -m unittest tools/test_begleiter_shim.py, aus apps/fyos-shell).

Der Shim läuft als echter Prozess vor einem kleinen "Studio" (in diesem Test eine eingebettete Python-Zeile), das die Kennung
nicht kennt. Geprüft: Kopf nur auf /api/state, Weiterreichen von POST samt Rumpf, Streaming in Stücken, Fehler 502 bei totem
Studio, Beenden mit SIGTERM samt Studio.
"""
import http.client
import os
import signal
import socket
import subprocess
import sys
import time
import unittest
from pathlib import Path

SHIM = Path(__file__).resolve().parent / "begleiter_shim.py"

STUDIO = r'''
import http.server, sys, time
class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path == "/api/state":
            b = b'{"version":"1.2.3","models":[]}'
            self.send_response(200); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
        elif self.path == "/strom":
            self.send_response(200); self.send_header("Content-Type","text/event-stream"); self.send_header("Transfer-Encoding","chunked"); self.end_headers()
            for i in range(3):
                d = ("data: %d\n\n" % i).encode()
                self.wfile.write(b"%x\r\n%s\r\n" % (len(d), d)); self.wfile.flush(); time.sleep(0.4)
            self.wfile.write(b"0\r\n\r\n")
        else:
            b = b"hallo"; self.send_response(200); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0); d = self.rfile.read(n)
        b = b"echo:" + d; self.send_response(200); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
'''


def freier_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ShimTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = freier_port()
        cls.shim = subprocess.Popen([sys.executable, str(SHIM), "--port", str(cls.port), "--kennung", "k-123", "--",
                                     sys.executable, "-c", STUDIO, "{upstream}"])
        ende = time.time() + 10
        while time.time() < ende:
            try:
                if cls.hole("GET", "/api/state")[0].status == 200:
                    return
            except OSError:
                pass
            time.sleep(0.1)
        raise RuntimeError("Shim wird nicht bereit")

    @classmethod
    def tearDownClass(cls):
        if cls.shim.poll() is None:
            cls.shim.terminate()
            cls.shim.wait(timeout=15)

    @classmethod
    def hole(cls, methode, pfad, rumpf=None):
        c = http.client.HTTPConnection("127.0.0.1", cls.port, timeout=10)
        c.request(methode, pfad, body=rumpf)
        r = c.getresponse()
        return r, r.read()

    def test_kennung_nur_auf_api_state(self):
        r, rumpf = self.hole("GET", "/api/state")
        self.assertEqual(r.status, 200)
        self.assertEqual(r.getheader("X-FYOS-Kennung"), "k-123")
        self.assertIn(b"1.2.3", rumpf)
        r, rumpf = self.hole("GET", "/sonst")
        self.assertIsNone(r.getheader("X-FYOS-Kennung"))
        self.assertEqual(rumpf, b"hallo")

    def test_post_rumpf_wird_durchgereicht(self):
        r, rumpf = self.hole("POST", "/x", b"abc")
        self.assertEqual(rumpf, b"echo:abc")

    def test_strom_kommt_in_stuecken_an(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("GET", "/strom")
        r = c.getresponse()
        t0 = time.time()
        erstes = r.fp.readline()  # erste Zeile muss lange vor dem Ende des Stroms da sein (Gesamtdauer ~1,2 s)
        self.assertLess(time.time() - t0, 0.9)
        self.assertTrue(erstes.strip().startswith(b"data:") or erstes.strip() != b"")

    def test_totes_studio_gibt_502_und_beendet_nicht_den_shim(self):
        port = freier_port()
        shim = subprocess.Popen([sys.executable, str(SHIM), "--port", str(port), "--kennung", "z", "--", sys.executable, "-c", "import time; time.sleep(60)"])
        try:
            ende = time.time() + 10
            r = None
            while time.time() < ende:
                try:
                    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                    c.request("GET", "/api/state")
                    r = c.getresponse()
                    break
                except OSError:
                    time.sleep(0.1)
            self.assertIsNotNone(r)
            self.assertEqual(r.status, 502)
        finally:
            shim.terminate()
            shim.wait(timeout=15)


class BeendenTest(unittest.TestCase):
    def test_sigterm_beendet_shim_und_studio(self):
        port = freier_port()
        pidfile = Path(os.environ.get("TMPDIR", "/tmp")) / f"shimtest-{port}.pid"
        studio = f"import os,time; open({str(pidfile)!r},'w').write(str(os.getpid())); time.sleep(60)"
        shim = subprocess.Popen([sys.executable, str(SHIM), "--port", str(port), "--kennung", "z", "--", sys.executable, "-c", studio])
        ende = time.time() + 10
        while not pidfile.exists() and time.time() < ende:
            time.sleep(0.1)
        kind = int(pidfile.read_text())
        shim.send_signal(signal.SIGTERM)
        shim.wait(timeout=15)
        ende = time.time() + 5
        lebt = True
        while lebt and time.time() < ende:
            try:
                os.kill(kind, 0)
                time.sleep(0.1)
            except ProcessLookupError:
                lebt = False
        pidfile.unlink(missing_ok=True)
        self.assertFalse(lebt, "Studio läuft nach dem Beenden des Shims weiter")


if __name__ == "__main__":
    unittest.main()
