#!/usr/bin/env python3
"""Runner-Attrappe für die Prüfung des Profils agent (nur Standardbibliothek, nur Loopback, kein echter Runner, keine Daten).

  runner_attrappe.py [--port N] [--log DATEI] [--token T] [--tempo S]

Spricht den Teil der Runner-Schnittstelle, den die Chat-Seite braucht:
  GET  /api/health, /api/gespraeche, /api/freigaben, /api/laeufe, /api/gespraech/1/ansicht?voll=1
  GET  /api/gespraech/1/ereignisse        Ereignisstrom (SSE): erst ein Snapshot, dann Ereignisse, alle 5 s ein Herzschlag-Kommentar
  POST /api/gespraech/1/nachricht         startet je nach Text ein Szenario (siehe SZENARIEN)
  POST /api/freigaben/<id>                Entscheidung (erteilt/abgelehnt), schreibt einen Entscheidungs-Eintrag in den Strom
  POST /api/e2e/ergebnis                  die Seite meldet ein Prüfergebnis (nur Debug-Bauten der Hülle starten das Skript der Seite)
  POST /api/e2e/kappen                    trennt alle offenen Ströme hart (Netzabbruch mitten im Strom)
Mit --token verlangt jede Anfrage `Authorization: Bearer <T>` (sonst 401). Jede Anfrage steht als JSON-Zeile im Protokoll (--log),
mit `auth: true/false` (kam das richtige Token an?), aber nie mit dem Token selbst.
"""
import argparse
import json
import queue
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

SZENARIEN = {
    "streaming": "Antwort in Teilen (Streaming)",
    "werkzeug": "ein Werkzeugaufruf mit Ergebnis (Karte)",
    "freigabe": "eine Freigabe, die entschieden werden muss (nur Erlauben/Ablehnen)",
    "reset": "ein Reset-Marker (neuer Kontext)",
    "lang": "zwölf Teile über sechs Sekunden (Abbruch mitten im Strom)",
}


