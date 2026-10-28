#!/usr/bin/env python3
"""Runner-Attrappe für die Prüfung des Profils agent (nur Standardbibliothek, nur Loopback, kein echter Runner, keine Daten).

  runner_attrappe.py [--port N] [--log DATEI] [--token T] [--tempo S]

Spricht den Teil der Runner-Schnittstelle, den die Chat-Seite und die Seitenleiste brauchen:
  GET  /api/health, /api/konfiguration, /api/modelle, /api/freigaben, /api/laeufe
  GET  /api/gespraeche                    Sitzungsliste (Sitzung 1 Hauptgespräch, Sitzung 2 in einem anderen Arbeitsbereich)
  POST /api/gespraeche                    neue Sitzung {titel, arbeitsbereich, modell} → 201 {gespraech: {id, meta, agent}}
  GET  /api/gespraech/<id>                Meta und Arbeitsordner der Sitzung (agent.cwd)
  GET  /api/gespraech/<id>/ansicht?voll=1 Verlauf der Sitzung
  GET  /api/gespraech/<id>/ereignisse     Ereignisstrom (SSE) der Sitzung: erst ein Snapshot, dann Ereignisse, alle 5 s ein Herzschlag-Kommentar
  GET  /api/strom                         Aktivitätsstrom über alle Sitzungen: `hallo`, dann Zeilen {t, gespraech, titel, art, typ, text}
  POST /api/gespraech/<id>/nachricht      startet je nach Text ein Szenario (siehe SZENARIEN)
  POST /api/gespraech/<id>/abbrechen      beendet ein laufendes Szenario früh
  POST /api/freigaben/<id>                Entscheidung (erteilt/abgelehnt), schreibt einen Entscheidungs-Eintrag in den Strom
  POST /api/e2e/ergebnis                  die Seite meldet ein Prüfergebnis (nur Debug-Bauten der Hülle starten das Skript der Seite)
  POST /api/e2e/kappen                    trennt alle offenen Ströme hart (Netzabbruch mitten im Strom)
Mit --token verlangt jede Anfrage `Authorization: Bearer <T>` (sonst 401). Jede Anfrage steht als JSON-Zeile im Protokoll (--log),
mit `auth: true/false` (kam das richtige Token an?), aber nie mit dem Token selbst.
"""
import argparse
import json
import queue
import re
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

SZENARIEN = {
    "streaming": "Antwort in Teilen (Streaming)",
    "werkzeug": "ein Werkzeugaufruf mit Ergebnis (Karte)",
    "terminal": "Bash-Aufruf mit farbiger Ausgabe in Teilen (Terminal-Ansicht, ANSI)",
    "diff": "Edit- und Write-Aufruf (Diff-Ansicht)",
    "freigabe": "eine Freigabe, die entschieden werden muss (nur Erlauben/Ablehnen)",
    "reset": "ein Reset-Marker (neuer Kontext)",
    "lang": "zwölf Teile über sechs Sekunden (Abbruch mitten im Strom)",
}

# Arbeitsbereiche und Modelle der Attrappe (erfundene Namen und Pfade)
BEREICHE = {
    "standard": {"titel": "Standard", "pfad": "/probe/standard"},
    "projekt": {"titel": "Projekt Alpha", "pfad": "/probe/alpha"},
}
MODELLE = [{"id": "probe-modell", "name": "Probe-Modell", "provider": "probe", "max": False}]

ANSI_TEXT = "\x1b[1mBau\x1b[0m gestartet\n\x1b[32mgruen ok\x1b[0m und \x1b[31mrot Fehler\x1b[0m\nFortschritt 10%\rFortschritt 100%\n"


