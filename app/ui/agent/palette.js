/**
 * palette.js — die Palette (Cmd/Strg+K): ein Feld über allem, das zu Sitzungen, Dateien, Befehlen, Skills, Hub-Werkzeugen und zu
 * Handgriffen der App führt (Paket B3 in FYOS-AGENT-LOKAL-PLAN). Die Palette kennt den Runner nicht: was sie zeigt, reichen ihr Rückrufe
 * herein, und was eine Wahl bewirkt, ebenso. Texte kommen nur als textContent in die Seite.
 *
 * Gruppen in fester Reihenfolge: Handgriff, Sitzung, Datei, Befehl, Skill, Hub (Werkzeug), Verlauf. Ein Vorzeichen engt ein:
 *   ">" Handgriffe · "@" Dateien · "/" Befehle und Skills · "#" Hub-Werkzeuge
 * Handgriffe, Sitzungen, Befehle und Skills stehen sofort da (die Befehle liest die Palette einmal je Öffnen). Dateien, Hub-Werkzeuge
 * und der Verlauf fragen den Runner: verzögert, und nur die Antwort auf die letzte Eingabe zählt. Eine Quelle, die es nicht gibt (Rückruf
 * fehlt, liefert null oder scheitert), fehlt in der Liste; die Fußzeile nennt, was nicht ging.
 *
 * createPalette(refs, opts) → { oeffne(text), schliesse(), offen(), zustand() }
 *   refs: { wurzel }   leeres Element; die Palette baut sich hinein und blendet es ein und aus
 *   opts: {
 *     aktionen()          → [{ name, zusatz, rechts, wahl() }]
 *     sitzungen()         → [{ id, titel, ort, archiviert, angepinnt }]        beiSitzung(id)
 *     dateien(q)          → Promise<{ treffer: [{ relativ, name }] } | null>   beiDatei(relativ)
 *     befehle()           → Promise<[{ name, beschreibung, art }] | null>      beiBefehl(name)   (art 'skill': Name beginnt mit "skill:")
 *     werkzeuge(q)        → Promise<[{ name, beschreibung }] | null>           beiWerkzeug(name)
 *     verlauf(q)          → Promise<{ treffer: [{ id, titel, auszug }] } | null>  beiTreffer(treffer)
 *     beiFehler(text)     eine Wahl ist gescheitert
 *     verzoegerungMs      Vorgabe 180
 *   }
 */
