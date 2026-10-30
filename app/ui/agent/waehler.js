/* Kleiner Wähler im Fuß des Eingabefelds (Modell, Modus): ein Knopf öffnet eine Liste (Rolle listbox) über ihm.
 * Tastatur: Pfeil unten/oben oder Enter öffnet; in der Liste Pfeile, Pos1/Ende, Enter oder Leertaste wählt, Esc schließt und gibt den Fokus zurück.
 * Gruppen (Überschrift + Punkte) sind möglich; ein gesperrter Punkt ist sichtbar, aber nicht wählbar. Alle Texte gehen über textContent.
 *
 * FP.createWaehler(knopf, menue, { beiWahl(wert, gruppeId) → Promise|undefined, beschriftung }) →
 *   { setze(gruppen), oeffne(), schliesse(), istOffen() }   gruppen: [{ id, titel?, punkte: [{ wert, text, hilfe?, gewaehlt?, gesperrt? }] }]
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  let zaehler = 0;
  function createWaehler(knopf, menue, opts) {
    opts = opts || {};
    const doc = knopf.ownerDocument;
    const praefix = `wp${(zaehler += 1)}-`;
    let gruppen = [];
    let offen = false;
    let index = 0;

    menue.setAttribute('role', 'listbox');
    menue.tabIndex = -1;
    if (opts.beschriftung) menue.setAttribute('aria-label', opts.beschriftung);
    knopf.setAttribute('aria-haspopup', 'listbox');
    knopf.setAttribute('aria-expanded', 'false');
    menue.hidden = true;

    const punkte = () => gruppen.flatMap((g) => g.punkte.map((p) => ({ p, g })));
    const waehlbar = () => punkte().map((x, i) => ({ ...x, i })).filter((x) => !x.p.gesperrt);

    function zeichne() {
      menue.textContent = '';
      let i = 0;
      for (const g of gruppen) {
        const behaelter = doc.createElement('div');
        behaelter.setAttribute('role', 'group');
        if (g.titel) {
          behaelter.setAttribute('aria-label', g.titel);
          const t = doc.createElement('div');
          t.className = 'waehler-titel';
          t.setAttribute('aria-hidden', 'true');
          t.textContent = g.titel;
          behaelter.appendChild(t);
        }
        for (const p of g.punkte) {
          const o = doc.createElement('div');
          const mein = i;
          o.id = `${praefix}${mein}`;
          o.className = 'waehler-punkt';
          o.setAttribute('role', 'option');
          o.setAttribute('aria-selected', p.gewaehlt ? 'true' : 'false');
          if (p.gesperrt) o.setAttribute('aria-disabled', 'true');
          if (mein === index && offen) o.classList.add('fokus');
          const h = doc.createElement('span');
          h.className = 'haken';
          h.setAttribute('aria-hidden', 'true');
          h.textContent = p.gewaehlt ? '✓' : '';
          const t = doc.createElement('span');
          t.className = 'text';
          t.textContent = p.text;
          if (p.hilfe) {
            const s = doc.createElement('span');
            s.className = 'hilfe';
            s.textContent = p.hilfe;
            t.appendChild(s);
          }
          o.append(h, t);
          o.addEventListener('mousedown', (ev) => ev.preventDefault());
          o.addEventListener('click', () => waehle(mein));
          behaelter.appendChild(o);
          i += 1;
        }
        menue.appendChild(behaelter);
      }
      if (offen) {
        menue.setAttribute('aria-activedescendant', `${praefix}${index}`);
        const el = menue.querySelector(`#${praefix}${index}`);
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
      } else {
        menue.removeAttribute('aria-activedescendant');
      }
    }

    function oeffne() {
      if (offen || knopf.disabled) return;
      const w = waehlbar();
      if (!w.length) return;
      offen = true;
      const gewaehlt = w.find((x) => x.p.gewaehlt);
      index = (gewaehlt || w[0]).i;
      menue.hidden = false;
      knopf.setAttribute('aria-expanded', 'true');
      zeichne();
      menue.focus();
    }
    function schliesse(fokus) {
      if (!offen) return;
      offen = false;
      menue.hidden = true;
      knopf.setAttribute('aria-expanded', 'false');
      menue.removeAttribute('aria-activedescendant');
      if (fokus) knopf.focus();
    }
    function waehle(i) {
      const x = punkte()[i];
      if (!x || x.p.gesperrt) return;
      schliesse(true);
      if (opts.beiWahl) opts.beiWahl(x.p.wert, x.g.id);
    }
    function schritt(richtung) {
      const w = waehlbar();
      if (!w.length) return;
      const pos = w.findIndex((x) => x.i === index);
      index = w[(pos + richtung + w.length) % w.length].i;
      zeichne();
    }

    knopf.addEventListener('click', () => (offen ? schliesse(true) : oeffne()));
    knopf.addEventListener('keydown', (e) => {
      if (offen) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        oeffne();
      }
    });
    menue.addEventListener('keydown', (e) => {
      if (!offen) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        schritt(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const w = waehlbar();
        if (w.length) {
          index = (e.key === 'Home' ? w[0] : w[w.length - 1]).i;
          zeichne();
        }
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        waehle(index);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        schliesse(true);
      } else if (e.key === 'Tab') {
        schliesse(false);
      }
    });
    doc.addEventListener('click', (e) => {
      if (offen && !knopf.contains(e.target) && !menue.contains(e.target)) schliesse(false);
    });

    return {
      setze(neu) {
        gruppen = neu || [];
        zeichne();
      },
      oeffne,
      schliesse,
      istOffen: () => offen,
    };
  }
  FP.createWaehler = createWaehler;
})(typeof globalThis !== 'undefined' ? globalThis : window);
