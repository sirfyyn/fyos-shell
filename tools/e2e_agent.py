#!/usr/bin/env python3
"""Ende-zu-Ende-Prüfung des Profils agent (nur macOS, ohne Netz, ohne Zugangsdaten, ohne echten Runner und ohne den Schlüsselbund des Entwicklers).

Die Hülle läuft mit Profil agent und einem Wegwerf-Datenordner; als Runner dient die Attrappe `tools/runner_attrappe.py` (Loopback, Test-Token).
Das Token steht nicht im Schlüsselbund, sondern in einem Tresor im Arbeitsspeicher, den nur Debug-Bauten über FYOS_SHELL_TRESOR_SAAT vorbelegen lassen.
Die Chat-Seite bedient sich im Prüfmodus selbst (ui/agent/e2e.js, nur mit FYOS_SHELL_AGENT_E2E=1 im Debug-Bau) und meldet jedes Ergebnis an die Attrappe.

  A1  Chat-Fenster lädt die lokale Seite und verbindet sich: Gesundheit, Gespräche, Verlauf, Strom, alle mit richtigem Token und Kopf X-FYOS-Agent
  A2  Gespräch mit Streaming (Text erscheint vor dem Ende), Werkzeugkarte, Freigabe (genau zwei Knöpfe, Erlauben wirkt), Reset-Marker,
      Neuverbinden mitten im Strom (Text komplett, nichts doppelt)
      Arbeitsplatz: Sitzungsliste, Arbeitsordner im Kopf, Terminal-Ansicht (ANSI, Fortschrittszeile), Diff-Ansicht, Wechsel ohne Neuaufbau,
      laufende Sitzung markiert, neue Sitzung mit Arbeitsordner, neue Sitzung nur mit Namen (Enter im Namensfeld), Umbenennen im Kopf
      und in der Leiste (PATCH durch die Brücke, Esc, ohne Neuaufbau, Entwurf bleibt), Fehler des Runners klar, Archivieren und Wiederherstellen
  A3 der Beobachter fragt Freigaben und Läufe ab (Tray), auch ohne dass die Seite etwas tut
  A4  Token nirgends in den Einstellungen (nur der Verweis), keine Anfrage ohne Token
  A5  falsches Token: die Anwendung bleibt am Leben und versucht es wieder (Katalogmeldung im Banner, Wiederholen)
  A6  SIGTERM beendet die Hülle
  A7  bisheriger einzelner Runner steht danach als erster Eintrag der Runner-Liste (gleicher Tresor-Verweis, nichts neu einzurichten)
  B1  lokaler Runner: die Hülle startet das Test-Programm (tools/lokaler_runner_test.py) mit freiem Port und zufälligem Token, Ordnerwahl über
      den Prüfbau-Ersatz des Systemdialogs, Sitzung mit Ordner, zuletzt benutzte Ordner, reservierter Weg bleibt der Seite verwehrt
  B2  Umschalten auf einen entfernten Runner ohne Neustart: Ordnerbaum (Wurzeln, Aufklappen, Wählen), 403 und 404 klar, zuletzt je Runner
  B3  SIGTERM der Hülle beendet auch das lokale Programm (kein Zombie, kein Waise); das Token steht nicht in den Einstellungen

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
PORT_FERNE = 18683
PROGRAMM = e.TOOLS / "lokaler_runner_test.py"
ERWARTET_B = ["runner-liste", "lokaler-runner-laeuft", "lokal-dialog-statt-baum", "lokal-ordner-gewaehlt", "lokal-sitzung-mit-ordner", "ordner-in-liste",
              "zuletzt-benutzt", "erlauben-nicht-fuer-die-seite", "wechsel-entfernt", "baum-wurzeln", "baum-aufklappen", "baum-auswahl",
              "baum-sitzung-mit-ordner", "ausserhalb-403-klar", "nicht-gefunden-404-klar", "zuletzt-je-runner", "ende"]
TOKEN = "-".join(["e2e", "probe"] * 4)  # erfundener Testwert
ERWARTET = ["seite-geladen", "verbunden", "streaming-teilweise", "streaming-ganz", "werkzeugkarte", "freigabe-karte",
            "freigabe-nur-erlauben-ablehnen", "freigabe-erteilt", "reset-marker", "neuverbunden-vollstaendig", "neuverbunden-nichts-doppelt",
            "sitzungsliste", "ordner-im-kopf", "terminal-ansicht", "terminal-fortschrittszeile", "diff-ansicht", "wechsel-zu-zweiter", "wechsel-eigener-verlauf",
            "laufende-sitzung-markiert", "markierung-endet", "wechsel-erhaelt-sitzung", "wechsel-nichts-doppelt", "neue-sitzung",
            "neue-sitzung-mit-namen", "umbenennen-kopf", "umbenennen-ohne-neuaufbau", "umbenennen-esc", "umbenennen-leiste", "umbenennen-fehler-klar",
            "archivieren", "wiederherstellen", "ende"]


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
            ok = e.warten_bis(lambda: any(z.get("ergebnis", {}).get("schritt") in ("ende", "abgebrochen") for z in zeilen(log)), 240)
            z = zeilen(log)
            ergebnisse = {x["ergebnis"]["schritt"]: x["ergebnis"] for x in z if "ergebnis" in x}
            pfade = [x["pfad"].split("?")[0] for x in z if "pfad" in x]
            print("A1 Fenster und Verbindung")
            e.melde("A1", "die lokale Seite lädt und verbindet sich (Gesundheit, Gespräche, Verlauf, Strom)",
                    all(p in pfade for p in ("/api/health", "/api/gespraeche", "/api/gespraech/1/ansicht", "/api/gespraech/1/ereignisse", "/api/konfiguration", "/api/strom")), json.dumps(sorted(set(pfade))))
            e.melde("A1", "die Seitenleiste fragt den Arbeitsordner der Sitzung und beim Wechsel die zweite Sitzung", "/api/gespraech/1" in pfade and "/api/gespraech/2/ansicht" in pfade and "/api/gespraech/2/ereignisse" in pfade)
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
        liste = json.loads((daten / "einstellungen.json").read_text(encoding="utf-8")).get("agent", {}).get("runner", [])
        e.melde("A7", "der bisherige Runner steht als erster Eintrag der Liste, mit demselben Tresor-Verweis",
                len(liste) == 1 and liste[0].get("adresse") == f"http://127.0.0.1:{PORT}" and liste[0].get("token") == "{tresor:runner-token}" and liste[0].get("art") == "entfernt", json.dumps(liste))
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


def lebt(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def ergebnisse_aus(*logs):
    aus = {}
    for log in logs:
        for x in zeilen(log):
            k = x.get("koerper")
            if x.get("pfad") == "/api/e2e/ergebnis" and isinstance(k, dict) and "schritt" in k:
                aus[k["schritt"]] = k
    return aus


def pruefe_ordner(app, arbeit):
    """B1 bis B3: lokaler Runner (Test-Programm als Kindprozess der Hülle), Ordnerwahl, Umschalten auf einen entfernten Runner (Ordnerbaum)."""
    import re
    PROGRAMM.chmod(0o755)
    tmp = arbeit / "tmp"
    tmp.mkdir(exist_ok=True)
    daten = arbeit / "daten" / "ordner"
    if daten.exists():
        shutil.rmtree(daten)
    daten.mkdir(parents=True)
    baum = arbeit / "ordnerbaum"
    if baum.exists():
        shutil.rmtree(baum)
    (baum / "wurzel" / "a" / "tief").mkdir(parents=True)
    (baum / "wurzel" / "b").mkdir()
    lokal_ordner = arbeit / "projekt-lokal"
    lokal_ordner.mkdir(exist_ok=True)
    lokal_log, ferne_log = arbeit / "lokal-runner.log", arbeit / "ferne-runner.log"
    lokal_log.unlink(missing_ok=True)
    ferne_log.unlink(missing_ok=True)
    if e.port_offen(PORT_FERNE):
        sys.exit(f"Port {PORT_FERNE} ist belegt (ein anderer Prüfstand läuft noch).")
    ferne = subprocess.Popen([sys.executable, str(PROGRAMM), "--log", str(ferne_log)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             env=dict(os.environ, FYOS_RUNNER_PORT=str(PORT_FERNE), FYOS_RUNNER_TOKEN=TOKEN, FYOS_RUNNER_ORDNER_ERLAUBT=str((baum / "wurzel").resolve())))
    try:
        if not e.warten_bis(lambda: e.port_offen(PORT_FERNE), 10):
            sys.exit("Test-Programm (entfernter Runner) startet nicht")
        (daten / "einstellungen.json").write_text(json.dumps({"schema": 1, "agent": {
            "runner": [{"id": "lokal", "name": "Dieser Rechner", "art": "lokal", "adresse": None, "token": ""},
                       {"id": "ferne", "name": "Ferne", "art": "entfernt", "adresse": f"http://127.0.0.1:{PORT_FERNE}", "token": "{tresor:runner-ferne}"}],
            "aktiv_runner": "lokal", "lokal": {"programm": str(PROGRAMM), "args": ["--log", str(lokal_log)]}, "ruhe": False, "gemeldet": []}}), encoding="utf-8")
        env = dict(os.environ, FYOS_SHELL_DATEN=str(daten), TMPDIR=str(tmp), FYOS_SHELL_TRESOR_SAAT=f"runner-ferne={TOKEN}", FYOS_SHELL_AGENT_E2E="1",
                   FYOS_SHELL_AGENT_E2E_SKRIPT="e2e-ordner", FYOS_SHELL_E2E_ORDNER=str(lokal_ordner))
        starts = []
        proc = subprocess.Popen([str(app / "Contents" / "MacOS" / "fyos-shell")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            ok = e.warten_bis(lambda: any(x in ergebnisse_aus(ferne_log) for x in ("ende", "abgebrochen")), 180)
            erg = ergebnisse_aus(lokal_log, ferne_log)
            print("B1 lokaler Runner und Ordnerwahl, B2 Umschalten und Ordnerbaum")
            for schritt in ERWARTET_B:
                r = erg.get(schritt)
                e.melde("B1" if schritt in ERWARTET_B[:8] else "B2", f"Schritt {schritt}", bool(r and r["ok"]), json.dumps(r) if r else "kein Ergebnis (Zeitüberschreitung oder Seite nicht gestartet)")
            e.melde("B2", "der Prüflauf ist bis zum Ende gekommen", ok and "ende" in erg)
            z = zeilen(lokal_log)
            starts = [x["start"]["pid"] for x in z if "start" in x]
            anfragen = [x for x in z if "pfad" in x]
            e.melde("B1", "das Test-Programm wurde von der Hülle gestartet (genau einmal) und jede Anfrage kam mit dem zufälligen Token", len(starts) == 1 and bool(anfragen) and all(x["auth"] for x in anfragen), f"{len(starts)} Starts, {len(anfragen)} Anfragen")
            posts = [x["koerper"] for x in anfragen if x.get("methode") == "POST" and x["pfad"] == "/api/gespraeche"]
            e.melde("B1", "die neue Sitzung ging mit dem gewählten Ordner an den lokalen Runner", any(isinstance(k, dict) and str(k.get("ordner", "")).endswith("projekt-lokal") for k in posts), json.dumps(posts))
            erlaubt = [x for x in anfragen if x["pfad"] == "/api/ordner/erlauben"]
            e.melde("B1", "die Hülle (nicht die Seite) meldete den Ordner als erlaubte Wurzel, und zwar nur diesen", len(erlaubt) == 1 and str(erlaubt[0]["koerper"].get("pfad", "")).endswith("projekt-lokal"), json.dumps([x["koerper"] for x in erlaubt]))
            datei = (daten / "einstellungen.json").read_text(encoding="utf-8")
            e.melde("B3", "kein 64-stelliges Token in den Einstellungen; gemerkt ist der Ordner, nicht mehr", re.search(r"[0-9a-f]{64}", datei) is None and TOKEN not in datei and "projekt-lokal" in datei)
        finally:
            e.melde("B3", "SIGTERM beendet die Hülle", beenden(proc))
            if starts:
                e.warten_bis(lambda: not lebt(starts[0]), 12)
                e.melde("B3", "das lokale Programm ist mit der Hülle beendet (kein Zombie, kein Waise)", not lebt(starts[0]))
            e.melde("B3", "der entfernte Test-Runner läuft unberührt weiter", ferne.poll() is None)
    finally:
        ferne.terminate()
        ferne.wait(timeout=10)


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
    pruefe_ordner(app, arbeit)
    schlecht = [x for x in e.ERGEBNISSE if not x[2]]
    print(f"\n{len(e.ERGEBNISSE) - len(schlecht)} von {len(e.ERGEBNISSE)} Prüfungen bestanden.")
    for tor, name, _, detail in schlecht:
        print(f"FEHLER {tor} {name}: {detail}")
    sys.exit(1 if schlecht else 0)


if __name__ == "__main__":
    main()
