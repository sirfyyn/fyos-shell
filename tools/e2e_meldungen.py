#!/usr/bin/env python3
"""Ende-zu-Ende-Prüfung der System-Mitteilungen im Profil OS (nur macOS, ohne Netz, ohne Zugangsdaten): Testserver `testserver.py os`, Seite /os/meldungen.

  M1  Die Brücke window.__FYOS_HUELLE__ steht im Hauptrahmen der Seite (Profil os)
  M2  Hauptseite des Servers darf den Befehl: zu langer Titel (81 Zeichen) wird von der Hülle mit MITTEILUNG_ABGELEHNT beantwortet (Befehl erreicht)
  M3  Eine einzige Prüfmitteilung (Titel „FYOS OS Test“, still): Ergebnis der Hülle wird berichtet (gezeigt oder MITTEILUNGEN_*-Fehlercode)
  M4  Sandbox-Rahmen (srcdoc, sandbox ohne allow-same-origin, Ursprung null): weder Brücke noch __TAURI_INTERNALS__, kein Zugriff auf parent
  M5  Rahmen mit gleichem Ursprung (nicht sandboxed): bekommt die Brücke nicht (Initialisierungsskript nur im Hauptrahmen)
  M6  Ein anderer Server (anderer Port als in der Capability) ruft denselben Befehl: Tauri lehnt per ACL ab, keine Mitteilung

Aufruf (aus apps/fyos-shell):  python3 tools/e2e_meldungen.py [--ohne-bau]
Höchstens EINE echte Systemmitteilung je Lauf (M3). Eigene Bundle-Id (.meldtest), eigener Datenordner, keine Zugangsdaten.
"""
import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import e2e_os as o  # noqa: E402
import e2e_update as e  # noqa: E402

NAME = "FYOS OS Meldungen D0-Test"
PORT = 18681
PORT_FREMD = 18682  # nicht in der Capability des Baus


def bauen(ausgabe):
    ziel = ausgabe / "bau"
    if ziel.exists():
        shutil.rmtree(ziel)
    ziel.mkdir(parents=True)
    r = subprocess.run([sys.executable, str(e.TOOLS / "bauen.py"), "os", "--debug", "--bundles", "app", "--name", NAME, "--kennung-zusatz", "meldtest",
                        "--meldungen-test-ursprung", f"http://127.0.0.1:{PORT}"])
    if r.returncode != 0:
        sys.exit("Bau fehlgeschlagen")
    shutil.copytree(e.WURZEL / "target" / "debug" / "bundle" / "macos" / f"{NAME}.app", ziel / f"{NAME}.app", symlinks=True)
    return ziel / f"{NAME}.app"


def berichte(log):
    """Berichte der Seite: {Schlüssel: Wert} aus /os/ergebnis?k=…&w=…"""
    out = {}
    for z in o.zeilen(log):
        if z["pfad"].startswith("/os/ergebnis"):
            q = parse_qs(urlparse(z["pfad"]).query)
            out[q.get("k", [""])[0]] = q.get("w", [""])[0]
    return out


def lauf(app, arbeit, port, log, tmp, spion, daten):
    server = o.server_starten(arbeit, port, log)
    try:
        if not e.warten_bis(lambda: e.port_offen(port), 10):
            sys.exit("Test-Server startet nicht")
        proc = o.app_starten(app, daten, tmp, spion, f"http://127.0.0.1:{port}/os/meldungen")
        try:
            e.warten_bis(lambda: {"HAUPT", "ZEIGEN", "RAHMEN", "GLEICH"} <= set(berichte(log)), 45)
        finally:
            o.beenden(proc)
        return berichte(log)
    finally:
        server.terminate()
        server.wait(timeout=10)


def pruefe(app, arbeit):
    tmp = arbeit / "tmp"
    tmp.mkdir(exist_ok=True)
    spion = arbeit / "browser-spion.sh"
    spion.write_text('#!/bin/sh\nexit 0\n', encoding="utf-8")
    spion.chmod(0o755)
    daten = arbeit / "daten" / "meldungen"
    if daten.exists():
        shutil.rmtree(daten)
    log = arbeit / "meldungen-server.log"
    log.unlink(missing_ok=True)

    b = lauf(app, arbeit, PORT, log, tmp, spion, daten)
    print(json.dumps(b, ensure_ascii=False))
    e.melde("M1", "Brücke im Hauptrahmen vorhanden, Profil os", b.get("HAUPT", "").startswith("bruecke=object;profil=os"), b.get("HAUPT", "fehlt"))
    e.melde("M2", "zu langer Titel: Hülle antwortet MITTEILUNG_ABGELEHNT (Befehl erreicht, Prüfung greift)", b.get("LANG") == "abgelehnt:MITTEILUNG_ABGELEHNT", b.get("LANG", "fehlt"))
    zeigen = b.get("ZEIGEN", "fehlt")
    e.melde("M3", "Prüfmitteilung: gezeigt oder Katalogfehler MITTEILUNGEN_* (nicht ACL, nicht Absender)", zeigen.startswith("ok:") or zeigen.startswith("fehler:MITTEILUNG"), zeigen)
    print(f"  [Beobachtung] Systemmitteilung: {zeigen}")
    rahmen = b.get("RAHMEN", "fehlt").split(",")
    e.melde("M4", "Sandbox-Rahmen: Brücke und __TAURI_INTERNALS__ nicht definiert, parent gesperrt", rahmen[:2] == ["undefined", "undefined"] and rahmen[2:] == ["gesperrt"], b.get("RAHMEN", "fehlt"))
    e.melde("M5", "Rahmen mit gleichem Ursprung: keine Brücke", b.get("GLEICH", "fehlt").split(",")[0] == "undefined", b.get("GLEICH", "fehlt"))

    log2 = arbeit / "meldungen-server-fremd.log"
    log2.unlink(missing_ok=True)
    daten2 = arbeit / "daten" / "meldungen-fremd"
    if daten2.exists():
        shutil.rmtree(daten2)
    b2 = lauf(app, arbeit, PORT_FREMD, log2, tmp, spion, daten2)
    print(json.dumps(b2, ensure_ascii=False))
    z2 = b2.get("ZEIGEN", "fehlt")
    e.melde("M6", "Server außerhalb der Capability: Befehl per ACL abgelehnt (keine Mitteilung)", z2.startswith("fehler:") and "MITTEILUNG" not in z2, z2)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--arbeit", default="/private/tmp/fyos-shell-d0-e2e/lauf-meldungen")
    p.add_argument("--ohne-bau", action="store_true")
    a = p.parse_args()
    if sys.platform != "darwin":
        sys.exit("Dieses Skript läuft nur auf macOS.")
    arbeit = Path(a.arbeit)
    arbeit.mkdir(parents=True, exist_ok=True)
    app = arbeit / "bau" / f"{NAME}.app" if a.ohne_bau else bauen(arbeit)
    pruefe(app, arbeit)
    schlecht = [x for x in e.ERGEBNISSE if not x[2]]
    for tor, name, ok, detail in e.ERGEBNISSE:
        print(f"{'OK    ' if ok else 'FEHLER'} {tor} {name} [{detail}]")
    print(f"\n{len(e.ERGEBNISSE) - len(schlecht)} von {len(e.ERGEBNISSE)} Prüfungen bestanden.")
    sys.exit(1 if schlecht else 0)


if __name__ == "__main__":
    main()
