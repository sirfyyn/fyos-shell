#!/usr/bin/env python3
"""Ende-zu-Ende-Prüfung des Profils OS (nur macOS, ohne Netz, ohne Zugangsdaten): Test-Server bildet FYOS OS + Anmeldeserver nach (testserver.py os).

  O1  Anmelde-Weiterleitung: Server -> Anmeldeserver (zweiter Host) -> Server; die Seite wird geladen
  O2  Navigationssperre im echten WebView: ein Skript der Seite versucht window.open und location.href zu einem fremden Host:
      beides landet im (hier nachgebauten) Browser-Befehl, nichts wird im Fenster geladen, die Seite lebt weiter (Herzschlag)
  O3  Anmeldung bleibt nach Neustart: dauerhaftes Cookie kommt beim nächsten Start sofort mit (kein zweiter Weg über den Anmeldeserver);
      das Sitzungs-Cookie (ohne Ablauf) wird beobachtet und berichtet
  O4  Server beim Start aus: Fehlerseite statt Weiß, automatisches Wiederholen mit Rücknahme (erste Anfrage kommt erst nach dem Wiederholen)
  O5  SIGTERM beendet die Hülle
  O6  Fensterlage wird beim Beenden gemerkt

Aufruf (aus apps/fyos-shell):  python3 tools/e2e_os.py [--ohne-bau]
Die App hat eine eigene Bundle-Id (.e2etest), eigenes TMPDIR und FYOS_SHELL_DATEN in einem Wegwerf-Ordner. Es werden keine Zugangsdaten verwendet;
der „Browser“ ist ein Skript, das die Adresse nur in eine Datei schreibt.
"""
import argparse
import json
import os
import shutil
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import e2e_update as e  # noqa: E402

NAME = "FYOS OS D0-Test"
PORT = 18661
PORT_AUS = 18662
# Cookie-Namen je Lauf neu: der WebView-Speicher der Test-Kennung überlebt Läufe (das ist die Persistenz, die geprüft wird)
PRAEFIX = "l%d_" % int(time.time())


def bauen(ausgabe):
    ziel = ausgabe / "bau"
    if ziel.exists():
        shutil.rmtree(ziel)
    ziel.mkdir(parents=True)
    r = subprocess.run([sys.executable, str(e.TOOLS / "bauen.py"), "os", "--debug", "--bundles", "app", "--name", NAME, "--kennung-zusatz", "e2etest"])
    if r.returncode != 0:
        sys.exit("Bau fehlgeschlagen")
    shutil.copytree(e.WURZEL / "target" / "debug" / "bundle" / "macos" / f"{NAME}.app", ziel / f"{NAME}.app", symlinks=True)
    return ziel / f"{NAME}.app"


def zeilen(pfad):
    if not Path(pfad).is_file():
        return []
    out = []
    for z in Path(pfad).read_text(encoding="utf-8").splitlines():
        try:
            out.append(json.loads(z))
        except json.JSONDecodeError:
            pass
    return out


