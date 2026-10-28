#!/usr/bin/env python3
"""Prüft einen Baum vor der Veröffentlichung auf Privates (nur Standardbibliothek, nur lesend).

  python3 tools/oeffentlich_pruefen.py [WURZEL] [--json] [--ausnahmen]

Sucht in allen Textdateien (ohne .git, node_modules, target, Binärdateien, Sperrdateien) nach:
  - privaten Rechnern und Netzen (Titan, TrueNAS, 192.168.*, 10.*, 172.16-31.*, .lan, Tailscale, interne Gitea-Adresse)
  - Namen der Betreiber und interner Dienste (Max/Bitzer/Anna, Ginny, Authentik, MCP-Hub, k8s)
  - persönlichen Pfaden (/Users/<name>, /home/<name>, C:\\Users\\<name>)
  - Geheimnissen (private Schlüssel, Tokens, Passwörter, Bearer-Köpfe, private Minisign-Schlüsseldateien)
  - der internen Update-Adresse fyos.sirfyyn.de, wenn sie NICHT als Profil-Konfiguration oder Platzhalter vorkommt
Jeder Treffer erscheint als `Datei:Zeile: [Kategorie] Text`. Öffentliche Schlüssel (.pub) sind in Ordnung. Ausgang 0 = kein offener Treffer,
1 = es gibt offene Treffer. `--ausnahmen` zeigt zusätzlich die bewusst erlaubten Treffer samt Begründung.

Ausgenommen sind dieses Werkzeug und sein Test (sie enthalten die Suchmuster selbst).
"""
import json
import os
import re
import sys
from pathlib import Path

# (Kategorie, Muster, ohne Beachtung der Groß-/Kleinschreibung?)
MUSTER = [
    ("privater-rechner", r"\btitan(-10g|-lan)?\b", True),
    ("privater-rechner", r"\btruenas\b", True),
    ("privates-netz", r"\b192\.168\.\d{1,3}\.\d{1,3}\b", False),
    ("privates-netz", r"\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", False),
    ("privates-netz", r"\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b", False),
    ("privates-netz", r"\b[\w-]+\.lan\b", True),
    ("privates-netz", r"tailscale|\.ts\.net|\bheadscale\b", True),
    ("interner-dienst", r"git\.sirfyyn\.de|gitea\.sirfyyn", True),
    ("interner-dienst", r"\bginny\b", True),
    ("interner-dienst", r"\bauthentik\b", True),
    ("interner-dienst", r"\bmcp[-_ ]?hub\b", True),
    ("interner-dienst", r"\bk8s\b|kubectl|kubernetes|\bflux\b", True),
    ("interner-dienst", r"entscheidungsbuch|Entscheidung(en)?\s+(Nr\.?\s*)?\d{3}\b|\bNr\.\s*\d{3}\b", True),
    ("person", r"\bMax\b|Bitzer|\bAnna\b", False),
    ("persoenlicher-pfad", r"/Users/[A-Za-z0-9._-]+|/home/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+", False),
    ("persoenlicher-pfad", r"/mnt/(perf|fastmodels|Files)\b", False),
    ("geheimnis", r"-----BEGIN [A-Z ]*PRIVATE KEY-----", False),
    ("geheimnis", r"\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bglpat-[A-Za-z0-9_-]{15,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b", False),
    ("geheimnis", r"Bearer\s+[A-Za-z0-9._~+/=-]{20,}", False),
    ("geheimnis", r"(token|passwort|password|secret|api[_-]?key)\s*[:=]\s*[\"'][^\"'$<{][^\"']{7,}[\"']", True),
    ("geheimnis", r"untrusted comment: (minisign|rsign) encrypted secret key", True),
    ("interne-adresse", r"fyos\.sirfyyn\.de", True),
]

# Bewusst erlaubt: (Pfadmuster, Kategorie, Muster auf der Zeile, Begründung)
AUSNAHMEN = [
    (r"^app/profile/[a-z]+\.conf\.json$", "interne-adresse", r"https://fyos\.sirfyyn\.de/update/(studio|agent|os)/latest\.json",
     "Update-Adresse je Profil: Konfiguration, kein Geheimnis; die App holt Updates von dort"),
    (r"^crates/shell-core/src/profil\.rs$|^app/src/zustand\.rs$", "interne-adresse", r"https://fyos\.sirfyyn\.de/os\b",
     "Vorgabe der Start-URL des Profils os (die Weboberfläche des Projekts), Konfiguration pro Profil; Nutzer können sie in den Einstellungen ändern"),
    # Erfundene Werte, an denen das Schwärzen und die Pfadlogik geprüft werden (Tests und e2e); keine echten Daten.
    (r"^crates/shell-core/src/(bericht|autostart)\.rs$|^tools/e2e_update\.py$", "geheimnis", r"abcdefghijklmnop\d+|ghp_abcdefghijklmnopqrstuv|AKIAABCDEFGHIJKLMNOP|hf_AbCdEfGhIjKlMn123",
     "Testwerte für das Schwärzen (erfunden)"),
    (r"^crates/shell-core/src/(bericht|autostart)\.rs$", "persoenlicher-pfad", r"/Users/(anna|maxm)|/home/(x|anna)|C:\\\\Users\\\\Bob",
     "erfundene Pfade für Tests der Pfadlogik und des Schwärzens"),
    (r"^crates/shell-core/src/(navigation|netz)\.rs$|^app/src/os\.rs$", "interne-adresse", r"(fyos|auth)\.sirfyyn\.de",
     "Standard-Hosts des Profils os (Konfiguration: der Server und sein Anmeldeserver) und Tests der Navigationssperre und Fehlerklassen gegen diese Namen"),
    (r"^tools/bauen\.py$", "interne-adresse", r"https://fyos\.sirfyyn\.de/update/<profil>/latest\.json",
     "Dokumentation der Update-Adresse je Profil (siehe app/profile/*.conf.json)"),
    (r"^app/capabilities/os-meldungen\.json$|^app/src/mitteilung\.rs$", "interne-adresse", r"https://fyos\.sirfyyn\.de/\*",
     "Capability des Profils os: der Befehl für Systemmitteilungen gilt nur für Seiten des Servers (Konfiguration und ihr Test)"),
]

