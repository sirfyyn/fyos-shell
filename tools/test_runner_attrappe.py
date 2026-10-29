#!/usr/bin/env python3
"""Tests der Runner-Attrappe (python3 -m unittest tools/test_runner_attrappe.py): Token, Strom mit Snapshot, Szenarien, Freigabe, Kappen."""
import json
import sys
import threading
import time
import unittest
import urllib.error
import urllib.parse
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

    def test_sitzungsliste_konfiguration_und_neue_sitzung(self):
        liste = self.anfrage("/api/gespraeche")["gespraeche"]
        self.assertEqual([g["id"] for g in liste][:2], [1, 2])
        bereiche = self.anfrage("/api/konfiguration")["arbeitsbereiche"]
        self.assertIn(liste[1]["arbeitsbereich"], bereiche)
        self.assertEqual(self.anfrage("/api/gespraech/2")["agent"]["cwd"], bereiche["projekt"]["pfad"])
        neu = self.anfrage("/api/gespraeche", {"titel": "Eigene", "arbeitsbereich": "projekt"})["gespraech"]
        self.assertGreaterEqual(neu["id"], 3)
        self.assertEqual(self.anfrage(f"/api/gespraech/{neu['id']}")["meta"]["titel"], "Eigene")
        with self.assertRaises(urllib.error.HTTPError) as f:
            self.anfrage("/api/gespraeche", {"arbeitsbereich": "gibt-es-nicht"})
        self.assertEqual(f.exception.code, 400)

    def test_sitzungen_haben_getrennte_verlaeufe(self):
        self.anfrage("/api/gespraech/2/nachricht", {"text": "reset"})
        deadline = time.time() + 5
        while time.time() < deadline and self.z.sitzungen[2].laeuft:
            time.sleep(0.05)
        zwei = [e["kind"] for e in self.anfrage("/api/gespraech/2/ansicht?voll=1")["entries"]]
        self.assertIn("pi.reset", zwei)
        eins = [e["kind"] for e in self.anfrage("/api/gespraech/1/ansicht?voll=1")["entries"]]
        self.assertNotIn("pi.reset", eins)

    def test_terminal_und_diff_szenarien_liefern_werkzeugereignisse(self):
        for text, name in (("terminal", "bash"), ("diff", "edit")):
            threading.Timer(0.1, lambda t=text: self.anfrage("/api/gespraech/2/nachricht", {"text": t})).start()
            req = urllib.request.Request(self.basis + "/api/gespraech/2/ereignisse", headers={"Authorization": f"Bearer {TOKEN}"})
            evs, art = [], None
            with urllib.request.urlopen(req, timeout=8) as a:
                for zeile in a:
                    z = zeile.decode().rstrip("\n")
                    if z.startswith("event: "):
                        art = z[7:]
                    elif z.startswith("data: ") and art == "ereignisse":
                        evs.extend(json.loads(z[6:]))
                        if any(x["type"] == "run_end" for x in evs):
                            break
            starts = [x for x in evs if x["type"] == "tool_execution_start"]
            self.assertEqual(starts[0]["toolName"], name)
            if name == "bash":
                teile = "".join(x["output"]["append"] for x in evs if x["type"] == "tool_execution_update")
                self.assertIn("\x1b[32m", teile)
            else:
                self.assertIn("edits", starts[0]["args"])
                self.assertEqual(starts[1]["toolName"], "write")

    def test_aktivitaetsstrom_meldet_zeilen_je_sitzung(self):
        threading.Timer(0.3, lambda: self.anfrage("/api/gespraech/2/nachricht", {"text": "reset"})).start()
        req = urllib.request.Request(self.basis + "/api/strom", headers={"Authorization": f"Bearer {TOKEN}"})
        zeilen, art = [], None
        with urllib.request.urlopen(req, timeout=8) as a:
            for zeile in a:
                z = zeile.decode().rstrip("\n")
                if z.startswith("event: "):
                    art = z[7:]
                elif z.startswith("data: "):
                    d = json.loads(z[6:])
                    if art == "hallo":
                        self.assertEqual(len(d["gespraeche"]), len(self.z.sitzungen))
                    else:
                        zeilen.append(d)
                        if d["typ"] == "fertig":
                            break
        self.assertTrue(all(x["gespraech"] == 2 for x in zeilen))
        self.assertEqual([x["typ"] for x in zeilen][-1], "fertig")

    def test_zwei_nachrichten_einer_sitzung_laufen_nacheinander(self):
        threading.Timer(0.1, lambda: self.anfrage("/api/gespraech/2/nachricht", {"text": "reset"})).start()
        threading.Timer(0.15, lambda: self.anfrage("/api/gespraech/2/nachricht", {"text": "streaming"})).start()
        req = urllib.request.Request(self.basis + "/api/gespraech/2/ereignisse", headers={"Authorization": f"Bearer {TOKEN}"})
        arten, art, enden = [], None, 0
        with urllib.request.urlopen(req, timeout=10) as a:
            for zeile in a:
                z = zeile.decode().rstrip("\n")
                if z.startswith("event: "):
                    art = z[7:]
                elif z.startswith("data: ") and art == "ereignisse":
                    for x in json.loads(z[6:]):
                        arten.append(x["type"])
                        enden += x["type"] == "run_end"
                    if enden >= 2:
                        break
        # run_start, ..., run_end, run_start, ..., run_end: nie zwei Starts vor dem ersten Ende
        zug = [t for t in arten if t in ("run_start", "run_end")]
        self.assertEqual(zug, ["run_start", "run_end", "run_start", "run_end"])

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


