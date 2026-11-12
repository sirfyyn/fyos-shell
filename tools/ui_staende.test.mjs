// Stände und Zurückspulen in der Agent-Oberfläche (Paket A5, dritter Teil in FYOS-AGENT-LOKAL-PLAN): die Tafel „Änderungen“ der Schiene
// (staende-tafel.js), die Zeile „Stand … Hierher zurück“ unter den Nachrichten und die zurückgenommenen Züge im Gespräch (chat-renderer.js,
// runner-adapter.js). jsdom wie in ui_agent.test.mjs: über FYOS_JSDOM_DIR (Ordner mit node_modules/jsdom) oder ein benachbartes fyos-web.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HIER, '..', 'app', 'ui', 'agent');
const lies = (n) => fs.readFileSync(path.join(UI, n), 'utf8');

function findeJsdom() {
  for (const k of [process.env.FYOS_JSDOM_DIR, path.join(HIER, '..', '..', '..', '..', 'fyos-web')].filter(Boolean)) {
    try {
      return createRequire(path.join(k, 'x.js'))('jsdom');
    } catch {
      /* nächster */
    }
  }
  return null;
}
const jsdom = findeJsdom();
const dom = (name, fn) => test(name, { skip: jsdom ? false : 'jsdom nicht gefunden (FYOS_JSDOM_DIR setzen)' }, fn);
const warte = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const bis = async (fn, frist = 3000) => {
  const ende = Date.now() + frist;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > ende) throw new Error(`Zeit abgelaufen: ${fn}`);
    await warte(10);
  }
};
function logik(...dateien) {
  const w = { FyosPrototyp: {} };
  for (const n of dateien) new Function('window', 'globalThis', lies(n))(w, w);
  return w.FyosPrototyp;
}
const uhr = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const ZEIT1 = Date.UTC(2026, 10, 11, 16, 31, 0);
const ZEIT2 = Date.UTC(2026, 10, 11, 16, 36, 0);
const ORDNER = '/arbeit/projekt';
const PATCH = '--- src/b.txt\n+++ src/b.txt\n@@ -1,3 +1,4 @@\n eins\n-zwei\n+ZWEI\n drei\n+vier\n';
const antwortStaende = (extra) => ({
  ok: true,
  ordner: ORDNER,
  dateien: [
    { pfad: `${ORDNER}/a.txt`, relativ: 'a.txt', zustand: 'neu', plus: 2, minus: 0, aenderungen: 2, fremd: false, gesichert: true },
    { pfad: `${ORDNER}/src/b.txt`, relativ: 'src/b.txt', zustand: 'geaendert', plus: 2, minus: 1, aenderungen: 2, fremd: false, gesichert: true },
  ],
  staende: [
    { id: '21', zeit: ZEIT1, titel: 'Erste Bitte', aenderungen: 2, dateien: 2, gespraech: true },
    { id: '30', zeit: ZEIT2, titel: 'Zweite Bitte', aenderungen: 2, dateien: 2, gespraech: true },
  ],
  gesamt: { dateien: 2, plus: 4, minus: 1 },
  ...extra,
});
const probeStand = (extra) => ({
  ok: true, probe: true, stand: '30', zeit: ZEIT2, gespraech: true, eintraege: 9,
  dateien: [{ pfad: `${ORDNER}/a.txt`, relativ: 'a.txt', aktion: 'wiederherstellen', fremd: false }, { pfad: `${ORDNER}/c.txt`, relativ: 'c.txt', aktion: 'loeschen', fremd: false }],
  ...extra,
});

