#!/usr/bin/env python3
"""Erzeugt je Profil ein eigenes App-Symbol (Studio, Agent, OS).

  python3 tools/icons_erzeugen.py [--profil agent] [--quelle app/icons/icon.png] [--ziel app/profile/icons] [--vorschau DATEI.png]

Agent: ein eigenes, hier gezeichnetes Symbol. Drei Würfel stehen auf einem geschlossenen Ring: die Schleife, in der der Agent arbeitet und
die nicht abreißt. Dunkler Grund, grüne Würfel, weißer Ring mit einem Punkt auf jedem Würfel (dieselbe Formensprache wie das Symbol von
FLE Link, dort in Pink und als offene Verbindungen). Für kleine Größen (bis 64 px) gibt es eine kräftigere Fassung ohne Bodenfliesen, mit
dickerem Ring. Die Farbe steht in AGENT_FARBE; `--farbe` probiert eine andere aus.

OS und Studio: das gemeinsame Grundsymbol (dunkles Quadrat mit weißem „F“ und einem Farbpunkt), nur die Farbe des Punkts ändert sich:
  os     violett
  studio orange

Ergebnis je Profil in <ziel>/<profil>/: icon.icns (nur macOS, braucht `iconutil`), icon.ico, icon.png (512), 32x32.png, 128x128.png, 128x128@2x.png.
Die Profil-Konfiguration (app/profile/<profil>.conf.json) verweist mit `bundle.icon` darauf. Braucht Pillow.
"""
import argparse
import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

HIER = Path(__file__).resolve().parent.parent
FARBEN = {"os": (139, 92, 246), "studio": (245, 158, 11)}
HINTERGRUND = (26, 32, 44)  # Farbe des Quadrats, in die der Punkt am Rand übergeht
PROFILE = ("agent", "os", "studio")

# --- Symbol des Agenten -------------------------------------------------------------------------------------------------
AGENT_FARBE = (52, 211, 153)  # Grün (#34d399), die Farbe des Agenten; alle Töne (Flächen, Kanten, Schein) leiten sich daraus ab
C30, S30 = math.cos(math.radians(30)), 0.5


def _mische(a, b, w):
    return tuple(round(a[i] * (1 - w) + b[i] * w) for i in range(3))


def _toene(farbe):
    """Aus der Grundfarbe: Grund, Deckfläche, linke und rechte Seite (je oben, unten), Lichtkante, Schatten unter dem Ring."""
    weiss, schwarz = (255, 255, 255), (0, 0, 0)
    return {
        "grund": _mische((10, 10, 14), farbe, 0.035),
        "oben": (_mische(farbe, weiss, 0.50), _mische(farbe, weiss, 0.25)),  # hinten hell, vorn satter
        "links": (_mische(farbe, schwarz, 0.06), _mische(farbe, schwarz, 0.22)),
        "rechts": (_mische(farbe, schwarz, 0.30), _mische(farbe, schwarz, 0.51)),  # im Schatten
        "kante": _mische(farbe, weiss, 0.78) + (215,),
        "schatten": _mische(farbe, schwarz, 0.58) + (130,),
    }


def farbe_lesen(text):
    """„#rrggbb“ oder „r,g,b“ → (r, g, b)."""
    t = text.strip()
    if t.startswith("#") and len(t) == 7:
        return tuple(int(t[i:i + 2], 16) for i in (1, 3, 5))
    teile = [int(x) for x in t.split(",")]
    if len(teile) != 3 or any(not 0 <= x <= 255 for x in teile):
        raise argparse.ArgumentTypeError(f"Farbe nicht lesbar: {text} (erwartet #rrggbb oder r,g,b)")
    return tuple(teile)


