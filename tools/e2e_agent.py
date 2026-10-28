#!/usr/bin/env python3
"""Ende-zu-Ende-Prüfung des Profils agent (nur macOS, ohne Netz, ohne Zugangsdaten, ohne echten Runner und ohne den Schlüsselbund des Entwicklers).

Die Hülle läuft mit Profil agent und einem Wegwerf-Datenordner; als Runner dient die Attrappe `tools/runner_attrappe.py` (Loopback, Test-Token).
Das Token steht nicht im Schlüsselbund, sondern in einem Tresor im Arbeitsspeicher, den nur Debug-Bauten über FYOS_SHELL_TRESOR_SAAT vorbelegen lassen.
Die Chat-Seite bedient sich im Prüfmodus selbst (ui/agent/e2e.js, nur mit FYOS_SHELL_AGENT_E2E=1 im Debug-Bau) und meldet jedes Ergebnis an die Attrappe.

  A1  Chat-Fenster lädt die lokale Seite und verbindet sich: Gesundheit, Gespräche, Verlauf, Strom, alle mit richtigem Token und Kopf X-FYOS-Agent
  A2  Gespräch mit Streaming (Text erscheint vor dem Ende), Werkzeugkarte, Freigabe (genau zwei Knöpfe, Erlauben wirkt), Reset-Marker,
      Neuverbinden mitten im Strom (Text komplett, nichts doppelt)
  A3  der Beobachter fragt Freigaben und Läufe ab (Tray), auch ohne dass die Seite etwas tut
  A4  Token nirgends in den Einstellungen (nur der Verweis), keine Anfrage ohne Token
  A5  falsches Token: die Anwendung bleibt am Leben und versucht es wieder (Katalogmeldung im Banner, Wiederholen)
  A6  SIGTERM beendet die Hülle

Aufruf (aus apps/fyos-shell):  python3 tools/e2e_agent.py [--ohne-bau]
"""
import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import e2e_update as e  # noqa: E402

NAME = "FYOS Agent D0-Test"
PORT = 18681
PORT_FALSCH = 18682
TOKEN = "-".join(["e2e", "probe"] * 4)  # erfundener Testwert
ERWARTET = ["seite-geladen", "verbunden", "streaming-teilweise", "streaming-ganz", "werkzeugkarte", "freigabe-karte",
            "freigabe-nur-erlauben-ablehnen", "freigabe-erteilt", "reset-marker", "neuverbunden-vollstaendig", "neuverbunden-nichts-doppelt", "ende"]


def bauen(ausgabe):
    ziel = ausgabe / "bau"
    if ziel.exists():
        shutil.rmtree(ziel)
    ziel.mkdir(parents=True)
    r = subprocess.run([sys.executable, str(e.TOOLS / "bauen.py"), "agent", "--debug", "--bundles", "app", "--name", NAME, "--kennung-zusatz", "e2etest"])
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