test('Antworten des Runners werden bereinigt: feste Formen, Summen neu gerechnet, Unbekanntes fällt auf sichere Werte', () => {
  const W = logik('runner-wege.js').wege;
  const s = W.staendeBereinigen(antwortStaende());
  assert.deepEqual(s.dateien[1], { pfad: `${ORDNER}/src/b.txt`, relativ: 'src/b.txt', zustand: 'geaendert', plus: 2, minus: 1, aenderungen: 2, fremd: false, gesichert: true });
  assert.deepEqual(s.staende[0], { id: '21', zeit: ZEIT1, titel: 'Erste Bitte', aenderungen: 2, dateien: 2, gespraech: true });
  assert.deepEqual(s.gesamt, { dateien: 2, plus: 4, minus: 1 });
  const schief = W.staendeBereinigen({
    dateien: [{ pfad: '/x/y.bin', zustand: 'quatsch', plus: null, minus: 'viele', aenderungen: -3, fremd: 'ja' }, { relativ: 'ohne-pfad' }, null, { pfad: 7 }],
    staende: [{ id: 30, zeit: 'gestern', titel: 5, aenderungen: 1.9, dateien: -1, gespraech: 'ja' }, { titel: 'ohne Kennung' }, { id: '' }],
    gesamt: { dateien: 99, plus: 99, minus: 99 },
  });
  assert.deepEqual(schief.dateien, [{ pfad: '/x/y.bin', relativ: '/x/y.bin', zustand: 'geaendert', plus: null, minus: null, aenderungen: 1, fremd: false, gesichert: true }]);
  assert.deepEqual(schief.staende, [{ id: '30', zeit: 0, titel: '', aenderungen: 1, dateien: 0, gespraech: false }]);
  assert.deepEqual(schief.gesamt, { dateien: 1, plus: 0, minus: 0 });
  assert.deepEqual(W.staendeBereinigen(null), { ordner: '', dateien: [], staende: [], gesamt: { dateien: 0, plus: 0, minus: 0 } });

  assert.deepEqual(W.staendeDiffBereinigen({ relativ: 'src/b.txt', patch: PATCH, plus: 2, minus: 1 }), { relativ: 'src/b.txt', patch: PATCH, plus: 2, minus: 1, grund: '' });
  assert.deepEqual(W.staendeDiffBereinigen({ relativ: 'bild.png', patch: null, grund: 'kein_text' }), { relativ: 'bild.png', patch: null, plus: null, minus: null, grund: 'kein_text' });
  assert.equal(W.staendeDiffBereinigen({ patch: { nicht: 'text' } }).patch, null);

  const z = W.zurueckBereinigen({ ok: true, gespraech: true, nachricht: 'Zweite Bitte', dateien: [{ relativ: 'a.txt', aktion: 'wiederhergestellt' }, { relativ: 'c.txt', aktion: 'erfunden', fremd: true }, { aktion: 'geloescht' }] });
  assert.deepEqual(z, { probe: false, gespraech: true, gespraechGrund: '', zeit: 0, eintraege: 0, nachricht: 'Zweite Bitte', dateien: [{ relativ: 'a.txt', aktion: 'wiederhergestellt', fremd: false }, { relativ: 'c.txt', aktion: 'unveraendert', fremd: true }] });
  assert.deepEqual(W.zurueckBereinigen(undefined), { probe: false, gespraech: false, gespraechGrund: '', zeit: 0, eintraege: 0, nachricht: '', dateien: [] });
});

