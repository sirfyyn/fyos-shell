#!/usr/bin/env python3
"""Linux-Bau und Prüfungen der Hülle im Container (aufgerufen von docker/bauen-linux.sh, auf einem Linux-Rechner mit Docker).

  linux_pruefen.py bauen [profil]   AppImage (Debug, Version 0.0.1) mit einem Testschlüssel bauen
  linux_pruefen.py pruefen          --info und --selbsttest unter Xvfb, mit und ohne WEBKIT_DISABLE_DMABUF_RENDERER=1
  linux_pruefen.py schleife         Update-Schleife als AppImage: 0.0.1 -> 0.0.2, Rückweg, Daten bleiben, Signaturfehler,
                                    Rollback-Schutz (baut beide Versionen, startet den Test-Server im Container)
  linux_pruefen.py pixel            Fenster unter Xvfb sichtbar öffnen, Abzug über Xvfb -fbdir, Pixelprobe (tools/pixelprobe.py)
  linux_pruefen.py tresor           ohne Secret-Service-Dienst: Verweis {tresor:NAME} gibt TRESOR_NICHT_VERFUEGBAR mit Abhilfe (kein stilles Ausweichen)

Alles läuft ohne GPU und ohne echten Bildschirm (Xvfb, Mesa-Software). Der Selbsttest beweist: WebKitGTK startet, die lokale Seite
wird geladen, JavaScript läuft, der Rust-Befehl antwortet; die Pixelprobe beweist zusätzlich, dass im Fenster etwas zu sehen ist
(ein weißes oder einfarbiges Fenster fällt durch). Das **Weißbild mit NVIDIA** kann beides nicht beweisen: dafür bräuchte es die echte
GPU, die hier ausdrücklich nicht benutzt wird.
"""
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

WURZEL = Path(__file__).resolve().parent.parent
TOOLS = WURZEL / "tools"
ZIEL = Path(os.environ.get("CARGO_TARGET_DIR", WURZEL / "target"))
SCHLUESSEL = WURZEL / "testschluessel"
LAUF = WURZEL / "lauf-linux"
NAME = "FLE Studio D0-Linux"
PORT_UPDATE = 18700
UPDATE_BASIS = f"http://127.0.0.1:{PORT_UPDATE}/"
ERGEBNISSE = []


def lauf(cmd, **kw):
    print("+", " ".join(str(c) for c in cmd), flush=True)
    return subprocess.run([str(c) for c in cmd], **kw)


def melde(name, ok, detail=""):
    ERGEBNISSE.append((name, ok))
    print(f"  [{'ok' if ok else 'FEHLER'}] {name}" + (f" - {detail}" if detail and not ok else ""), flush=True)


def schluessel(name):
    SCHLUESSEL.mkdir(exist_ok=True)
    key = SCHLUESSEL / f"{name}.key"
    if not key.exists():
        r = lauf([WURZEL / "node_modules" / ".bin" / "tauri", "signer", "generate", "--ci", "-p", "", "-w", key])
        if r.returncode != 0:
            sys.exit("Testschlüssel konnte nicht erzeugt werden")
    return key


def bauen_version(profil, version, key):
    r = lauf([sys.executable, TOOLS / "bauen.py", profil, "--version", version, "--debug", "--bundles", "appimage",
              "--update-schluessel", key, "--update-pubkey", str(key) + ".pub", "--update-basis", UPDATE_BASIS, "--name", NAME])
    if r.returncode != 0:
        sys.exit(r.returncode)


def bauen(profil):
    bauen_version(profil, "0.0.1", schluessel(profil))
    sys.exit(0)


def appimage():
    gefunden = sorted((ZIEL / "debug" / "bundle" / "appimage").glob("*.AppImage"))
    if not gefunden:
        sys.exit("Kein AppImage gefunden. Abhilfe: erst 'bauen'.")
    return gefunden[0]


def daten(name, update_basis=None, begleiter_env=None):
    d = WURZEL / "daten-linux" / name
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True)
    # Begleiter: der Test-Server, Port und Kennung bestimmt die Hülle
    einst = {"schema": 1, "meine_eigene_einstellung": {"bleibt": [1, 2, 3]},
             "begleiter": {"programm": sys.executable, "frist_s": 20, "env": {},
                           "args": [str(TOOLS / "testserver.py"), "studio", "--version", "4.0.0-test"]}}
    if begleiter_env:
        einst["begleiter"]["env"] = begleiter_env
    if update_basis:
        einst["update_basis"] = update_basis
    (d / "einstellungen.json").write_text(json.dumps(einst), encoding="utf-8")
    (d / "daten-marke.txt").write_text("meine Daten, ein Update fasst sie nicht an\n", encoding="utf-8")
    (d / "plugins" / "beispiel").mkdir(parents=True)
    (d / "plugins" / "beispiel" / "plugin.txt").write_text("Plugin-Ordner\n", encoding="utf-8")
    return d