def attrappe(port, log, token):
    return subprocess.Popen([sys.executable, str(e.TOOLS / "runner_attrappe.py"), "--port", str(port), "--log", str(log), "--token", token],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def app_starten(app, daten, tmp, port, token_im_tresor):
    daten.mkdir(parents=True, exist_ok=True)
    (daten / "einstellungen.json").write_text(json.dumps({
        "schema": 1,
        "agent": {"runner_adresse": f"http://127.0.0.1:{port}", "runner_token": "{tresor:runner-token}", "ruhe": False, "gemeldet": []},
    }), encoding="utf-8")
    env = dict(os.environ, FYOS_SHELL_DATEN=str(daten), TMPDIR=str(tmp), FYOS_SHELL_TRESOR_SAAT=f"runner-token={token_im_tresor}", FYOS_SHELL_AGENT_E2E="1")
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
    daten = arbeit / "daten" / "agent"
    if daten.exists():
        shutil.rmtree(daten)
    log = arbeit / "attrappe.log"
    log.unlink(missing_ok=True)
    if e.port_offen(PORT) or e.port_offen(PORT_FALSCH):
        sys.exit(f"Port {PORT} oder {PORT_FALSCH} ist belegt (ein anderer Prüfstand läuft noch). Abhilfe: beenden oder die Ports in tools/e2e_agent.py ändern.")
    server = attrappe(PORT, log, TOKEN)
    try:
        if not e.warten_bis(lambda: e.port_offen(PORT), 10):
            sys.exit("Runner-Attrappe startet nicht")
        proc = app_starten(app, daten, tmp, PORT, TOKEN)
        try:
            ok = e.warten_bis(lambda: any(z.get("ergebnis", {}).get("schritt") in ("ende", "abgebrochen") for z in zeilen(log)), 120)
            z = zeilen(log)
            ergebnisse = {x["ergebnis"]["schritt"]: x["ergebnis"] for x in z if "ergebnis" in x}
            pfade = [x["pfad"].split("?")[0] for x in z if "pfad" in x]
            print("A1 Fenster und Verbindung")
            e.melde("A1", "die lokale Seite lädt und verbindet sich (Gesundheit, Gespräche, Verlauf, Strom)",
                    all(p in pfade for p in ("/api/health", "/api/gespraeche", "/api/gespraech/1/ansicht", "/api/gespraech/1/ereignisse")), json.dumps(sorted(set(pfade))))
            print("A2 Gespräch")
            for schritt in ERWARTET:
                r = ergebnisse.get(schritt)
                e.melde("A2", f"Schritt {schritt}", bool(r and r["ok"]), json.dumps(r) if r else "kein Ergebnis (Zeitüberschreitung oder Seite nicht gestartet)")
            e.melde("A2", "der Prüflauf ist bis zum Ende gekommen", ok and "ende" in ergebnisse)
            print("A3 Beobachter")
            e.melde("A3", "der Beobachter fragt Freigaben und Läufe ab", "/api/freigaben" in pfade and "/api/laeufe" in pfade)
            print("A4 Token")
            anfragen = [x for x in z if "pfad" in x]
            e.melde("A4", "jede Anfrage kam mit dem richtigen Token und dem Kopf X-FYOS-Agent", bool(anfragen) and all(x["auth"] and x["kopf"] for x in anfragen))
            datei = (daten / "einstellungen.json").read_text(encoding="utf-8")
            e.melde("A4", "das Token steht nicht in den Einstellungen, nur der Verweis", TOKEN not in datei and "{tresor:runner-token}" in datei)
        finally:
            e.melde("A6", "SIGTERM beendet die Hülle", beenden(proc))
    finally:
        server.terminate()
        server.wait(timeout=10)

    print("A5 falsches Token")
    log5 = arbeit / "attrappe-falsch.log"
    log5.unlink(missing_ok=True)
    daten5 = arbeit / "daten" / "agent-falsch"
    if daten5.exists():
        shutil.rmtree(daten5)
    server5 = attrappe(PORT_FALSCH, log5, TOKEN)
    try:
        e.warten_bis(lambda: e.port_offen(PORT_FALSCH), 10)
        proc = app_starten(app, daten5, tmp, PORT_FALSCH, "ein-ganz-anderes-token-0123456789")
        try:
            e.warten_bis(lambda: len([x for x in zeilen(log5) if "pfad" in x and not x["auth"]]) >= 3, 45)
            abgelehnt = [x for x in zeilen(log5) if "pfad" in x and not x["auth"]]
            e.melde("A5", "die Hülle fragt weiter nach (Wiederholen), nimmt die Ablehnung hin und läuft weiter", len(abgelehnt) >= 3 and proc.poll() is None, f"{len(abgelehnt)} abgelehnte Anfragen")
        finally:
            beenden(proc)
    finally:
        server5.terminate()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--arbeit", default="/private/tmp/fyos-shell-d0-e2e/lauf-agent")
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
