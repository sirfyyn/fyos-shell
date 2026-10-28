#!/usr/bin/env python3
"""Ende-zu-Ende-Prüfung der Übernahme aus dem bestehenden Python-Studio (`--uebernehmen-studio`), nur macOS, ohne Netz, ohne Python-Bündel.

  U1  Probelauf (--trocken) gegen einen Attrappen-Ordner: zeigt, was kopiert würde; schreibt nichts; Quelle bytegleich
  U2  echter Lauf: Dateien da und gleich, Protokolle/Update-Zustand/Modelle nicht, hosts.json bleibt 0600, Marke da,
      einstellungen.json der Hülle ohne Token, Quelle bytegleich; zweiter Lauf wird mit Katalogtext verweigert
  U3  Teilkollision: eine schon vorhandene Datei im Ziel wird nie überschrieben
  U4  Leeres/fehlendes altes Verzeichnis: Katalogfehler UEBERNAHME_QUELLE_FEHLT, Ausgang 2
  U5  Das echte Verzeichnis dieses Macs (~/Library/Application Support/FLE Studio), falls vorhanden: nur LESEN (--trocken) und danach
      eine echte Übernahme aus einer KOPIE davon (ditto) in einen Wegwerf-Datenordner; das Original bleibt bytegleich
  U6  Profil Agent/Os darf nicht übernehmen (nur Studio): hier nur über die Unit-Tests abgedeckt

Aufruf (aus apps/fyos-shell):  python3 tools/e2e_uebernahme.py [--ohne-bau]
Die App läuft mit eigener Bundle-Id (.e2etest), eigenem TMPDIR und FYOS_SHELL_DATEN in einem Wegwerf-Ordner; eine installierte App, der echte Schlüsselbund
und der echte Anmeldeordner bleiben unberührt. Das echte Studio-Verzeichnis wird nur gelesen (Kopie per ditto).
"""
import argparse
import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import e2e_update as e  # noqa: E402

VERSION = "0.0.3"
ALTES_STUDIO_ECHT = Path.home() / "Library" / "Application Support" / "FLE Studio"


def attrappe(ziel):
    if ziel.exists():
        shutil.rmtree(ziel)
    dateien = {
        "settings.json": json.dumps({"theme": "dark", "hf_token": "hf_attrappe_geheim", "access_key": "", "attach_key": ""}),
        "hosts.json": json.dumps([{"id": "host-a", "token": "attrappe-token-123"}]),
        "plugins.json": '{"v": 1}',
        "chats/c1.json": '{"t": "hallo"}',
        "chats/files/a.txt": "anhang",
        "plugins/beispiel/settings.json": "{}",
        "logs/studio.log": "protokoll",
        "update-check.json": "{}",
        "update.log": "u",
        "models/gross.gguf": "xxxx",
        "engines/llama/bin": "x",
    }
    for rel, inhalt in dateien.items():
        p = ziel / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(inhalt, encoding="utf-8")
    os.chmod(ziel / "hosts.json", 0o600)
    return ziel


def baum(ordner):
    """Pfad -> (Inhalt, Rechte) aller Dateien; Vergleich vorher/nachher."""
    aus = {}
    for p in sorted(Path(ordner).rglob("*")):
        if p.is_file():
            aus[str(p.relative_to(ordner))] = (p.read_bytes(), stat.S_IMODE(p.stat().st_mode))
    return aus


def lauf(umg, app, daten, alt, *args):
    return umg.lauf(app, daten, "--uebernehmen-studio", *args, env_extra={"FYOS_SHELL_ALTES_STUDIO": str(alt)}, timeout=60)


