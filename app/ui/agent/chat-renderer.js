/* Renderer: Ereignis → DOM. Klassisches Skript (läuft per Doppelklick von file://), hängt sich an globalThis.FyosPrototyp.
 *
 * Schnittstelle (siehe README.md): createChatView(spalte, opts) liefert
 *   addUserMessage, startTurn, startThinking, appendThinking, endThinking, appendText, startTool, updateTool, endTool,
 *   askApproval, resolveApproval, addMarker, endTurn, handleKey, flush, clear, stats, …
 * Alle Aufrufe laufen durch eine geordnete Warteschlange: Text wird rAF-getaktet zeichenweise freigegeben,
 * alles andere (Karten, Freigaben, Marker) wartet, bis der davor liegende Text gezeigt ist. So bleibt die Reihenfolge stabil.
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});
  // Name des Agenten in der Anzeige: neutral, bis die Seite den Namen des Runners kennt (chat.js setzt FP.anzeigename aus /api/health)
  const anzeigename = () => FP.anzeigename || 'Agent';

  // ---------------------------------------------------------------------------
  // Kleinkram (Gegenstück zu gespraech-logik.js: kurz, dauerText; ein Test vergleicht beide)
  // ---------------------------------------------------------------------------
  function kurz(wert, n = 120) {
    const t = String(wert == null ? '' : wert).replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  }
  function dauerText(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return '<1 s';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m < 60) return r ? `${m} min ${r} s` : `${m} min`;
    const h = Math.floor(m / 60);
    return `${h} h ${m % 60} min`;
  }
  /** Für Karten: "0,4 s", "3,2 s", "12 s". */
  function dauerKurz(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    if (ms < 10000) return `${(Math.round(ms / 100) / 10).toString().replace('.', ',')} s`;
    return dauerText(ms);
  }
  function zahlK(n) {
    if (n >= 1000000) return `${(Math.round(n / 100000) / 10).toString().replace('.', ',')} M`;
    return n >= 1000 ? `${(Math.round(n / 100) / 10).toString().replace('.', ',')}k` : String(n);
  }

  const ICON = {
    lesen: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 1.75h6l3 3v9.5h-9z M9.5 1.75v3h3 M5.5 8h5 M5.5 10.5h5" /></svg>',
    suchen: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25" /><path d="M10.2 10.2l3.6 3.6" /></svg>',
    bash: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5h12v9H2z M4.5 6.5l2 1.5-2 1.5 M8 10h3" /></svg>',
    edit: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 13.5l.7-3L10.8 3l2.2 2.2-7.6 7.6z M9.5 4.3l2.2 2.2" /></svg>',
    andere: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5l-1 4h4l-6 7 1-5h-4z" /></svg>',
    chev: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5L10 8l-4.5 4.5" /></svg>',
  };

  const ARTEN = {
    read: ['lesen', 'Lesen'],
    ls: ['lesen', 'Ordner'],
    grep: ['suchen', 'Suchen'],
    find: ['suchen', 'Dateien'],
    hub_suchen: ['suchen', 'Hub'],
    bash: ['bash', 'Bash'],
    edit: ['edit', 'Bearbeiten'],
    multiedit: ['edit', 'Bearbeiten'],
    str_replace: ['edit', 'Bearbeiten'],
    write: ['edit', 'Schreiben'],
  };
  function artVon(name) {
    const a = ARTEN[String(name || '').toLowerCase()];
    return a ? { art: a[0], label: a[1] } : { art: 'andere', label: kurz(String(name || 'Werkzeug').replace(/_/g, ' '), 30).replace(/^./, (c) => c.toUpperCase()) };
  }
  function ersterWert(args, namen) {
    if (!args || typeof args !== 'object') return '';
    for (const n of namen) if (args[n] !== undefined && args[n] !== null && args[n] !== '') return String(args[n]);
    return '';
  }
  function kurzfassung(name, args) {
    const n = String(name || '').toLowerCase();
    if (n === 'bash') return kurz(ersterWert(args, ['command', 'befehl']), 140);
    if (n === 'grep') return kurz(`„${ersterWert(args, ['pattern', 'suche'])}“ ${ersterWert(args, ['path', 'pfad'])}`.trim(), 140);
    if (n === 'find') return kurz(ersterWert(args, ['pattern', 'name', 'path']), 140);
    return kurz(ersterWert(args, ['path', 'file_path', 'pfad', 'werkzeug', 'suche', 'aktion', 'url', 'titel']), 140);
  }

  // ---------------------------------------------------------------------------
  // Zeilen-Diff (für Edit-Aufrufe mit alt/neu) und Diff-Zahlen
  // ---------------------------------------------------------------------------
  /** Einfacher LCS-Zeilendiff; liefert Zeilen [[' '|'+'|'-', text], …]. */
  function diffZeilen(alt, neu) {
    const a = String(alt).split('\n');
    const b = String(neu).split('\n');
    const n = a.length;
    const m = b.length;
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const aus = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        aus.push([' ', a[i]]);
        i++;
        j++;
      } else if (L[i + 1][j] >= L[i][j + 1]) aus.push(['-', a[i++]]);
      else aus.push(['+', b[j++]]);
    }
    while (i < n) aus.push(['-', a[i++]]);
    while (j < m) aus.push(['+', b[j++]]);
    return aus;
  }
  function diffZahlen(diff) {
    let plus = 0;
    let minus = 0;
    for (const h of (diff && diff.hunks) || []) for (const z of h.zeilen) z[0] === '+' ? plus++ : z[0] === '-' && minus++;
    return { plus, minus };
  }
  function sprachVonDatei(name) {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  // ---------------------------------------------------------------------------
  // Scroll: haftet am Ende, solange der Nutzer dort ist
  // ---------------------------------------------------------------------------
  function createScrollFollower(scroller, o) {
    const raf = o.raf;
    const schwelle = o.schwelle == null ? 40 : o.schwelle;
    let haftet = true;
    let geplant = false;
    let letzterTop = scroller.scrollTop;
    const abstand = () => scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    const knopf = () => {
      if (o.button) o.button.hidden = haftet || scroller.scrollHeight <= scroller.clientHeight + 1;
    };
    scroller.addEventListener('scroll', () => {
      const top = scroller.scrollTop;
      if (abstand() <= schwelle) haftet = true;
      else if (top < letzterTop) haftet = false;
      letzterTop = top;
      knopf();
    });
    function zumEnde() {
      scroller.scrollTop = scroller.scrollHeight;
      letzterTop = scroller.scrollTop;
      knopf();
    }
    if (o.button) {
      o.button.addEventListener('click', () => {
        haftet = true;
        zumEnde();
      });
    }
    return {
      get haftet() {
        return haftet;
      },
      set haftet(v) {
        haftet = !!v;
        knopf();
      },
      follow() {
        if (!haftet) {
          knopf();
          return;
        }
        if (geplant) return;
        geplant = true;
        raf(() => {
          geplant = false;
          if (haftet) zumEnde();
          else knopf();
        });
      },
      zumEnde: () => {
        haftet = true;
        zumEnde();
      },
      aktualisiere: knopf,
    };
  }

  // ---------------------------------------------------------------------------
  // Ansage für Screenreader: höflich und gedrosselt
  // ---------------------------------------------------------------------------
  function createAnsager(region, o) {
    const now = o.now;
    const st = o.setTimeout;
    const gap = o.gap == null ? 2500 : o.gap;
    let letzte = -Infinity;
    let timer = null;
    let satz = '';
    const warte = [];
    const flush = () => {
      timer = null;
      if (!warte.length) return;
      if (region) region.textContent = warte.join(' ');
      warte.length = 0;
      letzte = now();
    };
    const plane = () => {
      if (timer != null) return;
      timer = st(flush, Math.max(0, letzte + gap - now()));
    };
    return {
      sage(t) {
        if (t) warte.push(t);
        plane();
      },
      /** Streaming-Text: nur abgeschlossene Sätze werden vorgemerkt. */
      textHin(s) {
        satz += s;
        const m = /^([\s\S]*?[.!?:])\s/.exec(satz);
        if (!m) return;
        const letztesEnde = Math.max(satz.lastIndexOf('. '), satz.lastIndexOf('! '), satz.lastIndexOf('? '), satz.lastIndexOf(': '), satz.lastIndexOf('.\n'));
        if (letztesEnde < 0) return;
        warte.push(satz.slice(0, letztesEnde + 1).replace(/\s+/g, ' ').trim());
        satz = satz.slice(letztesEnde + 1);
        plane();
      },
      textEnde() {
        const r = satz.replace(/\s+/g, ' ').trim();
        satz = '';
        if (r) this.sage(r);
      },
      flush,
      get ausstehend() {
        return warte.length;
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Die Ansicht
  // ---------------------------------------------------------------------------
  function createChatView(spalte, opts) {
    opts = opts || {};
    const doc = spalte.ownerDocument;
    const win = doc.defaultView || G;
    const scroller = opts.scroller || spalte.parentElement;
    const now = opts.now || (() => Date.now());
    // Ein verdecktes oder verstecktes Fenster (Tray, hinter anderen) bekommt keine Animationsbilder: dann läuft der Takt über einen Zeitgeber,
    // damit Antworten weiter ankommen (Negative Nummern = Zeitgeber).
    const raf = opts.raf || ((f) => {
      if (doc.hidden) return -win.setTimeout(() => f(win.performance.now()), 50) - 1;
      return win.requestAnimationFrame(f);
    });
    const caf = opts.caf || ((id) => (id < 0 ? win.clearTimeout(-id - 1) : win.cancelAnimationFrame(id)));
    const setIv = opts.setInterval || ((f, ms) => win.setInterval(f, ms));
    const clearIv = opts.clearInterval || ((id) => win.clearInterval(id));
    const setTo = opts.setTimeout || ((f, ms) => win.setTimeout(f, ms));
    const reduziert = typeof opts.reduceMotion === 'function' ? opts.reduceMotion : () => !!opts.reduceMotion;
    const pacingAn = opts.pace !== false;
    const stats = { knotenNeu: 0, entfernt: 0, textZeichen: 0, tokenSchritte: 0, tools: 0 };
    const folge = createScrollFollower(scroller, { raf, button: opts.zumEnde, schwelle: opts.schwelle });
    const ansage = createAnsager(opts.ansage || null, { now, setTimeout: setTo, gap: opts.ansageAbstand });

    // Höhenänderungen ohne Ereignis (Aufklappen über Übergang, Bildlauf der Schrift) halten das Ende ebenfalls im Blick
    if (typeof win.ResizeObserver === 'function') new win.ResizeObserver(() => folge.follow()).observe(spalte);

    let idZaehler = 0;
    const uid = (p) => `${p}${++idZaehler}`;
    const el = (tag, cls, text) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      stats.knotenNeu++;
      return e;
    };
    const svg = (name) => {
      const s = el('span', 'symbol');
      s.innerHTML = ICON[name] || ''; // statische Konstanten, nie Nutzerdaten
      s.setAttribute('aria-hidden', 'true');
      return s;
    };

    // Zustand
    let turn = null;
    let turnStart = 0;
    let turnSchritte = 0;
    let seg = null; // { md, el }
    let denken = null;
    let gruppe = null;
    let busy = false;
    const tools = new Map();
    const freigaben = new Map();
    const alleTimer = new Set();

    const melde = () => opts.onZustand && opts.onZustand(zustand());
    function zustand() {
      let offene = 0;
      for (const f of freigaben.values()) if (f.offen) offene++;
      return { busy, wartetAufFreigabe: offene > 0, offeneFreigaben: offene, tools: [...tools.values()].filter((t) => t.status === 'laeuft').length, denkt: !!denken && !denken.fertig };
    }

    // --- Warteschlange / Pacer ------------------------------------------------
    const queue = [];
    let rafId = null;
    let letzteZeit = 0;
    let uebertrag = 0;
    const basisRate = opts.zeichenProSekunde || 110;

    function lauf(op) {
      if (op.fn) op.fn();
      else {
        textSchreiben(op.s);
      }
    }
    function enqueue(op) {
      if (!pacingAn || reduziert()) {
        if (queue.length) flush();
        lauf(op);
        return;
      }
      const l = queue[queue.length - 1];
      if (op.s != null && l && l.s != null) l.s += op.s;
      else queue.push(op);
      plane();
    }
    function plane() {
      if (rafId != null || !queue.length) return;
      rafId = raf(tick);
    }
    function rueckstand() {
      let n = 0;
      for (const o of queue) if (o.s != null) n += o.s.length;
      return n;
    }
    function tick(ts) {
      rafId = null;
      const dt = letzteZeit ? Math.min(100, Math.max(1, ts - letzteZeit)) : 16;
      letzteZeit = ts;
      // Rückstand holt sich selbst auf: je mehr wartet, desto schneller (kein ewiges Hinterherlaufen)
      const rate = basisRate + rueckstand() * 1.6;
      uebertrag += (rate * dt) / 1000;
      let n = Math.floor(uebertrag);
      uebertrag -= n;
      stats.tokenSchritte++;
      while (queue.length) {
        const h = queue[0];
        if (h.fn) {
          queue.shift();
          h.fn();
          continue;
        }
        if (n <= 0) break;
        const teil = h.s.slice(0, n);
        h.s = h.s.slice(n);
        n -= teil.length;
        if (!h.s) queue.shift();
        textSchreiben(teil);
      }
      if (queue.length) rafId = raf(tick);
      else letzteZeit = 0;
    }
    function flush() {
      if (rafId != null) {
        caf(rafId);
        rafId = null;
      }
      while (queue.length) lauf(queue.shift());
      letzteZeit = 0;
      uebertrag = 0;
    }

    // --- Bausteine -----------------------------------------------------------
    function teil(e) {
      if (!turn) startTurnDom({});
      e.classList.add('ein');
      turn.appendChild(e);
      folge.follow();
      return e;
    }
    function schliesseText() {
      if (seg) {
        seg.md.end();
        ansage.textEnde();
        seg = null;
      }
    }
    function textSchreiben(s) {
      if (!seg) {
        if (denken && !denken.fertig) endThinkingDom();
        gruppe = null;
        const e = el('div', 'text md');
        teil(e);
        seg = { el: e, md: FP.createMarkdownStream(e) };
      }
      seg.md.write(s);
      stats.textZeichen += s.length;
      ansage.textHin(s);
      folge.follow();
    }
    function aufklappKnopf(kopf, wrapper, offen) {
      const id = uid('auf');
      const inhalt = wrapper.querySelector('.aufklapp-innen');
      inhalt.id = id;
      kopf.setAttribute('aria-controls', id);
      const setze = (o) => {
        wrapper.classList.toggle('offen', o);
        kopf.setAttribute('aria-expanded', o ? 'true' : 'false');
      };
      setze(!!offen);
      kopf.addEventListener('click', () => {
        setze(!wrapper.classList.contains('offen'));
        folge.follow();
      });
      return setze;
    }
    function aufklapp(inner) {
      const w = el('div', 'aufklapp');
      const i = el('div', 'aufklapp-innen');
      i.appendChild(inner);
      w.appendChild(i);
      return w;
    }

    // --- Nutzer --------------------------------------------------------------
    function addUserMessage(m) {
      flush();
      schliesseText();
      const wrap = el('div', 'mensch ein');
      const blase = el('div', 'blase');
      const text = String(m.text == null ? '' : m.text);
      const re = /(^|\s)(@[\w./-]+)/g;
      let l = 0;
      let x;
      while ((x = re.exec(text))) {
        const start = x.index + x[1].length;
        if (start > l) blase.appendChild(doc.createTextNode(text.slice(l, start)));
        blase.appendChild(el('span', 'erwaehnung', x[2]));
        l = start + x[2].length;
      }
      if (l < text.length) blase.appendChild(doc.createTextNode(text.slice(l)));
      wrap.appendChild(blase);
      const hinweis = el('div', 'mensch-hinweis', 'wird nach dem Zug gesendet');
      hinweis.hidden = !m.queued;
      if (m.queued) wrap.classList.add('eingereiht');
      wrap.appendChild(hinweis);
      spalte.appendChild(wrap);
      turn = null;
      folge.zumEnde();
      ansage.sage(`Du: ${kurz(text, 160)}`);
      return {
        el: wrap,
        gesendet() {
          wrap.classList.remove('eingereiht');
          hinweis.hidden = true;
        },
        entfernen() {
          wrap.remove();
        },
      };
    }

    // --- Zug -----------------------------------------------------------------
    function startTurnDom(m) {
      schliesseText();
      turn = el('article', 'zug ein');
      turn.setAttribute('aria-label', `Antwort von ${anzeigename()}`);
      const kopf = el('div', 'zug-kopf');
      kopf.append(el('span', 'avatar', anzeigename().charAt(0).toUpperCase()), el('span', 'name', m.name || anzeigename()), el('span', 'modell', m.modell || ''));
      turn.appendChild(kopf);
      spalte.appendChild(turn);
      turnStart = now();
      turnSchritte = 0;
      busy = true;
      gruppe = null;
      folge.follow();
      ansage.sage(`${anzeigename()} antwortet`);
      melde();
      return turn;
    }
    function startTurn(m) {
      enqueue({ fn: () => startTurnDom(m || {}) });
    }

    // --- Denken --------------------------------------------------------------
    function startThinkingDom(t0) {
      schliesseText();
      gruppe = null;
      const sec = el('section', 'denken');
      sec.dataset.zustand = 'laeuft';
      const kopf = el('button', 'denken-kopf');
      kopf.type = 'button';
      const label = el('span', 'label schimmer', 'Denkt …');
      const zeit = el('span', 'zeit', '0 s');
      const chev = el('span', 'chev');
      chev.innerHTML = ICON.chev;
      kopf.append(label, zeit, chev);
      const body = el('div', 'denken-text');
      const textKnoten = doc.createTextNode('');
      body.appendChild(textKnoten);
      const auf = aufklapp(body);
      sec.append(kopf, auf);
      aufklappKnopf(kopf, auf, false);
      teil(sec);
      const d = { sec, label, zeit, textKnoten, start: t0 == null ? now() : t0, fertig: false, iv: null };
      d.iv = setIv(() => {
        zeit.textContent = dauerText(now() - d.start);
      }, 1000);
      alleTimer.add(d.iv);
      denken = d;
      ansage.sage(`${anzeigename()} denkt`);
      melde();
    }
    function endThinkingDom(t1) {
      const d = denken;
      if (!d || d.fertig) return;
      d.fertig = true;
      clearIv(d.iv);
      alleTimer.delete(d.iv);
      const ms = (t1 == null ? now() : t1) - d.start;
      d.sec.dataset.zustand = 'fertig';
      d.label.classList.remove('schimmer');
      d.label.textContent = `Gedacht für ${dauerText(ms)}`;
      d.zeit.textContent = '';
      if (!d.textKnoten.data) d.textKnoten.data = 'Keine Einzelheiten aufgezeichnet.';
      melde();
    }
    function startThinking() {
      { const t = now(); enqueue({ fn: () => startThinkingDom(t) }); }
    }
    function appendThinking(s) {
      enqueue({
        fn: () => {
          if (!denken || denken.fertig) startThinkingDom();
          denken.textKnoten.data += s;
          folge.follow();
        },
      });
    }
    function endThinking() {
      { const t = now(); enqueue({ fn: () => endThinkingDom(t) }); }
    }

    // --- Text ----------------------------------------------------------------
    function appendText(s) {
      if (!s) return;
      enqueue({ s: String(s) });
    }

    // --- Werkzeuge -----------------------------------------------------------
    /** `ansi`: Terminal-Ausgabe (Bash): Farbfolgen werden zu Klassen `an-*`, andere Steuerfolgen verschwinden. */
    function erzeugeAusgabe(maxZeilen, ansi) {
      const wrap = el('div', ansi ? 'ausgabe terminal-ausgabe' : 'ausgabe');
      const pre = el('pre', 'ausgabe-pre');
      const kopfzeilen = el('span', 'kopfzeilen');
      const rest = el('span', 'rest');
      rest.hidden = true;
      pre.append(kopfzeilen, rest);
      const mehr = el('button', 'mehr');
      mehr.type = 'button';
      mehr.hidden = true;
      wrap.append(pre, mehr);
      let zeile = 0;
      let ziel = kopfzeilen;
      const leser = ansi && FP.ansiLeser ? FP.ansiLeser() : null;
      let schwanz = doc.createTextNode('');
      let zeileHatInhalt = false;
      kopfzeilen.appendChild(schwanz);
      // Beschriftetes Stück (Terminal-Farbe) an die aktuelle Zeile hängen; ohne Klasse läuft es im gemeinsamen Textknoten weiter
      const stueck = (t, klasse) => {
        if (!t) return;
        zeileHatInhalt = true;
        if (!klasse) {
          schwanz.data += t;
          return;
        }
        const s = el('span', klasse, t);
        ziel.appendChild(s);
        schwanz = doc.createTextNode('');
        ziel.appendChild(schwanz);
      };
      const neueZeile = () => {
        schwanz.data += '\n';
        zeile++;
        zeileHatInhalt = false;
        ziel = zeile >= maxZeilen ? rest : kopfzeilen;
        schwanz = doc.createTextNode('');
        ziel.appendChild(schwanz);
      };
      let restZeilen = 0;
      const aktualisiere = () => {
        const offen = !rest.hidden;
        mehr.hidden = restZeilen === 0;
        mehr.textContent = offen ? 'Weniger anzeigen' : `${restZeilen} weitere Zeile${restZeilen === 1 ? '' : 'n'}`;
        mehr.setAttribute('aria-expanded', offen ? 'true' : 'false');
      };
      mehr.addEventListener('click', () => {
        rest.hidden = !rest.hidden;
        wrap.classList.toggle('lang', !rest.hidden);
        aktualisiere();
        folge.follow();
      });
      return {
        el: wrap,
        get leer() {
          return zeile === 0 && !pre.textContent;
        },
        append(text) {
          text = String(text);
          const teile = leser ? leser.schreibe(FP.wagenruecklauf ? FP.wagenruecklauf(text) : text) : [{ text, klasse: '' }];
          for (const t of teile) {
            const zeilen = t.text.split('\n');
            for (let i = 0; i < zeilen.length; i++) {
              stueck(zeilen[i], t.klasse);
              if (i < zeilen.length - 1) neueZeile();
            }
          }
          restZeilen = Math.max(0, zeile + (zeileHatInhalt ? 1 : 0) - maxZeilen);
          aktualisiere();
        },
        setze(text) {
          // nur für Ereignisse, die die Ausgabe ersetzen ("set"): Neuaufbau der Ausgabe dieser Karte, nicht des Chats
          kopfzeilen.textContent = '';
          rest.textContent = '';
          zeile = 0;
          zeileHatInhalt = false;
          ziel = kopfzeilen;
          if (leser) leser.zuruecksetzen();
          schwanz = doc.createTextNode('');
          kopfzeilen.appendChild(schwanz);
          this.append(text);
        },
      };
    }
    function eingabeText(name, args) {
      const n = String(name || '').toLowerCase();
      if (n === 'bash') return `$ ${ersterWert(args, ['command', 'befehl'])}`;
      if (n === 'read' || n === 'ls' || n === 'write') return ersterWert(args, ['path', 'file_path', 'pfad']);
      if (n === 'grep') return `${ersterWert(args, ['pattern', 'suche'])}   ${ersterWert(args, ['path', 'pfad'])}`.trim();
      try {
        return JSON.stringify(args, null, 2);
      } catch (e) {
        return String(args);
      }
    }

    function erzeugeDiff(diff) {
      const z = diffZahlen(diff);
      const wrap = el('div', 'diff');
      const kopf = el('div', 'diff-kopf');
      kopf.append(el('span', 'datei', diff.datei || 'Datei'), diffChips(z));
      const tab = el('table', 'diff-tabelle');
      tab.setAttribute('aria-label', `Änderungen in ${diff.datei || 'Datei'}: ${z.plus} hinzugefügt, ${z.minus} entfernt`);
      const tb = el('tbody');
      const lang = sprachVonDatei(diff.datei);
      let letzteAltEnde = null;
      let hunkNr = 0;
      for (const h of diff.hunks || []) {
        let a = h.alt;
        let b = h.neu;
        if (letzteAltEnde != null && a != null && a > letzteAltEnde) {
          const tr = el('tr', 'trenn');
          const td = el('td', null, `${a - letzteAltEnde} unveränderte Zeilen`);
          td.colSpan = 4;
          tr.appendChild(td);
          tb.appendChild(tr);
        } else if (hunkNr > 0 && a == null) {
          // Änderungen ohne bekannte Zeilennummern (aus der Werkzeugeingabe abgeleitet): getrennte Stellen sichtbar trennen
          const tr = el('tr', 'trenn');
          const td = el('td', null, `Änderung ${hunkNr + 1}`);
          td.colSpan = 4;
          tr.appendChild(td);
          tb.appendChild(tr);
        }
        hunkNr++;
        for (const [t, text] of h.zeilen) {
          const tr = el('tr', t === '+' ? 'add' : t === '-' ? 'del' : 'ctx');
          const nrA = el('td', 'nr', t === '+' || a == null ? '' : String(a));
          const nrB = el('td', 'nr', t === '-' || b == null ? '' : String(b));
          const vz = el('td', 'vz', t === ' ' ? '' : t === '+' ? '+' : '−');
          vz.setAttribute('aria-label', t === '+' ? 'hinzugefügt' : t === '-' ? 'entfernt' : 'unverändert');
          const code = el('td', 'code');
          FP.haengeZeile(doc, code, text, lang);
          tr.append(nrA, nrB, vz, code);
          tb.appendChild(tr);
          if (t !== '+' && a != null) a++;
          if (t !== '-' && b != null) b++;
        }
        letzteAltEnde = a;
      }
      tab.appendChild(tb);
      const scrollbox = el('div', 'diff-scroll');
      scrollbox.tabIndex = 0;
      scrollbox.setAttribute('role', 'region');
      scrollbox.setAttribute('aria-label', `Diff ${diff.datei || ''}`);
      scrollbox.appendChild(tab);
      wrap.append(kopf, scrollbox);
      return wrap;
    }
    function diffChips(z) {
      const c = el('span', 'diffzahl');
      c.append(el('span', 'plus', `+${z.plus}`), doc.createTextNode(' '), el('span', 'minus', `−${z.minus}`));
      return c;
    }

    function gruppeSicher() {
      if (gruppe) return gruppe;
      const g = el('section', 'gruppe');
      g.dataset.zustand = 'fertig';
      const kopf = el('button', 'gruppe-kopf');
      kopf.type = 'button';
      const label = el('span', 'label');
      const detail = el('span', 'kurzfassung');
      const meta = el('span', 'meta');
      const dauer = el('span', 'dauer');
      meta.appendChild(dauer);
      const chev = el('span', 'chev');
      chev.innerHTML = ICON.chev;
      kopf.append(svg('lesen'), label, detail, meta, chev);
      const liste = el('div', 'gruppe-liste');
      const auf = aufklapp(liste);
      g.append(kopf, auf);
      aufklappKnopf(kopf, auf, false);
      teil(g);
      gruppe = { el: g, liste, label, detail, dauer, lesen: 0, suchen: 0, andere: 0, ms: 0, laufend: 0 };
      return gruppe;
    }
    function gruppeAktualisiere(g) {
      const t = [];
      if (g.lesen) t.push(g.lesen === 1 ? '1 Datei gelesen' : `${g.lesen} Dateien gelesen`);
      if (g.suchen) t.push(g.suchen === 1 ? '1 Suche' : `${g.suchen} Suchen`);
      g.label.textContent = t.join(' · ') || 'Werkzeuge';
      g.el.dataset.zustand = g.laufend > 0 ? 'laeuft' : 'fertig';
      g.dauer.textContent = g.laufend > 0 ? '' : dauerKurz(g.ms);
    }

    function startToolDom(m, t0) {
      if (denken && !denken.fertig) endThinkingDom();
      schliesseText();
      const { art, label } = artVon(m.name);
      const grp = art === 'lesen' || art === 'suchen';
      if (!grp) gruppe = null;
      stats.tools++;
      turnSchritte++;
      const card = el('div', 'karte');
      card.dataset.zustand = 'laeuft';
      card.dataset.art = art;
      const kopf = el('button', 'karte-kopf');
      kopf.type = 'button';
      const sr = el('span', 'sr', 'läuft');
      const kf = el('span', 'kurzfassung', kurzfassung(m.name, m.args) || m.titel || '');
      const meta = el('span', 'meta');
      const chips = el('span', 'diffchips');
      const dauer = el('span', 'dauer', '');
      meta.append(chips, dauer);
      const chev = el('span', 'chev');
      chev.innerHTML = ICON.chev;
      kopf.append(svg(art), el('span', 'werkzeug', label), kf, meta, sr, chev);
      const body = el('div', 'karte-koerper');
      const eingabe = el('pre', art === 'bash' ? 'eingabe terminal-befehl' : 'eingabe', eingabeText(m.name, m.args));
      eingabe.hidden = !eingabe.textContent.trim() || art === 'edit';
      const ausgabe = erzeugeAusgabe(art === 'bash' ? 12 : 6, art === 'bash');
      ausgabe.el.hidden = true;
      if (art === 'bash') {
        // Terminal-Ansicht: Titelleiste, Befehl mit Eingabezeichen, Ausgabe in Monospace mit Terminalfarben
        const term = el('div', 'terminal');
        term.setAttribute('role', 'group');
        term.setAttribute('aria-label', 'Terminal');
        const leiste = el('div', 'terminal-leiste');
        leiste.append(el('span', 'terminal-titel', 'Terminal'));
        term.append(leiste, eingabe, ausgabe.el);
        body.appendChild(term);
      } else {
        body.appendChild(eingabe);
        body.appendChild(ausgabe.el);
      }
      const diffHalter = el('div', 'diff-halter');
      body.appendChild(diffHalter);
      const auf = aufklapp(body);
      card.append(kopf, auf);
      const setze = aufklappKnopf(kopf, auf, art === 'bash');
      const t = {
        id: m.id,
        card,
        art,
        name: m.name,
        status: 'laeuft',
        start: t0 == null ? now() : t0,
        dauer,
        sr,
        chips,
        ausgabe,
        diffHalter,
        setze,
        kf,
        grp: null,
      };
      if (grp) {
        const g = gruppeSicher();
        g.liste.appendChild(card);
        g.laufend++;
        if (art === 'lesen') g.lesen++;
        else g.suchen++;
        g.detail.textContent = kurzfassung(m.name, m.args);
        g.el.dataset.zustand = 'laeuft';
        gruppeAktualisiere(g);
        t.grp = g;
        folge.follow();
      } else teil(card);
      tools.set(m.id, t);
      ansage.sage(`${label} gestartet: ${kurz(kurzfassung(m.name, m.args), 80)}`);
      melde();
    }
    function startTool(m) {
      { const t = now(); enqueue({ fn: () => startToolDom(m, t) }); }
    }
    /** `output`: Text anhängen. Mit `{ set: '…' }` ersetzen, mit `{ args }` die Eingabe nachreichen. */
    function updateTool(id, u) {
      enqueue({
        fn: () => {
          const t = tools.get(id);
          if (!t) return;
          if (u.args) {
            t.kf.textContent = kurzfassung(t.name, u.args);
            const e = t.card.querySelector('.eingabe');
            if (e && t.art !== 'edit') {
              e.textContent = eingabeText(t.name, u.args);
              e.hidden = !e.textContent.trim();
            }
          }
          if (typeof u.set === 'string') {
            t.ausgabe.el.hidden = false;
            t.ausgabe.setze(u.set);
          }
          if (typeof u.append === 'string' && u.append) {
            t.ausgabe.el.hidden = false;
            t.ausgabe.append(u.append);
          }
          folge.follow();
        },
      });
    }
    function endToolDom(id, r, t1) {
      const t = tools.get(id);
      if (!t || t.status !== 'laeuft') return;
      r = r || {};
      const status = r.status === 'fehler' ? 'fehler' : r.status === 'abgebrochen' ? 'abgebrochen' : 'fertig';
      t.status = status;
      const ms = r.dauerMs != null ? r.dauerMs : (t1 == null ? now() : t1) - t.start;
      t.card.dataset.zustand = status;
      t.sr.textContent = status === 'fertig' ? 'fertig' : status === 'fehler' ? 'Fehler' : 'abgebrochen';
      t.dauer.textContent = dauerKurz(ms);
      if (typeof r.output === 'string' && t.ausgabe.leer) {
        t.ausgabe.el.hidden = !r.output;
        if (r.output) t.ausgabe.append(r.output);
      }
      if (r.diff) {
        t.diffHalter.appendChild(erzeugeDiff(r.diff));
        const z = diffZahlen(r.diff);
        t.chips.appendChild(diffChips(z));
        t.setze(true);
        t.kf.textContent = r.diff.datei || t.kf.textContent;
      }
      if (t.grp) {
        t.grp.laufend = Math.max(0, t.grp.laufend - 1);
        t.grp.ms += ms;
        gruppeAktualisiere(t.grp);
      }
      ansage.sage(status === 'fehler' ? `${artVon(t.name).label} fehlgeschlagen` : `${artVon(t.name).label} fertig`);
      folge.follow();
      melde();
    }
    function endTool(id, r) {
      { const t = now(); enqueue({ fn: () => endToolDom(id, r, t) }); }
    }

    // --- Freigaben -----------------------------------------------------------
    const RISIKO = { low: 'geringes Risiko', medium: 'mittleres Risiko', high: 'hohes Risiko' };
    function askApproval(m) {
      let loese;
      const versprechen = new Promise((r) => (loese = r));
      enqueue({
        fn: () => {
          if (denken && !denken.fertig) endThinkingDom();
          schliesseText();
          gruppe = null;
          const risiko = RISIKO[m.risiko] ? m.risiko : 'medium';
          const box = el('section', 'freigabe');
          box.setAttribute('role', 'group');
          box.setAttribute('aria-label', 'Freigabe erbeten');
          box.dataset.zustand = 'offen';
          box.dataset.risiko = risiko;
          const kopf = el('div', 'fz-kopf');
          const frage = el('div', 'fz-frage');
          frage.append(doc.createTextNode(`${anzeigename()} will: `), el('strong', null, m.aktion), m.ziel ? doc.createTextNode(' ') : doc.createTextNode(''));
          if (m.ziel) frage.appendChild(el('code', 'inline', m.ziel));
          const chip = el('span', 'chip risiko', RISIKO[risiko]);
          kopf.append(frage, chip);
          const ktx = el('div', 'fz-kontext', m.kontext || '');
          ktx.hidden = !m.kontext;
          const knoepfe = el('div', 'fz-knoepfe');
          // Je Aktion eine eigene Freigabe: nur Erlauben oder Ablehnen (mit optionaler Notiz), keine Pauschalmodi
          const notiz = el('input', 'fz-notiz');
          notiz.type = 'text';
          notiz.placeholder = 'Notiz (optional)';
          notiz.setAttribute('aria-label', 'Notiz zur Entscheidung (optional)');
          notiz.maxLength = 400;
          notiz.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') {
              ev.preventDefault();
              entscheide(m.id, 'erlauben', false, notiz.value);
            } else if (ev.key === 'Escape') {
              ev.preventDefault();
              ev.stopPropagation();
              entscheide(m.id, 'ablehnen', false, notiz.value);
            }
          });
          const mk = (text, taste, cls, wert) => {
            const b = el('button', cls);
            b.type = 'button';
            b.setAttribute('aria-keyshortcuts', taste);
            b.append(doc.createTextNode(text + ' '), el('kbd', null, taste));
            b.addEventListener('click', () => entscheide(m.id, wert, false, notiz.value));
            return b;
          };
          const b1 = mk('Erlauben', '1', 'primaer', 'erlauben');
          const b3 = mk('Ablehnen', '2', 'gefahr', 'ablehnen');
          knoepfe.append(b1, b3, notiz);
          const b2 = notiz;
          const aktionen = aufklapp(knoepfe);
          aktionen.classList.add('offen', 'fz-aktionen');
          const ergebnis = el('div', 'fz-ergebnis');
          box.append(kopf, ktx, aktionen, ergebnis);
          const f = { id: m.id, box, aktionen, ergebnis, loese, offen: true, aktion: m.aktion, buttons: [b1, b2, b3] };
          teil(box);
          freigaben.set(m.id, f);
          ansage.sage(`Freigabe erbeten: ${m.aktion}${m.ziel ? ' ' + m.ziel : ''}. ${RISIKO[risiko]}. Taste 1 erlauben, 2 ablehnen.`);
          if (!opts.darfFokus || opts.darfFokus()) {
            try {
              b1.focus({ preventScroll: true });
            } catch (e) {
              /* kein Fokus möglich */
            }
          }
          melde();
        },
      });
      return versprechen;
    }
    function entscheide(id, wert, extern, notiz) {
      const f = freigaben.get(id);
      if (!f || !f.offen) return false;
      f.offen = false;
      const ok = wert === 'erlauben';
      const n = String(notiz || '').trim();
      f.box.dataset.zustand = ok ? 'erlaubt' : 'abgelehnt';
      f.aktionen.classList.remove('offen');
      f.ergebnis.textContent = `${ok ? 'Erlaubt' : 'Abgelehnt'}: ${f.aktion}${n ? ` · ${n}` : ''}`;
      ansage.sage(f.ergebnis.textContent);
      f.loese({ wert, notiz: n });
      if (opts.onEntscheidung && !extern) opts.onEntscheidung(id, wert, n);
      folge.follow();
      melde();
      return true;
    }
    /** Hinweiszeile für automatisch Erlaubtes (statt einer Leiste). */
    function addNote(text, art) {
      enqueue({
        fn: () => {
          schliesseText();
          gruppe = null;
          teil(el('div', `notiz ${art || ''}`.trim(), text));
        },
      });
    }
    function offeneFreigabe() {
      for (const f of freigaben.values()) if (f.offen) return f;
      return null;
    }
    function handleKey(e) {
      const f = offeneFreigabe();
      if (!f || e.metaKey || e.ctrlKey || e.altKey) return false;
      const k = String(e.key).toLowerCase();
      const wert = k === '1' || k === 'y' ? 'erlauben' : k === '2' || k === 'n' || k === 'escape' ? 'ablehnen' : null;
      if (!wert) return false;
      if (e.preventDefault) e.preventDefault();
      entscheide(f.id, wert);
      return true;
    }

    // --- Marker --------------------------------------------------------------
    function addMarker(m) {
      enqueue({
        fn: () => {
          schliesseText();
          gruppe = null;
          turn = null;
          let text = m.text;
          let titel = '';
          if (m.kind === 'pi.reset') {
            text = text || 'Neuer Kontext begonnen';
            titel = 'Das Modell sieht den Verlauf darüber nicht mehr.';
          } else if (m.kind === 'pi.compaction') {
            text = text || (m.von != null && m.nach != null ? `Kontext verdichtet: ${zahlK(m.von)} → ${zahlK(m.nach)}` : 'Verlauf verdichtet');
            titel = 'Das Modell sieht ab hier die Zusammenfassung und das Folgende.';
          } else if (m.kind === 'abzweig') titel = 'Neues Gespräch ab dieser Stelle.';
          const mk = el('div', `marker ein`);
          mk.dataset.kind = m.kind || 'info';
          mk.setAttribute('role', 'note');
          if (titel) mk.title = titel;
          mk.append(el('span', 'linie'), el('span', 'marker-text', text || ''), el('span', 'linie'));
          spalte.appendChild(mk);
          folge.follow();
          ansage.sage(text);
        },
      });
    }

    // --- Ende ----------------------------------------------------------------
    function endTurn(r) {
      r = r || {};
      enqueue({
        fn: () => {
          if (!turn && !r.stopped) {
            busy = false;
            melde();
            return;
          }
          if (denken && !denken.fertig) endThinkingDom();
          schliesseText();
          for (const t of tools.values()) if (t.status === 'laeuft') endToolDom(t.id, { status: 'abgebrochen' });
          // Eine offene Freigabe überlebt das Ende des Zugs (der Runner beendet den Zug nach der Bitte). Nur bei Stopp (Esc) in der Demo wird abgelehnt.
          if (r.stopped) for (const f of freigaben.values()) if (f.offen) entscheide(f.id, 'ablehnen');
          gruppe = null;
          const ms = now() - turnStart;
          if (turn) {
            const text = r.stopped ? `Unterbrochen nach ${dauerText(ms)}` : `Fertig in ${dauerText(ms)}${turnSchritte ? ` · ${turnSchritte} ${turnSchritte === 1 ? 'Schritt' : 'Schritte'}` : ''}`;
            teil(el('div', 'zugfuss', text));
            ansage.sage(text);
          }
          turn = null;
          busy = false;
          melde();
        },
      });
    }

    function clear() {
      flush();
      for (const id of alleTimer) clearIv(id);
      alleTimer.clear();
      spalte.textContent = '';
      turn = seg = denken = gruppe = null;
      tools.clear();
      freigaben.clear();
      busy = false;
      melde();
    }

    return {
      addUserMessage,
      startTurn,
      startThinking,
      appendThinking,
      endThinking,
      appendText,
      startTool,
      updateTool,
      endTool,
      askApproval,
      resolveApproval: (id, wert, notiz) => enqueue({ fn: () => entscheide(id, wert, true, notiz) }),
      addNote,
      addMarker,
      endTurn,
      handleKey,
      flush,
      clear,
      zustand,
      stats,
      folge,
      ansage,
      get busy() {
        return busy;
      },
      get offeneFreigabe() {
        return offeneFreigabe();
      },
      get spalte() {
        return spalte;
      },
    };
  }

  Object.assign(FP, { createChatView, createScrollFollower, createAnsager, diffZeilen, diffZahlen, dauerText, dauerKurz, kurz, zahlK, artVon, kurzfassung });
})(typeof globalThis !== 'undefined' ? globalThis : window);
