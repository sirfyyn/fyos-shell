/* Eingabefeld des Arbeitsplatzes: Vorschläge für `@Datei` (Dateien des Arbeitsordners) und `/Befehl` (Befehle des Runners).
 *
 * Reine Teile (ohne DOM): aktiverToken, unscharf, pfadTeile, dateiWert, befehlsListe, rangiere.
 * Oberfläche: FP.createEingabe(refs, opts) hängt sich an die Textarea (Rolle combobox) und die Liste (Rolle listbox) und liest ihre Quellen über opts:
 *   opts.basis()         → Arbeitsordner der Sitzung (absolut) oder ''
 *   opts.ordner(abs)     → Promise<{ eintraege: [{ name, ordner, groesse }], abgeschnitten }>  (GET /api/ordner?pfad=&dateien=1, lazy je Ordner)
 *   opts.beruehrt()      → relative Pfade der Dateien, die der Agent in dieser Sitzung berührt hat (Rückfall, wenn der Ordner nicht lesbar ist)
 *   opts.befehle()       → Promise<[{ name, beschreibung, argumente, art, aliase }] | null>  (GET /api/befehle; null = älterer Runner)
 *   opts.beiAenderung()  → der Text wurde durch eine Wahl verändert (Höhe nachziehen)
 *
 * Eingesetzt wird nur der NAME einer Datei bzw. eines Befehls ("@pfad/relativ"), nie ein Dateiinhalt: der Agent liest die Datei selbst.
 * Alle Namen kommen vom Runner oder aus dem Verlauf und gehen ausschließlich über textContent in die Seite.
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  const MAX_ZEILEN = 50; // so viele Vorschläge zeigt die Liste höchstens
  const MAX_UNTERORDNER = 6; // Unterordner, die beim Weitertippen (ohne Schrägstrich) nachgeladen werden, je Eingabe
  const MAX_GELADEN = 40; // Ordner insgesamt, die für die Suche geladen werden (je Sitzung)
  const UEBERSPRINGEN = new Set(['node_modules', 'target', 'dist', 'build', 'out', 'vendor', '__pycache__', 'venv', '.venv']); // nie von selbst nachladen
  const FALLBACK_BEFEHLE = [
    { name: 'verdichten', beschreibung: 'Verlauf verdichten', argumente: '', art: '', aliase: [] },
    { name: 'leeren', beschreibung: 'Neuer Kontext, der Verlauf bleibt sichtbar', argumente: '', art: '', aliase: [] },
    { name: 'abzweigen', beschreibung: 'Neues Gespräch ab dieser Stelle', argumente: '', art: '', aliase: [] },
    { name: 'abbrechen', beschreibung: 'Laufenden Zug stoppen', argumente: '', art: '', aliase: [] },
  ];

  // --- rein ---------------------------------------------------------------------------------

  /**
   * Das Wort an der Schreibmarke, falls es ein Vorschlag-Auslöser ist.
   *   `@…` am Wortanfang (Anfang oder nach Leerraum): { art: 'datei', start, ende, anfrage, gequotet }; `@"…` erlaubt Leerzeichen im Namen.
   *   `/…` als erstes Wort des Textes: { art: 'befehl', start: 0, ende, anfrage }.
   * Sonst null. `ende` ist das Ende des Wortes im ganzen Text (bei Befehlen: bis zum ersten Leerraum), damit eine Wahl das ganze Wort ersetzt.
   */
  function aktiverToken(text, cursor) {
    text = String(text);
    const c = Math.max(0, Math.min(text.length, Number.isInteger(cursor) ? cursor : text.length));
    const vor = text.slice(0, c);
    let m = /(^|\s)@"([^"\n]*)$/.exec(vor);
    if (m) return { art: 'datei', start: m.index + m[1].length, ende: c, anfrage: m[2], gequotet: true };
    m = /(^|\s)@([^\s"]*)$/.exec(vor);
    if (m) return { art: 'datei', start: m.index + m[1].length, ende: c, anfrage: m[2], gequotet: false };
    m = /^\/([^\s]*)$/.exec(vor);
    if (m) {
      const rest = /^[^\s]*/.exec(text.slice(c))[0];
      return { art: 'befehl', start: 0, ende: c + rest.length, anfrage: m[1] };
    }
    return null;
  }

  /**
   * Unscharfer Treffer: Punktzahl (größer = besser) oder -1. Groß/Klein egal. Rangfolge: gleich, Anfang, Teilstück (früher besser),
   * Buchstaben in Reihenfolge (Wortanfänge zählen mehr, Lücken kosten).
   */
  function unscharf(anfrage, text) {
    const q = String(anfrage || '').toLowerCase();
    const t = String(text || '').toLowerCase();
    if (!q) return 0;
    if (t === q) return 5000;
    if (t.startsWith(q)) return 4000 - Math.min(t.length, 500);
    const i = t.indexOf(q);
    if (i >= 0) return 3000 - Math.min(i, 500) - Math.min(t.length, 500) / 10;
    let pos = -1;
    let punkte = 1000;
    for (const z of q) {
      const n = t.indexOf(z, pos + 1);
      if (n < 0) return -1;
      punkte -= Math.min(n - pos - 1, 40) * 2;
      if (n === 0 || /[\s/._-]/.test(t[n - 1])) punkte += 15;
      pos = n;
    }
    return punkte > 0 ? punkte : 1;
  }

  /** Die Anfrage nach dem letzten Schrägstrich teilen: `src/ap` → { ordner: 'src', filter: 'ap' }. `..` und absolute Pfade gibt es nicht (null). */
  function pfadTeile(anfrage) {
    const a = String(anfrage || '').replace(/\\/g, '/');
    if (a.startsWith('/') || a.split('/').includes('..') || a.includes('\0')) return null;
    const i = a.lastIndexOf('/');
    const ordner = i >= 0 ? a.slice(0, i).replace(/^(\.\/)+/, '').replace(/\/+/g, '/') : '';
    return { ordner: ordner === '.' ? '' : ordner, filter: i >= 0 ? a.slice(i + 1) : a };
  }

  /** Der Text, der für einen Pfad eingesetzt wird: `@pfad`, mit Anführungszeichen, wenn der Pfad Leerraum enthält. */
  function dateiWert(rel) {
    const p = String(rel);
    return /\s/.test(p) ? `@"${p}"` : `@${p}`;
  }

  /** Befehle zum Auslöser `/…`: nicht ausführbare Pi-Befehle (art terminal) fallen weg; Treffer am Namensanfang zuerst, dann Teilstücke. */
  function befehlsListe(befehle, anfrage) {
    const q = String(anfrage || '').toLowerCase();
    const alle = (befehle || []).filter((b) => b && b.art !== 'terminal');
    const bewertet = alle
      .map((b) => {
        const namen = [b.name, ...(b.aliase || [])];
        let beste = -1;
        for (const n of namen) {
          const p = n.toLowerCase().startsWith(q) ? 4000 - n.length : q && unscharf(q, n) >= 3000 - 500 ? 3000 : -1;
          if (p > beste) beste = p;
        }
        return { b, p: q ? beste : 0 };
      })
      .filter((x) => x.p >= 0);
    bewertet.sort((x, y) => y.p - x.p || (x.b.art === 'skill' ? 1 : 0) - (y.b.art === 'skill' ? 1 : 0) || x.b.name.localeCompare(y.b.name));
    return bewertet.map((x) => x.b);
  }

  /** Einträge eines Ordners nach der Anfrage ordnen: ohne Anfrage Ordner zuerst; mit Anfrage nach Punkten (Name zählt mehr als der Pfad). */
  function rangiere(eintraege, anfrage) {
    const q = String(anfrage || '');
    if (!q) return eintraege.slice().sort((a, b) => Number(!!b.ordner) - Number(!!a.ordner));
    return eintraege
      .map((e) => {
        const n = unscharf(q, e.name);
        const r = unscharf(q, e.rel);
        return { e, p: n >= 0 ? Math.max(n + 50, r) : r }; // ein Treffer im Namen zählt mehr als einer im Pfad
      })
      .filter((x) => x.p >= 0)
      .sort((a, b) => b.p - a.p || Number(!!b.e.ordner) - Number(!!a.e.ordner) || a.e.rel.localeCompare(b.e.rel))
      .map((x) => x.e);
  }

  // --- Oberfläche ---------------------------------------------------------------------------
  function createEingabe(refs, opts) {
    opts = opts || {};
    const feld = refs.feld;
    const liste = refs.liste;
    const doc = feld.ownerDocument;
    const ordnerCache = new Map(); // absoluter Ordner → { eintraege } | { fehler }
    let zustand = null; // { art, token, punkte: [{ ... }], index }
    let lauf = 0; // verwirft veraltete Antworten
    let geladen = 0;

    const sr = (text) => refs.ansage && (refs.ansage.textContent = text);

    function schliesse() {
      lauf += 1;
      zustand = null;
      liste.hidden = true;
      liste.textContent = '';
      feld.setAttribute('aria-expanded', 'false');
      feld.removeAttribute('aria-activedescendant');
    }

    function zeichne() {
      if (!zustand) return;
      liste.textContent = '';
      liste.setAttribute('aria-label', zustand.art === 'befehl' ? 'Befehle' : 'Dateien');
      if (zustand.hinweis) {
        const h = doc.createElement('div');
        h.className = 'menue-hinweis';
        h.setAttribute('role', 'presentation');
        h.textContent = zustand.hinweis;
        liste.appendChild(h);
      }
      zustand.punkte.forEach((p, i) => {
        const o = doc.createElement('div');
        o.className = `menue-punkt ${p.art}`;
        o.id = `mp${i}`;
        o.setAttribute('role', 'option');
        o.setAttribute('aria-selected', i === zustand.index ? 'true' : 'false');
        const a = doc.createElement('span');
        a.className = 'name';
        a.textContent = p.anzeige;
        o.appendChild(a);
        if (p.detail) {
          const b = doc.createElement('span');
          b.className = 'hilfe';
          b.textContent = p.detail;
          o.appendChild(b);
        }
        if (p.marke) {
          const m = doc.createElement('span');
          m.className = 'chip';
          m.textContent = p.marke;
          o.appendChild(m);
        }
        o.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          zustand.index = i;
          uebernimm();
        });
        liste.appendChild(o);
      });
      if (!zustand.punkte.length && !zustand.hinweis) {
        const h = doc.createElement('div');
        h.className = 'menue-hinweis';
        h.setAttribute('role', 'presentation');
        h.textContent = zustand.art === 'befehl' ? 'Keinen Befehl gefunden.' : 'Keine Datei gefunden.';
        liste.appendChild(h);
      }
      liste.hidden = false;
      feld.setAttribute('aria-expanded', 'true');
      if (zustand.punkte.length) {
        feld.setAttribute('aria-activedescendant', `mp${zustand.index}`);
        const el = liste.querySelector(`#mp${zustand.index}`);
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
      } else {
        feld.removeAttribute('aria-activedescendant');
      }
    }

    // --- Befehle ---
    async function zeigeBefehle(token) {
      const mein = ++lauf;
      let quelle = null;
      try {
        quelle = opts.befehle ? await opts.befehle() : null;
      } catch (f) {
        quelle = null;
      }
      if (mein !== lauf) return;
      const alle = quelle || FALLBACK_BEFEHLE;
      const treffer = befehlsListe(alle, token.anfrage).slice(0, MAX_ZEILEN);
      zustand = {
        art: 'befehl',
        token,
        index: 0,
        punkte: treffer.map((b) => ({
          art: 'befehl',
          anzeige: `/${b.name}`,
          detail: [b.argumente, b.beschreibung].filter(Boolean).join('  '),
          marke: b.art === 'skill' ? 'Skill' : b.art === 'vorlage' ? 'Vorlage' : '',
          wert: `/${b.name}`,
          mitArgument: !!b.argumente,
        })),
      };
      if (!treffer.length && !token.anfrage) zustand = null;
      if (zustand) zeichne();
      else schliesse();
    }

    // --- Dateien ---
    const verbinde = (basis, rel) => `${basis.replace(/\/+$/, '')}/${rel}`.replace(/\/+$/, '');
    async function ordnerLaden(rel) {
      const basis = opts.basis ? opts.basis() : '';
      if (!basis) throw Object.assign(new Error('Kein Arbeitsordner bekannt.'), { art: 'ohne_ordner' });
      const abs = verbinde(basis, rel);
      const alt = ordnerCache.get(abs);
      if (alt) {
        if (alt.fehler) throw alt.fehler;
        return alt;
      }
      geladen += 1;
      try {
        const r = await opts.ordner(abs);
        const e = {
          eintraege: r.eintraege.map((x) => ({ name: x.name, ordner: x.ordner !== false, groesse: x.groesse, rel: rel ? `${rel}/${x.name}` : x.name })),
          abgeschnitten: r.abgeschnitten === true,
        };
        ordnerCache.set(abs, e);
        return e;
      } catch (f) {
        // Ordner, den der Runner nicht lesen darf oder nicht kennt, nicht in jedem Tastendruck neu anfragen; ein Netzfehler wird nicht gemerkt
        if (f && f.art !== 'netz' && f.art !== 'zu_viele') ordnerCache.set(abs, { fehler: f });
        throw f;
      }
    }

    /** Einträge der schon geladenen Unterordner des Arbeitsordners (nie Ordner anderer Sitzungen). */
    function geladeneUnter() {
      const b = verbinde(opts.basis(), '');
      const aus = [];
      for (const [abs, v] of ordnerCache) if (v.eintraege && abs !== b && abs.startsWith(`${b}/`)) aus.push(...v.eintraege);
      return aus;
    }
    function dateiPunkte(eintraege, anfrage) {
      return rangiere(eintraege, anfrage)
        .slice(0, MAX_ZEILEN)
        .map((e) => ({
          art: e.ordner ? 'ordner' : 'datei',
          anzeige: e.ordner ? `${e.rel}/` : e.rel,
          detail: e.ordner ? '' : e.groesse != null ? FP.dateiGroesse(e.groesse) : '',
          rel: e.rel,
          ordner: !!e.ordner,
        }));
    }

    function rueckfall(token, teile, grund) {
      const beruehrt = (opts.beruehrt ? opts.beruehrt() : []).map((rel) => ({ name: rel.split('/').pop(), ordner: false, rel }));
      const mitPfad = teile.ordner ? beruehrt.filter((e) => e.rel.startsWith(`${teile.ordner}/`)) : beruehrt;
      zustand = {
        art: 'datei',
        token,
        index: 0,
        hinweis: `${grund} Vorgeschlagen werden Dateien, die der Agent in dieser Sitzung berührt hat.`,
        punkte: dateiPunkte(mitPfad, teile.filter),
      };
      zeichne();
    }

    async function zeigeDateien(token) {
      const mein = ++lauf;
      const teile = pfadTeile(token.anfrage);
      if (!teile) {
        schliesse();
        return;
      }
      let ordner;
      try {
        ordner = await ordnerLaden(teile.ordner);
      } catch (f) {
        if (mein !== lauf) return;
        const grund = f && f.art === 'ausserhalb' ? 'Der Ordner dieser Sitzung liegt außerhalb dessen, was der Runner freigibt.' : f && f.art === 'ohne_ordner' ? 'Diese Sitzung hat keinen bekannten Arbeitsordner.' : f && f.art === 'weg_fehlt' ? 'Dieser Runner listet keine Dateien.' : 'Der Ordner lässt sich nicht lesen.';
        rueckfall(token, teile, grund);
        return;
      }
      if (mein !== lauf) return;
      const basis = ordner.eintraege;
      zustand = { art: 'datei', token, index: 0, punkte: [], hinweis: ordner.abgeschnitten ? 'Der Ordner ist groß: nur die ersten Einträge werden gezeigt.' : '' };
      // Ohne Schrägstrich sucht die Eingabe auch in den schon geladenen Unterordnern und lädt einige nach (lazy, je Ordner einmal)
      const kandidaten = !teile.ordner && teile.filter ? basis.concat(geladeneUnter()) : basis;
      zustand.punkte = dateiPunkte(kandidaten, teile.filter);
      zeichne();
      if (!teile.ordner && teile.filter) {
        let n = 0;
        for (const e of basis) {
          if (n >= MAX_UNTERORDNER || geladen >= MAX_GELADEN) break;
          if (!e.ordner || UEBERSPRINGEN.has(e.name) || ordnerCache.has(verbinde(opts.basis(), e.rel))) continue;
          n += 1;
          try {
            await ordnerLaden(e.rel);
          } catch (f) {
            continue;
          }
          if (mein !== lauf) return;
          zustand.punkte = dateiPunkte(basis.concat(geladeneUnter()), teile.filter);
          if (zustand.index >= zustand.punkte.length) zustand.index = 0;
          zeichne();
        }
      }
    }

    // --- Wahl ---
    function ersetze(token, text) {
      const v = feld.value;
      feld.value = v.slice(0, token.start) + text + v.slice(token.ende);
      const pos = token.start + text.length;
      if (typeof feld.setSelectionRange === 'function') feld.setSelectionRange(pos, pos);
      if (opts.beiAenderung) opts.beiAenderung();
    }
    function uebernimm() {
      if (!zustand || !zustand.punkte.length) return;
      const p = zustand.punkte[zustand.index];
      const token = zustand.token;
      if (zustand.art === 'befehl') {
        schliesse();
        ersetze(token, `${p.wert} `);
        feld.focus();
        return;
      }
      if (p.ordner) {
        // in den Ordner hinein: `@dir/`, die Liste bleibt offen und zeigt dessen Inhalt
        ersetze(token, token.gequotet || /\s/.test(p.rel) ? `@"${p.rel}/` : `@${p.rel}/`);
        aktualisiere();
        feld.focus();
        return;
      }
      schliesse();
      ersetze(token, `${dateiWert(p.rel)} `);
      sr(`Datei ${p.rel} eingefügt`);
      feld.focus();
    }

    function aktualisiere() {
      const t = aktiverToken(feld.value, feld.selectionStart);
      if (!t) return schliesse();
      if (t.art === 'befehl') return void zeigeBefehle(t);
      return void zeigeDateien(t);
    }

    /** Taste im Eingabefeld, solange die Liste offen ist. → true, wenn die Taste verbraucht ist (der Aufrufer sendet dann nicht). */
    function beiTaste(e) {
      if (!zustand) return false;
      const n = zustand.punkte.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!n) return false;
        e.preventDefault();
        zustand.index = (zustand.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        zeichne();
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        schliesse();
        return true;
      }
      if (e.key === 'Tab' && !e.shiftKey && n) {
        e.preventDefault();
        uebernimm();
        return true;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.metaKey && !e.ctrlKey && n) {
        // Ein vollständig getippter Befehl ohne Argumente wird gesendet, nicht noch einmal ergänzt
        const p = zustand.punkte[zustand.index];
        if (zustand.art === 'befehl' && !p.mitArgument && feld.value.trim() === p.wert) {
          schliesse();
          return false;
        }
        e.preventDefault();
        uebernimm();
        return true;
      }
      return false;
    }

    function beiInput() {
      aktualisiere();
    }
    // Schreibmarke bewegt (Pfeil links/rechts, Klick): die Liste folgt dem Wort an der Marke
    feld.addEventListener('click', () => (zustand ? aktualisiere() : null));
    feld.addEventListener('blur', schliesse);

    return {
      beiInput,
      beiTaste,
      schliesse,
      aktualisiere,
      istOffen: () => !!zustand,
      zustand: () => zustand,
      /** Ordner-Speicher leeren (andere Sitzung, anderer Arbeitsordner, oder nach Änderungen durch den Agenten). */
      vergiss() {
        ordnerCache.clear();
        geladen = 0;
      },
    };
  }

  /** Dateigröße für die Liste: 812 B, 3,4 KB, 1,2 MB. */
  function dateiGroesse(n) {
    n = Number(n);
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} KB`;
    return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  }

  FP.dateiGroesse = FP.dateiGroesse || dateiGroesse;
  FP.createEingabe = createEingabe;
  FP.eingabe = { aktiverToken, unscharf, pfadTeile, dateiWert, befehlsListe, rangiere, dateiGroesse, FALLBACK_BEFEHLE };
})(typeof globalThis !== 'undefined' ? globalThis : window);
