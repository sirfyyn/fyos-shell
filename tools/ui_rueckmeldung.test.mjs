// Rückmeldung der Oberfläche (rueckmeldung.js, rueckmeldung.css): Wahl der Anzeige (kompakt, normal, detailliert), Töne zu den Momenten eines
// Zugs, kurze Meldung, Reaktionen unter einer Antwort. jsdom wie in ui_agent.test.mjs: über FYOS_JSDOM_DIR oder ein benachbartes fyos-web.
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
function logik(...dateien) {
  const w = { FyosPrototyp: {} };
  for (const n of dateien) new Function('window', 'globalThis', lies(n))(w, w);
  return w.FyosPrototyp;
}

// --- ohne Fenster ---------------------------------------------------------------------------------------------------------

test('Töne: aus schweigt; dezent meldet „braucht“ und „fertig“ nur, wenn das Fenster nicht vorn ist; deutlich meldet alles', () => {
  const { tonFuer } = logik('rueckmeldung.js').rueckmeldung;
  for (const m of ['gesendet', 'werkzeug', 'fehler', 'braucht', 'fertig']) assert.equal(tonFuer(m, { stufe: 'aus', vorn: false }), null);
  assert.equal(tonFuer('gesendet', { stufe: 'dezent', vorn: true }), 'gesendet');
  assert.equal(tonFuer('fehler', { stufe: 'dezent', vorn: true }), 'fehler');
  assert.equal(tonFuer('werkzeug', { stufe: 'dezent', vorn: false }), null, 'das Klicken je Werkzeug gibt es nur bei „deutlich“');
  assert.equal(tonFuer('braucht', { stufe: 'dezent', vorn: true }), null);
  assert.equal(tonFuer('braucht', { stufe: 'dezent', vorn: false }), 'braucht');
  assert.equal(tonFuer('fertig', { stufe: 'dezent', vorn: true }), null);
  assert.equal(tonFuer('fertig', { stufe: 'dezent', vorn: false }), 'fertig');
  for (const m of ['gesendet', 'werkzeug', 'fehler', 'braucht', 'fertig']) assert.equal(tonFuer(m, { stufe: 'deutlich', vorn: true }), m);
  assert.equal(tonFuer('unbekannt', { stufe: 'deutlich', vorn: false }), null);
  assert.equal(tonFuer('fertig', { stufe: 'laut', vorn: false }), null, 'eine unbekannte Stufe gilt als aus');
  assert.equal(tonFuer('fertig', null), null);
});

test('Wahl im Kreis und Texte der Reaktionen', () => {
  const R = logik('rueckmeldung.js').rueckmeldung;
  assert.deepEqual([R.naechste(R.ANZEIGEN, 'kompakt'), R.naechste(R.ANZEIGEN, 'normal'), R.naechste(R.ANZEIGEN, 'detail')], ['normal', 'detail', 'kompakt']);
  assert.equal(R.naechste(R.STUFEN, 'deutlich'), 'aus');
  assert.equal(R.naechste(R.STUFEN, 'gibt-es-nicht'), 'aus');
  assert.deepEqual(R.REAKTIONEN.map((x) => x.id), ['gut', 'nicht-gut', 'kuerzer', 'nochmal']);
  assert.deepEqual(R.REAKTIONEN.filter((x) => x.sendet).map((x) => x.id), ['kuerzer', 'nochmal'], 'nur die zwei Wünsche senden sofort');
  for (const x of R.REAKTIONEN) assert.ok(R.reaktionsText(x.id).length > 10, x.id);
  assert.equal(R.reaktionsText('fremd'), '');
});

test('Lage neben „bereit“: lokal zählt, ob das Modell antwortet; am vollen Runner, ob der Agent von selbst arbeiten darf', () => {
  const FP = logik('runner-wege.js', 'rueckmeldung.js');
  const { modellLage } = FP.rueckmeldung;
  assert.equal(modellLage(null), null);
  assert.equal(modellLage({ modell: null, arbeit: null }), null, 'meldet der Runner nichts dazu, steht nichts da');
  const gut = modellLage({ modell: { name: 'klein', antwortet: true } });
  assert.deepEqual([gut.stufe, gut.text], ['gut', '']);
  assert.match(gut.hinweis, /antwortet \(klein\)/);
  const weg = modellLage({ modell: { name: '', antwortet: false } });
  assert.deepEqual([weg.stufe, weg.text], ['warn', 'Modell antwortet nicht']);
  const wartet = modellLage({ modell: null, arbeit: { offen: false, warum: 'das Tor antwortet nicht' } });
  assert.deepEqual([wartet.stufe, wartet.text], ['warn', 'Agent wartet']);
  assert.match(wartet.hinweis, /das Tor antwortet nicht/);
  assert.equal(modellLage({ arbeit: { offen: true, warum: 'seit 6 Minuten ruhig' } }).stufe, 'gut');
  // bereinigt aus der Antwort des Runners: nur bekannte Felder, Text gekürzt, Unsinn fällt weg
  const b = FP.wege.betriebBereinigen({ arbeit: { offen: false, warum: 'x'.repeat(500), geprueft: 17, fremd: 1 } });
  assert.deepEqual(Object.keys(b.arbeit), ['offen', 'warum', 'geprueft']);
  assert.ok(b.arbeit.warum.length <= 200);
  assert.equal(FP.wege.betriebBereinigen({ arbeit: { offen: 'ja' } }).arbeit, null);
  assert.equal(FP.wege.betriebBereinigen({}).arbeit, null);
});

