#!/usr/bin/env python3
"""SHA-256-Prüfsummen für Release-Dateien (gleiches Format wie `sha256sum`; läuft auf jedem System, nur Standardbibliothek).

  python3 tools/pruefsummen.py Datei... > SHA256SUMS
  python3 tools/pruefsummen.py --pruefen SHA256SUMS      prüft die Dateien neben der Liste, Ausgang 0 = alle stimmen
"""
import hashlib
import sys
from pathlib import Path


def summe(pfad):
    h = hashlib.sha256()
    with open(pfad, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def zeilen(dateien):
    return [f"{summe(p)}  {Path(p).name}" for p in dateien]


def pruefen(liste):
    liste = Path(liste)
    fehler = []
    for zeile in liste.read_text(encoding="utf-8").splitlines():
        if not zeile.strip():
            continue
        erwartet, _, name = zeile.partition("  ")
        pfad = liste.parent / name
        if not pfad.is_file():
            fehler.append(f"{name}: Datei fehlt")
        elif summe(pfad) != erwartet:
            fehler.append(f"{name}: Prüfsumme stimmt nicht")
    return fehler


def main(argv):
    if argv and argv[0] == "--pruefen" and len(argv) == 2:
        fehler = pruefen(argv[1])
        print("\n".join(fehler) if fehler else "alle Prüfsummen stimmen")
        return 1 if fehler else 0
    if not argv or argv[0].startswith("-"):
        sys.exit(__doc__)
    print("\n".join(zeilen(argv)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