def unter_xvfb(app, d, modus, zusatz_env):
    env = dict(os.environ, FYOS_SHELL_DATEN=str(d), CUDA_VISIBLE_DEVICES="", **zusatz_env)
    modi = [modus] if isinstance(modus, str) else list(modus)
    cmd = ["xvfb-run", "-a", "-s", "-screen 0 1280x800x24", "dbus-run-session", "--", app, *modi]
    r = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, env=env, timeout=180)
    zeilen = [z for z in r.stdout.splitlines() if z.startswith("{")]
    return r.returncode, (json.loads(zeilen[-1]) if zeilen else None), r.stderr[-600:]


def pruefen():
    app = appimage()
    print(f"AppImage: {app} ({app.stat().st_size / 1048576:.1f} MiB)")
    ergebnis = 0
    for name, env in (("normal", {}), ("ohne_dmabuf", {"WEBKIT_DISABLE_DMABUF_RENDERER": "1"})):
        for modus in ("--info", "--selbsttest"):
            code, aus, err = unter_xvfb(app, daten(name), modus, env)
            ok = code == 0 and aus is not None
            ergebnis |= 0 if ok else 1
            print(f"[{'ok' if ok else 'FEHLER'}] {name} {modus}: Ausgang {code}")
            print("   ", json.dumps(aus, ensure_ascii=False) if aus else err)
    sys.exit(ergebnis)


# ---------------------------------------------------------------- Update-Schleife als AppImage

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


def json_schreiben(pfad, inhalt):
    pfad.parent.mkdir(parents=True, exist_ok=True)
    pfad.write_text(json.dumps(inhalt), encoding="utf-8")


def manifest(version, url, signatur):
    return {"version": version, "notes": f"Testversion {version}", "pub_date": "2026-10-28T12:00:00Z",
            "platforms": {"linux-x86_64": {"url": url, "signature": signatur}}}