class Sitzung:
    """Eine Sitzung der Attrappe: eigener Verlauf, eigener Strom, eigene Szenarien."""

    def __init__(self, z, sid, titel, art, bereich, erstellt):
        self.z = z
        self.id = sid
        self.titel = titel
        self.art = art
        self.bereich = bereich
        self.erstellt = erstellt
        self.eintraege = []  # Verlauf (für Ansicht und Snapshot)
        self.abonnenten = []  # (queue, Verbindungs-Objekt)
        self.laeuft = False
        self.teil = ""  # Text der laufenden Nachricht
        self.abbruch = threading.Event()
        self.zug_sperre = threading.Lock()

    def liste(self):
        return {"id": self.id, "art": self.art, "titel": self.titel, "arbeitsbereich": self.bereich, "erstellt": self.erstellt, "modell": None, "archiviert": False}

    def meta(self):
        return {"id": self.id, "titel": self.titel, "modell": "probe-modell", "arbeitsbereich": self.bereich, "erstellt": self.erstellt, "art": self.art}

    def senden(self, ereignisse):
        with self.z.sperre:
            for q, _ in list(self.abonnenten):
                q.put(ereignisse)

    def eintrag(self, kind, data=None, model=None):
        e = {"id": self.z.nr(), "kind": kind}
        if data is not None:
            e["data"] = data
        if model is not None:
            e["model"] = model
        with self.z.sperre:
            self.eintraege.append(e)
        return e

    def snapshot(self):
        with self.z.sperre:
            s = {"entries": list(self.eintraege), "agent": {"model": "probe-modell"}, "usage": {"models": {"probe/probe": {"input": 120, "output": 40, "cost": {"total": 0.01}}}}}
            if self.laeuft:
                s["run"] = True
                s["generation"] = {"message": {"role": "assistant", "content": [{"type": "text", "text": self.teil}]}}
            return s

    def pause(self, s):
        # in kleinen Schritten, damit "abbrechen" ein Szenario früh beendet
        ende = time.time() + s * self.z.tempo
        while time.time() < ende and not self.abbruch.is_set():
            time.sleep(0.02)

    def zeile(self, typ, text, wz=None):
        z = {"t": int(time.time() * 1000), "gespraech": self.id, "titel": self.titel, "art": self.art, "typ": typ, "text": text}
        if wz:
            z["wz"] = wz
        self.z.strom_senden("zeile", z)

    def szenario(self, text):
        # Der Runner arbeitet je Sitzung einen Zug nach dem anderen ab: eine zweite Nachricht wartet, bis der laufende Zug zu Ende ist
        # (sonst überschreibt das Ende des ersten Zugs Lauf-Zustand und Snapshot des zweiten).
        with self.zug_sperre:
            self._szenario(text)

    def _szenario(self, text):
        t = text.lower()
        self.abbruch.clear()
        try:
            e = self.eintrag("fyos.mensch", {"text": text})
            self.senden([{"type": "entry_appended", "entry": e}])
            self.zeile("mensch", text)
            with self.z.sperre:
                self.laeuft = True
                self.teil = ""
            self.senden([{"type": "run_start"}, {"type": "message_start", "message": {"role": "assistant", "content": []}}])
            if "freigabe" in t:
                self.freigabe_szenario()
            elif "terminal" in t:
                self.terminal_szenario()
            elif "diff" in t:
                self.diff_szenario()
            elif "werkzeug" in t:
                self.werkzeug_szenario()
            elif "reset" in t:
                e = self.eintrag("pi.reset", {"vorher": 1000, "nachher": 10})
                self.senden([{"type": "entry_appended", "entry": e}])
                self.antwort_in_teilen(["Kontext ist neu."], 0.1)
            elif "lang" in t:
                self.antwort_in_teilen([f"Lang {i} " for i in range(1, 13)], 0.5)
            else:
                self.antwort_in_teilen(["Antwort Teil 1 ", "Antwort Teil 2 ", "Antwort Teil 3 ", "Antwort Ende"], 0.8)
        finally:
            with self.z.sperre:
                self.laeuft = False
            self.senden([{"type": "run_end"}])
            self.zeile("fertig", "Zug fertig")

    def antwort_in_teilen(self, teile, abstand):
        for i, teil in enumerate(teile):
            if self.abbruch.is_set():
                break
            with self.z.sperre:
                self.teil += teil
            self.senden([{"type": "message_update", "changes": [{"type": "text_delta", "contentIndex": 0, "delta": teil}]}])
            self.pause(abstand)
        e = self.eintrag("pi.message", model=[{"role": "assistant", "content": [{"type": "text", "text": self.teil}]}])
        self.senden([{"type": "message_end", "entry": e}])

    def werkzeug_ende(self, tid, name, ergebnis, fehler=False):
        e = self.eintrag("pi.tool", model=[{"role": "toolResult", "toolCallId": tid, "toolName": name, "content": [{"type": "text", "text": ergebnis}], "isError": fehler}])
        self.senden([{"type": "tool_execution_end", "toolCallId": tid, "toolName": name, "entry": e}])

    def werkzeug_szenario(self):
        self.senden([{"type": "tool_execution_start", "toolCallId": "t1", "toolName": "read", "args": {"path": "probe.txt"}}])
        self.zeile("werkzeug", "read probe.txt", "read")
        self.pause(0.5)
        self.werkzeug_ende("t1", "read", "Inhalt der Probe")
        self.antwort_in_teilen(["Werkzeug fertig."], 0.1)

    def terminal_szenario(self):
        tid = f"b{self.z.nr()}"
        self.senden([{"type": "tool_execution_start", "toolCallId": tid, "toolName": "bash", "args": {"command": "./bauen.sh --farbe"}}])
        self.zeile("werkzeug", "bash ./bauen.sh --farbe", "bash")
        self.pause(0.3)
        # absichtlich mitten in einer Farbfolge geteilt: die Seite muss die angefangene Folge festhalten
        for stueck in ["\x1b[1mBau\x1b[0m gestartet\n\x1b[32mgruen ok\x1b[0m und \x1b[3", "1mrot Fehler\x1b[0m\nFortschritt 10%\rFortschritt 100%\n"]:
            self.senden([{"type": "tool_execution_update", "toolCallId": tid, "output": {"append": stueck}}])
            self.pause(0.3)
        self.werkzeug_ende(tid, "bash", ANSI_TEXT)
        self.antwort_in_teilen(["Terminal fertig."], 0.1)

    def diff_szenario(self):
        tid = f"e{self.z.nr()}"
        args = {"path": "src/probe.txt", "edits": [{"oldText": "alte Zeile\ngleich", "newText": "neue Zeile\ngleich\nzusaetzlich"}, {"oldText": "Ende alt", "newText": "Ende neu"}]}
        self.senden([{"type": "tool_execution_start", "toolCallId": tid, "toolName": "edit", "args": args}])
        self.zeile("werkzeug", "edit src/probe.txt", "edit")
        self.pause(0.3)
        self.werkzeug_ende(tid, "edit", "2 Änderungen in src/probe.txt")
        tid2 = f"w{self.z.nr()}"
        self.senden([{"type": "tool_execution_start", "toolCallId": tid2, "toolName": "write", "args": {"path": "neu.txt", "content": "eins\nzwei\ndrei\n"}}])
        self.zeile("werkzeug", "write neu.txt", "write")
        self.pause(0.2)
        self.werkzeug_ende(tid2, "write", "neu.txt geschrieben")
        self.antwort_in_teilen(["Diff fertig."], 0.1)

    def freigabe_szenario(self):
        fid = f"f{self.z.nr()}"
        f = {"id": fid, "sid": self.id, "status": "offen", "erstellt": int(time.time() * 1000), "aktion": "Probe-Aktion ausführen", "risiko": "low", "befehl": "echo probe"}
        with self.z.sperre:
            self.z.freigaben.append(f)
        e = self.eintrag("fyos.freigabe", {"id": fid, "aktion": f["aktion"], "risiko": "low", "werkzeug": "bash"})
        self.senden([{"type": "entry_appended", "entry": e}])
        self.zeile("freigabe", "wartet auf Freigabe: Probe-Aktion ausführen")
        ende = time.time() + 60
        while time.time() < ende and f["status"] == "offen":
            time.sleep(0.1)
        self.antwort_in_teilen(["Freigabe erteilt." if f["status"] == "erteilt" else "Freigabe abgelehnt."], 0.1)


