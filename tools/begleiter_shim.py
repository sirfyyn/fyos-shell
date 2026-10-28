#!/usr/bin/env python3
"""Kennungs-Hülle ("Shim") vor einem Studio-Server (nur Standardbibliothek).

Die Hülle verlangt von ihrem Begleiter, dass `GET /api/state` den Kopf `X-FYOS-Kennung: <kennung>` trägt (siehe README,
"Port und Kennung"). Das Python-Studio liefert den Kopf nicht und soll nicht dafür geändert werden. Der Shim ist deshalb
der Begleiter, den die Hülle startet: er lauscht auf dem Port der Hülle, startet das eigentliche Studio auf einem eigenen
freien Port, reicht jede Anfrage unverändert durch und setzt nur auf `/api/state` den Kopf. Antworten werden Stück für Stück
durchgereicht (Server-Sent Events und große Dateien brauchen keinen Zwischenspeicher), Protokoll-Upgrades (WebSocket) werden als
Tunnel durchgereicht. Beim Beenden (SIGTERM) endet auch das Studio samt seinen Kindprozessen.

  begleiter_shim.py --port {port} --kennung {kennung} -- python3 -m fle_studio --port {upstream}

`{upstream}` in den Argumenten nach `--` wird durch den freien Port des Studios ersetzt. Die Hülle trägt den Aufruf in
`einstellungen.json` als Begleiter ein (`programm`: Python, `args`: Pfad des Shims und diese Argumente; `{port}` und `{kennung}` setzt sie selbst ein).
"""
import argparse
import http.client
import http.server
import os
import select
import signal
import socket
import subprocess
import sys
import threading
import time

KOPF = "X-FYOS-Kennung"
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade"}


def freier_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def handler_bauen(upstream_port, kennung):
    class Durchreichen(http.server.BaseHTTPRequestHandler):
        # HTTP/1.0: Verbindung endet nach der Antwort, der Rumpf braucht weder Länge noch Chunking
        protocol_version = "HTTP/1.0"

        def log_message(self, *args):
            pass

        def _tunnel(self):
            """Protokoll-Upgrade (WebSocket): Anfrage roh weiterreichen, danach beide Richtungen kopieren."""
            up = socket.create_connection(("127.0.0.1", upstream_port), timeout=10)
            kopf = f"{self.command} {self.path} HTTP/1.1\r\n" + "".join(f"{k}: {v}\r\n" for k, v in self.headers.items()) + "\r\n"
            up.sendall(kopf.encode("latin-1"))
            laenge = int(self.headers.get("Content-Length") or 0)
            if laenge:
                up.sendall(self.rfile.read(laenge))
            self.connection.setblocking(True)
            up.setblocking(True)
            offen = [self.connection, up]
            while True:
                lesbar, _, _ = select.select(offen, [], [], 60)
                if not lesbar:
                    break
                ende = False
                for quelle in lesbar:
                    daten = quelle.recv(65536)
                    if not daten:
                        ende = True
                        break
                    (up if quelle is self.connection else self.connection).sendall(daten)
                if ende:
                    break
            up.close()
            self.close_connection = True

        def _weiter(self):
            if self.headers.get("Upgrade"):
                return self._tunnel()
            laenge = int(self.headers.get("Content-Length") or 0)
            rumpf = self.rfile.read(laenge) if laenge else None
            kopf = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
            verbindung = http.client.HTTPConnection("127.0.0.1", upstream_port, timeout=300)
            try:
                verbindung.request(self.command, self.path, body=rumpf, headers=kopf)
                antwort = verbindung.getresponse()
            except OSError as e:
                text = f"Studio antwortet nicht: {e}".encode("utf-8")
                self.send_response(502)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(text)))
                self.end_headers()
                self.wfile.write(text)
                return
            self.send_response(antwort.status, antwort.reason)
            for k, v in antwort.getheaders():
                if k.lower() not in HOP and k.lower() != KOPF.lower():
                    self.send_header(k, v)
            if self.path.split("?", 1)[0] == "/api/state":
                self.send_header(KOPF, kennung)
            self.end_headers()
            try:
                if self.command != "HEAD":
                    while True:
                        stueck = antwort.read1(65536) if hasattr(antwort, "read1") else antwort.read(65536)
                        if not stueck:
                            break
                        self.wfile.write(stueck)
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass  # der Client hat aufgelegt (Fenster zu, Strom abgebrochen)
            finally:
                verbindung.close()

        do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = _weiter

    return Durchreichen


# --- Prozessbaum: plattformneutral (Unix: eigene Sitzung und Prozessgruppe; Windows: eigene Prozessgruppe, taskkill /T) ---
# Die Konstanten stehen hier, weil `subprocess.CREATE_NEW_PROCESS_GROUP` & Co. nur unter Windows existieren.
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_NO_WINDOW = 0x08000000
SANFT_S = 8


def ist_windows():
    return os.name == "nt"


def ein_ausgabe():
    """Ein-/Ausgabe des Studios ausdrücklich festlegen: Eingabe leer, Ausgabe und Fehler in die des Shims (also in das Protokoll der Hülle).
    Ohne Angabe erbt ein unter Windows ohne Konsole gestarteter Kindprozess unter Umständen KEINE gültigen Standardhandles; Python setzt dann
    sys.stdout/sys.stderr auf None, und jeder Zugriff darauf im Studio wäre ein Absturz."""
    def strom(s):
        try:
            return s.fileno() if s is not None else subprocess.DEVNULL
        except (OSError, ValueError, AttributeError):
            return subprocess.DEVNULL
    return {"stdin": subprocess.DEVNULL, "stdout": strom(sys.stdout), "stderr": strom(sys.stderr)}


