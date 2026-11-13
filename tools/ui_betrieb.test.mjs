// Tafel „Betrieb“ (betrieb-tafel.js, Lesen über runner-wege.js `betriebLage`): Antwort bereinigen, Zeilen, Zeichnen, Knopf ohne Weg.
// jsdom wie in ui_agent.test.mjs: über FYOS_JSDOM_DIR oder ein benachbartes fyos-web.
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

const LAGE = {
  ok: true,
  modell: { name: 'modell-a', antwortet: true },
  hub: { konfiguriert: true, erreichbar: true },
  cluster: {
    satz: '2 Knoten, alle bereit',
    knoten: [
      { name: 'knoten-a', bereit: true, abgesperrt: false, probleme: 0, aufgaben: ['gpu-pool'], cpuProzent: 3.9, ramGib: 11.7, ramGesamtGib: 120.9, gpus: [{ nr: '0', modell: 'RTX', auslastungProzent: 96, vramMib: 28021, vramGesamtMib: 32217, temperaturC: 69 }] },
      { name: 'knoten-b', bereit: false, abgesperrt: false, probleme: 1, aufgaben: [], cpuProzent: null, ramGib: null, ramGesamtGib: null, gpus: [] },
    ],
  },
  zeit: 1,
};

test('betriebLageBereinigen: nur bekannte Felder, Unsinn wird leer, ohne Cluster null', () => {
  const { betriebLageBereinigen } = logik('runner-wege.js').wege;
  const s = betriebLageBereinigen({ ...LAGE, geheim: 'x', cluster: { ...LAGE.cluster, knoten: [...LAGE.cluster.knoten, { name: '' }, null] } });
  assert.deepEqual(Object.keys(s), ['modell', 'hub', 'cluster', 'flelink', 'rechner', 'zeit']);
  assert.equal(s.cluster.knoten.length, 2);
  assert.deepEqual(s.cluster.knoten[0].gpus[0], { nr: '0', modell: 'RTX', auslastungProzent: 96, vramMib: 28021, vramGesamtMib: 32217, temperaturC: 69 });
  const leer = betriebLageBereinigen(null);
  assert.deepEqual(leer, { modell: { name: null, antwortet: null }, hub: { konfiguriert: false, erreichbar: null, fehler: '' }, cluster: null, flelink: null, rechner: null, zeit: null });
  assert.deepEqual(betriebLageBereinigen({ flelink: { erreichbar: false, geheim: 1 } }).flelink, { erreichbar: false });
});

test('Zeilen: Zustand des Knotens, Speicher, GPU mit Anteil', () => {
  const { knotenZustand, speicherText, gpuZeile } = logik('betrieb-tafel.js').betrieb;
  assert.equal(knotenZustand({ bereit: true, abgesperrt: false, probleme: 0 }), 'gut');
  assert.equal(knotenZustand({ bereit: true, abgesperrt: true, probleme: 0 }), 'warn');
  assert.equal(knotenZustand({ bereit: false, abgesperrt: false, probleme: 0 }), 'schlecht');
  assert.equal(speicherText(11.7, 120.9), '11,7 / 120,9 GB');
  assert.equal(speicherText(null, 120.9), '');
  const g = gpuZeile(LAGE.cluster.knoten[0].gpus[0]);
  assert.equal(g.text, 'GPU0 · 96 % · 27,4 / 31,5 GB · 69 °C');
  assert.ok(Math.abs(g.anteil - 28021 / 32217) < 1e-9);
  assert.equal(gpuZeile({ nr: '1', auslastungProzent: null, vramMib: null, vramGesamtMib: null, temperaturC: null }).anteil, null);
});

test('Quelltext: kein HTML aus Text, kein eigenes Netz; Knopf und Tafel stehen im HTML, das Skript ist eingebunden', () => {
  assert.doesNotMatch(lies('betrieb-tafel.js'), /innerHTML|insertAdjacentHTML|\bfetch\(|XMLHttpRequest/);
  const html = lies('chat.html');
  assert.match(html, /id="schieneBetrieb"[^>]*hidden/);
  assert.match(html, /id="tafelBetrieb"/);
  assert.match(html, /<script src="betrieb-tafel.js"><\/script>/);
  assert.match(lies('werkbank.js'), /'dateien', 'wissen', 'betrieb'\]/);
});

function tafel(antwort) {
  const d = new jsdom.JSDOM('<!doctype html><body><button id="k" hidden></button><div id="r"></div><p id="f" hidden></p></body>', { runScripts: 'outside-only' });
  const w = d.window;
  w.eval(lies('runner-wege.js'));
  w.eval(lies('betrieb-tafel.js'));
  const $ = (id) => w.document.getElementById(id);
  const z = { aufrufe: 0, wege: [] };
  const wege = {
    betriebLage: async () => {
      z.aufrufe++;
      if (antwort instanceof Error) throw antwort;
      return w.FyosPrototyp.wege.betriebLageBereinigen(antwort);
    },
  };
  const t = w.FyosPrototyp.betrieb.createBetriebTafel({ knopf: $('k'), rumpf: $('r'), fuss: $('f') }, {
    wege, sichtbar: () => true, beiWeg: (kennt) => z.wege.push(kennt),
    setInterval: () => 1, clearInterval: () => {}, jetzt: () => new Date(2026, 10, 13, 9, 5, 7),
  });
  return { $, t, z };
}

