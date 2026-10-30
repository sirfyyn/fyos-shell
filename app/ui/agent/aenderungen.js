/* Änderungen-Panel des Arbeitsplatzes: zeigt, welche Dateien der Agent in der offenen Sitzung geschrieben oder bearbeitet hat.
 *
 * Quelle sind allein die Werkzeugaufrufe im Verlauf (write, edit, multiedit, str_replace; read für den Ausgangsstand): der Adapter
 * (runner-adapter.js) sammelt sie beim Abspielen des Verlaufs und beim Live-Strom, `sammle()` leitet daraus die Dateiliste ab.
 * Der Runner hat KEINEN Weg, Dateien des Arbeitsordners zu lesen (siehe docs/current/FYOS-AGENT-HUELLE.md, Abschnitt 9g): Vorschau und
 * Dateibaum kommen darum aus dem Verlauf (zuletzt geschriebener Inhalt mit den späteren Bearbeitungen, sonst das Ergebnis des letzten Lesens).
 *
 * Reine Teile (ohne DOM): sammle, vorschau, baum, relativ. Oberfläche: createAenderungen(refs, opts). Texte kommen aus dem Verlauf und werden
 * nur als Text eingesetzt. Der Diff wird vom Renderer der Verlaufskarten gebaut (FP.baueDiff in chat-renderer.js), nichts doppelt.
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  const VORSCHAU_ZEICHEN = 200000; // größere Dateien zeigt die Vorschau nur zum Anfang
  const VORSCHAU_ZEILEN = 2000;
  const DIFF_ZEILEN = 400; // gezeigte Zeilen einer neuen Datei im Diff (die Zähler gelten immer für die ganze Datei)
  const KONTEXT = 2; // unveränderte Zeilen um eine Änderung, wenn ein Schreibvorgang gegen einen bekannten Stand verglichen wird
  const LESE_KURZ_ZEILEN = 2000; // so groß ist ein Lese-Ergebnis des Runners höchstens (dann ist es vermutlich gekürzt)
  const LESE_KURZ_ZEICHEN = 50 * 1024;
  const VERGLEICH_MAX = 3000; // Zeilen, bis zu denen ein Vergleich gerechnet wird (sonst: alles als neu)

  const pfadVon = (args) => {
    if (!args || typeof args !== 'object') return '';
    for (const n of ['path', 'file_path', 'pfad']) if (typeof args[n] === 'string' && args[n]) return args[n];
    return '';
  };

  /** Pfad relativ zum Arbeitsordner (Schrägstriche vereinheitlicht); `ausserhalb`, wenn er nicht darunter liegt. */
  function relativ(pfad, cwd) {
    let p = String(pfad || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    const c = cwd ? String(cwd).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '') : '';
    let ausserhalb = false;
    if (c && p.startsWith(`${c}/`)) p = p.slice(c.length + 1);
    else if (p.startsWith('/') || /^[A-Za-z]:\//.test(p)) ausserhalb = true;
    p = p.replace(/^(\.\/)+/, '');
    return { rel: p, ausserhalb };
  }
  const nameVon = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
  const ordnerVon = (rel) => (rel.lastIndexOf('/') > 0 ? rel.slice(0, rel.lastIndexOf('/')) : '');

  const zeilenVon = (text) => {
    const t = String(text);
    return t === '' ? [] : t.replace(/\n$/, '').split('\n');
  };

  /** Schreibvorgang gegen einen bekannten Stand: Hunks mit Zeilennummern und je 2 Zeilen Kontext; null, wenn zu groß. */
  function vergleiche(alt, neu) {
    if (alt.split('\n').length > VERGLEICH_MAX || neu.split('\n').length > VERGLEICH_MAX) return null;
    const zl = FP.diffZeilen(alt, neu);
    let plus = 0;
    let minus = 0;
    for (const z of zl) z[0] === '+' ? plus++ : z[0] === '-' && minus++;
    const n = zl.length;
    const zeige = new Array(n).fill(false);
    zl.forEach((z, k) => {
      if (z[0] !== ' ') for (let j = Math.max(0, k - KONTEXT); j <= Math.min(n - 1, k + KONTEXT); j++) zeige[j] = true;
    });
    const hunks = [];
    let cur = null;
    let na = 1;
    let nb = 1;
    for (let k = 0; k < n; k++) {
      if (zeige[k]) {
        if (!cur) {
          cur = { alt: na, neu: nb, zeilen: [] };
          hunks.push(cur);
        }
        cur.zeilen.push(zl[k]);
      } else cur = null;
      if (zl[k][0] !== '+') na++;
      if (zl[k][0] !== '-') nb++;
    }
    return { hunks, plus, minus };
  }

  /**
   * Aus den beendeten Datei-Werkzeugen der Sitzung (Form des Adapters: { name, args, status, output? }, in der Reihenfolge ihres Endes)
   * die Dateien ableiten. → { dateien: [geändert oder geschrieben], beruehrt: [alle, auch nur gelesene] }
   * Eine Datei: { pfad (relativ), name, ordner, ausserhalb, art: 'neu'|'geaendert', plus, minus, hunks, weitere, aenderungen,
   *               gelesen, inhalt (letzter bekannter Stand oder null), quelle: 'geschrieben'|'gelesen'|'', unsicher }
   * „neu“ heißt: das erste Schreiben war ein write, ohne dass die Datei vorher gelesen wurde (der Runner meldet nicht, ob sie schon existierte).
   * Fehlgeschlagene Aufrufe zählen nicht.
   */
  function sammle(aufrufe, cwd) {
    const karte = new Map();
    for (const a of Array.isArray(aufrufe) ? aufrufe : []) {
      if (!a || a.status === 'fehler') continue;
      const roh = pfadVon(a.args);
      if (!roh) continue;
      const r = relativ(roh, cwd);
      if (!r.rel) continue;
      let d = karte.get(r.rel);
      if (!d) {
        d = { pfad: r.rel, name: nameVon(r.rel), ordner: ordnerVon(r.rel), ausserhalb: r.ausserhalb, art: null, plus: 0, minus: 0, hunks: [], weitere: 0, aenderungen: 0, gelesen: false, inhalt: null, quelle: '', unsicher: false };
        karte.set(r.rel, d);
      }
      if (a.name === 'read') {
        d.gelesen = true;
        // Das Werkzeug `read` kürzt auf 2000 Zeilen oder 50 KB: ein Ergebnis in dieser Größe gilt als möglicherweise unvollständig und taugt nicht als Stand
        const ganz = typeof a.output === 'string' && !(a.args && (a.args.offset || a.args.limit)) && a.output.length < LESE_KURZ_ZEICHEN && a.output.split('\n').length < LESE_KURZ_ZEILEN;
        if (ganz) {
          d.inhalt = a.output;
          d.quelle = 'gelesen';
          d.unsicher = false;
        }
        continue;
      }
      if (a.name === 'write') {
        if (!a.args || typeof a.args.content !== 'string') continue;
        const neu = a.args.content;
        if (d.art === null) d.art = d.gelesen || d.inhalt != null ? 'geaendert' : 'neu';
        const v = d.inhalt != null ? vergleiche(d.inhalt, neu) : null;
        if (v) {
          d.hunks.push(...v.hunks);
          d.plus += v.plus;
          d.minus += v.minus;
        } else {
          const z = zeilenVon(neu);
          d.hunks.push({ alt: null, neu: 1, zeilen: z.map((t) => ['+', t]) });
          d.plus += z.length;
        }
        d.inhalt = neu;
        d.quelle = 'geschrieben';
        d.unsicher = false;
        d.aenderungen++;
        continue;
      }
      const paare = FP.editPaare(a.args);
      if (!paare.length) continue;
      if (d.art === null) d.art = 'geaendert';
      for (const [alt, neu] of paare) {
        const zl = FP.diffZeilen(alt, neu);
        d.hunks.push({ alt: null, neu: null, zeilen: zl });
        for (const z of zl) z[0] === '+' ? d.plus++ : z[0] === '-' && d.minus++;
        if (d.inhalt != null) {
          const i = alt === '' ? -1 : d.inhalt.indexOf(alt);
          if (i >= 0) d.inhalt = d.inhalt.slice(0, i) + neu + d.inhalt.slice(i + alt.length);
          else d.unsicher = true;
        }
      }
      d.aenderungen++;
    }
    const alle = [...karte.values()];
    for (const d of alle) {
      if (d.art === 'neu' && d.inhalt != null && !d.unsicher) {
        // eine neu angelegte Datei zeigt ihren heutigen Inhalt als hinzugefügt (nicht die Folge ihrer Zwischenstände)
        const z = zeilenVon(d.inhalt);
        d.hunks = [{ alt: null, neu: 1, zeilen: z.slice(0, DIFF_ZEILEN).map((t) => ['+', t]) }];
        d.plus = z.length;
        d.minus = 0;
        d.weitere = Math.max(0, z.length - DIFF_ZEILEN);
      } else {
        // sonst nur kürzen, wenn ein einzelner Hunk sehr groß ist
        let rest = 0;
        for (const h of d.hunks) {
          if (h.zeilen.length > DIFF_ZEILEN) {
            rest += h.zeilen.length - DIFF_ZEILEN;
            h.zeilen = h.zeilen.slice(0, DIFF_ZEILEN);
          }
        }
        d.weitere = rest;
      }
    }
    return { dateien: alle.filter((d) => d.art !== null), beruehrt: alle };
  }

  const utf8Laenge = (t) => {
    let n = 0;
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c < 0xdc00) {
        n += 4;
        i++;
      } else n += 3;
    }
    return n;
  };

  /** Inhalt für die Vorschau: { art: 'text'|'binaer'|'fehlt', zeilen?, bytes, gekuerzt, quelle, unsicher } */
  function vorschau(d) {
    if (!d || d.inhalt == null) return { art: 'fehlt', bytes: 0, gekuerzt: false, quelle: '', unsicher: false };
    const t = String(d.inhalt);
    const bytes = utf8Laenge(t);
    if (t.indexOf('\u0000') >= 0) return { art: 'binaer', bytes, gekuerzt: false, quelle: d.quelle, unsicher: d.unsicher };
    let zeilen = t.split('\n');
    if (zeilen.length > 1 && zeilen[zeilen.length - 1] === '') zeilen.pop();
    let gekuerzt = false;
    if (t.length > VORSCHAU_ZEICHEN) {
      zeilen = t.slice(0, VORSCHAU_ZEICHEN).split('\n');
      gekuerzt = true;
    }
    if (zeilen.length > VORSCHAU_ZEILEN) {
      zeilen = zeilen.slice(0, VORSCHAU_ZEILEN);
      gekuerzt = true;
    }
    return { art: 'text', zeilen, bytes, gekuerzt, quelle: d.quelle, unsicher: d.unsicher };
  }

  /** Dateibaum aus den berührten Dateien: { name, pfad, ordner: Map, dateien: [] } */
  function baum(liste) {
    const wurzel = { name: '', pfad: '', ordner: new Map(), dateien: [] };
    for (const f of liste || []) {
      const teile = f.pfad.split('/').filter(Boolean);
      if (f.ausserhalb) teile.unshift('(außerhalb)');
      let k = wurzel;
      for (let i = 0; i < teile.length - 1; i++) {
        let u = k.ordner.get(teile[i]);
        if (!u) {
          u = { name: teile[i], pfad: (k.pfad ? `${k.pfad}/` : '') + teile[i], ordner: new Map(), dateien: [] };
          k.ordner.set(teile[i], u);
        }
        k = u;
      }
      k.dateien.push(f);
    }
    return wurzel;
  }

  const ICON = {
    chev: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5L10 8l-4.5 4.5" /></svg>',
    datei: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 1.75h6l3 3v9.5h-9z M9.5 1.75v3h3" /></svg>',
    ordner: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 3.5h4l1.5 1.75h7v7.5h-12.5z" /></svg>',
  };
  const ART_TEXT = { neu: 'neu', geaendert: 'geändert' };
  const QUELLE_TEXT = {
    geschrieben: 'Stand: zuletzt vom Agenten in dieser Sitzung geschrieben. Änderungen von außen danach sind hier nicht sichtbar.',
    gelesen: 'Stand: beim letzten Lesen durch den Agenten in dieser Sitzung.',
  };

  /**
   * refs: { knopf, zahl, panel, zu, hinweis, reiter, reiterListe, reiterBaum, inhalt }
   * opts: { beiAenderung(anzahl) }
   */
  function createAenderungen(refs, opts) {
    opts = opts || {};
    const doc = refs.panel.ownerDocument;
    const el = (tag, cls, text) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const mitIcon = (tag, cls, icon) => {
      const e = el(tag, cls);
      e.innerHTML = icon; // feste, eigene Zeichen
      return e;
    };
    let erg = { dateien: [], beruehrt: [] };
    let sitzung = null;
    let modus = 'liste'; // 'liste' | 'baum' | 'vorschau'
    let vorschauPfad = null;
    let zurueckModus = 'liste';
    const offen = new Set(); // Pfade mit aufgeklapptem Diff
    const zu = new Set(); // Pfade zugeklappter Ordner im Baum
    let sigAlt = '';
    const css = (s) => String(s).replace(/["\\]/g, '\\$&');

    const fokusSchluessel = () => {
      const a = doc.activeElement;
      return a && refs.inhalt.contains(a) && a.dataset && a.dataset.fokus ? a.dataset.fokus : null;
    };
    const fokusSetzen = (schluessel) => {
      if (!schluessel) return false;
      const b = refs.inhalt.querySelector(`[data-fokus="${css(schluessel)}"]`);
      if (b) b.focus();
      return !!b;
    };

    function artChip(art) {
      const c = el('span', `chip ae-art ${art}`, ART_TEXT[art] || art);
      c.dataset.art = art;
      return c;
    }

    function diffFuer(d) {
      return FP.baueDiff(doc, { datei: d.pfad, hunks: d.hunks, zahlen: { plus: d.plus, minus: d.minus }, weitere: d.weitere });
    }

    function zeichneListe() {
      if (!erg.dateien.length) {
        refs.inhalt.append(el('div', 'fp-leer', 'In dieser Sitzung wurden noch keine Dateien geändert.'));
        return;
      }
      const ul = el('ul', 'ae-liste');
      ul.setAttribute('aria-label', 'Geänderte Dateien');
      for (const d of erg.dateien) {
        const auf = offen.has(d.pfad);
        const li = el('li', 'ae-datei');
        li.dataset.pfad = d.pfad;
        li.dataset.art = d.art;
        const zeile = el('div', 'ae-zeile');
        const chev = mitIcon('button', `ae-auf${auf ? ' offen' : ''}`, ICON.chev);
        chev.type = 'button';
        chev.tabIndex = -1;
        chev.dataset.fokus = `auf:${d.pfad}`;
        chev.setAttribute('aria-expanded', String(auf));
        chev.setAttribute('aria-label', `Diff von ${d.pfad} ${auf ? 'einklappen' : 'aufklappen'}`);
        chev.addEventListener('click', () => schalteDiff(d.pfad));
        const name = el('button', 'ae-name');
        name.type = 'button';
        name.dataset.fokus = `name:${d.pfad}`;
        name.title = `${d.pfad}${d.ausserhalb ? ' (außerhalb des Arbeitsordners)' : ''}: Inhalt ansehen`;
        name.setAttribute('aria-label', `${d.pfad}, ${ART_TEXT[d.art]}, ${d.plus} hinzugefügt, ${d.minus} entfernt`);
        name.append(el('span', 'ae-dname', d.name));
        if (d.ordner || d.ausserhalb) name.append(el('span', 'ae-dordner', d.ordner || d.pfad.slice(0, d.pfad.length - d.name.length)));
        name.addEventListener('click', () => oeffneVorschau(d.pfad));
        const zahlen = FP.baueDiffChips(doc, { plus: d.plus, minus: d.minus });
        zahlen.classList.add('ae-zahlen');
        zeile.append(chev, name, artChip(d.art), zahlen);
        li.append(zeile);
        if (auf) {
          const halter = el('div', 'ae-diff');
          halter.append(diffFuer(d));
          li.append(halter);
        }
        ul.append(li);
      }
      refs.inhalt.append(ul);
      refs.inhalt.append(el('p', 'ae-fuss', 'Abgeleitet aus den Schreib- und Bearbeitungsschritten dieser Sitzung. Annehmen oder Ablehnen gibt es hier nicht.'));
    }

    function knotenZeichnen(k, tiefe) {
      const ul = el('ul', 'ae-baum');
      ul.setAttribute('role', 'group');
      const ordner = [...k.ordner.values()].sort((a, b) => a.name.localeCompare(b.name));
      for (const o of ordner) {
        const aufgeklappt = !zu.has(o.pfad);
        const li = el('li', 'ae-knoten-punkt');
        li.setAttribute('role', 'treeitem');
        li.setAttribute('aria-expanded', String(aufgeklappt));
        const b = el('button', `ae-knoten ordner${aufgeklappt ? ' offen' : ''}`);
        b.type = 'button';
        b.dataset.fokus = `ordner:${o.pfad}`;
        b.dataset.ordner = o.pfad;
        b.style.paddingLeft = `${6 + tiefe * 14}px`;
        const chev = mitIcon('span', 'ae-chev', ICON.chev);
        b.append(chev, mitIcon('span', 'ae-symbol', ICON.ordner), el('span', 'ae-dname', o.name));
        b.addEventListener('click', () => schalteOrdner(o.pfad));
        li.append(b);
        if (aufgeklappt) li.append(knotenZeichnen(o, tiefe + 1));
        ul.append(li);
      }
      const dateien = k.dateien.slice().sort((a, b) => a.name.localeCompare(b.name));
      for (const f of dateien) {
        const li = el('li', 'ae-knoten-punkt');
        li.setAttribute('role', 'treeitem');
        const b = el('button', 'ae-knoten datei');
        b.type = 'button';
        b.dataset.fokus = `datei:${f.pfad}`;
        b.dataset.datei = f.pfad;
        b.dataset.art = f.art || 'gelesen';
        b.style.paddingLeft = `${6 + tiefe * 14}px`;
        b.append(el('span', 'ae-chev leer'), mitIcon('span', 'ae-symbol', ICON.datei), el('span', 'ae-dname', f.name));
        const marke = el('span', `chip ae-art ${f.art || 'gelesen'}`, f.art ? ART_TEXT[f.art] : 'gelesen');
        b.append(marke);
        b.addEventListener('click', () => oeffneVorschau(f.pfad));
        li.append(b);
        ul.append(li);
      }
      return ul;
    }

    function zeichneBaum() {
      if (!erg.beruehrt.length) {
        refs.inhalt.append(el('div', 'fp-leer', 'In dieser Sitzung hat der Agent noch keine Dateien gelesen oder geändert.'));
        return;
      }
      const wurzel = knotenZeichnen(baum(erg.beruehrt), 0);
      wurzel.classList.add('wurzel');
      wurzel.setAttribute('role', 'tree');
      wurzel.setAttribute('aria-label', 'Dateien dieser Sitzung');
      refs.inhalt.append(wurzel);
      refs.inhalt.append(el('p', 'ae-fuss', 'Der Runner kann den Arbeitsordner nicht als Dateiliste ausgeben. Der Baum zeigt nur Dateien, die der Agent in dieser Sitzung gelesen, geschrieben oder bearbeitet hat.'));
    }

    function zeichneVorschau() {
      const d = erg.beruehrt.find((x) => x.pfad === vorschauPfad);
      const kopf = el('div', 'ae-vorschau-kopf');
      const zurueck = el('button', 'leise-knopf ae-zurueck', 'Zurück');
      zurueck.type = 'button';
      zurueck.dataset.fokus = 'zurueck';
      zurueck.addEventListener('click', () => schliesseVorschau());
      kopf.append(zurueck, el('span', 'ae-vname', vorschauPfad || ''));
      if (d && d.art) kopf.append(artChip(d.art));
      refs.inhalt.append(kopf);
      if (!d) {
        refs.inhalt.append(el('div', 'fp-leer', 'Diese Datei kommt in der Sitzung nicht mehr vor.'));
        return;
      }
      const v = vorschau(d);
      if (v.art === 'fehlt') {
        refs.inhalt.append(el('div', 'fp-leer ae-fehlt', 'Der aktuelle Inhalt ist nicht verfügbar. Der Runner bietet keinen Weg, Dateien des Arbeitsordners zu lesen; die Vorschau zeigt nur, was der Agent in dieser Sitzung geschrieben oder vollständig gelesen hat.'));
        return;
      }
      if (v.art === 'binaer') {
        refs.inhalt.append(el('div', 'fp-leer ae-binaer', `Binärdatei, ${v.bytes} Byte`));
        return;
      }
      const hinweise = [QUELLE_TEXT[v.quelle] || ''];
      if (v.unsicher) hinweise.push('Spätere Bearbeitungen ließen sich nicht sicher einarbeiten; der Stand kann abweichen.');
      if (v.gekuerzt) hinweise.push(`Gekürzt: gezeigt werden die ersten ${v.zeilen.length} Zeilen von ${v.bytes} Byte.`);
      refs.inhalt.append(el('p', 'ae-quelle', hinweise.filter(Boolean).join(' ')));
      const box = el('div', 'ae-code-scroll');
      box.tabIndex = 0;
      box.setAttribute('role', 'region');
      box.setAttribute('aria-label', `Inhalt von ${d.pfad}`);
      const tab = el('table', 'ae-code');
      const tb = el('tbody');
      v.zeilen.forEach((t, i) => {
        const tr = el('tr');
        tr.append(el('td', 'nr', String(i + 1)), el('td', 'code', t));
        tb.append(tr);
      });
      tab.append(tb);
      box.append(tab);
      refs.inhalt.append(box);
    }

    function sig() {
      return JSON.stringify([erg.beruehrt.map((d) => [d.pfad, d.art, d.plus, d.minus, d.aenderungen, d.gelesen, d.unsicher, d.inhalt == null ? -1 : d.inhalt.length])]);
    }

    function zeichne(erzwingen) {
      const n = erg.dateien.length;
      refs.zahl.textContent = String(n);
      refs.knopf.hidden = n === 0 && refs.panel.hidden;
      refs.knopf.setAttribute('aria-expanded', String(!refs.panel.hidden));
      refs.knopf.title = n === 1 ? '1 geänderte Datei in dieser Sitzung' : `${n} geänderte Dateien in dieser Sitzung`;
      if (opts.beiAenderung) opts.beiAenderung(n);
      if (refs.panel.hidden) return;
      const merke = fokusSchluessel();
      refs.inhalt.replaceChildren();
      refs.reiter.hidden = modus === 'vorschau';
      const istListe = modus !== 'baum';
      refs.reiterListe.setAttribute('aria-selected', String(istListe));
      refs.reiterBaum.setAttribute('aria-selected', String(!istListe));
      refs.reiterListe.tabIndex = istListe ? 0 : -1;
      refs.reiterBaum.tabIndex = istListe ? -1 : 0;
      if (modus === 'vorschau') zeichneVorschau();
      else if (modus === 'baum') zeichneBaum();
      else zeichneListe();
      fokusSetzen(merke);
      void erzwingen;
    }

    /** Neue Werkzeugaufrufe der offenen Sitzung. `sitzungId`: eine andere Sitzung setzt Diffs, Vorschau und Baum zurück. */
    function setze(aufrufe, cwd, sitzungId) {
      if (sitzungId !== undefined && String(sitzungId) !== String(sitzung)) {
        sitzung = sitzungId === null ? null : String(sitzungId);
        offen.clear();
        zu.clear();
        modus = 'liste';
        vorschauPfad = null;
        sigAlt = '';
      }
      erg = sammle(aufrufe, cwd);
      const s = sig();
      if (s === sigAlt && !refs.panel.hidden) return false;
      sigAlt = s;
      zeichne(true);
      return true;
    }

    function schalteDiff(pfad) {
      if (offen.has(pfad)) offen.delete(pfad);
      else offen.add(pfad);
      zeichne(true);
    }
    function schalteOrdner(pfad, an) {
      const will = an === undefined ? zu.has(pfad) : an; // will: aufgeklappt
      if (will) zu.delete(pfad);
      else zu.add(pfad);
      zeichne(true);
    }
    function oeffneVorschau(pfad) {
      if (modus !== 'vorschau') zurueckModus = modus;
      modus = 'vorschau';
      vorschauPfad = pfad;
      zeichne(true);
      const b = refs.inhalt.querySelector('.ae-zurueck');
      if (b) b.focus();
    }
    function schliesseVorschau() {
      const pfad = vorschauPfad;
      modus = zurueckModus;
      vorschauPfad = null;
      zeichne(true);
      if (pfad && !fokusSetzen(modus === 'baum' ? `datei:${pfad}` : `name:${pfad}`)) {
        const b = refs.inhalt.querySelector('button');
        if (b) b.focus();
      }
    }
    function waehleReiter(art) {
      modus = art;
      vorschauPfad = null;
      zeichne(true);
    }

    function zeige(an) {
      const will = an === undefined ? refs.panel.hidden : !!an;
      if (will === !refs.panel.hidden) return;
      refs.panel.hidden = !will;
      if (will) {
        zeichne(true);
        sigAlt = sig();
        const b = refs.inhalt.querySelector('.ae-name, .ae-knoten, .ae-zurueck');
        (b || refs.zu).focus();
      } else {
        zeichne();
        if (refs.panel.contains(doc.activeElement)) refs.knopf.focus();
      }
    }

    refs.knopf.addEventListener('click', () => zeige());
    refs.zu.addEventListener('click', () => zeige(false));
    refs.reiterListe.addEventListener('click', () => waehleReiter('liste'));
    refs.reiterBaum.addEventListener('click', () => waehleReiter('baum'));

    // Im Panel gehören alle Tasten ohne Umschalttaste dem Panel (chat.js hört am Dokument: Esc würde sonst den Lauf anhalten, 1/2/J/N Karten entscheiden)
    refs.panel.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      e.stopPropagation();
      const ziel = e.target;
      const istName = ziel.classList && ziel.classList.contains('ae-name');
      const istKnoten = ziel.classList && ziel.classList.contains('ae-knoten');
      if (k === 'Escape') {
        e.preventDefault();
        if (modus === 'vorschau') schliesseVorschau();
        else zeige(false);
        return;
      }
      if (ziel === refs.reiterListe || ziel === refs.reiterBaum) {
        if (k === 'ArrowLeft' || k === 'ArrowRight') {
          e.preventDefault();
          waehleReiter(ziel === refs.reiterListe ? 'baum' : 'liste');
          (modus === 'baum' ? refs.reiterBaum : refs.reiterListe).focus();
        } else if (k === 'ArrowDown') {
          e.preventDefault();
          const b = refs.inhalt.querySelector('.ae-name, .ae-knoten');
          if (b) b.focus();
        }
        return;
      }
      if (istName || istKnoten) {
        const alle = [...refs.inhalt.querySelectorAll(istName ? '.ae-name' : '.ae-knoten')];
        const i = alle.indexOf(ziel);
        const gehe = (j) => {
          e.preventDefault();
          if (alle[j]) alle[j].focus();
          else if (j < 0 && !refs.reiter.hidden) (modus === 'baum' ? refs.reiterBaum : refs.reiterListe).focus();
        };
        if (k === 'ArrowDown') return gehe(Math.min(alle.length - 1, i + 1));
        if (k === 'ArrowUp') return gehe(i - 1);
        if (k === 'Home') return gehe(0);
        if (k === 'End') return gehe(alle.length - 1);
        if (istName) {
          const pfad = ziel.closest('.ae-datei').dataset.pfad;
          if ((k === 'Enter' && e.shiftKey) || k === 'v' || k === 'V') {
            e.preventDefault();
            oeffneVorschau(pfad);
          } else if (k === 'Enter' || k === 'ArrowRight') {
            e.preventDefault();
            if (!offen.has(pfad)) schalteDiff(pfad);
            else if (k === 'Enter') schalteDiff(pfad);
          } else if (k === 'ArrowLeft') {
            e.preventDefault();
            if (offen.has(pfad)) schalteDiff(pfad);
          }
          return;
        }
        if (ziel.dataset.ordner !== undefined) {
          if (k === 'ArrowRight') {
            e.preventDefault();
            if (zu.has(ziel.dataset.ordner)) schalteOrdner(ziel.dataset.ordner, true);
          } else if (k === 'ArrowLeft') {
            e.preventDefault();
            if (!zu.has(ziel.dataset.ordner)) schalteOrdner(ziel.dataset.ordner, false);
          }
        }
      }
    });

    zeichne();
    return {
      setze,
      zeige,
      offen: () => !refs.panel.hidden,
      dateien: () => erg.dateien,
      beruehrt: () => erg.beruehrt,
      oeffneVorschau,
      schalteDiff,
      get modus() {
        return modus;
      },
    };
  }

  FP.createAenderungen = createAenderungen;
  FP.aenderungen = { sammle, vorschau, baum, relativ, vergleiche };
})(typeof globalThis !== 'undefined' ? globalThis : window);