def _verlauf(groesse, oben, unten, y0, y1):
    """Bild in voller Größe, dessen Farbe von y0 nach y1 von `oben` nach `unten` läuft (darüber und darunter gleichbleibend)."""
    spalte = Image.new("RGBA", (1, groesse))
    werte = []
    spanne = max(1.0, y1 - y0)
    for y in range(groesse):
        w = min(1.0, max(0.0, (y - y0) / spanne))
        werte.append(tuple(round(oben[i] * (1 - w) + unten[i] * w) for i in range(3)) + (255,))
    spalte.putdata(werte)
    return spalte.resize((groesse, groesse), Image.NEAREST)


def _flaeche(bild, ecken, farben):
    """Ein Vieleck mit senkrechtem Farbverlauf über seine eigene Höhe auf `bild` legen."""
    groesse = bild.size[0]
    maske = Image.new("L", bild.size, 0)
    ImageDraw.Draw(maske).polygon(ecken, fill=255)
    ys = [p[1] for p in ecken]
    bild.paste(_verlauf(groesse, farben[0], farben[1], min(ys), max(ys)), (0, 0), maske)


def agent_symbol(px=1024, fett=False, abtastung=3, farbe=None):
    """Das Symbol des Agenten als quadratisches RGBA-Bild mit `px` Kantenlänge. `fett`: Fassung für kleine Größen. `farbe`: Grundfarbe."""
    PINK = tuple(farbe or AGENT_FARBE)  # Signalfarbe dieser Zeichnung (Würfel, Schein, Leuchten des Rings)
    t = _toene(PINK)
    GRUND, OBEN, LINKS, RECHTS, KANTE = t["grund"], t["oben"], t["links"], t["rechts"], t["kante"]
    groesse = px * abtastung
    k = groesse / 1024.0  # alle Maße unten gelten für 1024 px
    radius = 200.0  # Ring (in der Ebene), an dem die Mitten der Würfel liegen
    kante = 156.0 if fett else 140.0
    ring_breite = 30.0 if fett else 15.0
    punkt = 31.0 if fett else 20.0
    cx = 512.0
    # Drei Würfel im gleichen Abstand: einer hinten, zwei vorn. Die Höhe der Zeichnung wird so gelegt, dass sie mittig im Quadrat steht.
    winkel = (225.0, 345.0, 105.0)
    zentren = [(radius * math.cos(math.radians(w)), radius * math.sin(math.radians(w))) for w in winkel]
    oben_y = min((x + y) * S30 for x, y in zentren) - kante - kante / 2
    unten_y = max((x + y) * S30 for x, y in zentren) + kante / 2
    cy = 512.0 - (oben_y + unten_y) / 2 + 4.0

    def iso(x, y, z=0.0):
        return ((cx + (x - y) * C30) * k, (cy + (x + y) * S30 - z) * k)

    def schicht():
        return Image.new("RGBA", (groesse, groesse), (0, 0, 0, 0))

    # Grund: fast schwarz, dahinter ein Dunst in der Signalfarbe
    bild = Image.new("RGBA", (groesse, groesse), GRUND + (255,))
    dunst = schicht()
    ImageDraw.Draw(dunst).ellipse([(cx - 320) * k, (cy - 400) * k, (cx + 320) * k, (cy + 150) * k], fill=PINK + (84,))
    bild = Image.alpha_composite(bild, dunst.filter(ImageFilter.GaussianBlur(105 * k)))

    # Bodenfliesen (nur in der großen Fassung)
    if not fett:
        boden = schicht()
        d = ImageDraw.Draw(boden)
        seite, luecke = 96.0, 14.0
        for i in range(-2, 2):
            for j in range(-2, 2):
                x0, y0 = i * (seite + luecke) + luecke / 2, j * (seite + luecke) + luecke / 2
                ecken = [iso(x0, y0), iso(x0 + seite, y0), iso(x0 + seite, y0 + seite), iso(x0, y0 + seite)]
                d.polygon(ecken, fill=(255, 255, 255, 10), outline=(255, 255, 255, 40), width=max(1, round(2.2 * k)))
        bild = Image.alpha_composite(bild, boden)

    # Schein unter den Würfeln
    schein = schicht()
    d = ImageDraw.Draw(schein)
    for x, y in zentren:
        sx, sy = iso(x, y)
        d.ellipse([sx - 150 * k, sy - 60 * k, sx + 150 * k, sy + 96 * k], fill=PINK + (130,))
    bild = Image.alpha_composite(bild, schein.filter(ImageFilter.GaussianBlur(36 * k)))

    # Würfel, von hinten nach vorn
    kanten = schicht()
    dk = ImageDraw.Draw(kanten)
    h = kante / 2
    strich = max(1, round((5.0 if fett else 3.0) * k))
    for x, y in sorted(zentren, key=lambda p: p[0] + p[1]):
        hinten, rechts, vorn, links = iso(x - h, y - h, kante), iso(x + h, y - h, kante), iso(x + h, y + h, kante), iso(x - h, y + h, kante)
        u_rechts, u_vorn, u_links = iso(x + h, y - h), iso(x + h, y + h), iso(x - h, y + h)
        _flaeche(bild, [links, vorn, u_vorn, u_links], LINKS)
        _flaeche(bild, [vorn, rechts, u_rechts, u_vorn], RECHTS)
        _flaeche(bild, [hinten, rechts, vorn, links], OBEN)
        dk.line([links, vorn, rechts], fill=KANTE, width=strich, joint="curve")
        dk.line([vorn, u_vorn], fill=KANTE[:3] + (120,), width=strich)
    bild = Image.alpha_composite(bild, kanten)

    # Ring auf der Höhe der Deckflächen: er läuft durch die Mitte jedes Würfels und schließt sich
    zx, zy = cx * k, (cy - kante) * k
    rx, ry = radius * math.sqrt(2) * C30 * k, radius * math.sqrt(2) * S30 * k

    def ellipse(d, breite, farbe):
        b = breite * k / 2
        d.ellipse([zx - rx - b, zy - ry - b, zx + rx + b, zy + ry + b], outline=farbe, width=max(1, round(breite * k)))

    schatten = schicht()
    ellipse(ImageDraw.Draw(schatten), ring_breite * 2.1, t["schatten"])
    bild = Image.alpha_composite(bild, schatten.filter(ImageFilter.GaussianBlur(3 * k)))
    leuchten = schicht()
    ellipse(ImageDraw.Draw(leuchten), ring_breite * 2.4, PINK + (255,))
    bild = Image.alpha_composite(bild, leuchten.filter(ImageFilter.GaussianBlur((10 if fett else 13) * k)))
    ring = schicht()
    ellipse(ImageDraw.Draw(ring), ring_breite, (255, 246, 251, 255))
    bild = Image.alpha_composite(bild, ring)

    # Punkte auf den Würfeln
    hof = schicht()
    d = ImageDraw.Draw(hof)
    for x, y in zentren:
        sx, sy = iso(x, y, kante)
        d.ellipse([sx - punkt * 1.9 * k, sy - punkt * 1.9 * k, sx + punkt * 1.9 * k, sy + punkt * 1.9 * k], fill=(255, 255, 255, 150))
    bild = Image.alpha_composite(bild, hof.filter(ImageFilter.GaussianBlur(11 * k)))
    d = ImageDraw.Draw(bild)
    for x, y in zentren:
        sx, sy = iso(x, y, kante)
        d.ellipse([sx - punkt * k, sy - punkt * k, sx + punkt * k, sy + punkt * k], fill=(255, 255, 255, 255))

    # Abgerundetes Quadrat mit Rand wie das Grundsymbol; außen durchsichtig
    rand, ecke = 64 * k, 205 * k
    feld = [rand, rand, groesse - rand, groesse - rand]
    rahmen = schicht()
    ImageDraw.Draw(rahmen).rounded_rectangle(feld, radius=ecke, outline=(255, 255, 255, 30), width=max(1, round(3 * k)))
    bild = Image.alpha_composite(bild, rahmen)
    maske = Image.new("L", (groesse, groesse), 0)
    ImageDraw.Draw(maske).rounded_rectangle(feld, radius=ecke, fill=255)
    bild.putalpha(maske)
    return bild.resize((px, px), Image.LANCZOS)