dom('Zeichnen: Modell, Hub, Knoten mit GPU; der Knopf erscheint, der Fuß nennt den Stand', async () => {
  const { $, t, z } = tafel(LAGE);
  await t.pruefe();
  assert.equal($('k').hidden, false);
  assert.deepEqual(z.wege, [true]);
  const r = $('r');
  assert.match(r.textContent, /Modellmodell-aantwortet/);
  assert.match(r.textContent, /Huberreichbarverbunden/);
  const knoten = r.querySelectorAll('.bt-knoten-eintrag');
  assert.equal(knoten.length, 2);
  assert.ok(knoten[0].querySelector('.bt-punkt.gut'));
  assert.ok(knoten[1].querySelector('.bt-punkt.schlecht'));
  assert.equal(knoten[0].querySelector('.bt-gpu .bt-werte').textContent, 'GPU0 · 96 % · 27,4 / 31,5 GB · 69 °C');
  assert.ok(knoten[0].querySelector('.bt-balken.gut'), 'VRAM bei 87 %: noch nicht gelb (erst über 90 %)');
  assert.equal($('f').textContent, 'Stand 09:05:07 · nur lesend');
});

dom('Ohne Weg bleibt der Knopf weg; ohne Cluster und bei Fehlern steht ein Satz da', async () => {
  const weg = tafel(Object.assign(new Error('Dieser Runner bietet den Weg nicht an.'), { art: 'weg_fehlt' }));
  await weg.t.pruefe();
  assert.equal(weg.$('k').hidden, true);
  assert.deepEqual(weg.z.wege, [false]);

  const ohne = tafel({ ...LAGE, hub: { konfiguriert: false }, cluster: null });
  await ohne.t.pruefe();
  assert.match(ohne.$('r').textContent, /Der Cluster steht hier, sobald der Runner einen Hub hat\./);

  const rot = tafel({ ...LAGE, cluster: { fehler: 'Kein Recht' } });
  await rot.t.pruefe();
  assert.match(rot.$('r').textContent, /Cluster nicht lesbar: Kein Recht/);

  const netz = tafel(Object.assign(new Error('weg'), { art: 'netz', meldung: 'Runner nicht erreichbar' }));
  await netz.t.pruefe();
  assert.equal(netz.$('k').hidden, true, 'ein Netzfehler zeigt den Knopf nicht erst');
  assert.match(netz.$('r').textContent, /Betrieb nicht lesbar: Runner nicht erreichbar/);
});

const FLELINK = { erreichbar: true, zustand: 'ready', modell: 'Bolt-E4B', kontext: 16384, slots: 1, slotsBelegt: 1, beschaeftigt: true, wartend: 2, tokS: 41.5, prefillTokS: 512.3, annahme: 0.71, ausLetzterAntwort: false };

test('Tempo aus FLE Link: tok/s, Prefill, Annahme, Slots, Wartende; ohne FLE Link leer', () => {
  const { tempoText } = logik('betrieb-tafel.js').betrieb;
  assert.equal(tempoText(FLELINK), '41,5 tok/s · Prefill 512 tok/s · Annahme 71 % · Slots 1/1 · 2 warten');
  assert.equal(tempoText({ ...FLELINK, prefillTokS: null, annahme: null, slots: null, wartend: 0, ausLetzterAntwort: true }), '41,5 tok/s (letzte Antwort)');
  assert.equal(tempoText({ erreichbar: false }), '');
  assert.equal(tempoText(null), '');
});

dom('FLE Link und dieser Rechner: Tempo unter dem Modell, „rechnet“ als laufend, RAM mit Balken; ohne FLE Link der Hinweis', async () => {
  const { $, t } = tafel({ ...LAGE, flelink: FLELINK, rechner: { quelle: 'flelink', ramGib: 7.5, ramGesamtGib: 8, gpus: [] } });
  await t.pruefe();
  const r = $('r');
  assert.equal(r.querySelector('.bt-tempo').textContent, '41,5 tok/s · Prefill 512 tok/s · Annahme 71 % · Slots 1/1 · 2 warten');
  assert.ok(r.querySelector('.bt-chip.laeuft'), 'das Modell rechnet');
  assert.match(r.textContent, /Dieser Rechnergemessen von FLE Link/);
  assert.match(r.textContent, /RAM 7,5 \/ 8,0 GB/);
  assert.ok(r.querySelectorAll('.bt-kachel')[1].querySelector('.bt-balken.warn'), 'RAM über 90 %');

  const aus = tafel({ ...LAGE, flelink: { erreichbar: false }, rechner: { quelle: 'system', ramGib: 6, ramGesamtGib: 8, gpus: [] } });
  await aus.t.pruefe();
  assert.match(aus.$('r').textContent, /FLE Linkläuft nicht auf diesem Rechner/);
  assert.match(aus.$('r').textContent, /laut System/);
  assert.equal(aus.$('r').querySelector('.bt-tempo'), null);
});

test('Zustand von FLE Link auf Deutsch; grün nur, wenn die Engine antwortet; Pink nur, solange sie rechnet', () => {
  const { flelinkZustand } = logik('betrieb-tafel.js').betrieb;
  const z = (zustand, beschaeftigt = false) => flelinkZustand({ zustand, beschaeftigt });
  assert.deepEqual(z('stopped'), { text: 'aus', art: '' });
  assert.deepEqual(z(null), { text: 'aus', art: '' });
  assert.deepEqual(z('starting'), { text: 'lädt', art: '' });
  assert.deepEqual(z('ready'), { text: 'bereit', art: 'gut' });
  assert.deepEqual(z('attached'), { text: 'bereit', art: 'gut' });
  assert.deepEqual(z('error'), { text: 'Fehler', art: 'schlecht' });
  assert.deepEqual(z('ready', true), { text: 'rechnet', art: 'laeuft' });
});
