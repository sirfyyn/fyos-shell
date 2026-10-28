"""Tests für tools/selbsttest_ci.py (python3 -m unittest tools/test_selbsttest_ci.py, aus apps/fyos-shell)."""
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import selbsttest_ci as s  # noqa: E402

GUT = {"modus": "selbsttest", "ok": True, "schritte": [
    {"name": "start", "ok": True, "text": "x"}, {"name": "begleiter", "ok": True, "text": "x"}, {"name": "fenster", "ok": True, "text": "x"}]}


class CI(unittest.TestCase):
    def test_einstellungen_haben_den_testserver_als_begleiter(self):
        e = s.einstellungen("python3")
        self.assertEqual(e["begleiter"]["programm"], "python3")
        self.assertIn("testserver.py", e["begleiter"]["args"][0])
        self.assertNotIn("port", e["begleiter"])  # freier Port wird von der Hülle gewählt

    def test_linux_ohne_display_nimmt_xvfb(self):
        with mock.patch.object(s.sys, "platform", "linux"):
            self.assertEqual(s.befehl("/x/app", False)[0], "xvfb-run")
            self.assertEqual(s.befehl("/x/app", True), ["/x/app", "--selbsttest"])
            self.assertEqual(s.befehl("/x/app", False, ohne_xvfb=True), ["/x/app", "--selbsttest"])

    def test_windows_und_mac_ohne_umweg(self):
        for p in ("win32", "darwin"):
            with mock.patch.object(s.sys, "platform", p):
                self.assertEqual(s.befehl("app.exe", False), ["app.exe", "--selbsttest"])

    def test_auswerten(self):
        self.assertTrue(s.auswerten(0, "Warnung\n" + json.dumps(GUT))[0])
        schlecht = dict(GUT, ok=False)
        self.assertFalse(s.auswerten(3, json.dumps(schlecht))[0])
        self.assertFalse(s.auswerten(0, "nur Text")[0])
        ohne_fenster = dict(GUT, schritte=GUT["schritte"][:2])
        self.assertFalse(s.auswerten(0, json.dumps(ohne_fenster))[0])


if __name__ == "__main__":
    unittest.main()
