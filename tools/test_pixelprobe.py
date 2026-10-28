"""Tests für tools/pixelprobe.py (python3 -m unittest tools/test_pixelprobe.py, aus apps/fyos-shell)."""
import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pixelprobe as p  # noqa: E402


def xwd(breite, hoehe, farbe_von):
    """Baut einen XWD-Abzug (32 Bit, little endian, Masken 0xff0000/0xff00/0xff) aus farbe_von(x, y) -> (r, g, b)."""
    kopf = [0] * 25
    kopf[0], kopf[1], kopf[2], kopf[3], kopf[4], kopf[5] = 100, 7, 2, 24, breite, hoehe
    kopf[7], kopf[11], kopf[12] = 0, 32, breite * 4
    kopf[14], kopf[15], kopf[16], kopf[19] = 0xFF0000, 0x00FF00, 0x0000FF, 0
    roh = bytearray(struct.pack(p.KOPF, *kopf))
    for y in range(hoehe):
        for x in range(breite):
            r, g, b = farbe_von(x, y)
            roh += struct.pack("<I", (r << 16) | (g << 8) | b)
    return bytes(roh)


class Probe(unittest.TestCase):
    def test_weisses_fenster_faellt_durch(self):
        b, h, px = p.lies_xwd(xwd(40, 30, lambda x, y: (255, 255, 255)))
        e = p.analysiere(px)
        self.assertFalse(e["sichtbar"])
        self.assertEqual((b, h, e["farben"]), (40, 30, 1))

    def test_schwarzes_und_einfarbiges_faellt_durch(self):
        for farbe in ((0, 0, 0), (200, 30, 30)):
            _, _, px = p.lies_xwd(xwd(20, 20, lambda x, y, f=farbe: f))
            self.assertFalse(p.analysiere(px)["sichtbar"], farbe)

    def test_seite_mit_text_besteht(self):
        # weiße Fläche mit "Text": dunkle Streifen und Grautöne (Kantenglättung)
        def farbe(x, y):
            if y % 6 in (2, 3) and x % 5 < 3:
                return (20, 20, 20)
            if y % 6 == 4 and x % 5 == 3:
                return (140, 140, 140)
            return (255, 255, 255)
        _, _, px = p.lies_xwd(xwd(60, 40, farbe))
        e = p.analysiere(px)
        self.assertTrue(e["sichtbar"], e)
        self.assertGreater(e["dunkel"], 0)

    def test_wenig_text_auf_heller_seite_besteht_aber_ein_fleck_nicht(self):
        # 97 % Hintergrund, 3 % Text (wie die echte Seite der Hülle): sichtbar
        spaerlich = [(255, 255, 255)] * 970 + [(20, 20, 20)] * 20 + [(150, 150, 150)] * 10
        self.assertTrue(p.analysiere(spaerlich)["sichtbar"])
        # 99,9 % Hintergrund und ein einzelner dunkler Punkt: kein Inhalt
        fleck = [(255, 255, 255)] * 9990 + [(20, 20, 20)] * 5 + [(150, 150, 150)] * 5
        self.assertFalse(p.analysiere(fleck)["sichtbar"])

    def test_dunkles_theme_mit_hellem_text_besteht(self):
        def farbe(x, y):
            return (230, 235, 240) if (y % 4 == 1 and x % 3 == 0) else ((25, 28, 32) if (x + y) % 7 else (60, 70, 90))
        _, _, px = p.lies_xwd(xwd(50, 30, farbe))
        self.assertTrue(p.analysiere(px)["sichtbar"])

    def test_ausschnitt_schneidet_das_fenster_aus_dem_vollbild(self):
        # schwarzer Bildschirm mit weißem Fenster 10x10 bei (5, 5): der Ausschnitt ist einfarbig weiß, das Vollbild nicht
        def farbe(x, y):
            return (255, 255, 255) if 5 <= x < 15 and 5 <= y < 15 else (0, 0, 0)
        b, h, px = p.lies_xwd(xwd(40, 30, farbe))
        fenster = p.ausschnitt(b, h, px, 5, 5, 10, 10)
        self.assertEqual(len(fenster), 100)
        self.assertEqual(p.analysiere(fenster)["farben"], 1)
        self.assertEqual(p.analysiere(px)["farben"], 2)
        self.assertEqual(len(p.ausschnitt(b, h, px, 35, 25, 20, 20)), 25)  # am Rand abgeschnitten
        self.assertEqual(p.ausschnitt(b, h, px, 100, 100, 5, 5), [])

    def test_kaputte_abzuege(self):
        with self.assertRaises(ValueError):
            p.lies_xwd(b"zu kurz")
        gut = xwd(10, 10, lambda x, y: (1, 2, 3))
        with self.assertRaises(ValueError):
            p.lies_xwd(gut[:-40])
        self.assertFalse(p.analysiere([])["sichtbar"])


if __name__ == "__main__":
    unittest.main()
