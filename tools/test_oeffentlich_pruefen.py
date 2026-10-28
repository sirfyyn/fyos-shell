"""Tests für tools/oeffentlich_pruefen.py (python3 -m unittest tools/test_oeffentlich_pruefen.py, aus dem Wurzelordner der Hülle)."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import oeffentlich_pruefen as o  # noqa: E402


def kategorien(rel, text):
    return [k for _, k, _, grund in o.suche(rel, text) if not grund]


class Muster(unittest.TestCase):
    def test_private_rechner_und_netze(self):
        self.assertIn("privater-rechner", kategorien("a.sh", "ssh titan-10g ls"))
        self.assertIn("privater-rechner", kategorien("a.sh", "TrueNAS Brücke"))
        self.assertIn("privates-netz", kategorien("a.py", 'url = "http://192.168.10.1:8080"'))
        self.assertIn("privates-netz", kategorien("a.py", "host 10.0.3.7"))
        self.assertIn("privates-netz", kategorien("a.py", "172.20.1.5"))
        self.assertIn("privates-netz", kategorien("a.py", "nas.lan"))
        self.assertIn("privates-netz", kategorien("a.py", "mein-rechner.tailnet.ts.net"))
        self.assertNotIn("privates-netz", kategorien("a.py", "127.0.0.1 und 172.32.0.1 und 8.8.8.8"))

    def test_namen_dienste_pfade(self):
        self.assertIn("person", kategorien("a.md", "Max hat entschieden"))
        self.assertIn("person", kategorien("a.md", "Bitzer"))
        self.assertNotIn("person", kategorien("a.md", "maximal und Maximum"))
        self.assertIn("interner-dienst", kategorien("a.md", "Ginny-Plugin"))
        self.assertIn("interner-dienst", kategorien("a.md", "hinter Authentik"))
        self.assertIn("interner-dienst", kategorien("a.md", "kubectl apply"))
        self.assertIn("interner-dienst", kategorien("a.md", "Entscheidung Nr. 685"))
        self.assertIn("persoenlicher-pfad", kategorien("a.py", "/Users/maxbitzer/fyos"))
        self.assertIn("persoenlicher-pfad", kategorien("a.py", "C:\\Users\\anna\\x"))
        self.assertIn("persoenlicher-pfad", kategorien("a.py", "/mnt/perf/x"))

    def test_geheimnisse(self):
        self.assertIn("geheimnis", kategorien("a", "-----BEGIN OPENSSH PRIVATE KEY-----"))
        self.assertIn("geheimnis", kategorien("a", "ghp_" + "a" * 30))
        self.assertIn("geheimnis", kategorien("a", "Authorization: Bearer " + "x" * 30))
        self.assertIn("geheimnis", kategorien("a", 'password = "hunter2hunter2"'))
        self.assertNotIn("geheimnis", kategorien("a", 'password = "$ENV_PASSWORT"'))
        self.assertIn("geheimnis", kategorien("a", "untrusted comment: minisign encrypted secret key"))

    def test_interne_adresse_nur_als_konfiguration(self):
        zeile = '"endpoints": ["https://fyos.sirfyyn.de/update/studio/latest.json"]'
        self.assertEqual(kategorien("app/profile/studio.conf.json", zeile), [])
        self.assertIn("interne-adresse", kategorien("app/src/lib.rs", zeile))
        self.assertIn("interne-adresse", kategorien("app/profile/studio.conf.json", "https://fyos.sirfyyn.de/geheim"))

    def test_dateinamen(self):
        self.assertTrue(o.namenstreffer("testschluessel/studio.key"))
        self.assertTrue(o.namenstreffer(".env"))
        self.assertEqual(o.namenstreffer("app/profile/studio.pub"), [])


class Baum(unittest.TestCase):
    def test_pruefe_findet_treffer_mit_zeile_und_ueberspringt_pub_und_binaer(self):
        with tempfile.TemporaryDirectory() as t:
            w = Path(t)
            (w / "a.md").write_text("sauber\nSSH nach titan\n", encoding="utf-8")
            (w / "schluessel.pub").write_text("dW50cnVzdGVk titan\n")
            (w / "bild.bin").write_bytes(b"\0\0titan\0")
            (w / "node_modules").mkdir()
            (w / "node_modules" / "x.js").write_text("titan")
            (w / "geheim.key").write_text("irgendwas")
            treffer = {(h["datei"], h["zeile"]) for h in o.pruefe(w)}
            self.assertEqual(treffer, {("a.md", 2), ("geheim.key", 0)})

    def test_ausgang(self):
        with tempfile.TemporaryDirectory() as t:
            (Path(t) / "ok.md").write_text("alles sauber\n")
            self.assertEqual(o.main([t]), 0)
            (Path(t) / "schlecht.md").write_text("Ginny\n")
            self.assertEqual(o.main([t]), 1)


if __name__ == "__main__":
    unittest.main()