class Zustand:
    def __init__(self, token, tempo, log):
        self.token = token
        self.tempo = tempo
        self.log = log
        self.sperre = threading.RLock()
        self.eintraege = []  # Verlauf (für Ansicht und Snapshot)
        self.freigaben = []
        self.abonnenten = []  # (queue, Verbindungs-Objekt)
        self.laeuft = False
        self.teil = ""  # Text der laufenden Nachricht
        self.zaehler = 0

    def nr(self):
        with self.sperre:
            self.zaehler += 1
            return self.zaehler

    def protokoll(self, **zeile):
        if self.log:
            with self.sperre, open(self.log, "a", encoding="utf-8") as f:
                f.write(json.dumps(zeile, ensure_ascii=False) + "\n")

    def senden(self, ereignisse):
        with self.sperre:
            for q, _ in list(self.abonnenten):
                q.put(ereignisse)

    def eintrag(self, kind, data=None, model=None):
        e = {"id": self.nr(), "kind": kind}
        if data is not None:
            e["data"] = data
        if model is not None:
            e["model"] = model
        with self.sperre:
            self.eintraege.append(e)
        return e

    def snapshot(self):
        with self.sperre:
            s = {"entries": list(self.eintraege), "agent": {"model": "probe-modell"}, "usage": {"models": {"probe/probe": {"input": 120, "output": 40, "cost": {"total": 0.01}}}}}
            if self.laeuft:
                s["run"] = True
                s["generation"] = {"message": {"role": "assistant", "content": [{"type": "text", "text": self.teil}]}}
            return s

    def pause(self, s):
        time.sleep(s * self.tempo)

    def szenario(self, text):
        t = text.lower()
        try:
            e = self.eintrag("fyos.mensch", {"text": text})
            self.senden([{"type": "entry_appended", "entry": e}])
            with self.sperre:
                self.laeuft = True
                self.teil = ""
            self.senden([{"type": "run_start"}, {"type": "message_start", "message": {"role": "assistant", "content": []}}])
            if "freigabe" in t:
                self.freigabe_szenario()
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
            with self.sperre:
                self.laeuft = False
            self.senden([{"type": "run_end"}])

    def antwort_in_teilen(self, teile, abstand):
        for i, teil in enumerate(teile):
            with self.sperre:
                self.teil += teil
            self.senden([{"type": "message_update", "changes": [{"type": "text_delta", "contentIndex": 0, "delta": teil}]}])
            self.pause(abstand)
        e = self.eintrag("pi.message", model=[{"role": "assistant", "content": [{"type": "text", "text": self.teil}]}])
        self.senden([{"type": "message_end", "entry": e}])

    def werkzeug_szenario(self):
        self.senden([{"type": "tool_execution_start", "toolCallId": "t1", "toolName": "read", "args": {"path": "probe.txt"}}])
        self.pause(0.5)
        e = self.eintrag("pi.tool", model=[{"role": "toolResult", "toolCallId": "t1", "toolName": "read", "content": [{"type": "text", "text": "Inhalt der Probe"}], "isError": False}])
        self.senden([{"type": "tool_execution_end", "toolCallId": "t1", "toolName": "read", "entry": e}])
        self.antwort_in_teilen(["Werkzeug fertig."], 0.1)

    def freigabe_szenario(self):
        fid = f"f{self.nr()}"
        f = {"id": fid, "status": "offen", "erstellt": int(time.time() * 1000), "aktion": "Probe-Aktion ausführen", "risiko": "low", "befehl": "echo probe"}
        with self.sperre:
            self.freigaben.append(f)
        e = self.eintrag("fyos.freigabe", {"id": fid, "aktion": f["aktion"], "risiko": "low", "werkzeug": "bash"})
        self.senden([{"type": "entry_appended", "entry": e}])
        ende = time.time() + 60
        while time.time() < ende and f["status"] == "offen":
            time.sleep(0.1)
        self.antwort_in_teilen(["Freigabe erteilt." if f["status"] == "erteilt" else "Freigabe abgelehnt."], 0.1)

    def entscheiden(self, fid, wert):
        with self.sperre:
            f = next((x for x in self.freigaben if x["id"] == fid), None)
            if not f:
                return None
            f["status"] = wert
        e = self.eintrag("fyos.freigabe-entscheidung", {"id": fid, "entscheidung": wert})
        self.senden([{"type": "entry_appended", "entry": e}])
        return list(self.freigaben)


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
            if p == "/api/gespraeche":
                return self._json(200, {"gespraeche": [{"id": 1, "art": "root", "titel": "Probe"}]})
            if p == "/api/freigaben":
                return self._json(200, {"freigaben": list(z.freigaben)})
            if p == "/api/laeufe":
                return self._json(200, {"laeufe": [{"id": 1, "status": "laeuft"}] if z.laeuft else []})
            if p == "/api/gespraech/1/ansicht":
                return self._json(200, {"entries": list(z.eintraege), "meta": {"titel": "Probe", "modell": "probe-modell"}, "usage": z.snapshot()["usage"]})
            if p == "/api/gespraech/1/ereignisse":
                return self._strom()
            self._json(404, {"fehler": "unbekannt"})

        def _strom(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            q = queue.Queue()
            with z.sperre:
                z.abonnenten.append((q, self.connection))
            try:
                self.wfile.write(f"event: snapshot\ndata: {json.dumps(z.snapshot(), ensure_ascii=False)}\n\n".encode("utf-8"))
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
                    z.abonnenten[:] = [a for a in z.abonnenten if a[0] is not q]

        def do_POST(self):
            if not self._erlaubt():
                return
            p = urlparse(self.path).path
            k = self._koerper()
            if p == "/api/gespraech/1/nachricht":
                threading.Thread(target=z.szenario, args=(str(k.get("text", "")),), daemon=True).start()
                return self._json(200, {"ok": True})
            if p.startswith("/api/freigaben/"):
                alle = z.entscheiden(p.rsplit("/", 1)[1], k.get("entscheidung", "abgelehnt"))
                return self._json(200 if alle is not None else 404, {"freigaben": alle} if alle is not None else {"fehler": "Freigabe nicht gefunden"})
            if p == "/api/e2e/ergebnis":
                z.protokoll(ergebnis=k)
                return self._json(200, {"ok": True})
            if p == "/api/e2e/kappen":
                with z.sperre:
                    offene = list(z.abonnenten)
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