test('Quelltext: kein Netz, kein HTML aus Text, keine Klangdatei, keine Signalfarbe im Stil', () => {
  const js = lies('rueckmeldung.js');
  assert.doesNotMatch(js, /\bfetch\(|XMLHttpRequest|innerHTML|insertAdjacentHTML|document\.write|transport\.api|new Audio\(|\.mp3|\.wav|\.ogg/);
  assert.doesNotMatch(lies('rueckmeldung.css'), /--akzent/);
});

// --- mit Fenster ----------------------------------------------------------------------------------------------------------

function aufbau(vorgabe = {}, extra = {}) {
  const d = new jsdom.JSDOM(
    '<!doctype html><body><div id="panes"></div><button id="a"></button><button id="t"></button><div id="toast" hidden></div></body>',
    { runScripts: 'outside-only', url: 'http://localhost/' },
  );
  const w = d.window;
  w.eval(lies('rueckmeldung.js'));
  const dok = w.document;
  const lager = new Map(Object.entries(vorgabe));
  const speicher = { getItem: (k) => (lager.has(k) ? lager.get(k) : null), setItem: (k, v) => lager.set(k, String(v)) };
  const toene = [];
  const audio = () => ({
    currentTime: 0,
    state: 'running',
    destination: {},
    createOscillator: () => ({ frequency: { setValueAtTime: (f) => toene.push(f) }, connect() {}, start() {}, stop() {} }),
    createGain: () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }),
  });
  const z = { vorn: true };
  const r = w.FyosPrototyp.rueckmeldung.createRueckmeldung({
    fenster: w,
    wurzel: dok.getElementById('panes'),
    anzeigeKnopf: dok.getElementById('a'),
    tonKnopf: dok.getElementById('t'),
    toast: dok.getElementById('toast'),
    speicher,
    audio,
    vorn: () => z.vorn,
    ...extra,
  });
  return { w, dok, r, lager, toene, z };
}

dom('Anzeige: Vorgabe normal, Klick schaltet weiter, die Klasse am Verlauf und der Speicher ziehen mit', () => {
  const { dok, r, lager } = aufbau();
  const panes = dok.getElementById('panes');
  const knopf = dok.getElementById('a');
  assert.equal(r.anzeige, 'normal');
  assert.equal(knopf.textContent, 'Anzeige: normal');
  assert.equal(panes.className, '');
  knopf.click();
  assert.equal(r.anzeige, 'detail');
  assert.ok(panes.classList.contains('anz-detail') && !panes.classList.contains('anz-kompakt'));
  assert.equal(knopf.textContent, 'Anzeige: detailliert');
  assert.equal(lager.get('fyos.agent.anzeige'), 'detail');
  assert.equal(dok.getElementById('toast').hidden, false, 'die Wahl wird kurz gemeldet');
  knopf.click();
  assert.ok(panes.classList.contains('anz-kompakt') && !panes.classList.contains('anz-detail'));
  knopf.click();
  assert.equal(panes.className, '');
});

dom('Gespeicherte Wahl gilt beim Start; Unsinn im Speicher fällt auf die Vorgabe zurück', () => {
  const a = aufbau({ 'fyos.agent.anzeige': 'kompakt', 'fyos.agent.toene': 'deutlich' });
  assert.equal(a.r.anzeige, 'kompakt');
  assert.equal(a.r.stufe, 'deutlich');
  assert.ok(a.dok.getElementById('panes').classList.contains('anz-kompakt'));
  const b = aufbau({ 'fyos.agent.anzeige': '<b>', 'fyos.agent.toene': 'bruellen' });
  assert.equal(b.r.anzeige, 'normal');
  assert.equal(b.r.stufe, 'aus');
});