class Zustand:
    def __init__(self, token, tempo, log):
        self.token = token
        self.tempo = tempo
        self.log = log
        self.sperre = threading.RLock()
        self.freigaben = []
        self.strom_abonnenten = []  # (queue, Verbindungs-Objekt) des Aktivitätsstroms
        self.zaehler = 0
        jetzt = int(time.time() * 1000)
        self.sitzungen = {
            1: Sitzung(self, 1, "Probe", "root", "standard", jetzt - 3600_000),
            2: Sitzung(self, 2, "Zweite Sitzung", "mensch", "projekt", jetzt - 7200_000),
        }
        self.naechste_id = 3

    # Die Sitzung 1 bleibt unter den alten Namen erreichbar (Tests und das Prüfskript der ersten Fassung)
    @property
    def eintraege(self):
        return self.sitzungen[1].eintraege

    @property
    def laeuft(self):
        return any(s.laeuft for s in self.sitzungen.values())

    @property
    def abonnenten(self):
        return self.sitzungen[1].abonnenten

    def nr(self):
        with self.sperre:
            self.zaehler += 1
            return self.zaehler

    def protokoll(self, **zeile):
        if self.log:
            with self.sperre, open(self.log, "a", encoding="utf-8") as f:
                f.write(json.dumps(zeile, ensure_ascii=False) + "\n")

    def strom_senden(self, art, daten):
        with self.sperre:
            for q, _ in list(self.strom_abonnenten):
                q.put((art, daten))

    def neue_sitzung(self, titel, bereich):
        with self.sperre:
            sid = self.naechste_id
            self.naechste_id += 1
            s = Sitzung(self, sid, (titel or "").strip()[:120] or "Neuer Agent", "mensch", bereich if bereich in BEREICHE else "standard", int(time.time() * 1000))
            self.sitzungen[sid] = s
        return s

    def sitzung(self, sid):
        try:
            return self.sitzungen.get(int(sid))
        except (TypeError, ValueError):
            return None

    def entscheiden(self, fid, wert):
        with self.sperre:
            f = next((x for x in self.freigaben if x["id"] == fid), None)
            if not f:
                return None
            f["status"] = wert
        s = self.sitzungen.get(f.get("sid", 1)) or self.sitzungen[1]
        e = s.eintrag("fyos.freigabe-entscheidung", {"id": fid, "entscheidung": wert})
        s.senden([{"type": "entry_appended", "entry": e}])
        return [{k: v for k, v in x.items() if k != "sid"} for x in self.freigaben]