def pruefe(umg, app):
    arbeit = umg.arbeit
    alt = attrappe(arbeit / "altes-studio")
    vorher = baum(alt)
    daten = arbeit / "daten" / "uebernahme"
    if daten.exists():
        shutil.rmtree(daten)
    daten.mkdir(parents=True)
    home = daten / "studio-home"

    print("U1 Probelauf")
    code, aus, err = lauf(umg, app, daten, alt, "--trocken")
    e.melde("U1", "Probelauf zeigt Anzahl, Größe und Ausgelassenes", code == 0 and aus and aus["trocken"] is True and aus["kopieren"] == 6 and aus["bytes"] > 0
            and {a["pfad"] for a in aus["ausgelassen"]} == {"logs", "update-check.json", "update.log", "models", "engines"}, json.dumps(aus) + err[-200:])
    e.melde("U1", "Probelauf schreibt nichts (kein studio-home, keine Marke), Quelle bytegleich", not home.exists() and not (daten / "uebernahme.json").exists() and baum(alt) == vorher)
    e.melde("U1", "Befund: Klartext-Geheimnisse in Studio-Dateien werden genannt, nie ihre Werte",
            len(aus["befunde"]) == 2 and "hf_attrappe_geheim" not in json.dumps(aus) and "attrappe-token-123" not in json.dumps(aus), json.dumps(aus["befunde"]))
    e.melde("U1", "Hinweis zu Modellen (Modellordner setzen)", any("Modellordner" in h for h in aus["hinweise"]))

    print("U2 echter Lauf")
    (daten / "einstellungen.json").write_text(json.dumps({"schema": 1}), encoding="utf-8")
    code, aus, err = lauf(umg, app, daten, alt)
    e.melde("U2", "Übernahme gelingt: 6 Dateien kopiert", code == 0 and aus and aus["ok"] and aus["kopiert"] == 6 and aus["fehlgeschlagen"] == [], json.dumps(aus) + err[-200:])
    gleich = all((home / rel).is_file() and (home / rel).read_bytes() == vorher[rel][0] for rel in ("settings.json", "hosts.json", "plugins.json", "chats/c1.json", "chats/files/a.txt", "plugins/beispiel/settings.json"))
    e.melde("U2", "kopierte Dateien sind inhaltsgleich", gleich)
    e.melde("U2", "Protokolle, Update-Zustand, Modelle und Engines wurden nicht kopiert",
            not any((home / n).exists() for n in ("logs", "update-check.json", "update.log", "models", "engines")))
    e.melde("U2", "hosts.json (Client-Token) bleibt nur für den Nutzer lesbar (0600)", stat.S_IMODE((home / "hosts.json").stat().st_mode) == 0o600)
    e.melde("U2", "die Marke uebernahme.json liegt im Datenordner (nicht im studio-home)", (daten / "uebernahme.json").is_file() and not (home / "uebernahme.json").exists())
    e.melde("U2", "Geheimnisse landen nicht in einstellungen.json der Hülle", "attrappe" not in (daten / "einstellungen.json").read_text() and "hf_" not in (daten / "einstellungen.json").read_text())
    e.melde("U2", "das alte Verzeichnis ist bytegleich und rechtegleich geblieben", baum(alt) == vorher)
    e.melde("U2", "keine Zwischendateien im Ziel", not [p for p in home.rglob("*") if p.name.endswith(".neu")])
    code, aus, _ = lauf(umg, app, daten, alt)
    e.melde("U2", "zweiter Lauf wird verweigert (UEBERNAHME_SCHON_ERFOLGT, Ausgang 2)", code == 2 and aus and aus["fehler"]["code"] == "UEBERNAHME_SCHON_ERFOLGT", json.dumps(aus))

    print("U3 Teilkollision")
    daten3 = arbeit / "daten" / "kollision"
    if daten3.exists():
        shutil.rmtree(daten3)
    (daten3 / "studio-home").mkdir(parents=True)
    (daten3 / "studio-home" / "settings.json").write_text("MEINE NEUEN EINSTELLUNGEN", encoding="utf-8")
    code, aus, err = lauf(umg, app, daten3, alt)
    e.melde("U3", "vorhandene Datei wird übersprungen und nie überschrieben", code == 0 and aus["kopiert"] == 5 and "settings.json" in aus["uebersprungen"]
            and (daten3 / "studio-home" / "settings.json").read_text() == "MEINE NEUEN EINSTELLUNGEN", json.dumps(aus) + err[-200:])
    e.melde("U3", "Quelle weiter bytegleich", baum(alt) == vorher)

    print("U4 fehlendes altes Verzeichnis")
    daten4 = arbeit / "daten" / "fehlt"
    if daten4.exists():
        shutil.rmtree(daten4)
    daten4.mkdir(parents=True)
    code, aus, _ = lauf(umg, app, daten4, arbeit / "gibt-es-nicht")
    f = (aus or {}).get("fehler", {})
    e.melde("U4", "Katalogfehler mit Ursache und Abhilfe, Ausgang 2, nichts angelegt",
            code == 2 and f.get("code") == "UEBERNAHME_QUELLE_FEHLT" and len(f.get("abhilfe", "")) > 20 and not (daten4 / "studio-home").exists(), json.dumps(aus))

    print("U5 echtes Verzeichnis dieses Macs")
    if not ALTES_STUDIO_ECHT.is_dir():
        print("  (kein echtes Studio-Verzeichnis auf diesem Mac, übersprungen)")
        return
    echt_vorher = baum(ALTES_STUDIO_ECHT)
    daten5 = arbeit / "daten" / "echt"
    if daten5.exists():
        shutil.rmtree(daten5)
    daten5.mkdir(parents=True)
    # ohne FYOS_SHELL_ALTES_STUDIO: die Hülle findet den Ort selbst (Standardpfad des Systems), liest nur
    code, aus, err = umg.lauf(app, daten5, "--uebernehmen-studio", "--trocken", timeout=60)
    e.melde("U5", "Hülle findet das echte Verzeichnis selbst und plant (Probelauf)", code == 0 and aus and aus["ort"] == str(ALTES_STUDIO_ECHT) and aus["trocken"] is True, json.dumps(aus)[:400] + err[-200:])
    e.melde("U5", "echtes Verzeichnis nach dem Probelauf bytegleich, Wegwerf-Ziel leer", baum(ALTES_STUDIO_ECHT) == echt_vorher and not (daten5 / "studio-home").exists())
    kopie = arbeit / "echt-kopie"
    if kopie.exists():
        shutil.rmtree(kopie)
    r = subprocess.run(["ditto", str(ALTES_STUDIO_ECHT), str(kopie)], capture_output=True, text=True)
    e.melde("U5", "Kopie des echten Verzeichnisses angelegt (ditto)", r.returncode == 0, r.stderr)
    code, aus, err = lauf(umg, app, daten5, kopie)
    erwartet = sum(1 for p in kopie.rglob("*") if p.is_file() and p.relative_to(kopie).parts[0] not in ("logs", "update-check.json", "update.log", "models", "engines") and not p.name.startswith("."))
    e.melde("U5", "echte Übernahme aus der Kopie: alle übernehmbaren Dateien kopiert", code == 0 and aus and aus["kopiert"] == erwartet and aus["fehlgeschlagen"] == [], f"erwartet {erwartet}: " + json.dumps(aus)[:400] + err[-200:])
    e.melde("U5", "echtes Verzeichnis dabei unverändert", baum(ALTES_STUDIO_ECHT) == echt_vorher)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--arbeit", default="/private/tmp/fyos-shell-d0-e2e/lauf-uebernahme")
    p.add_argument("--ohne-bau", action="store_true")
    a = p.parse_args()
    if sys.platform != "darwin":
        sys.exit("Dieses Skript läuft nur auf macOS.")
    arbeit = Path(a.arbeit)
    arbeit.mkdir(parents=True, exist_ok=True)
    key, _ = e.schluessel(arbeit)
    bauten = arbeit / "bauten"
    if not a.ohne_bau:
        e.bauen(VERSION, key, bauten)
    umg = e.Umgebung(arbeit, bauten / VERSION / f"{e.APPNAME}.app")
    app = umg.installieren("uebernahme")
    pruefe(umg, app)
    schlecht = [x for x in e.ERGEBNISSE if not x[2]]
    print(f"\n{len(e.ERGEBNISSE) - len(schlecht)} von {len(e.ERGEBNISSE)} Prüfungen bestanden.")
    for tor, name, _, detail in schlecht:
        print(f"FEHLER {tor} {name}: {detail}")
    sys.exit(1 if schlecht else 0)


if __name__ == "__main__":
    main()
