/* Modus-Wähler in der Statuszeile. Gezeigt werden nur Modi, die es wirklich gibt:
 *
 *   Freigabe        Der Runner hält heute nur Zerstörendes zurück (security.freigabePflicht, Standard DESTRUCTIVE), je Aktion einzeln mit sichtbarem Befehl.
 *                   Das ist Konfiguration des Runners; es gibt keinen Weg, sie je Sitzung zu ändern. Darum eine Zeile als Anzeige, nicht wählbar.
 *   Während der Arbeit   Wie eine Nachricht behandelt wird, wenn der Agent gerade arbeitet: „folgen“ (einreihen, der Standard) oder „steuern“ (greift sofort ein).
 *                   Das ist die Art der Nachricht (POST …/nachricht, Feld `art`) und gilt je Sitzung in diesem Fenster; Strg/Cmd+Enter greift weiter einmalig ein.
 *
 * Kein erfundener Modus („Jede Aktion fragen“ gäbe es im Runner nicht). Kommt später ein Weg zum Ändern der Freigabe, hängt er in `opts.beiFreigabe` ein.
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  const NAMEN = { DESTRUCTIVE: 'Zerstörendes' };
  const name = (s) => NAMEN[String(s).toUpperCase()] || String(s).toLowerCase();

  /** Kurztext für den Knopf: was fragt? Z. B. „Zerstörendes fragt“. */
  function freigabeText(pflicht) {
    const liste = (Array.isArray(pflicht) && pflicht.length ? pflicht : ['DESTRUCTIVE']).map(name);
    return `${liste.join(', ')} fragt`;
  }

  function startModus(knopf, menue, opts) {
    opts = opts || {};
    let letzter = { pflicht: ['DESTRUCTIVE'], sendeArt: 'folgen' };
    let gezeichnet = false;
    const w = FP.createWaehler(knopf, menue, {
      beschriftung: 'Modus der Sitzung',
      beiWahl: (wert, gruppe) => {
        if (gruppe === 'sendeart' && opts.beiSendeArt) opts.beiSendeArt(wert);
        else if (gruppe === 'freigabe' && opts.beiFreigabe) opts.beiFreigabe(wert);
      },
    });
    /** modus: { pflicht: [...], sendeArt: 'folgen' | 'steuern' } (fehlende Teile bleiben beim letzten Stand). */
    function zeichne(modus) {
      const neu = { ...letzter, ...(modus || {}) };
      if (gezeichnet && JSON.stringify(neu) === JSON.stringify(letzter)) return; // die Statuszeile ruft jede Sekunde: eine offene Liste nicht neu bauen
      gezeichnet = true;
      letzter = neu;
      const pflicht = Array.isArray(letzter.pflicht) && letzter.pflicht.length ? letzter.pflicht : ['DESTRUCTIVE'];
      const steuern = letzter.sendeArt === 'steuern';
      knopf.textContent = `${freigabeText(pflicht)}${steuern ? ' · greift ein' : ''}`;
      knopf.title = `Freigabe: ${freigabeText(pflicht)}. Während der Arbeit: ${steuern ? 'Nachrichten greifen sofort ein' : 'Nachrichten werden eingereiht'}.`;
      w.setze([
        {
          id: 'freigabe',
          titel: 'Freigabe',
          punkte: [
            {
              wert: 'pflicht',
              text: `Werkzeuge laufen durch, nur ${pflicht.map(name).join(', ')} fragt`,
              hilfe: 'Je Aktion einzeln, mit sichtbarem Befehl. Der Runner kennt keinen anderen Modus; geändert wird das in seiner Konfiguration, nicht je Sitzung.',
              gewaehlt: true,
              gesperrt: true,
            },
          ],
        },
        {
          id: 'sendeart',
          titel: 'Nachricht, während der Agent arbeitet',
          punkte: [
            { wert: 'folgen', text: 'Einreihen', hilfe: 'Die Nachricht wartet, bis der laufende Zug zu Ende ist.', gewaehlt: !steuern },
            { wert: 'steuern', text: 'Eingreifen', hilfe: 'Die Nachricht wirkt sofort im laufenden Zug.', gewaehlt: steuern },
          ],
        },
      ]);
    }
    zeichne(null);
    return { zeichne, setze: (o) => (o ? w.oeffne() : w.schliesse(false)), waehler: w, freigabeText };
  }
  FP.startModus = startModus;
})(typeof globalThis !== 'undefined' ? globalThis : window);
