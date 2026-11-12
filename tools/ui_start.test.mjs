// Startseite („Überblick“), Paket B3 in FYOS-AGENT-LOKAL-PLAN: was auf den Menschen wartet, was läuft, Betrieb, zuletzt (start.js, start.css).
// jsdom wie in ui_agent.test.mjs: über FYOS_JSDOM_DIR (Ordner mit node_modules/jsdom) oder ein benachbartes fyos-web.
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
const kopie = (x) => JSON.parse(JSON.stringify(x));
const BOESE = '<img src=x onerror=alert(1)>';
const JETZT = Date.UTC(2026, 10, 12, 10, 0, 0);

const SITZUNGEN = () => [
  { id: 1, titel: 'Zeitlimit für Modellanfragen', ordner: 'projekt', zeit: JETZT - 60000, zeitText: 'vor 1 Min.', laeuft: true },
  { id: 2, titel: 'Runner-Auswahl ohne Neustart', ordner: 'projekt', zeit: JETZT - 120000, zeitText: 'vor 2 Min.', laeuft: true },
  { id: 3, titel: 'Hub antwortet langsam', ordner: 'anderes', zeit: JETZT - 3600000, zeitText: 'vor 1 Std.', laeuft: false, angepinnt: true },
  { id: 4, titel: BOESE, ordner: '', zeit: JETZT - 7200000, zeitText: 'vor 2 Std.', laeuft: false },
];
const FREIGABEN = () => [
  { id: 'f1', conversationId: 2, gespraechTitel: 'Runner-Auswahl ohne Neustart', aktion: 'Zweig hochladen', befehl: 'git push origin arbeit', risiko: 'medium', status: 'offen' },
  { id: 'f2', conversationId: 9, gespraechTitel: 'Zweiter Platz am Tor', aktion: 'Tor umbauen', art: 'plan', plan: '1. …', status: 'offen' },
  { id: 'f3', conversationId: 3, gespraechTitel: 'Hub antwortet langsam', aktion: 'Ordner leeren', befehl: 'rm -r build', risiko: 'high', zerstoererisch: true, status: 'offen' },
];
const AUFGABEN = () => ({ eintraege: [{ text: 'lesen', zustand: 'fertig' }, { text: 'bauen', zustand: 'fertig' }, { text: 'Tests schreiben', zustand: 'laeuft' }, { text: 'prüfen', zustand: 'offen' }, { text: 'Doku', zustand: 'offen' }] });
const JOBS = () => [
  { id: 'j1abcd', name: 'npm test', laeuft: true, start: JETZT / 1000 - 42, ende: 0, exit: null, grund: '', dauer_s: 0, gespraech: 1 },
  { id: 'j2abcd', name: 'alt', laeuft: false, start: JETZT / 1000 - 900, ende: JETZT / 1000 - 800, exit: 0, grund: '', dauer_s: 100, gespraech: 1 },
];
const LAEUFE = () => [
  { id: '5', titel: 'Unteragent: Quellen lesen', quelle: 'unteragent', status: 'laeuft', art: 'lesen', erstellt: JETZT - 125000, beendet: 0, kindId: 11, eltern: 2, antwort: '', fehler: '' },
  { id: '6', titel: 'Unteragent: fertig', quelle: 'unteragent', status: 'abgeschlossen', art: 'lesen', erstellt: JETZT - 900000, beendet: JETZT - 800000, kindId: 12, eltern: 2, antwort: '', fehler: '' },
];

// --- ohne Fenster ---------------------------------------------------------------------------------------------------------

test('Satz oben: zählt, was wartet und was läuft', () => {
  const { gruss } = logik('start.js').start;
  assert.equal(gruss(0, 0), 'Nichts braucht dich, nichts läuft.');
  assert.equal(gruss(1, 1), 'Eine Sache braucht dich, eines läuft von selbst.');
  assert.equal(gruss(2, 2), 'Zwei Dinge brauchen dich, zwei laufen von selbst.');
  assert.equal(gruss(13, 14), '13 Dinge brauchen dich, 14 laufen von selbst.');
});

