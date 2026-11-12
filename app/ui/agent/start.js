/**
 * start.js — die Startseite („Überblick“): was über alle Sitzungen auf den Menschen wartet, was von selbst läuft, wie es Runner, Modell und
 * Hub geht und wo zuletzt gearbeitet wurde (Paket B3 in FYOS-AGENT-LOKAL-PLAN). Die Seite kennt den Runner nicht: chat.js reicht ihr
 * Rückrufe herein. Entschieden wird hier nichts; eine Freigabe führt in das Panel der Freigaben (dort liegen Notiz, „Später“ und die zweite
 * Bestätigung bei Zerstörerischem). Texte kommen nur als textContent in die Seite.
 *
 * Abschnitte:
 *   Braucht dich   offene Freigaben, Pläne und Entscheidungen aller Sitzungen, die älteste zuerst
 *   Läuft          Sitzungen, in denen der Agent arbeitet (mit dem Stand ihrer Aufgabenliste), Befehle im Hintergrund, Unteragenten
 *   Betrieb        nur was der Runner selbst meldet: Runner (Pause), Modell (lokaler Runner), Hub
 *   Zuletzt        die Sitzungen, in denen zuletzt etwas geschah
 *
 * createStart(refs, opts) → { zeige(), verberge(), sichtbar(), lade(), zeichne(), zustand(), ende() }
 *   refs: { wurzel }   leeres Element; die Seite baut sich hinein
 *   opts: {
 *     sitzungen()    → Zeilen der Leiste [{ id, titel, ordner, zeit, zeitText, laeuft, angepinnt }] (ohne Archiv)
 *     freigaben()    → offene Freigaben [{ id, conversationId, gespraechTitel, aktion, befehl, werkzeug, art, risiko, zerstoererisch }]
 *     aufgaben(id)   → Promise<Aufgabenliste>  (wege.aufgaben; ein Fehler heißt: keine Liste)
 *     laeufe()       → Promise<[Lauf]>, jobs() → Promise<[Job]>   (wege.laeufe, wege.jobs; ein Fehler heißt: keine)
 *     betrieb()      → Promise<{ pausiert, spielmodus, hub, modell, wartend } | null>   (wege.betrieb)
 *     beiSitzung(id), beiFreigaben(), beiPalette(), beiNeu(), beiZurueck()
 *     intervallMs    Vorgabe 5000, 0 = kein Abfragen; die Seite fragt nur, solange sie sichtbar ist
 *     jetzt, setInterval, clearInterval
 *   }
 */