def release_anlegen(bauten):
    r = LAUF / "release"
    if r.exists():
        shutil.rmtree(r)
    sig = {}
    for v in ("0.0.1", "0.0.2"):
        (r / "pakete" / v).mkdir(parents=True)
        shutil.copy(bauten / v / "paket.AppImage", r / "pakete" / v / "paket.AppImage")
        sig[v] = (bauten / v / "paket.AppImage.sig").read_text().strip()
        json_schreiben(r / f"v{v}" / "latest.json", manifest(v, f"{UPDATE_BASIS}pakete/{v}/paket.AppImage", sig[v]))
    json_schreiben(r / "latest.json", manifest("0.0.2", f"{UPDATE_BASIS}pakete/0.0.2/paket.AppImage", sig["0.0.2"]))
    # manipuliertes Paket (ein Byte verändert), echte Signatur
    defekt = bytearray((bauten / "0.0.2" / "paket.AppImage").read_bytes())
    defekt[len(defekt) // 2] ^= 0xFF
    (r / "f-paket" / "p").mkdir(parents=True)
    (r / "f-paket" / "p" / "paket.AppImage").write_bytes(bytes(defekt))
    json_schreiben(r / "f-paket" / "latest.json", manifest("0.0.2", f"{UPDATE_BASIS}f-paket/p/paket.AppImage", sig["0.0.2"]))
    # Rollback-Schutz: gültig signiertes Manifest mit niedrigerer Version als die installierte 0.0.2
    json_schreiben(r / "f-niedriger" / "latest.json", manifest("0.0.1", f"{UPDATE_BASIS}pakete/0.0.1/paket.AppImage", sig["0.0.1"]))
    return r


def schleife():
    key = schluessel("studio")
    bauten = LAUF / "bauten"
    for v in ("0.0.1", "0.0.2"):
        bauen_version("studio", v, key)
        ziel = bauten / v
        if ziel.exists():
            shutil.rmtree(ziel)
        ziel.mkdir(parents=True)
        quelle = appimage()
        shutil.copy(quelle, ziel / "paket.AppImage")
        shutil.copy(str(quelle) + ".sig", ziel / "paket.AppImage.sig")
    release = release_anlegen(bauten)
    log = LAUF / "anfragen.log"
    log.write_text("")
    server = subprocess.Popen([sys.executable, TOOLS / "testserver.py", "update", "--wurzel", release, "--port", str(PORT_UPDATE), "--log", log],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1)
        inst = LAUF / "inst"
        if inst.exists():
            shutil.rmtree(inst)
        inst.mkdir(parents=True)
        app = inst / "FYOS-Studio.AppImage"
        shutil.copy(bauten / "0.0.1" / "paket.AppImage", app)
        app.chmod(0o755)
        d = daten("schleife")
        vorher = {n: sha(d / n) for n in ("einstellungen.json", "daten-marke.txt", "plugins")}

        def lauf_app(*modi, daten_ordner=None):
            return unter_xvfb(app, daten_ordner or d, list(modi), {})

        print("T3/T5 Update-Schleife als AppImage (Linux x64, Xvfb)")
        code, aus, err = lauf_app("--info")
        melde("installiert ist 0.0.1", code == 0 and aus and aus["version"] == "0.0.1", json.dumps(aus) + err)
        # manipuliertes Paket, solange noch 0.0.1 installiert ist (sonst gäbe es ohnehin nichts zu aktualisieren)
        vor_roh = sha(app)
        d3 = daten("manipuliert", update_basis=f"{UPDATE_BASIS}f-paket/")
        code, aus, err = lauf_app("--aktualisieren", daten_ordner=d3)
        melde("manipuliertes Paket: UPDATE_SIGNATUR_FALSCH, Programm unverändert",
              code == 2 and aus and (aus.get("fehler") or {}).get("code") == "UPDATE_SIGNATUR_FALSCH" and sha(app) == vor_roh, json.dumps(aus) + err)

        code, aus, err = lauf_app("--aktualisieren")
        melde("Update eingespielt (0.0.1 -> 0.0.2)", code == 0 and aus and aus.get("ergebnis") == "eingespielt" and aus.get("version") == "0.0.2", json.dumps(aus) + err)
        code, aus, err = lauf_app("--info")
        melde("danach läuft 0.0.2, Vorversion 0.0.1, Ergebnis gemeldet",
              aus and aus["version"] == "0.0.2" and aus["vorherige"] == "0.0.1" and "Aktualisiert von Version 0.0.1 auf 0.0.2" in (aus.get("ausgang") or ""), json.dumps(aus) + err)
        melde("Einstellungen, Daten-Marke und Plugin-Ordner unverändert", {n: sha(d / n) for n in vorher} == vorher)
        code, aus, err = lauf_app("--selbsttest")
        melde("neue Version besteht den Selbsttest", code == 0 and aus and aus["ok"], json.dumps(aus) + err)
        code, aus, err = lauf_app("--aktualisieren")
        melde("erneute Suche: nichts zu tun", code == 0 and aus and aus.get("ergebnis") == "nichts_zu_tun", json.dumps(aus) + err)

        # Rollback-Schutz bei installierter 0.0.2
        d2 = daten("schutz", update_basis=f"{UPDATE_BASIS}f-niedriger/")
        vor_programm = sha(app)
        zeilen = len(log.read_text().splitlines())
        code, aus, err = lauf_app("--aktualisieren", daten_ordner=d2)
        neu = log.read_text().splitlines()[zeilen:]
        melde("Rollback-Schutz: niedrigere, gültig signierte Version wird nicht installiert",
              code == 0 and aus and aus.get("ergebnis") == "nichts_zu_tun" and not any("/pakete/" in z for z in neu) and sha(app) == vor_programm, json.dumps(aus) + err + "; ".join(neu))

        # Rückweg
        code, aus, err = lauf_app("--zurueck")
        melde("zurück auf 0.0.1 eingespielt", code == 0 and aus and aus.get("ergebnis") == "eingespielt" and aus.get("version") == "0.0.1", json.dumps(aus) + err)
        code, aus, err = lauf_app("--info")
        melde("danach läuft 0.0.1, Vorversion 0.0.2, Daten unverändert",
              aus and aus["version"] == "0.0.1" and aus["vorherige"] == "0.0.2" and {n: sha(d / n) for n in vorher} == vorher, json.dumps(aus) + err)
    finally:
        server.terminate()
        server.wait(timeout=10)
    schlecht = [n for n, ok in ERGEBNISSE if not ok]
    print(f"\n{len(ERGEBNISSE) - len(schlecht)} von {len(ERGEBNISSE)} Prüfungen bestanden.")
    sys.exit(1 if schlecht else 0)


# ---------------------------------------------------------------- Pixelprobe

def fenster_id(anzeige, titel, sekunden=60):
    ende = time.time() + sekunden
    while time.time() < ende:
        r = subprocess.run(["xwininfo", "-display", anzeige, "-root", "-tree"], capture_output=True, text=True)
        for zeile in r.stdout.splitlines():
            # Beispiel:  0x400003 "FLE Studio D0-Linux": ("fyos-shell" "FYOS Shell")  760x720+0+0  +12+34
            m = re.match(r"^\s+(0x[0-9a-f]+) \"([^\"]*)\".*?\s(\d+)x(\d+)\+-?\d+\+-?\d+\s+\+(-?\d+)\+(-?\d+)", zeile)
            if m and titel in m.group(2) and int(m.group(3)) > 100 and int(m.group(4)) > 100:
                return m.group(1), int(m.group(5)), int(m.group(6)), int(m.group(3)), int(m.group(4))
        time.sleep(1)
    return None


def tresor():
    """Im Container läuft kein Secret-Service-Dienst (nur ein leerer D-Bus-Sitzungsbus). Verweist die Einstellung auf ein Geheimnis, muss
    der Start mit dem Katalogfehler TRESOR_NICHT_VERFUEGBAR und einer Abhilfe scheitern, und nichts darf unbemerkt auf eine Datei ausweichen."""
    app = appimage()
    d = daten("tresor", begleiter_env={"HF_TOKEN": "{tresor:hf-token}"})
    code, aus, err = unter_xvfb(app, d, "--selbsttest", {})
    text = next((s["text"] for s in (aus or {}).get("schritte", []) if s["name"] == "begleiter"), "")
    melde("ohne Secret Service: TRESOR_NICHT_VERFUEGBAR mit Abhilfe, Selbsttest meldet den Fehler",
          code == 3 and "TRESOR_NICHT_VERFUEGBAR" in text and "Abhilfe:" in text, json.dumps(aus) + err)
    melde("kein Begleiter wurde ohne das Geheimnis gestartet", not (d / "begleiter.log").exists() or "hf-token" not in (d / "begleiter.log").read_text())
    melde("das Geheimnis steht nirgends in einer Datei der Einstellungen", "geheim" not in (d / "einstellungen.json").read_text().lower() or "{tresor:hf-token}" in (d / "einstellungen.json").read_text())
    schlecht = [n for n, ok in ERGEBNISSE if not ok]
    print(f"{len(ERGEBNISSE) - len(schlecht)} von {len(ERGEBNISSE)} Prüfungen bestanden.")
    sys.exit(1 if schlecht else 0)


def pixel():
    app = appimage()
    sys.path.insert(0, str(TOOLS))
    import pixelprobe
    print(f"Pixelprobe: {app.name}")
    fehler = 0
    for name, extra in (("normal", {}), ("ohne_dmabuf", {"WEBKIT_DISABLE_DMABUF_RENDERER": "1"})):
        anzeige = ":97"
        # Xvfb schreibt das Bild des Bildschirms laufend als XWD-Datei (-fbdir): kein Zusatzprogramm zum Abziehen nötig
        fbdir = LAUF / f"fb-{name}"
        fbdir.mkdir(parents=True, exist_ok=True)
        xvfb = subprocess.Popen(["Xvfb", anzeige, "-screen", "0", "1280x800x24", "-fbdir", str(fbdir)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(2)
        d = daten(f"pixel-{name}")
        env = dict(os.environ, DISPLAY=anzeige, FYOS_SHELL_DATEN=str(d), CUDA_VISIBLE_DEVICES="", **extra)
        prozess = subprocess.Popen(["dbus-run-session", "--", str(app)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            fenster = fenster_id(anzeige, NAME)
            if not fenster:
                print(f"[FEHLER] {name}: kein Fenster mit dem Titel {NAME} erschienen")
                fehler += 1
                continue
            wid, x, y, w, h = fenster
            time.sleep(8)  # Seite laden und zeichnen lassen
            abzug = fbdir / "Xvfb_screen0"
            kopie = LAUF / f"bildschirm-{name}.xwd"
            shutil.copy(abzug, kopie)
            breite, hoehe, px = pixelprobe.lies_xwd(kopie.read_bytes())
            gesamt = pixelprobe.analysiere(px)
            e = pixelprobe.analysiere(pixelprobe.ausschnitt(breite, hoehe, px, x, y, w, h))
            print(f"[{'ok' if e['sichtbar'] else 'FEHLER'}] {name}: Fenster {wid} {w}x{h} bei +{x}+{y}, {e['farben']} Farben, häufigster Anteil {e['haeufigster_anteil']}, dunkel {e['dunkel']}, hell {e['hell']} (ganzer Bildschirm: {gesamt['farben']} Farben)")
            fehler += 0 if e["sichtbar"] else 1
        finally:
            try:
                os.killpg(prozess.pid, signal.SIGTERM)
                prozess.wait(timeout=15)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                pass
            xvfb.terminate()
            xvfb.wait(timeout=10)
    sys.exit(1 if fehler else 0)


if __name__ == "__main__":
    modus = sys.argv[1] if len(sys.argv) > 1 else ""
    if modus == "bauen":
        bauen(sys.argv[2] if len(sys.argv) > 2 else "studio")
    elif modus == "pruefen":
        pruefen()
    elif modus == "schleife":
        schleife()
    elif modus == "tresor":
        tresor()
    elif modus == "pixel":
        pixel()
    else:
        sys.exit(__doc__)
