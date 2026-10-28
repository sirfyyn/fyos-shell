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
        # Die Pid-Datei wird beim Öffnen angelegt, der Inhalt kommt einen Augenblick später: auf eine ganze Zahl warten.
        kind = None
        while kind is None and time.time() < ende + 10:
            try:
                kind = int(pidfile.read_text())
            except (ValueError, FileNotFoundError):
                time.sleep(0.1)
        self.assertIsNotNone(kind, "das Studio hat seine Pid nicht geschrieben")
        # Erst SIGTERM, wenn der Shim wirklich lauscht (dann sind Signalbehandlung und Studio bereit); vorher wäre der Test ein Wettlauf.
        bereit = time.time() + 15
        while time.time() < bereit:
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
                break
            except OSError:
                time.sleep(0.1)
        shim.send_signal(signal.SIGTERM)
        shim.wait(timeout=20)
        # Frist großzügig und die Prozessgruppe prüfen: ein beendeter, aber noch nicht eingesammelter Prozess (Zombie) meldet kill(pid, 0) als lebend.
        ende = time.time() + 20
        lebt = True
        while lebt and time.time() < ende:
            try:
                os.kill(kind, 0)
                zustand = subprocess.run(["ps", "-o", "stat=", "-p", str(kind)], capture_output=True, text=True).stdout.strip()
                if zustand.startswith("Z") or not zustand:
                    lebt = False  # Zombie zählt als beendet
                else:
                    time.sleep(0.1)
            except ProcessLookupError:
                lebt = False
        if lebt:
            try:
                os.kill(kind, signal.SIGKILL)  # nicht verwaist zurücklassen
            except ProcessLookupError:
                pass
        pidfile.unlink(missing_ok=True)
        self.assertFalse(lebt, "Studio läuft nach dem Beenden des Shims weiter")


class PlattformTest(unittest.TestCase):
    """Der Prozessbaum-Teil ist plattformneutral; der Windows-Zweig wird hier mit Attrappen geprüft (kein Windows-Rechner nötig)."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(SHIM.parent))
        import begleiter_shim
        cls.shim_modul = begleiter_shim

    def test_start_unter_windows_nutzt_eigene_prozessgruppe_ohne_fenster(self):
        aufrufe = []
        self.shim_modul.kind_starten(["studio"], windows=True, popen=lambda *a, **kw: aufrufe.append((a, kw)))
        (args, kw), = aufrufe
        self.assertEqual(kw, {"creationflags": 0x00000200 | 0x08000000})
        self.assertNotIn("start_new_session", kw)

    def test_start_unter_unix_nutzt_eigene_sitzung(self):
        aufrufe = []
        self.shim_modul.kind_starten(["studio"], windows=False, popen=lambda *a, **kw: aufrufe.append(kw))
        self.assertEqual(aufrufe, [{"start_new_session": True}])

    def _attrappe(self, beendet):
        class Kind:
            pid = 4711
            signale = []

            def poll(self):
                return 0 if beendet else None

            def send_signal(self, s):
                self.signale.append(s)

            def wait(self, timeout=None):
                if not beendet:
                    raise subprocess.TimeoutExpired("studio", timeout)
        return Kind()

    def test_beenden_unter_windows_erst_ctrl_break_dann_taskkill_auf_den_baum(self):
        k = self._attrappe(beendet=False)
        befehle = []
        self.shim_modul.baum_beenden(k, windows=True, ausfuehren=lambda cmd, **kw: befehle.append(cmd), sanft_s=0.01)
        self.assertEqual(k.signale, [getattr(signal, "CTRL_BREAK_EVENT", 1)])
        self.assertEqual(befehle, [["taskkill", "/PID", "4711", "/T", "/F"]])

    def test_beenden_unter_windows_bei_schon_beendetem_studio_ist_kein_fehler(self):
        k = self._attrappe(beendet=True)
        befehle = []
        self.shim_modul.baum_beenden(k, windows=True, ausfuehren=lambda cmd, **kw: befehle.append(cmd))
        self.assertEqual(k.signale, [], "kein Signal an einen beendeten Prozess")
        self.assertEqual(len(befehle), 1, "Nachkommen werden trotzdem eingesammelt")

    @unittest.skipIf(os.name == "nt", "Unix-Zweig")
    def test_beenden_unter_unix_nimmt_den_ganzen_baum(self):
        kind = self.shim_modul.kind_starten(["sh", "-c", "sleep 30 & echo $! ; wait"], windows=False, popen=lambda b, **kw: subprocess.Popen(b, stdout=subprocess.PIPE, text=True, **kw))
        enkel = int(kind.stdout.readline())
        os.kill(enkel, 0)
        self.shim_modul.baum_beenden(kind, windows=False, sanft_s=5)
        ende = time.time() + 3
        lebt = True
        while lebt and time.time() < ende:
            try:
                os.kill(enkel, 0)
                time.sleep(0.05)
            except ProcessLookupError:
                lebt = False
        self.assertFalse(lebt)

    def test_abbruchsignale_binden_sigterm(self):
        alt = signal.getsignal(signal.SIGTERM)
        try:
            self.shim_modul.abbruchsignale(lambda *_: None)
            self.assertNotEqual(signal.getsignal(signal.SIGTERM), alt)
        finally:
            signal.signal(signal.SIGTERM, alt)


if __name__ == "__main__":
    unittest.main()