test('Sicht: Freigaben als „Braucht dich“, laufende Sitzungen mit Aufgabenstand, Hintergrund und Unteragenten, zuletzt ohne Laufendes', () => {
  const S = logik('werkbank.js', 'start.js').start;
  const s = S.startSicht({ sitzungen: SITZUNGEN(), freigaben: FREIGABEN(), aufgaben: new Map([['1', AUFGABEN()]]), jobs: JOBS(), laeufe: LAEUFE(), jetzt: JETZT });
  assert.deepEqual(kopie(s.braucht), [
    { id: 'f1', art: 'freigabe', titel: 'Freigabe: git push origin arbeit', unter: 'Runner-Auswahl ohne Neustart · mittleres Risiko · Zweig hochladen', sitzung: 2, ernst: false },
    { id: 'f2', art: 'plan', titel: 'Plan wartet: Tor umbauen', unter: 'Zweiter Platz am Tor', sitzung: 9, ernst: false },
    { id: 'f3', art: 'freigabe', titel: 'Freigabe: rm -r build', unter: 'Hub antwortet langsam · zerstörerisch · Ordner leeren', sitzung: 3, ernst: true },
  ]);
  assert.deepEqual(kopie(s.laeuft), [
    { art: 'sitzung', id: '1', sitzung: 1, titel: 'Zeitlimit für Modellanfragen', unter: 'Tests schreiben', anteil: 0.4, rechts: '2/5', haelt: false },
    { art: 'sitzung', id: '2', sitzung: 2, titel: 'Runner-Auswahl ohne Neustart', unter: 'wartet auf dich', anteil: null, rechts: 'wartet', haelt: true },
    { art: 'job', id: 'job:j1abcd', sitzung: 1, titel: 'Hintergrund: npm test', unter: 'Zeitlimit für Modellanfragen', anteil: null, rechts: '42 s', haelt: false },
    { art: 'unteragent', id: 'lauf:5', sitzung: 11, titel: 'Unteragent: Quellen lesen', unter: 'Runner-Auswahl ohne Neustart', anteil: null, rechts: '2 min', haelt: false },
  ]);
  assert.equal(s.gruss, 'Drei Dinge brauchen dich, drei laufen von selbst.', 'die Sitzung, die auf eine Freigabe wartet, läuft nicht von selbst');
  assert.deepEqual(kopie(s.zuletzt.map((z) => [z.id, z.rechts, z.angepinnt])), [['3', 'vor 1 Std.', true], ['4', 'vor 2 Std.', false]]);
  // Ohne alles
  const leer = S.startSicht({});
  assert.deepEqual(kopie(leer), { gruss: 'Nichts braucht dich, nichts läuft.', braucht: [], laeuft: [], zuletzt: [] });
  // Ohne werkbank.js: Sitzungen ohne Aufgabenstand, keine Läufe
  const ohne = logik('start.js').start.startSicht({ sitzungen: SITZUNGEN(), jobs: JOBS(), laeufe: LAEUFE(), jetzt: JETZT });
  assert.deepEqual(kopie(ohne.laeuft.map((l) => [l.art, l.rechts])), [['sitzung', 'arbeitet'], ['sitzung', 'arbeitet']]);
});

test('Betrieb: nur was der Runner meldet; Pause, Modell und Hub in ihren Zuständen', () => {
  const { betriebSicht } = logik('start.js').start;
  assert.deepEqual(kopie(betriebSicht(null, { fehler: 'Der Runner ist nicht erreichbar.' })), [{ titel: 'Runner', wert: 'Der Runner ist nicht erreichbar.', chip: 'nicht erreichbar', art: 'schlecht' }]);
  assert.deepEqual(kopie(betriebSicht({ gespraeche: 1 })), [{ titel: 'Runner', wert: '1 Sitzung', chip: 'verbunden', art: 'gut' }], 'ohne Modell und Hub keine Kachel dafür');
  const voll = betriebSicht({ gespraeche: 4, pausiert: false, spielmodus: '', modell: { name: 'klein-1b', antwortet: true }, wartend: 2, hub: { erreichbar: true, text: '12 Erweiterungen' } });
  assert.deepEqual(kopie(voll), [
    { titel: 'Runner', wert: '4 Sitzungen', chip: 'verbunden', art: 'gut' },
    { titel: 'Modell', wert: 'klein-1b · 2 in der Schlange', chip: 'antwortet', art: 'gut' },
    { titel: 'Hub', wert: '12 Erweiterungen', chip: 'erreichbar', art: 'gut' },
  ]);
  const schlecht = betriebSicht({ gespraeche: 2, pausiert: true, spielmodus: 'spiel', modell: { name: 'x', antwortet: false }, hub: { erreichbar: false, text: 'Zeitüberschreitung' } });
  assert.deepEqual(kopie(schlecht.map((k) => [k.titel, k.chip, k.art])), [['Runner', 'pausiert', 'warn'], ['Modell', 'antwortet nicht', 'schlecht'], ['Hub', 'nicht erreichbar', 'warn']]);
  assert.equal(schlecht[0].wert, '2 Sitzungen · Pause (spiel)');
  assert.equal(betriebSicht({ gespraeche: 0, pausiert: true })[0].wert, '0 Sitzungen · Ruhe');
  assert.equal(betriebSicht({ modell: { name: '', antwortet: null } })[1].chip, 'ungeprüft');
  // Ein Runner ohne Hub ist kein Ausfall: neutrale Kachel
  assert.deepEqual(kopie(betriebSicht({ gespraeche: 1, hub: { erreichbar: false, eingerichtet: false, text: 'Kein Hub konfiguriert' } })[1]), { titel: 'Hub', wert: 'Kein Hub eingerichtet', chip: 'aus', art: '' });
});

