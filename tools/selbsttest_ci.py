#!/usr/bin/env python3
"""Selbsttest der gebauten Hülle auf jedem System (Linux, macOS, Windows), ohne Signierung und ohne Konto. Nur Standardbibliothek.

  python3 tools/selbsttest_ci.py <Programm> [--ohne-xvfb] [--buendel]

Legt einen Wegwerf-Datenordner an, trägt den Test-Server (tools/testserver.py studio) als Begleiter ein, startet `<Programm> --selbsttest`
(unter Linux ohne DISPLAY mit `xvfb-run -a` und `dbus-run-session`) und wertet die JSON-Zeile aus: Begleiter gesund mit Kennung,
Seite gezeichnet, Rust-Befehl antwortet. Ausgang 0 = gut. Mit `--buendel` wird kein Begleiter eingetragen: die Hülle muss das ECHTE Studio aus dem
Python-Bündel starten (`tools/buendel_bauen.py` hat es nach app/resources gebaut; `FYOS_SHELL_RESSOURCEN` zeigt der ungepackten Hülle den Ordner).
Ausgang 0 = gut. Das ist der Prüfschritt des CI-Entwurfs (apps/fyos-shell/ci).
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

TOOLS = Path(__file__).resolve().parent


def einstellungen(python=None, buendel=False):
    """Die Einstellungen für den Test: Begleiter ist der Test-Server, Port und Kennung bestimmt die Hülle. Mit `buendel` kein Begleiter:
    dann gilt das Python-Bündel (das echte Studio)."""
    if buendel:
        return {"schema": 1}
    return {"schema": 1, "begleiter": {"programm": python or sys.executable, "frist_s": 30, "env": {},
                                       "args": [str(TOOLS / "testserver.py"), "studio", "--version", "4.0.0-test"]}}


def befehl(programm, hat_display, ohne_xvfb=False):
    """Kommandozeile des Selbsttests; unter Linux ohne Bildschirm mit virtuellem."""
    if sys.platform.startswith("linux") and not hat_display and not ohne_xvfb:
        return ["xvfb-run", "-a", "-s", "-screen 0 1280x800x24", "dbus-run-session", "--", str(programm), "--selbsttest"]
    return [str(programm), "--selbsttest"]


def auswerten(code, stdout, buendel=False):
    """(ok, Text) aus Ausgang und letzter JSON-Zeile."""
    zeilen = [z for z in stdout.splitlines() if z.startswith("{")]
    if not zeilen:
        return False, f"keine JSON-Ausgabe, Ausgang {code}"
    aus = json.loads(zeilen[-1])
    schritte = {s["name"]: s for s in aus.get("schritte", [])}
    gut = code == 0 and aus.get("ok") is True and all(schritte.get(n, {}).get("ok") for n in ("start", "begleiter", "fenster"))
    if buendel:  # das echte Studio aus dem Bündel, nicht der Test-Server
        gut = gut and "Quelle: Bündel" in schritte.get("begleiter", {}).get("text", "") and "fle-studio" in schritte["begleiter"]["text"]
    return gut, json.dumps(aus, ensure_ascii=False)


def main(argv):
    if not argv or argv[0].startswith("-"):
        sys.exit(__doc__)
    programm = Path(argv[0])
    if not programm.is_file():
        sys.exit(f"{programm} gibt es nicht. Abhilfe: erst bauen (tools/bauen.py <profil> --debug).")
    with tempfile.TemporaryDirectory(prefix="selbsttest-") as t:
        daten = Path(t)
        buendel = "--buendel" in argv
        (daten / "einstellungen.json").write_text(json.dumps(einstellungen(buendel=buendel)), encoding="utf-8")
        env = dict(os.environ, FYOS_SHELL_DATEN=str(daten))
        if buendel:
            env["FYOS_SHELL_RESSOURCEN"] = str(Path(__file__).resolve().parent.parent / "app" / "resources")
        r = subprocess.run(befehl(programm, bool(os.environ.get("DISPLAY")), "--ohne-xvfb" in argv), capture_output=True, text=True, env=env, timeout=300)
    gut, text = auswerten(r.returncode, r.stdout, buendel)
    print(("[ok] " if gut else "[FEHLER] ") + text)
    if not gut:
        print(r.stderr[-800:], file=sys.stderr)
    return 0 if gut else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
