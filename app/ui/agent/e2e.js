/* Prüfskript für tools/e2e_agent.py. Läuft NUR, wenn Rust es meldet (ziel_info.e2e: Debug-Bau und Umgebung FYOS_SHELL_AGENT_E2E=1).
 * Es bedient die echte Chat-Oberfläche wie ein Nutzer (Nachrichten senden, Knopf „Erlauben“ drücken) und meldet jedes Ergebnis über die Brücke
 * an die Runner-Attrappe (POST /api/e2e/ergebnis); die Prüfung selbst liest das Protokoll der Attrappe. Kein Netz der Seite, keine Geheimnisse. */
(function () {
  'use strict';
  const tauri = window.__TAURI__;
  // Die sichtbare Sitzung wechselt; __chat liefert immer die aktuelle
  const chat = { get S() { return window.__chat.S; }, sende: (t, s) => window.__chat.sende(t, s) };
  const $ = (id) => document.getElementById(id);
  const spalteAktiv = () => document.querySelector('.pane.aktiv .spalte');
  const reihe = (id) => document.querySelector(`#sitzungsliste .sitzung[data-id="${id}"]`); // nur die Liste, nicht das Archiv
  const doppel = (el) => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  const api = (methode, pfad, koerper) => tauri.core.invoke('runner_anfrage', { methode, pfad, koerper: koerper === undefined ? null : koerper });
  const melde = (schritt, ok, detail) => api('POST', '/api/e2e/ergebnis', { schritt, ok: !!ok, detail: String(detail || '').slice(0, 300) }).catch(() => {});
  const warte = async (f, ms) => {
    const bis = Date.now() + (ms || 20000);
    while (Date.now() < bis) {
      try {
        if (f()) return true;
      } catch (e) {
        /* nächste Runde */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  const text = () => {
    const s = spalteAktiv();
    return s ? s.innerText.replace(/[\u00a0\s]+/g, ' ') : '';
  };
  // Zustand der Seite f\u00fcr Fehlermeldungen (hilft, wenn ein Schritt nicht ankommt)
  const lage = () => `hidden=${document.hidden} aktiv=${window.__arbeitsplatz && window.__arbeitsplatz.aktiv ? window.__arbeitsplatz.aktiv.id : '-'} busy=${window.__chat && window.__chat.view.busy} verbunden=${window.__chat && window.__chat.S.verbunden} text=\u2026${text().slice(-120)}`;
  const zaehle = (haystack, nadel) => haystack.split(nadel).length - 1;
  const knoepfe = (titel) => [...document.querySelectorAll('.fz-knoepfe button')].filter((b) => b.textContent.trim().startsWith(titel));

  async function lauf() {
    await melde('seite-geladen', true, document.title);
    const verbunden = await warte(() => chat.S.verbunden && chat.S.id !== null, 20000);
    await melde('verbunden', verbunden, chat.S.verbunden ? 'ja' : 'nein');
    // Die Seite öffnet die zuletzt benutzte Sitzung (im WebView gemerkt, bleibt von Lauf zu Lauf): der Prüflauf beginnt immer in Sitzung 1
    await window.__arbeitsplatz.wechsle(1);
    await warte(() => String(window.__arbeitsplatz.aktiv && window.__arbeitsplatz.aktiv.id) === '1' && window.__chat.S.verbunden, 20000);

    await chat.sende('streaming');
    const teilweise = await warte(() => text().includes('Antwort Teil 1') && !text().includes('Antwort Ende'), 15000);
    await melde('streaming-teilweise', teilweise, 'Text erscheint vor dem Ende');
    await melde('streaming-ganz', await warte(() => text().includes('Antwort Ende'), 15000), text().slice(-80));

    // Kontextanzeige: die Attrappe liefert wie der Runner eine Lebenszeitsumme (input 9,7 Mio., 193 Mio. gesendet), pro Antwort ihre usage (3500 Token) und
    // usage.context = { tokens, window } mit dem Fenster 262144 (Rhea): gezeigt wird die Füllung der letzten Antwort (1 % von 262,1k), nie die Summe als Kontext
    const ktx = $('kontext');
    const ktxOk = await warte(() => ktx.dataset.bekannt === '1', 15000);
    await melde('kontext-plausibel', ktxOk && $('kontextText').textContent === '1 %' && ktx.getAttribute('aria-valuenow') === '1' && /262,1k/.test($('kontextTitel').textContent) && /^gesamt 193 M ein/.test($('tokens').textContent) && !/9729|100 %/.test(document.querySelector('.statuszeile').textContent), `${$('kontextText').textContent} | ${$('kontextTitel').textContent} | ${$('tokens').textContent}`);

    // Einstellungen-Knopf: ruft den Befehl, ohne Fehlermeldung (das Fenster selbst prüft e2e_agent.py von außen)
    const eKnopf = $('einstellungenKnopf');
    eKnopf.click();
    await new Promise((r) => setTimeout(r, 1500));
    await melde('einstellungen-knopf', !eKnopf.hidden && $('einstellungenFehler').hidden && eKnopf.title.includes('Einstellungen'), `fehler verborgen=${$('einstellungenFehler').hidden} ${$('einstellungenFehler').textContent}`);

    await chat.sende('werkzeug');
    await melde('werkzeugkarte', await warte(() => document.querySelector('.karte') && text().includes('Werkzeug fertig.')), 'Karte und Antwort');

    await chat.sende('freigabe');
    const erlauben = await warte(() => knoepfe('Erlauben').length === 1, 15000);
    await melde('freigabe-karte', erlauben, 'Karte mit Knopf Erlauben');
    await melde('freigabe-nur-erlauben-ablehnen', erlauben && document.querySelectorAll('.fz-knoepfe button').length === 2 && knoepfe('Ablehnen').length === 1, 'genau zwei Knöpfe');
    if (erlauben) knoepfe('Erlauben')[0].click();
    const erteilt = await warte(() => text().includes('Freigabe erteilt.'), 15000);
    await melde('freigabe-erteilt', erteilt, text().slice(-80));

    { // Freigaben-Panel (eigener Block: eigene Namen)
    // je eine offene Freigabe in Sitzung 1 (Probe) und Sitzung 2 (hohes Risiko); Panel, Erlauben, Später, Sprung
    const ap = window.__arbeitsplatz;
    const panelKarten = () => [...document.querySelectorAll('#freigabenListe .fp-karte')];
    const alle = async () => (await api('GET', '/api/freigaben')).freigaben;
    // Live: das Abfragen alle 4 s ruht; die Zahl muss allein über den Aktivitätsstrom (/api/strom) nachkommen
    const fpObj = ap.freigaben;
    fpObj.stopp();
    const t0 = Date.now();
    await chat.sende('freigabe');
    await api('POST', '/api/gespraech/2/nachricht', { text: 'freigabe hoch' });
    const zahl2 = await warte(() => $('freigabenZahl').textContent === '2' && !$('freigabenKnopf').hidden, 15000);
    const dauer = Date.now() - t0;
    fpObj.start(); // Abfragen wieder an (Rückfall)
    await melde('freigaben-zahl', zahl2, `Zahl=${$('freigabenZahl').textContent} Knopf verborgen=${$('freigabenKnopf').hidden}`);
    await melde('freigaben-live-strom', zahl2 && dauer < 3500, `ohne Abfragen nach ${dauer} ms`);
    // Banner bei geschlossenem Panel; ein Klick öffnet das Panel
    const banner = $('freigabenBanner');
    await melde('freigaben-banner', !banner.hidden && $('freigabenPanel').hidden && banner.textContent === '2 Freigaben warten', `Banner verborgen=${banner.hidden} Text=${banner.textContent}`);
    banner.click();
    const zwei = await warte(() => panelKarten().length === 2, 5000);
    await melde('freigaben-banner-oeffnet-panel', zwei && !$('freigabenPanel').hidden && banner.hidden, `Panel verborgen=${$('freigabenPanel').hidden} Banner verborgen=${banner.hidden}`);
    const titel = panelKarten().map((k) => `${k.querySelector('.fp-sitzung-titel').textContent}/${k.dataset.risiko}`);
    await melde('freigaben-panel-alle-sitzungen', zwei && !$('freigabenPanel').hidden && titel.includes('Probe/low') && titel.includes('Zweite Sitzung/high') && panelKarten().some((k) => k.classList.contains('high')), titel.join(' · '));
    // Marke „zerstörerisch“ nur bei der hochriskanten Karte (der Runner setzt zerstoererisch bei hohem Risiko immer)
    const hochKarte = () => panelKarten().find((k) => k.dataset.risiko === 'high');
    const markiert = panelKarten().filter((k) => k.querySelector('.chip.zerst')).map((k) => k.dataset.risiko);
    await melde('freigaben-zerstoererisch-marke', markiert.length === 1 && markiert[0] === 'high' && hochKarte().querySelector('.chip.zerst').textContent === 'zerstörerisch', `markiert: ${markiert.join(',')}`);
    // Erlauben im Panel: die hochriskante Freigabe der Sitzung 2 (die Sitzung selbst ist gar nicht offen); zerstörerisch: erst „Wirklich erlauben“, mit Notiz
    const notizFeld = hochKarte().querySelector('.fp-notiz');
    notizFeld.value = 'Probelauf, nichts wird gelöscht.';
    notizFeld.dispatchEvent(new Event('input', { bubbles: true }));
    hochKarte().querySelector('.fp-erlauben').click();
    const wirklich = await warte(() => hochKarte() && hochKarte().querySelector('.fp-wirklich'), 5000);
    const nachErstem = (await alle()).filter((f) => f.status === 'offen').length;
    await melde('freigaben-zerstoererisch-zweite-bestaetigung', !!wirklich && nachErstem === 2, `Knopf Wirklich erlauben: ${!!wirklich}, offen beim Runner nach dem ersten Klick: ${nachErstem}`);
    if (wirklich) hochKarte().querySelector('.fp-wirklich').click();
    const eins = await warte(() => panelKarten().length === 1 && $('freigabenZahl').textContent === '1', 15000);
    const nachErlauben = (await alle()).map((f) => `${f.conversationId}:${f.status}`).sort().join(',');
    await melde('freigaben-erlauben-im-panel', eins && /2:erteilt/.test(nachErlauben) && /1:offen/.test(nachErlauben), nachErlauben);
    const entschieden = (await alle()).find((f) => f.conversationId === 2);
    await melde('freigaben-notiz-beim-runner', !!entschieden && entschieden.notiz === 'Probelauf, nichts wird gelöscht.' && entschieden.entschiedenVon === 'mensch', `notiz=${entschieden && entschieden.notiz}`);
    // Später: bleibt beim Runner offen und in der Zahl
    panelKarten()[0].querySelector('.fp-spaeter').click();
    const spaeter = await warte(() => panelKarten()[0] && panelKarten()[0].dataset.zustand === 'spaeter', 5000);
    const nachSpaeter = (await alle()).filter((f) => f.status === 'offen').length;
    await melde('freigaben-spaeter', spaeter && $('freigabenZahl').textContent === '1' && nachSpaeter === 1, `Zahl=${$('freigabenZahl').textContent} offen beim Runner=${nachSpaeter}`);
    // Sprung: aus Sitzung 2 in Sitzung 1, ohne Neuaufbau der Ansichten
    await ap.wechsle(2);
    await warte(() => String(ap.aktiv && ap.aktiv.id) === '2', 15000);
    const fpPane1 = ap.ansichten.get('1').pane;
    const fpPane2 = ap.ansichten.get('2').pane;
    panelKarten()[0].querySelector('.fp-sprung').click();
    const gesprungen = await warte(() => String(ap.aktiv && ap.aktiv.id) === '1' && $('freigabenPanel').hidden, 15000);
    await melde('freigaben-sprung', gesprungen, `aktiv=${ap.aktiv && ap.aktiv.id} Panel verborgen=${$('freigabenPanel').hidden}`);
    await melde('freigaben-sprung-ohne-neuaufbau', ap.ansichten.get('1') && ap.ansichten.get('1').pane === fpPane1 && ap.ansichten.get('2') && ap.ansichten.get('2').pane === fpPane2 && fpPane1.isConnected && fpPane2.isConnected, 'dieselben Ansichten (Elemente) wie vor dem Sprung');
    // die Karte im Verlauf der Sitzung entscheidet; Zahl und Knopf folgen
    const offeneKarte = () => spalteAktiv().querySelector('.freigabe[data-zustand="offen"] .fz-knoepfe button');
    const hatKarte = await warte(() => offeneKarte(), 15000);
    if (hatKarte) offeneKarte().click();
    const nachVerlauf = await warte(() => $('freigabenZahl').textContent === '0' && $('freigabenKnopf').hidden, 15000);
    await melde('freigaben-verlauf-zieht-nach', hatKarte && nachVerlauf, `Zahl=${$('freigabenZahl').textContent} Knopf verborgen=${$('freigabenKnopf').hidden}`);
    await warte(() => text().includes('Freigabe erteilt.'), 15000);
    }

    await chat.sende('reset');
    await melde('reset-marker', await warte(() => document.querySelector('.marker')), 'Marker im Verlauf');

    await chat.sende('lang');
    await warte(() => text().includes('Lang 3 '), 15000);
    await api('POST', '/api/e2e/kappen', {}).catch(() => {});
    const ganz = await warte(() => text().includes('Lang 12'), 30000);
    await melde('neuverbunden-vollstaendig', ganz, ganz ? 'Text nach dem Abbruch komplett' : lage());
    await melde('neuverbunden-nichts-doppelt', zaehle(text(), 'Lang 3 Lang 4') === 1 && zaehle(text(), 'Lang 12') === 1, `Lang 3/4: ${zaehle(text(), 'Lang 3 Lang 4')}x, Lang 12: ${zaehle(text(), 'Lang 12')}x ${JSON.stringify(text().slice(-150))}`);

    // --- Arbeitsplatz: Seitenleiste, Ordner, Terminal, Diff, Wechsel ---
    const liste = await warte(() => document.querySelectorAll('.sitzung').length >= 2 && reihe(2) && reihe(2).textContent.includes('Zweite Sitzung'), 15000);
    await melde('sitzungsliste', liste, [...document.querySelectorAll('.sitzung-titel')].map((x) => x.textContent).join('|'));
    await melde('ordner-im-kopf', $('ordner').textContent === 'standard' && $('ordner').title.includes('/probe/standard'), `${$('ordner').textContent} / ${$('ordner').title}`);

    await chat.sende('terminal');
    const term = await warte(() => spalteAktiv().querySelector('.terminal .an-gruen') && spalteAktiv().querySelector('.terminal .an-rot') && text().includes('Terminal fertig.'), 15000);
    const termEl = spalteAktiv() && spalteAktiv().querySelector('.terminal');
    const roh = termEl ? termEl.innerText : '';
    await melde('terminal-ansicht', term &&!roh.includes('[32m') && !roh.includes('\u001b') && roh.includes('rot Fehler') && roh.includes('./bauen.sh'), roh.slice(0, 120));
    await melde('terminal-fortschrittszeile', roh.includes('Fortschritt 100%') && !roh.includes('Fortschritt 10%'), roh.slice(-60));

    await chat.sende('diff');
    const diff = await warte(() => spalteAktiv().querySelectorAll('.diff').length >= 2 && text().includes('Diff fertig.'), 15000);
    const d = spalteAktiv().querySelector('.diff');
    await melde('diff-ansicht', diff && d.querySelector('tr.add') && d.querySelector('tr.del') && d.textContent.includes('src/probe.txt') && d.querySelector('.diff-tabelle[aria-label*="hinzugefügt"]'), d ? d.textContent.slice(0, 120) : 'kein Diff');

    { // Panel „Änderungen“: Liste, Diff, Vorschau und Baum aus den Datei-Werkzeugen der Sitzung (das Szenario „aenderungen“ der Attrappe, dazu die zwei Dateien des Szenarios „diff“)
    await chat.sende('aenderungen');
    const knopfOk = await warte(() => text().includes('Änderungen fertig.') && !$('aenderungenKnopf').hidden && $('aenderungenZahl').textContent === '3', 15000);
    await melde('aenderungen-knopf', knopfOk, `Knopf verborgen=${$('aenderungenKnopf').hidden} Zahl=${$('aenderungenZahl').textContent}`);
    $('aenderungenKnopf').click();
    const zeilen = () => [...document.querySelectorAll('#aenderungenInhalt .ae-datei')];
    const pfade = () => zeilen().map((z) => z.dataset.pfad).sort();
    const listeOk = await warte(() => !$('aenderungenPanel').hidden && pfade().length === 3, 5000);
    await melde('aenderungen-liste', listeOk && pfade().join(',') === 'neu.txt,notizen/plan.md,src/probe.txt' && zeilen().find((z) => z.dataset.pfad === 'notizen/plan.md').dataset.art === 'neu' && zeilen().find((z) => z.dataset.pfad === 'src/probe.txt').dataset.art === 'geaendert', pfade().join(','));
    document.querySelector('.ae-datei[data-pfad="notizen/plan.md"] .ae-auf').click();
    const diffOk = await warte(() => document.querySelectorAll('.ae-datei[data-pfad="notizen/plan.md"] .diff tr.add').length === 4, 5000);
    await melde('aenderungen-diff', diffOk && document.querySelectorAll('.ae-datei[data-pfad="notizen/plan.md"] .diff tr.del').length === 0 && /\+4/.test(document.querySelector('.ae-datei[data-pfad="notizen/plan.md"] .diffzahl').textContent), 'neue Datei mit 4 hinzugefügten Zeilen');
    document.querySelector('.ae-datei[data-pfad="notizen/plan.md"] .ae-name').click();
    const vorschauOk = await warte(() => document.querySelectorAll('#aenderungenInhalt .ae-code tr').length === 4, 5000);
    const zeilenText = [...document.querySelectorAll('#aenderungenInhalt .ae-code .code')].map((x) => x.textContent).join('|');
    await melde('aenderungen-vorschau', vorschauOk && zeilenText === '# Plan|erster Punkt|zweiter Punkt|dritter Punkt', zeilenText);
    document.querySelector('#aenderungenInhalt .ae-zurueck').click();
    $('aenderungenReiterBaum').click();
    const baumOk = await warte(() => document.querySelector('.ae-knoten[data-datei="src/probe.txt"]') && document.querySelector('.ae-knoten[data-ordner="notizen"]'), 5000);
    await melde('aenderungen-baum', !!baumOk && !!document.querySelector('.ae-knoten[data-datei="notizen/plan.md"]'), [...document.querySelectorAll('.ae-knoten')].map((b) => b.querySelector('.ae-dname').textContent).join('|'));
    ($('aenderungenInhalt').querySelector('.ae-knoten') || $('aenderungenZu')).focus();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await melde('aenderungen-esc', $('aenderungenPanel').hidden && !window.__chat.view.busy, `Panel verborgen=${$('aenderungenPanel').hidden}`);
    }

    // Wechsel: Sitzung 1 bleibt als dasselbe Element erhalten (kein Neuaufbau), Sitzung 2 hat einen eigenen Verlauf
    const pane1 = spalteAktiv();
    pane1.dataset.marke = 'bleibt';
    const karten1 = pane1.querySelectorAll('.karte').length;
    await chat.sende('lang');
    await warte(() => text().split('Lang 3 ').length >= 3, 15000); // zweiter Lauf hat begonnen
    reihe(2).click();
    const zwei = await warte(() => window.__arbeitsplatz.aktiv && String(window.__arbeitsplatz.aktiv.id) === '2' && $('ordner').textContent === 'alpha', 15000);
    await melde('wechsel-zu-zweiter', zwei, `Ordner ${$('ordner').textContent}`);
    await melde('wechsel-eigener-verlauf', zwei && !text().includes('Terminal fertig.') && !text().includes('Lang 3 '), text().slice(0, 80));
    const markiert = await warte(() => reihe(1) && reihe(1).dataset.laeuft === '1', 15000);
    await melde('laufende-sitzung-markiert', markiert, 'Sitzung 1 arbeitet im Hintergrund');
    await chat.sende('streaming');
    await warte(() => text().includes('Antwort Ende'), 15000);
    const frei = await warte(() => reihe(1) && reihe(1).dataset.laeuft === '0', 20000);
    await melde('markierung-endet', frei, 'Sitzung 1 nicht mehr als laufend markiert');
    reihe(1).click();
    const zurueck = await warte(() => window.__arbeitsplatz.aktiv && String(window.__arbeitsplatz.aktiv.id) === '1', 15000);
    const vollstaendig = await warte(() => text().split('Lang 12').length >= 3 && text().includes('Terminal fertig.'), 15000);
    await melde('wechsel-erhaelt-sitzung', zurueck && spalteAktiv() === pane1 && pane1.dataset.marke === 'bleibt' && pane1.querySelectorAll('.karte').length === karten1, `Karten ${pane1.querySelectorAll('.karte').length} von ${karten1}`);
    await melde('wechsel-nichts-doppelt', vollstaendig && text().split('Lang 12').length === 3 && text().split('Terminal fertig.').length === 2, `Lang 12: ${text().split('Lang 12').length - 1}x (erwartet 2: zwei Läufe)`);

    // Neue Sitzung mit Arbeitsordner
    $('neueSitzung').click();
    $('neuTitel').value = 'Neu E2E';
    $('neuOrdner').value = 'projekt';
    $('neuForm').requestSubmit();
    const neu = await warte(() => window.__arbeitsplatz.aktiv && String(window.__arbeitsplatz.aktiv.id) !== '1' && String(window.__arbeitsplatz.aktiv.id) !== '2' && $('titel').textContent === 'Neu E2E' && $('ordner').textContent === 'alpha', 15000);
    await melde('neue-sitzung', neu, `${$('titel').textContent} / ${$('ordner').textContent}`);

    // --- Benennen, Umbenennen, Archivieren: alles über die echte Brücke (PATCH geht durch runner_anfrage zur Attrappe) ---
    const taste = (ziel, key) => ziel.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const serverTitel = async (id) => {
      const r = await api('GET', '/api/gespraeche');
      const g = (r.gespraeche || []).find((x) => String(x.id) === String(id));
      return g ? g.titel : null;
    };
    const vorherId = String(window.__arbeitsplatz.aktiv.id);
    $('neueSitzung').click();
    $('neuTitel').value = 'Nur Name';
    taste($('neuTitel'), 'Enter'); // Enter im Namensfeld startet die Sitzung
    const benannt = await warte(() => window.__arbeitsplatz.aktiv && String(window.__arbeitsplatz.aktiv.id) !== vorherId && $('titel').textContent === 'Nur Name', 15000);
    const sid = benannt ? String(window.__arbeitsplatz.aktiv.id) : '';
    await melde('neue-sitzung-mit-namen', benannt && (await serverTitel(sid)) === 'Nur Name' && !!reihe(sid) && reihe(sid).querySelector('.sitzung-titel').textContent === 'Nur Name', `${$('titel').textContent} / Server: ${await serverTitel(sid)}`);

    // Umbenennen im Kopf (Doppelklick auf den Namen, Enter)
    const entwurf = 'noch nicht gesendet';
    $('eingabe').value = entwurf;
    const paneVorher = document.querySelector('.pane.aktiv');
    $('titel').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    const kopfFeld = $('titelEditor').querySelector('input');
    if (kopfFeld) {
      kopfFeld.value = 'Umbenannt E2E';
      taste(kopfFeld, 'Enter');
    }
    const kopfOk = await warte(() => $('titel').textContent === 'Umbenannt E2E' && $('titelEditor').hidden, 15000);
    await melde('umbenennen-kopf', kopfOk && (await serverTitel(sid)) === 'Umbenannt E2E' && reihe(sid).querySelector('.sitzung-titel').textContent === 'Umbenannt E2E', `${$('titel').textContent} / Server: ${await serverTitel(sid)}`);
    await melde('umbenennen-ohne-neuaufbau', document.querySelector('.pane.aktiv') === paneVorher && $('eingabe').value === entwurf, `Entwurf: ${$('eingabe').value}`);
    $('eingabe').value = '';

    // Esc bricht ab: nichts wird gesendet, der Name bleibt
    $('titelUmbenennen').click();
    const escFeld = $('titelEditor').querySelector('input');
    if (escFeld) {
      escFeld.value = 'Wird verworfen';
      taste(escFeld, 'Escape');
    }
    await melde('umbenennen-esc', !!escFeld && $('titelEditor').hidden && $('titel').textContent === 'Umbenannt E2E' && (await serverTitel(sid)) === 'Umbenannt E2E', $('titel').textContent);

    // Umbenennen in der Leiste (Doppelklick auf eine andere Sitzung)
    doppel(reihe(2).querySelector('.sitzung-titel'));
    const zeilenFeld = document.querySelector('.sitzung-editor .titel-eingabe');
    if (zeilenFeld) {
      zeilenFeld.value = 'Zweite umbenannt';
      taste(zeilenFeld, 'Enter');
    }
    const zeileOk = await warte(() => reihe(2) && reihe(2).querySelector('.sitzung-titel').textContent === 'Zweite umbenannt' && !document.querySelector('.titel-eingabe'), 15000);
    await melde('umbenennen-leiste', zeileOk && (await serverTitel(2)) === 'Zweite umbenannt' && $('titel').textContent === 'Umbenannt E2E', `Server: ${await serverTitel(2)}`);

    // Der Runner lehnt ab (unbekannte Sitzung): die Brücke meldet den Fehler mit Text
    let abgelehnt = null;
    try {
      await api('PATCH', '/api/gespraech/9999', { titel: 'x' });
    } catch (f) {
      abgelehnt = f;
    }
    await melde('umbenennen-fehler-klar', !!abgelehnt && abgelehnt.code === 'RUNNER_FEHLER' && /nicht gefunden/.test(String(abgelehnt.details || '')), JSON.stringify(abgelehnt));

    // Archivieren (Knopf an der Zeile): weg aus der Liste, im eingeklappten Archiv, die offene Sitzung weicht auf die Hauptsitzung aus
    reihe(sid).closest('.sitzung-zeile').querySelector('.archivieren').click();
    const weg = await warte(() => !reihe(sid) && $('archivKopf') && !$('archivKopf').hidden && String(window.__arbeitsplatz.aktiv.id) === '1', 15000);
    await melde('archivieren', weg && (await serverTitel(sid)) === null && $('archivListe').hidden && $('archivZahl').textContent === '1', `Archiv ${$('archivZahl').textContent}, aktiv ${window.__arbeitsplatz.aktiv.id}`);
    $('archivKopf').click();
    const imArchiv = !$('archivListe').hidden && $('archivListe').textContent.includes('Umbenannt E2E');
    $('archivListe').querySelector('.wiederherstellen').click();
    const zurueckInListe = await warte(() => reihe(sid) && $('archivZahl').textContent === '0', 15000); // der Runner kennt die Archivliste: der Abschnitt bleibt, leer
    await melde('wiederherstellen', imArchiv && zurueckInListe && (await serverTitel(sid)) === 'Umbenannt E2E', `im Archiv: ${imArchiv}, Server: ${await serverTitel(sid)}`);

    { // Archiv dauerhaft, Suche, Datei-Vorschau und Dateibaum über den Runner (docs/current/FYOS-AGENT-HUELLE.md, Abschnitt 9h)
    const ap = window.__arbeitsplatz;
    const tippe = (feld, wert) => {
      feld.value = wert;
      feld.dispatchEvent(new Event('input', { bubbles: true }));
    };
    // Archiv vom Runner: eine Sitzung wird NICHT über dieses Fenster archiviert (anderes Fenster, früherer Start); nach dem Laden der Liste steht sie im Archiv
    await api('PATCH', `/api/gespraech/${sid}`, { archiviert: true });
    await ap.ladeListe();
    const dauerhaft = await warte(() => !reihe(sid) && $('archivZahl').textContent === '1' && !$('archivKopf').hidden, 15000);
    if ($('archivListe').hidden) $('archivKopf').click();
    await melde('archiv-vom-runner', dauerhaft && $('archivListe').textContent.includes('Umbenannt E2E'), `Zahl=${$('archivZahl').textContent} Text=${$('archivListe').textContent.slice(0, 60)}`);

    // Suche: Treffer im Titel der archivierten Sitzung, Hervorhebung als <mark>, Marke „archiviert“; Klick wechselt dorthin mit Hinweis
    const feld = $('sucheFeld');
    feld.focus();
    tippe(feld, 'Umbenannt');
    await warte(() => document.querySelector(`.suche-treffer[data-id="${sid}"]`), 15000);
    const treffer = document.querySelector(`.suche-treffer[data-id="${sid}"]`);
    await melde('suche-treffer', !!treffer && !!treffer.querySelector('.suche-titel mark') && treffer.querySelector('.suche-titel mark').textContent.toLowerCase() === 'umbenannt' && !!treffer.querySelector('.suche-archiv') && $('leisteListe').classList.contains('suche-aktiv') && !document.querySelector('.suche-ergebnis img'), treffer ? treffer.textContent.slice(0, 80) : 'kein Treffer');
    if (treffer) treffer.click();
    const gewechselt = await warte(() => String(ap.aktiv && ap.aktiv.id) === String(sid) && text().includes('ist archiviert'), 15000);
    await melde('suche-archiv-treffer', gewechselt, `aktiv=${ap.aktiv && ap.aktiv.id} ${text().slice(-100)}`);
    feld.focus();
    feld.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await melde('suche-esc', feld.value === '' && !$('leisteListe').classList.contains('suche-aktiv') && $('sucheErgebnis').hidden, `Feld=${feld.value}`);
    // zurück in die Hauptsitzung und die Sitzung wiederherstellen
    await ap.wechsle(1);
    $('archivListe').querySelector('.wiederherstellen').click();
    await warte(() => reihe(sid) && $('archivZahl').textContent === '0', 15000);
    // Kürzel „/“ außerhalb eines Eingabefelds
    document.activeElement.blur();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
    await melde('kuerzel-suche', document.activeElement === feld, `aktiv=${document.activeElement && document.activeElement.id}`);
    feld.blur();

    // Dateibaum und Vorschau über den Runner: eine Sitzung mit Arbeitsordner im erfundenen Baum der Attrappe
    const neuSitzung = await api('POST', '/api/gespraeche', { titel: 'Dateien E2E', ordner: '/probe/ordner-a/projekt-eins' });
    const nid = String((neuSitzung.gespraech || neuSitzung).id);
    await ap.ladeListe();
    await ap.wechsle(nid);
    await warte(() => String(ap.aktiv && ap.aktiv.id) === nid && $('ordner').textContent === 'projekt-eins', 15000);
    const pa = ap.aenderungen;
    pa.zeige(true);
    $('aenderungenReiterBaum').click();
    const baumDa = await warte(() => document.querySelector('.ae-knoten[data-datei="README.md"]') && pa.lebend, 15000);
    const namen = () => [...document.querySelectorAll('#aenderungenInhalt .ae-knoten .ae-dname')].map((x) => x.textContent);
    await melde('baum-mit-dateien', !!baumDa && pa.lebend && namen().includes('lang.txt') && namen().includes('src') && namen().includes('docs') && !namen().includes('.env') && !namen().includes('server.pem') && !namen().includes('.versteckt'), namen().join('|'));
    document.querySelector('.ae-knoten[data-ordner="src"]').click();
    await warte(() => document.querySelector('.ae-knoten[data-datei="src/haupt.py"]'), 10000);
    const code = () => [...document.querySelectorAll('#aenderungenInhalt .ae-code .code')].map((x) => x.textContent).join('|');
    document.querySelector('.ae-knoten[data-datei="README.md"]').click();
    const readmeOk = await warte(() => code() === '# Probe|Hallo Welt', 10000);
    await melde('vorschau-ueber-weg', readmeOk && /aktuell vom Runner gelesen/.test(document.querySelector('#aenderungenInhalt .ae-quelle').textContent), code());
    document.querySelector('#aenderungenInhalt .ae-zurueck').click();
    document.querySelector('.ae-knoten[data-datei="src/haupt.py"]').click();
    const geschwaerzt = await warte(() => document.querySelector('#aenderungenInhalt .ae-geschwaerzt'), 10000);
    await melde('vorschau-geschwaerzt', geschwaerzt && code().includes('PASSWORD=***') && !code().includes('geheim123'), code());
    document.querySelector('#aenderungenInhalt .ae-zurueck').click();
    document.querySelector('.ae-knoten[data-datei="lang.txt"]').click();
    const gekuerzt = await warte(() => /Gekürzt/.test((document.querySelector('#aenderungenInhalt .ae-quelle') || {}).textContent || ''), 10000);
    await melde('vorschau-gekuerzt', gekuerzt, (document.querySelector('#aenderungenInhalt .ae-quelle') || {}).textContent);
    document.querySelector('#aenderungenInhalt .ae-zurueck').click();
    document.querySelector('.ae-knoten[data-datei="src/bild.png"]').click();
    await warte(() => document.querySelector('#aenderungenInhalt .ae-binaer'), 10000);
    const binaer = document.querySelector('#aenderungenInhalt .ae-binaer');
    await melde('vorschau-binaer', !!binaer && /^Binärdatei, \d+ Byte$/.test(binaer.textContent) && !document.querySelector('#aenderungenInhalt .ae-code'), binaer ? binaer.textContent : 'keine Anzeige');
    document.querySelector('#aenderungenInhalt .ae-zurueck').click();
    pa.oeffneVorschau('.env');
    await warte(() => document.querySelector('#aenderungenInhalt .ae-grund[data-grund="gesperrt"]'), 10000);
    const gesperrt = document.querySelector('#aenderungenInhalt .ae-grund[data-grund="gesperrt"]');
    await melde('vorschau-gesperrt', !!gesperrt && !document.querySelector('#aenderungenInhalt .ae-code') && !/Token/i.test($('aenderungenInhalt').textContent), gesperrt ? gesperrt.textContent : 'keine Meldung');
    pa.zeige(false);
    await ap.wechsle(1);
    }

    await melde('ende', true, '');
  }
  lauf().catch((f) => melde('abgebrochen', false, (f && f.message) || f));
})();