def server_starten(arbeit, port, log, ausfall=0):
    return subprocess.Popen([sys.executable, str(e.TOOLS / "testserver.py"), "os", "--port", str(port), "--log", str(log), "--ausfall", str(ausfall), "--praefix", PRAEFIX],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def app_starten(app, daten, tmp, spion, start_url):
    daten.mkdir(parents=True, exist_ok=True)
    (daten / "einstellungen.json").write_text(json.dumps({"schema": 1, "start_url": start_url, "erlaubte_hosts": ["localhost"]}), encoding="utf-8")
    env = dict(os.environ, FYOS_SHELL_DATEN=str(daten), TMPDIR=str(tmp), FYOS_SHELL_BROWSER_BEFEHL=str(spion))
    return subprocess.Popen([str(app / "Contents" / "MacOS" / "fyos-shell")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def beenden(p):
    p.send_signal(signal.SIGTERM)
    try:
        p.wait(timeout=30)
        return True
    except subprocess.TimeoutExpired:
        p.kill()
        return False


def pruefe(app, arbeit):
    tmp = arbeit / "tmp"
    tmp.mkdir(exist_ok=True)
    spion = arbeit / "browser-spion.sh"
    urls = arbeit / "browser-urls.txt"
    spion.write_text(f'#!/bin/sh\necho "$1" >> "{urls}"\n', encoding="utf-8")
    spion.chmod(spion.stat().st_mode | stat.S_IXUSR)
    daten = arbeit / "daten" / "os"
    if daten.exists():
        shutil.rmtree(daten)
    log = arbeit / "os-server.log"
    for p in (log, urls):
        p.unlink(missing_ok=True)

    print("O1 Anmelde-Weiterleitung")
    server = server_starten(arbeit, PORT, log)
    try:
        if not e.warten_bis(lambda: e.port_offen(PORT), 10):
            sys.exit("Test-Server startet nicht")
        proc = app_starten(app, daten, tmp, spion, f"http://127.0.0.1:{PORT}/os")
        try:
            def webkit(z):
                return "AppleWebKit" in z.get("ua", "") or "Mozilla" in z.get("ua", "")
            ok1 = e.warten_bis(lambda: any(webkit(z) and z["pfad"].startswith("/os") and f"{PRAEFIX}fyos_dauer=1" in z["cookie"] for z in zeilen(log)), 40)
            z1 = zeilen(log)
            pfade = [z["pfad"].split("?")[0] for z in z1 if webkit(z)]
            e.melde("O1", "Probe der Hülle (kein WebKit) und dann der WebView laden die Seite; Weg über localhost (Anmeldeserver) und zurück",
                    ok1 and "/auth/login" in pfade and "/auth/fertig" in pfade and "/os/rueck" in pfade and any(not webkit(z) for z in z1), json.dumps(pfade))
            print("O2 Navigationssperre")
            ok2 = e.warten_bis(lambda: urls.is_file() and len(urls.read_text().split()) >= 2, 20)
            gesehen = urls.read_text().split() if urls.is_file() else []
            e.melde("O2", "window.open und location.href zu Fremdem gehen an den Browser-Befehl (nicht ins Fenster)",
                    ok2 and "https://example.org/neu" in gesehen and "https://example.com/blockiert" in gesehen, str(gesehen))
            herz0 = sum(1 for z in zeilen(log) if z["pfad"] == "/os/herz")
            time.sleep(3)
            herz1 = sum(1 for z in zeilen(log) if z["pfad"] == "/os/herz")
            e.melde("O2", "die Seite lebt weiter (Herzschlag nach dem Versuch, sie zu verlassen)", herz1 > herz0, f"{herz0} -> {herz1}")
        finally:
            e.melde("O5", "SIGTERM beendet die Hülle", beenden(proc))

        lage = daten / "fenster-inhalt.json"
        e.melde("O6", "Position und Größe des Fensters sind beim Beenden gemerkt (fenster-inhalt.json)", lage.is_file() and json.loads(lage.read_text()).get("breite", 0) > 300, lage.read_text() if lage.is_file() else "fehlt")
        print("O3 Anmeldung nach Neustart")
        vorher = len(zeilen(log))
        proc = app_starten(app, daten, tmp, spion, f"http://127.0.0.1:{PORT}/os")
        try:
            ok3 = e.warten_bis(lambda: len([z for z in zeilen(log)[vorher:] if webkit(z) and z["pfad"].startswith("/os") and not z["pfad"].startswith("/os/herz")]) >= 1, 40)
            neu = [z for z in zeilen(log)[vorher:] if webkit(z)]
            erste = next((z for z in neu if z["pfad"].split("?")[0] == "/os"), {})
            e.melde("O3", "dauerhaftes Cookie (Expires) kommt nach dem Neustart sofort mit", ok3 and f"{PRAEFIX}fyos_dauer=1" in erste.get("cookie", ""), json.dumps(erste))
            e.melde("O3", "kein zweiter Weg über den Anmeldeserver nach dem Neustart", not any(z["pfad"].startswith("/auth/") for z in neu), json.dumps([z["pfad"] for z in neu]))
            sitzung = f"{PRAEFIX}fyos_sitzung=1" in erste.get("cookie", "")
            print(f"  [Beobachtung] Sitzungs-Cookie (ohne Ablauf) nach Neustart: {'erhalten' if sitzung else 'verworfen'}")
            e.ERGEBNISSE.append(("O3", f"Beobachtung Sitzungs-Cookie: {'erhalten' if sitzung else 'verworfen'}", True, ""))
        finally:
            beenden(proc)
    finally:
        server.terminate()
        server.wait(timeout=10)

    print("O4 Server beim Start aus: Fehlerseite und Wiederholen")
    log4 = arbeit / "os-server4.log"
    log4.unlink(missing_ok=True)
    daten4 = arbeit / "daten" / "os-aus"
    if daten4.exists():
        shutil.rmtree(daten4)
    t0 = time.time()
    proc = app_starten(app, daten4, tmp, spion, f"http://127.0.0.1:{PORT_AUS}/os")
    server4 = None
    try:
        time.sleep(8)  # erster Versuch gescheitert (Verbindung abgelehnt), nächster nach 5 s Rücknahme
        e.melde("O4", "Hülle läuft trotz fehlendem Server weiter (Fehlerseite statt Beenden)", proc.poll() is None)
        server4 = server_starten(arbeit, PORT_AUS, log4)
        e.warten_bis(lambda: e.port_offen(PORT_AUS), 10)
        t_server = time.time() - t0
        ok4 = e.warten_bis(lambda: any(z["pfad"].startswith("/os") for z in zeilen(log4)), 60)
        dauer = time.time() - t0
        e.melde("O4", "nach dem Start des Servers lädt die Hülle von allein (Wiederholen mit Rücknahme)", ok4, f"Server ab {t_server:.0f} s, erste Anfrage nach {dauer:.0f} s")
        e.melde("O4", "die Wiederholung kam nicht vor dem Start des Servers (kein Dauerfeuer) und innerhalb einer Rücknahme-Stufe (<= 20 s)", ok4 and dauer - t_server <= 20, f"{dauer - t_server:.0f} s nach Serverstart")
    finally:
        beenden(proc)
        if server4:
            server4.terminate()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--arbeit", default="/private/tmp/fyos-shell-d0-e2e/lauf-os")
    p.add_argument("--ohne-bau", action="store_true")
    a = p.parse_args()
    if sys.platform != "darwin":
        sys.exit("Dieses Skript läuft nur auf macOS.")
    arbeit = Path(a.arbeit)
    arbeit.mkdir(parents=True, exist_ok=True)
    app = arbeit / "bau" / f"{NAME}.app" if a.ohne_bau else bauen(arbeit)
    pruefe(app, arbeit)
    schlecht = [x for x in e.ERGEBNISSE if not x[2]]
    print(f"\n{len(e.ERGEBNISSE) - len(schlecht)} von {len(e.ERGEBNISSE)} Prüfungen bestanden.")
    for tor, name, _, detail in schlecht:
        print(f"FEHLER {tor} {name}: {detail}")
    sys.exit(1 if schlecht else 0)


if __name__ == "__main__":
    main()
