/* Vorgänge, Kalender und Ereignisse des Runners als eigene Bereiche im Arbeitsplatz (Runner-Plattform, docs/current/RUNNER-EIGENSTAENDIG.md).
 *
 * Wege (alle über transport.api, also im Fenster über die Brücke): GET/POST /api/tickets, GET /api/tickets/waiting, GET/PATCH /api/tickets/<id>,
 * POST /api/tickets/<id>/comments, POST/DELETE /api/tickets/<id>/archive; GET/POST /api/calendar, PATCH/DELETE /api/calendar/<id>;
 * GET/POST /api/bus, GET /api/bus/state und der Strom /api/bus/stream (Kanal `bus`).
 *
 * Kennt der Runner die Plattform nicht (älterer Runner: 404, ausgeschaltet: 503), bleibt nur der Chat sichtbar. Wer handelt, bestimmt das Token beim
 * Runner, nie diese Seite. Alle Texte kommen von außen und werden nur als Text eingesetzt, nie als HTML.
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  const SPALTEN = [
    ['new', 'Neu'],
    ['in_progress', 'In Arbeit'],
    ['waiting_approval', 'Wartet auf dich'],
    ['triage', 'Ruht'],
    ['resolved', 'Erledigt'],
    ['closed', 'Geschlossen'],
  ];
  const STATUS_TEXT = Object.fromEntries(SPALTEN);
  const ARTEN = { INC: 'Störung', PRB: 'Problem', CHG: 'Änderung', VOR: 'Vorhaben' };
  const SCHWERE = { low: 'gering', medium: 'mittel', high: 'hoch', critical: 'kritisch' };
  const THEMEN = [
    ['inbox', 'Eingang'],
    ['tickets', 'Vorgänge'],
    ['calendar', 'Kalender'],
    ['bridges', 'Brücken'],
  ];
  const TAG = 86_400_000;
  const LISTE_MAX = 300;

  // --- reine Logik (ohne DOM) ---------------------------------------------------------------------------------
  /** Vorgänge nach Spalte; Geschlossene nur auf Wunsch. In jeder Spalte das Schwerste zuerst, dann das zuletzt Geänderte. */
  function spalten(tickets, { geschlossene = false } = {}) {
    const rang = { critical: 0, high: 1, medium: 2, low: 3 };
    const aus = SPALTEN.filter(([s]) => geschlossene || s !== 'closed').map(([status, titel]) => ({ status, titel, vorgaenge: [] }));
    for (const t of Array.isArray(tickets) ? tickets : []) {
      const s = aus.find((x) => x.status === t.status);
      if (s) s.vorgaenge.push(t);
    }
    for (const s of aus) {
      s.vorgaenge.sort((a, b) => (rang[a.severity] ?? 9) - (rang[b.severity] ?? 9) || String(b.updated_at).localeCompare(String(a.updated_at)));
    }
    return aus;
  }

  /** Montag 00:00 (Ortszeit) der Woche von `ms`. */
  function wochenStart(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
  }

  /** Eine Woche Schritt für Schritt über den Kalender, damit die Umstellung der Uhr keinen Tag verschiebt. */
  function tagAb(start, n) {
    const d = new Date(start);
    d.setDate(d.getDate() + n);
    return d.getTime();
  }

  /** Die sieben Tage ab `start` mit ihren Einträgen. Ein Eintrag über mehrere Tage steht an jedem seiner Tage. */
  function wochenTage(start, eintraege) {
    const tage = [];
    for (let i = 0; i < 7; i += 1) {
      const von = tagAb(start, i);
      const bis = tagAb(start, i + 1);
      tage.push({
        von,
        eintraege: (Array.isArray(eintraege) ? eintraege : [])
          .filter((e) => Date.parse(e.from) < bis && Date.parse(e.to) > von)
          .sort((a, b) => Date.parse(a.from) - Date.parse(b.from)),
      });
    }
    return tage;
  }

  const zwei = (n) => String(n).padStart(2, '0');
  /** ISO-Zeit → Wert für `<input type="datetime-local">` in Ortszeit. */
  function fuerEingabe(wert) {
    const d = new Date(wert);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${zwei(d.getMonth() + 1)}-${zwei(d.getDate())}T${zwei(d.getHours())}:${zwei(d.getMinutes())}`;
  }
  /** Wert aus `<input type="datetime-local">` → ISO-Zeit, leer bleibt null. */
  function ausEingabe(wert) {
    if (!wert) return null;
    const d = new Date(wert);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const uhrzeit = (wert) => {
    const d = new Date(wert);
    return Number.isNaN(d.getTime()) ? '' : `${zwei(d.getHours())}:${zwei(d.getMinutes())}`;
  };
  const datumZeit = (wert) => {
    const d = new Date(wert);
    return Number.isNaN(d.getTime()) ? '' : `${zwei(d.getDate())}.${zwei(d.getMonth() + 1)}.${d.getFullYear()} ${uhrzeit(wert)}`;
  };
  const tagKurz = (ms) => new Date(ms).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });

  /** Der Text zu einem Fehler des Runners. Kennt der Runner den Weg nicht oder ist die Plattform aus, `fehlt: true`. */
  function fehlerSicht(f) {
    const t = FP.wege ? FP.wege.fehlerTeile(f) : { status: f && f.status, text: f && f.message };
    return { status: t.status, fehlt: t.status === 404 || t.status === 503, text: t.text || (f && f.message) || String(f) };
  }

  // --- Oberfläche ---------------------------------------------------------------------------------------------
  /**
   * refs: { nav, zahl, haupt, panes, wurzel }  (nav: Knöpfe mit data-bereich; wurzel: leeres Element für die Bereiche)
   * opts: { transport, intervallMs (Vorgabe 5000, 0 = kein Abfragen), jetzt, beiChat }
   */
  function createPlattform(refs, opts) {
    const doc = refs.wurzel.ownerDocument;
    const transport = opts.transport;
    const jetzt = opts.jetzt || (() => Date.now());
    const k = (w) => FP.wege.kodiere(w);
    const el = (tag, cls, text) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined && text !== null) e.textContent = text;
      return e;
    };
    const knopf = (text, cls, beiKlick) => {
      const b = el('button', cls, text);
      b.type = 'button';
      if (beiKlick) b.addEventListener('click', beiKlick);
      return b;
    };
    const feld = (form, name, titel, eingabe) => {
      const l = el('label', 'pf-feld');
      l.append(el('span', 'pf-feld-name', titel));
      eingabe.name = name;
      l.append(eingabe);
      form.append(l);
      return eingabe;
    };
    const eingabe = (typ, attr = {}) => {
      const i = el(typ === 'textarea' ? 'textarea' : 'input');
      if (typ !== 'textarea') i.type = typ;
      Object.assign(i, attr);
      return i;
    };
    const auswahl = (paare, wert) => {
      const s = el('select');
      for (const [v, t] of paare) {
        const o = el('option', null, t);
        o.value = v;
        s.append(o);
      }
      if (wert !== undefined) s.value = wert;
      return s;
    };

    let bereich = 'chat';
    let verfuegbar = false;

    // --- Vorgänge ---
    const vorgaenge = (() => {
      const wurzel = el('section', 'pf-bereich');
      wurzel.setAttribute('aria-label', 'Vorgänge');
      const kopf = el('header', 'pf-kopf');
      const suche = eingabe('search', { placeholder: 'Vorgänge durchsuchen', maxLength: 200, className: 'pf-suche' });
      suche.setAttribute('aria-label', 'Vorgänge durchsuchen');
      const artWahl = auswahl([['', 'Alle Arten'], ...Object.entries(ARTEN)], '');
      artWahl.setAttribute('aria-label', 'Art');
      const geschlossenWahl = eingabe('checkbox');
      const geschlossenLabel = el('label', 'pf-schalter');
      geschlossenLabel.append(geschlossenWahl, doc.createTextNode(' Geschlossene'));
      const neuKnopf = knopf('Neuer Vorgang', 'primaer');
      kopf.append(el('h2', null, 'Vorgänge'), suche, artWahl, geschlossenLabel, neuKnopf);

      const hinweis = el('p', 'pf-hinweis');
      hinweis.setAttribute('role', 'alert');
      hinweis.hidden = true;

      const form = el('form', 'pf-form');
      form.hidden = true;
      form.autocomplete = 'off';
      const neuTitel = feld(form, 'title', 'Titel', eingabe('text', { maxLength: 300, required: true }));
      const neuArt = feld(form, 'type', 'Art', auswahl(Object.entries(ARTEN), 'INC'));
      const neuSchwere = feld(form, 'severity', 'Schwere', auswahl(Object.entries(SCHWERE), 'medium'));
      const neuText = feld(form, 'description', 'Beschreibung', eingabe('textarea', { maxLength: 4000, rows: 3 }));
      const formKnoepfe = el('div', 'pf-knoepfe');
      const neuAbbruch = knopf('Abbrechen');
      const neuAnlegen = el('button', 'primaer', 'Anlegen');
      neuAnlegen.type = 'submit';
      formKnoepfe.append(neuAbbruch, neuAnlegen);
      form.append(formKnoepfe);

      const brett = el('div', 'pf-brett');
      const detail = el('aside', 'pf-detail');
      detail.setAttribute('aria-label', 'Vorgang');
      detail.hidden = true;
      const koerper = el('div', 'pf-koerper');
      koerper.append(brett, detail);
      wurzel.append(kopf, hinweis, form, koerper);

      let tickets = [];
      let sig = '';
      let offen = null; // geöffneter Vorgang (mit Verlauf)
      let detailSig = '';
      let nachfrage = false; // zerstörerische Freigabe: „Erlauben“ wurde einmal gedrückt
      let entwurf = '';

      function melde(text) {
        hinweis.hidden = !text;
        hinweis.textContent = text || '';
      }
      function zeichneBrett() {
        const aus = spalten(tickets, { geschlossene: geschlossenWahl.checked });
        brett.replaceChildren(
          ...aus.map((s) => {
            const spalte = el('section', `pf-spalte pf-s-${s.status}`);
            spalte.dataset.status = s.status;
            const k1 = el('h3', 'pf-spalte-kopf');
            k1.append(el('span', null, s.titel), el('span', 'pf-zahl', String(s.vorgaenge.length)));
            spalte.append(k1);
            for (const t of s.vorgaenge) spalte.append(karte(t));
            if (!s.vorgaenge.length) spalte.append(el('p', 'pf-leer', 'Nichts'));
            return spalte;
          }),
        );
      }
      function karte(t) {
        const b = knopf('', `pf-karte${offen && offen.id === t.id ? ' aktiv' : ''}`, () => oeffne(t.id));
        b.dataset.id = t.id;
        const zeile = el('span', 'pf-karte-kopf');
        zeile.append(el('span', 'pf-id', t.id), el('span', `pf-pill pf-sev-${t.severity}`, SCHWERE[t.severity] || t.severity));
        b.append(zeile, el('span', 'pf-karte-titel', t.title));
        const meta = [];
        if (t.assignee) meta.push(`@${t.assignee}`);
        if (Number(t.occurrences) > 1) meta.push(`${t.occurrences}×`);
        if (t.wiedervorlage) meta.push(`zurück ${t.wiedervorlage}`);
        if (t.waiting_for) meta.push(`wartet auf ${t.waiting_for}`);
        if (t.kinder) meta.push(`${t.kinder_resolved}/${t.kinder} Kinder`);
        if (meta.length) b.append(el('span', 'pf-karte-meta', meta.join(' · ')));
        return b;
      }
      async function lade() {
        const q = new URLSearchParams();
        const status = SPALTEN.map(([s]) => s).filter((s) => geschlossenWahl.checked || s !== 'closed');
        q.set('status', status.join(','));
        q.set('limit', '500');
        if (artWahl.value) q.set('type', artWahl.value);
        if (suche.value.trim()) q.set('q', suche.value.trim());
        const r = await transport.api('GET', `/api/tickets?${q}`);
        tickets = r.tickets || [];
        const neu = JSON.stringify([tickets.map((t) => [t.id, t.status, t.updated_at, t.severity, t.title]), geschlossenWahl.checked, offen && offen.id]);
        if (neu !== sig) {
          sig = neu;
          zeichneBrett();
        }
        if (offen) await ladeDetail();
      }
      async function ladeDetail() {
        try {
          const r = await transport.api('GET', `/api/tickets/${encodeURIComponent(offen.id)}`);
          offen = r.ticket;
          const neu = JSON.stringify([offen.updated_at, offen.status, (offen.verlauf || []).length, nachfrage]);
          if (neu !== detailSig) {
            detailSig = neu;
            zeichneDetail();
          }
        } catch (f) {
          const s = fehlerSicht(f);
          if (s.status === 404) schliesseDetail();
          else melde(s.text);
        }
      }
      async function oeffne(id) {
        offen = { id };
        nachfrage = false;
        entwurf = '';
        detailSig = '';
        detail.hidden = false;
        sig = '';
        await ladeDetail();
        zeichneBrett();
      }
      function schliesseDetail() {
        offen = null;
        detail.hidden = true;
        detail.replaceChildren();
        sig = '';
        zeichneBrett();
      }
      async function handle(fn) {
        melde('');
        try {
          await fn();
          nachfrage = false;
          detailSig = '';
          sig = '';
          await lade();
        } catch (f) {
          melde(fehlerSicht(f).text);
        }
      }
      const aendere = (patch) => handle(() => transport.api('PATCH', `/api/tickets/${encodeURIComponent(offen.id)}`, { expected_status: offen.status, ...patch }));

      function zeichneDetail() {
        const t = offen;
        const kopfD = el('div', 'pf-detail-kopf');
        kopfD.append(el('span', 'pf-id', `${t.id} · ${ARTEN[t.type] || t.type}`), knopf('Schließen', 'leise-knopf', schliesseDetail));
        const teile = [kopfD, el('h3', 'pf-detail-titel', t.title)];
        const fakten = el('dl', 'pf-fakten');
        const fakt = (n, w) => {
          if (w === '' || w === null || w === undefined) return;
          fakten.append(el('dt', null, n), el('dd', null, String(w)));
        };
        fakt('Status', STATUS_TEXT[t.status] || t.status);
        fakt('Schwere', SCHWERE[t.severity] || t.severity);
        fakt('Zuständig', t.assignee);
        fakt('Gemeldet von', t.reporter);
        fakt('Quelle', t.source);
        fakt('Wartet auf', t.waiting_for);
        fakt('Wiedervorlage', t.wiedervorlage && `${t.wiedervorlage}${t.wiedervorlage_quelle === 'standard' ? ' (Vorgabe)' : ''}`);
        fakt('Vorkommen', Number(t.occurrences) > 1 ? t.occurrences : '');
        fakt('Master', t.master);
        fakt('Kinder', t.kinder ? `${t.kinder_resolved} von ${t.kinder} erledigt` : '');
        fakt('Verweise', t.links);
        fakt('Angelegt', datumZeit(t.created_at));
        fakt('Geändert', datumZeit(t.updated_at));
        fakt('Archiviert', t.archived_at && datumZeit(t.archived_at));
        teile.push(fakten);
        if (t.description) teile.push(el('p', 'pf-text', t.description));

        if (t.status === 'waiting_approval' && !t.archived_at) {
          const f = el('div', `pf-freigabe${t.freigabe_zerstoererisch === 'ja' || t.freigabe_risiko === 'high' ? ' hoch' : ''}`);
          f.append(el('strong', null, 'Diese Freigabe wartet auf dich'));
          if (t.freigabe_risiko) f.append(el('span', 'pf-karte-meta', `Risiko ${SCHWERE[t.freigabe_risiko] || t.freigabe_risiko}${t.freigabe_zerstoererisch === 'ja' ? ' · zerstörerisch' : ''}`));
          if (t.freigabe_kontext) f.append(el('p', 'pf-text', t.freigabe_kontext));
          const zerst = t.freigabe_zerstoererisch === 'ja';
          const knoepfe = el('div', 'pf-knoepfe');
          knoepfe.append(
            knopf(nachfrage ? 'Wirklich erlauben' : 'Erlauben', 'primaer', () => {
              if (zerst && !nachfrage) {
                nachfrage = true;
                detailSig = '';
                zeichneDetail();
                return;
              }
              aendere({ status: 'in_progress' });
            }),
            knopf('Ablehnen', 'gefahr', () => aendere({ status: 'triage' })),
          );
          f.append(knoepfe);
          teile.push(f);
        }

        if (!t.archived_at) {
          const wahl = auswahl(SPALTEN, t.status);
          wahl.setAttribute('aria-label', 'Status ändern');
          wahl.addEventListener('change', () => {
            if (wahl.value !== t.status) aendere({ status: wahl.value });
          });
          const reihe = el('div', 'pf-reihe');
          reihe.append(el('span', 'pf-feld-name', 'Status ändern'), wahl);
          teile.push(reihe);
          const c = el('form', 'pf-kommentar');
          const ta = eingabe('textarea', { rows: 3, placeholder: 'Kommentar', maxLength: 20000, value: entwurf });
          ta.setAttribute('aria-label', 'Kommentar');
          ta.addEventListener('input', () => {
            entwurf = ta.value;
          });
          const senden = el('button', null, 'Kommentieren');
          senden.type = 'submit';
          c.append(ta, senden);
          c.addEventListener('submit', (e) => {
            e.preventDefault();
            const text = ta.value.trim();
            if (!text) return;
            handle(async () => {
              await transport.api('POST', `/api/tickets/${encodeURIComponent(t.id)}/comments`, { text });
              entwurf = '';
            });
          });
          teile.push(c);
        }
        const arch = t.archived_at
          ? knopf('Wiederherstellen', 'leise-knopf', () => handle(() => transport.api('DELETE', `/api/tickets/${encodeURIComponent(t.id)}/archive`)))
          : knopf('Archivieren', 'leise-knopf', () => handle(() => transport.api('POST', `/api/tickets/${encodeURIComponent(t.id)}/archive`, { reason: '' })));
        teile.push(arch);

        const verlauf = el('ol', 'pf-verlauf');
        for (const h of t.verlauf || []) {
          const li = el('li', h.event === 'comment' ? 'pf-kommentar-eintrag' : '');
          li.append(el('span', 'pf-karte-meta', `${datumZeit(h.ts)} · ${h.actor}${h.event === 'comment' ? '' : ` · ${h.event}`}${h.origin ? ` · über ${h.origin}` : ''}`));
          if (h.detail) li.append(el('span', 'pf-text', h.detail));
          verlauf.append(li);
        }
        teile.push(el('h4', 'pf-feld-name', 'Verlauf'), verlauf);
        detail.replaceChildren(...teile);
      }

      neuKnopf.addEventListener('click', () => {
        form.hidden = !form.hidden;
        if (!form.hidden) neuTitel.focus();
      });
      neuAbbruch.addEventListener('click', () => {
        form.hidden = true;
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const body = { title: neuTitel.value.trim(), type: neuArt.value, severity: neuSchwere.value, description: neuText.value };
        if (!body.title) return;
        handle(async () => {
          const r = await transport.api('POST', '/api/tickets', body);
          form.reset();
          neuArt.value = 'INC';
          neuSchwere.value = 'medium';
          form.hidden = true;
          if (r.ticket) await oeffne(r.ticket.id);
        });
      });
      let warte = null;
      suche.addEventListener('input', () => {
        clearTimeout(warte);
        warte = setTimeout(() => lade().catch((f) => melde(fehlerSicht(f).text)), 200);
      });
      artWahl.addEventListener('change', () => lade().catch((f) => melde(fehlerSicht(f).text)));
      geschlossenWahl.addEventListener('change', () => lade().catch((f) => melde(fehlerSicht(f).text)));

      return { wurzel, lade, oeffne, zeige() {}, verlasse() {}, melde };
    })();

    // --- Kalender ---
    const kalender = (() => {
      const wurzel = el('section', 'pf-bereich');
      wurzel.setAttribute('aria-label', 'Kalender');
      const kopf = el('header', 'pf-kopf');
      const zurueck = knopf('‹', 'leise-knopf');
      zurueck.setAttribute('aria-label', 'Woche zurück');
      const heute = knopf('Heute', 'leise-knopf');
      const vor = knopf('›', 'leise-knopf');
      vor.setAttribute('aria-label', 'Woche vor');
      const spanne = el('span', 'pf-spanne');
      const neuKnopf = knopf('Neuer Termin', 'primaer');
      kopf.append(el('h2', null, 'Kalender'), zurueck, heute, vor, spanne, neuKnopf);

      const hinweis = el('p', 'pf-hinweis');
      hinweis.setAttribute('role', 'alert');
      hinweis.hidden = true;
      const luecke = el('p', 'pf-luecke');
      luecke.hidden = true;

      const form = el('form', 'pf-form');
      form.hidden = true;
      form.autocomplete = 'off';
      const fTitel = feld(form, 'title', 'Titel', eingabe('text', { maxLength: 200, required: true }));
      const fVon = feld(form, 'from', 'Beginn', eingabe('datetime-local', { required: true }));
      const fBis = feld(form, 'to', 'Ende', eingabe('datetime-local'));
      const fOrt = feld(form, 'location', 'Ort', eingabe('text', { maxLength: 200 }));
      const fExklusiv = feld(form, 'exklusiv', 'Belegt exklusiv', eingabe('text', { maxLength: 64, placeholder: 'z. B. ein Rechner' }));
      const fVorgang = feld(form, 'ticket', 'Vorgang', eingabe('text', { maxLength: 32 }));
      const fErinnern = feld(form, 'remind_min', 'Erinnern (Minuten vorher)', eingabe('number', { min: 0, max: 10080 }));
      const fText = feld(form, 'description', 'Beschreibung', eingabe('textarea', { maxLength: 4000, rows: 2 }));
      const fKnoepfe = el('div', 'pf-knoepfe');
      const fLoeschen = knopf('Löschen', 'gefahr');
      const fAbbruch = knopf('Abbrechen');
      const fSpeichern = el('button', 'primaer', 'Speichern');
      fSpeichern.type = 'submit';
      fKnoepfe.append(fLoeschen, fAbbruch, fSpeichern);
      form.append(fKnoepfe);

      const woche = el('div', 'pf-woche');
      wurzel.append(kopf, hinweis, luecke, form, woche);

      let start = wochenStart(jetzt());
      let bearbeitet = null;
      let sig = '';
      let eintraege = [];

      function melde(text) {
        hinweis.hidden = !text;
        hinweis.textContent = text || '';
      }
      function zeichne() {
        const heuteVon = wochenStart(jetzt()) === start ? new Date(jetzt()).setHours(0, 0, 0, 0) : null;
        spanne.textContent = `${tagKurz(start)} – ${tagKurz(tagAb(start, 6))}`;
        woche.replaceChildren(
          ...wochenTage(start, eintraege).map((t) => {
            const spalte = el('section', `pf-tag${t.von === heuteVon ? ' heute' : ''}`);
            spalte.append(el('h3', 'pf-spalte-kopf', tagKurz(t.von)));
            for (const e of t.eintraege) {
              const b = knopf('', `pf-termin${e.exklusiv ? ' exklusiv' : ''}`, () => bearbeite(e));
              b.dataset.id = e.id;
              b.append(el('span', 'pf-zeit', e.all_day ? 'ganztags' : `${uhrzeit(e.from)}–${uhrzeit(e.to)}`), el('span', 'pf-karte-titel', e.title));
              const meta = [];
              if (e.exklusiv) meta.push(`belegt ${e.exklusiv}`);
              if (e.ticket) meta.push(e.ticket);
              if (e.location) meta.push(e.location);
              if (e.source && e.source !== 'planned') meta.push(`über ${e.source}`);
              if (meta.length) b.append(el('span', 'pf-karte-meta', meta.join(' · ')));
              spalte.append(b);
            }
            return spalte;
          }),
        );
      }
      async function lade() {
        const r = await transport.api('GET', `/api/calendar?from=${k(new Date(start).toISOString())}&to=${k(new Date(tagAb(start, 7)).toISOString())}`);
        eintraege = r.entries || [];
        const fehlt = r.unreachable || [];
        luecke.hidden = !fehlt.length;
        luecke.textContent = fehlt.length ? `Nicht lesbar: ${fehlt.map((u) => `${u.source} (${u.reason})`).join(', ')}. Dort kann mehr stehen, als hier zu sehen ist.` : '';
        const neu = JSON.stringify([start, eintraege.map((e) => [e.id, e.updated_at]), new Date(jetzt()).toDateString()]);
        if (neu !== sig) {
          sig = neu;
          zeichne();
        }
      }
      const neuLaden = () => lade().catch((f) => melde(fehlerSicht(f).text));
      function bearbeite(e) {
        bearbeitet = e;
        form.hidden = false;
        fLoeschen.hidden = !e;
        fTitel.value = e ? e.title : '';
        fVon.value = e ? fuerEingabe(e.from) : '';
        fBis.value = e ? fuerEingabe(e.to) : '';
        fOrt.value = e?.location || '';
        fExklusiv.value = e?.exklusiv || '';
        fVorgang.value = e?.ticket || '';
        fErinnern.value = e && e.remind_min !== null && e.remind_min !== undefined ? String(e.remind_min) : '';
        fText.value = e?.description || '';
        fTitel.focus();
      }
      zurueck.addEventListener('click', () => {
        start = tagAb(start, -7);
        neuLaden();
      });
      vor.addEventListener('click', () => {
        start = tagAb(start, 7);
        neuLaden();
      });
      heute.addEventListener('click', () => {
        start = wochenStart(jetzt());
        neuLaden();
      });
      neuKnopf.addEventListener('click', () => bearbeite(null));
      fAbbruch.addEventListener('click', () => {
        form.hidden = true;
      });
      fLoeschen.addEventListener('click', async () => {
        if (!bearbeitet) return;
        melde('');
        try {
          await transport.api('DELETE', `/api/calendar/${encodeURIComponent(bearbeitet.id)}`);
          form.hidden = true;
          await lade();
        } catch (f) {
          melde(fehlerSicht(f).text);
        }
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        melde('');
        const von = ausEingabe(fVon.value);
        if (!fTitel.value.trim() || !von) return melde('Titel und Beginn fehlen.');
        const bis = ausEingabe(fBis.value);
        const body = {
          title: fTitel.value.trim(),
          from: von,
          ...(bis ? { to: bis } : {}),
          location: fOrt.value.trim(),
          exklusiv: fExklusiv.value.trim() || null,
          ticket: fVorgang.value.trim() || null,
          remind_min: fErinnern.value === '' ? null : Number(fErinnern.value),
          description: fText.value,
        };
        try {
          if (bearbeitet) await transport.api('PATCH', `/api/calendar/${encodeURIComponent(bearbeitet.id)}`, body);
          else await transport.api('POST', '/api/calendar', body);
          form.hidden = true;
          sig = '';
          await lade();
        } catch (f) {
          melde(fehlerSicht(f).text);
        }
      });
      return { wurzel, lade, zeige() {}, verlasse() {}, melde };
    })();

    // --- Ereignisse ---
    const ereignisse = (() => {
      const wurzel = el('section', 'pf-bereich');
      wurzel.setAttribute('aria-label', 'Ereignisse');
      const kopf = el('header', 'pf-kopf');
      const chips = el('div', 'pf-chips');
      chips.setAttribute('role', 'tablist');
      const stand = el('span', 'pf-spanne');
      const neuKnopf = knopf('Ereignis einwerfen', 'primaer');
      kopf.append(el('h2', null, 'Ereignisse'), chips, stand, neuKnopf);
      const hinweis = el('p', 'pf-hinweis');
      hinweis.setAttribute('role', 'alert');
      hinweis.hidden = true;
      const form = el('form', 'pf-form');
      form.hidden = true;
      form.autocomplete = 'off';
      const fText = feld(form, 'text', 'Text', eingabe('textarea', { rows: 2, maxLength: 8000, required: true }));
      const fQuelle = feld(form, 'source', 'Quelle', eingabe('text', { maxLength: 64, value: 'webhook' }));
      const fBezug = feld(form, 'ref', 'Bezug', eingabe('text', { maxLength: 120 }));
      const fKnoepfe = el('div', 'pf-knoepfe');
      const fAbbruch = knopf('Abbrechen');
      const fSenden = el('button', 'primaer', 'Einwerfen');
      fSenden.type = 'submit';
      fKnoepfe.append(fAbbruch, fSenden);
      form.append(fKnoepfe);
      const liste = el('ol', 'pf-ereignisse');
      liste.setAttribute('aria-live', 'polite');
      const leer = el('p', 'pf-leer', 'Noch keine Ereignisse.');
      wurzel.append(kopf, hinweis, form, leer, liste);

      let thema = 'inbox';
      let gesehen = new Map(); // seq → Ereignis
      let stromAuf = false;

      function melde(text) {
        hinweis.hidden = !text;
        hinweis.textContent = text || '';
      }
      function zeile(e) {
        const li = el('li', `pf-ereignis${e.class === 'max' ? ' besitzer' : ''}`);
        li.dataset.seq = String(e.seq);
        const kopfZ = el('div', 'pf-ereignis-kopf');
        kopfZ.append(el('span', 'pf-id', `#${e.seq}`), el('span', 'pf-karte-meta', datumZeit(e.t)), el('span', 'pf-pill', e.source));
        if (e.class === 'max') kopfZ.append(el('span', 'pf-pill pf-besitzer', 'Vorfahrt'));
        if (e.severity) kopfZ.append(el('span', `pf-pill pf-sev-${e.severity}`, SCHWERE[e.severity] || e.severity));
        if (e.ref) kopfZ.append(el('span', 'pf-karte-meta', e.ref));
        li.append(kopfZ, el('span', 'pf-text', e.text));
        return li;
      }
      function zeichne() {
        const alle = [...gesehen.values()].sort((a, b) => b.seq - a.seq).slice(0, LISTE_MAX);
        leer.hidden = alle.length > 0;
        liste.replaceChildren(...alle.map(zeile));
      }
      function aufnehmen(e) {
        if (!e || e.topic !== thema || gesehen.has(e.seq)) return;
        gesehen.set(e.seq, e);
        zeichne();
      }
      function zeichneChips() {
        chips.replaceChildren(
          ...THEMEN.map(([id, titel]) => {
            const b = knopf(titel, `pf-chip${id === thema ? ' an' : ''}`, () => waehle(id));
            b.setAttribute('role', 'tab');
            b.setAttribute('aria-selected', id === thema ? 'true' : 'false');
            return b;
          }),
        );
      }
      async function lade() {
        const head = await transport.api('GET', '/api/bus/state');
        const t = (head.topics || []).find((x) => x.topic === thema);
        const kopfSeq = Number(t?.head ?? 0);
        const gelesen = (head.cursors || []).find((c) => c.topic === thema && c.consumer === 'agent');
        stand.textContent = thema === 'inbox' && gelesen ? (Number(gelesen.seq) >= kopfSeq ? 'alles angenommen' : `${kopfSeq - Number(gelesen.seq)} noch nicht angenommen`) : '';
        const r = await transport.api('GET', `/api/bus?topic=${k(thema)}&after=${Math.max(0, kopfSeq - 200)}&limit=200`);
        for (const e of r.events || []) gesehen.set(e.seq, e);
        zeichne();
        return kopfSeq;
      }
      function stromOeffnen(ab) {
        stromAuf = true;
        Promise.resolve(transport.oeffneStrom('bus', `/api/bus/stream?topic=${thema}&after=${ab}`)).catch(() => {
          stromAuf = false; // dann bleibt das regelmäßige Laden
        });
      }
      function stromZu() {
        if (!stromAuf) return;
        stromAuf = false;
        Promise.resolve(transport.schliesseStrom('bus')).catch(() => {});
      }
      async function waehle(id) {
        thema = id;
        gesehen = new Map();
        zeichneChips();
        zeichne();
        await start();
      }
      async function start() {
        melde('');
        try {
          const ab = await lade();
          if (bereich === 'ereignisse') stromOeffnen(ab);
        } catch (f) {
          melde(fehlerSicht(f).text);
        }
      }
      neuKnopf.addEventListener('click', () => {
        form.hidden = !form.hidden;
        if (!form.hidden) fText.focus();
      });
      fAbbruch.addEventListener('click', () => {
        form.hidden = true;
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        melde('');
        const text = fText.value.trim();
        if (!text) return;
        try {
          await transport.api('POST', '/api/bus', { text, source: fQuelle.value.trim() || 'webhook', ...(fBezug.value.trim() ? { ref: fBezug.value.trim() } : {}), topic: thema === 'inbox' ? undefined : thema });
          fText.value = '';
          form.hidden = true;
          await lade();
        } catch (f) {
          melde(fehlerSicht(f).text);
        }
      });
      if (transport.onStrom) {
        transport.onStrom((p) => {
          if (p && p.kanal === 'bus' && p.art === 'bus') aufnehmen(p.daten);
        });
      }
      zeichneChips();
      return { wurzel, lade, zeige: start, verlasse: stromZu, melde };
    })();

    const BEREICHE = { vorgaenge, kalender, ereignisse };
    refs.wurzel.append(vorgaenge.wurzel, kalender.wurzel, ereignisse.wurzel);
    // Die Seitenleiste kann eingeklappt sein, und ihr Schalter gehört zum Kopf des Chats: ohne diesen Knopf käme man nicht zurück.
    for (const b of Object.values(BEREICHE)) {
      b.wurzel.querySelector('.pf-kopf').prepend(knopf('‹ Chat', 'leise-knopf pf-zum-chat', () => wechsle('chat')));
    }

    function zeigeBereich() {
      const chat = bereich === 'chat';
      refs.haupt.classList.toggle('pf-an', !chat);
      refs.panes.hidden = !chat;
      refs.wurzel.hidden = chat;
      for (const [name, b] of Object.entries(BEREICHE)) b.wurzel.hidden = name !== bereich;
      for (const b of refs.nav.querySelectorAll('[data-bereich]')) {
        const an = b.dataset.bereich === bereich;
        b.classList.toggle('aktiv', an);
        if (an) b.setAttribute('aria-current', 'page');
        else b.removeAttribute('aria-current');
      }
    }
    async function wechsle(name) {
      if (name === bereich) return;
      BEREICHE[bereich]?.verlasse();
      bereich = BEREICHE[name] ? name : 'chat';
      zeigeBereich();
      if (bereich === 'chat') {
        opts.beiChat?.();
        return;
      }
      const b = BEREICHE[bereich];
      try {
        await b.lade();
        await b.zeige();
      } catch (f) {
        b.melde(fehlerSicht(f).text);
      }
    }
    for (const b of refs.nav.querySelectorAll('[data-bereich]')) {
      b.addEventListener('click', () => wechsle(b.dataset.bereich));
    }

    /** Kennt der Runner die Plattform? Ohne sie bleibt nur der Chat; die Zahl zeigt, was auf den Besitzer wartet. */
    async function pruefe() {
      try {
        const r = await transport.api('GET', '/api/tickets/waiting');
        verfuegbar = true;
        refs.nav.hidden = false;
        const n = Number(r.anzahl) || 0;
        refs.zahl.hidden = n === 0;
        refs.zahl.textContent = String(n);
      } catch (f) {
        if (!fehlerSicht(f).fehlt) return; // Netzfehler: der Stand bleibt, der nächste Takt fragt wieder
        verfuegbar = false;
        refs.nav.hidden = true;
        if (bereich !== 'chat') await wechsle('chat');
      }
    }
    async function takt() {
      await pruefe();
      if (!verfuegbar || bereich === 'chat' || bereich === 'ereignisse') return;
      const b = BEREICHE[bereich];
      try {
        await b.lade();
      } catch (f) {
        b.melde(fehlerSicht(f).text);
      }
    }
    zeigeBereich();
    const intervall = opts.intervallMs === undefined ? 5000 : opts.intervallMs;
    const zeitgeber = intervall ? setInterval(() => void takt(), intervall) : null;

    return {
      takt,
      pruefe,
      wechsle,
      bereich: () => bereich,
      verfuegbar: () => verfuegbar,
      vorgangOeffnen: async (id) => {
        await wechsle('vorgaenge');
        await vorgaenge.oeffne(id);
      },
      stop: () => zeitgeber && clearInterval(zeitgeber),
    };
  }

  FP.createPlattform = createPlattform;
  FP.plattformLogik = { spalten, wochenStart, wochenTage, tagAb, fuerEingabe, ausEingabe, fehlerSicht };
})(typeof window !== 'undefined' ? window : globalThis);
