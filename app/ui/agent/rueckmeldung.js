/* Rückmeldung der Oberfläche: wie viel der Verlauf zeigt (kompakt, normal, detailliert), Töne zu den Momenten eines Zugs, eine kurze Meldung
 * am unteren Rand und die Reaktionen unter einer Antwort.
 *
 *   FP.rueckmeldung = { createRueckmeldung, tonFuer, naechste, reaktionsText, modellLage, abschlussSicht, istTestbefehl, ANZEIGEN, STUFEN, REAKTIONEN, KLAENGE }
 *
 * Alle Töne entstehen hier aus Sinus- und Dreieckswellen, es gibt keine Klangdateien. Die Wahl steht im Speicher des Fensters (localStorage);
 * ohne ihn gilt sie bis zum Schließen. Nichts hiervon spricht mit dem Runner: was eine Reaktion sendet, sendet die Seite.
 */
(() => {
  'use strict';
  const FP = (window.FyosPrototyp = window.FyosPrototyp || {});

  const ANZEIGEN = ['kompakt', 'normal', 'detail'];
  const ANZEIGE_NAME = { kompakt: 'kompakt', normal: 'normal', detail: 'detailliert' };
  const ANZEIGE_HILFE = {
    kompakt: 'Kompakt: nur die Antworten, Freigaben, Fehler und was gerade läuft',
    normal: 'Normal: eine Karte je Werkzeug, Denken und Ausgaben zugeklappt',
    detail: 'Detailliert: Denken und Ausgaben stehen aufgeklappt im Verlauf',
  };
  const STUFEN = ['aus', 'dezent', 'deutlich'];
  const STUFE_HILFE = {
    aus: 'Töne aus',
    dezent: 'Dezent: leise; „Braucht dich“ und „Fertig“ klingen nur, wenn das Fenster nicht vorn ist',
    deutlich: 'Deutlich: lauter, auch bei jedem fertigen Werkzeug und wenn das Fenster vorn ist',
  };
  const LAUT = { aus: 0, dezent: 0.05, deutlich: 0.14 };

  // Jeder Klang ist eine Folge von Tönen: [Frequenz in Hz, Beginn in s, Dauer in s, Wellenform, Lautstärkefaktor]
  const KLAENGE = {
    gesendet: [[880, 0, 0.07, 'triangle', 0.8]],
    werkzeug: [[1320, 0, 0.035, 'triangle', 0.5]],
    fehler: [[196, 0, 0.22, 'sine', 1.2], [174.6, 0.09, 0.26, 'sine', 1.2]],
    braucht: [[659.3, 0, 0.14, 'sine', 1], [880, 0.13, 0.22, 'sine', 1]],
    fertig: [[523.3, 0, 0.16, 'sine', 1], [783.99, 0.12, 0.3, 'sine', 1]],
  };

  /** Welcher Klang zu einem Moment gehört, oder null. `vorn`: das Fenster ist sichtbar und hat den Fokus. */
  function tonFuer(moment, lage) {
    const stufe = lage && STUFEN.includes(lage.stufe) ? lage.stufe : 'aus';
    if (stufe === 'aus' || !KLAENGE[moment]) return null;
    if (moment === 'werkzeug') return stufe === 'deutlich' ? moment : null;
    if ((moment === 'braucht' || moment === 'fertig') && stufe === 'dezent' && lage.vorn) return null;
    return moment;
  }

  /** Die nächste Wahl im Kreis (für die Knöpfe, die mit jedem Klick weiterschalten). */
  function naechste(liste, wert) {
    const i = liste.indexOf(wert);
    return liste[(i + 1) % liste.length];
  }

  // Reaktionen unter einer Antwort. `sendet`: geht sofort als Nachricht an den Agenten; `ergaenzen`: steht im Eingabefeld, der Mensch schreibt
  // den Satz zu Ende; sonst wird sie vermerkt und geht mit der nächsten Nachricht mit.
  const REAKTIONEN = [
    { id: 'gut', zeichen: 'gut', hilfe: 'Gut so. Wird vermerkt und geht mit deiner nächsten Nachricht mit.' },
    { id: 'nicht-gut', zeichen: 'nicht gut', hilfe: 'Nicht gut. Schreib in einem Satz dazu, was gefehlt hat.', ergaenzen: true },
    { id: 'kuerzer', zeichen: 'kürzer', hilfe: 'Sofort senden: bitte kürzer.', sendet: true },
    { id: 'nochmal', zeichen: 'noch einmal', hilfe: 'Sofort senden: bitte noch einmal, auf anderem Weg.', sendet: true },
  ];
  const TEXTE = {
    gut: '(Rückmeldung zur letzten Antwort: gut so.)',
    'nicht-gut': 'Die letzte Antwort war nicht gut: ',
    kuerzer: 'Bitte kürzer: fasse deine letzte Antwort in höchstens drei Sätzen zusammen.',
    nochmal: 'Bitte noch einmal: geh die letzte Aufgabe neu an, auf einem anderen Weg als eben.',
  };
  const reaktionsText = (id) => TEXTE[id] || '';

  // Befehle, die als Testlauf gelten (für den Abschluss eines Zugs)
  const TESTBEFEHL = /(^|[\s;&|(])(npm (run )?test|pnpm (run )?test|yarn test|node --test|pytest|python3? -m (pytest|unittest)|cargo test|go test|vitest|jest|make test|deno test|bun test)\b/;

  /**
   * Der Abschluss eines eben beendeten Zugs (Prototyp „Abschluss mit nächsten Schritten“): ein Satz über das, was geschah, und die
   * passenden nächsten Schritte. `zug`: { dateien: Zahl geänderter Dateien, tests: null | { ok, exit }, git: null | { offen: Zahl } }.
   * → null, wenn nichts zu sagen ist (keine Datei, kein Test), sonst { text, knoepfe: ['aenderungen'|'commit'] }.
   */
  function abschlussSicht(zug) {
    const z = zug && typeof zug === 'object' ? zug : {};
    const n = Number.isFinite(z.dateien) ? Math.max(0, Math.trunc(z.dateien)) : 0;
    const t = z.tests && typeof z.tests === 'object' ? z.tests : null;
    if (!n && !t) return null;
    const teile = [];
    teile.push(n === 0 ? 'Keine Datei geändert' : n === 1 ? 'Eine Datei geändert' : `${n} Dateien geändert`);
    if (t) teile.push(t.ok ? 'Tests grün' : `Tests rot${Number.isInteger(t.exit) ? ` (Exit ${t.exit})` : ''}`);
    else if (n) teile.push('keine Tests gelaufen');
    const knoepfe = [];
    if (z.git && Number.isFinite(z.git.offen)) {
      teile.push(z.git.offen > 0 ? 'nichts committet' : 'alles committet');
      if (z.git.offen > 0) knoepfe.push('commit');
    }
    if (n) knoepfe.push('aenderungen');
    return { text: `${teile.join(', ')}.`, knoepfe };
  }
  const istTestbefehl = (befehl) => TESTBEFEHL.test(String(befehl || ''));

  /**
   * Was neben dem Zustand der Sitzung über Modell und Agent zu sagen ist, aus `betrieb()` (runner-wege.js). „bereit“ meint nur
   * die Sitzung; ob das Modell antwortet, steht hier. `stufe` 'warn': sichtbar als eigene Marke; 'gut': nur im Hinweistext.
   * Meldet der Runner nichts dazu, kommt null.
   */
  function modellLage(betrieb) {
    const b = betrieb && typeof betrieb === 'object' ? betrieb : null;
    if (!b) return null;
    if (b.modell && typeof b.modell.antwortet === 'boolean') {
      const name = b.modell.name ? ` (${b.modell.name})` : '';
      return b.modell.antwortet
        ? { stufe: 'gut', text: '', hinweis: `Das Modell antwortet${name}.` }
        : { stufe: 'warn', text: 'Modell antwortet nicht', hinweis: `Das Modell antwortet nicht${name}. Nachrichten werden erst angenommen, wenn es wieder da ist.` };
    }
    if (b.arbeit && typeof b.arbeit.offen === 'boolean') {
      const warum = String(b.arbeit.warum || '').trim();
      return b.arbeit.offen
        ? { stufe: 'gut', text: '', hinweis: `Der Agent darf von selbst arbeiten${warum ? `: ${warum}` : '.'}` }
        : { stufe: 'warn', text: 'Agent wartet', hinweis: `Der Agent arbeitet gerade nicht von selbst${warum ? `: ${warum}` : '.'}` };
    }
    return null;
  }

  /**
   * opts: wurzel (Element, das die Klasse der Anzeige trägt), anzeigeKnopf, tonKnopf, toast (Element für die kurze Meldung),
   *       speicher (wie localStorage), audio () => AudioContext (für Tests), vorn () => boolean, setTimeout, clearTimeout.
   */
  function createRueckmeldung(opts) {
    opts = opts || {};
    const win = opts.fenster || window;
    const doc = win.document;
    const setTo = opts.setTimeout || ((f, ms) => win.setTimeout(f, ms));
    const clearTo = opts.clearTimeout || ((id) => win.clearTimeout(id));
    const lies = (k, erlaubt, sonst) => {
      try {
        const v = opts.speicher ? opts.speicher.getItem(k) : null;
        return erlaubt.includes(v) ? v : sonst;
      } catch (e) {
        return sonst;
      }
    };
    const merke = (k, v) => {
      try {
        if (opts.speicher) opts.speicher.setItem(k, v);
      } catch (e) {
        /* ohne Speicher gilt die Wahl bis zum Schließen */
      }
    };
    let anzeige = lies('fyos.agent.anzeige', ANZEIGEN, 'normal');
    let stufe = lies('fyos.agent.toene', STUFEN, 'aus');
    let ctx = null;
    let toastZeit = null;
    const gespielt = [];

    function zeichne() {
      if (opts.wurzel) {
        opts.wurzel.classList.toggle('anz-kompakt', anzeige === 'kompakt');
        opts.wurzel.classList.toggle('anz-detail', anzeige === 'detail');
      }
      if (opts.anzeigeKnopf) {
        opts.anzeigeKnopf.textContent = `Anzeige: ${ANZEIGE_NAME[anzeige]}`;
        opts.anzeigeKnopf.title = `${ANZEIGE_HILFE[anzeige]}. Klick schaltet weiter.`;
        opts.anzeigeKnopf.dataset.anzeige = anzeige;
      }
      if (opts.tonKnopf) {
        opts.tonKnopf.textContent = `Töne: ${stufe}`;
        opts.tonKnopf.title = `${STUFE_HILFE[stufe]}. Klick schaltet weiter.`;
        opts.tonKnopf.dataset.stufe = stufe;
      }
    }

    function spiele(name) {
      const folge = KLAENGE[name];
      const laut = LAUT[stufe];
      if (!folge || !laut) return false;
      gespielt.push(name);
      try {
        ctx = ctx || (opts.audio ? opts.audio() : new (win.AudioContext || win.webkitAudioContext)());
        if (!ctx) return false;
        if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
        for (const [freq, start, dauer, art, faktor] of folge) {
          const t = ctx.currentTime + start;
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = art;
          o.frequency.setValueAtTime(freq, t);
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(laut * faktor, t + 0.012);
          g.gain.exponentialRampToValueAtTime(0.0001, t + dauer);
          o.connect(g);
          g.connect(ctx.destination);
          o.start(t);
          o.stop(t + dauer + 0.02);
        }
        return true;
      } catch (e) {
        return false; // kein Ton möglich (kein Klang im Fenster): die Oberfläche bleibt, wie sie ist
      }
    }

    const vorn = () => (opts.vorn ? !!opts.vorn() : !doc.hidden && (typeof doc.hasFocus !== 'function' || doc.hasFocus()));

    /** Ein Moment eines Zugs: gesendet, werkzeug, fehler, braucht, fertig. Gibt den gespielten Klang zurück oder null. */
    function moment(name) {
      const klang = tonFuer(name, { stufe, vorn: vorn() });
      if (klang) spiele(klang);
      return klang;
    }

    function toast(text, ms) {
      const t = opts.toast;
      if (!t) return;
      t.textContent = String(text || '');
      t.hidden = false;
      if (toastZeit !== null) clearTo(toastZeit);
      toastZeit = setTo(() => {
        t.hidden = true;
        toastZeit = null;
      }, ms || 1800);
    }

    function setzeAnzeige(v) {
      if (!ANZEIGEN.includes(v)) return;
      anzeige = v;
      merke('fyos.agent.anzeige', v);
      zeichne();
    }
    function setzeStufe(v) {
      if (!STUFEN.includes(v)) return;
      stufe = v;
      merke('fyos.agent.toene', v);
      zeichne();
    }

    if (opts.anzeigeKnopf) {
      opts.anzeigeKnopf.addEventListener('click', () => {
        setzeAnzeige(naechste(ANZEIGEN, anzeige));
        toast(ANZEIGE_HILFE[anzeige]);
        if (opts.beiAnzeige) opts.beiAnzeige(anzeige);
      });
    }
    if (opts.tonKnopf) {
      opts.tonKnopf.addEventListener('click', () => {
        setzeStufe(naechste(STUFEN, stufe));
        toast(STUFE_HILFE[stufe]);
        spiele('fertig'); // so klingt die gewählte Stufe
      });
    }
    zeichne();

    return {
      moment,
      toast,
      setzeAnzeige,
      setzeStufe,
      get anzeige() {
        return anzeige;
      },
      get stufe() {
        return stufe;
      },
      gespielt,
    };
  }

  FP.rueckmeldung = { createRueckmeldung, tonFuer, naechste, reaktionsText, modellLage, abschlussSicht, istTestbefehl, ANZEIGEN, STUFEN, REAKTIONEN, KLAENGE };
})();
