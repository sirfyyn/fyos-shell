#!/usr/bin/env python3
"""Tests des Test-Programms für den lokalen Runner (python3 -m unittest discover -s tools): Vertrag Version 1."""
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

PROGRAMM = Path(__file__).resolve().parent / "lokaler_runner_test.py"
TOKEN = "-".join(["probe"] * 8)  # erfundener Testwert


def freier_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Vertrag(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        t = Path(cls.tmp.name)
        (t / "wurzel" / "a" / "tief").mkdir(parents=True)
        (t / "wurzel" / "b").mkdir()
        (t / "draussen").mkdir()
        (t / "gesperrt").mkdir()
        cls.gesperrt = str((t / "gesperrt").resolve())
        cls.wurzel = str((t / "wurzel").resolve())
        cls.draussen = str((t / "draussen").resolve())
        cls.port = freier_port()
        env = dict(os.environ, FYOS_RUNNER_PORT=str(cls.port), FYOS_RUNNER_TOKEN=TOKEN, FYOS_RUNNER_ORDNER_ERLAUBT=cls.wurzel, FYOS_RUNNER_HOST="127.0.0.1")
        cls.p = subprocess.Popen([sys.executable, str(PROGRAMM)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", cls.port), timeout=0.1).close()
                break
            except OSError:
                time.sleep(0.05)

    @classmethod
    def tearDownClass(cls):
        if cls.p.poll() is None:
            cls.p.kill()
        cls.p.wait()
        cls.tmp.cleanup()

    def api(self, pfad, daten=None, token=TOKEN, methode=None):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{pfad}", data=None if daten is None else json.dumps(daten).encode(), method=methode or ("GET" if daten is None else "POST"))
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req, timeout=5) as a:
                return a.status, json.loads(a.read())
        except urllib.error.HTTPError as f:
            return f.code, json.loads(f.read() or b"{}")

    def test_gesundheit_und_token(self):
        self.assertEqual(self.api("/api/health")[1]["ok"], True)
        self.assertEqual(self.api("/api/health", token=None)[0], 401)
        self.assertEqual(self.api("/api/health", token="falsch")[0], 401)

    def test_ordnerliste_nach_vertrag(self):
        c, w = self.api("/api/ordner")
        self.assertEqual((c, w["wurzeln"][0], w["eintraege"]), (200, self.wurzel, []))
        c, a = self.api("/api/ordner?pfad=" + urllib.request.quote(self.wurzel))
        self.assertEqual([e["name"] for e in a["eintraege"]], ["a", "b"])
        self.assertTrue(a["erlaubt"] and all(e["ordner"] for e in a["eintraege"]))
        self.assertEqual(self.api("/api/ordner?pfad=" + urllib.request.quote(self.gesperrt))[:2], (403, {"fehler": "ausserhalb"}))
        self.assertEqual(self.api("/api/ordner?pfad=" + urllib.request.quote(self.wurzel + "/gibt-es-nicht"))[0], 404)
        self.assertEqual(self.api("/api/ordner?pfad=relativ")[0], 403)

    def test_neue_wurzel_und_sitzung_mit_ordner(self):
        c, s = self.api("/api/gespraeche", {"titel": "x", "ordner": self.draussen})
        self.assertEqual((c, s), (403, {"fehler": "ausserhalb"}))
        c, w = self.api("/api/ordner/erlauben", {"pfad": self.draussen})
        self.assertEqual((c, self.draussen in w["wurzeln"]), (200, True))
        c, s = self.api("/api/gespraeche", {"titel": "x", "ordner": self.draussen})
        self.assertEqual(c, 201)
        self.assertEqual(s["gespraech"]["agent"]["cwd"], self.draussen)
        liste = self.api("/api/gespraeche")[1]["gespraeche"]
        self.assertIn(self.draussen, [g["agent"]["cwd"] for g in liste])
        self.assertEqual(self.api("/api/ordner/erlauben", {"pfad": "/gibt/es/nicht"})[0], 400)

    def test_umbenennen_und_archivieren(self):
        c, s = self.api("/api/gespraeche", {"titel": "Alt"})
        sid = s["gespraech"]["id"]
        c, r = self.api(f"/api/gespraech/{sid}", {"titel": "Neu"}, methode="PATCH")
        self.assertEqual((c, r["gespraech"]["meta"]["titel"]), (200, "Neu"))
        self.assertEqual(self.api(f"/api/gespraech/{sid}", {"titel": ""}, methode="PATCH")[1]["gespraech"]["meta"]["titel"], "Neu")
        self.api(f"/api/gespraech/{sid}", {"archiviert": True}, methode="PATCH")
        self.assertNotIn(sid, [g["id"] for g in self.api("/api/gespraeche")[1]["gespraeche"]])
        self.api(f"/api/gespraech/{sid}", {"archiviert": False}, methode="PATCH")
        self.assertEqual({g["id"]: g["titel"] for g in self.api("/api/gespraeche")[1]["gespraeche"]}[sid], "Neu")
        self.assertEqual(self.api("/api/gespraech/9999", {"titel": "x"}, methode="PATCH")[0], 500)
        self.assertEqual(self.api(f"/api/gespraech/{sid}", {"titel": "x"}, token=None, methode="PATCH")[0], 401)

    def test_zuletzt_sigterm_beendet_sauber(self):
        # eigener Prozess, damit die anderen Tests nicht gestört werden
        port = freier_port()
        env = dict(os.environ, FYOS_RUNNER_PORT=str(port), FYOS_RUNNER_TOKEN=TOKEN)
        p = subprocess.Popen([sys.executable, str(PROGRAMM)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.1).close()
                break
            except OSError:
                time.sleep(0.05)
        p.send_signal(signal.SIGTERM)
        self.assertEqual(p.wait(timeout=8), 0)


if __name__ == "__main__":
    unittest.main()
