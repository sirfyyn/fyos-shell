/* Tafel „Änderungen“ der Seitenleiste (Paket A5, dritter Teil): welche Dateien der Agent in dieser Sitzung mit write und edit geändert hat
 * (unterm Strich, gegen den Stand vor seiner Arbeit), der Unterschied je Datei, eine Datei zurücknehmen, und die Stände: zurück auf den
 * Zustand vor einer Nachricht, Dateien und Gespräch gemeinsam.
 *
 * Gelesen wird über runner-wege.js (staende, staendeDiff). Zurückgesetzt wird mit POST /api/gespraech/<id>/zurueck: erst als Probe (sie
 * sagt, was geschähe), dann nach der Bestätigung des Menschen. Kennt der Runner den Weg nicht (Runner ohne Stände), bleibt der Knopf der
 * Schiene weg. Texte des Runners gehen nur über textContent in die Seite. Die reinen Teile (dateiSicht, standSicht, frageSicht) stehen
 * getrennt vom DOM und sind ohne Fenster prüfbar.
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  const ZUSTAND_TEXT = { neu: 'neu', geaendert: '', geloescht: 'gelöscht' };
  const mehrzahl = (n, eins, viele) => `${n} ${n === 1 ? eins : viele}`;
  const uhr = (ms) => (FP.uhrzeit ? FP.uhrzeit(ms) : '');

  /** Eine geänderte Datei, wie die Tafel sie zeigt. → { name, ordner, marke, zahlen: { plus, minus } | null, hinweis, titel } */
  function dateiSicht(d) {
    const rel = String(d.relativ || d.pfad || '');
    const i = rel.lastIndexOf('/');
    const hinweise = [];
    if (d.fremd) hinweise.push('seitdem von Hand geändert');
    if (d.gesichert === false) hinweise.push('nicht gesichert, lässt sich nicht zurücknehmen');
    const zahlen = d.plus === null || d.minus === null ? null : { plus: d.plus, minus: d.minus };
    return {
      name: i >= 0 ? rel.slice(i + 1) : rel,
      ordner: i > 0 ? rel.slice(0, i) : '',
      marke: ZUSTAND_TEXT[d.zustand] || '',
      zahlen,
      hinweis: hinweise.join(' · '),
      titel: `${rel}: ${d.zustand === 'neu' ? 'vom Agenten angelegt' : d.zustand === 'geloescht' ? 'gelöscht' : 'geändert'}${zahlen ? `, ${zahlen.plus} Zeilen dazu, ${zahlen.minus} weg` : ''}`,
    };
  }

  /** Ein Stand, wie Tafel und Gespräch ihn zeigen. → { zeit („17:31“ oder ''), titel, meta, kurz (Zeile unter der Nachricht) } */
  function standSicht(s) {
    const zeit = uhr(s.zeit);
    const anfang = s.id === 'anfang';
    const dateien = mehrzahl(s.dateien, 'Datei', 'Dateien');
    return {
      zeit,
      titel: s.titel || (anfang ? 'Vor der ersten Änderung' : 'Vor einer früheren Nachricht'),
      meta: [dateien, s.gespraech ? '' : 'nur Dateien'].filter(Boolean).join(' · '),
      kurz: [`Stand${zeit ? ` ${zeit}` : ''}`, dateien].join(' · '),
    };
  }

  const AKTION_TEXT = {
    wiederherstellen: 'wird wiederhergestellt',
    loeschen: 'wird gelöscht (der Agent hat sie angelegt)',
    unveraendert: 'ist schon auf dem Stand',
    nicht_gesichert: 'ist nicht gesichert und bleibt, wie sie ist',
  };
  const GRUND_TEXT = {
    verdichtet: 'Das Gespräch wurde seitdem geleert oder verdichtet: zurück gehen nur die Dateien. Der Agent erfährt es vor deiner nächsten Nachricht.',
    schon_zurueck: 'Das Gespräch ist an dieser Stelle schon zurückgespult: zurück gehen nur die Dateien.',
    nicht_im_verlauf: 'Die Nachricht liegt nicht mehr im geladenen Verlauf: zurück gehen nur die Dateien. Der Agent erfährt es vor deiner nächsten Nachricht.',
  };

  /**
   * Die Rückfrage vor einem Zurücksetzen, aus der Probe des Runners.
   * f: { art: 'stand'|'datei', name (Uhrzeit oder Dateiname), probe (zurueckBereinigen) }
   * → { titel, dateien: [{ text, warn }], zeilen: [Text], warnung, knopf, nurDateien (zweiter Knopf), nichts (es gibt nichts zu tun), trotzdem }
   */
  function frageSicht(f) {
    const p = f.probe || { dateien: [], gespraech: false };
    const aendert = p.dateien.filter((d) => d.aktion === 'wiederherstellen' || d.aktion === 'loeschen');
    const fremd = aendert.some((d) => d.fremd);
    const dateien = p.dateien.map((d) => ({ text: `${d.relativ} ${AKTION_TEXT[d.aktion] || ''}${d.fremd ? ' · seitdem von Hand geändert' : ''}`.trim(), warn: d.fremd === true }));
    const zeilen = [];
    const stand = f.art === 'stand';
    if (stand) {
      if (p.gespraech) zeilen.push('Das Gespräch danach bleibt lesbar, zählt aber nicht mehr. Deine Nachricht kommt zurück ins Eingabefeld.');
      else zeilen.push(GRUND_TEXT[p.gespraechGrund] || GRUND_TEXT.verdichtet);
      if (aendert.length) zeilen.push('Was ein Befehl geändert hat, geht nicht mit zurück.');
    } else zeilen.push('Das Gespräch bleibt, wie es ist. Der Agent erfährt es vor deiner nächsten Nachricht.');
    const nichts = !aendert.length && !(stand && p.gespraech);
    return {
      titel: stand ? `Zurück auf den Stand${f.name ? ` von ${f.name}` : ''}?` : `${f.name || 'Datei'} zurücknehmen?`,
      dateien,
      zeilen: nichts ? ['Hier ist nichts zurückzusetzen.'] : zeilen,
      warnung: fremd ? 'Was seitdem von Hand geändert wurde, wird dabei überschrieben. Der Runner sichert es vorher in seiner Ablage.' : '',
      knopf: stand ? (fremd ? 'Trotzdem zurücksetzen' : 'Zurücksetzen') : fremd ? 'Trotzdem zurücknehmen' : 'Zurücknehmen',
      nurDateien: stand && p.gespraech && aendert.length > 0,
      nichts,
      trotzdem: fremd,
    };
  }

  /** Klartext eines Fehlers der Anfrage (HTTP-Transport oder Brücke), ohne Kennwörter des Protokolls. */
  function fehlerText(f) {
    const t = FP.wege && FP.wege.fehlerTeile ? FP.wege.fehlerTeile(f) : { text: '', status: null, netz: false };
    if (t.netz) return 'Der Runner ist nicht erreichbar.';
    return t.text || (f && f.message) || 'Nicht möglich.';
  }

  /**
   * refs: { knopf (Schiene), marke, leer, dateien (ul), staendeKopf, staende (ol), meldung, fuss }
   * opts: { wege, transport, beiStaende(liste: [{ id, text }]) (Zeilen unter den Nachrichten), beiDateien(pfade | null, dateien | null) (was der
   *         Runner als geändert nennt, als Pfade und als [{ relativ, zustand }]; null: er kennt keine Stände), beiZurueck(antwort) (nach einem Zurücksetzen), beiWeg(kennt),
   *         beiDatei(datei) (ein Klick auf den Namen: die Seite zeigt den Unterschied als Fläche; ohne sie oder bei `false` klappt er hier auf) }
   * Rückgabe: { setzeSitzung(id), neu(), oeffneStand(id), ende(), zustand() }
   */
  function createStaendeTafel(refs, opts) {
    opts = opts || {};
    const doc = refs.dateien.ownerDocument;
    const wege = opts.wege;
    let sitzung = null;
    let daten = { dateien: [], staende: [] };
    let weg = 'unbekannt'; // 'ja' | 'nein' (Runner ohne Stände) | 'unbekannt'
    const offen = new Set(); // Pfade mit aufgeklapptem Unterschied
    const diffs = new Map(); // Pfad → { phase: 'laedt'|'ok'|'fehler', diff?, text? }
    let frage = null; // { art, id | pfad, name, phase: 'laedt'|'bereit'|'laeuft'|'fehler', probe?, fehler? }
    let ladeLauf = 0;
    let frageLauf = 0;
    let beendet = false;

    function el(name, klasse, text) {
      const e = doc.createElement(name);
      if (klasse) e.className = klasse;
      if (text !== undefined) e.textContent = text;
      return e;
    }
    function knopf(text, klasse, beiKlick) {
      const b = el('button', klasse, text);
      b.type = 'button';
      b.addEventListener('click', beiKlick);
      return b;
    }
    /** Das Zeichen für „zurücknehmen“ (ein Pfeil, der umkehrt), als festes eigenes Bild. */
    function pfeil() {
      const NS = 'http://www.w3.org/2000/svg';
      const svg = doc.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('aria-hidden', 'true');
      const p = doc.createElementNS(NS, 'path');
      p.setAttribute('d', 'M4.5 6.5h5a2.75 2.75 0 0 1 0 5.5H7 M6.75 4L4.25 6.5l2.5 2.5');
      svg.append(p);
      return svg;
    }

    function baueFrage() {
      const kasten = el('div', 'st-frage');
      kasten.setAttribute('role', 'group');
      if (frage.phase === 'laedt') {
        kasten.append(el('p', 'st-frage-text leise', 'Der Runner prüft, was zurückzusetzen ist …'));
        return kasten;
      }
      if (frage.phase === 'fehler' && !frage.probe) {
        kasten.append(el('p', 'st-frage-fehler', frage.fehler || 'Nicht möglich.'));
        kasten.append(knopf('Schließen', 'st-knopf', () => frageZu(true)));
        return kasten;
      }
      const s = frageSicht(frage);
      kasten.setAttribute('aria-label', s.titel);
      kasten.append(el('strong', 'st-frage-titel', s.titel));
      if (s.dateien.length) {
        const ul = el('ul', 'st-frage-dateien');
        for (const d of s.dateien.slice(0, 40)) {
          const li = el('li', d.warn ? 'warn' : '', d.text);
          ul.append(li);
        }
        if (s.dateien.length > 40) ul.append(el('li', 'leise', `und ${s.dateien.length - 40} weitere`));
        kasten.append(ul);
      }
      for (const z of s.zeilen) kasten.append(el('p', 'st-frage-text', z));
      if (s.warnung) kasten.append(el('p', 'st-frage-warnung', s.warnung));
      if (frage.phase === 'fehler') kasten.append(el('p', 'st-frage-fehler', frage.fehler || 'Nicht möglich.'));
      const reihe = el('div', 'st-frage-knoepfe');
      const laeuft = frage.phase === 'laeuft';
      if (!s.nichts) {
        // kräftig, aber ohne Signalfarbe: die trägt in der Oberfläche nur der eine Hauptknopf (Senden) und Laufendes
        const ja = knopf(laeuft ? 'Setzt zurück …' : s.knopf, 'st-ja', () => fuehreAus(false));
        ja.disabled = laeuft;
        reihe.append(ja);
        if (s.nurDateien) {
          const nur = knopf('Nur Dateien', 'st-knopf st-nur', () => fuehreAus(true));
          nur.title = 'Die Dateien zurücksetzen, das Gespräch lassen, wie es ist';
          nur.disabled = laeuft;
          reihe.append(nur);
        }
      }
      const nein = knopf(s.nichts ? 'Schließen' : 'Abbrechen', 'st-knopf st-nein', () => frageZu(true));
      nein.disabled = laeuft;
      reihe.append(nein);
      kasten.append(reihe);
      return kasten;
    }

    function zeichneDiff(li, d) {
      const halter = el('div', 'st-diff');
      const stand = diffs.get(d.pfad);
      if (!stand || stand.phase === 'laedt') halter.append(el('p', 'leise st-diff-text', 'Unterschied wird geladen …'));
      else if (stand.phase === 'fehler') halter.append(el('p', 'st-diff-text', stand.text));
      else if (stand.diff && FP.baueDiff) halter.append(FP.baueDiff(doc, stand.diff));
      else halter.append(el('p', 'leise st-diff-text', stand.text || 'Kein Unterschied als Text.'));
      li.append(halter);
    }

    function zeichne() {
      const n = daten.dateien.length;
      refs.marke.hidden = n === 0;
      refs.marke.textContent = String(n);
      refs.knopf.title = n ? `Änderungen: ${mehrzahl(n, 'Datei', 'Dateien')} in dieser Sitzung geändert` : 'Änderungen des Agenten in dieser Sitzung';
      refs.leer.hidden = n > 0 || daten.staende.length > 0;
      const merkeFokus = doc.activeElement && refs.dateien.parentNode.contains(doc.activeElement) ? doc.activeElement.dataset.fokus : null;

      refs.dateien.textContent = '';
      for (const d of daten.dateien) {
        const s = dateiSicht(d);
        const auf = offen.has(d.pfad);
        const li = el('li', 'st-datei');
        li.dataset.zustand = d.zustand;
        const zeile = el('div', 'st-zeile');
        const name = el('button', 'st-name');
        name.type = 'button';
        name.dataset.fokus = `name:${d.pfad}`;
        name.title = s.titel;
        // mit `beiDatei` zeigt die Seite den Unterschied rechts als Fläche; ohne sie klappt er hier in der Leiste auf
        if (!opts.beiDatei) name.setAttribute('aria-expanded', auf ? 'true' : 'false');
        name.append(el('span', 'st-dname', s.name));
        if (s.ordner) name.append(el('span', 'st-dordner', s.ordner));
        name.addEventListener('click', () => {
          if (opts.beiDatei && opts.beiDatei(d) !== false) return;
          schalteDiff(d.pfad);
        });
        zeile.append(name);
        if (s.marke) zeile.append(el('span', 'chip st-marke', s.marke));
        if (s.zahlen && FP.baueDiffChips) {
          const z = FP.baueDiffChips(doc, s.zahlen);
          z.classList.add('st-zahlen');
          zeile.append(z);
        }
        // nur ein Zeichen, damit der Dateiname in der schmalen Leiste Platz behält; der Name der Handlung steht im Titel und für Vorleser
        const zurueck = knopf('', 'st-knopf st-zurueck', () => frageDatei(d));
        zurueck.append(pfeil(), el('span', 'sr', `${s.name} zurücknehmen`));
        zurueck.dataset.fokus = `zurueck:${d.pfad}`;
        zurueck.title = d.gesichert === false ? 'Der Stand davor ist nicht gesichert' : 'Zurücknehmen: diese Datei auf den Stand vor der Arbeit des Agenten zurücksetzen';
        zurueck.disabled = d.gesichert === false;
        zeile.append(zurueck);
        li.append(zeile);
        if (s.hinweis) li.append(el('p', 'st-hinweis', s.hinweis));
        if (auf) zeichneDiff(li, d);
        if (frage && frage.art === 'datei' && frage.pfad === d.pfad) li.append(baueFrage());
        refs.dateien.append(li);
      }

      refs.staendeKopf.hidden = daten.staende.length === 0;
      refs.staende.textContent = '';
      // der neueste Stand zuerst: dorthin will man am ehesten zurück
      for (const st of daten.staende.slice().reverse()) {
        const s = standSicht(st);
        const li = el('li', 'st-stand');
        const zeile = el('div', 'st-zeile');
        const text = el('span', 'st-stand-text');
        if (s.zeit) text.append(el('span', 'st-zeit', s.zeit));
        text.append(el('span', 'st-stand-titel', s.titel));
        text.title = s.titel;
        const hin = knopf('Hierher zurück', 'st-knopf st-hin', () => frageStand(st.id));
        hin.dataset.fokus = `stand:${st.id}`;
        hin.title = st.gespraech ? 'Dateien und Gespräch auf den Stand vor dieser Nachricht zurücksetzen' : 'Die Dateien auf diesen Stand zurücksetzen';
        zeile.append(text, hin);
        li.append(zeile, el('p', 'st-hinweis', s.meta));
        if (frage && frage.art === 'stand' && frage.id === st.id) li.append(baueFrage());
        refs.staende.append(li);
      }
      refs.fuss.hidden = n === 0 && daten.staende.length === 0;

      // Fokus: die offene Rückfrage zuerst, sonst dorthin zurück, wo er war
      const ja = refs.dateien.parentNode.querySelector('.st-frage .st-ja, .st-frage .st-nein');
      if (frage && frage.neu && ja) {
        frage.neu = false;
        ja.focus();
      } else if (merkeFokus) {
        for (const b of refs.dateien.parentNode.querySelectorAll('[data-fokus]')) if (b.dataset.fokus === merkeFokus) b.focus();
      }
    }

    function meldeStaende() {
      // welche Dateien der Runner als geändert nennt (null: er kennt keine Stände): danach richtet sich das Panel „Änderungen der Sitzung“
      // zweites Argument: dieselben Dateien mit ihrem Zustand (neu, geändert, gelöscht), für die Marken im Baum der Tafel „Dateien“
      if (opts.beiDateien) opts.beiDateien(weg === 'ja' ? daten.dateien.map((d) => d.relativ) : null, weg === 'ja' ? daten.dateien.map((d) => ({ relativ: d.relativ, zustand: d.zustand })) : null);
      if (!opts.beiStaende) return;
      opts.beiStaende(daten.staende.filter((s) => s.id !== 'anfang').map((s) => ({ id: s.id, text: standSicht(s).kurz })));
    }

    async function neu() {
      if (!wege || beendet || sitzung === null || weg === 'nein') return;
      const fuer = sitzung;
      const lauf = ++ladeLauf;
      try {
        const r = await wege.staende(fuer);
        if (beendet || lauf !== ladeLauf || fuer !== sitzung) return;
        if (weg !== 'ja') {
          weg = 'ja';
          refs.knopf.hidden = false;
          if (opts.beiWeg) opts.beiWeg(true);
        }
        daten = r;
        // Unterschiede aufgeklappter Dateien gelten nach einer Änderung nicht mehr: neu holen; Verschwundenes vergessen
        const da = new Set(r.dateien.map((d) => d.pfad));
        for (const p of [...offen]) {
          if (!da.has(p)) offen.delete(p);
          else void ladeDiff(p);
        }
        for (const p of [...diffs.keys()]) if (!offen.has(p)) diffs.delete(p);
        if (frage && frage.art === 'datei' && !da.has(frage.pfad)) frage = null;
        if (frage && frage.art === 'stand' && !r.staende.some((s) => s.id === frage.id)) frage = null;
      } catch (f) {
        if (beendet || lauf !== ladeLauf || fuer !== sitzung) return;
        if (f && f.art === 'weg_fehlt') {
          weg = 'nein';
          refs.knopf.hidden = true;
          daten = { dateien: [], staende: [] };
          frage = null;
          if (opts.beiWeg) opts.beiWeg(false);
        } else return; // Netzfehler: der letzte Stand bleibt stehen
      }
      zeichne();
      meldeStaende();
    }

    /** Die sichtbare Sitzung hat gewechselt. */
    function setzeSitzung(id) {
      const neuId = id === undefined ? null : id;
      if (String(neuId) === String(sitzung)) return;
      sitzung = neuId;
      ladeLauf += 1;
      frageLauf += 1;
      daten = { dateien: [], staende: [] };
      offen.clear();
      diffs.clear();
      frage = null;
      zeichne();
      meldeStaende(); // die Angaben der vorigen Sitzung gelten nicht mehr
      void neu();
    }

    async function ladeDiff(pfad) {
      const fuer = sitzung;
      diffs.set(pfad, { phase: 'laedt' });
      try {
        const r = await wege.staendeDiff(fuer, pfad);
        if (beendet || fuer !== sitzung || !offen.has(pfad)) return;
        const d = daten.dateien.find((x) => x.pfad === pfad);
        const diff = r.patch && FP.diffAusPatch ? FP.diffAusPatch(r.patch, r.relativ || (d && d.relativ)) : null;
        const grund = { nicht_gesichert: 'Der Stand davor ist nicht gesichert (die Datei war zu groß).', kein_text: 'Kein Text: der Unterschied lässt sich nicht zeigen.', zu_lang: 'Der Unterschied ist zu lang für die Anzeige.' };
        diffs.set(pfad, diff ? { phase: 'ok', diff: { ...diff, zahlen: r.plus !== null && r.minus !== null ? { plus: r.plus, minus: r.minus } : undefined } } : { phase: 'ok', text: grund[r.grund] || 'Kein Unterschied.' });
      } catch (f) {
        if (beendet || fuer !== sitzung || !offen.has(pfad)) return;
        diffs.set(pfad, { phase: 'fehler', text: (f && f.message) || 'Unterschied nicht lesbar.' });
      }
      zeichne();
    }

    function schalteDiff(pfad) {
      if (offen.has(pfad)) {
        offen.delete(pfad);
        diffs.delete(pfad);
        zeichne();
        return;
      }
      offen.add(pfad);
      zeichne();
      void ladeDiff(pfad);
    }

    const zurueckPfad = () => `/api/gespraech/${encodeURIComponent(sitzung)}/zurueck`;

    async function probe(koerper) {
      const fuer = sitzung;
      const lauf = ++frageLauf;
      zeichne();
      try {
        const r = FP.wege.zurueckBereinigen(await opts.transport.api('POST', zurueckPfad(), { ...koerper, probe: true }));
        if (beendet || lauf !== frageLauf || fuer !== sitzung || !frage) return;
        frage.probe = r;
        frage.phase = 'bereit';
      } catch (f) {
        if (beendet || lauf !== frageLauf || fuer !== sitzung || !frage) return;
        frage.phase = 'fehler';
        frage.fehler = fehlerText(f);
      }
      frage.neu = true;
      zeichne();
    }

    function frageStand(id) {
      const st = daten.staende.find((s) => s.id === String(id));
      if (!st || sitzung === null) return false;
      frage = { art: 'stand', id: st.id, name: uhr(st.zeit), phase: 'laedt', von: `stand:${st.id}` };
      void probe({ stand: st.id });
      return true;
    }

    function frageDatei(d) {
      if (sitzung === null) return;
      frage = { art: 'datei', pfad: d.pfad, name: dateiSicht(d).name, phase: 'laedt', von: `zurueck:${d.pfad}` };
      void probe({ datei: d.pfad });
    }

    function frageZu(mitFokus) {
      const von = frage && frage.von;
      frage = null;
      frageLauf += 1;
      zeichne();
      if (mitFokus && von) for (const b of refs.dateien.parentNode.querySelectorAll('[data-fokus]')) if (b.dataset.fokus === von) b.focus();
    }

    async function fuehreAus(nurDateien) {
      if (!frage || frage.phase === 'laeuft' || !frage.probe) return;
      const f = frage;
      const s = frageSicht(f);
      const fuer = sitzung;
      const koerper = f.art === 'stand' ? { stand: f.id, ...(nurDateien ? { gespraech: false } : {}) } : { datei: f.pfad };
      if (s.trotzdem) koerper.trotzdem = true;
      f.phase = 'laeuft';
      zeichne();
      try {
        const r = FP.wege.zurueckBereinigen(await opts.transport.api('POST', zurueckPfad(), koerper));
        if (beendet || fuer !== sitzung) return;
        frage = null;
        frageLauf += 1;
        zeichne();
        if (opts.beiZurueck) opts.beiZurueck(r);
        void neu();
      } catch (g) {
        if (beendet || fuer !== sitzung || frage !== f) return;
        f.phase = 'fehler';
        f.fehler = fehlerText(g);
        zeichne();
      }
    }

    // Esc in der Tafel schließt die offene Rückfrage (chat.js hört am Dokument: Esc hielte sonst den Lauf an)
    refs.dateien.parentNode.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !frage || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (frage.phase !== 'laeuft') frageZu(true);
    });

    zeichne();

    return {
      setzeSitzung,
      neu,
      /** Die Rückfrage zu einem Stand öffnen (aus dem Gespräch heraus: „Hierher zurück“ unter einer Nachricht). → false, wenn es den Stand nicht gibt */
      oeffneStand: (id) => frageStand(id),
      ende() {
        beendet = true;
      },
      get kennt() {
        return weg === 'ja';
      },
      zustand: () => ({ daten, weg, offen: [...offen], frage: frage ? { art: frage.art, phase: frage.phase, id: frage.id, pfad: frage.pfad } : null }),
    };
  }

  FP.staende = { dateiSicht, standSicht, frageSicht, fehlerText, createStaendeTafel };
})(typeof globalThis !== 'undefined' ? globalThis : window);
