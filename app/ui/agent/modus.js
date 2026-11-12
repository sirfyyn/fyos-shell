/* Modus-Wähler in der Statuszeile. Gezeigt werden nur Modi, die es wirklich gibt:
 *
 *   Modus der Sitzung    Kennt der Runner einen Modus je Sitzung (die Sitzungsliste nennt ihn im Feld `modus`), ist er hier wählbar:
 *                        planen (nur lesen, dann Plan vorlegen), fragen (vor jeder Änderung), frei (nur Zerstörendes fragt), umgehen (nichts fragt).
 *                        Gewechselt wird mit PATCH /api/gespraech/<id> { modus } (opts.beiModus); der Runner sagt es dem Agenten vor der nächsten Nachricht.
 *   Freigabe             Ein Runner ohne Modus je Sitzung hält nur Zerstörendes zurück (security.freigabePflicht, Standard DESTRUCTIVE). Das ist seine
 *                        Konfiguration: dann steht hier eine Zeile als Anzeige, nicht wählbar.
 *   Während der Arbeit   Wie eine Nachricht behandelt wird, wenn der Agent gerade arbeitet: „folgen“ (einreihen, der Standard) oder „steuern“ (greift sofort ein).
 *                        Das ist die Art der Nachricht (POST …/nachricht, Feld `art`) und gilt je Sitzung in diesem Fenster; Strg/Cmd+Enter greift weiter einmalig ein.
 *
 * Kein erfundener Modus: was der Runner nicht kennt, steht nicht zur Wahl.
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  const NAMEN = { DESTRUCTIVE: 'Zerstörendes' };
  const name = (s) => NAMEN[String(s).toUpperCase()] || String(s).toLowerCase();

  /** Die Modi einer Sitzung, in der Reihenfolge von vorsichtig nach frei. `kurz` steht auf dem Knopf. */
  const SITZUNGSMODI = [
    { wert: 'planen', text: 'Planen', kurz: 'Planen', hilfe: 'Nur lesen und nachsehen. Der Agent legt einen Plan vor; erst nach deinem Ja ändert er etwas.' },
    { wert: 'fragen', text: 'Vor Änderungen fragen', kurz: 'Fragt vor Änderungen', hilfe: 'Vor jeder Datei, die er schreibt, und jedem Befehl, der mehr tut als lesen, wartet der Aufruf auf dich.' },
    { wert: 'frei', text: 'Frei, Zerstörendes fragt', kurz: 'Zerstörendes fragt', hilfe: 'Er arbeitet ohne Rückfragen. Nur Löschen, Überschreiben und nicht Rückholbares hält an.' },
    { wert: 'umgehen', text: 'Berechtigungen umgehen', kurz: 'Berechtigungen umgehen', hilfe: 'Nichts fragt mehr, auch Zerstörendes läuft sofort. Nur was den Rechner als Ganzes träfe, fragt weiter.' },
  ];
  const sitzungsModus = (m) => SITZUNGSMODI.find((x) => x.wert === m) || null;

  /** Kurztext für den Knopf: was fragt? Z. B. „Zerstörendes fragt“. */
  function freigabeText(pflicht) {
    const liste = (Array.isArray(pflicht) && pflicht.length ? pflicht : ['DESTRUCTIVE']).map(name);
    return `${liste.join(', ')} fragt`;
  }

  /** Der Modus neben „planen“, in den Strg/Cmd+Umschalt+P zurückwechselt: der zuletzt gewählte andere, sonst „frei“. */
  function planUmschalten(jetzt, davor) {
    if (jetzt !== 'planen') return 'planen';
    return sitzungsModus(davor) && davor !== 'planen' ? davor : 'frei';
  }

  function startModus(knopf, menue, opts) {
    opts = opts || {};
    let letzter = { pflicht: ['DESTRUCTIVE'], sendeArt: 'folgen', sitzung: null, wechselt: false };
    let gezeichnet = false;
    const w = FP.createWaehler(knopf, menue, {
      beschriftung: 'Modus der Sitzung',
      beiWahl: (wert, gruppe) => {
        if (gruppe === 'sendeart' && opts.beiSendeArt) return opts.beiSendeArt(wert);
        if (gruppe === 'sitzungsmodus' && opts.beiModus) return opts.beiModus(wert);
        if (gruppe === 'freigabe' && opts.beiFreigabe) return opts.beiFreigabe(wert);
        return undefined;
      },
    });
    /**
     * modus: { pflicht: [...], sendeArt: 'folgen' | 'steuern', sitzung: 'planen' | 'fragen' | 'frei' | 'umgehen' | null, wechselt: boolean }
     * (fehlende Teile bleiben beim letzten Stand). `sitzung: null`: der Runner kennt keinen Modus je Sitzung.
     */
    function zeichne(modus) {
      const neu = { ...letzter, ...(modus || {}) };
      if (gezeichnet && JSON.stringify(neu) === JSON.stringify(letzter)) return; // die Statuszeile ruft jede Sekunde: eine offene Liste nicht neu bauen
      gezeichnet = true;
      letzter = neu;
      const pflicht = Array.isArray(letzter.pflicht) && letzter.pflicht.length ? letzter.pflicht : ['DESTRUCTIVE'];
      const steuern = letzter.sendeArt === 'steuern';
      const sitzung = sitzungsModus(letzter.sitzung);
      const vorn = letzter.wechselt ? 'wechsle …' : sitzung ? sitzung.kurz : freigabeText(pflicht);
      knopf.textContent = `${vorn}${steuern ? ' · greift ein' : ''}`;
      knopf.dataset.modus = sitzung ? sitzung.wert : '';
      knopf.title = `${sitzung ? `Modus der Sitzung: ${sitzung.text}. ${sitzung.hilfe}` : `Freigabe: ${freigabeText(pflicht)}.`} Während der Arbeit: ${steuern ? 'Nachrichten greifen sofort ein' : 'Nachrichten werden eingereiht'}.`;
      const erste = sitzung
        ? {
            id: 'sitzungsmodus',
            titel: 'Modus der Sitzung',
            punkte: SITZUNGSMODI.map((m) => ({ wert: m.wert, text: m.text, hilfe: m.hilfe, gewaehlt: m.wert === sitzung.wert, gesperrt: !!letzter.wechselt })),
          }
        : {
            id: 'freigabe',
            titel: 'Freigabe',
            punkte: [
              {
                wert: 'pflicht',
                text: `Werkzeuge laufen durch, nur ${pflicht.map(name).join(', ')} fragt`,
                hilfe: 'Je Aktion einzeln, mit sichtbarem Befehl. Dieser Runner kennt keinen Modus je Sitzung; geändert wird das in seiner Konfiguration.',
                gewaehlt: true,
                gesperrt: true,
              },
            ],
          };
      w.setze([
        erste,
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
  FP.modus = { SITZUNGSMODI, sitzungsModus, planUmschalten, freigabeText };
})(typeof globalThis !== 'undefined' ? globalThis : window);
