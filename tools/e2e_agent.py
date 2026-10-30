#!/usr/bin/env python3
"""Ende-zu-Ende-Prüfung des Profils agent (nur macOS, ohne Netz, ohne Zugangsdaten, ohne echten Runner und ohne den Schlüsselbund des Entwicklers).

Die Hülle läuft mit Profil agent und einem Wegwerf-Datenordner; als Runner dient die Attrappe `tools/runner_attrappe.py` (Loopback, Test-Token).
Das Token steht nicht im Schlüsselbund, sondern in einem Tresor im Arbeitsspeicher, den nur Debug-Bauten über FYOS_SHELL_TRESOR_SAAT vorbelegen lassen.
Die Chat-Seite bedient sich im Prüfmodus selbst (ui/agent/e2e.js, nur mit FYOS_SHELL_AGENT_E2E=1 im Debug-Bau) und meldet jedes Ergebnis an die Attrappe.

  A1  Chat-Fenster lädt die lokale Seite und verbindet sich: Gesundheit, Gespräche, Verlauf, Strom, alle mit richtigem Token und Kopf X-FYOS-Agent
  A2  Gespräch mit Streaming (Text erscheint vor dem Ende), Werkzeugkarte, Freigabe (genau zwei Knöpfe, Erlauben wirkt), Reset-Marker,
      Freigaben-Panel (Zahl aller offenen Freigaben, Liste über alle Sitzungen, Erlauben im Panel, Später, Sprung in die Sitzung ohne Neuaufbau),
      Neuverbinden mitten im Strom (Text komplett, nichts doppelt)
      Arbeitsplatz: Sitzungsliste, Arbeitsordner im Kopf, Terminal-Ansicht (ANSI, Fortschrittszeile), Diff-Ansicht, Wechsel ohne Neuaufbau,
      laufende Sitzung markiert, neue Sitzung mit Arbeitsordner, neue Sitzung nur mit Namen (Enter im Namensfeld), Umbenennen im Kopf
      und in der Leiste (PATCH durch die Brücke, Esc, ohne Neuaufbau, Entwurf bleibt), Fehler des Runners klar, Archivieren und Wiederherstellen
      Panel „Änderungen“ (aenderungen-*: Knopf mit Zahl, Liste der Dateien aus den Datei-Werkzeugen, Diff, Vorschau, Dateibaum, Esc)
      Archiv vom Runner, Suche, Datei-Vorschau und Dateibaum über den Runner (archiv-vom-runner, suche-*, kuerzel-suche, baum-mit-dateien, vorschau-*)
      Kontextanzeige (kontext-plausibel: Füllung der letzten Antwort gegen das Fenster 262144 des Modells, nicht die Lebenszeitsumme) und Einstellungen-Knopf (einstellungen-knopf:
      der Befehl läuft ohne Fehler; A2b: danach gibt es ein zweites sichtbares Fenster, die Einstellungen; braucht die Bedienungshilfen-Erlaubnis
      für osascript, sonst "nicht prüfbar")
  A3 der Beobachter fragt Freigaben und Läufe ab (Tray), auch ohne dass die Seite etwas tut
  A4  Token nirgends in den Einstellungen (nur der Verweis), keine Anfrage ohne Token
  A5  falsches Token: die Anwendung bleibt am Leben und versucht es wieder (Katalogmeldung im Banner, Wiederholen)
  A6  SIGTERM beendet die Hülle
  A7  bisheriger einzelner Runner steht danach als erster Eintrag der Runner-Liste (gleicher Tresor-Verweis, nichts neu einzurichten)
  B1  lokaler Runner: die Hülle startet das Test-Programm (tools/lokaler_runner_test.py) mit freiem Port und zufälligem Token, Ordnerwahl über
      den Prüfbau-Ersatz des Systemdialogs, Sitzung mit Ordner, zuletzt benutzte Ordner, reservierter Weg bleibt der Seite verwehrt
  B2  Umschalten auf einen entfernten Runner ohne Neustart: Ordnerbaum (Wurzeln, Aufklappen, Wählen), 403 und 404 klar, zuletzt je Runner
  B3  SIGTERM der Hülle beendet auch das lokale Programm (kein Zombie, kein Waise); das Token steht nicht in den Einstellungen

  C1  zwei Adressen je Runner: die erste ist tot (geschlossener Port auf Loopback), die zweite lebt (Attrappe): die ganze Sitzung läuft über die zweite
  C2  danach leben beide: die Hülle bleibt bei der zuletzt funktionierenden (die erste bekommt keine Anfrage)
  C3  die erste antwortet mit 401: kein Wechsel, die zweite sieht nichts
  C4  die gemerkte (zweite) fällt aus: die Hülle geht zurück zur ersten; die gemerkte Adresse steht nicht in den Einstellungen

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
# zwei Adressen je Runner (C1 bis C4); PORT_ERSTE ist zuerst ein freier, geschlossener Port, später lebt dort eine Attrappe
PORT_ERSTE = 18684
PORT_ZWEITE = 18685
PORT_401 = 18686
PORT_401_ZWEITE = 18687
PROGRAMM = e.TOOLS / "lokaler_runner_test.py"
ERWARTET_B = ["runner-liste", "lokaler-runner-laeuft", "lokal-dialog-statt-baum", "lokal-ordner-gewaehlt", "lokal-sitzung-mit-ordner", "ordner-in-liste",
              "zuletzt-benutzt", "erlauben-nicht-fuer-die-seite", "wechsel-entfernt", "baum-wurzeln", "baum-aufklappen", "baum-auswahl",
              "baum-sitzung-mit-ordner", "ausserhalb-403-klar", "nicht-gefunden-404-klar", "zuletzt-je-runner", "ende"]
TOKEN = "-".join(["e2e", "probe"] * 4)  # erfundener Testwert
ERWARTET = ["seite-geladen", "verbunden", "streaming-teilweise", "streaming-ganz", "kontext-plausibel", "einstellungen-knopf", "werkzeugkarte", "freigabe-karte",
            "freigabe-nur-erlauben-ablehnen", "freigabe-erteilt", "freigaben-zahl", "freigaben-live-strom", "freigaben-banner", "freigaben-banner-oeffnet-panel",
            "freigaben-panel-alle-sitzungen", "freigaben-zerstoererisch-marke", "freigaben-zerstoererisch-zweite-bestaetigung", "freigaben-erlauben-im-panel", "freigaben-notiz-beim-runner",
            "freigaben-spaeter", "freigaben-sprung", "freigaben-sprung-ohne-neuaufbau", "freigaben-verlauf-zieht-nach", "reset-marker", "neuverbunden-vollstaendig", "neuverbunden-nichts-doppelt",
            "sitzungsliste", "ordner-im-kopf", "terminal-ansicht", "terminal-fortschrittszeile", "diff-ansicht", "aenderungen-knopf", "aenderungen-liste", "aenderungen-diff", "aenderungen-vorschau",
            "aenderungen-baum", "aenderungen-esc", "wechsel-zu-zweiter", "wechsel-eigener-verlauf",
            "laufende-sitzung-markiert", "markierung-endet", "wechsel-erhaelt-sitzung", "wechsel-nichts-doppelt", "neue-sitzung",
            "neue-sitzung-mit-namen", "umbenennen-kopf", "umbenennen-ohne-neuaufbau", "umbenennen-esc", "umbenennen-leiste", "umbenennen-fehler-klar",
            "archivieren", "wiederherstellen", "archiv-vom-runner", "suche-treffer", "suche-archiv-treffer", "suche-esc", "kuerzel-suche", "baum-mit-dateien",
            "vorschau-ueber-weg", "vorschau-geschwaerzt", "vorschau-gekuerzt", "vorschau-binaer", "vorschau-gesperrt", "ende"]


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


def sichtbare_fenster(prozess="fyos-shell"):
    """Titel der sichtbaren Fenster des Prüfbaus (System Events); None, wenn macOS das Lesen nicht erlaubt."""
    try:
        r = subprocess.run(["osascript", "-e", f'tell application "System Events" to get name of every window of process "{prozess}"'], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    return [n for n in r.stdout.strip().split(", ") if n]


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
            print("A2b Einstellungsfenster nach dem Klick auf den Knopf")
            fenster = sichtbare_fenster()
            if fenster is not None:
                fenster = [n for n in fenster if n == NAME]  # nur die Fenster des Prüfbaus (eine laufende installierte App heißt anders und wird nicht gezählt)
            if not fenster:
                print("  [nicht prüfbar] A2b osascript liest keine Fenster des Prüfbaus (Bedienungshilfen für das Terminal erlauben; der Prüfbau muss dazu sichtbar sein); der Befehl selbst ist durch den Schritt einstellungen-knopf belegt")
            else:
                e.melde("A2b", "es gibt zwei sichtbare Fenster: Chat und Einstellungen", len(fenster) >= 2, json.dumps(fenster))
            print("A3 Beobachter")
            e.melde("A3", "der Beobachter fragt Freigaben und Läufe ab", "/api/freigaben" in pfade and "/api/laeufe" in pfade)
            # Wege von Archiv, Suche, Datei lesen und Dateiliste: nur GET, mit Token, mit der erwarteten Abfrage (alles durch die echte Brücke runner_anfrage)
            wege = [x for x in z if "pfad" in x and x["methode"] == "GET"]
            e.melde("A3", "Archiv, Suche, Datei und Dateiliste kamen als GET mit Token durch die Brücke",
                    any(x["pfad"] == "/api/gespraeche?archiv=1" and x["auth"] for x in wege)
                    and any(x["pfad"].startswith("/api/suche?q=Umbenannt&limit=20&archiv=alle") and x["auth"] for x in wege)
                    and any(x["pfad"].startswith("/api/datei?pfad=%2Fprobe%2Fordner-a%2Fprojekt-eins%2FREADME%2Emd&gespraech=") and x["pfad"].endswith("&max=200000") and x["auth"] for x in wege)
                    and any(x["pfad"].startswith("/api/ordner?pfad=%2Fprobe%2Fordner-a%2Fprojekt-eins&dateien=1") and x["auth"] for x in wege),
                    json.dumps(sorted({x["pfad"][:90] for x in wege if x["pfad"].startswith(("/api/suche", "/api/datei", "/api/ordner", "/api/gespraeche?"))})[:12]))
            e.melde("A3", "Suche und Datei lesen kamen nie mit einem anderen Verb als GET", all(x["methode"] == "GET" for x in z if "pfad" in x and x["pfad"].startswith(("/api/suche", "/api/datei"))))
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
            # die Attrappe des Runners schreibt das Ergebnis als eigene Zeile {"ergebnis": {...}}
            if isinstance(x.get("ergebnis"), dict) and "schritt" in x["ergebnis"]:
                aus[x["ergebnis"]["schritt"]] = x["ergebnis"]
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


def app_starten_zwei(app, daten, tmp, erste, zweite, token_im_tresor):
    """Startet die Hülle mit einem Runner der Liste, der zwei Adressen hat (`adresse`, `adresse2`); das Token liegt im Tresor im Arbeitsspeicher."""
    daten.mkdir(parents=True, exist_ok=True)
    (daten / "einstellungen.json").write_text(json.dumps({"schema": 1, "agent": {
        "runner": [{"id": "zwei", "name": "Zwei Adressen", "art": "entfernt", "adresse": f"http://127.0.0.1:{erste}", "adresse2": f"http://127.0.0.1:{zweite}", "token": "{tresor:runner-zwei}"}],
        "aktiv_runner": "zwei", "ruhe": False, "gemeldet": []}}), encoding="utf-8")
    env = dict(os.environ, FYOS_SHELL_DATEN=str(daten), TMPDIR=str(tmp), FYOS_SHELL_TRESOR_SAAT=f"runner-zwei={token_im_tresor}", FYOS_SHELL_AGENT_E2E="1")
    return subprocess.Popen([str(app / "Contents" / "MacOS" / "fyos-shell")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def anfragen_in(log):
    return [x for x in zeilen(log) if "pfad" in x]


def pruefe_adressen(app, arbeit):
    """C1 bis C4: zwei Adressen je Runner. Erste Adresse = freier, geschlossener Port auf Loopback; zweite = Attrappe."""
    tmp = arbeit / "tmp"
    tmp.mkdir(exist_ok=True)
    for port in (PORT_ERSTE, PORT_ZWEITE, PORT_401, PORT_401_ZWEITE):
        if e.port_offen(port):
            sys.exit(f"Port {port} ist belegt (ein anderer Prüfstand läuft noch). Abhilfe: beenden oder die Ports in tools/e2e_agent.py ändern.")
    daten = arbeit / "daten" / "zwei"
    if daten.exists():
        shutil.rmtree(daten)
    log1, log2 = arbeit / "zwei-erste.log", arbeit / "zwei-zweite.log"
    log1.unlink(missing_ok=True)
    log2.unlink(missing_ok=True)
    print("C1 erste Adresse tot, zweite lebt")
    zweite = attrappe(PORT_ZWEITE, log2, TOKEN)
    erste = None
    try:
        if not e.warten_bis(lambda: e.port_offen(PORT_ZWEITE), 10):
            sys.exit("Runner-Attrappe (zweite Adresse) startet nicht")
        proc = app_starten_zwei(app, daten, tmp, PORT_ERSTE, PORT_ZWEITE, TOKEN)
        try:
            e.warten_bis(lambda: "verbunden" in ergebnisse_aus(log2), 120)
            e.melde("C1", "die Verbindung kommt über die zweite Adresse zustande (erste: kein TCP)", "verbunden" in ergebnisse_aus(log2) and "/api/health" in [x["pfad"].split("?")[0] for x in anfragen_in(log2)])
            # C2: jetzt lebt auch die erste Adresse; die Hülle bleibt bei der zuletzt funktionierenden (zweiten)
            erste = attrappe(PORT_ERSTE, log1, TOKEN)
            e.warten_bis(lambda: e.port_offen(PORT_ERSTE), 10)
            ok = e.warten_bis(lambda: any(x in ergebnisse_aus(log2) for x in ("ende", "abgebrochen")), 240)
            erg = ergebnisse_aus(log2)
            for schritt in ("verbunden", "streaming-ganz", "freigabe-erteilt", "neuverbunden-vollstaendig", "neuverbunden-nichts-doppelt", "wechsel-erhaelt-sitzung", "ende"):
                r = erg.get(schritt)
                e.melde("C1", f"Schritt {schritt} (über die zweite Adresse)", bool(r and r["ok"]), json.dumps(r) if r else "kein Ergebnis")
            e.melde("C1", "der Prüflauf ist über die zweite Adresse bis zum Ende gekommen", ok and "ende" in erg)
            print("C2 beide lebendig: bleibt bei der zuletzt funktionierenden")
            e.warten_bis(lambda: False, 12)  # mindestens zwei Beobachter-Durchgänge nach dem Ende
            e.melde("C2", "die erste (inzwischen lebende) Adresse hat keine einzige Anfrage bekommen, auch nicht beim Neuverbinden des Stroms", len(anfragen_in(log1)) == 0, f"{len(anfragen_in(log1))} Anfragen")
            e.melde("C2", "die zweite Adresse bedient weiter (Beobachter)", len([x for x in anfragen_in(log2) if x["pfad"].split("?")[0] == "/api/freigaben"]) >= 3)
            # C4: die gemerkte (zweite) fällt aus: zurück zur ersten
            print("C4 die gemerkte Adresse fällt aus: zurück zur ersten")
            zweite.terminate()
            zweite.wait(timeout=10)
            e.melde("C4", "nach dem Ausfall der zweiten Adresse kommen Anfragen mit richtigem Token bei der ersten an",
                    e.warten_bis(lambda: any(x["auth"] and x["pfad"].split("?")[0] == "/api/freigaben" for x in anfragen_in(log1)), 60), f"{len(anfragen_in(log1))} Anfragen")
            e.melde("C4", "die Hülle läuft weiter", proc.poll() is None)
            datei = (daten / "einstellungen.json").read_text(encoding="utf-8")
            runner = json.loads(datei).get("agent", {}).get("runner", [{}])[0]
            e.melde("C4", "die Einstellungen bleiben, wie eingetragen (erste, zweite): die gemerkte Adresse steht nur im Speicher; das Token steht nicht darin",
                    TOKEN not in datei and runner.get("adresse") == f"http://127.0.0.1:{PORT_ERSTE}" and runner.get("adresse2") == f"http://127.0.0.1:{PORT_ZWEITE}", json.dumps(runner))
        finally:
            beenden(proc)
    finally:
        for s in (zweite, erste):
            if s is not None and s.poll() is None:
                s.terminate()
                s.wait(timeout=10)

    print("C3 die erste Adresse antwortet mit 401: kein Wechsel")
    daten3 = arbeit / "daten" / "zwei-401"
    if daten3.exists():
        shutil.rmtree(daten3)
    log3, log4 = arbeit / "zwei-401-erste.log", arbeit / "zwei-401-zweite.log"
    log3.unlink(missing_ok=True)
    log4.unlink(missing_ok=True)
    abweisend = attrappe(PORT_401, log3, "ein-ganz-anderes-token-0123456789")
    gut = attrappe(PORT_401_ZWEITE, log4, TOKEN)
    try:
        e.warten_bis(lambda: e.port_offen(PORT_401) and e.port_offen(PORT_401_ZWEITE), 10)
        proc = app_starten_zwei(app, daten3, tmp, PORT_401, PORT_401_ZWEITE, TOKEN)
        try:
            e.warten_bis(lambda: len([x for x in anfragen_in(log3) if not x["auth"]]) >= 3, 60)
            e.melde("C3", "die erste Adresse bekommt die Anfragen und lehnt ab (mindestens drei, Wiederholen läuft)", len([x for x in anfragen_in(log3) if not x["auth"]]) >= 3, f"{len(anfragen_in(log3))} Anfragen")
            e.melde("C3", "die zweite Adresse bekommt keine einzige Anfrage (kein Wechsel bei 401, das Token geht nicht an eine zweite Stelle)", len(anfragen_in(log4)) == 0, f"{len(anfragen_in(log4))} Anfragen")
            e.melde("C3", "die Hülle läuft weiter", proc.poll() is None)
        finally:
            beenden(proc)
    finally:
        for s in (abweisend, gut):
            s.terminate()
            s.wait(timeout=10)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--arbeit", default="/private/tmp/fyos-shell-d0-e2e/lauf-agent")
    p.add_argument("--ohne-bau", action="store_true")
    p.add_argument("--nur-adressen", action="store_true", help="nur C1 bis C4 (zwei Adressen je Runner)")
    a = p.parse_args()
    if sys.platform != "darwin":
        sys.exit("Dieses Skript läuft nur auf macOS.")
    arbeit = Path(a.arbeit)
    arbeit.mkdir(parents=True, exist_ok=True)
    app = arbeit / "bau" / f"{NAME}.app" if a.ohne_bau else bauen(arbeit)
    if not a.nur_adressen:
        pruefe(app, arbeit)
        pruefe_ordner(app, arbeit)
    pruefe_adressen(app, arbeit)
    schlecht = [x for x in e.ERGEBNISSE if not x[2]]
    print(f"\n{len(e.ERGEBNISSE) - len(schlecht)} von {len(e.ERGEBNISSE)} Prüfungen bestanden.")
    for tor, name, _, detail in schlecht:
        print(f"FEHLER {tor} {name}: {detail}")
    sys.exit(1 if schlecht else 0)


if __name__ == "__main__":
    main()
