#!/usr/bin/env python3
"""Baut das Python-Bündel des Studio-Profils: gestutzter Python-Interpreter + FLE Studio + Shim, festgenagelt und geprüft.

  python3 tools/buendel_bauen.py [--system SYSTEM] [--ziel ORDNER] [--cache ORDNER] [--lock DATEI] [--pruefen]

Ergebnis in ORDNER (Vorgabe app/resources/, wird von Tauri als Ressourcen ins Paket kopiert, siehe bauen.py --mit-python):
  python/        CPython (python-build-standalone, install_only_stripped), gestutzt (kein Tcl/Tk, keine Tests, kein pip)
  studio/        fle_studio* samt .dist-info (damit die Plugins des Studios per Entry Point gefunden werden); keine Abhängigkeiten
  shim/          begleiter_shim.py (bestätigt X-FYOS-Kennung vor /api/state)
  buendel.json   Beschreibung (Interpreter-Pfad relativ, Versionen); die Hülle liest nur diese Datei

Alles ist in python-buendel.lock.json festgenagelt: der Interpreter mit SHA-256 des Archivs, das Studio mit einem Hash über die entpackten
Dateien (unabhängig davon, wie GitHub das Archiv packt). Jede Abweichung bricht den Bau ab. Heruntergeladen wird nur in den Cache; das
Bündel enthält keine privaten Plugins. `--pruefen` prüft nur die Sperrdatei (Aufbau, Prüfsummen-Form), ohne Netz.
"""
import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

WURZEL = Path(__file__).resolve().parent.parent
LOCK = WURZEL / "python-buendel.lock.json"
STANDARD_ZIEL = WURZEL / "app" / "resources"

# Was das Studio nicht braucht (Messung: 73,9 -> 45,8 MB entpackt, siehe docs/current/FYOS-SHELL-PYTHON-BUENDEL.md)
ENTFERNEN = [
    "python/lib/python3.*/idlelib", "python/lib/python3.*/tkinter", "python/lib/python3.*/turtledemo", "python/lib/python3.*/ensurepip",
    "python/lib/python3.*/lib2to3", "python/lib/python3.*/test", "python/lib/python3.*/site-packages",
    "python/lib/tcl[0-9]*", "python/lib/tk[0-9]*", "python/lib/itcl[0-9]*", "python/lib/thread[0-9]*", "python/lib/libtcl*", "python/lib/libtk*",
    "python/lib/python3.*/lib-dynload/_tkinter*", "python/share", "python/include", "python/lib/pkgconfig",
    "python/bin/pip*", "python/bin/idle*", "python/bin/2to3*", "python/bin/pydoc*", "python/bin/python3-config", "python/bin/python3.*-config",
    "python/tcl", "python/Lib/idlelib", "python/Lib/tkinter", "python/Lib/turtledemo", "python/Lib/ensurepip", "python/Lib/lib2to3", "python/Lib/test",
    "python/Lib/site-packages", "python/DLLs/_tkinter*", "python/DLLs/tcl*", "python/DLLs/tk*", "python/Scripts", "python/include", "python/libs",
]


class Abbruch(Exception):
    """Ein Fehler mit Ursache und Abhilfe in einem Text."""


def system_id(system=None, maschine=None):
    s = (system or platform.system()).lower()
    m = (maschine or platform.machine()).lower()
    arch = {"arm64": "aarch64", "aarch64": "aarch64", "x86_64": "x86_64", "amd64": "x86_64"}.get(m)
    os_name = {"darwin": "macos", "linux": "linux", "windows": "windows"}.get(s)
    if not arch or not os_name:
        raise Abbruch(f"Unbekanntes System {s}/{m}. Abhilfe: --system macos-aarch64|macos-x86_64|linux-x86_64|windows-x86_64 angeben.")
    return f"{os_name}-{arch}"