dom('Töne: aus ist die Vorgabe und spielt nichts; dezent schweigt bei „fertig“, solange das Fenster vorn ist', () => {
  const { dok, r, toene, z } = aufbau();
  assert.equal(r.stufe, 'aus');
  assert.equal(r.moment('fertig'), null);
  assert.equal(toene.length, 0);
  dok.getElementById('t').click(); // dezent, spielt zur Probe „fertig“
  assert.equal(r.stufe, 'dezent');
  assert.equal(dok.getElementById('t').textContent, 'Töne: dezent');
  const probe = toene.length;
  assert.equal(probe, 2, 'die Probe sind zwei Töne');
  assert.equal(r.moment('fertig'), null);
  assert.equal(toene.length, probe);
  z.vorn = false;
  assert.equal(r.moment('fertig'), 'fertig');
  assert.equal(r.moment('braucht'), 'braucht');
  assert.equal(toene.length, probe + 4);
  assert.equal(r.moment('werkzeug'), null);
});

dom('Ohne Klang im Fenster und ohne Speicher bleibt alles bedienbar', () => {
  const { dok, r } = aufbau({}, { audio: () => { throw new Error('kein Klang'); }, speicher: { getItem() { throw new Error('zu'); }, setItem() { throw new Error('zu'); } } });
  dok.getElementById('t').click();
  dok.getElementById('a').click();
  assert.equal(r.stufe, 'dezent');
  assert.equal(r.anzeige, 'detail');
  assert.equal(r.moment('gesendet'), 'gesendet');
});

dom('Meldung: Text nur als Text, verschwindet nach der Frist', async () => {
  const { dok, r } = aufbau();
  const t = dok.getElementById('toast');
  r.toast('<img src=x onerror=alert(1)>', 10);
  assert.equal(t.hidden, false);
  assert.equal(t.querySelector('img'), null);
  await new Promise((f) => setTimeout(f, 40));
  assert.equal(t.hidden, true);
});

