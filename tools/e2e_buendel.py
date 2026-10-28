#!/usr/bin/env python3
"""Ende-zu-Ende-Prüfung des Studio-Profils MIT Python-Bündel (S-A), nur macOS, ohne Netz außer dem einmaligen Laden des Bündels in den Cache.

Baut zwei Versionen (0.0.2, 0.0.3) mit `bauen.py --mit-python`, installiert die erste in einen Wegwerf-Ordner und prüft:

  B1  Selbsttest ohne eingestellten Begleiter: das ECHTE Studio läuft aus dem Bündel (Quelle: Bündel), /api/state mit Kennung
  B2  Fenstermodus: Interpreter liegt im Paket, der Shim bestätigt X-FYOS-Kennung, ein Plugin des Nutzers wird gefunden, das Paket bleibt
      bytegleich (keine .pyc), SIGTERM beendet Hülle, Shim und Studio
  B3  Update 0.0.2 -> 0.0.3 tauscht das Bündel mit der App; Daten, Studio-Daten und Plugin-Ordner des Nutzers unverändert; Selbsttest danach
  B4  Rückweg auf 0.0.2

Aufruf (aus apps/fyos-shell):  python3 tools/e2e_buendel.py [--ohne-bau]
Die App läuft mit eigener Bundle-Id (.e2etest), eigenem TMPDIR und FYOS_SHELL_DATEN in einem Wegwerf-Ordner; eine installierte App, der echte Schlüsselbund
und der echte Anmeldeordner bleiben unberührt.
"""
import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import e2e_update as e  # noqa: E402

VERSIONEN = ("0.0.2", "0.0.3")


def release_anlegen(arbeit, bauten):
    r = arbeit / "release"
    if r.exists():
        shutil.rmtree(r)
    basis = f"http://127.0.0.1:{e.PORT_UPDATE}"
    sig = {}
    for v in VERSIONEN:
        (r / "pakete" / v).mkdir(parents=True)
        shutil.copy(bauten / v / "paket.app.tar.gz", r / "pakete" / v / "paket.app.tar.gz")
        sig[v] = (bauten / v / "paket.app.tar.gz.sig").read_text().strip()
        e.json_schreiben(r / f"v{v}" / "latest.json", e.manifest(v, f"{basis}/pakete/{v}/paket.app.tar.gz", sig[v]))
    e.json_schreiben(r / "latest.json", e.manifest(VERSIONEN[-1], f"{basis}/pakete/{VERSIONEN[-1]}/paket.app.tar.gz", sig[VERSIONEN[-1]]))
    return r


def daten_anlegen(umg, name):
    """Datenordner OHNE eingestellten Begleiter (das Bündel soll gelten), mit Daten und einem Plugin des Nutzers."""
    d = umg.arbeit / "daten" / name
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True)
    (d / "einstellungen.json").write_text(json.dumps({"schema": 1, "meine_eigene_einstellung": {"bleibt": [1, 2, 3]}}), encoding="utf-8")
    (d / "daten-marke.txt").write_text("meine Daten\n", encoding="utf-8")
    (d / "studio-home" / "plugins").mkdir(parents=True)
    (d / "studio-home" / "plugins" / "beispiel-plugin.txt").write_text("Daten eines Plugins im Studio-Datenordner\n", encoding="utf-8")
    # Plugin des Nutzers: ein entpacktes Paket mit .dist-info und Entry Point, wie `pip install --target` es hinterlässt
    p = d / "studio-plugins"
    (p / "e2e_plugin").mkdir(parents=True)
    (p / "e2e_plugin" / "__init__.py").write_text("def register(ctx):\n    pass\n", encoding="utf-8")
    info = p / "e2e_plugin-1.0.dist-info"
    info.mkdir()
    (info / "METADATA").write_text("Metadata-Version: 2.1\nName: e2e-plugin\nVersion: 1.0\n", encoding="utf-8")
    (info / "entry_points.txt").write_text("[fle_studio.plugins]\ne2e-plugin = e2e_plugin:register\n", encoding="utf-8")
    return d


def stand(d):
    return {n: e.sha(d / n) for n in ("einstellungen.json", "daten-marke.txt", "studio-plugins")} | {"studio-plugins-daten": e.sha(d / "studio-home" / "plugins")}


