/* Tafel „Wissen“ der Seitenleiste (Paket B1, Prototyp apps/fyos-agent/prototyp/ausbau.html, „Gedächtnis und Wissen“): Suche über den Hub
 * (Wissensbasis, Wiki, Doku, Fähigkeiten, Dokumente, Ablage; das Gedächtnis nur mit dem Häkchen), Treffer mit Quelle, Reife und Stand.
 * Ein Klick klappt den Text des Treffers auf (wissen.lesen); „Erwähnen“ legt seine Adresse ins Nachrichtenfeld. Nur lesend, über runner-wege.js
 * (`wissen`, `wissenLesen`, `wissenDa`). Kennt der Runner die Wege nicht, bleibt der Knopf der Schiene weg.
 *
 *   FP.wissen = { createWissenTafel, trefferUnterzeile }
 *
 * Texte nur als textContent. Kürzel der Klassen: `ws-`.
 */
(() => {
  'use strict';
  const FP = (window.FyosPrototyp = window.FyosPrototyp || {});

  /** „dokumente/datei · 12.11.2026“ unter dem Titel. */
  function trefferUnterzeile(t) {
    const stand = /^\d{4}-\d{2}-\d{2}/.test(t.stand) ? `${t.stand.slice(8, 10)}.${t.stand.slice(5, 7)}.${t.stand.slice(0, 4)}` : t.stand;
    return [t.quelle, stand].filter(Boolean).join(' · ');
  }

  /**
   * refs: { knopf, feld, gedaechtnis, liste, hinweis }
   * opts: { wege, beiErwaehnen?: (text) => void, beiWeg?: (kennt) => void, setTimeout?, clearTimeout? }
   */
  function createWissenTafel(refs, opts) {
    const doc = refs.liste.ownerDocument;
    const st = opts.setTimeout || ((f, ms) => setTimeout(f, ms));
    const ct = opts.clearTimeout || ((t) => clearTimeout(t));
    let uhr = null;
    let nr = 0; // nur die letzte Suche zeichnet

    const el = (tag, klasse, text) => {
      const e = doc.createElement(tag);
      if (klasse) e.className = klasse;
      if (text !== undefined) e.textContent = String(text);
      return e;
    };
    const hinweis = (t, fehler) => {
      refs.hinweis.textContent = t || '';
      refs.hinweis.hidden = !t;
      refs.hinweis.classList.toggle('ws-fehler', !!fehler);
    };

    async function aufklappen(li, t, knopf) {
      const offen = li.querySelector('.ws-text');
      if (offen) {
        offen.remove();
        knopf.setAttribute('aria-expanded', 'false');
        return;
      }
      knopf.setAttribute('aria-expanded', 'true');
      const block = el('div', 'ws-text', 'Wird gelesen …');
      li.appendChild(block);
      try {
        const e = await opts.wege.wissenLesen(t.adresse);
        block.textContent = e.aufloesbar ? e.text || '(leer)' : 'Diese Adresse ist nicht mehr auflösbar: der Weg ist kaputt oder das Gesuchte entfernt.';
      } catch (f) {
        block.textContent = `Nicht lesbar: ${(f && (f.meldung || f.message)) || 'unbekannter Fehler'}`;
        block.classList.add('ws-fehler');
      }
    }

    function zeichne(r) {
      refs.liste.textContent = '';
      if (!r.treffer.length) {
        hinweis('Nichts gefunden. Andere Wörter oder eine Kennung versuchen.');
        return;
      }
      hinweis(r.satz);
      for (const t of r.treffer) {
        const li = el('li', 'ws-treffer');
        const kopf = el('button', 'ws-kopf');
        kopf.type = 'button';
        kopf.setAttribute('aria-expanded', 'false');
        kopf.title = t.adresse ? `Text lesen: ${t.adresse}` : 'Text lesen';
        const titel = el('span', 'ws-titel', t.titel);
        kopf.appendChild(titel);
        if (t.reife) kopf.appendChild(el('span', `ws-reife ${t.reife}`, t.reife));
        kopf.addEventListener('click', () => {
          if (t.adresse) void aufklappen(li, t, kopf);
        });
        li.appendChild(kopf);
        const unter = el('div', 'leise ws-unter', trefferUnterzeile(t));
        if (t.adresse && opts.beiErwaehnen) {
          const erw = el('button', 'leise-knopf ws-erwaehnen', 'Erwähnen');
          erw.type = 'button';
          erw.title = 'Die Adresse in die Nachricht legen';
          erw.addEventListener('click', () => opts.beiErwaehnen(`Siehe ${t.adresse}`));
          unter.appendChild(erw);
        }
        li.appendChild(unter);
        if (t.auszug) li.appendChild(el('p', 'ws-auszug', t.auszug));
        refs.liste.appendChild(li);
      }
    }

    async function suche() {
      const q = refs.feld.value.trim();
      const meine = ++nr;
      if (!q) {
        refs.liste.textContent = '';
        hinweis('');
        return;
      }
      hinweis('Sucht …');
      try {
        const r = await opts.wege.wissen(q, { limit: 10, gedaechtnis: !!(refs.gedaechtnis && refs.gedaechtnis.checked) });
        if (meine !== nr) return;
        zeichne(r);
      } catch (f) {
        if (meine !== nr) return;
        refs.liste.textContent = '';
        hinweis(`Suche nicht möglich: ${(f && (f.meldung || f.message)) || 'unbekannter Fehler'}`, true);
      }
    }
    const planen = () => {
      if (uhr !== null) ct(uhr);
      uhr = st(() => {
        uhr = null;
        void suche();
      }, 400);
    };
    refs.feld.addEventListener('input', planen);
    refs.feld.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      if (uhr !== null) ct(uhr);
      uhr = null;
      void suche();
    });
    if (refs.gedaechtnis) refs.gedaechtnis.addEventListener('change', () => void suche());

    /** Beim Start: kennt der Runner die Wege? (zeigt oder verbirgt den Knopf) */
    async function pruefe() {
      let da = false;
      try {
        da = await opts.wege.wissenDa();
      } catch (f) {
        da = false; // Runner gerade nicht erreichbar: der Knopf erscheint beim nächsten Start
      }
      if (refs.knopf) refs.knopf.hidden = !da;
      if (opts.beiWeg) opts.beiWeg(da);
      return da;
    }
    function zeige() {
      refs.feld.focus();
    }
    return { pruefe, zeige, suche };
  }

  FP.wissen = { createWissenTafel, trefferUnterzeile };
})();