(function (global) {
  'use strict';
  const FP = (global.FyosPrototyp = global.FyosPrototyp || {});

  /** [Schlüssel, Beschriftung, höchstens so viele Zeilen] in der Reihenfolge der Liste. */
  const GRUPPEN = [
    ['aktion', 'Handgriff', 6],
    ['sitzung', 'Sitzung', 8],
    ['datei', 'Datei', 8],
    ['befehl', 'Befehl', 6],
    ['skill', 'Skill', 6],
    ['werkzeug', 'Hub', 8],
    ['verlauf', 'Verlauf', 6],
  ];
  const VORZEICHEN = { '>': ['aktion'], '@': ['datei'], '/': ['befehl', 'skill'], '#': ['werkzeug'] };
  /** Diese Gruppen hat der Runner schon passend zur Eingabe gefiltert: sie werden nur gereiht, nie verworfen. */
  const FERN = ['datei', 'werkzeug', 'verlauf'];
  const FERN_NAME = { datei: 'Dateien', werkzeug: 'Hub-Werkzeuge', verlauf: 'Verlauf' };

  const klein = (s) => String(s === undefined || s === null ? '' : s).toLowerCase();
  const kurz = (s, n) => {
    const t = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };

  /**
   * Wie gut ein Eintrag zur Eingabe passt; 0 = passt nicht. Jedes Wort der Eingabe muss im Namen oder im Zusatz vorkommen. Am Anfang des
   * Namens zählt am meisten, dann am Anfang eines Teils (nach Leerzeichen, Schrägstrich, Punkt, Strich, Doppelpunkt), dann mitten im Namen,
   * dann nur im Zusatz. Kürzere Namen stehen bei Gleichstand vorn. Ohne Eingabe passt alles gleich gut.
   */
  function bewerte(q, name, zusatz) {
    const woerter = klein(q).split(/\s+/).filter(Boolean);
    if (!woerter.length) return 1;
    const n = klein(name);
    const z = klein(zusatz);
    let punkte = 0;
    for (const w of woerter) {
      const i = n.indexOf(w);
      if (i === 0) punkte += 100;
      else if (i > 0 && /[\s/._:-]/.test(n[i - 1])) punkte += 60;
      else if (i > 0) punkte += 30;
      else if (z.includes(w)) punkte += 10;
      else return 0;
    }
    return punkte + Math.max(0, 20 - Math.floor(n.length / 4));
  }

  /** Die Eingabe: ein Vorzeichen (> @ / #) engt auf Gruppen ein. → { text, gruppen } (gruppen: Liste oder null = alle) */
  function zerlege(roh) {
    const s = String(roh === undefined || roh === null ? '' : roh).replace(/^\s+/, '');
    const g = VORZEICHEN[s[0]];
    return g ? { text: s.slice(1).trim(), gruppen: g } : { text: s.trim(), gruppen: null };
  }

  /**
   * Die Zeilen der Liste. `eintraege`: { <gruppe>: [{ name, zusatz, rechts, wahl }] }. Je Gruppe die besten (siehe GRUPPEN), die Gruppen in
   * fester Reihenfolge; ohne Eingabe nur Handgriffe und Sitzungen in der gelieferten Reihenfolge. → [{ art, titel, name, rechts, eintrag }]
   */
  function ordne(roh, eintraege) {
    const { text, gruppen } = zerlege(roh);
    const zeilen = [];
    for (const [art, titel, hoechstens] of GRUPPEN) {
      if (gruppen && !gruppen.includes(art)) continue;
      if (!gruppen && !text && art !== 'aktion' && art !== 'sitzung') continue;
      const liste = Array.isArray(eintraege[art]) ? eintraege[art] : [];
      const fern = FERN.includes(art);
      const bewertet = [];
      liste.forEach((e, i) => {
        if (!e || typeof e.name !== 'string' || !e.name) return;
        const p = bewerte(text, e.name, e.zusatz);
        if (p === 0 && !fern) return;
        bewertet.push({ e, p, i });
      });
      // Ohne Eingabe und bei Antworten des Runners bleibt die gelieferte Reihenfolge; sonst die besten zuerst.
      if (text && !fern) bewertet.sort((a, b) => b.p - a.p || a.i - b.i);
      for (const { e } of bewertet.slice(0, gruppen ? hoechstens * 3 : hoechstens)) {
        zeilen.push({ art, titel, name: e.name, rechts: typeof e.rechts === 'string' ? e.rechts : '', eintrag: e });
      }
    }
    return zeilen;
  }

  function createPalette(refs, opts) {
    opts = opts || {};
    const wurzel = refs.wurzel;
    const doc = wurzel.ownerDocument;
    const el = (tag, cls, text) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined && text !== null) e.textContent = text;
      return e;
    };
    const verz = opts.verzoegerungMs === undefined ? 180 : opts.verzoegerungMs;

    wurzel.hidden = true;
    wurzel.classList.add('pal');
    const kasten = el('div', 'pal-kasten');
    kasten.setAttribute('role', 'dialog');
    kasten.setAttribute('aria-modal', 'true');
    kasten.setAttribute('aria-label', 'Palette: springen und ausführen');
    const kopf = el('div', 'pal-kopf');
    const feld = el('input', 'pal-feld');
    feld.type = 'text';
    feld.setAttribute('role', 'combobox');
    feld.setAttribute('aria-expanded', 'true');
    feld.setAttribute('aria-controls', 'palListe');
    feld.setAttribute('aria-autocomplete', 'list');
    feld.setAttribute('aria-label', 'Sitzung, Datei, Befehl oder Werkzeug');
    feld.placeholder = 'Sitzung, Datei, Befehl, Werkzeug …';
    feld.autocomplete = 'off';
    feld.spellcheck = false;
    const taste = el('kbd', 'pal-taste', 'Esc');
    kopf.append(feld, taste);
    const liste = el('div', 'pal-liste');
    liste.id = 'palListe';
    liste.setAttribute('role', 'listbox');
    liste.setAttribute('aria-label', 'Treffer');
    const leer = el('p', 'pal-leer');
    leer.hidden = true;
    const fuss = el('div', 'pal-fuss');
    const hilfe = el('span', 'pal-hilfe', '> Handgriff · @ Datei · / Befehl · # Hub-Werkzeug');
    const lage = el('span', 'pal-lage');
    lage.setAttribute('role', 'status');
    fuss.append(hilfe, lage);
    kasten.append(kopf, liste, leer, fuss);
    wurzel.replaceChildren(kasten);

    let offen = false;
    let zeilen = [];
    let gewaehlt = 0;
    let lauf = 0; // zählt Eingaben: nur die Antwort auf die letzte zählt
    let zeitgeber = null;
    let vorher = null; // Element, das vor dem Öffnen den Fokus hatte
    let befehle = null; // Liste dieses Öffnens oder null (noch nicht da, gibt es nicht)
    const fern = { datei: [], werkzeug: [], verlauf: [] };
    const sucht = new Set();
    const ging_nicht = new Set();

    const sicher = (fn, ...a) => {
      try {
        return typeof fn === 'function' ? fn(...a) : undefined;
      } catch {
        return undefined;
      }
    };

    function eintraege() {
      const aktion = (sicher(opts.aktionen) || []).filter((a) => a && typeof a.wahl === 'function');
      const sitzung = (sicher(opts.sitzungen) || [])
        .filter((s) => s && s.id !== undefined && s.id !== null)
        .map((s) => ({
          name: kurz(s.titel || `Sitzung ${s.id}`, 120),
          zusatz: s.ort || '',
          rechts: s.archiviert ? 'Archiv' : s.angepinnt ? 'angepinnt' : kurz(s.ort || '', 40),
          wahl: () => sicher(opts.beiSitzung, s.id),
        }));
      const alle = Array.isArray(befehle) ? befehle : [];
      const zeile = (b) => ({
        name: `/${b.name}`,
        zusatz: b.beschreibung || '',
        rechts: kurz(b.beschreibung || '', 60),
        wahl: () => sicher(opts.beiBefehl, b.name),
      });
      return {
        aktion,
        sitzung,
        befehl: alle.filter((b) => b.art !== 'skill').map(zeile),
        skill: alle.filter((b) => b.art === 'skill').map(zeile),
        datei: fern.datei,
        werkzeug: fern.werkzeug,
        verlauf: fern.verlauf,
      };
    }

    function zeichne() {
      zeilen = ordne(feld.value, eintraege());
      if (gewaehlt >= zeilen.length) gewaehlt = Math.max(0, zeilen.length - 1);
      liste.replaceChildren(
        ...zeilen.map((z, i) => {
          const d = el('div', `pal-zeile${i === gewaehlt ? ' gewaehlt' : ''}`);
          d.id = `palZeile${i}`;
          d.setAttribute('role', 'option');
          d.setAttribute('aria-selected', i === gewaehlt ? 'true' : 'false');
          d.dataset.art = z.art;
          d.append(el('small', 'pal-art', z.titel), el('span', 'pal-name', z.name), el('span', 'pal-rechts', z.rechts));
          d.addEventListener('mousedown', (e) => e.preventDefault()); // der Fokus bleibt im Feld
          d.addEventListener('click', () => void waehle(i));
          return d;
        }),
      );
      if (zeilen.length) feld.setAttribute('aria-activedescendant', `palZeile${gewaehlt}`);
      else feld.removeAttribute('aria-activedescendant');
      const { text } = zerlege(feld.value);
      leer.hidden = zeilen.length > 0;
      leer.textContent = sucht.size ? 'Sucht …' : text ? 'Nichts gefunden.' : 'Tippe, um zu suchen.';
      const teile = [];
      if (sucht.size) teile.push('sucht …');
      if (ging_nicht.size) teile.push(`nicht erreichbar: ${[...ging_nicht].map((g) => FERN_NAME[g]).join(', ')}`);
      lage.textContent = teile.join(' · ');
    }

    function markiere(i) {
      if (!zeilen.length) return;
      gewaehlt = (i + zeilen.length) % zeilen.length;
      [...liste.children].forEach((d, n) => {
        d.classList.toggle('gewaehlt', n === gewaehlt);
        d.setAttribute('aria-selected', n === gewaehlt ? 'true' : 'false');
      });
      feld.setAttribute('aria-activedescendant', `palZeile${gewaehlt}`);
      const d = liste.children[gewaehlt];
      if (d && typeof d.scrollIntoView === 'function') d.scrollIntoView({ block: 'nearest' });
    }

    /** Die Quellen am Runner für die jetzige Eingabe fragen; nur die Antwort auf die letzte Eingabe wird übernommen. */
    function frage() {
      const nr = lauf;
      const { text, gruppen } = zerlege(feld.value);
      const an = (g) => (!gruppen || gruppen.includes(g)) && text.length >= (gruppen ? 1 : 2);
      const quellen = {
        datei: () =>
          Promise.resolve(opts.dateien(text)).then((r) =>
            ((r && r.treffer) || []).map((t) => ({
              name: kurz(t.relativ, 200),
              rechts: '',
              wahl: () => sicher(opts.beiDatei, t.relativ),
            })),
          ),
        werkzeug: () =>
          Promise.resolve(opts.werkzeuge(text)).then((r) =>
            (r || []).map((w) => ({
              name: kurz(w.name, 120),
              zusatz: w.beschreibung || '',
              rechts: kurz(w.beschreibung || '', 60),
              wahl: () => sicher(opts.beiWerkzeug, w.name),
            })),
          ),
        verlauf: () =>
          Promise.resolve(opts.verlauf(text)).then((r) =>
            ((r && r.treffer) || []).map((t) => ({
              name: kurz(t.auszug || t.titel || `Sitzung ${t.id}`, 160),
              rechts: kurz(t.titel || '', 40),
              wahl: () => sicher(opts.beiTreffer, t),
            })),
          ),
      };
      const rueckruf = { datei: opts.dateien, werkzeug: opts.werkzeuge, verlauf: opts.verlauf };
      for (const g of FERN) {
        if (typeof rueckruf[g] !== 'function' || !an(g)) continue;
        sucht.add(g);
        let versprechen;
        try {
          versprechen = quellen[g]();
        } catch (f) {
          versprechen = Promise.reject(f);
        }
        versprechen
          .then((treffer) => {
            if (nr !== lauf || !offen) return;
            fern[g] = treffer;
            ging_nicht.delete(g);
          })
          .catch(() => {
            if (nr !== lauf || !offen) return;
            fern[g] = [];
            ging_nicht.add(g);
          })
          .finally(() => {
            if (nr !== lauf || !offen) return;
            sucht.delete(g);
            zeichne();
          });
      }
      zeichne();
    }

    function beiEingabe() {
      lauf += 1;
      gewaehlt = 0;
      for (const g of FERN) fern[g] = [];
      sucht.clear();
      ging_nicht.clear();
      if (zeitgeber) clearTimeout(zeitgeber);
      zeitgeber = null;
      zeichne();
      if (!zerlege(feld.value).text) return;
      if (verz > 0) zeitgeber = setTimeout(frage, verz);
      else frage();
    }

    async function waehle(i) {
      const z = zeilen[i];
      if (!z) return;
      schliesse();
      try {
        await z.eintrag.wahl();
      } catch (f) {
        sicher(opts.beiFehler, (f && f.message) || String(f));
      }
    }

    function oeffne(text) {
      if (!offen) vorher = doc.activeElement;
      offen = true;
      wurzel.hidden = false;
      feld.value = typeof text === 'string' ? text : '';
      befehle = null;
      beiEingabe();
      feld.focus();
      if (typeof opts.befehle === 'function') {
        const nr = lauf;
        Promise.resolve()
          .then(() => opts.befehle())
          .then((l) => {
            if (!offen) return;
            befehle = Array.isArray(l) ? l.filter((b) => b && typeof b.name === 'string' && b.name && b.art !== 'terminal') : null;
            if (nr === lauf) zeichne();
            else zeilen = ordne(feld.value, eintraege());
          })
          .catch(() => {
            befehle = null;
          });
      }
    }

    function schliesse() {
      if (!offen) return;
      offen = false;
      lauf += 1;
      if (zeitgeber) clearTimeout(zeitgeber);
      zeitgeber = null;
      sucht.clear();
      wurzel.hidden = true;
      liste.replaceChildren();
      zeilen = [];
      const zurueck = vorher;
      vorher = null;
      if (zurueck && typeof zurueck.focus === 'function' && doc.contains(zurueck)) zurueck.focus();
    }

    feld.addEventListener('input', beiEingabe);
    feld.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        markiere(gewaehlt + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        markiere(gewaehlt - 1);
      } else if (e.key === 'Home' && zeilen.length && !feld.value) {
        e.preventDefault();
        markiere(0);
      } else if (e.key === 'End' && zeilen.length && !feld.value) {
        e.preventDefault();
        markiere(zeilen.length - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        void waehle(gewaehlt);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        schliesse();
      } else if (e.key === 'Tab') {
        e.preventDefault(); // das Feld ist das einzige Ziel im Dialog
      }
    });
    // Ein Klick neben den Kasten schließt.
    wurzel.addEventListener('mousedown', (e) => {
      if (e.target === wurzel) {
        e.preventDefault();
        schliesse();
      }
    });

    return {
      oeffne,
      schliesse,
      offen: () => offen,
      zustand: () => ({
        offen,
        text: feld.value,
        gewaehlt,
        sucht: sucht.size > 0,
        zeilen: zeilen.map((z) => ({ art: z.art, name: z.name, rechts: z.rechts })),
      }),
    };
  }

  FP.palette = { createPalette, bewerte, zerlege, ordne, GRUPPEN };
})(typeof globalThis !== 'undefined' ? globalThis : window);
