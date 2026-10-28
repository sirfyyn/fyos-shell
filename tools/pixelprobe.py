#!/usr/bin/env python3
"""Pixelprobe für Fenster-Abzüge im XWD-Format (`xwd -id <fenster> -out datei`; nur Standardbibliothek).

Der Selbsttest der Hülle beweist, dass die Seite JavaScript ausführt. Diese Probe beweist, dass im Fenster **etwas zu sehen ist**:
ein weißes oder einfarbiges Fenster (das bekannte WebKitGTK-Weißbild) fällt durch, eine Seite mit Text und Knöpfen besteht.

  pixelprobe.py abzug.xwd        druckt eine JSON-Zeile mit den Maßen, Ausgang 0 = es ist etwas zu sehen, 1 = leer/einfarbig
"""
import json
import struct
import sys

KOPF = ">25I"


def lies_xwd(daten):
    """(breite, hoehe, pixel) aus einem 32-Bit-TrueColor-XWD; pixel = Liste von (r, g, b)."""
    if len(daten) < 100:
        raise ValueError("zu kurz für einen XWD-Abzug")
    k = struct.unpack(KOPF, daten[:100])
    kopf_len, version, _fmt, tiefe, breite, hoehe = k[0], k[1], k[2], k[3], k[4], k[5]
    byteorder, bpp, bytes_je_zeile = k[7], k[11], k[12]
    rmask, gmask, bmask, ncolors = k[14], k[15], k[16], k[19]
    if version != 7:
        raise ValueError(f"XWD-Version {version} nicht unterstützt")
    if bpp != 32 or tiefe not in (24, 32):
        raise ValueError(f"nur 32 Bit je Pixel unterstützt (gefunden {bpp} Bit, Tiefe {tiefe})")
    ab = kopf_len + ncolors * 12
    ende = ">" if byteorder == 1 else "<"
    pixel = []
    for y in range(hoehe):
        zeile = daten[ab + y * bytes_je_zeile: ab + y * bytes_je_zeile + breite * 4]
        if len(zeile) < breite * 4:
            raise ValueError("Abzug ist abgeschnitten")
        for (wort,) in struct.iter_unpack(ende + "I", zeile):
            pixel.append((_kanal(wort, rmask), _kanal(wort, gmask), _kanal(wort, bmask)))
    return breite, hoehe, pixel


def _kanal(wort, maske):
    if not maske:
        return 0
    schieb = (maske & -maske).bit_length() - 1
    return (wort & maske) >> schieb


def ausschnitt(breite, hoehe, pixel, x, y, w, h):
    """Rechteck (x, y, w, h) aus einem Vollbild, am Rand abgeschnitten (negative Ursprünge erlaubt)."""
    x0, y0 = max(x, 0), max(y, 0)
    x1, y1 = min(x + w, breite), min(y + h, hoehe)
    if x1 <= x0 or y1 <= y0:
        return []
    return [pixel[zeile * breite + spalte] for zeile in range(y0, y1) for spalte in range(x0, x1)]


def analysiere(pixel):
    """Maße eines Bildes. 'sichtbar' = mindestens 3 verschiedene Farben UND der häufigste Farbton deckt höchstens 99,5 % ab (eine helle Seite mit wenig Text ist zu rund 97 % Hintergrund)
    UND es gibt dunkle und helle Pixel (Text auf Fläche). Ein weißes, schwarzes oder einfarbiges Fenster besteht nicht."""
    n = len(pixel)
    if n == 0:
        return {"pixel": 0, "farben": 0, "haeufigster_anteil": 1.0, "dunkel": 0, "hell": 0, "sichtbar": False}
    zaehler = {}
    dunkel = hell = 0
    for p in pixel:
        zaehler[p] = zaehler.get(p, 0) + 1
        lum = (p[0] * 299 + p[1] * 587 + p[2] * 114) // 1000
        if lum < 100:
            dunkel += 1
        elif lum > 160:
            hell += 1
    haeufigster = max(zaehler.values()) / n
    sichtbar = len(zaehler) >= 3 and haeufigster <= 0.995 and dunkel > 0 and hell > 0
    return {"pixel": n, "farben": len(zaehler), "haeufigster_anteil": round(haeufigster, 4), "dunkel": dunkel, "hell": hell, "sichtbar": sichtbar}


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    with open(sys.argv[1], "rb") as f:
        breite, hoehe, pixel = lies_xwd(f.read())
    ergebnis = analysiere(pixel)
    ergebnis.update(breite=breite, hoehe=hoehe)
    print(json.dumps(ergebnis))
    sys.exit(0 if ergebnis["sichtbar"] else 1)


if __name__ == "__main__":
    main()
