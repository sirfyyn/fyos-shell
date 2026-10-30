#!/usr/bin/env python3
"""Runner-Attrappe für die Prüfung des Profils agent (nur Standardbibliothek, nur Loopback, kein echter Runner, keine Daten).

  runner_attrappe.py [--port N] [--log DATEI] [--token T] [--tempo S] [--ohne-ordner]

Spricht den Teil der Runner-Schnittstelle, den die Chat-Seite und die Seitenleiste brauchen:
  GET  /api/health, /api/konfiguration, /api/modelle, /api/freigaben, /api/laeufe
  GET  /api/gespraeche                    Sitzungsliste (Sitzung 1 Hauptgespräch, Sitzung 2 in einem anderen Arbeitsbereich); ohne Parameter ohne Archivierte,
                                          ?archiv=1 nur Archivierte, ?archiv=alle beide; jedes Gespräch trägt `archiviert`
  GET  /api/suche?q=&limit=&archiv=       Suche über Titel und sichtbaren Verlauf: {ok, treffer: [{id, titel, archiviert, aktualisiert, ausschnitt, start, laenge,
                                          markierungen, zahl, quelle}], abgeschnitten, durchsucht, gesamt}; q mindestens 2 Zeichen (sonst 400 {ok: false, fehler})
  GET  /api/modelle                       je Modell `contextWindow`; usage.context = {tokens, window} in /ansicht und im Snapshot des Stroms (tokens null nach Reset)
  POST /api/gespraeche                    neue Sitzung {titel, arbeitsbereich, modell} → 201 {gespraech: {id, meta, agent}}; ohne titel „Neuer Agent“, bis 120 Zeichen
  PATCH /api/gespraech/<id>               {titel, archiviert} → 200 {gespraech: {id, meta, agent}}; archivierte Sitzungen fehlen in GET /api/gespraeche (wie beim Runner)
  GET  /api/ordner?pfad=…                 Ordnerwahl: ohne pfad die Wurzeln, mit pfad die Unterordner (erfundener Baum unter /probe/ordner-a und -b)
                                          POST /api/gespraeche nimmt zusätzlich `ordner`; Gesprächsliste und Gespräch tragen ihn in `ordner` und `agent.cwd`
  GET  /api/ordner?pfad=…&dateien=1       dazu Dateien ({name, ordner: false, groesse}), Ordner zuerst, Gesperrte (.env, *.pem …) fehlen
  GET  /api/datei?pfad=…&gespraech=&max=  Inhalt einer Textdatei im erfundenen Baum: {ok, pfad, groesse, text, abgeschnitten, binaer: false, geaendert}, Binärdatei
                                          ohne text ({binaer: true}); 400 ungültig, 403 ausserhalb/gesperrt, 404, 413 (max über 1 MiB); Standard 200000 Byte
  GET  /api/gespraech/<id>                Meta und Arbeitsordner der Sitzung (agent.cwd)
  GET  /api/gespraech/<id>/ansicht?voll=1 Verlauf der Sitzung
  GET  /api/gespraech/<id>/ereignisse     Ereignisstrom (SSE) der Sitzung: erst ein Snapshot, dann Ereignisse, alle 5 s ein Herzschlag-Kommentar
  GET  /api/strom                         Aktivitätsstrom über alle Sitzungen: `hallo`, dann Zeilen {t, gespraech, titel, art, typ, text}
  POST /api/gespraech/<id>/nachricht      startet je nach Text ein Szenario (siehe SZENARIEN)
  POST /api/gespraech/<id>/abbrechen      beendet ein laufendes Szenario früh
  GET  /api/freigaben                     alle Freigaben aller Sitzungen, neueste zuerst, in der Form des Runners (conversationId, gespraechTitel, aktion,
                                          risiko, zerstoererisch, kontext, befehl, werkzeug, status offen/erteilt/abgelehnt, erstellt, entschieden, entschiedenVon, notiz)
  POST /api/freigaben/<id>                {entscheidung: erteilt|abgelehnt, von, notiz (höchstens 600 Zeichen, leer = null)} → 200 {ok, freigaben} (die neue Liste) und ein Entscheidungs-Eintrag
                                          im Strom der Sitzung; Fehler wie beim Runner: 500 {ok: false, fehler} (falsches Wort, unbekannt, schon entschieden)
  POST /api/e2e/ergebnis                  die Seite meldet ein Prüfergebnis (nur Debug-Bauten der Hülle starten das Skript der Seite)
  POST /api/e2e/kappen                    trennt alle offenen Ströme hart (Netzabbruch mitten im Strom)
Mit --token verlangt jede Anfrage `Authorization: Bearer <T>` (sonst 401). Jede Anfrage steht als JSON-Zeile im Protokoll (--log),
mit `auth: true/false` (kam das richtige Token an?), aber nie mit dem Token selbst.
"""
import argparse
import fnmatch
import json
import posixpath
import queue
import re
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

SZENARIEN = {
    "streaming": "Antwort in Teilen (Streaming)",
    "werkzeug": "ein Werkzeugaufruf mit Ergebnis (Karte)",
    "terminal": "Bash-Aufruf mit farbiger Ausgabe in Teilen (Terminal-Ansicht, ANSI)",
    "diff": "Edit- und Write-Aufruf (Diff-Ansicht)",
    "aenderungen": "Datei-Werkzeuge (write, read, edit, ein Fehlschlag) mit toolCall im Verlauf: Futter für das Panel „Änderungen“",
    "freigabe": "eine Freigabe, die entschieden werden muss (nur Erlauben/Ablehnen); mit „hoch“ im Text hohes Risiko (und zerstörerisch), mit „zerst“ mittleres Risiko und zerstörerisch",
    "reset": "ein Reset-Marker (neuer Kontext)",
    "lang": "zwölf Teile über sechs Sekunden (Abbruch mitten im Strom)",
}

# Arbeitsbereiche und Modelle der Attrappe (erfundene Namen und Pfade)
BEREICHE = {
    "standard": {"titel": "Standard", "pfad": "/probe/standard"},
    "projekt": {"titel": "Projekt Alpha", "pfad": "/probe/alpha"},
}
# `contextWindow` wie GET /api/modelle des Runners (Rhea: 262144); die Attrappe nimmt dieselbe Zahl, damit die Oberfläche nicht auf 128000 fällt
KONTEXT_FENSTER = 262144
MODELLE = [{"id": "probe-modell", "name": "Probe-Modell", "provider": "probe", "max": False, "contextWindow": KONTEXT_FENSTER}]