def prozesse(muster):
    r = subprocess.run(["ps", "-axo", "pid=,args="], capture_output=True, text=True)
    return [z.strip() for z in r.stdout.splitlines() if muster in z and "ps -axo" not in z]


def holen(url, kopf=None):
    with urllib.request.urlopen(url, timeout=3) as a:
        return a.status, dict(a.headers), a.read().decode("utf-8", "replace")


def pruefe(umg, bauten):
    app_a = umg.installieren("buendel", quelle=bauten / VERSIONEN[0] / f"{e.APPNAME}.app")
    d = daten_anlegen(umg, "buendel")
    vorher = stand(d)
    res = app_a / "Contents" / "Resources"
    exe = app_a / "Contents" / "MacOS" / "fyos-shell"

    print("B1 Selbsttest mit dem Bündel")
    code, aus, err = umg.lauf(app_a, d, "--selbsttest", timeout=180)
    text = next((s["text"] for s in (aus or {}).get("schritte", []) if s["name"] == "begleiter"), "")
    e.melde("B1", "echtes Studio aus dem Bündel: läuft, /api/state mit Kennung, Quelle Bündel", code == 0 and "fle-studio 0.4.1" in text and "Quelle: Bündel" in text, text + err[-300:])
    beschreibung = json.loads((res / "buendel.json").read_text()) if (res / "buendel.json").is_file() else {}
    interpreter = res / beschreibung.get("python", {}).get("interpreter", "fehlt")
    e.melde("B1", "Interpreter, Studio und Shim liegen im Paket (Contents/Resources)", interpreter.is_file() and os.access(interpreter, os.X_OK) and (res / "studio" / "fle_studio").is_dir() and (res / "shim" / "begleiter_shim.py").is_file(), str(interpreter))
    e.melde("B1", "nach dem Selbsttest läuft nichts mehr", not prozesse(str(app_a)))

    print("B2 Fenstermodus (--versteckt)")
    paket_vorher = e.sha(res)
    env = dict(os.environ, FYOS_SHELL_DATEN=str(d), TMPDIR=umg.eigener_tmp())
    erste = subprocess.Popen([str(exe), "--versteckt"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    port = kennung = None
    try:
        def shim_gefunden():
            nonlocal port, kennung
            for z in prozesse("begleiter_shim.py"):
                teile = z.split()
                if "--port" in teile and "--kennung" in teile and str(app_a) in z:
                    port, kennung = teile[teile.index("--port") + 1], teile[teile.index("--kennung") + 1]
                    return True
            return False
        e.melde("B2", "Hülle startet den Shim aus dem Bündel", e.warten_bis(shim_gefunden, 40))
        gesund = False
        if port:
            def hole():
                try:
                    return holen(f"http://127.0.0.1:{port}/api/state")
                except Exception:
                    return None
            ende = time.time() + 40
            antwort = None
            while time.time() < ende:
                antwort = hole()
                if antwort and antwort[0] == 200 and antwort[1].get("X-FYOS-Kennung") == kennung:
                    gesund = True
                    break
                time.sleep(0.5)
        e.melde("B2", "/api/state des Studios trägt die Kennung der Hülle", gesund)
        python_zeilen = prozesse("-m fle_studio")
        e.melde("B2", "das Studio läuft mit dem Interpreter aus dem Paket", any(str(interpreter) in z for z in python_zeilen), "; ".join(python_zeilen)[:300])
        if port:
            try:
                plugins = json.loads(holen(f"http://127.0.0.1:{port}/api/plugins")[2])
                ids = [p.get("id") for p in (plugins if isinstance(plugins, list) else plugins.get("plugins", []))]
            except Exception as ex:
                ids = [str(ex)]
            e.melde("B2", "Plugin des Nutzers (studio-plugins) wird gefunden, ebenso die mitgelieferten", "e2e-plugin" in ids and "updater" in ids, str(ids))
    finally:
        erste.send_signal(signal.SIGTERM)
        try:
            erste.wait(timeout=30)
        except subprocess.TimeoutExpired:
            erste.kill()
    e.melde("B2", "SIGTERM beendet Hülle, Shim und Studio", e.warten_bis(lambda: not prozesse(str(app_a)), 15), "; ".join(prozesse(str(app_a)))[:300])
    e.melde("B2", "das Paket ist bytegleich geblieben (keine .pyc, keine Schreibzugriffe)", e.sha(res) == paket_vorher)
    e.melde("B2", "Studio-Daten liegen im Datenordner, nicht im Paket", (d / "studio-home").is_dir() and any((d / "studio-home").iterdir()))

    print("B3 Update 0.0.2 -> 0.0.3")
    code, aus, err = umg.lauf(app_a, d, "--aktualisieren", timeout=180)
    e.melde("B3", "Update eingespielt", code == 0 and aus and aus.get("ergebnis") == "eingespielt" and aus.get("version") == VERSIONEN[1], json.dumps(aus) + err[-300:])
    ziel_app = bauten / VERSIONEN[1] / f"{e.APPNAME}.app"
    e.melde("B3", "Programm und Bündel sind die der neuen Version (Resources und Programm bytegleich zum Bau 0.0.3)",
            e.sha(res) == e.sha(ziel_app / "Contents" / "Resources") and e.sha(exe) == e.sha(ziel_app / "Contents" / "MacOS" / "fyos-shell"))
    e.melde("B3", "Daten, Studio-Daten und Plugin-Ordner des Nutzers unverändert", stand(d) == vorher)
    code, aus, err = umg.lauf(app_a, d, "--selbsttest", timeout=180)
    text = next((s["text"] for s in (aus or {}).get("schritte", []) if s["name"] == "begleiter"), "")
    e.melde("B3", "nach dem Update startet das Studio aus dem neuen Bündel", code == 0 and VERSIONEN[1] in aus["schritte"][0]["text"] and "fle-studio 0.4.1" in text, json.dumps(aus) + err[-200:])
    e.melde("B3", "Plugin-Ordner und Daten nach dem Selbsttest weiter unverändert", stand(d) == vorher)

    print("B4 Rückweg")
    code, aus, err = umg.lauf(app_a, d, "--zurueck", timeout=180)
    e.melde("B4", "zurück auf 0.0.2 eingespielt", code == 0 and aus and aus.get("version") == VERSIONEN[0], json.dumps(aus) + err[-200:])
    e.melde("B4", "Bündel der alten Version wieder da, Daten unverändert",
            e.sha(res) == e.sha(bauten / VERSIONEN[0] / f"{e.APPNAME}.app" / "Contents" / "Resources") and stand(d) == vorher)
    code, aus, _ = umg.lauf(app_a, d, "--selbsttest", timeout=180)
    e.melde("B4", "Selbsttest der alten Version mit Bündel", code == 0 and aus and aus["ok"])


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--arbeit", default="/private/tmp/fyos-shell-d0-e2e/lauf-buendel")
    p.add_argument("--ohne-bau", action="store_true")
    a = p.parse_args()
    if sys.platform != "darwin":
        sys.exit("Dieses Skript läuft nur auf macOS.")
    arbeit = Path(a.arbeit)
    arbeit.mkdir(parents=True, exist_ok=True)
    key, _ = e.schluessel(arbeit)
    bauten = arbeit / "bauten"
    if not a.ohne_bau:
        for v in VERSIONEN:
            e.bauen(v, key, bauten, extra=("--mit-python",))
    release = release_anlegen(arbeit, bauten)
    log = arbeit / "anfragen.log"
    log.write_text("")
    server = subprocess.Popen([sys.executable, str(e.TOOLS / "testserver.py"), "update", "--wurzel", str(release), "--port", str(e.PORT_UPDATE), "--log", str(log)],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not e.warten_bis(lambda: e.port_offen(e.PORT_UPDATE), 10):
            sys.exit("Test-Server startet nicht")
        umg = e.Umgebung(arbeit, bauten / VERSIONEN[0] / f"{e.APPNAME}.app")
        pruefe(umg, bauten)
    finally:
        server.terminate()
        server.wait(timeout=10)
    schlecht = [x for x in e.ERGEBNISSE if not x[2]]
    print(f"\n{len(e.ERGEBNISSE) - len(schlecht)} von {len(e.ERGEBNISSE)} Prüfungen bestanden.")
    for tor, name, _, detail in schlecht:
        print(f"FEHLER {tor} {name}: {detail}")
    sys.exit(1 if schlecht else 0)


if __name__ == "__main__":
    main()
