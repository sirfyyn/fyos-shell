#!/usr/bin/env python3
"""Neutrales Test-Programm für den Vertrag des lokalen Runners (nur Standardbibliothek, nur Loopback, keine Daten).

Es erfüllt den Vertrag aus `crates/shell-core/src/agent/lokal.rs` und dient der Prüfung der Hülle (tools/e2e_agent.py, Tests). Es ist KEIN Runner:
es hat keinen Agenten, keine Modelle, keine Werkzeuge; die Sitzungen bleiben leer.

Umgebung (von der Hülle gesetzt, bei einem Handstart selbst setzen):
  FYOS_RUNNER_PORT, FYOS_RUNNER_TOKEN, FYOS_RUNNER_ORDNER_ERLAUBT (":" getrennt), FYOS_RUNNER_HOST (Vorgabe 127.0.0.1), FYOS_RUNNER_DATEN
Optional: --log DATEI schreibt je Anfrage eine JSON-Zeile {methode, pfad, auth, koerper}, nie das Token.

Wege: GET /api/health, /api/ordner[?pfad=], POST /api/ordner/erlauben, GET/POST /api/gespraeche, GET/PATCH /api/gespraech/<id>,
/api/gespraech/<id>/ansicht, /api/gespraech/<id>/ereignisse (SSE), /api/strom (SSE), /api/konfiguration, /api/modelle, /api/freigaben, /api/laeufe.
Ordner außerhalb der Wurzeln: 403 {"fehler":"ausserhalb"}; nicht vorhanden: 404; Anfrage ohne Token: 401. Endet bei SIGTERM sauber.
"""
import argparse
import json
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

MAX_EINTRAEGE = 200


class Zustand:
    def __init__(self, token, wurzeln, log):
        self.token = token
        self.wurzeln = []
        for w in wurzeln:
            self.erlauben(w)
        self.log = log
        self.sperre = threading.Lock()
        self.sitzungen = {1: {"id": 1, "titel": "Haupt", "art": "root", "cwd": self.wurzeln[0] if self.wurzeln else ""}}
        self.naechste = 2

    def erlauben(self, pfad):
        p = os.path.realpath(pfad)
        if os.path.isabs(pfad) and os.path.isdir(p) and p not in self.wurzeln:
            self.wurzeln.append(p)
            return True
        return os.path.isdir(p)

    def innerhalb(self, pfad):
        p = os.path.realpath(pfad)
        return any(p == w or p.startswith(w.rstrip(os.sep) + os.sep) for w in self.wurzeln)

    def protokoll(self, zeile):
        if self.log:
            with self.sperre, open(self.log, "a", encoding="utf-8") as f:
                f.write(json.dumps(zeile) + "\n")


