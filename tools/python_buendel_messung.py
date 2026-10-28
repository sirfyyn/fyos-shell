#!/usr/bin/env python3
"""Messung für das Python-Bündel der Hülle (nur Messung, es wird nichts ausgeliefert). Nur Standardbibliothek.

  python3 tools/python_buendel_messung.py <python-install-ordner> <venv-mit-fle-studio>

Nimmt eine entpackte python-build-standalone-Distribution (z. B. die von `uv` verwaltete unter ~/.local/share/uv/python/cpython-3.11*)
und das venv, in das `fle-studio` installiert wurde, kopiert beides in einen Wegwerf-Ordner, entfernt, was das Studio nicht braucht
(tkinter/Tcl/Tk, idlelib, turtledemo, ensurepip, lib2to3, Tests, __pycache__, site-packages der Distribution), und misst:
Größe entpackt und als tar.gz/tar.xz. Zum Schluss startet es das Studio mit dem **gestutzten** Interpreter (`--version`, dann
`GET /api/state`), damit klar ist, dass das Stutzen nichts kaputt gemacht hat. Ausgabe: eine JSON-Zeile.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path

ENTFERNEN = [
    "lib/python3.*/idlelib", "lib/python3.*/tkinter", "lib/python3.*/turtledemo", "lib/python3.*/ensurepip", "lib/python3.*/lib2to3",
    "lib/python3.*/test", "lib/python3.*/site-packages", "lib/tcl*", "lib/tk*", "lib/itcl*", "lib/thread*", "lib/libtcl*", "lib/libtk*",
    "lib/python3.*/lib-dynload/_tkinter*", "share", "include",
]


def groesse(pfad):
    return sum(p.stat().st_size for p in Path(pfad).rglob("*") if p.is_file() and not p.is_symlink())


def packen(ordner, ziel, modus):
    with tarfile.open(ziel, modus) as t:
        t.add(ordner, arcname=".")
    return Path(ziel).stat().st_size


def freier_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main(argv):
    if len(argv) != 2:
        sys.exit(__doc__)
    python, venv = Path(argv[0]).resolve(), Path(argv[1]).resolve()
    site = next((venv / "lib").glob("python3.*/site-packages"), None)
    if not (python / "bin").is_dir() or site is None:
        sys.exit("Erstes Argument: entpackte Distribution (mit bin/), zweites: venv mit installiertem fle-studio.")
    ergebnis = {"distribution_entpackt_mb": round(groesse(python) / 1e6, 1)}
    with tempfile.TemporaryDirectory() as t:
        t = Path(t)
        ziel = t / "python"
        shutil.copytree(python, ziel, symlinks=True)
        for muster in ENTFERNEN:
            for p in ziel.glob(muster):
                shutil.rmtree(p) if p.is_dir() and not p.is_symlink() else p.unlink()
        for p in list(ziel.rglob("__pycache__")):
            shutil.rmtree(p, ignore_errors=True)
        ergebnis["gestutzt_entpackt_mb"] = round(groesse(ziel) / 1e6, 1)
        ergebnis["gestutzt_tar_gz_mb"] = round(packen(ziel, t / "a.tar.gz", "w:gz") / 1e6, 1)
        ergebnis["gestutzt_tar_xz_mb"] = round(packen(ziel, t / "a.tar.xz", "w:xz") / 1e6, 1)
        paket = t / "studio-pakete"
        shutil.copytree(site, paket, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "pip*", "setuptools*", "_distutils_hack", "pkg_resources"))
        ergebnis["studio_entpackt_mb"] = round(groesse(paket) / 1e6, 2)
        ergebnis["studio_tar_gz_mb"] = round(packen(paket, t / "s.tar.gz", "w:gz") / 1e6, 2)

        interpreter = next((ziel / "bin").glob("python3.[0-9]*"))
        env = dict(os.environ, PYTHONPATH=str(paket), PYTHONDONTWRITEBYTECODE="1")
        env.pop("PYTHONHOME", None)
        v = subprocess.run([str(interpreter), "-m", "fle_studio", "--version"], capture_output=True, text=True, env=env, timeout=60)
        ergebnis["version_ausgabe"] = (v.stdout + v.stderr).strip()[:80]
        port = freier_port()
        home = t / "studio-home"
        prozess = subprocess.Popen([str(interpreter), "-m", "fle_studio", "--port", str(port), "--no-browser", "--home", str(home)], env=env,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            zustand = None
            ende = time.time() + 30
            while time.time() < ende and zustand is None:
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/state", timeout=2) as a:
                        zustand = json.loads(a.read().decode("utf-8")).get("version")
                except OSError:
                    time.sleep(0.3)
            ergebnis["studio_laeuft_mit_gestutztem_interpreter"] = zustand
        finally:
            prozess.terminate()
            prozess.wait(timeout=15)
    print(json.dumps(ergebnis, ensure_ascii=False))
    return 0 if ergebnis.get("studio_laeuft_mit_gestutztem_interpreter") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