/** Ansicht und Adapter wie im Gespräch. */
function ansicht(opts, viewOpts) {
  const d = new jsdom.JSDOM('<!doctype html><body><div id="verlauf"><div id="spalte"></div></div><button id="ende" hidden></button><div id="ansage"></div></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = d.window;
  for (const s of ['markdown-strom.js', 'terminal.js', 'chat-renderer.js', 'runner-adapter.js', 'rueckmeldung.js']) w.eval(lies(s));
  const FP = w.FyosPrototyp;
  const view = FP.createChatView(w.document.getElementById('spalte'), {
    scroller: w.document.getElementById('verlauf'), zumEnde: w.document.getElementById('ende'), ansage: w.document.getElementById('ansage'),
    raf: (f) => setTimeout(() => f(Date.now()), 0), caf: () => {}, setInterval: () => 1, clearInterval: () => {}, reduceMotion: () => true,
    ...(viewOpts || {}),
  });
  return { w, d: w.document, FP, view, adapter: FP.createRunnerAdapter(view, opts || {}) };
}
const mensch = (id, text) => ({ id, kind: 'fyos.mensch', data: { text, von: 'mensch', zeit: 1760000000000 }, model: [{ role: 'user', content: text }] });
const antwort = (id, text) => ({ id, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' }] });
const werkzeugEnde = (id, fehler) => ({ type: 'tool_execution_end', toolCallId: id, toolName: 'bash', entry: { id: 90, model: [{ role: 'toolResult', content: [{ type: 'text', text: 'x' }], isError: fehler }] } });

dom('Momente: ein abgespielter Verlauf klingt nicht; live melden sich Werkzeug, Fehler und das Ende des Laufs', () => {
  const momente = [];
  const { view, adapter } = ansicht({ onMoment: (m) => momente.push(m) });
  adapter.replay([mensch(1, 'Bitte'), antwort(2, 'Erledigt.')], false);
  view.flush();
  assert.deepEqual(momente, [], 'Abspielen ist nicht eben geschehen');
  adapter.apply({ type: 'entry_appended', entry: mensch(3, 'Noch eine') });
  adapter.apply({ type: 'run_start' });
  adapter.apply({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'bash', args: { command: 'ls' } });
  adapter.apply(werkzeugEnde('a', false));
  adapter.apply({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'bash', args: { command: 'falsch' } });
  adapter.apply(werkzeugEnde('b', true));
  // eine Nachricht mitten im Zug beendet ihn in der Ansicht, ist aber kein „fertig“
  adapter.apply({ type: 'entry_appended', entry: mensch(4, 'Halt, anders') });
  assert.deepEqual(momente, ['werkzeug', 'fehler']);
  adapter.apply({ type: 'turn_start' });
  adapter.apply({ type: 'run_end' });
  view.flush();
  assert.deepEqual(momente, ['werkzeug', 'fehler', 'fertig']);
});

dom('Momente: eine Freigabe-Bitte ist „braucht“, das Ende dieses Laufs dann kein „fertig“', () => {
  const momente = [];
  const { view, adapter } = ansicht({ onMoment: (m) => momente.push(m) });
  adapter.apply({ type: 'run_start' });
  adapter.apply({ type: 'entry_appended', entry: { id: 7, kind: 'fyos.freigabe', data: { id: 'f1', aktion: 'bash', befehl: 'git push', risiko: 'medium', wartet: true } } });
  adapter.apply({ type: 'run_end' });
  view.flush();
  assert.deepEqual(momente, ['braucht']);
});

dom('Reaktionen: stehen nur unter einem eben beendeten Zug, ein Klick meldet die Art und markiert den Knopf', () => {
  const geklickt = [];
  let R;
  const a = ansicht({}, {});
  R = a.FP.rueckmeldung.REAKTIONEN;
  const { d, view, adapter } = ansicht({}, { reaktionen: R, onReaktion: (id) => geklickt.push(id) });
  adapter.replay([mensch(1, 'Bitte'), antwort(2, 'Erledigt.')], false);
  view.flush();
  assert.equal(d.querySelectorAll('.zugfuss').length, 1);
  assert.equal(d.querySelector('.rm-reaktionen'), null, 'alte Züge tragen keine Reaktionen');
  adapter.apply({ type: 'entry_appended', entry: mensch(3, 'Noch eine') });
  adapter.apply({ type: 'run_start' });
  adapter.apply({ type: 'entry_appended', entry: antwort(4, 'Auch erledigt.') });
  adapter.apply({ type: 'run_end' });
  view.flush();
  const reihe = d.querySelector('.rm-reaktionen');
  assert.ok(reihe, 'unter dem neuen Zug');
  const knoepfe = [...reihe.querySelectorAll('button')];
  assert.deepEqual(knoepfe.map((b) => b.textContent), ['gut', 'nicht gut', 'kürzer', 'noch einmal']);
  knoepfe[2].click();
  assert.deepEqual(geklickt, ['kuerzer']);
  assert.equal(knoepfe[2].getAttribute('aria-pressed'), 'true');
  assert.equal(knoepfe[0].getAttribute('aria-pressed'), 'false');
  assert.equal(reihe.dataset.gewaehlt, 'kuerzer');
});

dom('Kopieren: am Fuß jedes Zugs mit Antworttext, auch unter alten; kopiert wird der Text, wie er kam', async () => {
  const kopiert = [];
  const { w, d, view, adapter } = ansicht({}, { onKopiert: (t) => kopiert.push(t) });
  const geschrieben = [];
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: (t) => { geschrieben.push(t); return Promise.resolve(); } }, configurable: true });
  adapter.replay([mensch(1, 'Bitte'), antwort(2, 'Erledigt: **zwei** Dateien.\n\n```js\nconst a = 1;\n```')], false);
  view.flush();
  const knopf = d.querySelector('.zugfuss .rm-kopieren');
  assert.ok(knopf, 'auch unter einem abgespielten Zug');
  knopf.click();
  assert.deepEqual(geschrieben, ['Erledigt: **zwei** Dateien.\n\n```js\nconst a = 1;\n```']);
  assert.deepEqual(kopiert, geschrieben);
  assert.equal(knopf.textContent, 'Kopiert');
  // ein Zug ohne Antworttext (nur Werkzeug) trägt keinen Knopf
  adapter.apply({ type: 'entry_appended', entry: mensch(3, 'Noch eine') });
  adapter.apply({ type: 'run_start' });
  adapter.apply({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'bash', args: { command: 'ls' } });
  adapter.apply(werkzeugEnde('a', false));
  adapter.apply({ type: 'run_end' });
  view.flush();
  const fuesse = [...d.querySelectorAll('.zugfuss')];
  assert.equal(fuesse.length, 2);
  assert.equal(fuesse[1].querySelector('.rm-kopieren'), null);
});

dom('Kopieren ohne Zwischenablage: der Knopf sagt es, nichts bricht', () => {
  const { w, d, view, adapter } = ansicht({}, {});
  Object.defineProperty(w.navigator, 'clipboard', { value: undefined, configurable: true });
  adapter.replay([mensch(1, 'Bitte'), antwort(2, 'Erledigt.')], false);
  view.flush();
  const knopf = d.querySelector('.rm-kopieren');
  knopf.click();
  assert.equal(knopf.textContent, 'Kopieren nicht möglich');
});

dom('Stil: kompakt lässt Laufendes, Fehler und Freigaben stehen; detailliert klappt auf', () => {
  const css = lies('rueckmeldung.css');
  assert.match(css, /\.anz-kompakt \.karte:not\(\[data-zustand="laeuft"\]\):not\(\[data-zustand="fehler"\]\)/);
  assert.doesNotMatch(css, /\.anz-kompakt[^{]*\.freigabe/);
  assert.match(css, /\.anz-detail \.aufklapp \{ grid-template-rows: 1fr; \}/);
});
