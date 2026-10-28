#!/usr/bin/env python3
"""Erzeugt je Profil ein eigenes App-Symbol (Studio, Agent, OS) aus dem gemeinsamen Grundsymbol.

  python3 tools/icons_erzeugen.py [--quelle app/icons/icon.png] [--ziel app/profile/icons]

Grundsymbol: dunkles Quadrat mit weißem „F“ und einem Farbpunkt. Je Profil ändert sich nur die Farbe des Punkts, damit die drei Apps im Dock
und in der Programmliste auseinanderzuhalten sind:
  agent  grün   (wie das bisherige Agent-Symbol)
  os     violett
  studio orange

Ergebnis je Profil in <ziel>/<profil>/: icon.icns (nur macOS, braucht `iconutil`), icon.ico, icon.png (512), 32x32.png, 128x128.png, 128x128@2x.png.
Die Profil-Konfiguration (app/profile/<profil>.conf.json) verweist mit `bundle.icon` darauf. Braucht Pillow.
"""
import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

HIER = Path(__file__).resolve().parent.parent
FARBEN = {"agent": (52, 199, 120), "os": (139, 92, 246), "studio": (245, 158, 11)}
HINTERGRUND = (26, 32, 44)  # Farbe des Quadrats, in die der Punkt am Rand übergeht


def umfaerben(bild, ziel):
    """Ersetzt die grüne Farbe des Punkts durch `ziel`; Ränder gehen weich ins dunkle Quadrat über. Alles Übrige bleibt unverändert."""
    px = bild.convert("RGBA")
    daten = px.load()
    breite, hoehe = px.size
    for y in range(hoehe):
        for x in range(breite):
            r, g, b, a = daten[x, y]
            m = g - (r + b) / 2  # Grünanteil: Punkt etwa +115, dunkler Grund und weißes „F“ etwa 0
            if m <= 4:
                continue
            w = max(0.0, min(1.0, m / 115.0))
            daten[x, y] = tuple(round(HINTERGRUND[i] * (1 - w) + ziel[i] * w) for i in range(3)) + (a,)
    return px


def schreiben(bild, ordner):
    ordner.mkdir(parents=True, exist_ok=True)
    gross = bild.resize((1024, 1024), Image.LANCZOS) if bild.size != (1024, 1024) else bild
    gross.resize((512, 512), Image.LANCZOS).save(ordner / "icon.png")
    gross.resize((32, 32), Image.LANCZOS).save(ordner / "32x32.png")
    gross.resize((128, 128), Image.LANCZOS).save(ordner / "128x128.png")
    gross.resize((256, 256), Image.LANCZOS).save(ordner / "128x128@2x.png")
    gross.save(ordner / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    if sys.platform == "darwin" and shutil.which("iconutil"):
        with tempfile.TemporaryDirectory() as t:
            satz = Path(t) / "icon.iconset"
            satz.mkdir()
            for n in (16, 32, 128, 256, 512):
                gross.resize((n, n), Image.LANCZOS).save(satz / f"icon_{n}x{n}.png")
                gross.resize((n * 2, n * 2), Image.LANCZOS).save(satz / f"icon_{n}x{n}@2x.png")
            subprocess.run(["iconutil", "-c", "icns", str(satz), "-o", str(ordner / "icon.icns")], check=True)
    else:
        print(f"Hinweis: kein iconutil, {ordner / 'icon.icns'} wurde nicht erzeugt (auf dem Mac ausführen).", file=sys.stderr)


def main(argv):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--quelle", default=str(HIER / "app" / "icons" / "icon.png"), help="Grundsymbol (grüner Punkt, quadratisch, möglichst 1024 px)")
    p.add_argument("--ziel", default=str(HIER / "app" / "profile" / "icons"))
    a = p.parse_args(argv)
    quelle = Image.open(a.quelle).convert("RGBA")
    if quelle.size[0] < 512:
        sys.exit(f"{a.quelle} ist mit {quelle.size[0]} px zu klein. Abhilfe: ein Grundsymbol mit mindestens 512 px angeben (--quelle).")
    for profil, farbe in FARBEN.items():
        schreiben(umfaerben(quelle, farbe), Path(a.ziel) / profil)
        print(f"{profil}: {Path(a.ziel) / profil}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
