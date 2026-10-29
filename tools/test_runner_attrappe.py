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

    def patch(self, pfad, daten, token=TOKEN):
        req = urllib.request.Request(self.basis + pfad, data=json.dumps(daten).encode(), method="PATCH")
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

    def test_freigaben_form_wie_beim_runner_alle_sitzungen_neueste_zuerst_fehler_als_500(self):
        """Form aus deploy/runner/pi-durable/test/freigaben-wege.test.js (echter Runner): Liste über alle Sitzungen, Sprungziel, Fehlerbild der Entscheidung."""
        vorher = {f["id"] for f in self.anfrage("/api/freigaben")["freigaben"]}
        threading.Timer(0.05, lambda: self.anfrage("/api/gespraech/1/nachricht", {"text": "freigabe eins"})).start()
        time.sleep(0.4)
        threading.Timer(0.05, lambda: self.anfrage("/api/gespraech/2/nachricht", {"text": "freigabe hoch zwei"})).start()
        deadline = time.time() + 5
        neu = []
        while time.time() < deadline and len(neu) < 2:
            time.sleep(0.05)
            neu = [f for f in self.anfrage("/api/freigaben")["freigaben"] if f["id"] not in vorher]
        self.assertEqual(len(neu), 2)
        antwort = self.anfrage("/api/freigaben")
        self.assertIs(antwort["ok"], True)
        self.assertEqual([f["id"] for f in antwort["freigaben"][:2]], [neu[0]["id"], neu[1]["id"]])
        spaet, frueh = neu[0], neu[1]
        self.assertGreater(spaet["erstellt"], frueh["erstellt"], "neueste zuerst")
        self.assertEqual((spaet["conversationId"], spaet["gespraechTitel"], spaet["risiko"]), (2, "Zweite Sitzung", "high"))
        self.assertEqual((frueh["conversationId"], frueh["risiko"]), (1, "low"))
        for f in (spaet, frueh):
            self.assertEqual((f["status"], f["werkzeug"], f["befehl"]), ("offen", "bash", "echo probe"))
            self.assertTrue(f["aktion"] and f["kontext"])
        # Fehler wie beim Runner: 500 mit {ok: false, fehler}
        for pfad, koerper, text in [
            (f"/api/freigaben/{frueh['id']}", {"entscheidung": "vielleicht"}, "Entscheidung: erteilt oder abgelehnt"),
            ("/api/freigaben/gibts-nicht", {"entscheidung": "erteilt"}, "Freigabe nicht gefunden"),
        ]:
            with self.assertRaises(urllib.error.HTTPError) as f:
                self.anfrage(pfad, koerper)
            self.assertEqual(f.exception.code, 500)
            self.assertEqual(json.loads(f.exception.read()), {"ok": False, "fehler": text})
        # Entscheidung: die Antwort ist die neue Liste, der Eintrag steht im Strom der Sitzung der Freigabe, ein zweites Mal ist ein Fehler
        liste = self.anfrage(f"/api/freigaben/{spaet['id']}", {"entscheidung": "abgelehnt", "von": "mensch"})
        self.assertIs(liste["ok"], True)
        entschieden = next(f for f in liste["freigaben"] if f["id"] == spaet["id"])
        self.assertEqual((entschieden["status"], entschieden["entschiedenVon"]), ("abgelehnt", "mensch"))
        self.assertEqual(next(f for f in liste["freigaben"] if f["id"] == frueh["id"])["status"], "offen")
        self.assertIn("fyos.freigabe-entscheidung", [e["kind"] for e in self.anfrage("/api/gespraech/2/ansicht?voll=1")["entries"]])
        with self.assertRaises(urllib.error.HTTPError) as f:
            self.anfrage(f"/api/freigaben/{spaet['id']}", {"entscheidung": "erteilt"})
        self.assertEqual(json.loads(f.exception.read())["fehler"], "Freigabe ist bereits abgelehnt")
        self.anfrage(f"/api/freigaben/{frueh['id']}", {"entscheidung": "erteilt"})  # räumt das Szenario auf

    def test_freigabe_zerstoererisch_und_notiz_wie_beim_runner(self):
        """Feld zerstoererisch (hohes Risiko gilt immer als zerstörerisch, „zerst“ setzt es bei mittlerem Risiko) und notiz (Entscheidungs-Eintrag, auf 600 gekürzt, leer = null)."""
        vorher = {f["id"] for f in self.anfrage("/api/freigaben")["freigaben"]}
        # eine Freigabe je Sitzung (eine zweite in derselben Sitzung wartet, bis die erste entschieden ist)
        for sitzung, text in [(2, "freigabe hoch"), (1, "freigabe zerst")]:
            threading.Timer(0.05, lambda s=sitzung, t=text: self.anfrage(f"/api/gespraech/{s}/nachricht", {"text": t})).start()
            time.sleep(0.4)
        deadline = time.time() + 5
        neu = []
        while time.time() < deadline and len(neu) < 2:
            time.sleep(0.05)
            neu = sorted((f for f in self.anfrage("/api/freigaben")["freigaben"] if f["id"] not in vorher), key=lambda f: f["erstellt"])
        self.assertEqual([(f["risiko"], f["zerstoererisch"]) for f in neu], [("high", True), ("medium", True)])
        hoch, mittel = neu
        liste = self.anfrage(f"/api/freigaben/{hoch['id']}", {"entscheidung": "erteilt", "von": "mensch", "notiz": "ok" + "x" * 700})
        self.assertEqual(len(next(f for f in liste["freigaben"] if f["id"] == hoch["id"])["notiz"]), 600)
        eintraege = [e for e in self.anfrage("/api/gespraech/2/ansicht?voll=1")["entries"] if e["kind"] == "fyos.freigabe-entscheidung"]
        self.assertEqual(eintraege[-1]["data"]["notiz"], "ok" + "x" * 598)
        liste = self.anfrage(f"/api/freigaben/{mittel['id']}", {"entscheidung": "abgelehnt", "von": "mensch"})  # ohne Notiz: null
        self.assertIsNone(next(f for f in liste["freigaben"] if f["id"] == mittel["id"])["notiz"])
        time.sleep(0.4)  # die Szenarien enden, bevor der nächste Test eine Sitzung braucht

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

    def test_neue_sitzung_mit_namen_und_standardname(self):
        # wie der echte Runner (neuesGespraech): Name bis 120 Zeichen, ohne Name „Neuer Agent“; Antwort gespraech.meta.titel, Liste gespraeche[].titel
        mit = self.anfrage("/api/gespraeche", {"titel": "Mein Projekt"})["gespraech"]
        self.assertEqual(mit["meta"]["titel"], "Mein Projekt")
        ohne = self.anfrage("/api/gespraeche", {})["gespraech"]
        self.assertEqual(ohne["meta"]["titel"], "Neuer Agent")
        leer = self.anfrage("/api/gespraeche", {"titel": ""})["gespraech"]
        self.assertEqual(leer["meta"]["titel"], "Neuer Agent")
        lang = self.anfrage("/api/gespraeche", {"titel": "x" * 300})["gespraech"]
        self.assertEqual(len(lang["meta"]["titel"]), 120)
        liste = {g["id"]: g for g in self.anfrage("/api/gespraeche")["gespraeche"]}
        self.assertEqual(liste[mit["id"]]["titel"], "Mein Projekt")
        self.assertEqual(liste[ohne["id"]]["titel"], "Neuer Agent")

    def test_umbenennen_und_archivieren_per_patch(self):
        sid = self.anfrage("/api/gespraeche", {"titel": "Alt"})["gespraech"]["id"]
        r = self.patch(f"/api/gespraech/{sid}", {"titel": "Neu"})
        self.assertEqual(r["gespraech"]["meta"]["titel"], "Neu")
        self.assertFalse(r["gespraech"]["meta"]["archiviert"])
        # ein leerer Name ändert nichts, ein zu langer wird gekürzt
        self.assertEqual(self.patch(f"/api/gespraech/{sid}", {"titel": ""})["gespraech"]["meta"]["titel"], "Neu")
        self.assertEqual(len(self.patch(f"/api/gespraech/{sid}", {"titel": "y" * 200})["gespraech"]["meta"]["titel"]), 120)
        self.patch(f"/api/gespraech/{sid}", {"titel": "Neu"})
        # archivieren: weg aus der Liste, einzeln noch lesbar; Umbenennen im Archiv entarchiviert nicht
        self.assertTrue(self.patch(f"/api/gespraech/{sid}", {"archiviert": True})["gespraech"]["meta"]["archiviert"])
        self.assertNotIn(sid, [g["id"] for g in self.anfrage("/api/gespraeche")["gespraeche"]])
        self.assertTrue(self.anfrage(f"/api/gespraech/{sid}")["meta"]["archiviert"])
        self.assertTrue(self.patch(f"/api/gespraech/{sid}", {"titel": "Im Archiv"})["gespraech"]["meta"]["archiviert"])
        self.patch(f"/api/gespraech/{sid}", {"archiviert": False})
        liste = {g["id"]: g for g in self.anfrage("/api/gespraeche")["gespraeche"]}
        self.assertEqual(liste[sid]["titel"], "Im Archiv")
        self.assertFalse(liste[sid]["archiviert"])

    def test_patch_unbekannte_sitzung_und_ohne_token(self):
        with self.assertRaises(urllib.error.HTTPError) as f:
            self.patch("/api/gespraech/999", {"titel": "x"})
        self.assertEqual(f.exception.code, 500)  # so antwortet der echte Runner heute
        self.assertIn("nicht gefunden", json.loads(f.exception.read())["fehler"])
        with self.assertRaises(urllib.error.HTTPError) as g:
            self.patch("/api/gespraech/1", {"titel": "x"}, token="falsch")
        self.assertEqual(g.exception.code, 401)

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