SKIP_ORDNER = {".git", "node_modules", "target", "__pycache__", "gen", "dist-linux", "lauf-linux", "daten-linux", "testschluessel"}
SKIP_DATEIEN = {"Cargo.lock", "package-lock.json", "oeffentlich_pruefen.py", "test_oeffentlich_pruefen.py"}
SKIP_ENDUNGEN = {".png", ".icns", ".ico", ".jpg", ".jpeg", ".gif", ".woff", ".woff2", ".pub", ".xwd", ".tar", ".gz", ".zip"}
MAX_BYTES = 2_000_000


def textdatei(pfad):
    if pfad.name in SKIP_DATEIEN or pfad.suffix in SKIP_ENDUNGEN:
        return None
    try:
        if pfad.stat().st_size > MAX_BYTES:
            return None
        roh = pfad.read_bytes()
    except OSError:
        return None
    if b"\0" in roh[:4096]:
        return None
    return roh.decode("utf-8", errors="replace")


def namenstreffer(rel):
    """Dateinamen, die nie in ein öffentliches Repo gehören (private Schlüssel, Umgebungsdateien)."""
    name = Path(rel).name
    if name.endswith(".key") or name in (".env", "id_rsa", "id_ed25519") or name.startswith(".env."):
        return [("geheimnis", f"Datei {name} sieht nach einem privaten Schlüssel oder einer Umgebungsdatei aus")]
    return []


def suche(rel, text):
    """Treffer einer Datei: Liste von (zeile, kategorie, text, ausnahme_begruendung_oder_None)."""
    treffer = []
    for nr, zeile in enumerate(text.splitlines(), 1):
        for kategorie, muster, ohne_gross in MUSTER:
            m = re.search(muster, zeile, re.IGNORECASE if ohne_gross else 0)
            if not m:
                continue
            grund = None
            for pfad_re, kat, zeilen_re, begruendung in AUSNAHMEN:
                if kat == kategorie and re.search(pfad_re, rel) and re.search(zeilen_re, zeile):
                    grund = begruendung
                    break
            treffer.append((nr, kategorie, zeile.strip()[:160], grund))
    return treffer


def pruefe(wurzel):
    wurzel = Path(wurzel)
    ergebnis = []
    for ordner, unterordner, dateien in os.walk(wurzel):
        unterordner[:] = [u for u in unterordner if u not in SKIP_ORDNER]
        for name in sorted(dateien):
            pfad = Path(ordner) / name
            rel = pfad.relative_to(wurzel).as_posix()
            for kat, text in namenstreffer(rel):
                ergebnis.append({"datei": rel, "zeile": 0, "kategorie": kat, "text": text, "ausnahme": None})
            inhalt = textdatei(pfad)
            if inhalt is None:
                continue
            for nr, kat, text, grund in suche(rel, inhalt):
                ergebnis.append({"datei": rel, "zeile": nr, "kategorie": kat, "text": text, "ausnahme": grund})
    return ergebnis


def main(argv):
    wurzel = next((a for a in argv if not a.startswith("--")), ".")
    treffer = pruefe(wurzel)
    offen = [t for t in treffer if not t["ausnahme"]]
    erlaubt = [t for t in treffer if t["ausnahme"]]
    if "--json" in argv:
        print(json.dumps({"offen": offen, "erlaubt": erlaubt}, ensure_ascii=False, indent=1))
    else:
        for t in offen:
            print(f"{t['datei']}:{t['zeile']}: [{t['kategorie']}] {t['text']}")
        if "--ausnahmen" in argv:
            for t in erlaubt:
                print(f"{t['datei']}:{t['zeile']}: [erlaubt: {t['kategorie']}] {t['ausnahme']}")
        print(f"\n{len(offen)} offene Treffer, {len(erlaubt)} bewusst erlaubt")
    return 1 if offen else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