class OrdnerTests(Basis):
    """Ordner je Sitzung: GET /api/ordner und `ordner` in POST /api/gespraeche (Vertrag des Runners)."""

    ohne_ordner = False

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        if cls.ohne_ordner:
            cls.z.wurzeln = []

    def roh(self, pfad, daten=None, token=TOKEN):
        """Wie anfrage, aber mit Statuscode auch bei Fehlern: (status, json)."""
        req = urllib.request.Request(self.basis + pfad, data=None if daten is None else json.dumps(daten).encode(), method="GET" if daten is None else "POST")
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req, timeout=5) as a:
                return a.status, json.loads(a.read())
        except urllib.error.HTTPError as f:
            return f.code, json.loads(f.read())

    def liste(self, pfad):
        return self.roh("/api/ordner?pfad=" + urllib.parse.quote(pfad, safe=""))

    def test_ohne_pfad_nur_die_wurzeln(self):
        status, d = self.roh("/api/ordner")
        self.assertEqual(status, 200)
        self.assertEqual(d["wurzeln"], r.ORDNER_WURZELN)
        self.assertIsNone(d["pfad"])
        self.assertEqual(d["eintraege"], [])
        self.assertTrue(d["erlaubt"])

    def test_auflisten_nur_ordner_alphabetisch_ohne_versteckte(self):
        status, d = self.liste("/probe/ordner-a")
        self.assertEqual(status, 200)
        self.assertEqual(d["pfad"], "/probe/ordner-a")
        self.assertEqual([e["name"] for e in d["eintraege"]], ["Notizen", "projekt-eins", "projekt-zwei"])
        self.assertTrue(all(e["ordner"] is True for e in d["eintraege"]))
        self.assertNotIn("abgeschnitten", d)

    def test_mehr_als_500_sind_abgeschnitten(self):
        status, d = self.liste("/probe/ordner-b/viele")
        self.assertEqual(status, 200)
        self.assertEqual(len(d["eintraege"]), 500)
        self.assertTrue(d["abgeschnitten"])

    def test_ausbrueche_sind_403_ausserhalb(self):
        for p in ["/probe/ordner-a/../draussen", "/probe", "/", "/etc", "/probe/ordner-a/..", "/probe/ordner-ax", "/probe/draussen"]:
            status, d = self.liste(p)
            self.assertEqual((status, d["fehler"]), (403, "ausserhalb"), p)

    def test_ungueltige_pfade_sind_400(self):
        for p in ["relativ/pfad", ".", "/probe/ordner-a\0/x"]:
            status, d = self.liste(p)
            self.assertEqual((status, d["fehler"]), (400, "ungueltig"), repr(p))

    def test_nicht_vorhanden_404_und_datei_400(self):
        self.assertEqual(self.liste("/probe/ordner-a/gibtsnicht")[0], 404)
        status, d = self.liste("/probe/ordner-a/liesmich.txt")
        self.assertEqual((status, d["fehler"]), (400, "kein_ordner"))

    def test_token_wird_verlangt(self):
        self.assertEqual(self.roh("/api/ordner", token="x" * 20)[0], 401)
        self.assertEqual(self.roh("/api/gespraeche", {"ordner": "/probe/ordner-a"}, token="x" * 20)[0], 401)

    def test_post_mit_ordner_setzt_cwd_in_gespraech_und_liste(self):
        status, d = self.roh("/api/gespraeche", {"titel": "Mit Ordner", "arbeitsbereich": "projekt", "ordner": "/probe/ordner-a/projekt-eins/"})
        self.assertEqual(status, 201)
        g = d["gespraech"]
        self.assertEqual(g["agent"]["cwd"], "/probe/ordner-a/projekt-eins")
        self.assertEqual(g["meta"]["arbeitsbereich"], "projekt")
        self.assertEqual(self.anfrage(f"/api/gespraech/{g['id']}")["agent"]["cwd"], "/probe/ordner-a/projekt-eins")
        eintrag = next(x for x in self.anfrage("/api/gespraeche")["gespraeche"] if x["id"] == g["id"])
        self.assertEqual(eintrag["agent"]["cwd"], "/probe/ordner-a/projekt-eins")
        self.assertEqual(eintrag["ordner"], "/probe/ordner-a/projekt-eins")
        # ohne Ordner gilt der Arbeitsbereich
        root = next(x for x in self.anfrage("/api/gespraeche")["gespraeche"] if x["id"] == 1)
        self.assertEqual(root["agent"]["cwd"], r.BEREICHE["standard"]["pfad"])
        self.assertIsNone(root["ordner"])

    def test_post_mit_schlechtem_ordner_ist_400_und_legt_nichts_an(self):
        vorher = len(self.anfrage("/api/gespraeche")["gespraeche"])
        for p in ["/probe/draussen", "/probe/ordner-a/../draussen", "relativ", "/probe/ordner-a/gibtsnicht", "/probe/ordner-a/liesmich.txt", "/probe/ordner-a\0", 42]:
            status, d = self.roh("/api/gespraeche", {"ordner": p})
            self.assertEqual(status, 400, repr(p))
            self.assertGreater(len(d["fehler"]), 10)
        self.assertEqual(len(self.anfrage("/api/gespraeche")["gespraeche"]), vorher)