def kind_starten(befehl, windows=None, popen=subprocess.Popen, **ein_aus):
    """Startet das Studio so, dass sich sein ganzer Baum beenden lässt. `windows`/`popen` nur für Tests."""
    if ist_windows() if windows is None else windows:
        return popen(befehl, creationflags=CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW, **ein_aus)
    return popen(befehl, start_new_session=True, **ein_aus)


def _nachfahren(pid):
    """Liefert die PIDs aller Nachfahren von `pid` (über /proc/…/stat), leer wenn /proc fehlt.

    Der Gruppen-Kill erreicht nur Prozesse in der Prozessgruppe des Studios. In Containern kann ein
    Nachfahre aus dieser Gruppe fallen und überleben; der Baum wird deshalb VOR dem Töten erfasst,
    damit Überlebende danach gezielt beendet werden können."""
    vater_von = {}
    try:
        eintraege = os.listdir("/proc")
    except OSError:
        return []
    for eintrag in eintraege:
        if not eintrag.isdigit():
            continue
        try:
            with open(f"/proc/{eintrag}/stat", "rb") as f:
                feld = f.read().decode("latin-1").split(")")[-1].split()
            vater_von[int(eintrag)] = int(feld[1])
        except (OSError, IndexError, ValueError):
            continue
    kinder = {}
    for kind_pid, vater in vater_von.items():
        kinder.setdefault(vater, []).append(kind_pid)
    nachfahren = []
    stapel = [pid]
    while stapel:
        vater = stapel.pop()
        for k in kinder.get(vater, []):
            nachfahren.append(k)
            stapel.append(k)
    return nachfahren


def baum_beenden(kind, windows=None, ausfuehren=subprocess.run, sanft_s=SANFT_S):
    """Beendet das Studio samt Nachkommen: erst höflich, nach `sanft_s` Sekunden hart. Ein schon beendetes Studio ist kein Fehler.

    Unix: SIGTERM/SIGKILL an die Prozessgruppe, danach Überlebende aus dem erfassten Baum hart beenden
    (fängt Enkel ab, die aus der Gruppe gefallen sind). Windows: CTRL_BREAK an die Prozessgruppe, danach
    `taskkill /T /F` auf den Baum."""
    win = ist_windows() if windows is None else windows
    if win:
        if kind.poll() is None:
            try:
                kind.send_signal(getattr(signal, "CTRL_BREAK_EVENT", 1))
                kind.wait(timeout=sanft_s)
            except (OSError, subprocess.TimeoutExpired):
                pass
        ausfuehren(["taskkill", "/PID", str(kind.pid), "/T", "/F"], capture_output=True)
        return
    baum = _nachfahren(kind.pid)
    try:
        os.killpg(kind.pid, signal.SIGTERM)
        kind.wait(timeout=sanft_s)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(kind.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    ueberlebende = []
    for nachkomme in baum:
        try:
            os.kill(nachkomme, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except OSError:
            ueberlebende.append(nachkomme)
    # Diagnose ins Protokoll (begleiter.log): war der Baum leer, weil /proc fehlte, oder wurden Nachfahren getötet?
    print(f"[shim] baum_beenden: erfasst={baum} ueberlebend={ueberlebende}", file=sys.stderr, flush=True)


def abbruchsignale(funktion):
    """Beenden-Signale der Plattform an `funktion` binden (SIGBREAK nur unter Windows)."""
    for name in ("SIGTERM", "SIGINT", "SIGBREAK"):
        nummer = getattr(signal, name, None)
        if nummer is not None:
            signal.signal(nummer, funktion)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", type=int, required=True, help="Port, auf dem der Shim lauscht (von der Hülle vorgegeben)")
    p.add_argument("--kennung", required=True, help="Kennung, die /api/state im Kopf X-FYOS-Kennung bestätigt")
    p.add_argument("befehl", nargs=argparse.REMAINDER, help="-- Programm und Argumente des Studios; {upstream} = dessen Port")
    a = p.parse_args()
    befehl = a.befehl[1:] if a.befehl and a.befehl[0] == "--" else a.befehl
    if not befehl:
        sys.exit("Es fehlt der Befehl des Studios nach '--'.")

    upstream = freier_port()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), handler_bauen(upstream, a.kennung))
    server.daemon_threads = True

    def beenden(*_):
        # in eigenem Thread: shutdown() wartet auf die Schleife, die im Signalbehandler steht
        threading.Thread(target=server.shutdown).start()

    # Signale VOR dem Start des Studios binden: ein SIGTERM, der zwischen Start und Bindung einträfe, würde den Shim
    # ohne Aufräumen beenden und das Studio verwaist zurücklassen (Wettlauf, in der CI des öffentlichen Repos beobachtet).
    abbruchsignale(beenden)
    start = time.monotonic()
    kind = kind_starten([arg.replace("{upstream}", str(upstream)) for arg in befehl], **ein_ausgabe())

    def studio_ende():
        code = kind.wait()
        # Diagnose: ohne Zeile wüsste die Hülle nur „Begleiter beendet“; so steht Code und Laufzeit im Protokoll der Hülle (begleiter.log)
        print(f"[shim] Studio beendet mit Code {code} nach {time.monotonic() - start:.1f} s", file=sys.stderr, flush=True)
        beenden()

    # Endet das Studio von allein, endet auch der Shim (die Hülle sieht das und meldet es)
    threading.Thread(target=studio_ende, daemon=True).start()
    try:
        server.serve_forever()
    finally:
        server.server_close()
        baum_beenden(kind)
    sigterm = -getattr(signal, "SIGTERM", 15)
    sys.exit(0 if kind.returncode in (0, sigterm, None) else kind.returncode)


if __name__ == "__main__":
    main()
