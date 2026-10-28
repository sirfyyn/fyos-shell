/* Prüfskript für tools/e2e_agent.py. Läuft NUR, wenn Rust es meldet (ziel_info.e2e: Debug-Bau und Umgebung FYOS_SHELL_AGENT_E2E=1).
 * Es bedient die echte Chat-Oberfläche wie ein Nutzer (Nachrichten senden, Knopf „Erlauben“ drücken) und meldet jedes Ergebnis über die Brücke
 * an die Runner-Attrappe (POST /api/e2e/ergebnis); die Prüfung selbst liest das Protokoll der Attrappe. Kein Netz der Seite, keine Geheimnisse. */
(function () {
  'use strict';
  const tauri = window.__TAURI__;
  const chat = window.__chat;
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
  const text = () => $('spalte').innerText.replace(/[\u00a0\s]+/g, ' ');
  const zaehle = (haystack, nadel) => haystack.split(nadel).length - 1;
  const knoepfe = (titel) => [...document.querySelectorAll('.fz-knoepfe button')].filter((b) => b.textContent.trim().startsWith(titel));

  async function lauf() {
    await melde('seite-geladen', true, document.title);
    const verbunden = await warte(() => chat.S.verbunden && chat.S.id !== null, 20000);
    await melde('verbunden', verbunden, chat.S.verbunden ? 'ja' : 'nein');

    await chat.sende('streaming');
    const teilweise = await warte(() => text().includes('Antwort Teil 1') && !text().includes('Antwort Ende'), 15000);
    await melde('streaming-teilweise', teilweise, 'Text erscheint vor dem Ende');
    await melde('streaming-ganz', await warte(() => text().includes('Antwort Ende'), 15000), text().slice(-80));

    await chat.sende('werkzeug');
    await melde('werkzeugkarte', await warte(() => document.querySelector('.karte') && text().includes('Werkzeug fertig.')), 'Karte und Antwort');

    await chat.sende('freigabe');
    const erlauben = await warte(() => knoepfe('Erlauben').length === 1, 15000);
    await melde('freigabe-karte', erlauben, 'Karte mit Knopf Erlauben');
    await melde('freigabe-nur-erlauben-ablehnen', erlauben && document.querySelectorAll('.fz-knoepfe button').length === 2 && knoepfe('Ablehnen').length === 1, 'genau zwei Knöpfe');
    if (erlauben) knoepfe('Erlauben')[0].click();
    const erteilt = await warte(() => text().includes('Freigabe erteilt.'), 15000);
    await melde('freigabe-erteilt', erteilt, text().slice(-80));

    await chat.sende('reset');
    await melde('reset-marker', await warte(() => document.querySelector('.marker')), 'Marker im Verlauf');

    await chat.sende('lang');
    await warte(() => text().includes('Lang 3 '), 15000);
    await api('POST', '/api/e2e/kappen', {}).catch(() => {});
    const ganz = await warte(() => text().includes('Lang 12'), 30000);
    await melde('neuverbunden-vollstaendig', ganz, 'Text nach dem Abbruch komplett');
    await melde('neuverbunden-nichts-doppelt', zaehle(text(), 'Lang 3 Lang 4') === 1 && zaehle(text(), 'Lang 12') === 1, `Lang 3/4: ${zaehle(text(), 'Lang 3 Lang 4')}x, Lang 12: ${zaehle(text(), 'Lang 12')}x`);
    await melde('ende', true, '');
  }
  lauf().catch((f) => melde('abgebrochen', false, (f && f.message) || f));
})();