test('Sicht der Tafel: Datei, Stand, Rückfrage und die Zeile im Gespräch, ohne Fenster', () => {
  const FP = logik('runner-adapter.js', 'runner-wege.js', 'staende-tafel.js');
  const S = FP.staende;
  assert.equal(FP.uhrzeit(ZEIT1), uhr(ZEIT1));
  assert.deepEqual([FP.uhrzeit(0), FP.uhrzeit(null), FP.uhrzeit('x')], ['', '', '']);

  assert.deepEqual(S.dateiSicht({ relativ: 'src/tief/b.txt', zustand: 'geaendert', plus: 2, minus: 1, fremd: false, gesichert: true }), {
    name: 'b.txt', ordner: 'src/tief', marke: '', zahlen: { plus: 2, minus: 1 }, hinweis: '', titel: 'src/tief/b.txt: geändert, 2 Zeilen dazu, 1 weg',
  });
  const neu = S.dateiSicht({ relativ: 'a.txt', zustand: 'neu', plus: null, minus: null, fremd: true, gesichert: false });
  assert.deepEqual([neu.name, neu.ordner, neu.marke, neu.zahlen, neu.hinweis], ['a.txt', '', 'neu', null, 'seitdem von Hand geändert · nicht gesichert, lässt sich nicht zurücknehmen']);
  assert.equal(S.dateiSicht({ relativ: 'weg.txt', zustand: 'geloescht', plus: 0, minus: 4 }).marke, 'gelöscht');

  assert.deepEqual(S.standSicht({ id: '30', zeit: ZEIT2, titel: 'Zweite Bitte', dateien: 2, gespraech: true }), { zeit: uhr(ZEIT2), titel: 'Zweite Bitte', meta: '2 Dateien', kurz: `Stand ${uhr(ZEIT2)} · 2 Dateien` });
  assert.deepEqual(S.standSicht({ id: 'anfang', zeit: 0, titel: '', dateien: 1, gespraech: false }), { zeit: '', titel: 'Vor der ersten Änderung', meta: '1 Datei · nur Dateien', kurz: 'Stand · 1 Datei' });

  const W = FP.wege;
  const f = S.frageSicht({ art: 'stand', name: '17:36', probe: W.zurueckBereinigen(probeStand()) });
  assert.deepEqual(f, {
    titel: 'Zurück auf den Stand von 17:36?',
    dateien: [{ text: 'a.txt wird wiederhergestellt', warn: false }, { text: 'c.txt wird gelöscht (der Agent hat sie angelegt)', warn: false }],
    zeilen: ['Das Gespräch danach bleibt lesbar, zählt aber nicht mehr. Deine Nachricht kommt zurück ins Eingabefeld.', 'Was ein Befehl geändert hat, geht nicht mit zurück.'],
    warnung: '', knopf: 'Zurücksetzen', nurDateien: true, nichts: false, trotzdem: false,
  });
  const fremd = S.frageSicht({ art: 'stand', name: '17:36', probe: W.zurueckBereinigen(probeStand({ gespraech: false, gespraechGrund: 'verdichtet', dateien: [{ relativ: 'a.txt', aktion: 'wiederherstellen', fremd: true }] })) });
  assert.deepEqual([fremd.knopf, fremd.trotzdem, fremd.nurDateien, fremd.dateien[0]], ['Trotzdem zurücksetzen', true, false, { text: 'a.txt wird wiederhergestellt · seitdem von Hand geändert', warn: true }]);
  assert.match(fremd.warnung, /überschrieben\. Der Runner sichert es vorher/);
  assert.match(fremd.zeilen[0], /geleert oder verdichtet: zurück gehen nur die Dateien/);
  const datei = S.frageSicht({ art: 'datei', name: 'b.txt', probe: W.zurueckBereinigen({ probe: true, gespraech: false, dateien: [{ relativ: 'src/b.txt', aktion: 'wiederherstellen' }] }) });
  assert.deepEqual([datei.titel, datei.knopf, datei.nurDateien, datei.zeilen], ['b.txt zurücknehmen?', 'Zurücknehmen', false, ['Das Gespräch bleibt, wie es ist. Der Agent erfährt es vor deiner nächsten Nachricht.']]);
  const nichts = S.frageSicht({ art: 'stand', name: '', probe: W.zurueckBereinigen({ probe: true, gespraech: false, gespraechGrund: 'schon_zurueck', dateien: [{ relativ: 'a.txt', aktion: 'unveraendert' }] }) });
  assert.deepEqual([nichts.titel, nichts.nichts, nichts.zeilen], ['Zurück auf den Stand?', true, ['Hier ist nichts zurückzusetzen.']]);
  // nur das Gespräch (keine Datei mehr anders): es gibt etwas zu tun, aber kein „Nur Dateien“
  const nurGespraech = S.frageSicht({ art: 'stand', name: '17:36', probe: W.zurueckBereinigen({ probe: true, gespraech: true, dateien: [] }) });
  assert.deepEqual([nurGespraech.nichts, nurGespraech.nurDateien, nurGespraech.zeilen.length], [false, false, 1]);

  const um = uhr(ZEIT2);
  assert.equal(FP.zurueckText({ art: 'stand', gespraech: true, standZeit: ZEIT2, dateien: [{ relativ: 'a.txt', aktion: 'wiederhergestellt' }, { relativ: 'b.txt', aktion: 'wiederhergestellt' }, { relativ: 'c.txt', aktion: 'geloescht' }] }), `Zurückgesetzt auf den Stand von ${um} · 2 Dateien wiederhergestellt · 1 gelöscht · das Gespräch geht hier weiter`);
  assert.equal(FP.zurueckText({ art: 'stand', gespraech: true, standZeit: null, dateien: [] }), 'Zurückgesetzt auf den Stand · das Gespräch geht hier weiter');
  assert.equal(FP.zurueckText({ art: 'stand', gespraech: false, standZeit: ZEIT2, dateien: [{ relativ: 'a.txt', aktion: 'wiederhergestellt' }, { relativ: 'gross.bin', aktion: 'nicht_gesichert' }] }), `Dateien auf den Stand von ${um} zurückgesetzt · 1 Datei wiederhergestellt · 1 nicht gesichert und unverändert · das Gespräch ist unverändert`);
  assert.equal(FP.zurueckText({ art: 'datei', gespraech: false, dateien: [{ relativ: 'src/b.txt', aktion: 'wiederhergestellt' }] }), 'src/b.txt zurückgenommen · das Gespräch ist unverändert');
  assert.equal(FP.zurueckText({ art: 'datei', dateien: [{ relativ: 'neu.txt', aktion: 'geloescht' }] }), 'neu.txt zurückgenommen (gelöscht) · das Gespräch ist unverändert');
  assert.equal(FP.zurueckText(null), 'Dateien auf den Stand zurückgesetzt · nichts zu ändern · das Gespräch ist unverändert');
});

