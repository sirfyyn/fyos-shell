#!/usr/bin/env python3
"""Ende-zu-Ende-Prüfung der Update-Schleife (Tore T2 bis T6 des Durchstichs D0), nur macOS, ohne Netz und ohne Konto.

Ablauf: Testschlüssel erzeugen (nie im Repository) · Version 0.0.1 und 0.0.2 bauen (Debug) · Pakete signieren und in
einen lokalen "Release-Ordner" legen · Test-Server starten · die Fälle durchlaufen:

  T2  Selbsttest, Einzelinstanz, sauberes Beenden des Begleiters
  T3  Update 0.0.1 -> 0.0.2: neue Version läuft, Einstellungen, Daten-Marke und Plugin-Ordner unverändert
  T4  Signatur: manipuliertes Paket, falsche Signatur, Manifest ohne Signatur: abgelehnt, alte Version bleibt
  T5  Rückweg: "zurück" auf die Vorversion, Neuinstallation findet die Daten, "zurück" ohne Vorversion
  T6  Fehlertexte: Manifest fehlt, Server weg, Begleiter startet nicht / endet sofort / antwortet nicht

Aufruf (aus apps/fyos-shell):  python3 tools/e2e_update.py [--arbeit ORDNER] [--ohne-bau]
Die App läuft mit FYOS_SHELL_DATEN in einem Wegwerf-Datenordner; echte Installationen und Einstellungen bleiben unberührt.
"""
import argparse
import hashlib
import json
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

WURZEL = Path(__file__).resolve().parent.parent
TOOLS = WURZEL / "tools"
TAURI = WURZEL / "node_modules" / ".bin" / "tauri"
APPNAME = "FLE Studio D0-Test"
PORT_UPDATE = 18700  # steht so im gebauten Paket (Update-Adresse)
PORT_STUDIO = 18642
ERGEBNISSE = []


def plattform():
    arch = {"arm64": "aarch64", "x86_64": "x86_64"}[platform.machine()]
    return f"darwin-{arch}"


def melde(tor, name, ok, detail=""):
    ERGEBNISSE.append((tor, name, ok, detail))
    print(f"  [{'ok' if ok else 'FEHLER'}] {tor} {name}" + (f" - {detail}" if detail and not ok else ""), flush=True)


def sha(pfad):
    h = hashlib.sha256()
    pfad = Path(pfad)
    if pfad.is_dir():
        for p in sorted(pfad.rglob("*")):
            if p.is_file():
                h.update(str(p.relative_to(pfad)).encode())
                h.update(p.read_bytes())
    else:
        h.update(pfad.read_bytes())
    return h.hexdigest()