test('Wege: Betrieb und Hub-Werkzeuge kommen bereinigt an (nur bekannte Felder), die Pfade stimmen', async () => {
  const W = logik('runner-wege.js').wege;
  // voller Runner: kein Modell, keine Schlange
  assert.deepEqual(kopie(W.betriebBereinigen({ ok: true, pausiert: false, spielmodus: null, gespraeche: 7, hub: { ok: true, daten: { plugins: [{ name: 'a', healthy: true }, { name: 'b', healthy: false }] } }, geheim: 'x' })), {
    pausiert: false, spielmodus: '', gespraeche: 7, modell: null, wartend: null, hub: { erreichbar: true, eingerichtet: true, text: '2 Erweiterungen · 1 nicht gesund' },
  });
  // lokaler Runner: Modell und Schlange in englischen Feldern
  assert.deepEqual(kopie(W.betriebBereinigen({ pausiert: true, spielmodus: 'spiel', gespraeche: 2.9, model: { name: 'klein-1b', url: 'http://127.0.0.1:1/v1', answers: false }, queue: { waiting: 3, paused: false }, hub: { ok: false, fehler: 'Kein Hub konfiguriert' } })), {
    pausiert: true, spielmodus: 'spiel', gespraeche: 2, modell: { name: 'klein-1b', antwortet: false }, wartend: 3, hub: { erreichbar: false, eingerichtet: false, text: 'Kein Hub konfiguriert' },
  });
  assert.deepEqual(kopie(W.betriebBereinigen({ hub: { ok: false, fehler: 'Zeitüberschreitung' } }).hub), { erreichbar: false, eingerichtet: true, text: 'Zeitüberschreitung' });
  assert.deepEqual(kopie(W.betriebBereinigen({ hub: { ok: true, daten: { plugins: 12 } } }).hub), { erreichbar: true, eingerichtet: true, text: '12 Erweiterungen' });
  assert.deepEqual(kopie(W.betriebBereinigen(null)), { pausiert: false, spielmodus: '', gespraeche: 0, modell: null, wartend: null, hub: null });
  // Werkzeuge: Name und erste Zeile der Beschreibung
  assert.deepEqual(kopie(W.werkzeugBereinigen({ name: ' hub.suchen ', description: 'Sucht Werkzeuge.\nZweite Zeile', inputSchema: {} })), { name: 'hub.suchen', beschreibung: 'Sucht Werkzeuge.' });
  assert.deepEqual(kopie(W.werkzeugBereinigen({ name: 'a.b', beschreibung: 'deutsch' })), { name: 'a.b', beschreibung: 'deutsch' });
  assert.equal(W.werkzeugBereinigen({ name: '  ' }), null);
  assert.equal(W.werkzeugBereinigen(null), null);
  const pfade = [];
  const wege = W.createWege({
    api: async (methode, pfad) => {
      pfade.push(`${methode} ${pfad}`);
      if (pfad.startsWith('/api/werkzeuge')) return { ok: true, werkzeuge: [{ name: 'x.y', description: 'tut etwas' }, { kaputt: true }] };
      return { ok: true, gespraeche: 1 };
    },
  });
  assert.deepEqual(kopie(await wege.werkzeuge('zwei wörter')), [{ name: 'x.y', beschreibung: 'tut etwas' }]);
  assert.equal((await wege.betrieb()).gespraeche, 1);
  assert.deepEqual(pfade, ['GET /api/werkzeuge?q=zwei%20w%C3%B6rter', 'GET /api/health']);
});

