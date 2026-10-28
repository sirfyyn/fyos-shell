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

  testserver.py os [--port N] [--log DATEI] [--ausfall N] 
      Bildet den Ablauf von FYOS OS hinter Anmeldeserver nach, OHNE echte Anmeldung: derselbe Port antwortet unter dem Namen 127.0.0.1 als „Server“ und
      unter localhost als „Anmeldeserver“ (zwei Hosts, zwei Cookie-Töpfe). GET /os ohne Sitzungs-Cookie leitet auf localhost/auth/login, das
      selbsttätig anmeldet (kein Formular, keine Zugangsdaten) und zurück auf 127.0.0.1/os/rueck leitet; dort setzt der „Server“ ein dauerhaftes
      Cookie (fyos_dauer, 1 Tag) und ein Sitzungs-Cookie (fyos_sitzung, ohne Ablauf). Mit Cookie liefert /os eine Seite (mit Links, auch zu
      example.com). --ausfall N: die ersten N Anfragen an /os bekommen 503. Jede Anfrage steht samt Host und Cookie als JSON-Zeile im Protokoll.

Alle binden nur an 127.0.0.1 und beenden sich sauber bei SIGTERM.
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


class OsServer(http.server.BaseHTTPRequestHandler):
    """Nachbildung von FYOS OS + Anmeldeserver (siehe Kopf). Nur zum Prüfen von Weiterleitungen, Cookies und Navigationssperre."""
    protocol_version = "HTTP/1.1"
    port = 0
    logdatei = None
    ausfall = 0
    praefix = ""
    zaehler = 0
    sperre = threading.Lock()

    def log_message(self, fmt, *args):
        pass

    def _log(self):
        if self.logdatei:
            with self.sperre, open(self.logdatei, "a", encoding="utf-8") as f:
                f.write(json.dumps({"t": time.time(), "pfad": self.path, "host": self.headers.get("Host", ""), "cookie": self.headers.get("Cookie", ""), "ua": self.headers.get("User-Agent", "")[:40]}) + "\n")

    def _antwort(self, code, typ="text/html; charset=utf-8", rumpf="", kopf=()):
        b = rumpf.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", typ)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Connection", "close")
        for k, v in kopf:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        self._log()
        host = self.headers.get("Host", "").split(":")[0]
        pfad = self.path.split("?")[0]
        server = f"http://127.0.0.1:{self.port}"
        auth = f"http://localhost:{self.port}"
        if pfad == "/ruhig":
            # Leerlaufseite für Messungen (Speicher/CPU): ein kleines, lebendiges Dokument, ohne Navigation und ohne Anmeldung
            seite = ("<!doctype html><title>Leerlauf</title><h1>Leerlauf</h1><div id='z'></div><ul id='l'></ul>"
                     "<script>var n=0,l=document.getElementById('l');for(var i=0;i<200;i++){var e=document.createElement('li');e.textContent='Eintrag '+i;l.appendChild(e);}"
                     "setInterval(function(){n++;document.getElementById('z').textContent='Takt '+n;fetch('/os/herz-ruhig').catch(function(){});},1000);</script>")
            return self._antwort(200, rumpf=seite)
        if pfad == "/os/herz-ruhig":
            return self._antwort(204)
        if host == "127.0.0.1" and pfad == "/os/ergebnis":
            return self._antwort(204)  # Meldungsprüfung: die Seite berichtet über den Pfad (steht im Protokoll)
        if host == "127.0.0.1" and pfad == "/os/meldungen":
            # Meldungsprüfung (e2e_meldungen.py): Hauptseite ruft die Brücke, ein Sandbox-Rahmen (Ursprung null) und ein gleicher Ursprung nicht
            if f"{self.praefix}fyos_dauer=1" not in self.headers.get("Cookie", ""):
                return self._antwort(302, kopf=[("Location", f"{auth}/auth/login?next={server}/os/meldungen")])
            rahmen = ("<script>var b=window.__FYOS_HUELLE__;var r=[typeof b,typeof window.__TAURI_INTERNALS__];"
                      "try{r.push(typeof parent.__FYOS_HUELLE__)}catch(e){r.push('gesperrt')}"
                      "new Image().src='" + server + "/os/ergebnis?k=RAHMEN&w='+encodeURIComponent(r.join(','))+'&t='+Date.now();</script>")
            seite = ("<!doctype html><title>FYOS OS Meldungen (Test)</title><h1>Meldungen</h1>"
                     '<iframe id="sandbox" sandbox="allow-scripts" srcdoc="' + rahmen.replace('"', '&quot;') + '"></iframe>'
                     '<iframe id="gleich" src="/os/rahmen"></iframe>'
                     "<script>function melde(k,w){return fetch('/os/ergebnis?k='+k+'&w='+encodeURIComponent(w)+'&t='+Date.now());}"
                     "melde('HAUPT','bruecke='+typeof window.__FYOS_HUELLE__+';profil='+(window.__FYOS_HUELLE__&&window.__FYOS_HUELLE__.profil));"
                     "setTimeout(async function(){var b=window.__FYOS_HUELLE__;if(!b){melde('ZEIGEN','keine-bruecke');return;}"
                     "try{var e=await b.benachrichtigen('x'.repeat(81),'zu lang');melde('LANG','erlaubt:'+JSON.stringify(e));}catch(f){melde('LANG','abgelehnt:'+String(f&&f.code||f));}"
                     "try{var e=await b.benachrichtigen('FYOS OS Test','Pr\\u00fcfmitteilung 1 von 1 (e2e)',{still:true});melde('ZEIGEN','ok:'+JSON.stringify(e));}catch(f){melde('ZEIGEN','fehler:'+String(f&&f.code||f));}"
                     "},1500);setInterval(function(){fetch('/os/herz');},1000);</script>")
            return self._antwort(200, rumpf=seite)
        if host == "127.0.0.1" and pfad == "/os/rahmen":
            return self._antwort(200, rumpf="<!doctype html><script>new Image().src='/os/ergebnis?k=GLEICH&w='+encodeURIComponent(typeof window.__FYOS_HUELLE__+','+typeof window.__TAURI_INTERNALS__)+'&t='+Date.now();</script>")
        if host == "127.0.0.1" and pfad == "/os":
            with self.sperre:
                OsServer.zaehler += 1
                aus = OsServer.zaehler <= OsServer.ausfall
            if aus:
                return self._antwort(503, rumpf="Wartung")
            if f"{self.praefix}fyos_dauer=1" in self.headers.get("Cookie", ""):
                seite = ("<!doctype html><title>FYOS OS (angemeldet)</title><h1>FYOS OS</h1>"
                         '<p><a id="extern" href="https://example.com/">Fremder Link</a> <a id="oeffnen" target="_blank" href="https://example.org/neu">Neues Fenster</a></p>'
                         '<p id="inner">angemeldet</p>'
                         '<script>setTimeout(function(){window.open("https://example.org/neu");},700);'
                         'setTimeout(function(){location.href="https://example.com/blockiert";},1400);'
                         'setInterval(function(){fetch("/os/herz");},1000);</script>')
                return self._antwort(200, rumpf=seite)
            return self._antwort(302, kopf=[("Location", f"{auth}/auth/login?next={server}/os")])
        if host == "localhost" and pfad == "/auth/login":
            # Anmeldeseite (200, wie die von Anmeldeserver); ein Browser folgt der Weiterleitung im Kopf selbsttätig, ein einfacher Client bleibt hier stehen
            return self._antwort(200, rumpf='<!doctype html><title>Anmeldung (Test)</title><meta http-equiv="refresh" content="0;url=/auth/fertig' + ('?w=meldungen' if 'os/meldungen' in self.path else '') + '"><p>Anmeldung …</p>')
        if host == "localhost" and pfad == "/auth/fertig":
            # „Anmeldung“ ohne Zugangsdaten: Sitzung beim Anmeldeserver setzen und zurück zum Server
            return self._antwort(302, kopf=[("Set-Cookie", "anmelde_session=1; Path=/; Expires=Fri, 01 Jan 2100 00:00:00 GMT; HttpOnly"), ("Location", f"{server}/os/rueck" + ("?w=meldungen" if "w=meldungen" in self.path else ""))])
        if host == "127.0.0.1" and pfad == "/os/herz":
            return self._antwort(204)
        if host == "127.0.0.1" and pfad == "/os/rueck":
            return self._antwort(302, kopf=[("Set-Cookie", f"{self.praefix}fyos_dauer=1; Path=/; Expires=Fri, 01 Jan 2100 00:00:00 GMT; HttpOnly"), ("Set-Cookie", f"{self.praefix}fyos_sitzung=1; Path=/; HttpOnly"), ("Location", f"{server}/os" + ("/meldungen" if "w=meldungen" in self.path else ""))])
        return self._antwort(404, "text/plain", "nicht gefunden")


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
    o = sub.add_parser("os")
    o.add_argument("--port", type=int, default=18660)
    o.add_argument("--log")
    o.add_argument("--ausfall", type=int, default=0)
    o.add_argument("--praefix", default="", help="Vorsatz der Cookie-Namen (Tests: je Lauf neu, damit Cookies früherer Läufe im WebView nichts verfälschen)")
    a = p.parse_args()

    if a.art == "os":
        OsServer.port, OsServer.logdatei, OsServer.ausfall, OsServer.praefix = a.port, a.log, a.ausfall, a.praefix
        server = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), OsServer)
    elif a.art == "update":
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
