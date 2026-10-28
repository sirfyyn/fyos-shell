#!/usr/bin/env python3
"""Test-Server für die FYOS-Hülle (nur Standardbibliothek, nur Loopback).

  testserver.py update --wurzel ORDNER [--port N]
      Liefert den Ordner statisch (latest.json, Pakete, .sig) und schreibt jede Anfrage in ORDNER/../anfragen.log,
      wenn --log gesetzt ist. So prüft die Update-Schleife gegen einen "Release-Server", ohne Netz und ohne Konto.

  testserver.py studio [--port N] [--version V] [--bereit-nach S]
      Gibt sich als FLE Studio: GET /api/state liefert {app, version, engine, models, ...}, GET / eine Seite.
      Er ist der "Begleiter" im Durchstich D0 (Kindprozess der Hülle) und ersetzt später das mitgelieferte Python-Studio.
      Port und Kennung gibt die Hülle vor (Umgebung FYOS_SHELL_PORT / FYOS_SHELL_KENNUNG); die Kennung bestätigt er im Kopf
      X-FYOS-Kennung, daran erkennt die Hülle, dass er und kein fremder Server auf dem Port antwortet.

Beide binden nur an 127.0.0.1 und beenden sich sauber bei SIGTERM.
"""
import argparse
import functools
import http.server
import json
import os
import signal
import sys
import threading
import time


class Statisch(http.server.SimpleHTTPRequestHandler):
    logdatei = None

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        zeile = "%s %s" % (self.command, self.path)
        if self.logdatei:
            with open(self.logdatei, "a", encoding="utf-8") as f:
                f.write(zeile + "\n")


class Studio(http.server.BaseHTTPRequestHandler):
    version = "0.0.0-test"
    kennung = None
    start = 0.0
    bereit_nach = 0.0

    def log_message(self, fmt, *args):
        pass

    def _senden(self, code, typ, koerper):
        daten = koerper.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", typ)
        self.send_header("Content-Length", str(len(daten)))
        if self.kennung and self.path == "/api/state":
            self.send_header("X-FYOS-Kennung", self.kennung)
        self.end_headers()
        self.wfile.write(daten)

    def do_GET(self):
        if time.time() - self.start < self.bereit_nach:
            self._senden(503, "text/plain", "startet")
            return
        if self.path == "/api/state":
            zustand = {
                "app": "FLE Studio (Testserver)",
                "version": self.version,
                "platform": sys.platform,
                "engine": {"running": False, "state": "gestoppt"},
                "models": [{"id": "test-a"}, {"id": "test-b"}],
            }
            self._senden(200, "application/json", json.dumps(zustand))
        elif self.path in ("/", "/index.html"):
            self._senden(200, "text/html; charset=utf-8", "<!doctype html><title>FLE Studio Test</title><h1>FLE Studio (Testserver)</h1>")
        else:
            self._senden(404, "text/plain", "nicht gefunden")


def dienen(server):
    # SIGTERM wie ein Dienst behandeln: shutdown() blockiert im Signalthread, also in einem Thread auslösen
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown).start())
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="art", required=True)
    u = sub.add_parser("update")
    u.add_argument("--wurzel", required=True)
    u.add_argument("--port", type=int, default=18700)
    u.add_argument("--log", help="Datei, in die jede Anfrage geschrieben wird")
    s = sub.add_parser("studio")
    s.add_argument("--port", type=int, default=int(os.environ.get("FYOS_SHELL_PORT", "18642")))
    s.add_argument("--kennung", default=os.environ.get("FYOS_SHELL_KENNUNG"), help="wird in /api/state als Kopf X-FYOS-Kennung bestätigt")
    s.add_argument("--version", default="0.0.0-test")
    s.add_argument("--bereit-nach", type=float, default=0.0, help="Sekunden, in denen /api/state noch 503 liefert")
    a = p.parse_args()

    if a.art == "update":
        Statisch.logdatei = a.log
        handler = functools.partial(Statisch, directory=a.wurzel)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), handler)
    else:
        Studio.version = a.version
        Studio.kennung = a.kennung
        Studio.start = time.time()
        Studio.bereit_nach = a.bereit_nach
        server = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), Studio)
    print("bereit auf 127.0.0.1:%d" % a.port, flush=True)
    dienen(server)


if __name__ == "__main__":
    main()
