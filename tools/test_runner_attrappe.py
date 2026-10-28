#!/usr/bin/env python3
"""Tests der Runner-Attrappe (python3 -m unittest tools/test_runner_attrappe.py): Token, Strom mit Snapshot, Szenarien, Freigabe, Kappen."""
import json
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import runner_attrappe as r  # noqa: E402

TOKEN = "-".join(["probe"] * 4)  # erfundener Testwert


class Basis(unittest.TestCase):
    token = TOKEN

    @classmethod
    def setUpClass(cls):
        cls.z = r.Zustand(cls.token, 0.02, None)
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), r.handler(cls.z))
        cls.srv.daemon_threads = True
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.basis = f"http://127.0.0.1:{cls.srv.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def anfrage(self, pfad, daten=None, token=TOKEN):
        req = urllib.request.Request(self.basis + pfad, data=None if daten is None else json.dumps(daten).encode(), method="GET" if daten is None else "POST")
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        with urllib.request.urlopen(req, timeout=5) as a:
            return json.loads(a.read())

    def strom(self, bis, frist=5):
        """Liest den Strom, bis `bis(ereignisse)` wahr ist; liefert (Snapshot, Ereignisse)."""
        req = urllib.request.Request(self.basis + "/api/gespraech/1/ereignisse", headers={"Authorization": f"Bearer {TOKEN}"})
        snap, evs, art = None, [], None
        ende = time.time() + frist
        with urllib.request.urlopen(req, timeout=frist) as a:
            for zeile in a:
                z = zeile.decode().rstrip("\n")
                if z.startswith("event: "):
                    art = z[7:]
                elif z.startswith("data: "):
                    d = json.loads(z[6:])
                    if art == "snapshot":
                        snap = d
                    else:
                        evs.extend(d)
                    if bis(evs) or time.time() > ende:
                        break
        return snap, evs


class Tests(Basis):
    def test_token_wird_verlangt(self):
        with self.assertRaises(urllib.error.HTTPError) as f:
            self.anfrage("/api/health", token="x" * 20)
        self.assertEqual(f.exception.code, 401)
        self.assertTrue(self.anfrage("/api/health")["ok"])

    def test_streaming_liefert_teile_und_endnachricht(self):
        threading.Timer(0.1, lambda: self.anfrage("/api/gespraech/1/nachricht", {"text": "streaming"})).start()
        _, evs = self.strom(lambda e: any(x["type"] == "run_end" for x in e))
        deltas = [c["delta"] for x in evs if x["type"] == "message_update" for c in x["changes"]]
        self.assertEqual("".join(deltas), "Antwort Teil 1 Antwort Teil 2 Antwort Teil 3 Antwort Ende")
        self.assertTrue(any(x["type"] == "message_end" for x in evs))

    def test_freigabe_wird_entschieden_und_erscheint_im_strom(self):
        threading.Timer(0.1, lambda: self.anfrage("/api/gespraech/1/nachricht", {"text": "freigabe"})).start()
        deadline = time.time() + 5
        while time.time() < deadline and not any(f["status"] == "offen" for f in self.anfrage("/api/freigaben")["freigaben"]):
            time.sleep(0.05)
        offen = [f for f in self.anfrage("/api/freigaben")["freigaben"] if f["status"] == "offen"]
        self.assertEqual(len(offen), 1)
        self.anfrage(f"/api/freigaben/{offen[0]['id']}", {"entscheidung": "erteilt", "von": "mensch"})
        self.assertEqual(self.anfrage("/api/freigaben")["freigaben"][-1]["status"], "erteilt")
        kinds = [e["kind"] for e in self.anfrage("/api/gespraech/1/ansicht?voll=1")["entries"]]
        self.assertIn("fyos.freigabe", kinds)
        self.assertIn("fyos.freigabe-entscheidung", kinds)

    def test_snapshot_enthaelt_den_laufenden_text_nach_dem_neuverbinden(self):
        self.z.tempo = 0.3  # zwölf Teile in etwa 1,8 s, damit der Strom mitten im Lauf geöffnet werden kann
        try:
            threading.Timer(0.05, lambda: self.anfrage("/api/gespraech/1/nachricht", {"text": "lang"})).start()
            time.sleep(0.6)
            snap, _ = self.strom(lambda e: True)
            self.assertTrue(snap.get("run"))
            self.assertTrue(snap["generation"]["message"]["content"][0]["text"].startswith("Lang 1"))
            deadline = time.time() + 8
            while time.time() < deadline and self.z.laeuft:
                time.sleep(0.05)
        finally:
            self.z.tempo = 0.02

    def test_kappen_trennt_offene_stroeme(self):
        res = {}

        def lese():
            try:
                res["snap"], res["evs"] = self.strom(lambda e: False, frist=5)
            except Exception as e:  # abgerissene Verbindung
                res["fehler"] = e

        t = threading.Thread(target=lese)
        t.start()
        time.sleep(0.3)
        self.assertEqual(self.anfrage("/api/e2e/kappen", {})["gekappt"], 1)
        t.join(6)
        self.assertFalse(t.is_alive())


if __name__ == "__main__":
    unittest.main()
