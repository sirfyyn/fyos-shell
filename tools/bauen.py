#!/usr/bin/env python3
"""Baut die Hülle für ein Profil mit der lokalen Tauri-CLI (node_modules, kein globales Werkzeug).

Release für ein Profil, Schlüssel aus dem macOS-Schlüsselbund (nach tools/schluessel_erzeugen.sh):
  python3 tools/bauen.py studio --schluesselbund

Test mit eigenem Schlüssel und lokalem Test-Server (Debug-Bau, http erlaubt):
  python3 tools/bauen.py studio --version 0.0.1 --debug --bundles app \
      --update-schluessel /pfad/zum/schluessel --update-pubkey /pfad/zum/schluessel.pub \
      --update-basis http://127.0.0.1:18700/ --name "FLE Studio D0-Test"

Die Update-Adresse steht je Profil in app/profile/<profil>.conf.json (https://fyos.sirfyyn.de/update/<profil>/latest.json),
der öffentliche Schlüssel in app/profile/<profil>.pub (von schluessel_erzeugen.sh). Ohne Schlüssel entsteht ein Paket ohne
Update-Fähigkeit (die Hülle meldet dann UPDATE_NICHT_EINGERICHTET). Private Schlüssel kommen nie aus dem Repository.
Ausgabe: der Ordner mit den Paketen wird auf stdout gedruckt (letzte Zeile).
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

WURZEL = Path(__file__).resolve().parent.parent
APP = WURZEL / "app"
PROFILE = ("studio", "agent", "os")
DIENST = "fyos-shell-update-{profil}"  # Name des Schlüsselbund-Eintrags (Konten: schluessel, passwort)


def aus_schluesselbund(profil, konto):
    r = subprocess.run(["security", "find-generic-password", "-s", DIENST.format(profil=profil), "-a", konto, "-w"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"Im Schlüsselbund fehlt der Eintrag {DIENST.format(profil=profil)} ({konto}). "
                 "Abhilfe: tools/schluessel_erzeugen.sh ausführen (einmalig, durch den Schlüsselverantwortlichen).")
    return r.stdout.rstrip("\n")


def overlay(a):
    conf = {}
    if a.version:
        conf["version"] = a.version
    if a.name:
        conf["productName"] = a.name
    if a.kennung_zusatz:
        basis = json.loads((APP / "profile" / f"{a.profil}.conf.json").read_text(encoding="utf-8"))["identifier"]
        conf["identifier"] = f"{basis}.{a.kennung_zusatz}"
    updater = {}
    if a.update_basis:
        updater["endpoints"] = [a.update_basis.rstrip("/") + "/latest.json"]
    pubkey_datei = Path(a.update_pubkey) if a.update_pubkey else APP / "profile" / f"{a.profil}.pub"
    if pubkey_datei.exists():
        updater["pubkey"] = pubkey_datei.read_text(encoding="utf-8").strip()
    elif a.signiert:
        sys.exit(f"Der öffentliche Schlüssel fehlt: {pubkey_datei}. Abhilfe: tools/schluessel_erzeugen.sh oder --update-pubkey.")
    if a.signiert:
        conf["bundle"] = {"createUpdaterArtifacts": True}
    if a.mit_python:
        # Interpreter, Studio und Shim (von buendel_bauen.py nach app/resources gebaut) kommen als Ressourcen ins Paket
        conf.setdefault("bundle", {})["resources"] = {
            "resources/python/": "python/", "resources/studio/": "studio/", "resources/shim/": "shim/", "resources/buendel.json": "buendel.json"}
    if updater:
        conf["plugins"] = {"updater": updater}
    if a.meldungen_test_ursprung:
        # Nur Prüfbauten: Der Testserver (http, eigener Rechner) darf den Meldungsbefehl wie der echte Server aufrufen (inline Capability).
        profil = json.loads((APP / "profile" / f"{a.profil}.conf.json").read_text(encoding="utf-8"))
        liste = list(profil.get("app", {}).get("security", {}).get("capabilities", ["haupt", "inhalt"]))
        liste.append({"identifier": "os-meldungen-test", "windows": ["inhalt"], "local": False,
                      "remote": {"urls": [a.meldungen_test_ursprung.rstrip("/") + "/*"]}, "permissions": ["allow-os-benachrichtigen"]})
        conf["app"] = {"security": {"capabilities": liste}}
    return conf


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("profil", choices=PROFILE)
    p.add_argument("--version", help="überschreibt die Version der Konfiguration (Tests)")
    p.add_argument("--name", help="überschreibt den Produktnamen (Tests, damit nichts mit einer echten Installation verwechselt wird)")
    p.add_argument("--debug", action="store_true", help="Debug-Bau (schnell); ohne: Release")
    p.add_argument("--bundles", default=None, help="app, dmg (macOS) · appimage, deb (Linux) · nsis, msi (Windows)")
    p.add_argument("--kennung-zusatz", help="hängt der Bundle-Id einen Zusatz an (<id>.<zusatz>): Test-Bau, der nicht mit einer installierten App kollidiert (Einzelinstanz, Daten, Tresor)")
    p.add_argument("--mit-python", action="store_true", help="Python-Bündel mit dem Studio-Server bauen (tools/buendel_bauen.py) und ins Paket legen; nur Profil studio")
    p.add_argument("--ohne-paket", action="store_true", help="nur das Programm bauen, kein Installationspaket (für den Selbsttest im CI)")
    p.add_argument("--schluesselbund", action="store_true", help="privaten Update-Schlüssel und Passwort dieses Profils aus dem macOS-Schlüsselbund holen")
    p.add_argument("--update-schluessel", help="Pfad (oder Inhalt) des privaten Update-Schlüssels; sonst Umgebung TAURI_SIGNING_PRIVATE_KEY")
    p.add_argument("--update-pubkey", help="öffentlicher Schlüssel (.pub); Vorgabe app/profile/<profil>.pub")
    p.add_argument("--meldungen-test-ursprung", help="nur Prüfbauten: erlaubt dem Server mit diesem Ursprung (z. B. http://127.0.0.1:18661) den Meldungsbefehl zusätzlich zur Server-Adresse des Profils")
    p.add_argument("--update-basis", help="überschreibt die Basisadresse der Manifeste (Tests), z. B. http://127.0.0.1:18700/")
    a = p.parse_args()

    tauri = WURZEL / "node_modules" / ".bin" / ("tauri.cmd" if sys.platform == "win32" else "tauri")
    if not tauri.exists():
        sys.exit("Die lokale Tauri-CLI fehlt. Abhilfe: im Ordner apps/fyos-shell einmal 'npm install' ausführen.")

    if a.mit_python:
        if a.profil != "studio":
            sys.exit("--mit-python gibt es nur für das Profil studio (nur dieses hat einen Begleiter).")
        import buendel_bauen
        if buendel_bauen.main([]) != 0:
            sys.exit("Das Python-Bündel konnte nicht gebaut werden (Meldung oben).")
    env = dict(os.environ)
    if a.schluesselbund:
        env["TAURI_SIGNING_PRIVATE_KEY"] = aus_schluesselbund(a.profil, "schluessel")
        env["TAURI_SIGNING_PRIVATE_KEY_PASSWORD"] = aus_schluesselbund(a.profil, "passwort")
    elif a.update_schluessel:
        env["TAURI_SIGNING_PRIVATE_KEY"] = a.update_schluessel  # Pfad oder Inhalt; der Bau akzeptiert beides
        env.setdefault("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "")
    a.signiert = bool(env.get("TAURI_SIGNING_PRIVATE_KEY"))

    bundles = a.bundles or {"darwin": "app", "linux": "appimage", "win32": "nsis"}[sys.platform]
    env.setdefault("CARGO_BUILD_JOBS", "2")

    with tempfile.TemporaryDirectory() as tmp:
        zusatz = Path(tmp) / "bau.conf.json"
        zusatz.write_text(json.dumps(overlay(a)), encoding="utf-8")
        paket = ["--no-bundle"] if a.ohne_paket else ["--bundles", bundles]
        cmd = [str(tauri), "build", "--ci", *paket,
               "--config", str(APP / "profile" / f"{a.profil}.conf.json"), "--config", str(zusatz)]
        if a.debug:
            cmd.append("--debug")
        r = subprocess.run(cmd, cwd=APP, env=env)
        if r.returncode != 0:
            sys.exit(r.returncode)
    ziel = Path(env.get("CARGO_TARGET_DIR") or WURZEL / "target")
    print(ziel / ("debug" if a.debug else "release") / "bundle")


if __name__ == "__main__":
    main()