(function (global) {
  'use strict';
  const FP = (global.FyosPrototyp = global.FyosPrototyp || {});

  const ZAHL = ['null', 'eine', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf'];
  const gross = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const wort = (n) => (n >= 0 && n < ZAHL.length ? ZAHL[n] : String(n));
  const kurz = (s, n) => {
    const t = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const RISIKO = { low: 'geringes Risiko', medium: 'mittleres Risiko', high: 'hohes Risiko' };

  /** Der eine Satz oben: wie viel wartet, wie viel läuft. */
  function gruss(braucht, laeuft) {
    const links = braucht === 0 ? 'Nichts braucht dich' : braucht === 1 ? 'Eine Sache braucht dich' : `${gross(wort(braucht))} Dinge brauchen dich`;
    const rechts = laeuft === 0 ? 'nichts läuft' : laeuft === 1 ? 'eines läuft von selbst' : `${wort(laeuft)} laufen von selbst`;
    return `${links}, ${rechts}.`;
  }

  /** Eine offene Freigabe als Zeile von „Braucht dich“. */
  function brauchtZeile(f) {
    const befehl = kurz(f.befehl || f.werkzeug || '', 160);
    const aktion = kurz(f.aktion || '', 160);
    let titel;
    if (f.art === 'plan') titel = `Plan wartet: ${aktion || 'ohne Titel'}`;
    else if (f.art === 'karte') titel = `Entscheidung: ${aktion || 'ohne Titel'}`;
    else titel = `Freigabe: ${befehl || aktion || 'ohne Angabe'}`;
    const unter = [kurz(f.gespraechTitel || '', 80)];
    if (f.art !== 'plan' && f.art !== 'karte') {
      if (f.zerstoererisch) unter.push('zerstörerisch');
      else unter.push(RISIKO[f.risiko] || RISIKO.medium);
      if (befehl && aktion) unter.push(aktion);
    }
    return {
      id: String(f.id),
      art: f.art === 'plan' || f.art === 'karte' ? f.art : 'freigabe',
      titel,
      unter: unter.filter(Boolean).join(' · '),
      sitzung: f.conversationId === undefined ? null : f.conversationId,
      ernst: !!f.zerstoererisch || f.risiko === 'high',
    };
  }

  /**
   * Was die Seite zeigt, aus dem, was Leiste, Freigaben und Runner wissen (reine Funktion).
   * e: { sitzungen, freigaben, aufgaben (Map: Sitzungs-Id → Aufgabenliste), laeufe, jobs, jetzt }
   * → { gruss, braucht: [...], laeuft: [...], zuletzt: [...] }
   */
  function startSicht(e) {
    e = e || {};
    const jetzt = e.jetzt || Date.now();
    const W = FP.werkbank || {};
    const sitzungen = Array.isArray(e.sitzungen) ? e.sitzungen.filter((s) => s && s.id !== undefined && s.id !== null) : [];
    const titelVon = new Map(sitzungen.map((s) => [String(s.id), s.titel]));
    const braucht = (Array.isArray(e.freigaben) ? e.freigaben : []).filter((f) => f && f.id !== undefined && f.id !== null).map(brauchtZeile);
    const wartend = new Set(braucht.map((b) => String(b.sitzung)));

    const laeuft = [];
    for (const s of sitzungen) {
      if (!s.laeuft) continue;
      const a = e.aufgaben && typeof e.aufgaben.get === 'function' ? e.aufgaben.get(String(s.id)) : null;
      const sicht = a && W.aufgabenSicht ? W.aufgabenSicht(a) : null;
      const mitListe = sicht && !sicht.leer;
      laeuft.push({
        art: 'sitzung',
        id: String(s.id),
        sitzung: s.id,
        titel: s.titel,
        unter: wartend.has(String(s.id)) ? 'wartet auf dich' : mitListe && sicht.aktuell ? kurz(sicht.aktuell, 120) : s.ordner || '',
        anteil: mitListe ? sicht.anteil : null,
        rechts: wartend.has(String(s.id)) ? 'wartet' : mitListe ? `${sicht.fertig}/${sicht.gesamt}` : 'arbeitet',
        haelt: wartend.has(String(s.id)),
      });
    }
    const nebenher = W.laeufeSicht ? W.laeufeSicht(e.laeufe, e.jobs, { jetzt, max: 200 }).zeilen.filter((z) => z.zustand === 'laeuft') : [];
    for (const z of nebenher) {
      const eltern = z.gespraech === undefined || z.gespraech === null ? '' : titelVon.get(String(z.gespraech)) || '';
      laeuft.push({
        art: z.art,
        id: z.schluessel,
        sitzung: z.art === 'unteragent' && z.kindId !== null && z.kindId !== undefined ? z.kindId : z.gespraech === undefined ? null : z.gespraech,
        titel: `${z.art === 'job' ? 'Hintergrund' : z.art === 'unteragent' ? 'Unteragent' : 'Lauf'}: ${kurz(z.titel, 120)}`,
        unter: eltern,
        anteil: null,
        rechts: z.dauerText || 'läuft',
        haelt: false,
      });
    }

    const zuletzt = sitzungen
      .filter((s) => !s.laeuft)
      .slice()
      .sort((a, b) => (Number(b.zeit) || 0) - (Number(a.zeit) || 0))
      .slice(0, 6)
      .map((s) => ({ id: String(s.id), sitzung: s.id, titel: s.titel, unter: s.ordner || '', rechts: s.zeitText || '', angepinnt: !!s.angepinnt }));

    return { gruss: gruss(braucht.length, laeuft.filter((l) => !l.haelt).length), braucht, laeuft, zuletzt };
  }

  /** Die Kacheln von „Betrieb“ aus wege.betrieb(): nur was gemeldet ist. → [{ titel, wert, chip, art: 'gut'|'warn'|'schlecht'|'' }] */
  function betriebSicht(b, o) {
    o = o || {};
    if (!b) return [{ titel: 'Runner', wert: o.fehler || 'antwortet nicht', chip: 'nicht erreichbar', art: 'schlecht' }];
    const kacheln = [];
    const n = Number(b.gespraeche) || 0;
    const sitz = n === 1 ? '1 Sitzung' : `${n} Sitzungen`;
    if (b.spielmodus) kacheln.push({ titel: 'Runner', wert: `${sitz} · Pause (${kurz(b.spielmodus, 40)})`, chip: 'pausiert', art: 'warn' });
    else if (b.pausiert) kacheln.push({ titel: 'Runner', wert: `${sitz} · Ruhe`, chip: 'pausiert', art: 'warn' });
    else kacheln.push({ titel: 'Runner', wert: sitz, chip: 'verbunden', art: 'gut' });
    if (b.modell) {
      const name = kurz(b.modell.name || 'ohne Namen', 60);
      const wartet = Number.isFinite(b.wartend) && b.wartend > 0 ? ` · ${b.wartend} in der Schlange` : '';
      if (b.modell.antwortet === true) kacheln.push({ titel: 'Modell', wert: `${name}${wartet}`, chip: 'antwortet', art: 'gut' });
      else if (b.modell.antwortet === false) kacheln.push({ titel: 'Modell', wert: `${name}${wartet}`, chip: 'antwortet nicht', art: 'schlecht' });
      else kacheln.push({ titel: 'Modell', wert: `${name}${wartet}`, chip: 'ungeprüft', art: '' });
    }
    if (b.hub) {
      if (b.hub.erreichbar) kacheln.push({ titel: 'Hub', wert: b.hub.text || 'Werkzeuge über den Hub', chip: 'erreichbar', art: 'gut' });
      else if (b.hub.eingerichtet === false) kacheln.push({ titel: 'Hub', wert: 'Kein Hub eingerichtet', chip: 'aus', art: '' });
      else kacheln.push({ titel: 'Hub', wert: kurz(b.hub.text || 'keine Antwort', 120), chip: 'nicht erreichbar', art: 'warn' });
    }
    return kacheln;
  }

  function createStart(refs, opts) {
    opts = opts || {};
    const wurzel = refs.wurzel;
    const doc = wurzel.ownerDocument;
    const jetzt = opts.jetzt || (() => Date.now());
    const setI = opts.setInterval || ((f, ms) => setInterval(f, ms));
    const clearI = opts.clearInterval || ((z) => clearInterval(z));
    const intervall = opts.intervallMs === undefined ? 5000 : opts.intervallMs;
    const el = (tag, cls, text) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined && text !== null) e.textContent = text;
      return e;
    };
    const knopf = (text, cls, beiKlick) => {
      const b = el('button', cls, text);
      b.type = 'button';
      b.addEventListener('click', beiKlick);
      return b;
    };
    const sicher = (fn, ...a) => {
      try {
        return typeof fn === 'function' ? fn(...a) : undefined;
      } catch {
        return undefined;
      }
    };

    wurzel.hidden = true;
    wurzel.classList.add('ueb');
    const kopf = el('header', 'ueb-kopf');
    const satz = el('h2', 'ueb-gruss');
    satz.setAttribute('aria-live', 'polite');
    const knoepfe = el('div', 'ueb-knoepfe');
    // Kopf und Eingabe des Gesprächs sind hier ausgeblendet, und die Leiste kann eingeklappt sein: ohne diesen Knopf käme man nicht zurück.
    if (typeof opts.beiZurueck === 'function') knoepfe.append(knopf('‹ Chat', 'leise-knopf klein ueb-zurueck', () => sicher(opts.beiZurueck)));
    if (typeof opts.beiNeu === 'function') knoepfe.append(knopf('Neue Sitzung', 'primaer klein', () => sicher(opts.beiNeu)));
    if (typeof opts.beiPalette === 'function') knoepfe.append(knopf('Suchen und springen', 'klein ueb-palette', () => sicher(opts.beiPalette)));
    kopf.append(satz, knoepfe);
    const abschnitt = (titel, cls) => {
      const s = el('section', `ueb-abschnitt ${cls}`);
      const h = el('h3', 'ueb-titel', titel);
      const k = el('div', 'ueb-koerper');
      s.append(h, k);
      return { s, k };
    };
    const A = {
      braucht: abschnitt('Braucht dich', 'ueb-braucht'),
      laeuft: abschnitt('Läuft', 'ueb-laeuft'),
      betrieb: abschnitt('Betrieb', 'ueb-betrieb'),
      zuletzt: abschnitt('Zuletzt', 'ueb-zuletzt'),
    };
    const spalte = el('div', 'ueb-spalte');
    spalte.append(kopf, A.braucht.s, A.laeuft.s, A.betrieb.s, A.zuletzt.s);
    wurzel.replaceChildren(spalte);

    let sichtbar = false;
    let zeit = null;
    let lauf = 0;
    const aufgaben = new Map(); // Sitzungs-Id → Aufgabenliste der laufenden Sitzungen
    let laeufe = [];
    let jobs = [];
    let betrieb; // undefined: noch nicht gefragt; null: Runner antwortet nicht
    let betriebFehler = '';
    let sig = '';
    let letzte = null;

    const zurSitzung = (id) => {
      if (id !== null && id !== undefined && id !== '') sicher(opts.beiSitzung, id);
    };

    function zeile(z, cls) {
      const d = el('div', `ueb-zeile ${cls || ''}`.trim());
      const text = el('span', 'ueb-text');
      text.append(el('b', 'ueb-name', z.titel));
      if (z.unter) text.append(el('small', 'ueb-unter', z.unter));
      d.append(text);
      return d;
    }

    function zeichne() {
      const s = startSicht({ sitzungen: sicher(opts.sitzungen) || [], freigaben: sicher(opts.freigaben) || [], aufgaben, laeufe, jobs, jetzt: jetzt() });
      const kacheln = betrieb === undefined ? [] : betriebSicht(betrieb, { fehler: betriebFehler });
      letzte = { ...s, betrieb: kacheln };
      const neu = JSON.stringify(letzte);
      if (neu === sig) return;
      sig = neu;
      satz.textContent = s.gruss;

      A.braucht.k.replaceChildren(
        ...(s.braucht.length
          ? s.braucht.map((b) => {
              const d = zeile(b, `ueb-wartet${b.ernst ? ' ernst' : ''}`);
              d.dataset.art = b.art;
              const kn = el('span', 'ueb-zeilenknoepfe');
              kn.append(knopf(b.art === 'plan' ? 'Plan lesen' : 'Ansehen', 'klein', () => sicher(opts.beiFreigaben, b.id)));
              if (b.sitzung !== null) kn.append(knopf('Zur Sitzung', 'klein leise-knopf', () => zurSitzung(b.sitzung)));
              d.append(kn);
              return d;
            })
          : [el('p', 'ueb-leer', 'Nichts wartet auf dich.')]),
      );

      A.laeuft.k.replaceChildren(
        ...(s.laeuft.length
          ? s.laeuft.map((l) => {
              const d = zeile(l, 'ueb-lauf');
              d.dataset.art = l.art;
              d.prepend(el('span', `ueb-punkt${l.haelt ? ' haelt' : ' arbeitet'}`));
              if (l.anteil !== null) {
                const balken = el('span', 'ueb-balken');
                balken.setAttribute('role', 'progressbar');
                balken.setAttribute('aria-valuemin', '0');
                balken.setAttribute('aria-valuemax', '100');
                balken.setAttribute('aria-valuenow', String(Math.round(l.anteil * 100)));
                const i = el('i');
                i.style.setProperty('--w', String(Math.max(0, Math.min(1, l.anteil))));
                balken.append(i);
                d.append(balken);
              }
              d.append(el('span', 'ueb-rechts', l.rechts));
              if (l.sitzung !== null && l.sitzung !== undefined) {
                d.classList.add('ueb-klickbar');
                d.tabIndex = 0;
                d.setAttribute('role', 'button');
                d.addEventListener('click', () => zurSitzung(l.sitzung));
                d.addEventListener('keydown', (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    zurSitzung(l.sitzung);
                  }
                });
              }
              return d;
            })
          : [el('p', 'ueb-leer', 'Gerade läuft nichts.')]),
      );

      A.betrieb.s.hidden = kacheln.length === 0;
      A.betrieb.k.replaceChildren(
        ...kacheln.map((k) => {
          const d = el('div', 'ueb-kachel');
          const oben = el('div', 'ueb-kachelkopf');
          oben.append(el('b', null, k.titel), el('span', `chip ${k.art}`.trim(), k.chip));
          d.append(oben, el('span', 'ueb-wert', k.wert));
          return d;
        }),
      );

      A.zuletzt.s.hidden = s.zuletzt.length === 0;
      A.zuletzt.k.replaceChildren(
        ...s.zuletzt.map((z) => {
          const b = el('button', 'ueb-zeile ueb-klickbar ueb-sitzung');
          b.type = 'button';
          const text = el('span', 'ueb-text');
          text.append(el('b', 'ueb-name', z.titel));
          if (z.unter) text.append(el('small', 'ueb-unter', z.unter));
          b.append(text, el('span', 'ueb-rechts', z.angepinnt ? `angepinnt · ${z.rechts}`.replace(/ · $/, '') : z.rechts));
          b.addEventListener('click', () => zurSitzung(z.sitzung));
          return b;
        }),
      );
    }

    /** Vom Runner holen, was die Seite nicht schon von der Leiste weiß. Jede Quelle für sich: scheitert eine, bleibt der Rest. */
    async function lade() {
      const nr = (lauf += 1);
      const laufende = (sicher(opts.sitzungen) || []).filter((s) => s && s.laeuft).map((s) => String(s.id));
      const aufgabenNeu = new Map();
      const fragen = [
        ...(typeof opts.aufgaben === 'function'
          ? laufende.slice(0, 12).map((id) =>
              Promise.resolve()
                .then(() => opts.aufgaben(id))
                .then((a) => aufgabenNeu.set(id, a))
                .catch(() => {}),
            )
          : []),
        Promise.resolve()
          .then(() => (typeof opts.laeufe === 'function' ? opts.laeufe() : []))
          .then((l) => ({ laeufe: Array.isArray(l) ? l : [] }))
          .catch(() => ({ laeufe: [] })),
        Promise.resolve()
          .then(() => (typeof opts.jobs === 'function' ? opts.jobs() : []))
          .then((j) => ({ jobs: Array.isArray(j) ? j : [] }))
          .catch(() => ({ jobs: [] })),
        Promise.resolve()
          .then(() => (typeof opts.betrieb === 'function' ? opts.betrieb() : undefined))
          .then((b) => ({ betrieb: b === undefined ? undefined : b || null, fehler: '' }))
          .catch((f) => ({ betrieb: null, fehler: (f && (f.meldung || f.message)) || '' })),
      ];
      const antworten = await Promise.all(fragen);
      if (nr !== lauf) return;
      aufgaben.clear();
      for (const [id, a] of aufgabenNeu) aufgaben.set(id, a);
      for (const a of antworten) {
        if (!a || typeof a !== 'object' || a instanceof Map) continue;
        if ('laeufe' in a) laeufe = a.laeufe;
        if ('jobs' in a) jobs = a.jobs;
        if ('betrieb' in a) {
          betrieb = a.betrieb;
          betriebFehler = a.fehler;
        }
      }
      zeichne();
    }

    function zeige() {
      if (sichtbar) return;
      sichtbar = true;
      wurzel.hidden = false;
      zeichne();
      void lade();
      if (intervall && zeit === null) zeit = setI(() => void lade(), intervall);
    }
    function verberge() {
      if (!sichtbar) return;
      sichtbar = false;
      wurzel.hidden = true;
      lauf += 1;
      if (zeit !== null) clearI(zeit);
      zeit = null;
    }

    return {
      zeige,
      verberge,
      sichtbar: () => sichtbar,
      lade,
      /** Leiste oder Freigaben haben sich geändert: neu zeichnen, ohne den Runner zu fragen. */
      zeichne: () => {
        if (sichtbar) zeichne();
      },
      zustand: () => ({ sichtbar, ...(letzte || {}) }),
      ende: verberge,
    };
  }

  FP.start = { createStart, startSicht, betriebSicht, gruss, brauchtZeile };
})(typeof globalThis !== 'undefined' ? globalThis : window);