# --- Grundsymbol umfärben (OS, Studio) ----------------------------------------------------------------------------------
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


def schreiben(bild, ordner, klein=None):
    """Den Satz Dateien schreiben. `klein`: eigene Fassung für Größen bis 64 px (sonst wird `bild` verkleinert)."""
    ordner.mkdir(parents=True, exist_ok=True)
    gross = bild.resize((1024, 1024), Image.LANCZOS) if bild.size != (1024, 1024) else bild
    fein = klein.resize((1024, 1024), Image.LANCZOS) if klein is not None and klein.size != (1024, 1024) else klein

    def stufe(n):
        quelle = fein if fein is not None and n <= 64 else gross
        return quelle.resize((n, n), Image.LANCZOS)

    stufe(512).save(ordner / "icon.png")
    stufe(32).save(ordner / "32x32.png")
    stufe(128).save(ordner / "128x128.png")
    stufe(256).save(ordner / "128x128@2x.png")
    ico = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    stufe(256).save(ordner / "icon.ico", sizes=ico, append_images=[stufe(n) for n, _ in ico[:-1]])
    if sys.platform == "darwin" and shutil.which("iconutil"):
        with tempfile.TemporaryDirectory() as t:
            satz = Path(t) / "icon.iconset"
            satz.mkdir()
            for n in (16, 32, 128, 256, 512):
                stufe(n).save(satz / f"icon_{n}x{n}.png")
                stufe(n * 2).save(satz / f"icon_{n}x{n}@2x.png")
            subprocess.run(["iconutil", "-c", "icns", str(satz), "-o", str(ordner / "icon.icns")], check=True)
    else:
        print(f"Hinweis: kein iconutil, {ordner / 'icon.icns'} wurde nicht erzeugt (auf dem Mac ausführen).", file=sys.stderr)