def handler(z):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _json(self, code, obj):
            b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(b)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(b)

        def _erlaubt(self):
            gut = z.token is None or self.headers.get("Authorization") == f"Bearer {z.token}"
            z.protokoll(pfad=self.path, methode=self.command, auth=gut, kopf=self.headers.get("X-FYOS-Agent") == "1")
            if not gut:
                self._json(401, {"fehler": "Nicht erlaubt"})
            return gut

        def _koerper(self):
            n = int(self.headers.get("Content-Length") or 0)
            try:
                return json.loads(self.rfile.read(n) or b"{}")
            except json.JSONDecodeError:
                return {}

        def do_GET(self):
            if not self._erlaubt():
                return
            p = urlparse(self.path).path
            if p == "/api/health":
                return self._json(200, {"ok": True, "agent": "probe", "pausiert": False, "geraet": {"name": "Attrappe"}})
            if p == "/api/konfiguration":
                return self._json(200, {"ok": True, "arbeitsbereiche": BEREICHE, "modelle": MODELLE, "version": 1})
            if p == "/api/modelle":
                return self._json(200, {"ok": True, "modelle": MODELLE})
            if p == "/api/gespraeche":
                return self._json(200, {"ok": True, "gespraeche": [s.liste() for s in z.sitzungen.values()]})
            if p == "/api/freigaben":
                return self._json(200, {"freigaben": [{k: v for k, v in x.items() if k != "sid"} for x in z.freigaben]})
            if p == "/api/laeufe":
                return self._json(200, {"laeufe": [{"id": 1, "status": "laeuft"}] if z.laeuft else []})
            if p == "/api/strom":
                return self._strom_aktivitaet()
            m = re.fullmatch(r"/api/gespraech/(\d+)(?:/(ansicht|ereignisse))?", p)
            if m:
                s = z.sitzung(m.group(1))
                if not s:
                    return self._json(404, {"fehler": "Gespräch nicht gefunden"})
                if m.group(2) == "ansicht":
                    return self._json(200, {"entries": list(s.eintraege), "meta": s.meta(), "usage": s.snapshot()["usage"]})
                if m.group(2) == "ereignisse":
                    return self._strom(s)
                return self._json(200, {"ok": True, "id": s.id, "meta": s.meta(), "agent": {"model": "probe-modell", "cwd": BEREICHE[s.bereich]["pfad"], "tools": ["read", "bash", "edit", "write"]}})
            self._json(404, {"fehler": "unbekannt"})

        def _sse_kopf(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()

        def _strom(self, s):
            self._sse_kopf()
            q = queue.Queue()
            with z.sperre:
                s.abonnenten.append((q, self.connection))
            try:
                self.wfile.write(f"event: snapshot\ndata: {json.dumps(s.snapshot(), ensure_ascii=False)}\n\n".encode("utf-8"))
                self.wfile.flush()
                while True:
                    try:
                        ev = q.get(timeout=5)
                        self.wfile.write(f"event: ereignisse\ndata: {json.dumps(ev, ensure_ascii=False)}\n\n".encode("utf-8"))
                    except queue.Empty:
                        self.wfile.write(b": wach\n\n")
                    self.wfile.flush()
            except OSError:
                pass
            finally:
                with z.sperre:
                    s.abonnenten[:] = [a for a in s.abonnenten if a[0] is not q]

        def _strom_aktivitaet(self):
            self._sse_kopf()
            q = queue.Queue()
            with z.sperre:
                z.strom_abonnenten.append((q, self.connection))
            try:
                hallo = {"gespraeche": [{"id": s.id, "titel": s.titel, "art": s.art} for s in z.sitzungen.values()]}
                self.wfile.write(f"event: hallo\ndata: {json.dumps(hallo, ensure_ascii=False)}\n\n".encode("utf-8"))
                self.wfile.flush()
                while True:
                    try:
                        art, daten = q.get(timeout=5)
                        self.wfile.write(f"event: {art}\ndata: {json.dumps(daten, ensure_ascii=False)}\n\n".encode("utf-8"))
                    except queue.Empty:
                        self.wfile.write(b": wach\n\n")
                    self.wfile.flush()
            except OSError:
                pass
            finally:
                with z.sperre:
                    z.strom_abonnenten[:] = [a for a in z.strom_abonnenten if a[0] is not q]

        def do_POST(self):
            if not self._erlaubt():
                return
            p = urlparse(self.path).path
            k = self._koerper()
            if p == "/api/gespraeche":
                if k.get("arbeitsbereich") and k["arbeitsbereich"] not in BEREICHE:
                    return self._json(400, {"fehler": f"Unbekannter Arbeitsbereich: {k['arbeitsbereich']}"})
                s = z.neue_sitzung(k.get("titel"), k.get("arbeitsbereich", "standard"))
                return self._json(201, {"ok": True, "gespraech": {"id": s.id, "meta": s.meta(), "agent": {"model": "probe-modell", "cwd": BEREICHE[s.bereich]["pfad"], "tools": []}, "usage": None}})
            m = re.fullmatch(r"/api/gespraech/(\d+)/(nachricht|abbrechen)", p)
            if m:
                s = z.sitzung(m.group(1))
                if not s:
                    return self._json(404, {"fehler": "Gespräch nicht gefunden"})
                if m.group(2) == "nachricht":
                    threading.Thread(target=s.szenario, args=(str(k.get("text", "")),), daemon=True).start()
                else:
                    s.abbruch.set()
                return self._json(200, {"ok": True})
            if p.startswith("/api/freigaben/"):
                alle = z.entscheiden(p.rsplit("/", 1)[1], k.get("entscheidung", "abgelehnt"))
                return self._json(200 if alle is not None else 404, {"freigaben": alle} if alle is not None else {"fehler": "Freigabe nicht gefunden"})
            if p == "/api/e2e/ergebnis":
                z.protokoll(ergebnis=k)
                return self._json(200, {"ok": True})
            if p == "/api/e2e/kappen":
                with z.sperre:
                    offene = [a for s in z.sitzungen.values() for a in s.abonnenten] + list(z.strom_abonnenten)
                for _, verbindung in offene:
                    try:
                        verbindung.shutdown(2)
                    except OSError:
                        pass
                return self._json(200, {"ok": True, "gekappt": len(offene)})
            self._json(404, {"fehler": "unbekannt"})

    return H


def main(argv):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", type=int, default=18681)
    p.add_argument("--log")
    p.add_argument("--token")
    p.add_argument("--tempo", type=float, default=1.0, help="Faktor für die Pausen der Szenarien (Tests: kleiner)")
    a = p.parse_args(argv)
    z = Zustand(a.token, a.tempo, a.log)
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), handler(z))
    srv.daemon_threads = True
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=srv.shutdown, daemon=True).start())
    print(f"Runner-Attrappe auf http://127.0.0.1:{srv.server_address[1]}", flush=True)
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