/** Die Tafel im echten Gerüst der Seite, mit einem Runner aus dem Test: `get(pfad, z)` und `post(koerper, z)` liefern die Antworten. */
function tafel({ get, post } = {}) {
  const html = lies('chat.html');
  const d = new jsdom.JSDOM(html.replace(/<script[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, ''), { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = d.window;
  for (const s of ['markdown-strom.js', 'terminal.js', 'chat-renderer.js', 'runner-adapter.js', 'runner-wege.js', 'staende-tafel.js']) w.eval(lies(s));
  const FP = w.FyosPrototyp;
  const dok = w.document;
  const g = (id) => dok.getElementById(id);
  const z = { gets: [], posts: [], staende: [], zurueck: [], weg: [] };
  const transport = {
    api: async (methode, pfad, koerper) => {
      if (methode === 'GET') {
        z.gets.push(pfad);
        const r = typeof get === 'function' ? get(pfad, z) : get;
        if (r instanceof Error) throw r;
        return r;
      }
      z.posts.push([pfad, JSON.parse(JSON.stringify(koerper))]);
      const r = post(koerper, z);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  const t = FP.staende.createStaendeTafel(
    { knopf: g('schieneAenderungen'), marke: g('staendeMarke'), leer: g('staendeLeer'), dateien: g('staendeDateien'), staendeKopf: g('staendeKopf'), staende: g('staendeListe'), fuss: g('staendeFuss') },
    { wege: FP.wege.createWege(transport), transport, beiStaende: (l) => z.staende.push(l), beiZurueck: (r) => z.zurueck.push(r), beiWeg: (k) => z.weg.push(k) },
  );
  const q = (sel) => [...g('tafelAenderungen').querySelectorAll(sel)];
  return { w, dok, g, t, z, q, FP };
}
const httpFehler = (status, fehler) => Object.assign(new Error(`HTTP ${status}`), { status, fehler });

dom('Runner ohne Stände: der Knopf der Schiene bleibt weg; ein Netzfehler lässt den letzten Stand stehen', async () => {
  const ohne = tafel({ get: () => httpFehler(404, 'Unbekannte Route') });
  assert.equal(ohne.g('schieneAenderungen').hidden, true);
  ohne.t.setzeSitzung(7);
  await bis(() => ohne.z.weg.length);
  assert.deepEqual([ohne.z.weg, ohne.g('schieneAenderungen').hidden, ohne.t.kennt], [[false], true, false]);
  await ohne.t.neu();
  assert.equal(ohne.z.gets.length, 1, 'gefragt wird danach nicht mehr');
  // eine Antwort ohne die beiden Listen ist keine Antwort auf diese Frage (und heißt nicht „nichts geändert“)
  const fremd = tafel({ get: () => ({ ok: true }) });
  fremd.t.setzeSitzung(7);
  await bis(() => fremd.z.weg.length);
  assert.deepEqual([fremd.z.weg, fremd.g('schieneAenderungen').hidden], [[false], true]);

  let dran = 0;
  const netz = tafel({ get: () => (++dran === 2 ? Object.assign(new Error('weg'), { code: 'RUNNER_NICHT_ERREICHBAR' }) : antwortStaende()) });
  netz.t.setzeSitzung(7);
  await bis(() => netz.q('.st-datei').length === 2);
  await netz.t.neu();
  assert.deepEqual([netz.q('.st-datei').length, netz.g('schieneAenderungen').hidden], [2, false]);
});

dom('Tafel: geänderte Dateien mit Zahlen, Unterschied auf Klick, Stände neueste zuerst; Texte nur als Text', async () => {
  const boese = '<img src=x onerror="window.__xss=1">.txt';
  const { t, z, q, g, w } = tafel({
    get: (pfad) =>
      pfad.includes('/staende/diff')
        ? { ok: true, relativ: 'src/b.txt', patch: PATCH, plus: 2, minus: 1 }
        : antwortStaende({ dateien: [...antwortStaende().dateien, { pfad: `${ORDNER}/${boese}`, relativ: boese, zustand: 'geloescht', plus: 0, minus: 3, aenderungen: 1, fremd: true, gesichert: true }] }),
  });
  assert.equal(g('staendeLeer').hidden, false);
  t.setzeSitzung(7);
  await bis(() => q('.st-datei').length === 3);
  assert.deepEqual(z.gets, ['/api/gespraech/7/staende']);
  assert.deepEqual([g('schieneAenderungen').hidden, g('staendeMarke').hidden, g('staendeMarke').textContent, g('staendeLeer').hidden, g('staendeKopf').hidden, g('staendeFuss').hidden], [false, false, '3', true, false, false]);
  assert.deepEqual(q('.st-dname').map((e) => e.textContent), ['a.txt', 'b.txt', boese]);
  assert.deepEqual(q('.st-dordner').map((e) => e.textContent), ['src']);
  assert.deepEqual(q('.st-marke').map((e) => e.textContent), ['neu', 'gelöscht']);
  assert.deepEqual(q('.st-datei .st-hinweis').map((e) => e.textContent), ['seitdem von Hand geändert']);
  assert.equal(g('tafelAenderungen').querySelector('img'), null, 'ein Dateiname wird nie zu HTML');
  assert.equal(w.__xss, undefined);
  assert.match(q('.st-zahlen')[1].textContent, /\+2/);
  assert.match(q('.st-zahlen')[1].textContent, /[−-]1/);
  // Stände: der neueste zuerst
  assert.deepEqual(q('.st-stand-titel').map((e) => e.textContent), ['Zweite Bitte', 'Erste Bitte']);
  assert.deepEqual(q('.st-zeit').map((e) => e.textContent), [uhr(ZEIT2), uhr(ZEIT1)]);
  assert.deepEqual(q('.st-stand .st-hinweis').map((e) => e.textContent), ['2 Dateien', '2 Dateien']);
  // was unter den Nachrichten stehen soll
  assert.deepEqual(JSON.parse(JSON.stringify(z.staende.at(-1))), [{ id: '21', text: `Stand ${uhr(ZEIT1)} · 2 Dateien` }, { id: '30', text: `Stand ${uhr(ZEIT2)} · 2 Dateien` }]);

  // Unterschied: ein Klick auf den Namen lädt ihn und zeigt ihn mit Zeilennummern; ein zweiter Klick klappt zu
  q('.st-name')[1].click();
  assert.equal(q('.st-name')[1].getAttribute('aria-expanded'), 'true');
  await bis(() => q('.st-diff .diff-tabelle').length === 1);
  assert.equal(z.gets.at(-1), `/api/gespraech/7/staende/diff?pfad=${encodeURIComponent(`${ORDNER}/src/b.txt`).replace(/\./g, '%2E')}`);
  const zeilen = q('.st-diff .diff-tabelle tr').map((tr) => tr.textContent.replace(/\s+/g, ' ').trim());
  assert.ok(zeilen.some((x) => /ZWEI/.test(x)) && zeilen.some((x) => /zwei/.test(x)) && zeilen.some((x) => /vier/.test(x)), zeilen.join(' | '));
  q('.st-name')[1].click();
  assert.equal(q('.st-diff').length, 0);
});

dom('Hierher zurück: erst die Probe, dann die Rückfrage, dann das Zurücksetzen; „Nur Dateien“ lässt das Gespräch', async () => {
  let nach = false;
  const { t, z, q } = tafel({
    get: () => (nach ? antwortStaende({ dateien: [antwortStaende().dateien[1]], staende: [antwortStaende().staende[0]] }) : antwortStaende()),
    post: (k) => {
      if (k.probe) return probeStand();
      nach = true;
      return { ok: true, stand: '30', gespraech: k.gespraech !== false, nachricht: k.gespraech !== false ? 'Zweite Bitte' : null, dateien: [{ relativ: 'a.txt', aktion: 'wiederhergestellt' }, { relativ: 'c.txt', aktion: 'geloescht' }] };
    },
  });
  t.setzeSitzung(7);
  await bis(() => q('.st-stand').length === 2);
  q('.st-hin')[0].click();
  assert.equal(q('.st-frage').length, 1, 'während der Probe steht schon der Kasten da');
  await bis(() => q('.st-frage .st-ja').length === 1);
  assert.deepEqual(z.posts, [['/api/gespraech/7/zurueck', { stand: '30', probe: true }]]);
  assert.equal(q('.st-frage-titel')[0].textContent, `Zurück auf den Stand von ${uhr(ZEIT2)}?`);
  assert.deepEqual(q('.st-frage-dateien li').map((e) => e.textContent), ['a.txt wird wiederhergestellt', 'c.txt wird gelöscht (der Agent hat sie angelegt)']);
  assert.deepEqual(q('.st-frage-knoepfe button').map((b) => b.textContent), ['Zurücksetzen', 'Nur Dateien', 'Abbrechen']);
  assert.equal(q('.st-frage .st-ja')[0].classList.contains('primaer'), false, 'kein zweiter Knopf in der Signalfarbe');
  // Abbrechen: nichts geschieht
  q('.st-frage .st-nein')[0].click();
  assert.deepEqual([q('.st-frage').length, z.posts.length], [0, 1]);

  // noch einmal, diesmal zurücksetzen
  q('.st-hin')[0].click();
  await bis(() => q('.st-frage .st-ja').length === 1);
  q('.st-frage .st-ja')[0].click();
  await bis(() => z.zurueck.length === 1);
  assert.deepEqual(z.posts.at(-1), ['/api/gespraech/7/zurueck', { stand: '30' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(z.zurueck[0])), { probe: false, gespraech: true, gespraechGrund: '', zeit: 0, eintraege: 0, nachricht: 'Zweite Bitte', dateien: [{ relativ: 'a.txt', aktion: 'wiederhergestellt', fremd: false }, { relativ: 'c.txt', aktion: 'geloescht', fremd: false }] });
  await bis(() => q('.st-stand').length === 1);
  assert.deepEqual([q('.st-frage').length, q('.st-datei').length], [0, 1]);

  // „Nur Dateien“: das Gespräch bleibt
  nach = false;
  await t.neu();
  await bis(() => q('.st-stand').length === 2);
  t.oeffneStand('30');
  await bis(() => q('.st-frage .st-nur').length === 1);
  q('.st-frage .st-nur')[0].click();
  await bis(() => z.zurueck.length === 2);
  assert.deepEqual(z.posts.at(-1), ['/api/gespraech/7/zurueck', { stand: '30', gespraech: false }]);
  assert.deepEqual([z.zurueck[1].gespraech, z.zurueck[1].nachricht], [false, '']);
  assert.equal(t.oeffneStand('gibt-es-nicht'), false);
});

dom('Von Hand Geändertes: die Rückfrage warnt und sendet „trotzdem“; ein Fehler des Runners bleibt stehen, Esc schließt', async () => {
  let fehler = true;
  const { t, z, q, g, w } = tafel({
    get: () => antwortStaende({ dateien: [{ ...antwortStaende().dateien[1], fremd: true }] }),
    post: (k) => {
      if (k.probe) return { ok: true, probe: true, gespraech: false, dateien: [{ relativ: 'src/b.txt', aktion: 'wiederherstellen', fremd: true }] };
      if (fehler) return httpFehler(409, 'Der Agent arbeitet gerade. Erst anhalten, dann zurückspulen.');
      return { ok: true, gespraech: false, nachricht: null, dateien: [{ relativ: 'src/b.txt', aktion: 'wiederhergestellt' }] };
    },
  });
  t.setzeSitzung(7);
  await bis(() => q('.st-datei').length === 1);
  q('.st-zurueck')[0].click();
  await bis(() => q('.st-frage .st-ja').length === 1);
  assert.deepEqual(z.posts.at(-1), ['/api/gespraech/7/zurueck', { datei: `${ORDNER}/src/b.txt`, probe: true }]);
  assert.deepEqual([q('.st-frage-titel')[0].textContent, q('.st-frage .st-ja')[0].textContent, q('.st-frage .st-nur').length], ['b.txt zurücknehmen?', 'Trotzdem zurücknehmen', 0]);
  assert.match(q('.st-frage-warnung')[0].textContent, /von Hand geändert wurde, wird dabei überschrieben/);
  assert.equal(q('.st-frage-dateien li')[0].classList.contains('warn'), true);
  q('.st-frage .st-ja')[0].click();
  await bis(() => q('.st-frage-fehler').length === 1);
  assert.deepEqual(z.posts.at(-1), ['/api/gespraech/7/zurueck', { datei: `${ORDNER}/src/b.txt`, trotzdem: true }]);
  assert.equal(q('.st-frage-fehler')[0].textContent, 'Der Agent arbeitet gerade. Erst anhalten, dann zurückspulen.');
  assert.equal(z.zurueck.length, 0);
  // der Kasten bleibt offen, noch ein Versuch geht
  fehler = false;
  q('.st-frage .st-ja')[0].click();
  await bis(() => z.zurueck.length === 1);
  assert.equal(q('.st-frage').length, 0);

  // Esc schließt eine offene Rückfrage, ohne dass die Taste weiterwandert
  q('.st-zurueck')[0].click();
  await bis(() => q('.st-frage .st-ja').length === 1);
  let draussen = 0;
  w.document.addEventListener('keydown', () => (draussen += 1));
  q('.st-frage .st-ja')[0].dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.deepEqual([q('.st-frage').length, draussen], [0, 0]);

  // eine andere Sitzung: alles von vorn
  t.setzeSitzung(8);
  assert.equal(g('staendeMarke').hidden, true);
  await bis(() => z.gets.at(-1) === '/api/gespraech/8/staende');
});

/** Ansicht und Adapter wie im Gespräch. */
function ansicht(opts) {
  const d = new jsdom.JSDOM('<!doctype html><body><div id="verlauf"><div id="spalte"></div></div><button id="ende" hidden></button><div id="ansage"></div></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = d.window;
  for (const s of ['markdown-strom.js', 'terminal.js', 'chat-renderer.js', 'runner-adapter.js']) w.eval(lies(s));
  const FP = w.FyosPrototyp;
  const view = FP.createChatView(w.document.getElementById('spalte'), {
    scroller: w.document.getElementById('verlauf'), zumEnde: w.document.getElementById('ende'), ansage: w.document.getElementById('ansage'),
    raf: (f) => setTimeout(() => f(Date.now()), 0), caf: () => {}, setInterval: () => 1, clearInterval: () => {}, reduceMotion: () => true,
  });
  return { w, d: w.document, FP, view, adapter: FP.createRunnerAdapter(view, opts || {}) };
}
const mensch = (id, text, zeit) => ({ id, kind: 'fyos.mensch', data: { text, von: 'mensch', zeit }, model: [{ role: 'user', content: text }] });
const antwort = (id, text) => ({ id, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' }] });

dom('Gespräch: Stand unter der Nachricht, „Hierher zurück“ ruft mit der Kennung; nach dem Zurückspulen steht das Spätere blass da', async () => {
  const gemeldet = [];
  const { d, view, adapter } = ansicht({ onZurueck: (z) => gemeldet.push(z) });
  adapter.replay([mensch(21, 'Erste Bitte', ZEIT1), antwort(25, 'Erledigt eins.'), mensch(30, 'Zweite Bitte', ZEIT2), antwort(33, 'Erledigt zwei.')], false);
  view.flush();
  const nachrichten = () => [...d.querySelectorAll('.mensch')];
  assert.deepEqual(nachrichten().map((n) => n.dataset.eintrag), ['21', '30']);

  const geklickt = [];
  view.zeigeStaende([{ id: '21', text: 'Stand 17:31 · 2 Dateien' }, { id: '30', text: 'Stand 17:36 · 1 Datei' }], (id) => geklickt.push(id));
  view.flush();
  assert.deepEqual([...d.querySelectorAll('.mensch-stand .stand-text')].map((e) => e.textContent), ['Stand 17:31 · 2 Dateien', 'Stand 17:36 · 1 Datei']);
  d.querySelectorAll('.stand-knopf')[1].click();
  assert.deepEqual(geklickt, ['30']);
  // dieselbe Liste noch einmal: nichts doppelt; ein anderer Text zieht nach; ein Stand weniger nimmt die Zeile weg
  view.zeigeStaende([{ id: '21', text: 'Stand 17:31 · 3 Dateien' }], (id) => geklickt.push(id));
  view.flush();
  assert.deepEqual([...d.querySelectorAll('.mensch-stand .stand-text')].map((e) => e.textContent), ['Stand 17:31 · 3 Dateien']);
  view.zeigeStaende([{ id: '21', text: 'Stand 17:31 · 3 Dateien' }, { id: '30', text: 'Stand 17:36 · 1 Datei' }], (id) => geklickt.push(id));
  view.flush();
  assert.equal(d.querySelectorAll('.mensch-stand').length, 2);

  // der Runner meldet ein Zurückspulen vor die zweite Bitte (live): alles ab ihr steht blass da, ihr Stand ist weg, darunter die Zeile
  adapter.apply({ type: 'entry_appended', entry: { id: 42, kind: 'fyos.zurueck', data: { art: 'stand', stand: '30', ab: 30, gespraech: true, standZeit: ZEIT2, dateien: [{ relativ: 'a.txt', aktion: 'wiederhergestellt' }, { relativ: 'c.txt', aktion: 'geloescht' }] } } });
  view.flush();
  const kinder = [...d.getElementById('spalte').children];
  assert.deepEqual(kinder.map((k) => [k.classList.contains('mensch') ? 'mensch' : k.classList.contains('zug') ? 'zug' : 'marke', k.classList.contains('zurueckgenommen')]), [
    ['mensch', false], ['zug', false], ['mensch', true], ['zug', true], ['marke', false],
  ]);
  assert.equal(d.querySelectorAll('.mensch-stand').length, 1, 'der Stand der zurückgenommenen Nachricht ist weg');
  const marke = kinder.at(-1);
  assert.deepEqual([marke.dataset.kind, marke.querySelector('.marker-text').textContent], ['zurueck', `Zurückgesetzt auf den Stand von ${uhr(ZEIT2)} · 1 Datei wiederhergestellt · 1 gelöscht · das Gespräch geht hier weiter`]);
  assert.deepEqual(JSON.parse(JSON.stringify(gemeldet)), [{ gespraech: true, live: true }]);
  // eine zurückgenommene Nachricht bekommt keinen Stand mehr, auch wenn die Liste ihn noch nennt
  view.zeigeStaende([{ id: '21', text: 'Stand 17:31 · 3 Dateien' }, { id: '30', text: 'Stand 17:36 · 1 Datei' }], () => {});
  view.flush();
  assert.equal(d.querySelectorAll('.mensch-stand').length, 1);

  // danach geht das Gespräch weiter: die neue Nachricht und ihre Antwort sind nicht blass
  adapter.replay([mensch(44, 'Dritte Bitte', ZEIT2 + 60000), antwort(47, 'Erledigt drei.')], false);
  view.flush();
  const danach = [...d.getElementById('spalte').children].slice(-2);
  assert.deepEqual(danach.map((k) => k.classList.contains('zurueckgenommen')), [false, false]);
});

dom('Gespräch: beim Öffnen eines Verlaufs mit Zurückspulen steht alles gleich so da; nur Dateien zurück lässt das Gespräch, wie es ist', () => {
  const gemeldet = [];
  const { d, view, adapter } = ansicht({ onZurueck: (z) => gemeldet.push(z) });
  adapter.replay(
    [
      mensch(21, 'Erste Bitte', ZEIT1), antwort(25, 'Erledigt eins.'),
      { id: 27, kind: 'fyos.zurueck', data: { art: 'datei', gespraech: false, dateien: [{ relativ: 'src/b.txt', aktion: 'wiederhergestellt' }] } },
      mensch(30, 'Zweite Bitte', ZEIT2), antwort(33, 'Erledigt zwei.'),
      { id: 42, kind: 'fyos.zurueck', data: { art: 'stand', stand: '30', ab: 30, gespraech: true, standZeit: ZEIT2, dateien: [] } },
      mensch(44, 'Dritte Bitte', ZEIT2 + 60000), antwort(47, 'Erledigt drei.'),
      { id: 50, kind: 'fyos.zurueck', data: { art: 'stand', stand: '44', gespraech: false, standZeit: ZEIT2 + 60000, dateien: [{ relativ: 'a.txt', aktion: 'wiederhergestellt' }] } },
    ],
    false,
  );
  view.flush();
  const kinder = [...d.getElementById('spalte').children];
  const art = (k) => (k.classList.contains('mensch') ? 'mensch' : k.classList.contains('zug') ? 'zug' : 'marke');
  assert.deepEqual(kinder.map((k) => `${art(k)}${k.classList.contains('zurueckgenommen') ? '*' : ''}`), ['mensch', 'zug', 'marke', 'mensch*', 'zug*', 'marke', 'mensch', 'zug', 'marke']);
  assert.deepEqual(kinder.filter((k) => art(k) === 'marke').map((k) => k.querySelector('.marker-text').textContent), [
    'src/b.txt zurückgenommen · das Gespräch ist unverändert',
    `Zurückgesetzt auf den Stand von ${uhr(ZEIT2)} · das Gespräch geht hier weiter`,
    `Dateien auf den Stand von ${uhr(ZEIT2 + 60000)} zurückgesetzt · 1 Datei wiederhergestellt · das Gespräch ist unverändert`,
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(gemeldet)), [{ gespraech: false, live: false }, { gespraech: true, live: false }, { gespraech: false, live: false }]);
});

dom('Zurückspulen von Dateien und Gespräch nimmt auch die Datei-Werkzeuge ab dort aus der Zählung; nur das Gespräch zurück nicht', () => {
  const schreiben = (id, call, pfad) => [
    { id, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: call, name: 'write', arguments: { path: pfad, content: 'x\n' } }], stopReason: 'toolUse' }] },
    { id: id + 1, kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: call, toolName: 'write', content: [{ type: 'text', text: `Successfully wrote to ${pfad}` }], isError: false }] },
  ];
  const gerufen = [];
  const { view, adapter } = ansicht({ onWerkzeug: (a) => gerufen.push(a === null ? 'neu' : a.name) });
  adapter.replay([mensch(21, 'Erste Bitte', ZEIT1), ...schreiben(22, 'r1', 'a.txt'), mensch(30, 'Zweite Bitte', ZEIT2), ...schreiben(31, 'r2', 'b.txt'), ...schreiben(33, 'r3', 'c.txt')], false);
  view.flush();
  assert.deepEqual([...adapter.aufrufe()].map((a) => a.args.path), ['a.txt', 'b.txt', 'c.txt']);
  // nur das Gespräch zurück (keine Datei angefasst): die Dateien sind noch geändert, die Zählung bleibt
  adapter.apply({ type: 'entry_appended', entry: { id: 40, kind: 'fyos.zurueck', data: { art: 'stand', stand: '30', ab: 30, gespraech: true, dateien: [] } } });
  assert.equal(adapter.aufrufe().length, 3);
  // Dateien und Gespräch zurück: was ab der Nachricht geschrieben wurde, zählt nicht mehr
  adapter.apply({ type: 'entry_appended', entry: { id: 41, kind: 'fyos.zurueck', data: { art: 'stand', stand: '30', ab: 30, gespraech: true, dateien: [{ relativ: 'b.txt', aktion: 'geloescht' }, { relativ: 'c.txt', aktion: 'geloescht' }] } } });
  view.flush();
  assert.deepEqual([...adapter.aufrufe()].map((a) => a.args.path), ['a.txt']);
  assert.deepEqual(gerufen, ['write', 'write', 'write', 'neu']);
});

dom('Panel „Änderungen der Sitzung“: führt der Runner Stände, zählt dort nur, was er als geändert nennt', () => {
  const html = lies('chat.html');
  const d = new jsdom.JSDOM(html.replace(/<script[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, ''), { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = d.window;
  for (const s of ['markdown-strom.js', 'terminal.js', 'chat-renderer.js', 'aenderungen.js']) w.eval(lies(s));
  const g = (id) => w.document.getElementById(id);
  let genau = null;
  const a = w.FyosPrototyp.createAenderungen(
    { knopf: g('aenderungenKnopf'), zahl: g('aenderungenZahl'), panel: g('aenderungenPanel'), zu: g('aenderungenZu'), reiter: g('aenderungenReiter'), reiterListe: g('aenderungenReiterListe'), reiterBaum: g('aenderungenReiterBaum'), inhalt: g('aenderungenInhalt') },
    { nurDiese: () => genau },
  );
  const aufrufe = [{ name: 'write', args: { path: 'a.txt', content: 'x\n' }, status: 'fertig' }, { name: 'write', args: { path: 'src/b.txt', content: 'y\n' }, status: 'fertig' }];
  // Runner ohne Stände: wie bisher aus dem Verlauf abgeleitet
  a.setze(aufrufe, ORDNER, 7);
  assert.deepEqual([g('aenderungenZahl').textContent, a.dateien().length, a.beruehrt().length], ['2', 2, 2]);
  // der Runner nennt nur noch eine Datei als geändert (die andere wurde zurückgenommen)
  genau = new Set(['src/b.txt']);
  a.setze(aufrufe, ORDNER, 7);
  assert.deepEqual([g('aenderungenZahl').textContent, [...a.dateien()].map((x) => x.pfad), a.beruehrt().length], ['1', ['src/b.txt'], 2]);
  a.zeige(true);
  assert.match(g('aenderungenInhalt').querySelector('.ae-fuss').textContent, /Zurücknehmen und die Stände stehen in der Seitenleiste/);
  genau = new Set();
  a.setze(aufrufe, ORDNER, 7);
  assert.equal(g('aenderungenZahl').textContent, '0');
});

test('Quelltext: gelesen wird über runner-wege.js, Texte nur als Text, keine Signalfarbe', () => {
  const quelle = lies('staende-tafel.js');
  assert.doesNotMatch(quelle, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.doesNotMatch(quelle, /api\('GET'/, 'gelesen wird nur über runner-wege.js');
  assert.equal((quelle.match(/api\('POST'/g) || []).length, 2, 'zwei Anfragen: Probe und Zurücksetzen');
  const stil = lies('staende.css');
  assert.doesNotMatch(stil, /--akzent/);
  const seite = lies('chat.html');
  assert.match(seite, /<script src="staende-tafel\.js"><\/script>/);
  assert.match(seite, /<link rel="stylesheet" href="staende\.css">/);
  assert.match(seite, /id="schieneAenderungen"[^>]*hidden/);
});
