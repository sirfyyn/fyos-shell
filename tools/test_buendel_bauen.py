"""Tests für tools/buendel_bauen.py (python3 -m unittest tools/test_buendel_bauen.py, aus apps/fyos-shell). Ohne Netz."""
import hashlib
import io
import json
import os
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import buendel_bauen as b  # noqa: E402


def archiv(pfad, dateien, links=()):
    with tarfile.open(pfad, "w:gz") as t:
        for name, inhalt in dateien.items():
            info = tarfile.TarInfo(name)
            info.size = len(inhalt)
            t.addfile(info, io.BytesIO(inhalt))
        for name, ziel in links:
            info = tarfile.TarInfo(name)
            info.type = tarfile.SYMTYPE
            info.linkname = ziel
            t.addfile(info)


class Sperrdatei(unittest.TestCase):
    def test_die_echte_sperrdatei_ist_vollstaendig_und_festgenagelt(self):
        lock = b.lock_lesen()
        self.assertEqual(set(lock["python"]["systeme"]), {"macos-aarch64", "macos-x86_64", "linux-x86_64", "windows-x86_64"})
        for eintrag in lock["python"]["systeme"].values():
            self.assertTrue(eintrag["url"].startswith("https://github.com/astral-sh/python-build-standalone/releases/download/20261026/"))
            self.assertIn(lock["python"]["version"], eintrag["url"].replace("%2B", "+"))
        self.assertEqual(lock["python"]["systeme"]["windows-x86_64"]["interpreter"], "python/python.exe")
        self.assertEqual(lock["studio"]["commit"], lock["studio"]["url"].rsplit("/", 1)[1])

    def test_kaputte_sperrdatei_nennt_alle_fehler(self):
        with tempfile.TemporaryDirectory() as t:
            lock = json.loads(b.LOCK.read_text())
            lock["python"]["systeme"]["linux-x86_64"]["sha256"] = "zu kurz"
            lock["python"]["systeme"]["macos-aarch64"]["url"] = "http://unsicher/x"
            lock["studio"]["inhalt_sha256"] = "PLATZHALTER"
            pfad = Path(t) / "lock.json"
            pfad.write_text(json.dumps(lock))
            with self.assertRaises(b.Abbruch) as c:
                b.lock_lesen(pfad)
            text = str(c.exception)
            for teil in ("python/linux-x86_64: sha256", "python/macos-aarch64: url ist nicht https", "studio: inhalt_sha256"):
                self.assertIn(teil, text)


class System(unittest.TestCase):
    def test_system_id(self):
        self.assertEqual(b.system_id("Darwin", "arm64"), "macos-aarch64")
        self.assertEqual(b.system_id("Darwin", "x86_64"), "macos-x86_64")
        self.assertEqual(b.system_id("Linux", "x86_64"), "linux-x86_64")
        self.assertEqual(b.system_id("Windows", "AMD64"), "windows-x86_64")
        with self.assertRaises(b.Abbruch):
            b.system_id("Plan9", "mips")


class Archive(unittest.TestCase):
    def test_entpacken_normal(self):
        with tempfile.TemporaryDirectory() as t:
            a = Path(t) / "a.tar.gz"
            archiv(a, {"python/bin/python3.11": b"x"}, links=[("python/bin/python3", "python3.11")])
            b.sicher_entpacken(a, Path(t) / "ziel")
            self.assertTrue((Path(t) / "ziel/python/bin/python3.11").is_file())

    def test_entpacken_verweigert_pfade_und_links_nach_aussen(self):
        with tempfile.TemporaryDirectory() as t:
            for name, links in (("../boese", []), ("/etc/boese", [])):
                a = Path(t) / "a.tar.gz"
                archiv(a, {name: b"x"})
                with self.assertRaises(b.Abbruch, msg=name):
                    b.sicher_entpacken(a, Path(t) / "ziel")
            a = Path(t) / "l.tar.gz"
            archiv(a, {}, links=[("link", "../../etc/passwd")])
            with self.assertRaises(b.Abbruch):
                b.sicher_entpacken(a, Path(t) / "ziel2")
            self.assertFalse((Path(t) / "boese").exists())

    def test_herunterladen_prueft_die_summe_und_nutzt_den_cache(self):
        with tempfile.TemporaryDirectory() as t:
            quelle = Path(t) / "q.tar.gz"
            archiv(quelle, {"a": b"inhalt"})
            summe = b.sha256_datei(quelle)
            cache = Path(t) / "cache"
            ziel = b.herunterladen(quelle.as_uri(), summe, cache)
            self.assertEqual(b.sha256_datei(ziel), summe)
            quelle.unlink()  # zweiter Aufruf kommt aus dem Cache
            self.assertEqual(b.herunterladen(quelle.as_uri(), summe, cache), ziel)
            falsch = Path(t) / "f.tar.gz"
            archiv(falsch, {"a": b"anderer inhalt"})
            with self.assertRaises(b.Abbruch) as c:
                b.herunterladen(falsch.as_uri(), "0" * 64, Path(t) / "cache2")
            self.assertIn("Prüfsumme", str(c.exception))
            self.assertFalse(list((Path(t) / "cache2").glob("*.tar.gz")), "nichts Falsches im Cache")


