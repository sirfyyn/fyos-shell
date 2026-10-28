/* Inkrementelles Markdown für Streaming (klassisches Skript, kein Modul: läuft per Doppelklick von file://).
 *
 * Regel: Das DOM wächst nur. Ein fertiger Block (Absatz, Listenpunkt, Codezeile) wird nie neu gebaut.
 * - Block-Ebene: zeilenweise Zustandsmaschine (Absatz, Überschrift, Liste, Codezaun).
 * - Inline-Ebene: Text wird bis zur letzten "sauberen" Stelle (nach einem Leerzeichen, ohne offenes `code`, **fett**, *kursiv*, [Link](…))
 *   einmal geparst und vor einen Schwanz-Textknoten gesetzt. Nur dieser Schwanz wächst (derselbe Textknoten).
 * - Der Cursor ist eine CSS-Klasse (.ist-ende) auf dem aktiven Element, kein eingefügter Knoten.
 * Nichts wird als HTML eingesetzt (nur createElement/textContent).
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  // ---------------------------------------------------------------------------
  // Syntaxfarben (minimal, zeilenweise)
  // ---------------------------------------------------------------------------
  const SCHLUESSEL = {
    js: 'const let var function return if else for while of in new class import export from default async await try catch finally throw switch case break continue null true false undefined this typeof',
    py: 'def class return if elif else for while in import from as with try except finally raise lambda None True False and or not pass yield async await',
    sh: 'if then else fi for do done while case esac function in echo cd export sudo git npm node',
    json: 'true false null',
  };
  const ALIAS = { javascript: 'js', mjs: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js', python: 'py', bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh' };
  const WOERTER = {};
  for (const k of Object.keys(SCHLUESSEL)) WOERTER[k] = new Set(SCHLUESSEL[k].split(' '));

  function sprachKey(lang) {
    const l = String(lang || '').toLowerCase();
    const a = ALIAS[l] || l;
    return SCHLUESSEL[a] ? a : a === 'diff' ? 'diff' : '';
  }

  /** Eine Zeile → [{k: 'kw'|'str'|'com'|'num'|'fn'|'flag'|'', s}] */
  function highlightLine(line, lang) {
    const key = sprachKey(lang);
    if (!key) return [{ k: '', s: line }];
    if (key === 'diff') {
      const c = line[0];
      return [{ k: c === '+' ? 'add' : c === '-' ? 'del' : c === '@' ? 'fn' : '', s: line }];
    }
    const kom = key === 'js' ? '\\/\\/.*$' : '#.*$';
    const re = new RegExp(
      `(${key === 'json' ? '(?!)' : kom})|("(?:[^"\\\\]|\\\\.)*"?|'(?:[^'\\\\]|\\\\.)*'?${key === 'js' ? '|`(?:[^`\\\\]|\\\\.)*`?' : ''})|(\\b\\d+(?:\\.\\d+)?\\b)|(\\s--?[A-Za-z][\\w-]*)|([A-Za-z_$][\\w$]*)(?=\\()|([A-Za-z_$][\\w$]*)`,
      'g'
    );
    const aus = [];
    let letzte = 0;
    let m;
    const dazu = (k, s) => {
      if (!s) return;
      const l = aus[aus.length - 1];
      if (l && l.k === k) l.s += s;
      else aus.push({ k, s });
    };
    while ((m = re.exec(line))) {
      dazu('', line.slice(letzte, m.index));
      if (m[1]) dazu('com', m[1]);
      else if (m[2]) dazu(key === 'json' && /^\s*:/.test(line.slice(m.index + m[2].length)) ? 'fn' : 'str', m[2]);
      else if (m[3]) dazu('num', m[3]);
      else if (m[4]) dazu(key === 'sh' ? 'flag' : '', m[4]);
      else if (m[5]) dazu(WOERTER[key].has(m[5]) ? 'kw' : 'fn', m[5]);
      else dazu(WOERTER[key].has(m[6]) ? 'kw' : '', m[6]);
      letzte = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++;
    }
    dazu('', line.slice(letzte));
    return aus;
  }

  function haengeZeile(doc, eltern, line, lang) {
    for (const t of highlightLine(line, lang)) {
      if (!t.k) eltern.appendChild(doc.createTextNode(t.s));
      else {
        const sp = doc.createElement('span');
        sp.className = `tok-${t.k}`;
        sp.textContent = t.s;
        eltern.appendChild(sp);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Inline
  // ---------------------------------------------------------------------------
  const INLINE = /`([^`\n]+)`|\*\*([^*]+?)\*\*|\*([^*\s][^*]*?)\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

  function linkErlaubt(url) {
    return /^https?:\/\/[^\s]+$/i.test(String(url || ''));
  }

  function parseInline(text, doc) {
    const frag = doc.createDocumentFragment();
    const re = new RegExp(INLINE.source, 'g');
    let letzte = 0;
    let m;
    const el = (tag, cls) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      return e;
    };
    while ((m = re.exec(text))) {
      if (m.index > letzte) frag.appendChild(doc.createTextNode(text.slice(letzte, m.index)));
      if (m[1] !== undefined) {
        const c = el('code', 'inline');
        c.textContent = m[1];
        frag.appendChild(c);
      } else if (m[2] !== undefined) {
        const b = el('strong');
        b.appendChild(parseInline(m[2], doc));
        frag.appendChild(b);
      } else if (m[3] !== undefined) {
        const i = el('em');
        i.appendChild(parseInline(m[3], doc));
        frag.appendChild(i);
      } else {
        const href = m[5] !== undefined ? m[5] : m[6];
        const label = m[4] !== undefined ? m[4] : m[6];
        const a = el('a');
        if (linkErlaubt(href)) {
          a.setAttribute('href', href);
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
        }
        a.appendChild(m[4] !== undefined ? parseInline(label, doc) : doc.createTextNode(label));
        frag.appendChild(a);
      }
      letzte = m.index + m[0].length;
    }
    if (letzte < text.length) frag.appendChild(doc.createTextNode(text.slice(letzte)));
    return frag;
  }

  /** Bis wohin ist der Text "sauber" (nichts Offenes)? lastSafe = Länge des längsten sauberen Präfixes, das nach Leerraum endet. */
  function scanInline(s) {
    let code = false;
    let bold = false;
    let ital = false;
    let link = 0;
    let lastSafe = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '`') code = !code;
      else if (!code) {
        if (c === '*') {
          const zwei = s[i + 1] === '*';
          const next = s[i + (zwei ? 2 : 1)];
          const prev = s[i - 1];
          const oeffnen = next !== undefined && !/\s/.test(next);
          const schliessen = prev !== undefined && !/\s/.test(prev);
          if (zwei) {
            if (!bold) {
              if (oeffnen) bold = true;
            } else if (schliessen) bold = false;
            i++;
          } else if (!ital) {
            if (oeffnen) ital = true;
          } else if (schliessen) ital = false;
        } else if (c === '[' && link === 0) link = 1;
        else if (c === ']' && link === 1) {
          if (s[i + 1] === '(') {
            link = 2;
            i++;
          } else link = 0;
        } else if (c === ')' && link === 2) link = 0;
      }
      if (/\s/.test(s[i]) && !(code || bold || ital || link)) lastSafe = i + 1;
    }
    return { lastSafe, clean: !(code || bold || ital || link) };
  }

  /** Wachsender Inline-Text in einem Element: fertiger Teil bleibt, nur der Schwanz-Textknoten wächst. */
  class InlineStrom {
    constructor(el, doc, stats) {
      this.el = el;
      this.doc = doc;
      this.stats = stats;
      this.offen = '';
      this.schwanz = doc.createTextNode('');
      el.appendChild(this.schwanz);
    }
    push(s) {
      if (!s) return;
      this.offen += s;
      const { lastSafe } = scanInline(this.offen);
      if (lastSafe > 0) {
        const fertig = this.offen.slice(0, lastSafe);
        this.offen = this.offen.slice(lastSafe);
        this.el.insertBefore(parseInline(fertig, this.doc), this.schwanz);
        this.stats.festgeschrieben++;
      }
      this.schwanz.data = this.offen;
    }
    ende() {
      if (this.offen) {
        this.el.insertBefore(parseInline(this.offen, this.doc), this.schwanz);
        this.offen = '';
        this.schwanz.data = '';
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Blöcke
  // ---------------------------------------------------------------------------
  const R_UNENTSCHIEDEN = /^(\s*(?:[-*+]|\d+[.)]?|#{1,6}|`{1,2})|\s*)$/;
  const R_ZAUN = /^\s*```\s*([\w+#.-]*)\s*$/;
  const R_ZAUN_ANFANG = /^\s*```/;
  const R_KOPF = /^(#{1,6}) (.*)$/;
  const R_UL = /^(\s*)[-*+] (.*)$/;
  const R_OL = /^(\s*)\d+[.)] (.*)$/;

  function createMarkdownStream(root, opts) {
    const doc = root.ownerDocument;
    const stats = { bloecke: 0, festgeschrieben: 0, zeilen: 0 };
    let buf = ''; // die laufende, noch nicht beendete Zeile
    let zeilenArt = null; // null = noch unentschieden, 'text' | 'zaun'
    let modus = 'leer'; // leer | p | liste | code
    let cur = null; // InlineStrom des offenen Absatzes/Punkts
    let curEl = null;
    let liste = null; // { el, typ }
    let code = null; // { codeEl, schwanz, lang }
    let roh = '';
    let aktiv = null;
    let beendet = false;

    const markiere = (el) => {
      if (aktiv && aktiv !== el) aktiv.classList.remove('ist-ende');
      aktiv = el;
      if (el) el.classList.add('ist-ende');
    };
    const neu = (tag, cls) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      stats.bloecke++;
      return e;
    };
    const schliesseInline = () => {
      if (cur) cur.ende();
      cur = null;
      curEl = null;
    };
    const oeffneInline = (el) => {
      schliesseInline();
      cur = new InlineStrom(el, doc, stats);
      curEl = el;
      markiere(el);
    };

    function oeffneAbsatz() {
      const p = neu('p');
      root.appendChild(p);
      oeffneInline(p);
      modus = 'p';
      liste = null;
      return p;
    }
    function oeffneKopf(n) {
      const h = neu('h' + Math.min(n + 2, 6));
      root.appendChild(h);
      oeffneInline(h);
      modus = 'kopf';
      liste = null;
    }
    function oeffnePunkt(typ, einzug) {
      if (!liste || liste.typ !== typ) {
        const l = neu(typ);
        root.appendChild(l);
        liste = { el: l, typ };
      }
      const li = doc.createElement('li');
      stats.bloecke++;
      if (einzug >= 2) li.className = 'ebene2';
      liste.el.appendChild(li);
      oeffneInline(li);
      modus = 'liste';
    }
    function oeffneCode(lang) {
      schliesseInline();
      markiere(null);
      const box = neu('div', 'codeblock');
      const kopf = doc.createElement('div');
      kopf.className = 'code-kopf';
      const sp = doc.createElement('span');
      sp.className = 'sprache';
      sp.textContent = lang || 'text';
      const kn = doc.createElement('button');
      kn.type = 'button';
      kn.className = 'kopieren';
      kn.textContent = 'Kopieren';
      kn.setAttribute('aria-label', 'Code kopieren');
      kn.addEventListener('click', () => {
        try {
          const w = doc.defaultView;
          if (w && w.navigator && w.navigator.clipboard) w.navigator.clipboard.writeText(codeEl.textContent);
          kn.textContent = 'Kopiert';
          w.setTimeout(() => (kn.textContent = 'Kopieren'), 1500);
        } catch (e) {
          /* ohne Zwischenablage: still */
        }
      });
      kopf.append(sp, kn);
      const pre = doc.createElement('pre');
      const codeEl = doc.createElement('code');
      pre.appendChild(codeEl);
      box.append(kopf, pre);
      root.appendChild(box);
      const schwanz = doc.createTextNode('');
      codeEl.appendChild(schwanz);
      code = { codeEl, schwanz, lang: lang || '' };
      modus = 'code';
      liste = null;
      markiere(codeEl);
    }
    function schliesseCode() {
      code = null;
      modus = 'leer';
      markiere(null);
    }
    function codeZeile(z) {
      const frag = doc.createDocumentFragment();
      haengeZeile(doc, frag, z, code.lang);
      frag.appendChild(doc.createTextNode('\n'));
      code.codeEl.insertBefore(frag, code.schwanz);
      stats.zeilen++;
    }
    function codeSchwanz() {
      // Anfang eines schließenden Zauns nicht kurz aufblitzen lassen
      code.schwanz.data = /^\s*`{1,3}\s*$/.test(buf) ? '' : buf;
    }

    /** Entscheidet am Zeilenanfang, was die Zeile ist. `ende`: die Zeile ist zu Ende (Unentschiedenes zählt als Text). */
    function klassifiziere(ende) {
      if (R_ZAUN_ANFANG.test(buf)) {
        zeilenArt = 'zaun';
        return;
      }
      if (!ende && R_UNENTSCHIEDEN.test(buf)) return;
      let m;
      if ((m = R_KOPF.exec(buf))) {
        oeffneKopf(m[1].length);
        zeilenArt = 'text';
        buf = '';
        cur.push(m[2]);
        return;
      }
      if ((m = R_UL.exec(buf)) || (m = R_OL.exec(buf))) {
        oeffnePunkt(R_UL.test(buf) ? 'ul' : 'ol', m[1].length);
        zeilenArt = 'text';
        buf = '';
        cur.push(m[2]);
        return;
      }
      const text = buf.replace(/^\s+/, '');
      const einzug = buf.length - text.length;
      if (modus === 'p' || (modus === 'liste' && einzug >= 2)) {
        if (curEl && curEl.textContent.length) cur.push(' ');
      } else oeffneAbsatz();
      zeilenArt = 'text';
      buf = '';
      cur.push(text);
    }

    function zeileFertig() {
      if (modus === 'code') {
        if (/^\s*```\s*$/.test(buf)) schliesseCode();
        else {
          codeZeile(buf);
          code.schwanz.data = '';
        }
        buf = '';
        return;
      }
      if (zeilenArt === null) {
        if (buf.trim() === '') {
          if (modus === 'p' || modus === 'kopf') {
            schliesseInline();
            markiere(null);
            modus = 'leer';
          } else if (modus === 'liste') {
            // Leerzeile in einer Liste: Liste bleibt für einen folgenden Punkt gleichen Typs offen
            schliesseInline();
            markiere(null);
            modus = 'leer';
          }
          buf = '';
          return;
        }
        klassifiziere(true);
      }
      if (zeilenArt === 'zaun') {
        const m = R_ZAUN.exec(buf);
        schliesseInline();
        oeffneCode(m ? m[1] : '');
        buf = '';
      } else if (modus === 'kopf') {
        schliesseInline();
        markiere(null);
        modus = 'leer';
      }
      zeilenArt = null;
      buf = '';
    }

    function zeichen(seg) {
      if (!seg) return;
      if (modus === 'code') {
        buf += seg;
        codeSchwanz();
      } else if (zeilenArt === null) {
        buf += seg;
        klassifiziere(false);
      } else if (zeilenArt === 'zaun') buf += seg;
      else cur.push(seg);
    }

    return {
      stats,
      get text() {
        return roh;
      },
      write(s) {
        if (beendet || !s) return;
        s = String(s).replace(/\r\n?/g, '\n');
        roh += s;
        const teile = s.split('\n');
        for (let i = 0; i < teile.length; i++) {
          zeichen(teile[i]);
          if (i < teile.length - 1) zeileFertig();
        }
      },
      end() {
        if (beendet) return;
        beendet = true;
        if (modus === 'code') {
          if (buf && !/^\s*`{1,3}\s*$/.test(buf)) {
            codeZeile(buf);
          }
          code.schwanz.data = '';
        } else if (buf || zeilenArt) zeileFertig();
        schliesseInline();
        markiere(null);
      },
    };
  }

  Object.assign(FP, { createMarkdownStream, parseInline, scanInline, highlightLine, linkErlaubt, haengeZeile });
})(typeof globalThis !== 'undefined' ? globalThis : window);