class OrdnerAusTests(OrdnerTests):
    """Funktion aus (--ohne-ordner): keine Wurzeln, Auflisten 403, POST mit ordner 400 „nicht freigegeben“."""

    ohne_ordner = True

    def test_ohne_pfad_nur_die_wurzeln(self):
        status, d = self.roh("/api/ordner")
        self.assertEqual((status, d["wurzeln"], d["erlaubt"]), (200, [], False))

    def test_funktion_aus(self):
        self.assertEqual(self.liste("/probe/ordner-a")[0], 403)
        status, d = self.roh("/api/gespraeche", {"ordner": "/probe/ordner-a"})
        self.assertEqual(status, 400)
        self.assertIn("nicht freigegeben", d["fehler"])
        self.assertEqual(self.roh("/api/gespraeche", {"titel": "ohne"})[0], 201)

    # Die Tests der Oberklasse, die erlaubte Wurzeln voraussetzen, entfallen hier.
    test_auflisten_nur_ordner_alphabetisch_ohne_versteckte = None
    test_mehr_als_500_sind_abgeschnitten = None
    test_nicht_vorhanden_404_und_datei_400 = None
    test_post_mit_ordner_setzt_cwd_in_gespraech_und_liste = None
    test_post_mit_schlechtem_ordner_ist_400_und_legt_nichts_an = None
    test_ausbrueche_sind_403_ausserhalb = None


if __name__ == "__main__":
    unittest.main()