def lock_lesen(pfad=LOCK):
    lock = json.loads(Path(pfad).read_text(encoding="utf-8"))
    fehler = []
    for name, eintrag in lock["python"]["systeme"].items():
        if len(eintrag.get("sha256", "")) != 64 or not all(c in "0123456789abcdef" for c in eintrag["sha256"]):
            fehler.append(f"python/{name}: sha256 ist keine 64-stellige Hexsumme")
        if not eintrag.get("url", "").startswith("https://"):
            fehler.append(f"python/{name}: url ist nicht https")
        if not eintrag.get("interpreter"):
            fehler.append(f"python/{name}: interpreter fehlt")
    s = lock["studio"]
    if len(s.get("commit", "")) != 40:
        fehler.append("studio: commit ist keine vollständige Git-Kennung")
    if len(s.get("inhalt_sha256", "")) != 64:
        fehler.append("studio: inhalt_sha256 fehlt oder ist ein Platzhalter")
    if not s.get("url", "").startswith("https://"):
        fehler.append("studio: url ist nicht https")
    if fehler:
        raise Abbruch("Die Sperrdatei ist unvollständig:\n  - " + "\n  - ".join(fehler))
    return lock


def sha256_datei(pfad):
    h = hashlib.sha256()
    with open(pfad, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def baum_hash(wurzel, pfade):
    """Hash über Dateinamen und -inhalte (sortiert, ohne __pycache__); unabhängig von Archivform, Zeitstempeln und Rechten."""
    h = hashlib.sha256()
    wurzel = Path(wurzel)
    dateien = []
    for p in pfade:
        p = wurzel / p
        if p.is_dir():
            dateien += [f for f in p.rglob("*") if f.is_file() and "__pycache__" not in f.parts]
        elif p.is_file():
            dateien.append(p)
    for f in sorted(dateien, key=lambda f: f.relative_to(wurzel).as_posix()):
        h.update(f.relative_to(wurzel).as_posix().encode("utf-8") + b"\0")
        h.update(hashlib.sha256(f.read_bytes()).digest())
    return h.hexdigest()


def herunterladen(url, sha256, cache):
    """Lädt `url` in den Cache (falls nicht schon da und passend) und prüft die Summe. Gibt den Pfad zurück."""
    cache = Path(cache)
    cache.mkdir(parents=True, exist_ok=True)
    ziel = cache / f"{sha256}.tar.gz"
    if ziel.is_file() and sha256_datei(ziel) == sha256:
        return ziel
    print(f"Lade {url} …", flush=True)
    anfrage = urllib.request.Request(url, headers={"User-Agent": "fyos-shell-buendel"})
    teil = ziel.with_suffix(".teil")
    with urllib.request.urlopen(anfrage, timeout=120) as antwort, open(teil, "wb") as f:
        shutil.copyfileobj(antwort, f)
    if sha256_datei(teil) != sha256:
        gefunden = sha256_datei(teil)
        teil.unlink()
        raise Abbruch(f"Prüfsumme von {url} stimmt nicht (erwartet {sha256}, gefunden {gefunden}). Abhilfe: nichts installieren; die Sperrdatei nur nach eigener Prüfung ändern.")
    teil.replace(ziel)
    return ziel


def sicher_entpacken(archiv, ziel):
    """Entpackt ein tar.gz; verweigert absolute Pfade, `..` und Links, die aus dem Zielordner zeigen."""
    ziel = Path(ziel).resolve()
    with tarfile.open(archiv) as t:
        for m in t.getmembers():
            p = (ziel / m.name).resolve()
            if ziel != p and ziel not in p.parents:
                raise Abbruch(f"Archiv enthält einen Pfad außerhalb des Zielordners: {m.name}")
            if m.issym() or m.islnk():
                ziel_link = (p.parent / m.linkname).resolve() if m.issym() else (ziel / m.linkname).resolve()
                if ziel != ziel_link and ziel not in ziel_link.parents:
                    raise Abbruch(f"Archiv enthält einen Link nach außen: {m.name} -> {m.linkname}")
            if m.isdev():
                raise Abbruch(f"Archiv enthält eine Gerätedatei: {m.name}")
        t.extractall(ziel)


def stutzen(wurzel):
    """Entfernt, was das Studio nicht braucht, und löst die Links in bin/ auf (Tauri-Ressourcen kopieren Links als Dateien)."""
    wurzel = Path(wurzel)
    for muster in ENTFERNEN:
        for p in wurzel.glob(muster):
            if p.is_dir() and not p.is_symlink():
                shutil.rmtree(p)
            else:
                p.unlink()
    for p in list(wurzel.rglob("__pycache__")):
        shutil.rmtree(p, ignore_errors=True)
    # Links (bin/python3 -> python3.11) fallen weg: die Hülle ruft den echten Interpreter über buendel.json auf
    for p in sorted(wurzel.rglob("*"), key=lambda q: len(q.parts), reverse=True):
        if p.is_symlink():
            p.unlink()


def groesse(pfad):
    return sum(p.stat().st_size for p in Path(pfad).rglob("*") if p.is_file() and not p.is_symlink())


def dist_info_schreiben(ziel, name, version, entry_points, lizenz_text, zusammenfassung=""):
    """Schreibt <name>-<version>.dist-info mit METADATA und entry_points.txt (genug für importlib.metadata und damit für die Plugins)."""
    d = Path(ziel) / f"{name.replace('-', '_')}-{version}.dist-info"
    d.mkdir(parents=True, exist_ok=True)
    (d / "METADATA").write_text(
        f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\nSummary: {zusammenfassung}\nLicense-Expression: MIT\nRequires-Python: >=3.10\n", encoding="utf-8")
    (d / "INSTALLER").write_text("fyos-shell\n", encoding="utf-8")
    zeilen = []
    for gruppe, werte in entry_points.items():
        zeilen.append(f"[{gruppe}]")
        zeilen += [f"{k} = {v}" for k, v in werte.items()]
        zeilen.append("")
    (d / "entry_points.txt").write_text("\n".join(zeilen), encoding="utf-8")
    (d / "licenses").mkdir(exist_ok=True)
    (d / "licenses" / "LICENSE").write_text(lizenz_text, encoding="utf-8")
    return d


def pyproject_lesen(interpreter, pyproject):
    """Liest Pakete, Version und Entry Points aus pyproject.toml mit dem gebündelten Interpreter (hat tomllib; der Bau-Rechner muss es nicht haben)."""
    code = ("import json,sys,tomllib\nd=tomllib.load(open(sys.argv[1],'rb'))\n"
            "p=d['project']\nprint(json.dumps({'name':p['name'],'summary':p.get('description',''),"
            "'scripts':p.get('scripts',{}),'plugins':p.get('entry-points',{}),"
            "'pakete':d['tool']['hatch']['build']['targets']['wheel']['packages'],'versionsdatei':d['tool']['hatch']['version']['path']}))")
    r = subprocess.run([str(interpreter), "-c", code, str(pyproject)], capture_output=True, text=True)
    if r.returncode != 0:
        raise Abbruch(f"pyproject.toml des Studios nicht lesbar: {r.stderr.strip()[-300:]}")
    return json.loads(r.stdout)


def version_aus_datei(pfad):
    import re
    m = re.search(r'^__version__\s*=\s*"([^"]+)"', Path(pfad).read_text(encoding="utf-8"), re.M)
    if not m:
        raise Abbruch(f"Keine __version__ in {pfad}")
    return m.group(1)


def studio_bauen(quelle, ziel, interpreter, lock_studio):
    """Aus dem entpackten, geprüften Studio-Quellbaum: Pakete kopieren, dist-info schreiben."""
    quelle, ziel = Path(quelle), Path(ziel)
    info = pyproject_lesen(interpreter, quelle / "pyproject.toml")
    version = version_aus_datei(quelle / info["versionsdatei"])
    if version != lock_studio["version"]:
        raise Abbruch(f"Das Studio meldet Version {version}, die Sperrdatei verlangt {lock_studio['version']}. Abhilfe: Sperrdatei und Quelle abgleichen.")
    ziel.mkdir(parents=True, exist_ok=True)
    for paket in info["pakete"]:
        shutil.copytree(quelle / paket, ziel / Path(paket).name, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    eintraege = dict(info["plugins"])
    if info["scripts"]:
        eintraege["console_scripts"] = info["scripts"]
    dist_info_schreiben(ziel, info["name"], version, eintraege, (quelle / "LICENSE").read_text(encoding="utf-8"), info["summary"])
    return version, [Path(p).name for p in info["pakete"]]


def bauen(system, ziel, cache, lock_pfad):
    lock = lock_lesen(lock_pfad)
    py = lock["python"]["systeme"].get(system)
    if not py:
        raise Abbruch(f"Für {system} gibt es keinen Interpreter in der Sperrdatei.")
    ziel = Path(ziel)
    if ziel.exists():
        shutil.rmtree(ziel)
    ziel.mkdir(parents=True)

    archiv = herunterladen(py["url"], py["sha256"], cache)
    sicher_entpacken(archiv, ziel)
    stutzen(ziel)
    interpreter = ziel / py["interpreter"]
    if not interpreter.is_file():
        raise Abbruch(f"Nach dem Stutzen fehlt der Interpreter {py['interpreter']}. Abhilfe: Lizenz/Aufbau der Distribution prüfen, ENTFERNEN anpassen.")
    if os.name != "nt":
        interpreter.chmod(0o755)

    s = lock["studio"]
    studio_archiv = Path(cache) / f"studio-{s['commit']}.tar.gz"
    Path(cache).mkdir(parents=True, exist_ok=True)
    if not studio_archiv.is_file():
        print(f"Lade {s['url']} …", flush=True)
        with urllib.request.urlopen(urllib.request.Request(s["url"], headers={"User-Agent": "fyos-shell-buendel"}), timeout=120) as a, open(studio_archiv, "wb") as f:
            shutil.copyfileobj(a, f)
    with tempfile.TemporaryDirectory() as t:
        sicher_entpacken(studio_archiv, t)
        wurzeln = [p for p in Path(t).iterdir() if p.is_dir()]
        if len(wurzeln) != 1:
            raise Abbruch("Das Studio-Archiv hat nicht genau einen Wurzelordner.")
        quelle = wurzeln[0]
        gefunden = baum_hash(quelle, ["src", "pyproject.toml", "LICENSE"])
        if gefunden != s["inhalt_sha256"]:
            raise Abbruch(f"Der Inhalt des Studios (Commit {s['commit'][:10]}) stimmt nicht mit der Sperrdatei überein (gefunden {gefunden}). Abhilfe: nur nach eigener Prüfung festnageln.")
        studio_version, pakete = studio_bauen(quelle, ziel / "studio", interpreter, s)

    (ziel / "shim").mkdir()
    shutil.copy(WURZEL / "tools" / "begleiter_shim.py", ziel / "shim" / "begleiter_shim.py")
    beschreibung = {
        "format": 1,
        "system": system,
        "python": {"version": lock["python"]["version"], "release": lock["python"]["release"], "interpreter": py["interpreter"]},
        "studio": {"version": studio_version, "commit": s["commit"], "pakete": pakete, "ordner": "studio"},
        "shim": "shim/begleiter_shim.py",
        "gebaut_mit": "tools/buendel_bauen.py",
    }
    (ziel / "buendel.json").write_text(json.dumps(beschreibung, indent=2) + "\n", encoding="utf-8")
    return beschreibung, groesse(ziel)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--system", help="macos-aarch64 | macos-x86_64 | linux-x86_64 | windows-x86_64 (Vorgabe: dieses System)")
    p.add_argument("--ziel", default=str(STANDARD_ZIEL))
    p.add_argument("--cache", default=os.environ.get("FYOS_SHELL_CACHE") or str(Path.home() / ".cache" / "fyos-shell" / "buendel"))
    p.add_argument("--lock", default=str(LOCK))
    p.add_argument("--pruefen", action="store_true", help="nur die Sperrdatei prüfen (ohne Netz)")
    a = p.parse_args(argv)
    try:
        if a.pruefen:
            lock_lesen(a.lock)
            print("Sperrdatei in Ordnung")
            return 0
        beschreibung, byte = bauen(a.system or system_id(), a.ziel, a.cache, a.lock)
    except Abbruch as e:
        print(f"ABBRUCH: {e}", file=sys.stderr)
        return 2
    print(json.dumps({"ziel": a.ziel, "system": beschreibung["system"], "groesse_mb": round(byte / 1e6, 1), "python": beschreibung["python"]["version"], "studio": beschreibung["studio"]["version"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
