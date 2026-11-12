/* Fläche „Diff und Datei“ rechts neben dem Gespräch: eine Datei mit Zeilennummern (an einer Zeile geöffnet), der Unterschied einer Datei und
 * ein Bild. Jede geöffnete Datei ist ein Reiter im Bereich der Flächen (flaechen.js).
 *
 * Gelesen wird über runner-wege.js: `datei` (GET /api/datei), `dateiBild` (dasselbe mit bild=1) und `staendeDiff` (Unterschied gegen den Stand
 * vor der Arbeit des Agenten). Nichts wird geschrieben. Inhalte kommen nur als Text in die Seite, ein Bild nur als data-Adresse aus geprüftem
 * Base64 (runner-wege.js `dateiBildBereinigen`).
 *
 *   createDateiFlaeche({ flaechen }, opts) → { oeffneDatei, oeffneDiff, oeffneBild, beiWechsel, beiAenderung, setzeSitzung, offene(), folgt }
 *   opts: doc · wege · gespraech() → Kennung der sichtbaren Sitzung · ordner() → ihr Arbeitsordner (für relative Pfade und die Anzeige)
 *         kenntStaende() → führt der Runner Stände · hatUnterschied(absPfad) → hat der Agent die Datei in dieser Sitzung geändert
 *         breit() → liegt die Fläche neben dem Gespräch (nicht darüber); nur dann geht sie von selbst auf
 *
 * Reine Teile (ohne Fenster): absolut, anzeigePfad, nameVon, pfadMitZeile, siehtWiePfadAus, zeilenVon.
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  const BILD_NAME = /\.(png|jpe?g|gif|webp)$/i;
  const ZEILEN_MAX = 4000; // so viele Zeilen einer Datei werden gezeigt
  const FARBE_BIS = 1500; // bis zu so vielen Zeilen mit Hervorhebung der Sprache
  const BYTES_MAX = 400000; // so viel liest die Fläche von einer Datei
  /** Endungen, an denen ein Name ohne Ordner als Datei gilt („chat.js“, aber nicht „pi_durable.model“). */
  const ENDUNGEN = new Set(
    'js mjs cjs ts tsx jsx json jsonl md txt html htm css scss py rs toml yaml yml sh zsh bash sql go java c h cc cpp hpp swift kt rb php lock cfg conf ini xml svg png jpg jpeg gif webp log csv tsv plist gradle vue svelte lua patch diff'.split(' ')
  );

  const groesseText = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1).replace('.', ',')} KB` : `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`);
  const nameVon = (pfad) => String(pfad || '').replace(/\/+$/, '').split('/').pop() || String(pfad || '');

  /** „a/./b/../c“ vereinfachen; über den Anfang hinaus geht es nicht. */
  function vereinfacht(pfad) {
    const teile = [];
    for (const t of String(pfad).split('/')) {
      if (t === '' || t === '.') continue;
      if (t === '..') teile.pop();
      else teile.push(t);
    }
    return `/${teile.join('/')}`;
  }

  /** Ein Pfad aus dem Gespräch → absolut: relative gelten im Ordner der Sitzung. Ohne Ordner lässt sich ein relativer nicht auflösen (null). */
  function absolut(pfad, ordner) {
    const p = String(pfad || '').trim();
    if (!p || p.includes('\0')) return null;
    if (p.startsWith('/')) return vereinfacht(p);
    const o = String(ordner || '');
    if (!o.startsWith('/')) return null;
    return vereinfacht(`${o}/${p}`);
  }

  /** Wie ein Pfad gezeigt wird: unterhalb des Ordners der Sitzung relativ, sonst ganz. */
  function anzeigePfad(abs, ordner) {
    const o = String(ordner || '').replace(/\/+$/, '');
    const a = String(abs || '');
    return o && a.startsWith(`${o}/`) ? a.slice(o.length + 1) : a;
  }

  /** „pfad:zeile“, „pfad:zeile:spalte“ oder „pfad#L12“ → { pfad, zeile }; ohne Zeile ist sie 0. */
  function pfadMitZeile(text) {
    const t = String(text || '').trim();
    let m = /^(.+?):(\d{1,7})(?::\d{1,7})?$/.exec(t);
    if (m) return { pfad: m[1], zeile: Number(m[2]) };
    m = /^(.+?)#L(\d{1,7})$/.exec(t);
    if (m) return { pfad: m[1], zeile: Number(m[2]) };
    return { pfad: t, zeile: 0 };
  }

  /**
   * Sieht ein Stück Code im Text der Antwort wie ein Dateipfad aus? Mit Ordner („src/lauf/index.js“, „src/x:12“) reicht eine Endung oder eine
   * Zeile; ohne Ordner zählen nur bekannte Endungen („chat.js:610“). Adressen, Wege einer API und Namen mit Leerraum sind es nicht.
   */
  function siehtWiePfadAus(text) {
    const t = String(text || '');
    if (t.length < 3 || t.length > 300 || /\s/.test(t) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false;
    const { pfad, zeile } = pfadMitZeile(t);
    if (!/^(?:\.{1,2}\/|\/)?[\w@.+-]+(?:\/[\w@.+-]+)*$/.test(pfad)) return false;
    const m = /\.([A-Za-z][A-Za-z0-9]{0,9})$/.exec(nameVon(pfad));
    const endung = m ? m[1].toLowerCase() : '';
    if (pfad.includes('/')) return !!endung || zeile > 0;
    return ENDUNGEN.has(endung);
  }

  /** Text einer Datei → Zeilen (ohne die leere nach dem letzten Zeilenende). */
  function zeilenVon(text) {
    const z = String(text).split('\n');
    if (z.length > 1 && z[z.length - 1] === '') z.pop();
    return z.map((s) => (s.endsWith('\r') ? s.slice(0, -1) : s));
  }

  const sprachVon = (name) => {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  };
  const zaehle = (diff) => {
    let plus = 0;
    let minus = 0;
    for (const h of (diff && diff.hunks) || []) for (const z of h.zeilen) z[0] === '+' ? plus++ : z[0] === '-' && minus++;
    return { plus, minus };
  };
  const GRUND = {
    nicht_gesichert: 'Der Stand vor der Arbeit des Agenten ist nicht gesichert (die Datei war zu groß).',
    kein_text: 'Kein Text: der Unterschied lässt sich nicht zeigen.',
    zu_lang: 'Der Unterschied ist zu lang für die Anzeige.',
  };

  function createDateiFlaeche(refs, opts) {
    opts = opts || {};
    const flaechen = refs.flaechen;
    const doc = opts.doc || G.document;
    const wege = opts.wege;
    const ordner = () => (opts.ordner && opts.ordner()) || '';
    const gespraech = () => (opts.gespraech ? opts.gespraech() : null);
    const kenntStaende = () => !!(opts.kenntStaende && opts.kenntStaende());
    const el = (tag, cls, text) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    };

    /** offene Flächen der sichtbaren Sitzung: Kennung der Fläche → Eintrag */
    let offen = new Map();
    /** die Flächen der anderen Sitzungen dieses Fensters: Kennung der Sitzung → { offen, aktiv } */
    const proSitzung = new Map();
    let sitzung = null;
    /** Geht die Fläche von selbst auf, wenn der Agent eine Datei ändert? Aus, sobald der Mensch eine so geöffnete Fläche schließt. */
    let folgt = true;

    function knopf(text, titel, bei) {
      const b = el('button', 'leise-knopf df-knopf', text);
      b.type = 'button';
      if (titel) b.title = titel;
      b.addEventListener('click', bei);
      return b;
    }

    function baueTeil(e) {
      const teil = el('div', 'fl-teil df-teil');
      const leiste = el('div', 'df-leiste');
      const pfad = el('span', 'df-pfad');
      const info = el('span', 'df-info');
      const knoepfe = el('span', 'df-knoepfe');
      leiste.append(pfad, info, knoepfe);
      const hinweis = el('p', 'df-hinweis');
      hinweis.hidden = true;
      const inhalt = el('div', 'df-inhalt');
      inhalt.tabIndex = 0;
      inhalt.setAttribute('role', 'region');
      teil.append(leiste, hinweis, inhalt);
      e.teil = teil;
      e.els = { pfad, info, knoepfe, hinweis, inhalt };
    }

    function springe(e) {
      if (!e.sprung || e.teil.hidden || e.phase !== 'ok') return;
      const ziel = e.els.inhalt.querySelector('tr.ziel');
      e.sprung = false;
      if (ziel && typeof ziel.scrollIntoView === 'function') ziel.scrollIntoView({ block: 'center' });
    }

    function zeichneDatei(e, hinweise) {
      const r = e.res;
      const { info, inhalt } = e.els;
      if (r.art === 'binaer') {
        info.textContent = groesseText(r.groesse);
        inhalt.append(el('p', 'df-leer', 'Binärdatei: sie lässt sich hier nicht zeigen.'));
        return;
      }
      const zeilen = zeilenVon(r.text);
      const n = r.text === '' ? 0 : zeilen.length;
      info.textContent = `${n === 1 ? '1 Zeile' : `${n} Zeilen`} · ${groesseText(r.groesse)}`;
      if (r.abgeschnitten) hinweise.push('Gekürzt: gezeigt wird nur der Anfang der Datei.');
      if (r.geschwaerzt) hinweise.push('Geheimnisse geschwärzt: Teile der Datei sind durch *** ersetzt. Das ist eine Lesehilfe, keine Kopiervorlage.');
      if (n > ZEILEN_MAX) hinweise.push(`Gezeigt werden die ersten ${ZEILEN_MAX} von ${n} Zeilen.`);
      if (e.zeile > 0 && e.zeile > Math.min(n, ZEILEN_MAX)) hinweise.push(e.zeile > n && !r.abgeschnitten ? `Zeile ${e.zeile} gibt es nicht: die Datei hat ${n === 1 ? '1 Zeile' : `${n} Zeilen`}.` : `Zeile ${e.zeile} liegt hinter dem gezeigten Teil.`);
      if (n === 0) {
        inhalt.append(el('p', 'df-leer', 'Die Datei ist leer.'));
        return;
      }
      const tab = el('table', 'df-code');
      const tb = el('tbody');
      const lang = n <= FARBE_BIS && FP.haengeZeile ? sprachVon(e.pfad) : null;
      zeilen.slice(0, ZEILEN_MAX).forEach((t, i) => {
        const tr = el('tr', i + 1 === e.zeile ? 'ziel' : '');
        if (i + 1 === e.zeile) tr.setAttribute('aria-current', 'true');
        const code = el('td', 'code');
        if (lang !== null) FP.haengeZeile(doc, code, t, lang);
        else code.textContent = t;
        tr.append(el('td', 'nr', String(i + 1)), code);
        tb.append(tr);
      });
      tab.append(tb);
      inhalt.append(tab);
    }

    function zeichneDiff(e, hinweise) {
      const { info, inhalt } = e.els;
      if (!e.diff) {
        inhalt.append(el('p', 'df-leer', e.text || 'Kein Unterschied.'));
        return;
      }
      if (FP.baueDiffChips) info.append(FP.baueDiffChips(doc, e.diff.zahlen || zaehle(e.diff)));
      hinweise.push(e.quelle === 'staende' ? 'Alle Änderungen des Agenten an dieser Datei in dieser Sitzung, gegen den Stand davor.' : 'Die Änderung dieses einen Aufrufs.');
      if (FP.baueDiff) inhalt.append(FP.baueDiff(doc, { ...e.diff, datei: anzeigePfad(e.pfad, ordner()) }));
    }

    function zeichneBild(e, hinweise) {
      const b = e.res;
      const { info, inhalt } = e.els;
      info.textContent = [b.breite && b.hoehe ? `${b.breite} × ${b.hoehe}` : '', b.groesse ? groesseText(b.groesse) : ''].filter(Boolean).join(' · ');
      if (b.verkleinert) hinweise.push('Verkleinert gezeigt; die Datei selbst ist unverändert.');
      const bild = el('img', 'df-bild');
      bild.alt = `Bild ${zeigeName(e)}`;
      // nur geprüftes Base64 mit einem bekannten Bildtyp (runner-wege.js)
      bild.src = `data:${b.typ};base64,${b.bild}`;
      inhalt.append(bild);
    }

    function zeichne(e) {
      const rel = zeigePfad(e);
      const { pfad, info, knoepfe, hinweis, inhalt } = e.els;
      e.teil.dataset.art = e.art;
      e.teil.dataset.phase = e.phase;
      pfad.textContent = rel;
      pfad.title = e.pfad;
      inhalt.setAttribute('aria-label', e.art === 'diff' ? `Unterschied in ${rel}` : e.art === 'bild' ? `Bild ${rel}` : `Inhalt von ${rel}`);
      info.textContent = '';
      knoepfe.textContent = '';
      // der Rollstand bleibt, wenn derselbe Inhalt neu gezeichnet wird (nach einem stillen Nachladen), außer es geht an eine Zeile
      const oben = inhalt.scrollTop;
      const links = inhalt.scrollLeft;
      inhalt.textContent = '';
      if (e.art === 'datei' && opts.hatUnterschied && opts.hatUnterschied(e.pfad)) knoepfe.append(knopf('Unterschied', 'Was der Agent in dieser Sitzung an der Datei geändert hat', () => oeffneDiff({ pfad: e.pfad })));
      if (e.art === 'diff' && e.quelle === 'aufruf' && kenntStaende()) knoepfe.append(knopf('Alle Änderungen', 'Alle Änderungen des Agenten an dieser Datei in dieser Sitzung', () => oeffneDiff({ pfad: e.pfad })));
      if (e.art === 'diff') knoepfe.append(knopf('Datei', 'Die ganze Datei zeigen', () => oeffneDatei({ pfad: e.pfad })));
      if (!(e.art === 'diff' && e.quelle === 'aufruf')) knoepfe.append(knopf('Neu laden', 'Noch einmal vom Runner lesen', () => void lade(e)));
      const hinweise = [];
      if (e.phase === 'laedt') inhalt.append(el('p', 'df-leer', e.art === 'bild' ? 'Bild wird geladen …' : 'Wird gelesen …'));
      else if (e.phase === 'fehler') inhalt.append(el('p', 'df-leer fehler', e.fehler || 'Nicht lesbar.'));
      else if (e.art === 'datei') zeichneDatei(e, hinweise);
      else if (e.art === 'diff') zeichneDiff(e, hinweise);
      else zeichneBild(e, hinweise);
      hinweis.textContent = hinweise.join(' ');
      hinweis.hidden = hinweise.length === 0;
      if (e.phase === 'ok' && !e.sprung) {
        inhalt.scrollTop = oben;
        inhalt.scrollLeft = links;
      }
      springe(e);
    }

    /**
     * Den Inhalt einer Fläche vom Runner lesen. Antworten, die nach einem neueren Lesen ankommen, gelten nicht mehr.
     * `still`: was schon zu sehen ist, bleibt stehen, bis das Neue da ist (der Agent hat die Datei geändert, niemand hat geklickt).
     */
    async function lade(e, still) {
      const lauf = ++e.lauf;
      const g = gespraech();
      const gilt = () => lauf === e.lauf && offen.get(e.id) === e;
      e.veraltet = false;
      if (!(still && e.phase === 'ok')) {
        e.phase = 'laedt';
        zeichne(e);
      }
      try {
        if (e.art === 'datei') {
          const r = await wege.datei(e.pfad, { gespraech: g, max: BYTES_MAX });
          if (!gilt()) return;
          e.res = r;
        } else if (e.art === 'bild') {
          const b = await wege.dateiBild(e.pfad, { gespraech: g });
          if (!gilt()) return;
          e.res = b;
        } else {
          let r = null;
          try {
            r = await wege.staendeDiff(g, e.pfad);
          } catch (f) {
            if (!gilt()) return;
            // der Runner kennt zu dieser Datei keinen Stand: dann gilt die Änderung des Aufrufs, von dem aus die Fläche geöffnet wurde
            if (!e.aufruf) throw f && f.status === 404 ? new Error('Zu dieser Datei gibt es keinen Stand: der Agent hat sie in dieser Sitzung nicht mit seinen Datei-Werkzeugen geändert.') : f;
          }
          if (!gilt()) return;
          if (r) {
            const diff = r.patch && FP.diffAusPatch ? FP.diffAusPatch(r.patch, r.relativ || anzeigePfad(e.pfad, ordner())) : null;
            e.quelle = 'staende';
            e.diff = diff ? { ...diff, zahlen: r.plus !== null && r.minus !== null ? { plus: r.plus, minus: r.minus } : undefined } : null;
            e.text = diff ? '' : GRUND[r.grund] || 'Kein Unterschied.';
          } else {
            e.quelle = 'aufruf';
            e.diff = e.aufruf;
          }
        }
        e.phase = 'ok';
      } catch (f) {
        if (!gilt()) return;
        e.phase = 'fehler';
        e.fehler = (f && f.message) || 'Nicht lesbar.';
      }
      zeichne(e);
    }

    // zwei Unterschiede derselben Datei können nebeneinander offen sein: alle Änderungen der Sitzung und die eines einzelnen Aufrufs
    const einzeln = (e) => e.id.startsWith('aufruf:');
    // ein Anhang trägt den Namen, den der Mensch ihm gab (im Datenordner des Runners heißt die Datei anders)
    const zeigeName = (e) => e.name || nameVon(e.pfad);
    const zeigePfad = (e) => (e.name ? `Anhang · ${e.name}` : anzeigePfad(e.pfad, ordner()));
    const titelVon = (e) => (e.art === 'diff' ? `± ${zeigeName(e)}${einzeln(e) ? ' · Aufruf' : ''}` : zeigeName(e));
    const hinweisVon = (e) => `${e.art === 'diff' ? (einzeln(e) ? 'Änderung eines Aufrufs: ' : 'Unterschied: ') : e.art === 'bild' ? 'Bild: ' : ''}${zeigePfad(e)}`;

    function zeige(e, o) {
      flaechen.oeffne(
        {
          id: e.id,
          titel: titelVon(e),
          hinweis: hinweisVon(e),
          teil: e.teil,
          beiZu: (grund) => {
            offen.delete(e.id);
            e.lauf += 1;
            // schließt der Mensch eine Fläche, die von selbst aufging, bleibt sie künftig zu (bis er selbst wieder eine öffnet)
            if (e.vonSelbst && grund !== 'verdraengt') folgt = false;
          },
        },
        o
      );
    }

    /** Eine Fläche anlegen oder die vorhandene nehmen. → der Eintrag und ob er neu ist */
    function eintrag(id, art, pfad) {
      let e = offen.get(id);
      if (e) return { e, neu: false };
      e = { id, art, pfad, name: '', zeile: 0, sprung: false, vonSelbst: false, aufruf: null, quelle: '', diff: null, text: '', res: null, fehler: '', phase: 'laedt', lauf: 0, veraltet: false, teil: null, els: null };
      baueTeil(e);
      offen.set(id, e);
      return { e, neu: true };
    }

    /**
     * Eine Datei öffnen, auf Wunsch an einer Zeile. Ein Bild wird als Bild gezeigt. `name`: der Name eines Anhangs (statt des Dateinamens
     * im Datenordner). → false, wenn sich der Pfad nicht auflösen lässt
     */
    function oeffneDatei(d) {
      const abs = absolut(d && d.pfad, ordner());
      if (!abs) return false;
      if (BILD_NAME.test(abs)) return oeffneBild({ pfad: abs, name: d.name });
      folgt = true;
      const { e, neu } = eintrag(`datei:${abs}`, 'datei', abs);
      if (d.name) e.name = String(d.name).slice(0, 200);
      e.zeile = Math.max(0, Math.trunc(Number(d.zeile) || 0));
      e.sprung = e.zeile > 0;
      zeige(e);
      if (neu || e.veraltet || e.phase === 'fehler') void lade(e);
      else zeichne(e);
      return true;
    }

    /**
     * Den Unterschied einer Datei öffnen. Mit `diff` (aus einer Karte im Gespräch) die Änderung dieses einen Aufrufs; sonst alle Änderungen
     * des Agenten an der Datei (vom Runner). `vonSelbst`: der Agent hat die Datei eben geändert, niemand hat geklickt.
     */
    function oeffneDiff(d) {
      const abs = absolut(d && d.pfad, ordner());
      if (!abs) return false;
      const einzeln = !!(d.diff && !d.vonSelbst);
      if (d.vonSelbst) {
        if (!folgt || (opts.breit && !opts.breit())) return false;
      } else folgt = true;
      const { e, neu } = eintrag(`${einzeln ? 'aufruf' : 'diff'}:${abs}`, 'diff', abs);
      if (neu) e.vonSelbst = !!d.vonSelbst;
      else if (!d.vonSelbst) e.vonSelbst = false;
      e.aufruf = d.diff || e.aufruf;
      // von selbst geöffnet drängt sie sich nicht vor eine Fläche, die der Mensch gerade ansieht
      const vorn = flaechen.aktiv === null ? null : offen.get(flaechen.aktiv);
      zeige(e, { imHintergrund: !!d.vonSelbst && flaechen.aktiv !== null && !(vorn && vorn.vonSelbst) });
      if (einzeln) {
        e.quelle = 'aufruf';
        e.diff = d.diff;
        e.phase = 'ok';
        e.lauf += 1;
        zeichne(e);
      } else if (kenntStaende()) void lade(e);
      else if (e.aufruf) {
        e.quelle = 'aufruf';
        e.diff = e.aufruf;
        e.phase = 'ok';
        zeichne(e);
      } else {
        e.phase = 'fehler';
        e.fehler = 'Dieser Runner führt keine Stände: es gibt nur die Änderungen der einzelnen Aufrufe im Gespräch.';
        zeichne(e);
      }
      return true;
    }

    /** Eine Bilddatei oder einen angehängten Anhang als Bild zeigen. */
    function oeffneBild(d) {
      const abs = absolut(d && d.pfad, ordner());
      if (!abs) return false;
      folgt = true;
      const { e, neu } = eintrag(`bild:${abs}`, 'bild', abs);
      if (d.name) e.name = String(d.name).slice(0, 200);
      zeige(e);
      if (neu || e.veraltet || e.phase === 'fehler') void lade(e);
      return true;
    }

    /** Der Reiter-Bereich zeigt jetzt diese Fläche: Veraltetes neu lesen, an die Zeile springen. */
    function beiWechsel(id) {
      const e = id === null || id === undefined ? null : offen.get(id);
      if (!e) return;
      if (e.veraltet) void lade(e);
      else springe(e);
    }

    /** Der Agent hat Dateien geändert (oder zurückgespult wurde): was offen ist, kann veraltet sein. Die sichtbare Fläche liest gleich neu. */
    function beiAenderung() {
      for (const e of offen.values()) {
        if (e.id.startsWith('aufruf:')) continue; // die Änderung eines einzelnen Aufrufs bleibt, was sie war
        if (e.id === flaechen.aktiv && !e.teil.hidden) void lade(e, true);
        else e.veraltet = true;
      }
    }

    /** Die sichtbare Sitzung hat gewechselt: ihre Flächen kommen zurück, die der vorigen bleiben für später liegen. */
    function setzeSitzung(id) {
      const neu = id === undefined || id === null ? null : String(id);
      if (neu === sitzung) return;
      if (sitzung !== null) proSitzung.set(sitzung, { offen, aktiv: offen.has(flaechen.aktiv) ? flaechen.aktiv : null });
      for (const e of offen.values()) {
        e.lauf += 1;
        flaechen.schliesse(e.id, { still: true });
      }
      sitzung = neu;
      const alt = neu === null ? null : proSitzung.get(neu);
      proSitzung.delete(neu);
      offen = alt ? alt.offen : new Map();
      for (const e of offen.values()) {
        // was beim Verlassen noch lud, ist nie angekommen; alles andere kann sich seitdem geändert haben
        e.veraltet = true;
        zeige(e, { imHintergrund: true });
      }
      if (alt && alt.aktiv !== null && offen.has(alt.aktiv)) flaechen.aktiviere(alt.aktiv);
      const vorn = offen.get(flaechen.aktiv);
      if (vorn && vorn.veraltet) void lade(vorn);
    }

    return {
      oeffneDatei,
      oeffneDiff,
      oeffneBild,
      beiWechsel,
      beiAenderung,
      setzeSitzung,
      offene: () => [...offen.values()].map((e) => ({ id: e.id, art: e.art, pfad: e.pfad, zeile: e.zeile, phase: e.phase, quelle: e.quelle, vonSelbst: e.vonSelbst })),
      get folgt() {
        return folgt;
      },
    };
  }

  FP.createDateiFlaeche = createDateiFlaeche;
  FP.dateiFlaeche = { absolut, anzeigePfad, nameVon, pfadMitZeile, siehtWiePfadAus, zeilenVon, groesseText, ZEILEN_MAX, BYTES_MAX };
})(typeof globalThis !== 'undefined' ? globalThis : window);