# "Ordner je Sitzung": ein erfundener Ordnerbaum im Speicher (kein Dateisystem). Wörterbuch = Ordner, Text = Textdatei, bytes = Datei mit Rohdaten.
# Dieselben Wege wie der echte Runner (GET /api/ordner mit `dateien=1`, GET /api/datei, POST /api/gespraeche mit `ordner`), gleiche Fehlerbilder.
ORDNER_WURZELN = ["/probe/ordner-a", "/probe/ordner-b"]
DATEI_GEAENDERT = 1793350000000
ORDNER_BAUM = {
    "probe": {
        "ordner-a": {
            "projekt-eins": {
                "src": {"haupt.py": 'print("Grüße")\nPASSWORD=geheim123\n', "bild.png": b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"},
                "docs": {},
                "README.md": "# Probe\nHallo Welt\n",
                "lang.txt": ("zeile " + "x" * 93 + "\n") * 3000,
                ".env": "GEHEIM=1\n",
                "server.pem": "-----BEGIN CERTIFICATE-----\n",
            },
            "projekt-zwei": {},
            "Notizen": {},
            ".versteckt": {},
            "liesmich.txt": "Grüße aus der Attrappe\n",
        },
        "ordner-b": {"viele": {f"d{i:04d}": {} for i in range(510)}},
        "draussen": {"geheim": {}},
    }
}
ORDNER_MAX = 500

# usage wie beim Runner: das Dokument des Gesprächs ist die SUMME über die Lebenszeit (hier mit den Zahlen aus einer gemeldeten Anzeige vom 30.10.2026:
# input 9,7 Mio., input + cacheRead 193 Mio.), die usage einer Antwort ist der Prompt dieses einen Aufrufs samt Antwort (= die Kontextfüllung: 3500 Token)
USAGE_LEBENSZEIT = {"input": 9729400, "output": 2121500, "cacheRead": 183308800, "cacheWrite": 0, "totalTokens": 195159700, "cost": {"total": 0}}
USAGE_ANTWORT = {"input": 1200, "output": 300, "cacheRead": 2000, "cacheWrite": 0, "totalTokens": 3500, "cost": {"total": 0}}


# Suche über Sitzungen (GET /api/suche) in derselben Form wie der Runner (deploy/runner/pi-durable/src/suche.js): Titel und sichtbarer Text von
# Mensch und Agent, alle Wörter müssen vorkommen, Groß/Klein egal, Ausschnitt höchstens 160 Zeichen mit Offsets (start/laenge) statt HTML.
# Vereinfachungen der Attrappe: Offsets zählen Zeichen (Python) statt UTF-16-Einheiten (nur für Zeichen außerhalb der BMP anders), die Schwärzung
# kennt nur Bearer, token=, password= und ähnliche Schlüssel-Wert-Paare.
SUCHE_TREFFER_MAX = 50
SUCHE_SITZUNGEN_MAX = 200
SUCHE_AUSSCHNITT = 160
_SCHWAERZ = [
    (re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{6,}", re.I), "Bearer ***"),
    (re.compile(r"\b(authorization|token|passwort|password|passwd|secret|api[_-]?key)(\s*[=:]\s*)(\S+)", re.I), r"\1\2***"),
]


class SucheFehler(Exception):
    def __init__(self, status, meldung):
        super().__init__(meldung)
        self.status = status
        self.meldung = meldung


def suche_archiv_modus(roh):
    t = (roh or "").strip().lower()
    if t in ("", "0", "nein"):
        return "aktiv"
    if t in ("1", "ja"):
        return "archiviert"
    if t == "alle":
        return "alle"
    raise SucheFehler(400, "archiv muss 0, 1 oder alle sein")


def suche_passt(s, modus):
    return modus == "alle" or (s.archiviert if modus == "archiviert" else not s.archiviert)


def suche_ausschnitt(text, woerter):
    kl = text.lower()
    erster = min((kl.find(w) for w in woerter if kl.find(w) >= 0), default=0)
    von = max(0, erster - SUCHE_AUSSCHNITT // 3)
    bis = min(len(text), von + SUCHE_AUSSCHNITT)
    von = max(0, bis - SUCHE_AUSSCHNITT)
    aus, klaus = text[von:bis], kl[von:bis]
    alle = []
    for w in woerter:
        i = klaus.find(w)
        while i >= 0:
            alle.append((i, len(w)))
            i = klaus.find(w, i + len(w))
    alle.sort(key=lambda m: (m[0], -m[1]))
    marken, ende = [], 0
    for start, laenge in alle:
        if start < ende:
            continue
        marken.append({"start": start, "laenge": laenge})
        ende = start + laenge
        if len(marken) >= 10:
            break
    erste = marken[0] if marken else {"start": 0, "laenge": 0}
    return {"ausschnitt": aus, "start": erste["start"], "laenge": erste["laenge"], "markierungen": marken}


def suche_texte(s):
    """Sichtbare Texte einer Sitzung, neueste zuerst: Eingaben des Menschen (fyos.mensch) und Textblöcke des Agenten; keine Werkzeuge, keine Marker."""
    aus = []
    for e in s.eintraege:
        if e.get("kind") == "fyos.mensch":
            aus.append(str((e.get("data") or {}).get("text", "")))
        for m in e.get("model") or []:
            if m.get("role") == "assistant":
                aus.append("\n".join(b.get("text", "") for b in m.get("content") or [] if isinstance(b, dict) and b.get("type") == "text"))
    texte = []
    for t in reversed(aus):
        for muster, ersatz in _SCHWAERZ:
            t = muster.sub(ersatz, t)
        t = re.sub(r"\s+", " ", t).strip()
        if t:
            texte.append(t)
    return texte


def suche_antwort(z, query):
    """GET /api/suche?q=&limit=&archiv= → (Status, Körper); Fehler wie beim Runner: {ok: false, fehler}."""

    def eins(name):
        return query.get(name, [None])[0]

    try:
        q = eins("q")
        if q is None or len(q.strip()) < 2:
            raise SucheFehler(400, "q muss mindestens 2 Zeichen haben")
        if len(q.strip()) > 200:
            raise SucheFehler(400, "q darf höchstens 200 Zeichen haben")
        woerter = list(dict.fromkeys(w[:80].lower() for w in q.split()))
        if len(woerter) > 6:
            raise SucheFehler(400, "q darf höchstens 6 Wörter haben")
        roh_limit = eins("limit")
        if roh_limit in (None, ""):
            limit = 20
        else:
            try:
                limit = int(roh_limit)
            except ValueError:
                limit = 0
            if limit < 1 or str(limit) != roh_limit.strip():
                raise SucheFehler(400, f"limit muss eine ganze Zahl von 1 bis {SUCHE_TREFFER_MAX} sein")
            limit = min(limit, SUCHE_TREFFER_MAX)
        modus = suche_archiv_modus(eins("archiv"))
    except SucheFehler as f:
        return f.status, {"ok": False, "fehler": f.meldung}
    with z.sperre:
        liste = sorted((s for s in z.sitzungen.values() if suche_passt(s, modus)), key=lambda s: (s.art != "root", -s.erstellt))
    kandidaten = liste[:SUCHE_SITZUNGEN_MAX]
    abgeschnitten = len(liste) > len(kandidaten)
    treffer, durchsucht = [], 0
    for s in kandidaten:
        if len(treffer) >= limit:
            abgeschnitten = True
            break
        durchsucht += 1
        einheiten = [("titel", s.titel)] + [("verlauf", t) for t in suche_texte(s)]
        gefunden = set()
        zahl, beste = 0, None
        if all(w in s.titel.lower() for w in woerter):
            einheiten, zahl, beste = einheiten[:1], 1, ("titel", s.titel)
            gefunden = set(woerter)
        else:
            for quelle, text in einheiten:
                hier = [w for w in woerter if w in text.lower()]
                if not hier:
                    continue
                zahl += 1
                gefunden.update(hier)
                if beste is None or len(hier) > beste[2]:
                    beste = (quelle, text, len(hier))
        if len(gefunden) != len(woerter) or not beste:
            continue
        treffer.append({"id": s.id, "titel": s.titel, "archiviert": s.archiviert, "aktualisiert": s.aktualisiert, "quelle": beste[0], **suche_ausschnitt(beste[1], woerter), "zahl": zahl})
    treffer.sort(key=lambda t: -t["aktualisiert"])
    return 200, {"ok": True, "treffer": treffer, "abgeschnitten": abgeschnitten, "durchsucht": durchsucht, "gesamt": len(liste)}


class OrdnerFehler(Exception):
    def __init__(self, status, code, meldung):
        super().__init__(meldung)
        self.status, self.code, self.meldung = status, code, meldung


def pfad_pruefen(wurzeln, roh):
    """Textliche Prüfung wie src/ordner.js des Runners: gibt den normalisierten Pfad zurück oder wirft OrdnerFehler (400/403)."""
    if not isinstance(roh, str) or roh == "":
        raise OrdnerFehler(400, "ungueltig", "Pfad fehlt oder ist kein Text")
    if "\0" in roh:
        raise OrdnerFehler(400, "ungueltig", "Pfad enthält ein Nullbyte")
    if not roh.startswith("/"):
        raise OrdnerFehler(400, "ungueltig", "Pfad muss absolut sein")
    if not wurzeln:
        raise OrdnerFehler(403, "ausserhalb", "Ordnerwahl nicht freigegeben (keine erlaubten Wurzeln eingerichtet)")
    if ".." in roh.split("/"):
        raise OrdnerFehler(403, "ausserhalb", "Pfade mit „..“ sind nicht erlaubt")
    n = posixpath.normpath(roh)
    if n.startswith("//"):
        n = "/" + n.lstrip("/")
    if not any(n == w or n.startswith(w + "/") for w in wurzeln):
        raise OrdnerFehler(403, "ausserhalb", "Pfad liegt außerhalb der erlaubten Wurzeln")
    return n


def ordner_pruefen(wurzeln, roh):
    """Wie src/ordner.js des Runners: gibt den normalisierten Pfad und den Knoten zurück oder wirft OrdnerFehler (400/403/404)."""
    n = pfad_pruefen(wurzeln, roh)
    knoten = ORDNER_BAUM
    for teil in [t for t in n.split("/") if t]:
        if not isinstance(knoten, dict) or teil not in knoten:
            raise OrdnerFehler(404, "nicht_gefunden", "Ordner nicht gefunden")
        knoten = knoten[teil]
    if not isinstance(knoten, dict):
        raise OrdnerFehler(400, "kein_ordner", "Das ist kein Ordner")
    return n, knoten


# Sperrliste wie src/sperre.js des Runners (hier die wichtigsten Muster; Namen ohne Beachtung der Groß-/Kleinschreibung,
# angewendet auf jeden Pfadteil unterhalb der Wurzel).
SPERRE = [".env", ".env.*", "*.env", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*", ".netrc", ".npmrc", ".ssh", ".gnupg", ".aws",
          "credentials", "credentials.*", "*.token", "token.json", "secrets", "secrets.json", "secrets.yml", "secrets.yaml"]
DATEI_STANDARD = 200000
DATEI_HOECHST = 1048576


def gesperrt(wurzeln, n):
    wurzel = next((w for w in wurzeln if n == w or n.startswith(w + "/")), "")
    teile = [t for t in n[len(wurzel):].split("/") if t]
    return any(fnmatch.fnmatchcase(t.lower(), m.lower()) for t in teile for m in SPERRE)


def ordner_auflisten(wurzeln, pfad, dateien=False):
    """Wie src/ordner.js: mit dateien=True zusätzlich Dateien ({name, ordner: False, groesse}), Ordner zuerst, höchstens ORDNER_MAX zusammen."""
    if not pfad:
        return {"wurzeln": wurzeln, "pfad": None, "eintraege": [], "erlaubt": bool(wurzeln)}
    n, knoten = ordner_pruefen(wurzeln, pfad)
    if dateien and gesperrt(wurzeln, n):
        raise OrdnerFehler(403, "gesperrt", "Dieser Ordner ist gesperrt (deutet auf Geheimnisse hin)")
    sichtbar = lambda k: not k.startswith(".") and not (dateien and gesperrt(wurzeln, n.rstrip("/") + "/" + k))
    ordnung = lambda s: (s.lower(), s)
    ordner = sorted((k for k, v in knoten.items() if isinstance(v, dict) and sichtbar(k)), key=ordnung)
    eintraege = [{"name": k, "ordner": True} for k in ordner[:ORDNER_MAX]]
    zahl = len(ordner)
    if dateien:
        dateinamen = sorted((k for k, v in knoten.items() if not isinstance(v, dict) and sichtbar(k)), key=ordnung)
        zahl += len(dateinamen)
        for k in dateinamen[: max(0, ORDNER_MAX - len(eintraege))]:
            eintraege.append({"name": k, "ordner": False, "groesse": len(knoten[k] if isinstance(knoten[k], bytes) else knoten[k].encode("utf-8"))})
    antwort = {"wurzeln": wurzeln, "pfad": n, "eintraege": eintraege, "erlaubt": True}
    if zahl > ORDNER_MAX:
        antwort["abgeschnitten"] = True
    return antwort


def datei_schwaerzen(text):
    """Zeilenweise wie schwaerzenText() des Runners (verkürzt): Schlüssel-Wert-Paare, Bearer, Schlüsselblöcke."""
    text = re.sub(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)", "***PRIVATE KEY***", text)
    zeilen = []
    for zeile in text.split("\n"):
        zeile = re.sub(r"\bBearer\s+[A-Za-z0-9._~+/=-]{6,}", "Bearer ***", zeile, flags=re.I)
        zeile = re.sub(r"\b(authorization|token|passwort|password|passwd|secret|api[_-]?key)(\s*[=:]\s*)(\"[^\"]*\"|'[^']*'|\S+)", r"\1\2***", zeile, flags=re.I)
        zeilen.append(zeile)
    return "\n".join(zeilen)


def datei_lesen(wurzeln, roh, max_roh=None):
    """Wie src/datei.js des Runners: {pfad, groesse, text, abgeschnitten, binaer: False, geaendert, geschwaerzt (nur wenn etwas ersetzt wurde)} oder {pfad, groesse, binaer: True}."""
    if max_roh in (None, ""):
        grenze = DATEI_STANDARD
    else:
        if not re.fullmatch(r"\d{1,12}", str(max_roh)) or int(max_roh) < 1:
            raise OrdnerFehler(400, "ungueltig", "max muss eine ganze Zahl ab 1 sein")
        grenze = int(max_roh)
        if grenze > DATEI_HOECHST:
            raise OrdnerFehler(413, "zu_gross", f"max darf höchstens {DATEI_HOECHST} Byte sein")
    n = pfad_pruefen(wurzeln, roh)
    if gesperrt(wurzeln, n):
        raise OrdnerFehler(403, "gesperrt", "Diese Datei ist gesperrt (deutet auf Geheimnisse hin)")
    knoten = ORDNER_BAUM
    for teil in [t for t in n.split("/") if t]:
        if not isinstance(knoten, dict) or teil not in knoten:
            raise OrdnerFehler(404, "nicht_gefunden", "Datei nicht gefunden")
        knoten = knoten[teil]
    if isinstance(knoten, dict):
        raise OrdnerFehler(400, "keine_datei", "Das ist keine reguläre Datei")
    roh_bytes = knoten if isinstance(knoten, bytes) else knoten.encode("utf-8")
    if b"\0" in roh_bytes[:8192]:
        return {"pfad": n, "groesse": len(roh_bytes), "binaer": True}
    teil = roh_bytes[:grenze]
    text = teil.decode("utf-8", errors="ignore" if len(roh_bytes) > grenze else "replace")
    geschwaerzt = datei_schwaerzen(text)
    antwort = {"pfad": n, "groesse": len(roh_bytes), "text": geschwaerzt, "abgeschnitten": len(roh_bytes) > grenze, "binaer": False, "geaendert": DATEI_GEAENDERT}
    if geschwaerzt != text:
        antwort["geschwaerzt"] = True  # wie der Runner: das Feld steht nur, wenn etwas ersetzt wurde
    return antwort

ANSI_TEXT = "\x1b[1mBau\x1b[0m gestartet\n\x1b[32mgruen ok\x1b[0m und \x1b[31mrot Fehler\x1b[0m\nFortschritt 10%\rFortschritt 100%\n"


class Sitzung:
    """Eine Sitzung der Attrappe: eigener Verlauf, eigener Strom, eigene Szenarien."""

    def __init__(self, z, sid, titel, art, bereich, erstellt, ordner=None):
        self.z = z
        self.ordner = ordner
        self.id = sid
        self.titel = titel
        self.archiviert = False
        self.art = art
        self.bereich = bereich
        self.erstellt = erstellt
        self.aktualisiert = erstellt  # letzte Aktivität (Suche: `aktualisiert`)
        self.eintraege = []  # Verlauf (für Ansicht und Snapshot)
        self.abonnenten = []  # (queue, Verbindungs-Objekt)
        self.laeuft = False
        self.teil = ""  # Text der laufenden Nachricht
        self.abbruch = threading.Event()
        self.zug_sperre = threading.Lock()

    def cwd(self):
        return self.ordner or BEREICHE[self.bereich]["pfad"]

    def liste(self):
        return {"id": self.id, "art": self.art, "titel": self.titel, "arbeitsbereich": self.bereich, "ordner": self.ordner, "agent": {"cwd": self.cwd()}, "erstellt": self.erstellt, "modell": None, "archiviert": self.archiviert}

    def meta(self):
        return {"id": self.id, "titel": self.titel, "modell": "probe-modell", "arbeitsbereich": self.bereich, "ordner": self.ordner, "erstellt": self.erstellt, "art": self.art, "archiviert": self.archiviert}

    def senden(self, ereignisse):
        with self.z.sperre:
            for q, _ in list(self.abonnenten):
                q.put(ereignisse)

    def eintrag(self, kind, data=None, model=None):
        e = {"id": self.z.nr(), "kind": kind}
        if data is not None:
            e["data"] = data
        if model is not None:
            e["model"] = model
        with self.z.sperre:
            self.eintraege.append(e)
            self.aktualisiert = int(time.time() * 1000)
        return e

    def kontext(self):
        """usage.context wie beim Runner: Füllung = totalTokens der letzten Antwort, null nach einem Reset-Marker; window = Fenster des Modells."""
        tokens = None
        for e in self.eintraege:
            if e.get("kind") in ("pi.reset", "pi.compaction"):
                tokens = None
            for m in e.get("model") or []:
                t = (m.get("usage") or {}).get("totalTokens")
                if m.get("role") == "assistant" and isinstance(t, (int, float)) and t > 0:
                    tokens = t
        return {"tokens": tokens, "window": KONTEXT_FENSTER}

    def snapshot(self):
        with self.z.sperre:
            s = {"entries": list(self.eintraege), "agent": {"model": "probe-modell"}, "usage": {"models": {"probe/probe": USAGE_LEBENSZEIT}, "tools": {}, "context": self.kontext()}}
            if self.laeuft:
                s["run"] = True
                s["generation"] = {"message": {"role": "assistant", "content": [{"type": "text", "text": self.teil}]}}
            return s

    def pause(self, s):
        # in kleinen Schritten, damit "abbrechen" ein Szenario früh beendet
        ende = time.time() + s * self.z.tempo
        while time.time() < ende and not self.abbruch.is_set():
            time.sleep(0.02)

    def zeile(self, typ, text, wz=None):
        z = {"t": int(time.time() * 1000), "gespraech": self.id, "titel": self.titel, "art": self.art, "typ": typ, "text": text}
        if wz:
            z["wz"] = wz
        self.z.strom_senden("zeile", z)

    def szenario(self, text):
        # Der Runner arbeitet je Sitzung einen Zug nach dem anderen ab: eine zweite Nachricht wartet, bis der laufende Zug zu Ende ist
        # (sonst überschreibt das Ende des ersten Zugs Lauf-Zustand und Snapshot des zweiten).
        with self.zug_sperre:
            self._szenario(text)

    def _szenario(self, text):
        t = text.lower()
        self.abbruch.clear()
        try:
            e = self.eintrag("fyos.mensch", {"text": text})
            self.senden([{"type": "entry_appended", "entry": e}])
            self.zeile("mensch", text)
            with self.z.sperre:
                self.laeuft = True
                self.teil = ""
            self.senden([{"type": "run_start"}, {"type": "message_start", "message": {"role": "assistant", "content": []}}])
            if "freigabe" in t:
                self.freigabe_szenario(hoch="hoch" in t, zerst="zerst" in t)
            elif "terminal" in t:
                self.terminal_szenario()
            elif "aenderung" in t:
                self.aenderungen_szenario()
            elif "diff" in t:
                self.diff_szenario()
            elif "werkzeug" in t:
                self.werkzeug_szenario()
            elif "reset" in t:
                e = self.eintrag("pi.reset", {"vorher": 1000, "nachher": 10})
                self.senden([{"type": "entry_appended", "entry": e}])
                self.antwort_in_teilen(["Kontext ist neu."], 0.1)
            elif "lang" in t:
                self.antwort_in_teilen([f"Lang {i} " for i in range(1, 13)], 0.5)
            else:
                self.antwort_in_teilen(["Antwort Teil 1 ", "Antwort Teil 2 ", "Antwort Teil 3 ", "Antwort Ende"], 0.8)
        finally:
            with self.z.sperre:
                self.laeuft = False
            self.senden([{"type": "run_end"}])
            self.zeile("fertig", "Zug fertig")

    def antwort_in_teilen(self, teile, abstand):
        for i, teil in enumerate(teile):
            if self.abbruch.is_set():
                break
            with self.z.sperre:
                self.teil += teil
            self.senden([{"type": "message_update", "changes": [{"type": "text_delta", "contentIndex": 0, "delta": teil}]}])
            self.pause(abstand)
        e = self.eintrag("pi.message", model=[{"role": "assistant", "content": [{"type": "text", "text": self.teil}], "usage": USAGE_ANTWORT, "stopReason": "stop"}])
        self.senden([{"type": "message_end", "entry": e}])

    def werkzeug_ende(self, tid, name, ergebnis, fehler=False):
        e = self.eintrag("pi.tool", model=[{"role": "toolResult", "toolCallId": tid, "toolName": name, "content": [{"type": "text", "text": ergebnis}], "isError": fehler}])
        self.senden([{"type": "tool_execution_end", "toolCallId": tid, "toolName": name, "entry": e}])

    def werkzeug_szenario(self):
        self.senden([{"type": "tool_execution_start", "toolCallId": "t1", "toolName": "read", "args": {"path": "probe.txt"}}])
        self.zeile("werkzeug", "read probe.txt", "read")
        self.pause(0.5)
        self.werkzeug_ende("t1", "read", "Inhalt der Probe")
        self.antwort_in_teilen(["Werkzeug fertig."], 0.1)

    def terminal_szenario(self):
        tid = f"b{self.z.nr()}"
        self.senden([{"type": "tool_execution_start", "toolCallId": tid, "toolName": "bash", "args": {"command": "./bauen.sh --farbe"}}])
        self.zeile("werkzeug", "bash ./bauen.sh --farbe", "bash")
        self.pause(0.3)
        # absichtlich mitten in einer Farbfolge geteilt: die Seite muss die angefangene Folge festhalten
        for stueck in ["\x1b[1mBau\x1b[0m gestartet\n\x1b[32mgruen ok\x1b[0m und \x1b[3", "1mrot Fehler\x1b[0m\nFortschritt 10%\rFortschritt 100%\n"]:
            self.senden([{"type": "tool_execution_update", "toolCallId": tid, "output": {"append": stueck}}])
            self.pause(0.3)
        self.werkzeug_ende(tid, "bash", ANSI_TEXT)
        self.antwort_in_teilen(["Terminal fertig."], 0.1)

    def diff_szenario(self):
        tid = f"e{self.z.nr()}"
        args = {"path": "src/probe.txt", "edits": [{"oldText": "alte Zeile\ngleich", "newText": "neue Zeile\ngleich\nzusaetzlich"}, {"oldText": "Ende alt", "newText": "Ende neu"}]}
        self.senden([{"type": "tool_execution_start", "toolCallId": tid, "toolName": "edit", "args": args}])
        self.zeile("werkzeug", "edit src/probe.txt", "edit")
        self.pause(0.3)
        self.werkzeug_ende(tid, "edit", "2 Änderungen in src/probe.txt")
        tid2 = f"w{self.z.nr()}"
        self.senden([{"type": "tool_execution_start", "toolCallId": tid2, "toolName": "write", "args": {"path": "neu.txt", "content": "eins\nzwei\ndrei\n"}}])
        self.zeile("werkzeug", "write neu.txt", "write")
        self.pause(0.2)
        self.werkzeug_ende(tid2, "write", "neu.txt geschrieben")
        self.antwort_in_teilen(["Diff fertig."], 0.1)

    def werkzeug_mit_aufruf(self, tid, name, args, ergebnis, fehler=False):
        """Ein Werkzeugschritt in der Form des echten Runners: die Assistenten-Nachricht trägt den toolCall-Block (so steht er im Verlauf und
        kommt beim Neuladen zurück), dann Start und Ergebnis des Werkzeugs."""
        m = self.eintrag("pi.message", model=[{"role": "assistant", "content": [{"type": "toolCall", "id": tid, "name": name, "arguments": args}], "usage": USAGE_ANTWORT, "stopReason": "toolUse"}])
        self.senden([{"type": "message_end", "entry": m}])
        self.senden([{"type": "tool_execution_start", "toolCallId": tid, "toolName": name, "args": args}])
        self.zeile("werkzeug", f"{name} {args.get('path', '')}".strip(), name)
        self.pause(0.1)
        self.werkzeug_ende(tid, name, ergebnis, fehler)

    def aenderungen_szenario(self):
        """Datei-Werkzeuge für das Panel „Änderungen“: eine neue Datei (write, danach zweimal bearbeitet), eine gelesene und bearbeitete Datei,
        ein fehlgeschlagenes Bearbeiten. Pfade relativ zum Arbeitsordner, wie sie das Modell meist schreibt."""
        n = self.z.nr()
        self.werkzeug_mit_aufruf(f"aw{n}", "write", {"path": "notizen/plan.md", "content": "# Plan\nerster Punkt\nzweiter Punkt\n"}, "notizen/plan.md geschrieben")
        self.werkzeug_mit_aufruf(f"ar{n}", "read", {"path": "src/probe.txt"}, "alte Zeile\ngleich\nEnde alt\n")
        self.werkzeug_mit_aufruf(f"ae{n}", "edit", {"path": "src/probe.txt", "edits": [{"oldText": "alte Zeile", "newText": "neue Zeile"}, {"oldText": "Ende alt", "newText": "Ende neu\nund ein Nachtrag"}]}, "2 Änderungen in src/probe.txt")
        self.werkzeug_mit_aufruf(f"ap{n}", "edit", {"path": "notizen/plan.md", "edits": [{"oldText": "zweiter Punkt", "newText": "zweiter Punkt\ndritter Punkt"}]}, "1 Änderung in notizen/plan.md")
        self.werkzeug_mit_aufruf(f"af{n}", "edit", {"path": "src/fehlt.txt", "edits": [{"oldText": "x", "newText": "y"}]}, "Text nicht gefunden", fehler=True)
        self.antwort_in_teilen(["Änderungen fertig."], 0.1)

    def freigabe_szenario(self, hoch=False, zerst=False):
        fid = f"f{self.z.nr()}"
        risiko = "high" if hoch else ("medium" if zerst else "low")
        # wie neueFreigabe() des Runners: hohes Risiko gilt immer als zerstörerisch; das Modell kann es auch bei kleinerem Risiko setzen
        zerst = bool(zerst or hoch)
        jetzt = int(time.time() * 1000)
        # Form eines Eintrags wie GET /api/freigaben des Runners (neueFreigabe + gespraechTitel + kontext)
        f = {
            "id": fid, "conversationId": self.id, "gespraechTitel": self.titel, "taskId": None, "aktion": "Probe-Aktion ausführen", "risiko": risiko,
            "kontext": "Die Probe-Aktion läuft nur in der Attrappe und ändert nichts.", "kontextHerkunft": "rueckfall", "zerstoererisch": zerst,
            "werkzeug": "bash", "befehl": "echo probe", "bezug": None, "status": "offen", "erstellt": jetzt, "entschieden": None, "entschiedenVon": None, "notiz": None,
        }
        with self.z.sperre:
            self.z.freigaben.append(f)
        e = self.eintrag("fyos.freigabe", {"id": fid, "aktion": f["aktion"], "risiko": risiko, "kontext": f["kontext"], "werkzeug": "bash", "status": "offen"})
        self.senden([{"type": "entry_appended", "entry": e}])
        self.zeile("freigabe", "wartet auf Freigabe: Probe-Aktion ausführen")
        ende = time.time() + 60
        while time.time() < ende and f["status"] == "offen":
            time.sleep(0.1)
        self.antwort_in_teilen(["Freigabe erteilt." if f["status"] == "erteilt" else "Freigabe abgelehnt."], 0.1)


class Zustand:
    def __init__(self, token, tempo, log, ordner_an=True):
        self.token = token
        self.wurzeln = list(ORDNER_WURZELN) if ordner_an else []
        self.tempo = tempo
        self.log = log
        self.sperre = threading.RLock()
        self.freigaben = []
        self.strom_abonnenten = []  # (queue, Verbindungs-Objekt) des Aktivitätsstroms
        self.zaehler = 0
        jetzt = int(time.time() * 1000)
        self.sitzungen = {
            1: Sitzung(self, 1, "Probe", "root", "standard", jetzt - 3600_000),
            2: Sitzung(self, 2, "Zweite Sitzung", "mensch", "projekt", jetzt - 7200_000),
        }
        self.naechste_id = 3

    # Die Sitzung 1 bleibt unter den alten Namen erreichbar (Tests und das Prüfskript der ersten Fassung)
    @property
    def eintraege(self):
        return self.sitzungen[1].eintraege

    @property
    def laeuft(self):
        return any(s.laeuft for s in self.sitzungen.values())

    @property
    def abonnenten(self):
        return self.sitzungen[1].abonnenten

    def nr(self):
        with self.sperre:
            self.zaehler += 1
            return self.zaehler

    def protokoll(self, **zeile):
        if self.log:
            with self.sperre, open(self.log, "a", encoding="utf-8") as f:
                f.write(json.dumps(zeile, ensure_ascii=False) + "\n")

    def strom_senden(self, art, daten):
        with self.sperre:
            for q, _ in list(self.strom_abonnenten):
                q.put((art, daten))

    def neue_sitzung(self, titel, bereich, ordner=None):
        with self.sperre:
            sid = self.naechste_id
            self.naechste_id += 1
            s = Sitzung(self, sid, str(titel or "")[:120] or "Neuer Agent", "mensch", bereich if bereich in BEREICHE else "standard", int(time.time() * 1000), ordner)
            self.sitzungen[sid] = s
        return s

    def sitzung(self, sid):
        try:
            return self.sitzungen.get(int(sid))
        except (TypeError, ValueError):
            return None

    def liste_freigaben(self):
        """Wie runner.freigaben(): alle Eintraege, neueste zuerst; der Titel der Sitzung folgt einer Umbenennung."""
        with self.sperre:
            ausgabe = []
            for f in self.freigaben:
                s = self.sitzungen.get(f["conversationId"])
                ausgabe.append({**f, "gespraechTitel": s.titel if s else str(f["conversationId"])})
            return sorted(ausgabe, key=lambda x: x["erstellt"], reverse=True)

    def entscheiden(self, fid, wert, von="mensch", notiz=None):
        """Wie runner.entscheideFreigabe(): wirft FreigabeFehler (Text wie beim Runner), sonst die neue Liste."""
        if wert not in ("erteilt", "abgelehnt"):
            raise FreigabeFehler("Entscheidung: erteilt oder abgelehnt")
        with self.sperre:
            f = next((x for x in self.freigaben if x["id"] == fid), None)
            if not f:
                raise FreigabeFehler("Freigabe nicht gefunden")
            if f["status"] != "offen":
                raise FreigabeFehler(f"Freigabe ist bereits {f['status']}")
            f.update(status=wert, entschieden=int(time.time() * 1000), entschiedenVon=str(von or "mensch")[:64], notiz=(str(notiz)[:600] if notiz else None))
        s = self.sitzungen.get(f["conversationId"]) or self.sitzungen[1]
        e = s.eintrag("fyos.freigabe-entscheidung", {"id": fid, "entscheidung": wert, "von": f["entschiedenVon"], "notiz": f["notiz"], "zeit": f["entschieden"]})
        s.senden([{"type": "entry_appended", "entry": e}])
        return self.liste_freigaben()


class FreigabeFehler(Exception):
    pass


def handler(z):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _json(self, code, obj):
            b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(b)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(b)

        def _erlaubt(self):
            gut = z.token is None or self.headers.get("Authorization") == f"Bearer {z.token}"
            z.protokoll(pfad=self.path, methode=self.command, auth=gut, kopf=self.headers.get("X-FYOS-Agent") == "1")
            if not gut:
                self._json(401, {"fehler": "Nicht erlaubt"})
            return gut

        def _koerper(self):
            n = int(self.headers.get("Content-Length") or 0)
            try:
                return json.loads(self.rfile.read(n) or b"{}")
            except json.JSONDecodeError:
                return {}

        def do_GET(self):
            if not self._erlaubt():
                return
            p = urlparse(self.path).path
            if p == "/api/health":
                return self._json(200, {"ok": True, "agent": "probe", "pausiert": False, "geraet": {"name": "Attrappe"}})
            if p == "/api/konfiguration":
                return self._json(200, {"ok": True, "arbeitsbereiche": BEREICHE, "modelle": MODELLE, "version": 1})
            if p == "/api/modelle":
                return self._json(200, {"ok": True, "modelle": MODELLE})
            if p == "/api/ordner":
                abfrage = parse_qs(urlparse(self.path).query)
                pfad = abfrage.get("pfad", [None])[0]
                try:
                    return self._json(200, {"ok": True, **ordner_auflisten(z.wurzeln, pfad, abfrage.get("dateien", [""])[0] in ("1", "true"))})
                except OrdnerFehler as f:
                    return self._json(f.status, {"ok": False, "fehler": f.code, "meldung": f.meldung, "wurzeln": z.wurzeln, "erlaubt": bool(z.wurzeln)})
            if p == "/api/datei":
                abfrage = parse_qs(urlparse(self.path).query)
                try:
                    gid = abfrage.get("gespraech", [None])[0]
                    if gid and not z.sitzung(gid):
                        raise OrdnerFehler(404, "gespraech_nicht_gefunden", "Gespräch nicht gefunden")
                    return self._json(200, {"ok": True, **datei_lesen(z.wurzeln, abfrage.get("pfad", [None])[0], abfrage.get("max", [None])[0])})
                except OrdnerFehler as f:
                    return self._json(f.status, {"ok": False, "fehler": f.code, "meldung": f.meldung})
            if p == "/api/gespraeche":
                # wie der echte Runner (gespraeche() in src/runner.js): ohne ?archiv stehen archivierte Sitzungen nicht in der Liste;
                # ?archiv=1 liefert nur Archivierte, ?archiv=alle beide
                try:
                    modus = suche_archiv_modus(parse_qs(urlparse(self.path).query).get("archiv", [None])[0])
                except SucheFehler as f:
                    return self._json(f.status, {"ok": False, "fehler": f.meldung})
                return self._json(200, {"ok": True, "gespraeche": [s.liste() for s in z.sitzungen.values() if suche_passt(s, modus)]})
            if p == "/api/suche":
                status, koerper = suche_antwort(z, parse_qs(urlparse(self.path).query))
                return self._json(status, koerper)
            if p == "/api/freigaben":
                return self._json(200, {"ok": True, "freigaben": z.liste_freigaben()})
            if p == "/api/laeufe":
                return self._json(200, {"laeufe": [{"id": 1, "status": "laeuft"}] if z.laeuft else []})
            if p == "/api/strom":
                return self._strom_aktivitaet()
            m = re.fullmatch(r"/api/gespraech/(\d+)(?:/(ansicht|ereignisse))?", p)
            if m:
                s = z.sitzung(m.group(1))
                if not s:
                    return self._json(404, {"fehler": "Gespräch nicht gefunden"})
                if m.group(2) == "ansicht":
                    return self._json(200, {"entries": list(s.eintraege), "meta": s.meta(), "usage": s.snapshot()["usage"]})
                if m.group(2) == "ereignisse":
                    return self._strom(s)
                return self._json(200, {"ok": True, "id": s.id, "meta": s.meta(), "agent": {"model": "probe-modell", "cwd": s.cwd(), "tools": ["read", "bash", "edit", "write"]}})
            self._json(404, {"fehler": "unbekannt"})

        def _sse_kopf(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()

        def _strom(self, s):
            self._sse_kopf()
            q = queue.Queue()
            with z.sperre:
                s.abonnenten.append((q, self.connection))
            try:
                self.wfile.write(f"event: snapshot\ndata: {json.dumps(s.snapshot(), ensure_ascii=False)}\n\n".encode("utf-8"))
                self.wfile.flush()
                while True:
                    try:
                        ev = q.get(timeout=5)
                        self.wfile.write(f"event: ereignisse\ndata: {json.dumps(ev, ensure_ascii=False)}\n\n".encode("utf-8"))
                    except queue.Empty:
                        self.wfile.write(b": wach\n\n")
                    self.wfile.flush()
            except OSError:
                pass
            finally:
                with z.sperre:
                    s.abonnenten[:] = [a for a in s.abonnenten if a[0] is not q]

        def _strom_aktivitaet(self):
            self._sse_kopf()
            q = queue.Queue()
            with z.sperre:
                z.strom_abonnenten.append((q, self.connection))
            try:
                hallo = {"gespraeche": [{"id": s.id, "titel": s.titel, "art": s.art} for s in z.sitzungen.values()]}
                self.wfile.write(f"event: hallo\ndata: {json.dumps(hallo, ensure_ascii=False)}\n\n".encode("utf-8"))
                self.wfile.flush()
                while True:
                    try:
                        art, daten = q.get(timeout=5)
                        self.wfile.write(f"event: {art}\ndata: {json.dumps(daten, ensure_ascii=False)}\n\n".encode("utf-8"))
                    except queue.Empty:
                        self.wfile.write(b": wach\n\n")
                    self.wfile.flush()
            except OSError:
                pass
            finally:
                with z.sperre:
                    z.strom_abonnenten[:] = [a for a in z.strom_abonnenten if a[0] is not q]

        def do_PATCH(self):
            """PATCH /api/gespraech/<id> wie aendereGespraech des echten Runners: nur `titel` (Text, bis 120 Zeichen, leer ändert nichts) und
            `archiviert` (Wahrheitswert) wirken; unbekannte Sitzung → 500 mit Text (so antwortet der echte Runner heute)."""
            if not self._erlaubt():
                return
            p = urlparse(self.path).path
            k = self._koerper()
            m = re.fullmatch(r"/api/gespraech/(\d+)", p)
            if not m:
                return self._json(404, {"fehler": "unbekannt"})
            s = z.sitzung(m.group(1))
            if not s:
                return self._json(500, {"ok": False, "fehler": "Gespräch nicht gefunden"})
            with z.sperre:
                if "titel" in k and k["titel"] is not None:
                    neu = str(k["titel"])[:120]
                    s.titel = neu or s.titel
                if "archiviert" in k:
                    s.archiviert = bool(k["archiviert"])
            return self._json(200, {"ok": True, "gespraech": {"id": s.id, "meta": s.meta(), "agent": {"model": "probe-modell", "cwd": s.cwd(), "tools": []}, "usage": None}})

        def do_POST(self):
            if not self._erlaubt():
                return
            p = urlparse(self.path).path
            k = self._koerper()
            if p == "/api/gespraeche":
                if k.get("arbeitsbereich") and k["arbeitsbereich"] not in BEREICHE:
                    return self._json(400, {"fehler": f"Unbekannter Arbeitsbereich: {k['arbeitsbereich']}"})
                ordner = k.get("ordner")
                if ordner not in (None, ""):
                    try:
                        ordner, _ = ordner_pruefen(z.wurzeln, ordner)
                    except OrdnerFehler as f:
                        return self._json(400, {"ok": False, "fehler": f"Ordner abgelehnt ({f.code}): {f.meldung}"})
                else:
                    ordner = None
                s = z.neue_sitzung(k.get("titel"), k.get("arbeitsbereich", "standard"), ordner)
                return self._json(201, {"ok": True, "gespraech": {"id": s.id, "meta": s.meta(), "agent": {"model": "probe-modell", "cwd": s.cwd(), "tools": []}, "usage": None}})
            m = re.fullmatch(r"/api/gespraech/(\d+)/(nachricht|abbrechen)", p)
            if m:
                s = z.sitzung(m.group(1))
                if not s:
                    return self._json(404, {"fehler": "Gespräch nicht gefunden"})
                if m.group(2) == "nachricht":
                    threading.Thread(target=s.szenario, args=(str(k.get("text", "")),), daemon=True).start()
                else:
                    s.abbruch.set()
                return self._json(200, {"ok": True})
            if p.startswith("/api/freigaben/"):
                try:
                    alle = z.entscheiden(unquote(p.rsplit("/", 1)[1]), k.get("entscheidung"), k.get("von"), k.get("notiz"))
                except FreigabeFehler as f:
                    return self._json(500, {"ok": False, "fehler": str(f)})
                return self._json(200, {"ok": True, "freigaben": alle})
            if p == "/api/e2e/ergebnis":
                z.protokoll(ergebnis=k)
                return self._json(200, {"ok": True})
            if p == "/api/e2e/kappen":
                with z.sperre:
                    offene = [a for s in z.sitzungen.values() for a in s.abonnenten] + list(z.strom_abonnenten)
                for _, verbindung in offene:
                    try:
                        verbindung.shutdown(2)
                    except OSError:
                        pass
                return self._json(200, {"ok": True, "gekappt": len(offene)})
            self._json(404, {"fehler": "unbekannt"})

    return H


def main(argv):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", type=int, default=18681)
    p.add_argument("--log")
    p.add_argument("--token")
    p.add_argument("--tempo", type=float, default=1.0, help="Faktor für die Pausen der Szenarien (Tests: kleiner)")
    p.add_argument("--ohne-ordner", action="store_true", help="Ordnerwahl aus (keine Wurzeln), wie ein Runner ohne FYOS_RUNNER_ORDNER_ERLAUBT")
    a = p.parse_args(argv)
    z = Zustand(a.token, a.tempo, a.log, ordner_an=not a.ohne_ordner)
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), handler(z))
    srv.daemon_threads = True
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=srv.shutdown, daemon=True).start())
    print(f"Runner-Attrappe auf http://127.0.0.1:{srv.server_address[1]}", flush=True)
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
