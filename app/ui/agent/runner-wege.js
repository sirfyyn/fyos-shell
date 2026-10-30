/* Lesende Wege zum Runner für Archiv, Suche und Datei-Vorschau (reine Logik, ohne DOM): alles läuft über transport.api (Brücke runner_anfrage, nur GET).
 *
 *   archiv()            GET /api/gespraeche?archiv=1          → { unterstuetzt, liste }  (ältere Runner ignorieren den Parameter: dann unterstuetzt = false)
 *   suche(q, o)         GET /api/suche?q=&limit=&archiv=      → { treffer, abgeschnitten, ... }  (Treffer bereinigt; Fehler als Fehler mit .art)
 *   datei(pfad, o)      GET /api/datei?pfad=&gespraech=&max=  → { art: 'text'|'binaer', text, groesse, abgeschnitten, geschwaerzt, geaendert }
 *   ordner(pfad)        GET /api/ordner?pfad=&dateien=1       → { eintraege, abgeschnitten }
 *   modelle()           GET /api/modelle                      → Liste mit contextWindow
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
    else if (['gesperrt', 'verwehrt', 'ausserhalb', 'nicht_gefunden', 'keine_datei', 'zu_gross'].includes(t.text)) art = t.text;
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
      async ordner(pfad) {
        const r = await api(`/api/ordner?pfad=${kodiere(pfad)}&dateien=1`);
        const eintraege = (Array.isArray(r.eintraege) ? r.eintraege : [])
          .filter((e) => e && typeof e.name === 'string' && e.name)
          .map((e) => ({ name: e.name, ordner: e.ordner !== false, groesse: zahlOder(e.groesse, null) }));
        return { eintraege, abgeschnitten: r.abgeschnitten === true };
      },
    };
  }

  /**
   * Fenstergröße des Modells aus der Liste von GET /api/modelle. `modell`: Text ("anbieter/id", "id" oder Name) oder Objekt ({ provider, modelId | id, name }).
   * → Zahl oder null.
   */
  function fensterAusModellen(modelle, modell) {
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
    const gut = (m) => m && typeof m.contextWindow === 'number' && Number.isFinite(m.contextWindow) && m.contextWindow > 0;
    const passt = (m) => ids.includes(m.id) || ids.includes(m.name) || ids.includes(`${m.provider}/${m.id}`);
    const treffer = modelle.filter((m) => gut(m) && passt(m));
    const genau = treffer.find((m) => anbieter && m.provider === anbieter) || treffer[0];
    return genau ? genau.contextWindow : null;
  }

  FP.wege = { createWege, klassifiziere, fehlerTeile, wegFehlt, kodiere, markierungenPruefen, trefferBereinigen, archivListePruefen, fensterAusModellen, MELDUNG };
})(typeof globalThis !== 'undefined' ? globalThis : window);
