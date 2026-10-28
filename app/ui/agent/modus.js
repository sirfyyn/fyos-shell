/* Modus-Anzeige in der Statuszeile: "Berechtigungen umgehen" (Standard), als Menü wie in Claude Code Desktop.
 * Nur Anzeige: der Runner hält heute selbst nur Zerstörendes (security.freigabePflicht, Standard DESTRUCTIVE) zurück und kennt keinen
 * Schalter dafür. Das Menü ändert darum nichts und sagt, woran das liegt. Kommt später ein Konfigurations-Endpunkt, hängt er hier
 * über opts.setze(modus) ein (Promise); ohne ihn bleibt die Auswahl gesperrt.
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});
  function startModus(knopf, menue, opts) {
    opts = opts || {};
    const doc = knopf.ownerDocument;
    let offen = false;
    const setze = (o) => {
      offen = o;
      menue.hidden = !o;
      knopf.setAttribute('aria-expanded', o ? 'true' : 'false');
    };
    const zeichne = (modus) => {
      const pflicht = (modus && modus.pflicht) || ['DESTRUCTIVE'];
      menue.textContent = '';
      const mk = (text, haken, gesperrt, hilfe) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', haken ? 'true' : 'false');
        b.className = 'modus-punkt';
        if (gesperrt) b.setAttribute('aria-disabled', 'true');
        const h = doc.createElement('span');
        h.className = 'haken';
        h.textContent = haken ? '✓' : '';
        const t = doc.createElement('span');
        t.className = 'text';
        t.textContent = text;
        b.append(h, t);
        if (hilfe) {
          const s = doc.createElement('span');
          s.className = 'hilfe';
          s.textContent = hilfe;
          t.appendChild(s);
        }
        b.addEventListener('click', () => {
          if (opts.setze && !gesperrt) opts.setze(text);
        });
        return b;
      };
      menue.append(
        mk('Berechtigungen umgehen', true, false, 'Werkzeuge laufen durch. Nur Zerstörendes (' + pflicht.join(', ').toLowerCase() + ') fragt, je Aktion einzeln mit sichtbarem Befehl.'),
        mk('Jede Aktion fragen', false, true, 'Gibt es im Runner nicht (Beschränkungen weich, nur Destruktives geht durch eine Freigabe).')
      );
      const hinweis = doc.createElement('div');
      hinweis.className = 'modus-hinweis';
      hinweis.textContent = opts.setze ? '' : 'Anzeige des Runner-Zustands, hier nicht umschaltbar.';
      hinweis.hidden = !!opts.setze;
      menue.appendChild(hinweis);
    };
    knopf.addEventListener('click', () => setze(!offen));
    doc.addEventListener('click', (e) => {
      if (offen && !knopf.contains(e.target) && !menue.contains(e.target)) setze(false);
    });
    doc.addEventListener('keydown', (e) => {
      if (offen && e.key === 'Escape') {
        setze(false);
        knopf.focus();
      }
    });
    zeichne(null);
    return { zeichne, setze };
  }
  FP.startModus = startModus;
})(typeof globalThis !== 'undefined' ? globalThis : window);