def unterprozess(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def schluessel(arbeit):
    ordner = Path("/private/tmp/fyos-shell-d0-e2e/schluessel")  # bewusst außerhalb des Repositorys
    ordner.mkdir(parents=True, exist_ok=True)
    # je Profil ein eigenes Schlüsselpaar; der Schlüssel des Profils agent darf Studio nicht aktualisieren können
    for name in ("studio", "agent", "os"):
        key = ordner / f"{name}.key"
        if not key.exists():
            r = unterprozess([str(TAURI), "signer", "generate", "--ci", "-p", "", "-w", str(key)])
            if r.returncode != 0:
                sys.exit("Schlüsselerzeugung fehlgeschlagen: " + r.stderr)
    return ordner / "studio.key", ordner / "agent.key"


def bauen(version, key, ausgabe):
    ziel = ausgabe / version
    if ziel.exists():
        shutil.rmtree(ziel)
    ziel.mkdir(parents=True)
    r = subprocess.run([sys.executable, str(TOOLS / "bauen.py"), "studio", "--version", version, "--debug", "--bundles", "app",
                        "--update-schluessel", str(key), "--update-pubkey", str(key) + ".pub",
                        "--update-basis", f"http://127.0.0.1:{PORT_UPDATE}/", "--name", APPNAME])
    if r.returncode != 0:
        sys.exit(f"Bau {version} fehlgeschlagen")
    bundle = WURZEL / "target" / "debug" / "bundle" / "macos"
    shutil.copytree(bundle / f"{APPNAME}.app", ziel / f"{APPNAME}.app", symlinks=True)
    shutil.copy(bundle / f"{APPNAME}.app.tar.gz", ziel / "paket.app.tar.gz")
    shutil.copy(bundle / f"{APPNAME}.app.tar.gz.sig", ziel / "paket.app.tar.gz.sig")


def manifest(version, url, signatur):
    eintrag = {"url": url}
    if signatur is not None:
        eintrag["signature"] = signatur
    return {"version": version, "notes": f"Testversion {version}", "pub_date": "2026-10-27T12:00:00Z",
            "platforms": {plattform(): eintrag}}


def json_schreiben(pfad, inhalt):
    pfad.parent.mkdir(parents=True, exist_ok=True)
    pfad.write_text(json.dumps(inhalt), encoding="utf-8")


def release_ordner(arbeit, bauten, fremd_key):
    """Legt den Release-Ordner an: normale Manifeste und vier absichtlich fehlerhafte Wurzeln."""
    r = arbeit / "release"
    if r.exists():
        shutil.rmtree(r)
    basis = f"http://127.0.0.1:{PORT_UPDATE}"
    sig = {}
    for v in ("0.0.1", "0.0.2"):
        (r / "pakete" / v).mkdir(parents=True)
        shutil.copy(bauten / v / "paket.app.tar.gz", r / "pakete" / v / "paket.app.tar.gz")
        sig[v] = (bauten / v / "paket.app.tar.gz.sig").read_text().strip()
        json_schreiben(r / f"v{v}" / "latest.json", manifest(v, f"{basis}/pakete/{v}/paket.app.tar.gz", sig[v]))
    json_schreiben(r / "latest.json", manifest("0.0.2", f"{basis}/pakete/0.0.2/paket.app.tar.gz", sig["0.0.2"]))

    # f-paket: Paket mit einem verfälschten Byte, echte Signatur
    defekt = bytearray((bauten / "0.0.2" / "paket.app.tar.gz").read_bytes())
    defekt[len(defekt) // 2] ^= 0xFF
    (r / "f-paket" / "p").mkdir(parents=True)
    (r / "f-paket" / "p" / "paket.app.tar.gz").write_bytes(bytes(defekt))
    json_schreiben(r / "f-paket" / "latest.json", manifest("0.0.2", f"{basis}/f-paket/p/paket.app.tar.gz", sig["0.0.2"]))

    # f-sig: unverändertes Paket, aber mit dem Schlüssel eines Fremden signiert
    (r / "f-sig" / "p").mkdir(parents=True)
    fremdes_paket = r / "f-sig" / "p" / "paket.app.tar.gz"
    shutil.copy(bauten / "0.0.2" / "paket.app.tar.gz", fremdes_paket)
    s = unterprozess([str(TAURI), "signer", "sign", "-f", str(fremd_key), "-p", "", "--app-version", "0.0.2", str(fremdes_paket)])
    if s.returncode != 0:
        sys.exit("Fremdsignatur fehlgeschlagen: " + s.stderr)
    json_schreiben(r / "f-sig" / "latest.json",
                   manifest("0.0.2", f"{basis}/f-sig/p/paket.app.tar.gz", Path(str(fremdes_paket) + ".sig").read_text().strip()))

    # f-ohnesig: Manifest ohne Signatur
    json_schreiben(r / "f-ohnesig" / "latest.json", manifest("0.0.2", f"{basis}/pakete/0.0.2/paket.app.tar.gz", None))
    # f-leer: Ordner ohne latest.json
    (r / "f-leer").mkdir()

    # Rollback-Schutz: korrekt signierte Manifeste mit NIEDRIGERER bzw. GLEICHER Version als die installierte 0.0.2
    # (echtes Paket 0.0.1 mit seiner echten Signatur; alles gültig, nur die Version ist nicht neuer)
    json_schreiben(r / "f-niedriger" / "latest.json", manifest("0.0.1", f"{basis}/pakete/0.0.1/paket.app.tar.gz", sig["0.0.1"]))
    json_schreiben(r / "f-gleich" / "latest.json", manifest("0.0.2", f"{basis}/pakete/0.0.2/paket.app.tar.gz", sig["0.0.2"]))
    return r


def port_offen(port):
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def warten_bis(bedingung, sekunden):
    ende = time.time() + sekunden
    while time.time() < ende:
        if bedingung():
            return True
        time.sleep(0.2)
    return False


def studio_gesund():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT_STUDIO}/api/state", timeout=1) as a:
            return a.status == 200
    except Exception:
        return False


class Umgebung:
    def __init__(self, arbeit, app_quelle, echtes_studio=None):
        self.arbeit = arbeit
        self.app_quelle = app_quelle
        self.echtes_studio = echtes_studio  # venv mit installiertem fle-studio (bin/fle-studio) oder None
        self.zaehler = 0

    def installieren(self, name, quelle=None):
        ziel = self.arbeit / "inst" / name
        if ziel.exists():
            shutil.rmtree(ziel)
        ziel.mkdir(parents=True)
        shutil.copytree(quelle or self.app_quelle, ziel / f"{APPNAME}.app", symlinks=True)
        return ziel / f"{APPNAME}.app"

    def daten(self, name, update_basis=None, begleiter="ok"):
        d = self.arbeit / "daten" / name
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True)
        einst = {"schema": 1, "start_url": f"http://127.0.0.1:{PORT_STUDIO}/", "meine_eigene_einstellung": {"bleibt": [1, 2, 3]}}
        if update_basis:
            einst["update_basis"] = update_basis
        # Port und Kennung gibt die Hülle vor (Umgebung); fest eingestellt nur dort, wo der Test den Port kennen muss
        server = [sys.executable, str(TOOLS / "testserver.py"), "studio", "--version", "4.0.0-test"]
        programme = {
            "ok": {"programm": server[0], "args": server[1:], "env": {}, "frist_s": 15, "port": PORT_STUDIO},
            "auto": {"programm": server[0], "args": server[1:], "env": {}, "frist_s": 15},
            # Studio, das die Kennung nicht kennt (--kennung ""), hinter dem Shim, der sie bestätigt
            "shim": {"programm": sys.executable, "env": {}, "frist_s": 20,
                     "args": [str(TOOLS / "begleiter_shim.py"), "--port", "{port}", "--kennung", "{kennung}", "--",
                              *server, "--port", "{upstream}", "--kennung", ""]},
            # das ECHTE Python-Studio (fle-studio, nur Standardbibliothek) hinter dem Shim; Daten des Studios im Datenordner der Hülle
            "echt": ({"programm": sys.executable, "env": {}, "frist_s": 30,
                      "args": [str(TOOLS / "begleiter_shim.py"), "--port", "{port}", "--kennung", "{kennung}", "--",
                               str(Path(self.echtes_studio) / "bin" / "fle-studio"), "--port", "{upstream}", "--no-browser",
                               "--home", str(d / "studio-home")]} if self.echtes_studio else None),
            "fehlt": {"programm": "/gibt/es/nicht", "args": [], "env": {}, "frist_s": 5},
            "endet": {"programm": sys.executable, "args": ["-c", "raise SystemExit(3)"], "env": {}, "frist_s": 5},
            "stumm": {"programm": sys.executable, "args": ["-c", "import time; time.sleep(60)"], "env": {}, "frist_s": 2},
        }
        einst["begleiter"] = programme[begleiter]
        (d / "einstellungen.json").write_text(json.dumps(einst), encoding="utf-8")
        (d / "daten-marke.txt").write_text("meine Daten, ein Update fasst sie nicht an\n", encoding="utf-8")
        (d / "plugins" / "beispiel").mkdir(parents=True)
        (d / "plugins" / "beispiel" / "plugin.txt").write_text("Plugin-Ordner\n", encoding="utf-8")
        return d

    def lauf(self, app, daten, *args, timeout=120):
        exe = app / "Contents" / "MacOS" / "fyos-shell"
        env = dict(os.environ, FYOS_SHELL_DATEN=str(daten))
        r = subprocess.run([str(exe), *args], capture_output=True, text=True, env=env, timeout=timeout)
        zeilen = [z for z in r.stdout.splitlines() if z.startswith("{")]
        try:
            ausgabe = json.loads(zeilen[-1]) if zeilen else None
        except json.JSONDecodeError:
            ausgabe = None
        return r.returncode, ausgabe, r.stderr


