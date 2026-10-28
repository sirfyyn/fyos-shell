"""Tests für tools/pruefsummen.py (python3 -m unittest tools/test_pruefsummen.py, aus apps/fyos-shell)."""
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pruefsummen as p  # noqa: E402


class Summen(unittest.TestCase):
    def test_zeilenformat_und_pruefen(self):
        with tempfile.TemporaryDirectory() as t:
            a = Path(t) / "a.bin"
            a.write_bytes(b"inhalt")
            zeile = p.zeilen([a])[0]
            self.assertEqual(zeile, f"{hashlib.sha256(b'inhalt').hexdigest()}  a.bin")
            liste = Path(t) / "SHA256SUMS"
            liste.write_text(zeile + "\n")
            self.assertEqual(p.pruefen(liste), [])
            a.write_bytes(b"verfaelscht")
            self.assertEqual(p.pruefen(liste), ["a.bin: Prüfsumme stimmt nicht"])
            a.unlink()
            self.assertEqual(p.pruefen(liste), ["a.bin: Datei fehlt"])


if __name__ == "__main__":
    unittest.main()