class Handler(BaseHTTPRequestHandler):
    z = None
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def senden(self, code, daten):
        b = json.dumps(daten).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def koerper(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode())
        except ValueError:
            return {}

    def pruefe(self, methode, koerper=None):
        auth = self.headers.get("Authorization") == "Bearer " + self.z.token
        self.z.protokoll({"methode": methode, "pfad": self.path, "auth": auth, "koerper": koerper})
        if not auth:
            self.senden(401, {"fehler": "Nicht erlaubt"})
        return auth

    def do_GET(self):
        if not self.pruefe("GET"):
            return
        u = urlparse(self.path)
        p = u.path.rstrip("/")
        z = self.z
        if p == "/api/health":
            return self.senden(200, {"ok": True, "agent": "probe", "geraet": {"name": "Test"}, "pid": os.getpid()})
        if p == "/api/ordner":
            return self.ordner(parse_qs(u.query).get("pfad", [None])[0])
        if p == "/api/konfiguration":
            return self.senden(200, {"arbeitsbereiche": {}, "modelle": []})
        if p == "/api/modelle":
            return self.senden(200, {"modelle": []})
        if p == "/api/freigaben":
            return self.senden(200, {"freigaben": []})
        if p == "/api/laeufe":
            return self.senden(200, {"laeufe": []})
        if p == "/api/gespraeche":
            with z.sperre:
                liste = [{"id": s["id"], "titel": s["titel"], "art": s["art"], "arbeitsbereich": "", "erstellt": 1, "archiviert": False, "agent": {"cwd": s["cwd"]}} for s in z.sitzungen.values() if not s.get("archiviert")]
            return self.senden(200, {"gespraeche": liste})
        if p.startswith("/api/gespraech/"):
            teile = p[len("/api/gespraech/"):].split("/")
            try:
                s = z.sitzungen[int(teile[0])]
            except (ValueError, KeyError):
                return self.senden(404, {"fehler": "Gespräch nicht gefunden"})
            if len(teile) == 1:
                return self.senden(200, {"gespraech": {"id": s["id"], "titel": s["titel"]}, "agent": {"cwd": s["cwd"]}})
            if teile[1] == "ansicht":
                return self.senden(200, {"entries": []})
            if teile[1] == "ereignisse":
                return self.strom({"entries": [], "agent": {"model": "probe"}, "usage": {"models": {}}})
        if p == "/api/strom":
            return self.strom(None)
        self.senden(404, {"fehler": "unbekannter Weg"})

    def do_POST(self):
        k = self.koerper()
        if not self.pruefe("POST", k):
            return
        p = urlparse(self.path).path.rstrip("/")
        z = self.z
        if p == "/api/ordner/erlauben":
            pfad = k.get("pfad") if isinstance(k, dict) else None
            if not isinstance(pfad, str) or not os.path.isabs(pfad) or not os.path.isdir(pfad):
                return self.senden(400, {"fehler": "kein vorhandener absoluter Ordner"})
            with z.sperre:
                z.erlauben(pfad)
                return self.senden(200, {"wurzeln": list(z.wurzeln)})
        if p == "/api/e2e/ergebnis":
            # Prüfergebnis der Seite (nur Debug-Bauten der Hülle): steht im Protokoll, mehr passiert nicht
            return self.senden(200, {})
        if p == "/api/gespraeche":
            ordner = k.get("ordner") if isinstance(k, dict) else None
            if ordner is not None:
                if not isinstance(ordner, str) or not os.path.isabs(ordner):
                    return self.senden(400, {"fehler": "ordner muss ein absoluter Pfad sein"})
                if not z.innerhalb(ordner):
                    return self.senden(403, {"fehler": "ausserhalb"})
                if not os.path.isdir(ordner):
                    return self.senden(404, {"fehler": "Ordner nicht gefunden"})
            with z.sperre:
                sid = z.naechste
                z.naechste += 1
                z.sitzungen[sid] = {"id": sid, "titel": (k.get("titel") or "Neue Sitzung"), "art": "mensch", "cwd": ordner or (z.wurzeln[0] if z.wurzeln else "")}
                s = z.sitzungen[sid]
            return self.senden(201, {"gespraech": {"id": sid, "meta": {"titel": s["titel"]}, "agent": {"cwd": s["cwd"]}}})
        self.senden(404, {"fehler": "unbekannter Weg"})

    def do_PATCH(self):
        """PATCH /api/gespraech/<id> {titel, archiviert} wie der echte Runner (leerer Name ändert nichts; archivierte stehen nicht in der Liste)."""
        k = self.koerper()
        if not self.pruefe("PATCH", k):
            return
        p = urlparse(self.path).path.rstrip("/")
        z = self.z
        try:
            sid = int(p[len("/api/gespraech/"):]) if p.startswith("/api/gespraech/") else None
            s = z.sitzungen[sid]
        except (ValueError, KeyError):
            return self.senden(500, {"ok": False, "fehler": "Gespräch nicht gefunden"})
        with z.sperre:
            if isinstance(k, dict) and isinstance(k.get("titel"), str):
                s["titel"] = k["titel"][:120] or s["titel"]
            if isinstance(k, dict) and "archiviert" in k:
                s["archiviert"] = bool(k["archiviert"])
        self.senden(200, {"ok": True, "gespraech": {"id": s["id"], "meta": {"titel": s["titel"], "archiviert": bool(s.get("archiviert"))}, "agent": {"cwd": s["cwd"]}}})

    def ordner(self, pfad):
        z = self.z
        if pfad is None:
            return self.senden(200, {"wurzeln": list(z.wurzeln), "pfad": None, "eintraege": [], "erlaubt": False})
        if not os.path.isabs(pfad) or not z.innerhalb(pfad):
            return self.senden(403, {"fehler": "ausserhalb"})
        if not os.path.isdir(pfad):
            return self.senden(404, {"fehler": "Ordner nicht gefunden"})
        namen = []
        try:
            namen = sorted(n for n in os.listdir(pfad) if os.path.isdir(os.path.join(pfad, n)) and not n.startswith("."))
        except OSError:
            pass
        antwort = {"wurzeln": list(z.wurzeln), "pfad": pfad, "eintraege": [{"name": n, "ordner": True} for n in namen[:MAX_EINTRAEGE]], "erlaubt": True}
        if len(namen) > MAX_EINTRAEGE:
            antwort["abgeschnitten"] = True
        self.senden(200, antwort)

    def strom(self, snapshot):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            if snapshot is not None:
                self.wfile.write(("event: snapshot\ndata: " + json.dumps(snapshot) + "\n\n").encode())
            else:
                self.wfile.write(b"event: hallo\ndata: {}\n\n")
            self.wfile.flush()
            while True:
                time.sleep(2)
                self.wfile.write(b": wach\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        self.close_connection = True


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--log", default=None)
    ap.add_argument("--ignoriere", nargs="*", help="weitere Argumente aus der Vorlage der Hülle werden ignoriert")
    a, _ = ap.parse_known_args()
    env = os.environ
    port = int(env.get("FYOS_RUNNER_PORT", "0"))
    token = env.get("FYOS_RUNNER_TOKEN", "")
    if not port or not token:
        sys.exit("FYOS_RUNNER_PORT und FYOS_RUNNER_TOKEN fehlen")
    wurzeln = [w for w in env.get("FYOS_RUNNER_ORDNER_ERLAUBT", "").split(os.pathsep) if w]
    Handler.z = Zustand(token, wurzeln, a.log)
    Handler.z.protokoll({"start": {"pid": os.getpid(), "wurzeln": Handler.z.wurzeln}})
    server = ThreadingHTTPServer((env.get("FYOS_RUNNER_HOST", "127.0.0.1"), port), Handler)
    server.daemon_threads = True

    def ende(*_):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, ende)
    signal.signal(signal.SIGINT, ende)
    server.serve_forever()


if __name__ == "__main__":
    main()
