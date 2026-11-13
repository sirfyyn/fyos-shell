// Tafel „Wissen“ (wissen-tafel.js, Lesen über runner-wege.js `wissen`, `wissenLesen`, `wissenDa`): bereinigen, Unterzeile, Suche, Aufklappen,
// Erwähnen, Knopf ohne Weg. jsdom wie in ui_agent.test.mjs: über FYOS_JSDOM_DIR oder ein benachbartes fyos-web.
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
const warte = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const SUCHE = {
  satz: '2 Treffer',
  treffer: [
    { titel: 'Messlatte', quelle: 'dokumente/datei', adresse: 'docs/current/X.md#lauf', reife: 'feldnotiz', stand: '2026-11-12', auszug: 'Am Abend …' },
    { titel: 'Bericht', quelle: 'ablage/claude', adresse: 'ablage:claude/a', reife: 'kanon', stand: '', auszug: '' },
  ],
};

test('wissenBereinigen: nur bekannte Felder, leerer Titel bekommt einen; Unterzeile mit deutschem Datum', () => {
  const FP = logik('runner-wege.js', 'wissen-tafel.js');
  const s = FP.wege.wissenBereinigen({ ...SUCHE, treffer: [...SUCHE.treffer, { titel: '' }, null], geheim: 1 });
  assert.deepEqual(Object.keys(s), ['treffer', 'satz']);
  assert.equal(s.treffer.length, 3);
  assert.equal(s.treffer[2].titel, 'ohne Titel');
  assert.equal(FP.wissen.trefferUnterzeile(SUCHE.treffer[0]), 'dokumente/datei · 12.11.2026');
  assert.equal(FP.wissen.trefferUnterzeile(SUCHE.treffer[1]), 'ablage/claude');
});

test('Quelltext: kein HTML aus Text, kein eigenes Netz; Knopf, Tafel und Skript im HTML; Gedächtnis nur mit Häkchen', () => {
  assert.doesNotMatch(lies('wissen-tafel.js'), /innerHTML|insertAdjacentHTML|\bfetch\(|XMLHttpRequest/);
  const html = lies('chat.html');
  assert.match(html, /id="schieneWissen"[^>]*hidden/);
  assert.match(html, /id="tafelWissen"/);
  assert.match(html, /<input id="wissenGedaechtnis" type="checkbox">/);
  assert.doesNotMatch(html, /id="wissenGedaechtnis"[^>]*checked/);
  assert.match(html, /<script src="wissen-tafel.js"><\/script>/);
  assert.match(lies('runner-wege.js'), /\$\{o\.gedaechtnis \? '&gedaechtnis=1' : ''\}/);
});

function tafel({ suche = SUCHE, lesen = { aufloesbar: true, text: 'Der ganze Abschnitt' }, da = true } = {}) {
  const d = new jsdom.JSDOM('<!doctype html><body><button id="k" hidden></button><input id="f"><input id="g" type="checkbox"><p id="h"></p><ul id="l"></ul></body>', { runScripts: 'outside-only' });
  const w = d.window;
  w.eval(lies('wissen-tafel.js'));
  const $ = (id) => w.document.getElementById(id);
  const z = { suchen: [], lesen: [], erwaehnt: [], wege: [] };
  const wege = {
    wissen: async (q, o) => {
      z.suchen.push([q, o.gedaechtnis]);
      if (suche instanceof Error) throw suche;
      return suche;
    },
    wissenLesen: async (a) => {
      z.lesen.push(a);
      if (lesen instanceof Error) throw lesen;
      return lesen;
    },
    wissenDa: async () => {
      if (da instanceof Error) throw da;
      return da;
    },
  };
  const t = w.FyosPrototyp.wissen.createWissenTafel(
    { knopf: $('k'), feld: $('f'), gedaechtnis: $('g'), liste: $('l'), hinweis: $('h') },
    { wege, beiErwaehnen: (x) => z.erwaehnt.push(x), beiWeg: (k) => z.wege.push(k), setTimeout: (f) => (f(), 1), clearTimeout: () => {} },
  );
  return { w, $, t, z };
}

dom('Suche: Enter sucht, Treffer mit Reife und Unterzeile; Klick klappt den Text auf und zu; Erwähnen legt die Adresse ab', async () => {
  const { w, $, t, z } = tafel();
  assert.equal(await t.pruefe(), true);
  assert.equal($('k').hidden, false);
  $('f').value = 'Messlatte';
  $('f').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter' }));
  await warte(10);
  assert.deepEqual(z.suchen[z.suchen.length - 1], ['Messlatte', false]);
  const li = $('l').querySelectorAll('.ws-treffer');
  assert.equal(li.length, 2);
  assert.equal(li[0].querySelector('.ws-titel').textContent, 'Messlatte');
  assert.equal(li[0].querySelector('.ws-reife').textContent, 'feldnotiz');
  assert.match(li[0].querySelector('.ws-unter').textContent, /^dokumente\/datei · 12\.11\.2026/);
  assert.equal($('h').textContent, '2 Treffer');
  const kopf = li[0].querySelector('.ws-kopf');
  kopf.click();
  await warte(10);
  assert.deepEqual(z.lesen, ['docs/current/X.md#lauf']);
  assert.equal(li[0].querySelector('.ws-text').textContent, 'Der ganze Abschnitt');
  assert.equal(kopf.getAttribute('aria-expanded'), 'true');
  kopf.click();
  assert.equal(li[0].querySelector('.ws-text'), null);
  li[1].querySelector('.ws-erwaehnen').click();
  assert.deepEqual(z.erwaehnt, ['Siehe ablage:claude/a']);
  // das Häkchen sucht mit Gedächtnis neu
  $('g').checked = true;
  $('g').dispatchEvent(new w.Event('change'));
  await warte(10);
  assert.deepEqual(z.suchen[z.suchen.length - 1], ['Messlatte', true]);
});

dom('Ohne Weg kein Knopf; nichts gefunden, Fehler der Suche und eine nicht auflösbare Adresse stehen als Satz da', async () => {
  const ohne = tafel({ da: false });
  await ohne.t.pruefe();
  assert.equal(ohne.$('k').hidden, true);
  assert.deepEqual(ohne.z.wege, [false]);

  const leer = tafel({ suche: { treffer: [], satz: '' } });
  leer.$('f').value = 'xyz';
  await leer.t.suche();
  assert.match(leer.$('h').textContent, /^Nichts gefunden/);

  const rot = tafel({ suche: Object.assign(new Error('weg'), { meldung: 'Der Hub hat nicht geantwortet.' }) });
  rot.$('f').value = 'x';
  await rot.t.suche();
  assert.match(rot.$('h').textContent, /Suche nicht möglich: Der Hub hat nicht geantwortet\./);
  assert.ok(rot.$('h').classList.contains('ws-fehler'));

  const kaputt = tafel({ lesen: { aufloesbar: false, text: '' } });
  kaputt.$('f').value = 'Messlatte';
  await kaputt.t.suche();
  kaputt.$('l').querySelector('.ws-kopf').click();
  await warte(10);
  assert.match(kaputt.$('l').querySelector('.ws-text').textContent, /nicht mehr auflösbar/);
});