class Baum(unittest.TestCase):
    def test_baum_hash_ist_stabil_und_inhaltsabhaengig(self):
        with tempfile.TemporaryDirectory() as t:
            w = Path(t)
            (w / "src").mkdir()
            (w / "src" / "a.py").write_text("eins")
            (w / "LICENSE").write_text("mit")
            h1 = b.baum_hash(w, ["src", "LICENSE"])
            (w / "src" / "__pycache__").mkdir()
            (w / "src" / "__pycache__" / "a.pyc").write_text("egal")
            self.assertEqual(b.baum_hash(w, ["src", "LICENSE"]), h1, "__pycache__ zählt nicht")
            (w / "src" / "a.py").write_text("zwei")
            self.assertNotEqual(b.baum_hash(w, ["src", "LICENSE"]), h1)

    def test_stutzen_entfernt_unnoetiges_und_loest_links_auf(self):
        with tempfile.TemporaryDirectory() as t:
            w = Path(t)
            (w / "python/bin").mkdir(parents=True)
            (w / "python/bin/python3.11").write_text("x")
            os.symlink("python3.11", w / "python/bin/python3")
            (w / "python/bin/pip3").write_text("x")
            for d in ("lib/python3.11/idlelib", "lib/python3.11/tkinter", "lib/python3.11/site-packages", "lib/tcl8.6", "share/man", "include"):
                (w / "python" / d).mkdir(parents=True)
                (w / "python" / d / "x").write_text("x")
            (w / "python/lib/python3.11/os.py").write_text("import")
            b.stutzen(w)
            self.assertTrue((w / "python/bin/python3.11").is_file())
            self.assertTrue((w / "python/lib/python3.11/os.py").is_file(), "Standardbibliothek bleibt")
            for weg in ("python/bin/python3", "python/bin/pip3", "python/lib/python3.11/idlelib", "python/lib/python3.11/tkinter", "python/lib/tcl8.6", "python/share", "python/include"):
                self.assertFalse((w / weg).exists() or (w / weg).is_symlink(), weg)

    def test_dist_info_genuegt_fuer_entry_points(self):
        with tempfile.TemporaryDirectory() as t:
            d = b.dist_info_schreiben(t, "fle-studio", "0.4.1", {"fle_studio.plugins": {"forge": "fle_studio_forge:register"}}, "MIT-Text", "kurz")
            self.assertEqual(d.name, "fle_studio-0.4.1.dist-info")
            self.assertIn("Version: 0.4.1", (d / "METADATA").read_text())
            self.assertIn("[fle_studio.plugins]\nforge = fle_studio_forge:register", (d / "entry_points.txt").read_text())
            # importlib.metadata findet die Verteilung und ihre Entry Points aus diesem Ordner
            code = ("import sys; sys.path.insert(0, sys.argv[1])\nfrom importlib import metadata\n"
                    "eps = metadata.entry_points()\n"
                    "gruppe = eps.select(group='fle_studio.plugins') if hasattr(eps, 'select') else eps.get('fle_studio.plugins', [])\n"
                    "print([e.name for e in gruppe], metadata.version('fle-studio'))")
            import subprocess
            r = subprocess.run([sys.executable, "-c", code, t], capture_output=True, text=True)
            self.assertEqual(r.stdout.strip(), "['forge'] 0.4.1", r.stderr)


@unittest.skipUnless(sys.version_info >= (3, 11), "tomllib braucht Python 3.11 (der Bau benutzt dafür den gebündelten Interpreter)")
class Studio(unittest.TestCase):
    def test_studio_bauen_aus_einem_quellbaum(self):
        with tempfile.TemporaryDirectory() as t:
            q = Path(t) / "q"
            (q / "src" / "fle_studio").mkdir(parents=True)
            (q / "src" / "fle_studio" / "__init__.py").write_text('__version__ = "1.2.3"\n')
            (q / "src" / "fle_studio_x").mkdir()
            (q / "src" / "fle_studio_x" / "__init__.py").write_text("def register(c): pass\n")
            (q / "LICENSE").write_text("MIT")
            (q / "pyproject.toml").write_text(
                '[project]\nname = "fle-studio"\ndescription = "d"\n[project.scripts]\nfle-studio = "fle_studio.__main__:main"\n'
                '[project.entry-points."fle_studio.plugins"]\nx = "fle_studio_x:register"\n'
                '[tool.hatch.version]\npath = "src/fle_studio/__init__.py"\n'
                '[tool.hatch.build.targets.wheel]\npackages = ["src/fle_studio", "src/fle_studio_x"]\n')
            ziel = Path(t) / "z"
            version, pakete = b.studio_bauen(q, ziel, sys.executable, {"version": "1.2.3"})
            self.assertEqual((version, pakete), ("1.2.3", ["fle_studio", "fle_studio_x"]))
            self.assertTrue((ziel / "fle_studio_x" / "__init__.py").is_file())
            eintraege = (ziel / "fle_studio-1.2.3.dist-info" / "entry_points.txt").read_text()
            self.assertIn("x = fle_studio_x:register", eintraege)
            self.assertIn("[console_scripts]", eintraege)
            with self.assertRaises(b.Abbruch):
                b.studio_bauen(q, Path(t) / "z2", sys.executable, {"version": "9.9.9"})


if __name__ == "__main__":
    unittest.main()
