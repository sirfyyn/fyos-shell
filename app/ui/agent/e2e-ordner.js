/* Prüfskript für tools/e2e_agent.py (Teil „Runner und Ordner“). Läuft NUR, wenn Rust es meldet (Debug-Bau, FYOS_SHELL_AGENT_E2E=1 und
 * FYOS_SHELL_AGENT_E2E_SKRIPT=e2e-ordner). Zwei Phasen, getrennt durch das Umschalten des Runners (die Seite lädt dabei neu; die Phase merkt sich
 * sessionStorage): Phase 1 am lokalen Runner (Systemdialog ersetzt der Prüfbau durch FYOS_SHELL_E2E_ORDNER), Phase 2 an einem entfernten (Ordnerbaum).
 * Jedes Ergebnis geht über die Brücke an den jeweils aktiven Runner (POST /api/e2e/ergebnis); die Prüfung liest deren Protokolle. */
(function () {
  'use strict';
  const tauri = window.__TAURI__;
  const $ = (id) => document.getElementById(id);
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
  const phase = () => window.sessionStorage.getItem('e2e-ordner-phase') || '1';

  async function neueSitzung(titel) {
    $('neueSitzung').click();
    $('neuTitel').value = titel;
  }
  async function anlegen(titel) {
    $('neuForm').requestSubmit();
    return warte(() => window.__arbeitsplatz.aktiv && $('titel').textContent === titel, 15000);
  }

  async function phase1() {
    await warte(() => window.__arbeitsplatz && window.__arbeitsplatz.aktiv, 30000);
    const optionen = [...$('runnerWahl').options].map((o) => o.value);
    await melde('runner-liste', optionen.includes('lokal') && optionen.includes('ferne') && $('runnerWahl').value === 'lokal', `${optionen.join(',')} aktiv=${$('runnerWahl').value}`);
    const gesund = await api('GET', '/api/health').then((h) => h.ok === true, () => false);
    await melde('lokaler-runner-laeuft', gesund, 'Gesundheit über die Brücke');
    await neueSitzung('Lokal E2E');
    const dialog = await warte(() => !$('ordnerKasten').hidden && !$('ordnerDialog').hidden && $('ordnerBaum').hidden, 10000);
    await melde('lokal-dialog-statt-baum', dialog, `kasten=${$('ordnerKasten').hidden} dialog=${$('ordnerDialog').hidden}`);
    $('ordnerDialog').click();
    const gewaehlt = await warte(() => $('ordnerGewaehlt').textContent.includes('projekt-lokal'), 10000);
    await melde('lokal-ordner-gewaehlt', gewaehlt, $('ordnerGewaehlt').textContent);
    const angelegt = await anlegen('Lokal E2E');
    await melde('lokal-sitzung-mit-ordner', angelegt && $('ordner').textContent === 'projekt-lokal', `${$('titel').textContent} / ${$('ordner').textContent}`);
    const inListe = await warte(() => [...document.querySelectorAll('.sitzung')].some((b) => b.title.includes('projekt-lokal') || b.querySelector('.sitzung-meta').textContent.includes('projekt-lokal')), 15000);
    await melde('ordner-in-liste', inListe, [...document.querySelectorAll('.sitzung-meta')].map((m) => m.textContent).join(' | '));
    await neueSitzung('x');
    const zuletzt = await warte(() => [...document.querySelectorAll('.zuletzt-knopf')].some((b) => b.title.endsWith('projekt-lokal')), 10000);
    await melde('zuletzt-benutzt', zuletzt, [...document.querySelectorAll('.zuletzt-knopf')].map((b) => b.title).join(','));
    $('neuAbbrechen').click();
    let abgelehnt = false;
    try {
      await api('POST', '/api/ordner/erlauben', { pfad: '/' });
    } catch (f) {
      abgelehnt = true;
    }
    await melde('erlauben-nicht-fuer-die-seite', abgelehnt, 'runner_anfrage lehnt den reservierten Weg ab');
    window.sessionStorage.setItem('e2e-ordner-phase', '2');
    await tauri.core.invoke('runner_wechseln', { id: 'ferne' });
  }

  async function phase2() {
    await warte(() => window.__arbeitsplatz && window.__arbeitsplatz.aktiv, 30000);
    await melde('wechsel-entfernt', $('runnerWahl').value === 'ferne', `aktiv=${$('runnerWahl').value}`);
    await neueSitzung('Baum E2E');
    const baum = await warte(() => $('ordnerBaum').querySelectorAll('.baum-name').length >= 1 && $('ordnerDialog').hidden, 10000);
    await melde('baum-wurzeln', baum, `${$('ordnerBaum').querySelectorAll('.baum-name').length} Wurzeln`);
    const wurzel = $('ordnerBaum').querySelector('.baum-name').dataset.pfad;
    $('ordnerBaum').querySelector('.baum-auf').click();
    const kinderDa = await warte(() => [...$('ordnerBaum').querySelectorAll('.baum-name')].some((b) => b.textContent === 'a'), 15000);
    await melde('baum-aufklappen', kinderDa,[...$('ordnerBaum').querySelectorAll('.baum-name')].map((b) => b.textContent).join(','));
    const a = [...$('ordnerBaum').querySelectorAll('.baum-name')].find((b) => b.textContent === 'a');
    if (a) {
      a.closest('li').querySelector('.baum-auf').click();
    }
    const t = await warte(() => !!$('ordnerBaum').querySelector('.baum-name[data-pfad$="tief"]'), 15000);
    if (t) $('ordnerBaum').querySelector('.baum-name[data-pfad$="tief"]').click();
    await melde('baum-auswahl', t && $('ordnerGewaehlt').textContent.endsWith('tief'), $('ordnerGewaehlt').textContent);
    const angelegt = await anlegen('Baum E2E');
    await melde('baum-sitzung-mit-ordner', angelegt && $('ordner').textContent === 'tief', `${$('titel').textContent} / ${$('ordner').textContent}`);
    const fehlerCode = async (pfad) => api('GET', `/api/ordner?pfad=${encodeURIComponent(pfad)}`).then(() => 'kein Fehler', (m) => (m && m.code) || String(m));
    const c1 = await fehlerCode('/');
    await melde('ausserhalb-403-klar', c1 === 'ORDNER_AUSSERHALB', c1);
    const c2 = await fehlerCode(`${wurzel}/gibt-es-nicht`);
    await melde('nicht-gefunden-404-klar', c2 === 'ORDNER_NICHT_GEFUNDEN', c2);
    await neueSitzung('x');
    const z = await warte(() => [...document.querySelectorAll('.zuletzt-knopf')].some((b) => b.title.endsWith('tief')), 10000);
    const fremd = [...document.querySelectorAll('.zuletzt-knopf')].some((b) => b.title.includes('projekt-lokal'));
    await melde('zuletzt-je-runner', z && !fremd, [...document.querySelectorAll('.zuletzt-knopf')].map((b) => b.title).join(','));
    $('neuAbbrechen').click();
    await melde('ende', true, 'fertig');
  }

  (phase() === '1' ? phase1() : phase2()).catch((f) => melde('abgebrochen', false, (f && f.message) || String(f)));
})();
