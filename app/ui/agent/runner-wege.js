/* Lesende Wege zum Runner für Archiv, Suche und Datei-Vorschau (reine Logik, ohne DOM): alles läuft über transport.api (Brücke runner_anfrage, nur GET).
 *
 *   archiv()            GET /api/gespraeche?archiv=1          → { unterstuetzt, liste }  (ältere Runner ignorieren den Parameter: dann unterstuetzt = false)
 *   suche(q, o)         GET /api/suche?q=&limit=&archiv=      → { treffer, abgeschnitten, ... }  (Treffer bereinigt; Fehler als Fehler mit .art)
 *   datei(pfad, o)      GET /api/datei?pfad=&gespraech=&max=  → { art: 'text'|'binaer', text, groesse, abgeschnitten, geschwaerzt, geaendert }
 *   ordner(pfad, o)     GET /api/ordner?pfad=&dateien=1[&versteckt=1] → { eintraege, abgeschnitten }
 *   dateiSuche(id, q)   GET /api/gespraech/<id>/dateien?q=    → { treffer: [{ relativ, name }], gesamt, gekuerzt, unvollstaendig } (nur lokaler Runner)
 *   modelle()           GET /api/modelle                      → Liste mit contextWindow
 *   aufgaben(id)        GET /api/gespraech/<id>/aufgaben      → { eintraege: [{ text, zustand }], geaendert, fertig, laeuft, offen }  (Liste, die der Agent führt)
 *   laeufe()            GET /api/laeufe                       → [{ id, titel, quelle, status, erstellt, beendet, kindId, eltern, antwort, fehler }]
 *   jobs()              GET /api/jobs                         → [{ id, name, laeuft, start, ende, exit, grund, dauer_s, gespraech }]  (Befehle im Hintergrund)
 *   job(id, zeilen)     GET /api/jobs/<id>?zeilen=            → { id, name, befehl, laeuft, exit, grund, text, gekuerzt }
 *   browser()           GET /api/browser                      → { verfuegbar, laeuft, grund, url, titel, breite, hoehe }  (Browser des Agenten)
 *   browserBild(kenn)   GET /api/browser/bild?kenn=           → wie browser(), dazu { kenn, typ, bild (Base64) } oder { unveraendert }
 *   staende(id)         GET /api/gespraech/<id>/staende       → { ordner, dateien: [{ pfad, relativ, zustand, plus, minus, aenderungen, fremd, gesichert }],
 *                                                                 staende: [{ id, zeit, titel, aenderungen, dateien, gespraech }], gesamt }
 *   staendeDiff(id, p)  GET /api/gespraech/<id>/staende/diff  → { relativ, patch (Unified-Patch oder null), plus, minus, grund }
 *   anhaenge()          GET /api/anhaenge                     → { an, bilder (das Modell sieht Bilder), bilderQuelle, grenzen: { anzahl, bildBytes, dateiBytes, gesamtBytes } }
 *
 * Geschrieben wird hier nicht; `zurueckBereinigen` bereinigt nur die Antwort von POST …/zurueck (staende-tafel.js stellt die Anfrage).
 *
 * Fehler tragen `art`: 'weg_fehlt' (älterer Runner kennt den Weg nicht), 'zu_viele' (429), 'ungueltig' (400), 'gesperrt', 'verwehrt', 'ausserhalb',
 * 'nicht_gefunden', 'keine_datei', 'zu_gross', 'gespraech' (Sitzung unbekannt), 'netz' (Runner nicht erreichbar), 'andere'; dazu `status` und `meldung` (Klartext).
 * Texte aus der Antwort werden nur als Text weitergegeben, nie als HTML.
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  /** Ein Wert für die Abfrage eines Weges: URL-kodiert, auch Punkte (die Brücke weist ".." in jedem Weg ab). */
  function kodiere(wert) {
    return encodeURIComponent(String(wert)).replace(/\./g, '%2E');
  }

  /**
   * Fehler des Transports zerlegen. Zwei Formen: HTTP-Transport (Error mit .status und .fehler) und Tauri-Brücke (Error mit .code und .meldung.details
   * der Form "HTTP 403: gesperrt"; ein Netzfehler hat den Code RUNNER_NICHT_ERREICHBAR). → { status, text, code, netz }
   */
  function fehlerTeile(f) {
    let status = f && Number.isFinite(f.status) ? f.status : null;
    let text = f && typeof f.fehler === 'string' ? f.fehler : '';
    const code = (f && f.code) || '';
    const d = f && f.meldung && typeof f.meldung.details === 'string' ? f.meldung.details.trim() : '';
    if (status === null && d) {
      const m = /^HTTP (\d{3})(?::\s*([\s\S]*))?$/.exec(d);
      if (m) {
        status = Number(m[1]);
        text = (m[2] || '').trim();
      }
    }
    if (status === null && f && typeof f.message === 'string') {
      const m = /^HTTP (\d{3})$/.exec(f.message.trim());
      if (m) status = Number(m[1]);
    }
    const netz = code === 'RUNNER_NICHT_ERREICHBAR' || (status === null && !code);
    return { status, text, code, netz };
  }

  /** Ein Weg, den der Runner nicht kennt (ältere Fassung): 404 mit "Unbekannte Route" oder dem Platzhaltertext, nie ein Kennwort wie nicht_gefunden. */
  function wegFehlt(t) {
    return t.status === 404 && (t.text === '' || /unbekannte route|^nicht gefunden$|^not found$/i.test(t.text));
  }

  const MELDUNG = {
    weg_fehlt: 'Dieser Runner bietet den Weg nicht an.',
    zu_viele: 'Es laufen gerade zu viele Suchen. Bitte kurz warten.',
    ungueltig: 'Die Eingabe ist nicht möglich.',
    gesperrt: 'Diese Datei ist gesperrt (sie könnte Geheimnisse enthalten) und wird nicht angezeigt.',
    verwehrt: 'Der Runner darf diese Datei nicht lesen (keine Leserechte).',
    ausserhalb: 'Das liegt außerhalb der Ordner, die der Runner freigibt.',
    nicht_gefunden: 'Das gibt es auf dem Runner nicht (mehr).',
    keine_datei: 'Das ist keine reguläre Datei (Ordner oder Gerät).',
    zu_gross: 'Die Datei ist zu groß für die Vorschau.',
    kein_bild: 'Das ist kein Bild, das sich anzeigen lässt (PNG, JPEG, GIF oder WebP).',
    gespraech: 'Die Sitzung gibt es auf dem Runner nicht mehr.',
    netz: 'Der Runner ist nicht erreichbar.',
    zugang: 'Der Runner hat die Anmeldung abgelehnt (Token in den Einstellungen prüfen).',
  };

  /** Ordnet einen Fehler des Transports einer Art zu und macht daraus einen Error mit .art, .status, .meldung (Klartext). */
  function klassifiziere(f) {
    const t = fehlerTeile(f);
    let art = 'andere';
    if (t.netz) art = 'netz';
    else if (wegFehlt(t)) art = 'weg_fehlt';
    else if (t.status === 429) art = 'zu_viele';
    else if (t.status === 401 || t.code === 'TOKEN_ABGELEHNT') art = 'zugang';
    else if (t.code === 'ORDNER_AUSSERHALB') art = 'ausserhalb';
    else if (t.code === 'ORDNER_NICHT_GEFUNDEN') art = 'nicht_gefunden';
    else if (t.status === 413) art = 'zu_gross';
    else if (['gesperrt', 'verwehrt', 'ausserhalb', 'nicht_gefunden', 'keine_datei', 'zu_gross', 'kein_bild'].includes(t.text)) art = t.text;
    else if (t.text === 'gespraech_nicht_gefunden') art = 'gespraech';
    else if (t.status === 400 || t.text === 'ungueltig') art = 'ungueltig';
    let meldung = MELDUNG[art];
    if (!meldung) meldung = `Nicht möglich${t.status ? ` (HTTP ${t.status})` : ''}.`;
    if (art === 'ungueltig' && f && f.message && !/^HTTP /.test(f.message) && t.status === 400 && t.text && t.text !== 'ungueltig') meldung = `Nicht möglich: ${t.text}`;
    return Object.assign(new Error(meldung), { art, status: t.status, kennwort: t.text, code: t.code });
  }

  const zahlOder = (x, standard) => (typeof x === 'number' && Number.isFinite(x) ? x : standard);

  /**
   * Markierungen eines Treffers bereinigen: ganze Zahlen, innerhalb des Ausschnitts, aufsteigend, ohne Überlappung, höchstens 10. Fehlen `markierungen`,
   * gilt der erste Treffer (start/laenge). → [{ start, laenge }]
   */
  function markierungenPruefen(ausschnitt, roh, start, laenge) {
    const n = ausschnitt.length;
    const liste = Array.isArray(roh) && roh.length ? roh : [{ start, laenge }];
    const aus = [];
    let ende = 0;
    for (const m of liste.slice(0, 20).slice().sort((a, b) => zahlOder(a && a.start, 0) - zahlOder(b && b.start, 0))) {
      const s = Math.trunc(zahlOder(m && m.start, -1));
      const l = Math.trunc(zahlOder(m && m.laenge, 0));
      if (s < ende || l < 1 || s >= n) continue;
      const e = Math.min(n, s + l);
      aus.push({ start: s, laenge: e - s });
      ende = e;
      if (aus.length >= 10) break;
    }
    return aus;
  }

  function trefferBereinigen(t) {
    if (!t || t.id === undefined || t.id === null) return null;
    const ausschnitt = typeof t.ausschnitt === 'string' ? t.ausschnitt : '';
    return {
      id: t.id,
      titel: String(t.titel || '').trim() || 'Ohne Titel',
      archiviert: t.archiviert === true,
      aktualisiert: zahlOder(t.aktualisiert, 0),
      quelle: t.quelle === 'titel' ? 'titel' : 'verlauf',
      ausschnitt,
      markierungen: markierungenPruefen(ausschnitt, t.markierungen, t.start, t.laenge),
      zahl: Math.max(0, Math.trunc(zahlOder(t.zahl, 0))),
    };
  }

  /** Ist die Archivliste wirklich eine Archivliste? Jeder Eintrag muss `archiviert: true` tragen; sonst hat der Runner den Parameter ignoriert. */
  function archivListePruefen(r) {
    const liste = r && Array.isArray(r.gespraeche) ? r.gespraeche : null;
    if (!liste) return { unterstuetzt: false, liste: [] };
    if (liste.some((g) => !g || g.archiviert !== true)) return { unterstuetzt: false, liste: [] };
    return { unterstuetzt: true, liste };
  }

  // --- Aufgabenliste, Läufe und Hintergrundjobs: nur bekannte Felder, in festen Formen ---
  const AUFGABEN_ZUSTAENDE = ['offen', 'laeuft', 'fertig'];
  const JOB_KENNUNG = /^j[0-9a-z]{4,20}$/;
  const text = (x, max) => (typeof x === 'string' ? x.slice(0, max) : '');

  /** Die Aufgabenliste einer Sitzung: Einträge ohne Text fallen weg, ein unbekannter Zustand gilt als offen, die Zähler werden hier neu gezählt. */
  function aufgabenBereinigen(r) {
    const eintraege = (r && Array.isArray(r.eintraege) ? r.eintraege : [])
      .filter((e) => e && typeof e.text === 'string' && e.text.trim())
      .slice(0, 60)
      .map((e) => ({ text: e.text.trim().slice(0, 300), zustand: AUFGABEN_ZUSTAENDE.includes(e.zustand) ? e.zustand : 'offen' }));
    const z = { fertig: 0, laeuft: 0, offen: 0 };
    for (const e of eintraege) z[e.zustand] += 1;
    return { eintraege, geaendert: zahlOder(r && r.geaendert, 0), fertig: z.fertig, laeuft: z.laeuft, offen: z.offen };
  }

  function laufBereinigen(l) {
    if (!l || l.id === undefined || l.id === null) return null;
    return {
      id: String(l.id),
      titel: text(l.titel, 200).trim() || 'Lauf',
      quelle: text(l.quelle, 40),
      status: text(l.status, 40),
      art: l.art === 'arbeiten' || l.art === 'lesen' ? l.art : '',
      erstellt: zahlOder(l.erstellt, 0),
      beendet: zahlOder(l.beendet, 0),
      kindId: l.kindId === undefined ? null : l.kindId,
      eltern: l.eltern === undefined ? null : l.eltern,
      antwort: text(l.antwort, 4000),
      fehler: text(l.fehler, 800) || text(l.notiz, 800),
    };
  }

  function jobBereinigen(j) {
    if (!j || typeof j.id !== 'string' || !JOB_KENNUNG.test(j.id)) return null;
    return {
      id: j.id,
      name: text(j.name, 200).trim() || j.id,
      laeuft: j.laeuft === true,
      start: zahlOder(j.start, 0),
      ende: zahlOder(j.ende, 0),
      exit: Number.isInteger(j.exit) ? j.exit : null,
      grund: text(j.grund, 40),
      dauer_s: Math.max(0, zahlOder(j.dauer_s, 0)),
      gespraech: j.gespraech === undefined ? null : j.gespraech,
    };
  }

  // --- Palette und Startseite: Hub-Werkzeuge und was der Runner über sich meldet, nur bekannte Felder ---
  /** Ein Hub-Werkzeug aus GET /api/werkzeuge: Name und die erste Zeile der Beschreibung. */
  function werkzeugBereinigen(w) {
    if (!w || typeof w.name !== 'string' || !w.name.trim()) return null;
    const b = typeof w.beschreibung === 'string' ? w.beschreibung : typeof w.description === 'string' ? w.description : '';
    return { name: text(w.name.trim(), 200), beschreibung: text(b.trim().split('\n')[0].trim(), 300) };
  }

  /**
   * GET /api/health als das, was die Startseite zeigt. Was der Runner nicht meldet, bleibt null (der volle Runner nennt kein Modell):
   * { pausiert, spielmodus, gespraeche, modell: { name, antwortet: true|false|null } | null, wartend: Zahl | null,
   *   arbeit: { offen, warum, geprueft } | null, hub: { erreichbar, eingerichtet, text } | null }
   */
  function betriebBereinigen(r) {
    r = r && typeof r === 'object' ? r : {};
    const m = r.model && typeof r.model === 'object' ? r.model : null;
    const q = r.queue && typeof r.queue === 'object' ? r.queue : null;
    const h = r.hub && typeof r.hub === 'object' ? r.hub : null;
    let hub = null;
    if (h) {
      if (h.ok === true) {
        const p = h.daten && typeof h.daten === 'object' ? h.daten.plugins : null;
        const n = Array.isArray(p) ? p.length : Number.isFinite(p) ? Math.trunc(p) : null;
        const krank = Array.isArray(p) ? p.filter((x) => x && x.healthy === false).length : 0;
        hub = { erreichbar: true, eingerichtet: true, text: n === null ? '' : `${n} Erweiterungen${krank ? ` · ${krank} nicht gesund` : ''}` };
      } else {
        // Ein Runner ohne Hub meldet das als Fehler der Abfrage („Kein Hub konfiguriert“): das ist kein Ausfall.
        const grund = text(h.fehler, 200);
        hub = { erreichbar: false, eingerichtet: !/kein hub|no hub|nicht konfiguriert|nicht eingerichtet|not configured/i.test(grund), text: grund };
      }
    }
    return {
      pausiert: r.pausiert === true,
      spielmodus: text(r.spielmodus, 60),
      gespraeche: Math.max(0, Math.trunc(zahlOder(r.gespraeche, 0))),
      modell: m && (typeof m.name === 'string' || typeof m.answers === 'boolean') ? { name: text(m.name, 120), antwortet: typeof m.answers === 'boolean' ? m.answers : null } : null,
      wartend: q && Number.isFinite(q.waiting) ? Math.max(0, Math.trunc(q.waiting)) : null,
      // voller Runner: darf der Agent gerade von selbst arbeiten (Hintergrund-Tor)? Zu ist es auch, wenn das Modell nicht antwortet.
      arbeit: r.arbeit && typeof r.arbeit === 'object' && typeof r.arbeit.offen === 'boolean' ? { offen: r.arbeit.offen, warum: text(r.arbeit.warum, 200), geprueft: Number.isFinite(r.arbeit.geprueft) ? r.arbeit.geprueft : null } : null,
      hub,
    };
  }

  // --- Browser des Agenten: Stand und Bild der Seite, nur bekannte Felder ---
  const BILD_ARTEN = ['image/jpeg', 'image/png'];
  const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

  /** Stand (und, wenn dabei, Bild) des Browsers. Ein Bild gilt nur als JPEG oder PNG in Base64 und bis 8 MB; alles andere fällt weg. */
  function browserBereinigen(r) {
    const b = (r && r.browser) || {};
    const groesse = (x, standard) => Math.max(1, Math.min(10000, Math.trunc(zahlOder(x, standard))));
    const bild = typeof b.bild === 'string' && b.bild.length <= 11_000_000 && BASE64.test(b.bild) && BILD_ARTEN.includes(b.typ) ? b.bild : null;
    return {
      verfuegbar: b.verfuegbar === true,
      laeuft: b.laeuft === true,
      grund: text(b.grund, 600),
      url: text(b.url, 2000),
      titel: text(b.titel, 300),
      breite: groesse(b.breite, 1280),
      hoehe: groesse(b.hoehe, 800),
      kenn: /^[0-9a-f]{8,40}$/.test(String(b.kenn || '')) ? String(b.kenn) : '',
      unveraendert: b.unveraendert === true,
      typ: bild ? b.typ : '',
      bild,
    };
  }

  // --- Stände und Zurückspulen: geänderte Dateien, Stände, Unterschied einer Datei, Probe eines Zurücksetzens ---
  const DATEI_ZUSTAENDE = ['neu', 'geaendert', 'geloescht'];
  const PROBE_AKTIONEN = ['wiederherstellen', 'loeschen', 'unveraendert', 'nicht_gesichert'];
  const zeilenZahl = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.trunc(x) : null);

  /** Antwort von GET …/staende: Dateien (höchstens 500) und Stände (höchstens 200) in festen Formen; die Summen werden hier neu gerechnet. */
  function staendeBereinigen(r) {
    const dateien = (r && Array.isArray(r.dateien) ? r.dateien : [])
      .filter((d) => d && typeof d.pfad === 'string' && d.pfad)
      .slice(0, 500)
      .map((d) => ({
        pfad: d.pfad.slice(0, 4000),
        relativ: text(d.relativ, 4000) || d.pfad.slice(0, 4000),
        zustand: DATEI_ZUSTAENDE.includes(d.zustand) ? d.zustand : 'geaendert',
        plus: zeilenZahl(d.plus),
        minus: zeilenZahl(d.minus),
        aenderungen: Math.max(1, Math.trunc(zahlOder(d.aenderungen, 1))),
        fremd: d.fremd === true,
        gesichert: d.gesichert !== false,
      }));
    const staende = (r && Array.isArray(r.staende) ? r.staende : [])
      .filter((s) => s && (typeof s.id === 'string' || typeof s.id === 'number') && String(s.id))
      .slice(0, 200)
      .map((s) => ({
        id: String(s.id).slice(0, 80),
        zeit: zahlOder(s.zeit, 0),
        titel: text(s.titel, 200).trim(),
        aenderungen: Math.max(0, Math.trunc(zahlOder(s.aenderungen, 0))),
        dateien: Math.max(0, Math.trunc(zahlOder(s.dateien, 0))),
        gespraech: s.gespraech === true,
      }));
    let plus = 0;
    let minus = 0;
    for (const d of dateien) {
      plus += d.plus || 0;
      minus += d.minus || 0;
    }
    return { ordner: text(r && r.ordner, 4000), dateien, staende, gesamt: { dateien: dateien.length, plus, minus } };
  }

  /** Antwort von GET …/staende/diff: der Patch nur als Text und bis 600 000 Zeichen. */
  function staendeDiffBereinigen(r) {
    const patch = r && typeof r.patch === 'string' && r.patch.length <= 600000 ? r.patch : null;
    return { relativ: text(r && r.relativ, 4000), patch, plus: zeilenZahl(r && r.plus), minus: zeilenZahl(r && r.minus), grund: patch ? '' : text(r && r.grund, 40) || 'kein_text' };
  }

  /** Antwort von POST …/zurueck (Probe und Ausführung): welche Dateien, was mit ihnen geschieht, ob das Gespräch mit zurückgeht. */
  function zurueckBereinigen(r) {
    const aktionen = [...PROBE_AKTIONEN, 'wiederhergestellt', 'geloescht'];
    const dateien = (r && Array.isArray(r.dateien) ? r.dateien : [])
      .filter((d) => d && typeof d.relativ === 'string' && d.relativ)
      .slice(0, 500)
      .map((d) => ({ relativ: d.relativ.slice(0, 4000), aktion: aktionen.includes(d.aktion) ? d.aktion : 'unveraendert', fremd: d.fremd === true }));
    return {
      probe: !!(r && r.probe === true),
      gespraech: !!(r && r.gespraech === true),
      gespraechGrund: text(r && r.gespraechGrund, 40),
      zeit: zahlOder(r && r.zeit, 0),
      eintraege: Math.max(0, Math.trunc(zahlOder(r && r.eintraege, 0))),
      nachricht: r && typeof r.nachricht === 'string' ? r.nachricht.slice(0, 40000) : '',
      dateien,
    };
  }

  // --- Anhänge an einer Nachricht: was der Runner annimmt, und was an einer Nachricht im Verlauf hängt ---
  const VORSCHAU = /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/;

  /** Antwort von GET /api/anhaenge: nimmt der Runner Anhänge an, sieht das Modell Bilder, und die Grenzen (mit sicheren Vorgaben). */
  function anhaengeBereinigen(r) {
    const g = (r && r.grenzen) || {};
    const zahl = (x, vorgabe, min, max) => Math.max(min, Math.min(max, Math.trunc(zahlOder(x, vorgabe))));
    return {
      an: !!(r && r.an === true),
      bilder: !!(r && r.bilder === true),
      bilderQuelle: text(r && r.bilderQuelle, 40),
      grenzen: {
        anzahl: zahl(g.anzahl, 8, 1, 20),
        bildBytes: zahl(g.bildBytes, 12 * 1024 * 1024, 1024, 64 * 1024 * 1024),
        dateiBytes: zahl(g.dateiBytes, 8 * 1024 * 1024, 1024, 64 * 1024 * 1024),
        gesamtBytes: zahl(g.gesamtBytes, 20 * 1024 * 1024, 1024, 128 * 1024 * 1024),
      },
    };
  }

  /**
   * Die Anhänge einer Nachricht im Verlauf (`data.anhaenge` des Eintrags): höchstens 20, nur bekannte Felder. Die Vorschau eines Bildes gilt nur als
   * JPEG oder PNG in Base64 und bis 60 000 Zeichen; alles andere fällt weg (dann steht nur der Name da).
   */
  function nachrichtAnhaenge(liste) {
    return (Array.isArray(liste) ? liste : [])
      .filter((a) => a && typeof a.name === 'string' && a.name && (a.art === 'bild' || a.art === 'datei'))
      .slice(0, 20)
      .map((a) => ({
        art: a.art,
        name: a.name.slice(0, 200),
        groesse: Math.max(0, Math.trunc(zahlOder(a.groesse, 0))),
        breite: Math.max(0, Math.trunc(zahlOder(a.breite, 0))),
        hoehe: Math.max(0, Math.trunc(zahlOder(a.hoehe, 0))),
        vorschau: a.art === 'bild' && typeof a.vorschau === 'string' && a.vorschau.length <= 60000 && VORSCHAU.test(a.vorschau) ? a.vorschau : '',
        ansModell: a.ansModell === true,
        pfad: text(a.pfad, 2000),
      }));
  }

  const BILD_TYPEN = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  /**
   * Antwort von GET /api/datei?…&bild=1: eine Bilddatei als Bild. Nur ein bekannter Bildtyp und reines Base64 (bis 9 Millionen Zeichen) gelten;
   * sonst null (ein Runner, der `bild=1` nicht kennt, antwortet mit Text oder „Binärdatei“).
   */
  function dateiBildBereinigen(r, pfad) {
    if (!r || !BILD_TYPEN.includes(r.typ) || typeof r.bild !== 'string' || !r.bild || r.bild.length > 9000000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(r.bild)) return null;
    return {
      pfad: String(r.pfad || pfad || ''),
      typ: r.typ,
      bild: r.bild,
      breite: Math.max(0, Math.trunc(zahlOder(r.breite, 0))),
      hoehe: Math.max(0, Math.trunc(zahlOder(r.hoehe, 0))),
      groesse: Math.max(0, Math.trunc(zahlOder(r.groesse, 0))),
      verkleinert: r.verkleinert === true,
      geaendert: zahlOder(r.geaendert, 0),
    };
  }

  function createWege(transport) {
    const api = async (pfad) => {
      try {
        return await transport.api('GET', pfad);
      } catch (f) {
        throw klassifiziere(f);
      }
    };
    return {
      /** Archivierte Sitzungen des Runners. Ältere Runner: { unterstuetzt: false, liste: [] }; ein Netzfehler wirft. */
      async archiv() {
        return archivListePruefen(await api('/api/gespraeche?archiv=1'));
      },
      async suche(q, o) {
        o = o || {};
        const limit = Math.max(1, Math.min(50, Math.trunc(o.limit || 20)));
        const archiv = ['0', '1', 'alle'].includes(String(o.archiv)) ? String(o.archiv) : 'alle';
        const r = await api(`/api/suche?q=${kodiere(q)}&limit=${limit}&archiv=${archiv}`);
        const treffer = (Array.isArray(r.treffer) ? r.treffer : []).map(trefferBereinigen).filter(Boolean);
        return { treffer, abgeschnitten: r.abgeschnitten === true, durchsucht: zahlOder(r.durchsucht, 0), gesamt: zahlOder(r.gesamt, treffer.length) };
      },
      async datei(pfad, o) {
        o = o || {};
        let w = `/api/datei?pfad=${kodiere(pfad)}`;
        if (o.gespraech !== undefined && o.gespraech !== null && o.gespraech !== '') w += `&gespraech=${kodiere(o.gespraech)}`;
        w += `&max=${Math.max(1, Math.trunc(o.max || 200000))}`;
        const r = await api(w);
        if (r.binaer === true) return { art: 'binaer', pfad: String(r.pfad || pfad), groesse: zahlOder(r.groesse, 0) };
        if (typeof r.text !== 'string') throw Object.assign(new Error('Der Runner hat keinen Text geliefert.'), { art: 'andere', status: null });
        return {
          art: 'text',
          pfad: String(r.pfad || pfad),
          text: r.text,
          groesse: zahlOder(r.groesse, r.text.length),
          abgeschnitten: r.abgeschnitten === true,
          geschwaerzt: r.geschwaerzt === true,
          geaendert: zahlOder(r.geaendert, 0),
        };
      },
      /**
       * Eine Bilddatei als Bild (im Ordner der Sitzung, in einem freigegebenen Ordner oder ein Anhang der Sitzung). Ein Runner, der das nicht
       * kann, antwortet ohne Bild: Fehler mit art 'weg_fehlt'.
       */
      async dateiBild(pfad, o) {
        o = o || {};
        let w = `/api/datei?pfad=${kodiere(pfad)}`;
        if (o.gespraech !== undefined && o.gespraech !== null && o.gespraech !== '') w += `&gespraech=${kodiere(o.gespraech)}`;
        const b = dateiBildBereinigen(await api(`${w}&bild=1`), pfad);
        if (!b) throw Object.assign(new Error('Dieser Runner zeigt keine Bilder.'), { art: 'weg_fehlt', status: null });
        return b;
      },
      /**
       * Die Einträge eines Ordners, Ordner zuerst. Mit `o.versteckt` bittet die Tafel „Dateien“ auch um Punkt-Dateien; ein Runner, der das
       * nicht kennt (der volle), lässt sie einfach weg.
       */
      async ordner(pfad, o) {
        const r = await api(`/api/ordner?pfad=${kodiere(pfad)}&dateien=1${o && o.versteckt ? '&versteckt=1' : ''}`);
        const eintraege = (Array.isArray(r.eintraege) ? r.eintraege : [])
          .filter((e) => e && typeof e.name === 'string' && e.name)
          .map((e) => ({ name: e.name, ordner: e.ordner !== false, groesse: zahlOder(e.groesse, null) }));
        return { eintraege, abgeschnitten: r.abgeschnitten === true };
      },
      /**
       * Dateien im Ordner der Sitzung, deren Pfad den getippten Text enthält (Tafel „Dateien“). Nur der lokale Runner kennt den Weg; sonst
       * Fehler mit art 'weg_fehlt'. → { treffer: [{ relativ, name }], gesamt, gekuerzt, unvollstaendig }
       */
      async dateiSuche(id, q, o) {
        const limit = Math.max(1, Math.min(200, Math.trunc((o && o.limit) || 50)));
        const r = await api(`/api/gespraech/${kodiere(id)}/dateien?q=${kodiere(q)}&limit=${limit}`);
        if (!r || !Array.isArray(r.treffer)) throw Object.assign(new Error(MELDUNG.weg_fehlt), { art: 'weg_fehlt', status: null });
        const treffer = r.treffer
          .filter((t) => t && typeof t.relativ === 'string' && t.relativ && !t.relativ.startsWith('/') && !t.relativ.split('/').includes('..'))
          .map((t) => ({ relativ: text(t.relativ, 2000), name: text(t.relativ.slice(t.relativ.lastIndexOf('/') + 1), 400) }));
        return { treffer, gesamt: Math.max(treffer.length, Math.trunc(zahlOder(r.gesamt, treffer.length))), gekuerzt: r.gekuerzt === true, unvollstaendig: r.unvollstaendig === true };
      },
      /** Die Aufgabenliste, die der Agent in dieser Sitzung führt. Ältere Runner kennen den Weg nicht (Fehler mit art 'weg_fehlt'). */
      async aufgaben(id) {
        return aufgabenBereinigen(await api(`/api/gespraech/${kodiere(id)}/aufgaben`));
      },
      /** Läufe des Runners: Unteragenten (quelle 'unteragent') und lange Läufe, neueste zuerst. */
      async laeufe() {
        const r = await api('/api/laeufe');
        return (Array.isArray(r.laeufe) ? r.laeufe : []).map(laufBereinigen).filter(Boolean);
      },
      /** Befehle im Hintergrund: laufende und die der letzten 24 Stunden. */
      async jobs() {
        const r = await api('/api/jobs');
        return (Array.isArray(r.jobs) ? r.jobs : []).map(jobBereinigen).filter(Boolean);
      },
      /** Befehl und letzte Zeilen der Ausgabe eines Hintergrundjobs. */
      async job(id, zeilen) {
        if (typeof id !== 'string' || !JOB_KENNUNG.test(id)) throw Object.assign(new Error(MELDUNG.ungueltig), { art: 'ungueltig', status: null });
        const r = await api(`/api/jobs/${kodiere(id)}?zeilen=${Math.max(1, Math.min(500, Math.trunc(zeilen || 120)))}`);
        const j = jobBereinigen(r && r.job);
        if (!j) throw Object.assign(new Error(MELDUNG.nicht_gefunden), { art: 'nicht_gefunden', status: 404 });
        return { ...j, befehl: text(r.job.befehl, 2000), text: text(r.job.text, 200000), gekuerzt: r.job.gekuerzt === true };
      },
      /** Stand des Browsers, den der Agent bedient (startet ihn nicht). Runner ohne Browser-Fläche: Fehler mit art 'weg_fehlt'. */
      async browser() {
        return browserBereinigen(await api('/api/browser'));
      },
      /** Bild der Seite; mit `kenn` (Kennung des schon gezeigten Bildes) kommt ein unverändertes Bild nicht noch einmal. */
      async browserBild(kenn) {
        const k = /^[0-9a-f]{8,40}$/.test(String(kenn || '')) ? `?kenn=${kenn}` : '';
        return browserBereinigen(await api(`/api/browser/bild${k}`));
      },
      /** Was der Runner an einer Nachricht annimmt (Bilder, Dateien). Runner ohne Anhänge: Fehler mit art 'weg_fehlt'. */
      async anhaenge() {
        const r = await api('/api/anhaenge');
        if (!r || r.an !== true || !r.grenzen) throw Object.assign(new Error(MELDUNG.weg_fehlt), { art: 'weg_fehlt', status: null });
        return anhaengeBereinigen(r);
      },
      /** Geänderte Dateien und Stände einer Sitzung (was der Agent mit write und edit geändert hat). Runner ohne Stände: Fehler mit art 'weg_fehlt'. */
      async staende(id) {
        const r = await api(`/api/gespraech/${kodiere(id)}/staende`);
        // Nur eine Antwort mit beiden Listen ist eine Antwort auf diese Frage: alles andere gilt als „der Runner kennt den Weg nicht“,
        // damit eine fremde oder leere Antwort nicht als „nichts geändert“ gelesen wird.
        if (!r || !Array.isArray(r.dateien) || !Array.isArray(r.staende)) throw Object.assign(new Error(MELDUNG.weg_fehlt), { art: 'weg_fehlt', status: null });
        return staendeBereinigen(r);
      },
      /** Der Unterschied einer Datei zwischen dem Stand vor der Arbeit des Agenten und jetzt. `pfad`: der ganze Pfad aus staende(). */
      async staendeDiff(id, pfad) {
        return staendeDiffBereinigen(await api(`/api/gespraech/${kodiere(id)}/staende/diff?pfad=${kodiere(pfad)}`));
      },
      /** Hub-Werkzeuge, die zur Eingabe passen (höchstens 50). Ein Runner ohne Hub antwortet mit einer leeren Liste. */
      async werkzeuge(q) {
        const r = await api(`/api/werkzeuge?q=${kodiere(q)}`);
        return (r && Array.isArray(r.werkzeuge) ? r.werkzeuge : []).map(werkzeugBereinigen).filter(Boolean).slice(0, 50);
      },
      /** Was der Runner über sich meldet: Pause, Zahl der Sitzungen, Modell (lokaler Runner), Hub. */
      async betrieb() {
        return betriebBereinigen(await api('/api/health'));
      },
    };
  }

  /**
   * Der Eintrag der Modellliste (GET /api/modelle), der zu `modell` gehört. `modell`: Text ("anbieter/id", "id" oder Name) oder Objekt
   * ({ provider, modelId | id, name }). → Eintrag oder null. `nurMitFenster`: nur Einträge mit contextWindow.
   */
  function modellEintrag(modelle, modell, nurMitFenster) {
    if (!Array.isArray(modelle) || !modell) return null;
    const ids = [];
    let anbieter = '';
    if (typeof modell === 'string') {
      ids.push(modell);
      const i = modell.indexOf('/');
      if (i > 0) {
        anbieter = modell.slice(0, i);
        ids.push(modell.slice(i + 1));
      }
    } else if (typeof modell === 'object') {
      for (const k of ['id', 'modelId', 'name']) if (typeof modell[k] === 'string' && modell[k]) ids.push(modell[k]);
      if (typeof modell.provider === 'string') anbieter = modell.provider;
    }
    const gut = (m) => m && (!nurMitFenster || (typeof m.contextWindow === 'number' && Number.isFinite(m.contextWindow) && m.contextWindow > 0));
    const passt = (m) => ids.includes(m.id) || ids.includes(m.name) || ids.includes(`${m.provider}/${m.id}`);
    const treffer = modelle.filter((m) => gut(m) && passt(m));
    return treffer.find((m) => anbieter && m.provider === anbieter) || treffer[0] || null;
  }

  /** Fenstergröße des Modells aus der Liste von GET /api/modelle (siehe modellEintrag). → Zahl oder null. */
  function fensterAusModellen(modelle, modell) {
    const m = modellEintrag(modelle, modell, true);
    return m ? m.contextWindow : null;
  }

  FP.wege = {
    createWege, klassifiziere, fehlerTeile, wegFehlt, kodiere, markierungenPruefen, trefferBereinigen, archivListePruefen, fensterAusModellen, modellEintrag, MELDUNG,
    aufgabenBereinigen, laufBereinigen, jobBereinigen, browserBereinigen, staendeBereinigen, staendeDiffBereinigen, zurueckBereinigen, anhaengeBereinigen, nachrichtAnhaenge, dateiBildBereinigen,
    werkzeugBereinigen, betriebBereinigen,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
