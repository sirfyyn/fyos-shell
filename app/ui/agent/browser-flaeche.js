/* Browser-Fläche rechts neben dem Gespräch: der Browser, den der Agent bedient, als Bild der Seite zum Mitsehen und Mitbedienen.
 *
 * Der Runner hält den Browser; die Seite hier zeigt sein Bild (GET /api/browser/bild über runner-wege.js) und schickt, was der Mensch tut
 * (POST /api/browser/aktion: Adresse öffnen, zurück, vor, neu laden, Klick, Rad, Text, Taste, beenden). Kennt der Runner den Weg nicht,
 * bleibt der Knopf im Kopf weg. Alles, was vom Runner kommt, wird nur als Text oder als Bild (JPEG/PNG) eingesetzt.
 *
 *   createBrowserFlaeche(els, opts) → { pruefe(), zeige(offen), beiWerkzeug({ name }), offen, stand() }
 *   els:  wurzel, knopf, zu (optional), form, ziel (Feld für die Adresse der Seite), zurueck, vor, neu, beenden, buehne, bild, hinweis, lage
 *   opts: transport, wege, gespraech() → Kennung der sichtbaren Sitzung, beiOffen(offen), sichtbar() → ist die Fläche zu sehen,
 *         verdeckt() → liegt sie hinter einer anderen Fläche, nachVorn() (der Knopf im Kopf holt sie dann nach vorn, statt sie zu schließen),
 *         setInterval, clearInterval (für Tests), taktMs
 *
 * In der Seite liegt sie als Reiter im Bereich der Flächen (flaechen.js): der Bereich zeigt und versteckt ihren Teil, sie selbst weiß nur,
 * ob sie offen ist.
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  /** Tasten, die als Taste (nicht als Text) an die Seite gehen: Name im Browser → Name beim Runner. */
  const TASTEN = {
    Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  };

  /**
   * Punkt im Bild → Punkt in der Seite. `r`: Rechteck des Bildes im Fenster ({ left, top, width, height }); `breite`, `hoehe`: Größe der Seite
   * beim Runner. Außerhalb des Bildes: null.
   */
  function seitenPunkt(clientX, clientY, r, breite, hoehe) {
    if (!r || !(r.width > 0) || !(r.height > 0)) return null;
    const x = ((clientX - r.left) / r.width) * breite;
    const y = ((clientY - r.top) / r.height) * hoehe;
    if (x < 0 || y < 0 || x > breite || y > hoehe) return null;
    return { x: Math.round(x), y: Math.round(y) };
  }

  /** Was in der Zeile unter dem Kopf steht: wo der Browser gerade ist oder warum nichts zu sehen ist. */
  function lageText(s, beschaeftigt) {
    if (!s) return 'Browser wird geprüft …';
    if (!s.verfuegbar) return 'Kein Browser';
    if (beschaeftigt) return 'lädt …';
    if (!s.laeuft) return 'nicht gestartet';
    return s.titel || s.url || 'leere Seite';
  }

  function createBrowserFlaeche(els, opts) {
    opts = opts || {};
    const wege = opts.wege;
    const transport = opts.transport;
    const setIv = opts.setInterval || ((f, ms) => G.setInterval(f, ms));
    const clearIv = opts.clearInterval || ((id) => G.clearInterval(id));
    const sichtbar = opts.sichtbar || (() => true);
    const taktMs = opts.taktMs || 1500;

    let kennt = false; // bietet der Runner die Browser-Fläche an?
    let offen = false;
    let stand = null; // letzter Stand vom Runner (bereinigt)
    let kenn = ''; // Kennung des gezeigten Bildes
    let beschaeftigt = 0; // laufende Aktionen des Menschen
    let takt = null;
    let laeuftAbfrage = false;
    let radRest = 0;
    let radTimer = null;
    let textRest = '';
    let textTimer = null;

    function zeichne(fehler) {
      const s = stand;
      els.knopf.hidden = !kennt;
      els.knopf.setAttribute('aria-expanded', offen ? 'true' : 'false');
      els.wurzel.hidden = !offen || !kennt;
      els.lage.textContent = lageText(s, beschaeftigt > 0);
      const da = !!(s && s.verfuegbar);
      for (const k of [els.ziel, els.zurueck, els.vor, els.neu]) k.disabled = !da;
      els.zurueck.disabled = els.vor.disabled = els.neu.disabled = !(da && s.laeuft);
      els.beenden.hidden = !(da && s.laeuft);
      // die Adresse folgt der Seite, solange der Mensch nicht gerade darin tippt
      if (s && s.laeuft && els.ziel !== els.ziel.ownerDocument.activeElement) els.ziel.value = s.url || '';
      const zeigtBild = !!(da && s.laeuft && els.bild.getAttribute('src'));
      els.bild.hidden = !zeigtBild;
      els.buehne.dataset.zustand = !s ? 'laedt' : !s.verfuegbar ? 'fehlt' : s.laeuft ? 'laeuft' : 'ruht';
      let hinweis = '';
      if (fehler) hinweis = fehler;
      else if (s && !s.verfuegbar) hinweis = s.grund || 'Auf diesem Rechner gibt es keinen Browser, den der Agent benutzen kann.';
      else if (s && !s.laeuft) hinweis = 'Der Browser startet, sobald du oder der Agent eine Seite öffnet. Gib oben eine Adresse ein, zum Beispiel localhost:5173 oder eine Datei im Ordner der Sitzung.';
      els.hinweis.textContent = hinweis;
      els.hinweis.hidden = !hinweis;
      els.hinweis.classList.toggle('fehler', !!fehler);
    }

    /** Stand und Bild aus einer Antwort des Runners übernehmen. */
    function nimm(s) {
      stand = { verfuegbar: s.verfuegbar, laeuft: s.laeuft, grund: s.grund, url: s.url, titel: s.titel, breite: s.breite, hoehe: s.hoehe };
      if (!s.laeuft) {
        kenn = '';
        els.bild.removeAttribute('src');
      } else if (s.bild && !s.unveraendert) {
        kenn = s.kenn;
        els.bild.src = `data:${s.typ};base64,${s.bild}`;
        els.bild.alt = s.titel ? `Seite im Browser: ${s.titel}` : 'Seite im Browser';
      }
    }

    function meldung(f) {
      const d = f && f.meldung && typeof f.meldung.details === 'string' ? f.meldung.details.replace(/^HTTP \d{3}:\s*/, '') : '';
      return String(d || (f && (f.fehler || f.message)) || f || 'Das ging nicht.').slice(0, 300);
    }

    /** Fragt, ob der Runner eine Browser-Fläche anbietet, und holt den Stand. Ohne den Weg bleibt der Knopf weg. */
    async function pruefe() {
      try {
        const s = await wege.browser();
        kennt = true;
        nimm(s);
        zeichne();
        if (offen) void auffrischen();
      } catch (f) {
        // ein Runner ohne den Weg hat keine Browser-Fläche; bei einem Netzfehler bleibt, was war
        if (f && f.art === 'weg_fehlt') {
          kennt = false;
          zeige(false);
        }
        zeichne();
      }
      return kennt;
    }

    /** Das Bild nachziehen (nur, wenn der Browser läuft und die Fläche zu sehen ist). */
    async function auffrischen() {
      if (!kennt || !offen || laeuftAbfrage) return;
      laeuftAbfrage = true;
      try {
        nimm(await wege.browserBild(kenn));
        zeichne();
      } catch (f) {
        if (f && f.art === 'weg_fehlt') kennt = false;
        zeichne();
      } finally {
        laeuftAbfrage = false;
      }
    }

    /** Eine Bedienung des Menschen an den Runner schicken; die Antwort trägt den neuen Stand und das Bild. */
    async function aktion(koerper) {
      if (!kennt) return false;
      beschaeftigt += 1;
      zeichne();
      let fehler = '';
      try {
        const g = opts.gespraech ? opts.gespraech() : null;
        const r = await transport.api('POST', '/api/browser/aktion', g === null || g === undefined ? koerper : { ...koerper, gespraech: g });
        nimm(FP.wege.browserBereinigen(r));
      } catch (f) {
        fehler = meldung(f);
      } finally {
        beschaeftigt -= 1;
      }
      zeichne(fehler);
      return !fehler;
    }

    function taktAn() {
      if (takt !== null) return;
      takt = setIv(() => {
        if (offen && stand && stand.laeuft && beschaeftigt === 0 && sichtbar()) void auffrischen();
      }, taktMs);
    }
    function taktAus() {
      if (takt === null) return;
      clearIv(takt);
      takt = null;
    }

    function zeige(an) {
      const neu = !!an && kennt;
      if (neu === offen) {
        zeichne();
        return;
      }
      offen = neu;
      if (offen) {
        taktAn();
        void pruefe();
      } else taktAus();
      zeichne();
      if (opts.beiOffen) opts.beiOffen(offen);
    }

    /** Ein Werkzeug der sichtbaren Sitzung ist zu Ende: hat der Agent den Browser bedient, geht die Fläche auf und zieht nach. */
    function beiWerkzeug(w) {
      if (!w || w.name !== 'browser' || !kennt) return;
      if (!offen) zeige(true);
      else void pruefe();
    }

    // --- Bedienung ---
    els.knopf.addEventListener('click', () => {
      // offen, aber hinter einer anderen Fläche: nach vorn holen statt schließen
      if (offen && opts.verdeckt && opts.verdeckt()) {
        if (opts.nachVorn) opts.nachVorn();
        return;
      }
      zeige(!offen);
    });
    if (els.zu) els.zu.addEventListener('click', () => zeige(false));
    els.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const url = els.ziel.value.trim();
      if (!url) return;
      els.ziel.blur();
      void aktion({ aktion: 'oeffnen', url: url.slice(0, 2000) });
    });
    els.zurueck.addEventListener('click', () => void aktion({ aktion: 'zurueck' }));
    els.vor.addEventListener('click', () => void aktion({ aktion: 'vor' }));
    els.neu.addEventListener('click', () => void aktion({ aktion: 'neu' }));
    els.beenden.addEventListener('click', () => void aktion({ aktion: 'schliessen' }));

    // Klick ins Bild: an derselben Stelle der Seite
    els.bild.addEventListener('click', (e) => {
      if (!stand || !stand.laeuft) return;
      const p = seitenPunkt(e.clientX, e.clientY, els.bild.getBoundingClientRect(), stand.breite, stand.hoehe);
      els.buehne.focus({ preventScroll: true });
      if (p) void aktion({ aktion: 'klick', x: p.x, y: p.y });
    });
    // Rad: gesammelt, damit nicht jede Raste eine eigene Anfrage wird
    els.buehne.addEventListener(
      'wheel',
      (e) => {
        if (!stand || !stand.laeuft) return;
        e.preventDefault();
        radRest += e.deltaY;
        if (radTimer !== null) return;
        radTimer = G.setTimeout(() => {
          radTimer = null;
          const dy = Math.max(-5000, Math.min(5000, Math.round(radRest)));
          radRest = 0;
          if (dy) void aktion({ aktion: 'scroll', dx: 0, dy });
        }, 140);
      },
      { passive: false }
    );
    // Tasten, solange die Bühne den Fokus hat: Buchstaben gesammelt als Text, Sondertasten einzeln. Mit Cmd/Strg/Alt gehört die Taste der App.
    const textAb = () => {
      textTimer = null;
      const t = textRest;
      textRest = '';
      if (t) void aktion({ aktion: 'tippen', text: t });
    };
    els.buehne.addEventListener('keydown', (e) => {
      if (!stand || !stand.laeuft || e.metaKey || e.ctrlKey || e.altKey) return;
      if (TASTEN[e.key]) {
        e.preventDefault();
        e.stopPropagation();
        if (textTimer !== null) {
          G.clearTimeout(textTimer);
          textAb();
        }
        void aktion({ aktion: 'taste', taste: TASTEN[e.key] });
      } else if (typeof e.key === 'string' && e.key.length === 1) {
        e.preventDefault();
        e.stopPropagation();
        textRest += e.key;
        if (textTimer === null) textTimer = G.setTimeout(textAb, 250);
      }
    });

    zeichne();
    return {
      pruefe,
      zeige,
      beiWerkzeug,
      auffrischen,
      get offen() {
        return offen;
      },
      get kennt() {
        return kennt;
      },
      stand: () => stand,
    };
  }

  FP.createBrowserFlaeche = createBrowserFlaeche;
  FP.browserFlaeche = { seitenPunkt, lageText, TASTEN };
})(typeof globalThis !== 'undefined' ? globalThis : window);