test('Quelltext: kein eigenes Netz, kein HTML aus Text; im Überblick liegt kein Banner über der Seite', () => {
  const js = lies('start.js');
  assert.doesNotMatch(js, /\bfetch\(|XMLHttpRequest|innerHTML|insertAdjacentHTML|document\.write|transport\.api/);
  assert.match(lies('start.css'), /\.haupt\.ueb-an \.fp-banner \{ display: none; \}/);
});

// --- mit Fenster ----------------------------------------------------------------------------------------------------------

function start(extra = {}) {
  const d = new jsdom.JSDOM('<!doctype html><body><div id="start" hidden></div></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = d.window;
  for (const s of ['werkbank.js', 'start.js']) w.eval(lies(s));
  const dok = w.document;
  const z = { sitzungen: SITZUNGEN(), freigaben: FREIGABEN(), gesprungen: [], freigabenAuf: [], palette: 0, neu: 0, fragen: [], uhr: [] };
  const opts = {
    intervallMs: 0,
    jetzt: () => JETZT,
    sitzungen: () => z.sitzungen,
    freigaben: () => z.freigaben,
    aufgaben: async (id) => {
      z.fragen.push(`aufgaben:${id}`);
      if (String(id) !== '1') throw new Error('keine Liste');
      return AUFGABEN();
    },
    laeufe: async () => LAEUFE(),
    jobs: async () => JOBS(),
    betrieb: async () => ({ gespraeche: 4, modell: { name: 'klein-1b', antwortet: true }, hub: { erreichbar: false, text: 'Zeitüberschreitung' } }),
    beiSitzung: (id) => z.gesprungen.push(id),
    beiFreigaben: (id) => z.freigabenAuf.push(id),
    beiPalette: () => { z.palette += 1; },
    beiNeu: () => { z.neu += 1; },
    ...extra,
  };
  const s = w.FyosPrototyp.start.createStart({ wurzel: dok.getElementById('start') }, opts);
  const $ = (q) => dok.querySelector(q);
  const $$ = (q) => [...dok.querySelectorAll(q)];
  return { w, dok, s, z, $, $$ };
}

dom('Seite: vier Abschnitte, der Satz oben, Sprünge in Sitzung, Freigaben und Palette; Texte bleiben Text', async () => {
  const { w, dok, s, z, $, $$ } = start();
  assert.equal(dok.getElementById('start').hidden, true);
  s.zeige();
  assert.equal(dok.getElementById('start').hidden, false);
  await bis(() => $$('.ueb-kachel').length === 3);
  assert.equal($('.ueb-gruss').textContent, 'Drei Dinge brauchen dich, drei laufen von selbst.');
  assert.deepEqual($$('.ueb-titel').map((h) => h.textContent), ['Braucht dich', 'Läuft', 'Betrieb', 'Zuletzt']);
  // Braucht dich
  assert.equal($$('.ueb-wartet').length, 3);
  assert.equal($$('.ueb-wartet.ernst').length, 1);
  assert.deepEqual($$('.ueb-wartet')[1].querySelectorAll('button')[0].textContent, 'Plan lesen');
  $$('.ueb-wartet')[0].querySelectorAll('button')[0].click();
  $$('.ueb-wartet')[0].querySelectorAll('button')[1].click();
  assert.deepEqual(kopie(z.freigabenAuf), ['f1']);
  assert.deepEqual(kopie(z.gesprungen), [2]);
  assert.equal($$('.ueb-wartet button').some((b) => /erlauben|ablehnen/i.test(b.textContent)), false, 'entschieden wird im Panel der Freigaben, nicht hier');
  // Läuft
  const lauf = $$('.ueb-lauf');
  assert.equal(lauf.length, 4);
  assert.equal(lauf[0].querySelector('.ueb-balken').getAttribute('aria-valuenow'), '40');
  assert.equal(lauf[0].querySelector('.ueb-rechts').textContent, '2/5');
  assert.equal(lauf[0].querySelector('.ueb-unter').textContent, 'Tests schreiben');
  assert.equal(lauf[1].querySelector('.ueb-balken'), null);
  assert.ok(lauf[1].querySelector('.ueb-punkt.haelt'));
  assert.ok(lauf[0].querySelector('.ueb-punkt.arbeitet'));
  lauf[3].click();
  assert.deepEqual(kopie(z.gesprungen), [2, 11], 'ein Unteragent öffnet seinen eigenen Verlauf');
  lauf[2].dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.deepEqual(kopie(z.gesprungen), [2, 11, 1], 'Eingabetaste wie Klick');
  assert.deepEqual(kopie(z.fragen.sort()), ['aufgaben:1', 'aufgaben:2'], 'nur laufende Sitzungen werden nach ihrer Liste gefragt');
  // Betrieb
  assert.deepEqual($$('.ueb-kachel').map((k) => [k.querySelector('b').textContent, k.querySelector('.chip').textContent]), [['Runner', 'verbunden'], ['Modell', 'antwortet'], ['Hub', 'nicht erreichbar']]);
  // Zuletzt
  const zuletzt = $$('.ueb-sitzung');
  assert.equal(zuletzt.length, 2);
  assert.equal(zuletzt[0].querySelector('.ueb-rechts').textContent, 'angepinnt · vor 1 Std.');
  assert.equal(zuletzt[1].querySelector('.ueb-name').textContent, BOESE);
  assert.equal(dok.querySelectorAll('#start img').length, 0);
  zuletzt[0].click();
  assert.deepEqual(kopie(z.gesprungen), [2, 11, 1, 3]);
  // Kopf
  $('.ueb-palette').click();
  $('.ueb-knoepfe .primaer').click();
  assert.equal(z.palette, 1);
  assert.equal(z.neu, 1);
});

dom('Leer und Fehler: Sätze statt leerer Abschnitte; ein Runner, der nicht antwortet, steht als Kachel da; scheiternde Quellen lassen den Rest stehen', async () => {
  const { s, z, $, $$ } = start({
    laeufe: async () => {
      throw new Error('weg');
    },
    jobs: undefined,
    aufgaben: undefined,
    betrieb: async () => {
      throw Object.assign(new Error('x'), { meldung: 'Der Runner ist nicht erreichbar.' });
    },
  });
  z.sitzungen = [];
  z.freigaben = [];
  s.zeige();
  await bis(() => $$('.ueb-kachel').length === 1);
  assert.equal($('.ueb-gruss').textContent, 'Nichts braucht dich, nichts läuft.');
  assert.deepEqual($$('.ueb-leer').map((p) => p.textContent), ['Nichts wartet auf dich.', 'Gerade läuft nichts.']);
  assert.equal($('.ueb-zuletzt').hidden, true);
  assert.equal($('.ueb-kachel .chip').textContent, 'nicht erreichbar');
  assert.equal($('.ueb-wert').textContent, 'Der Runner ist nicht erreichbar.');
  // Die Leiste meldet eine neue Sitzung: zeichne() zieht nach, ohne den Runner zu fragen
  z.sitzungen = SITZUNGEN().slice(2);
  s.zeichne();
  assert.equal($$('.ueb-sitzung').length, 2);
  assert.equal($('.ueb-zuletzt').hidden, false);
});

dom('Abfragen nur, solange die Seite sichtbar ist; eine späte Antwort nach dem Verbergen ändert nichts', async () => {
  const uhren = [];
  let geladen = 0;
  let loese;
  const langsam = new Promise((r) => { loese = r; });
  const { s, $$ } = start({
    intervallMs: 5000,
    setInterval: (f, ms) => {
      uhren.push({ f, ms, an: true });
      return uhren.length - 1;
    },
    clearInterval: (i) => {
      uhren[i].an = false;
    },
    betrieb: async () => {
      geladen += 1;
      if (geladen === 2) await langsam;
      return { gespraeche: geladen };
    },
  });
  assert.equal(uhren.length, 0, 'verborgen läuft keine Uhr');
  s.zeige();
  await bis(() => $$('.ueb-kachel').length === 1);
  assert.deepEqual(uhren.map((u) => [u.ms, u.an]), [[5000, true]]);
  uhren[0].f();
  await bis(() => geladen === 2);
  s.verberge();
  assert.equal(uhren[0].an, false);
  loese();
  await warte(30);
  assert.equal(s.zustand().betrieb[0].wert, '1 Sitzung', 'die Antwort nach dem Verbergen ist verworfen');
  assert.equal(s.sichtbar(), false);
  s.zeichne();
  s.zeige();
  await bis(() => geladen === 3);
  assert.equal(uhren.length, 2);
});