def datenstand(d):
    return {n: sha(d / n) for n in ("einstellungen.json", "daten-marke.txt", "plugins")}


def pruefe_t2(umg):
    print("T2 Start, Selbsttest, Einzelinstanz")
    app = umg.installieren("t2")
    d = umg.daten("t2")
    code, aus, err = umg.lauf(app, d, "--selbsttest")
    ok = code == 0 and aus and aus["ok"]
    melde("T2", "Selbsttest (Begleiter startet, Seite zeichnet, Befehl antwortet)", ok, json.dumps(aus) + err[-300:])
    melde("T2", "Begleiter nach dem Selbsttest beendet", not port_offen(PORT_STUDIO))

    exe = app / "Contents" / "MacOS" / "fyos-shell"
    env = dict(os.environ, FYOS_SHELL_DATEN=str(d))
    erste = subprocess.Popen([str(exe), "--versteckt"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        melde("T2", "Fenstermodus: Begleiter wird gesund", warten_bis(studio_gesund, 25))
        t0 = time.time()
        zweite = subprocess.run([str(exe), "--versteckt"], env=env, capture_output=True, timeout=30)
        melde("T2", "zweiter Start endet sofort (Einzelinstanz)", zweite.returncode == 0 and time.time() - t0 < 10 and erste.poll() is None)
    finally:
        erste.send_signal(signal.SIGTERM)
        try:
            erste.wait(timeout=20)
        except subprocess.TimeoutExpired:
            erste.kill()
    melde("T2", "SIGTERM beendet die Hülle und den Begleiter sauber", warten_bis(lambda: not port_offen(PORT_STUDIO), 10))


def pruefe_t3_t5(umg):
    print("T3 Update 0.0.1 -> 0.0.2, T5 Rückweg")
    app = umg.installieren("t3")
    d = umg.daten("t3")
    vorher = datenstand(d)
    code, aus, _ = umg.lauf(app, d, "--info")
    melde("T3", "installiert ist 0.0.1", aus and aus["version"] == "0.0.1" and aus["vorherige"] is None)
    code, aus, err = umg.lauf(app, d, "--aktualisieren")
    melde("T3", "Update eingespielt (Ausgang 0, Version 0.0.2)", code == 0 and aus and aus.get("ergebnis") == "eingespielt" and aus.get("version") == "0.0.2", json.dumps(aus) + err[-300:])
    code, aus, _ = umg.lauf(app, d, "--info")
    melde("T3", "danach läuft 0.0.2, Vorversion 0.0.1 gemerkt", aus and aus["version"] == "0.0.2" and aus["vorherige"] == "0.0.1", json.dumps(aus))
    melde("T3", "Ergebnis des Updates wird gemeldet", aus and "Aktualisiert von Version 0.0.1 auf 0.0.2" in (aus.get("ausgang") or ""), json.dumps(aus))
    melde("T3", "Einstellungen, Daten-Marke und Plugin-Ordner unverändert", datenstand(d) == vorher)
    code, aus, _ = umg.lauf(app, d, "--selbsttest")
    melde("T3", "neue Version besteht den Selbsttest", code == 0 and aus and aus["ok"] and "0.0.2" in aus["schritte"][0]["text"], json.dumps(aus))
    code, aus, _ = umg.lauf(app, d, "--aktualisieren")
    melde("T3", "erneute Suche: nichts zu tun", code == 0 and aus and aus.get("ergebnis") == "nichts_zu_tun", json.dumps(aus))

    code, aus, err = umg.lauf(app, d, "--zurueck")
    melde("T5", "zurück auf 0.0.1 eingespielt", code == 0 and aus and aus.get("ergebnis") == "eingespielt" and aus.get("version") == "0.0.1", json.dumps(aus) + err[-300:])
    code, aus, _ = umg.lauf(app, d, "--info")
    melde("T5", "danach läuft 0.0.1, Vorversion 0.0.2, Rückweg gemeldet", aus and aus["version"] == "0.0.1" and aus["vorherige"] == "0.0.2" and (aus.get("ausgang") or "").startswith("Zurück"), json.dumps(aus))
    melde("T5", "Daten nach dem Rückweg unverändert", datenstand(d) == vorher)

    # Neuinstallation: Programm löschen, frisch kopieren, Daten sind noch da
    app2 = umg.installieren("t3")
    code, aus, _ = umg.lauf(app2, d, "--info")
    melde("T5", "Deinstallation und Neuinstallation finden die Daten", code == 0 and datenstand(d) == vorher and aus["vorherige"] == "0.0.2", json.dumps(aus))

    # ohne Vorversion
    d2 = umg.daten("t5-leer")
    code, aus, _ = umg.lauf(umg.installieren("t5"), d2, "--zurueck")
    melde("T5", "zurück ohne Vorversion nennt Ursache und Abhilfe",
          code == 2 and aus and aus["fehler"]["code"] == "RUECKWEG_KEINE_VORVERSION" and aus["fehler"]["abhilfe"], json.dumps(aus))


def pruefe_rollback_schutz(umg, bauten, log):
    """Der Updater nimmt von allein nie eine ältere oder gleiche Version, auch nicht bei gültiger Signatur (Standardvergleich
    "angebotene > installierte", kein Vergleich, der Abstiege erlaubt, außer beim bewussten Zurück-Weg mit der gemerkten Vorversion)."""
    print("T5 Rollback-Schutz")
    app = umg.installieren("schutz", quelle=bauten / "0.0.2" / f"{APPNAME}.app")
    programm = app / "Contents" / "MacOS" / "fyos-shell"
    vorher = sha(programm)
    for ordner, name in (("f-niedriger", "niedrigere Version (0.0.1 bei installierter 0.0.2)"), ("f-gleich", "gleiche Version (0.0.2)")):
        d = umg.daten(f"schutz-{ordner}", update_basis=f"http://127.0.0.1:{PORT_UPDATE}/{ordner}/")
        zeilen_vorher = len(log.read_text().splitlines())
        code, aus, err = umg.lauf(app, d, "--aktualisieren")
        neu = log.read_text().splitlines()[zeilen_vorher:]
        melde("T5", f"{name}, korrekt signiert: keine Aktualisierung (aktuell)",
              code == 0 and aus and aus.get("ergebnis") == "nichts_zu_tun" and aus.get("version") == "0.0.2", json.dumps(aus) + err[-200:])
        melde("T5", f"{name}: Server wurde gefragt, aber kein Paket geladen",
              any(z.endswith("/latest.json") for z in neu) and not any("/pakete/" in z for z in neu), "; ".join(neu))
        _, info, _ = umg.lauf(app, d, "--info")
        melde("T5", f"{name}: Programm unverändert, Version 0.0.2, keine Vorversion gemerkt",
              info and info["version"] == "0.0.2" and info["vorherige"] is None and sha(programm) == vorher, json.dumps(info))


def pruefe_echtes_studio(umg):
    """S-A: die Hülle mit dem echten Python-Studio (fle-studio) als Begleiter hinter dem Shim."""
    print("S-A Echtes Studio")
    app = umg.installieren("echt")
    d = umg.daten("echt", begleiter="echt")
    code, aus, err = umg.lauf(app, d, "--selbsttest", timeout=120)
    text = next((s["text"] for s in (aus or {}).get("schritte", []) if s["name"] == "begleiter"), "")
    melde("S-A", "echtes Studio startet hinter dem Shim, /api/state mit Kennung", code == 0 and "fle-studio" in text and "0.4." in text, text + err[-200:])
    melde("S-A", "nach dem Selbsttest läuft weder Shim noch Studio", warten_bis(lambda: subprocess.run(["pgrep", "-f", str(d / "studio-home")], capture_output=True).returncode != 0, 10))
    melde("S-A", "das Studio hat seine Daten im Datenordner der Hülle angelegt", any((d / "studio-home").iterdir()))

    # Update 0.0.1 -> 0.0.2 mit echtem Studio: Plugin-Ordner und Daten-Marke bleiben, das Studio startet danach wieder
    (d / "studio-home" / "plugins").mkdir(exist_ok=True)
    (d / "studio-home" / "plugins" / "beispiel-plugin.txt").write_text("Plugin des Studios\n", encoding="utf-8")
    vorher = {n: sha(d / n) for n in ("daten-marke.txt", "plugins")} | {"studio-plugins": sha(d / "studio-home" / "plugins")}
    code, aus, err = umg.lauf(app, d, "--aktualisieren")
    melde("S-A", "Update 0.0.1 -> 0.0.2 mit echtem Studio eingespielt", code == 0 and aus and aus.get("ergebnis") == "eingespielt", json.dumps(aus) + err[-200:])
    code, aus, err = umg.lauf(app, d, "--selbsttest", timeout=120)
    text = next((s["text"] for s in (aus or {}).get("schritte", []) if s["name"] == "begleiter"), "")
    melde("S-A", "nach dem Update läuft 0.0.2 und das echte Studio startet wieder", code == 0 and "0.0.2" in aus["schritte"][0]["text"] and "0.4." in text, json.dumps(aus) + err[-200:])
    nachher = {n: sha(d / n) for n in ("daten-marke.txt", "plugins")} | {"studio-plugins": sha(d / "studio-home" / "plugins")}
    melde("S-A", "Plugin-Ordner des Studios, Hüllen-Plugins und Daten-Marke unverändert", vorher == nachher)
    code, aus, _ = umg.lauf(app, d, "--zurueck", timeout=120)
    melde("S-A", "zurück auf 0.0.1 mit echtem Studio, Daten bleiben", code == 0 and aus and aus.get("version") == "0.0.1" and (d / "studio-home" / "plugins" / "beispiel-plugin.txt").is_file(), json.dumps(aus))


def pruefe_fehler(umg):
    print("T4 Signatur, T6 Fehlertexte")
    faelle = [
        ("T4", "manipuliertes Paket", "f-paket", "UPDATE_SIGNATUR_FALSCH"),
        ("T4", "Signatur eines Fremden", "f-sig", "UPDATE_SIGNATUR_FALSCH"),
        ("T4", "Manifest ohne Signatur", "f-ohnesig", "UPDATE_MANIFEST_UNLESBAR"),
        ("T6", "Manifest fehlt", "f-leer", "UPDATE_MANIFEST_FEHLT"),
    ]
    app = umg.installieren("fehler")
    vorher_programm = sha(app / "Contents" / "MacOS" / "fyos-shell")
    for tor, name, ordner, erwartet in faelle:
        d = umg.daten(f"fehler-{ordner}", update_basis=f"http://127.0.0.1:{PORT_UPDATE}/{ordner}/")
        code, aus, err = umg.lauf(app, d, "--aktualisieren")
        f = (aus or {}).get("fehler") or {}
        ok = code == 2 and f.get("code") == erwartet and f.get("ursache") and f.get("abhilfe")
        melde(tor, f"{name}: {erwartet} mit Ursache und Abhilfe", ok, json.dumps(aus) + err[-200:])
        _, info, _ = umg.lauf(app, d, "--info")
        melde(tor, f"{name}: installierte Version läuft unverändert weiter",
              info and info["version"] == "0.0.1" and sha(app / "Contents" / "MacOS" / "fyos-shell") == vorher_programm)

    # Server nicht erreichbar: Port, auf dem niemand lauscht
    d = umg.daten("fehler-weg", update_basis="http://127.0.0.1:9/")
    code, aus, _ = umg.lauf(app, d, "--aktualisieren")
    f = (aus or {}).get("fehler") or {}
    melde("T6", "Server nicht erreichbar: SERVER_NICHT_ERREICHBAR mit Abhilfe", code == 2 and f.get("code") == "SERVER_NICHT_ERREICHBAR" and f.get("abhilfe"), json.dumps(aus))

    # Port belegt von einem fremden Server (ohne Kennung): darf nicht als gesund gelten
    fremder = subprocess.Popen([sys.executable, str(TOOLS / "testserver.py"), "studio", "--port", str(PORT_STUDIO), "--version", "alt"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        warten_bis(studio_gesund, 10)
        d = umg.daten("begleiter-fremd", begleiter="ok")
        code, aus, _ = umg.lauf(app, d, "--selbsttest", timeout=90)
        text = next((s["text"] for s in (aus or {}).get("schritte", []) if s["name"] == "begleiter"), "")
        melde("T6", "fremder Server auf dem Port: PORT_BELEGT, nicht als gesund gemeldet", code == 3 and "PORT_BELEGT" in text and "Abhilfe:" in text, text)
    finally:
        fremder.terminate()
        fremder.wait(timeout=10)

    # ohne festen Port: die Hülle sucht einen freien, der Begleiter bestätigt die Kennung
    d = umg.daten("begleiter-auto", begleiter="auto")
    code, aus, _ = umg.lauf(app, d, "--selbsttest", timeout=90)
    text = next((s["text"] for s in (aus or {}).get("schritte", []) if s["name"] == "begleiter"), "")
    melde("T6", "freier Port gewählt, Kennung bestätigt", code == 0 and "läuft (http://127.0.0.1:" in text and f":{PORT_STUDIO}/" not in text, text)

    # Studio ohne Kennung hinter dem Shim: gesund, und nach dem Beenden bleibt nichts zurück
    d = umg.daten("begleiter-shim", begleiter="shim")
    code, aus, _ = umg.lauf(app, d, "--selbsttest", timeout=90)
    text = next((s["text"] for s in (aus or {}).get("schritte", []) if s["name"] == "begleiter"), "")
    melde("T6", "Studio ohne Kennung hinter dem Shim wird gesund", code == 0 and "4.0.0-test" in text, text)
    time.sleep(1)
    melde("T6", "Shim: nach dem Selbsttest läuft kein Shim und kein Studio mehr", subprocess.run(["pgrep", "-f", "begleiter_shim.py"], capture_output=True).returncode != 0)

    for art, erwartet in (("fehlt", "BEGLEITER_STARTET_NICHT"), ("endet", "BEGLEITER_BEENDET"), ("stumm", "BEGLEITER_ANTWORTET_NICHT")):
        d = umg.daten(f"begleiter-{art}", begleiter=art)
        code, aus, _ = umg.lauf(app, d, "--selbsttest", timeout=90)
        text = next((s["text"] for s in (aus or {}).get("schritte", []) if s["name"] == "begleiter"), "")
        melde("T6", f"Begleiter {art}: {erwartet} mit Abhilfe im Selbsttest", code == 3 and erwartet in text and "Abhilfe:" in text, text)
        melde("T6", f"Begleiter {art}: kein Prozess bleibt zurück", not port_offen(PORT_STUDIO))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--arbeit", default="/private/tmp/fyos-shell-d0-e2e/lauf")
    p.add_argument("--ohne-bau", action="store_true", help="vorhandene Bauten aus dem Arbeitsordner wiederverwenden")
    p.add_argument("--echtes-studio", help="venv mit installiertem fle-studio (uv venv + uv pip install 'fle-studio @ git+https://github.com/sirfyyn/fle-studio@v0.4.1'); schaltet die Prüfungen mit dem echten Studio ein")
    a = p.parse_args()
    if sys.platform != "darwin":
        sys.exit("Dieses Skript läuft nur auf macOS (Linux: siehe README, Abschnitt Linux).")
    arbeit = Path(a.arbeit)
    arbeit.mkdir(parents=True, exist_ok=True)
    key, fremd = schluessel(arbeit)
    bauten = arbeit / "bauten"
    if not a.ohne_bau:
        for v in ("0.0.1", "0.0.2"):
            bauen(v, key, bauten)
    release = release_ordner(arbeit, bauten, fremd)
    log = arbeit / "anfragen.log"
    log.write_text("")
    server = subprocess.Popen([sys.executable, str(TOOLS / "testserver.py"), "update", "--wurzel", str(release), "--port", str(PORT_UPDATE), "--log", str(log)],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not warten_bis(lambda: port_offen(PORT_UPDATE), 10):
            sys.exit("Test-Server startet nicht")
        umg = Umgebung(arbeit, bauten / "0.0.1" / f"{APPNAME}.app", a.echtes_studio)
        pruefe_t2(umg)
        pruefe_t3_t5(umg)
        pruefe_rollback_schutz(umg, bauten, log)
        pruefe_fehler(umg)
        if umg.echtes_studio:
            pruefe_echtes_studio(umg)
    finally:
        server.terminate()
        server.wait(timeout=10)
    schlecht = [e for e in ERGEBNISSE if not e[2]]
    print(f"\n{len(ERGEBNISSE) - len(schlecht)} von {len(ERGEBNISSE)} Prüfungen bestanden.")
    for tor, name, _, detail in schlecht:
        print(f"FEHLER {tor} {name}: {detail}")
    sys.exit(1 if schlecht else 0)


if __name__ == "__main__":
    main()