def main(argv):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--profil", choices=PROFILE, action="append", help="nur dieses Profil (mehrfach möglich); ohne Angabe alle")
    p.add_argument("--quelle", default=str(HIER / "app" / "icons" / "icon.png"), help="Grundsymbol für OS und Studio (grüner Punkt, quadratisch, möglichst 1024 px)")
    p.add_argument("--ziel", default=str(HIER / "app" / "profile" / "icons"))
    p.add_argument("--vorschau", help="das Symbol des Agenten (1024 px) zusätzlich in diese Datei schreiben; daneben entsteht <name>-klein.png")
    p.add_argument("--farbe", type=farbe_lesen, help="Grundfarbe des Agenten-Symbols zum Ausprobieren (#rrggbb oder r,g,b); Vorgabe AGENT_FARBE")
    a = p.parse_args(argv)
    profile = a.profil or list(PROFILE)
    if "agent" in profile:
        gross, klein = agent_symbol(1024, farbe=a.farbe), agent_symbol(1024, fett=True, farbe=a.farbe)
        schreiben(gross, Path(a.ziel) / "agent", klein=klein)
        if a.vorschau:
            ziel = Path(a.vorschau)
            gross.save(ziel)
            klein.save(ziel.with_name(ziel.stem + "-klein.png"))
        print(f"agent: {Path(a.ziel) / 'agent'}")
    rest = [x for x in profile if x != "agent"]
    if rest:
        quelle = Image.open(a.quelle).convert("RGBA")
        if quelle.size[0] < 512:
            sys.exit(f"{a.quelle} ist mit {quelle.size[0]} px zu klein. Abhilfe: ein Grundsymbol mit mindestens 512 px angeben (--quelle).")
        for profil in rest:
            schreiben(umfaerben(quelle, FARBEN[profil]), Path(a.ziel) / profil)
            print(f"{profil}: {Path(a.ziel) / profil}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
