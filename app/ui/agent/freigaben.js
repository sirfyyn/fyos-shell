/* Freigaben-Panel des Arbeitsplatzes: ein Knopf im Kopf mit der Zahl ALLER offenen Freigaben (über alle Sitzungen des Runners) und ein Panel mit
 * der Liste. Jede Karte zeigt Sitzung, Risikostufe, Aktion, Kontext und Befehl und bietet Erlauben, Ablehnen und „Später“ sowie den Sprung in die
 * Sitzung der Freigabe. „Später“ merkt das Fenster nur im Speicher: die Freigabe bleibt beim Runner offen (Liste, Zahl und Menüleiste ändern sich nicht).
 *
 * Wege des Runners (wie die Karten im Verlauf, echt.js): GET /api/freigaben → { freigaben: [{ id, conversationId, gespraechTitel, aktion, risiko,
 * kontext, befehl, werkzeug, status: 'offen'|'erteilt'|'abgelehnt', erstellt }] }; POST /api/freigaben/<id> { entscheidung: 'erteilt'|'abgelehnt',
 * von: 'mensch' } → { freigaben } (die neue Liste). Alle Texte kommen vom Runner und werden nur als Text eingesetzt, nie als HTML.
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  const RISIKO = { low: 'geringes Risiko', medium: 'mittleres Risiko', high: 'hohes Risiko' };
  const risikoText = (r) => RISIKO[r] || RISIKO.medium;
  const gut = (r) => (RISIKO[r] ? r : 'medium');

  /** Alle offenen Freigaben, die älteste zuerst. */
  function offene(liste) {
    return (Array.isArray(liste) ? liste : [])
      .filter((f) => f && f.status === 'offen' && f.id !== undefined && f.id !== null && String(f.id) !== '')
      .slice()
      .sort((a, b) => Number(a.erstellt || 0) - Number(b.erstellt || 0));
  }

  const fehlerText = (f) => (f && f.message) || String(f);

  /**
   * refs: { knopf, zahl, panel, liste, zu, hinweis }
   * opts: { transport, beiSprung(sitzungsId), beiAenderung(offene), intervallMs (Vorgabe 4000, 0 = kein Abfragen), setInterval, clearInterval }
   */
  function createFreigaben(refs, opts) {
    const doc = refs.panel.ownerDocument;
    const el = (tag, cls, text) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    let alle = [];
    let geladen = false;
    let fehler = 0;
    let hinweisText = '';
    let zeit = null;
    const zurueck = new Set(); // „Später“: nur in diesem Fenster gemerkt
    const arbeitet = new Set(); // Freigaben, deren Entscheidung gerade unterwegs ist
    let zeichneSig = '';
    const sig = () => JSON.stringify([offene(alle).map((f) => [f.id, f.risiko, f.aktion, f.kontext, f.befehl, f.gespraechTitel, zurueck.has(String(f.id)), arbeitet.has(String(f.id))]), geladen, fehler >= 2, hinweisText]);

    function hinweis(text) {
      hinweisText = text || '';
      refs.hinweis.hidden = !hinweisText;
      refs.hinweis.textContent = hinweisText;
    }

    function karte(f) {
      const id = String(f.id);
      const aufgeschoben = zurueck.has(id);
      const busy = arbeitet.has(id);
      const k = el('article', `fp-karte${f.risiko === 'high' ? ' high' : ''}`);
      k.dataset.id = id;
      k.dataset.risiko = gut(f.risiko);
      k.dataset.zustand = aufgeschoben ? 'spaeter' : 'offen';
      if (f.conversationId !== undefined && f.conversationId !== null && String(f.conversationId) !== '') {
        const zeile = el('div', 'fp-sitzung');
        zeile.append(el('span', 'fp-sitzung-titel', String(f.gespraechTitel || `Sitzung ${f.conversationId}`)));
        const sprung = el('button', 'fp-sprung', 'Zur Sitzung');
        sprung.type = 'button';
        sprung.setAttribute('aria-label', `Zur Sitzung: ${f.gespraechTitel || f.conversationId}`);
        sprung.addEventListener('click', () => {
          zeige(false);
          if (opts.beiSprung) opts.beiSprung(String(f.conversationId));
        });
        zeile.append(sprung);
        k.append(zeile);
      }
      const kopf = el('div', 'fp-kopf');
      kopf.append(el('span', 'fp-titel', 'Freigabe nötig'), el('span', 'chip risiko', risikoText(f.risiko)));
      k.append(kopf, el('div', 'fp-aktion', String(f.aktion || 'Aktion ohne Beschreibung')));
      if (f.kontext) k.append(el('div', 'fp-kontext', String(f.kontext)));
      const befehl = f.befehl || f.werkzeug;
      if (befehl) k.append(el('code', 'fp-befehl', String(befehl)));
      const knoepfe = el('div', 'fp-knoepfe');
      if (!aufgeschoben) {
        const ja = el('button', 'primaer fp-erlauben', 'Erlauben');
        const nein = el('button', 'gefahr fp-ablehnen', 'Ablehnen');
        const spaeter = el('button', 'fp-spaeter', 'Später');
        for (const b of [ja, nein, spaeter]) b.type = 'button';
        ja.disabled = nein.disabled = busy;
        ja.addEventListener('click', () => entscheide(id, 'erteilt'));
        nein.addEventListener('click', () => entscheide(id, 'abgelehnt'));
        spaeter.addEventListener('click', () => {
          zurueck.add(id);
          zeichne();
        });
        knoepfe.append(ja, nein, spaeter);
        k.append(knoepfe);
      } else {
        const jetzt = el('button', 'fp-jetzt', 'Jetzt entscheiden');
        jetzt.type = 'button';
        jetzt.addEventListener('click', () => {
          zurueck.delete(id);
          zeichne();
        });
        knoepfe.append(jetzt);
        k.append(el('div', 'fp-ergebnis', 'Zurückgestellt. Sie bleibt in der Liste und in der Menüleiste offen.'), knoepfe);
      }
      return k;
    }

    function zeichne(erzwingen) {
      const o = offene(alle);
      refs.zahl.textContent = String(o.length);
      refs.knopf.hidden = o.length === 0 && refs.panel.hidden;
      refs.knopf.setAttribute('aria-expanded', String(!refs.panel.hidden));
      refs.knopf.title = o.length === 1 ? '1 offene Freigabe' : `${o.length} offene Freigaben`;
      if (opts.beiAenderung) opts.beiAenderung(o);
      if (refs.panel.hidden) return;
      const s = sig();
      if (!erzwingen && s === zeichneSig) return;
      zeichneSig = s;
      const hatte = refs.liste.contains(doc.activeElement) ? doc.activeElement : null;
      const merke = hatte && hatte.closest('.fp-karte') ? [hatte.closest('.fp-karte').dataset.id, hatte.className] : null;
      refs.liste.replaceChildren();
      if (!geladen && !o.length) refs.liste.append(el('div', 'fp-leer', 'Lade offene Freigaben …'));
      else if (!o.length) refs.liste.append(el('div', 'fp-leer', 'Keine offenen Freigaben.'));
      for (const f of o) refs.liste.append(karte(f));
      if (fehler >= 2) refs.liste.append(el('div', 'fp-leer fehler', 'Die Liste lässt sich gerade nicht laden. Es wird weiter versucht.'));
      if (merke) {
        const k = refs.liste.querySelector(`.fp-karte[data-id="${CSS_ESC(merke[0])}"]`);
        const b = k && [...k.querySelectorAll('button')].find((x) => x.className === merke[1]);
        if (b) b.focus();
      }
    }
    const CSS_ESC = (s) => String(s).replace(/["\\]/g, '\\$&');

    /** Liste setzen (vom Runner geholt oder aus der Antwort einer Entscheidung); Entschiedenes verliert sein „Später“. */
    function setze(liste) {
      alle = Array.isArray(liste) ? liste : [];
      geladen = true;
      fehler = 0;
      const offen = new Set(offene(alle).map((f) => String(f.id)));
      for (const id of [...zurueck]) if (!offen.has(id)) zurueck.delete(id);
      zeichne();
    }

    async function lade() {
      try {
        const r = await opts.transport.api('GET', '/api/freigaben');
        setze(r && r.freigaben);
        if (hinweisText.startsWith('Liste')) hinweis('');
      } catch (f) {
        fehler += 1;
        zeichne();
      }
    }

    async function entscheide(id, entscheidung) {
      if (arbeitet.has(id)) return;
      arbeitet.add(id);
      zeichne();
      try {
        const r = await opts.transport.api('POST', `/api/freigaben/${encodeURIComponent(id)}`, { entscheidung, von: 'mensch' });
        arbeitet.delete(id);
        zurueck.delete(id);
        if (r && Array.isArray(r.freigaben)) setze(r.freigaben);
        else await lade();
        hinweis(entscheidung === 'erteilt' ? 'Freigabe erteilt.' : 'Freigabe abgelehnt.');
      } catch (f) {
        arbeitet.delete(id);
        hinweis(`Entscheidung nicht gespeichert: ${fehlerText(f)}`);
        await lade(); // war sie schon entschieden, verschwindet sie jetzt aus der Liste
        zeichne(true);
      }
    }

    function zeige(an) {
      const will = an === undefined ? refs.panel.hidden : !!an;
      if (will === !refs.panel.hidden) return;
      refs.panel.hidden = !will;
      if (will) {
        hinweis('');
        zeichne(true);
        lade();
        const b = refs.liste.querySelector('button');
        (b || refs.zu).focus();
      } else {
        zeichne();
        if (refs.panel.contains(doc.activeElement)) refs.knopf.focus();
      }
    }

    refs.knopf.addEventListener('click', () => zeige());
    refs.zu.addEventListener('click', () => zeige(false));
    // Im Panel gehören 1, 2, J, N und Esc dem Panel: sie dürfen nicht die Karte im Verlauf entscheiden (chat.js hört am Dokument)
    refs.panel.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = String(e.key).toLowerCase();
      if (k === 'escape') {
        e.preventDefault();
        zeige(false);
      }
      if (['1', '2', 'y', 'n', 'escape'].includes(k)) e.stopPropagation();
    });

    function start() {
      lade();
      const ms = opts.intervallMs === undefined ? 4000 : opts.intervallMs;
      if (ms > 0 && zeit === null) zeit = (opts.setInterval || G.setInterval)(lade, ms);
    }
    function stopp() {
      if (zeit !== null) (opts.clearInterval || G.clearInterval)(zeit);
      zeit = null;
    }
    zeichne();

    return { start, stopp, lade, setze, zeige, offene: () => offene(alle), zurueckgestellt: () => [...zurueck], entscheide, offen: () => !refs.panel.hidden };
  }

  FP.createFreigaben = createFreigaben;
  FP.freigaben = { offene, risikoText };
})(typeof globalThis !== 'undefined' ? globalThis : window);
