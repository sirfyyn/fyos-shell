/* Seitenleiste mit den Sitzungen: Zeilen bleiben beim Aktualisieren erhalten (nach Id abgeglichen, nur umsortiert), damit
 * Fokus, Hover und Auswahl nicht flackern. Tastatur: Pfeile hoch/runter, Pos1/Ende, Enter wählt (Liste mit Tabulatorstopp auf der Auswahl).
 * Nur Text, nie HTML aus dem Runner.
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  /**
   * refs: { liste, weitere, weitereKopf, weitereZahl, leer }; opts: { beiWahl(id), beiNeu() }
   * Rückgabe: { zeichne(daten, aktivId), fokus(id), zeilen() }
   */
  function createLeiste(refs, opts) {
    opts = opts || {};
    const doc = refs.liste.ownerDocument;
    const knoten = new Map(); // String(id) → Zeilenelement
    let aktivId = null;

    function zeileBauen(z) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'sitzung';
      b.setAttribute('role', 'option');
      const punkt = doc.createElement('span');
      punkt.className = 'sitzung-punkt';
      punkt.setAttribute('aria-hidden', 'true');
      const text = doc.createElement('span');
      text.className = 'sitzung-text';
      const titel = doc.createElement('span');
      titel.className = 'sitzung-titel';
      const meta = doc.createElement('span');
      meta.className = 'sitzung-meta';
      text.append(titel, meta);
      const sr = doc.createElement('span');
      sr.className = 'sr';
      b.append(punkt, text, sr);
      b.addEventListener('click', () => opts.beiWahl && opts.beiWahl(z.id));
      return b;
    }

    function fuelle(b, z) {
      b.dataset.id = String(z.id);
      b.dataset.art = z.art;
      b.dataset.laeuft = z.laeuft ? '1' : '0';
      const titel = b.querySelector('.sitzung-titel');
      if (titel.textContent !== z.titel) titel.textContent = z.titel;
      const meta = [z.ordner || z.bereich, z.laeuft ? 'arbeitet' : z.zeitText].filter(Boolean).join(' · ');
      const m = b.querySelector('.sitzung-meta');
      if (m.textContent !== meta) m.textContent = meta;
      b.title = [z.titel, z.pfad || z.bereich].filter(Boolean).join('\n');
      const sr = b.querySelector('.sr');
      const srText = z.laeuft ? ', arbeitet gerade' : '';
      if (sr.textContent !== srText) sr.textContent = srText;
      const gewaehlt = String(z.id) === String(aktivId);
      b.setAttribute('aria-selected', gewaehlt ? 'true' : 'false');
      b.tabIndex = gewaehlt ? 0 : -1;
      b.classList.toggle('aktiv', gewaehlt);
    }

    /** Die Zeilen eines Behälters der Liste anpassen: vorhandene behalten, fehlende bauen, übrige entfernen, Reihenfolge herstellen. */
    function abgleichen(behaelter, zeilen) {
      const soll = new Set(zeilen.map((z) => String(z.id)));
      for (const [id, b] of [...knoten]) {
        if (b.parentNode === behaelter && !soll.has(id)) {
          b.remove();
          knoten.delete(id);
        }
      }
      let vorher = null;
      for (const z of zeilen) {
        const id = String(z.id);
        let b = knoten.get(id);
        if (!b) {
          b = zeileBauen(z);
          knoten.set(id, b);
        }
        fuelle(b, z);
        const sollNach = vorher ? vorher.nextSibling : behaelter.firstChild;
        if (b !== sollNach) behaelter.insertBefore(b, sollNach);
        vorher = b;
      }
    }

    function zeichne(daten, aktiv) {
      aktivId = aktiv;
      const fokusId = doc.activeElement && doc.activeElement.classList && doc.activeElement.classList.contains('sitzung') ? doc.activeElement.dataset.id : null;
      abgleichen(refs.liste, daten.sitzungen || []);
      abgleichen(refs.weitere, daten.weitere || []);
      refs.leer.hidden = (daten.sitzungen || []).length > 0;
      refs.weitereKopf.hidden = !(daten.weitere || []).length;
      refs.weitereZahl.textContent = String((daten.weitere || []).length);
      // Falls die gewählte Sitzung nicht in der Liste steht (z. B. gerade erst angelegt), bleibt ein Tabulatorstopp auf der ersten Zeile
      if (![...knoten.values()].some((b) => b.tabIndex === 0)) {
        const erste = refs.liste.querySelector('.sitzung');
        if (erste) erste.tabIndex = 0;
      }
      if (fokusId && knoten.get(fokusId) && doc.activeElement !== knoten.get(fokusId)) knoten.get(fokusId).focus();
    }

    function sichtbar() {
      return [...refs.liste.querySelectorAll('.sitzung'), ...(refs.weitere.hidden ? [] : refs.weitere.querySelectorAll('.sitzung'))];
    }
    function taste(e) {
      const ziele = sichtbar();
      const i = ziele.indexOf(doc.activeElement);
      if (i < 0) return;
      let n = -1;
      if (e.key === 'ArrowDown') n = Math.min(ziele.length - 1, i + 1);
      else if (e.key === 'ArrowUp') n = Math.max(0, i - 1);
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = ziele.length - 1;
      if (n < 0) return;
      e.preventDefault();
      ziele[n].focus();
    }
    refs.liste.addEventListener('keydown', taste);
    refs.weitere.addEventListener('keydown', taste);

    return {
      zeichne,
      fokus(id) {
        const b = knoten.get(String(id));
        if (b) b.focus();
      },
      zeilen: () => [...knoten.values()],
    };
  }

  FP.createLeiste = createLeiste;
})(typeof globalThis !== 'undefined' ? globalThis : window);
