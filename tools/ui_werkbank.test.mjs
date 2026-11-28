// Werkbank der Agent-Oberfläche (werkbank.js): Schiene der Seitenleiste, Aufgabenliste des Agenten mit Streifen, Läufe (Unteragenten und
// Befehle im Hintergrund); dazu das Anpinnen von Sitzungen und der Schutz der Eingabe vor typografischen Ersetzungen.
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
const plain = (x) => JSON.parse(JSON.stringify(x));

/** Module ohne Fenster laden (reine Logik). */
function logik(...dateien) {
  const w = { FyosPrototyp: {} };
  for (const n of dateien) new Function('window', 'globalThis', lies(n))(w, w);
  return w.FyosPrototyp;
}

// --- reine Logik ---
test('dauerText: Sekunden, Minuten, Stunden mit Rest', () => {
  const { dauerText } = logik('werkbank.js').werkbank;
  assert.deepEqual([0, 45, 89, 90, 600, 5399, 5400, 7500, -3, 'x'].map(dauerText), ['0 s', '45 s', '89 s', '1 min', '10 min', '89 min', '1 h 30 min', '2 h 5 min', '0 s', '0 s']);
});

test('aufgabenSicht: Zähler, Anteil, der aktuelle Schritt ist der laufende, sonst der nächste offene', () => {
  const { aufgabenSicht } = logik('werkbank.js').werkbank;
  const leer = aufgabenSicht(null);
  assert.deepEqual([leer.leer, leer.gesamt, leer.kurz, leer.aktuell, leer.anteil], [true, 0, '', '', 0]);
  const s = aufgabenSicht({ eintraege: [{ text: 'Plan lesen', zustand: 'fertig' }, { text: 'Tests schreiben', zustand: 'laeuft' }, { text: 'Bericht', zustand: 'offen' }, { text: 'Aufräumen', zustand: 'offen' }] });
  assert.deepEqual([s.gesamt, s.fertig, s.laeuft, s.offen, s.unerledigt], [4, 1, 1, 2, 3]);
  assert.equal(s.anteil, 0.25);
  assert.equal(s.aktuell, 'Tests schreiben');
  assert.equal(s.kurz, '1 von 4');
  assert.equal(s.arbeitet, true);
  // nichts läuft: der nächste offene Schritt
  const ruht = aufgabenSicht({ eintraege: [{ text: 'A', zustand: 'fertig' }, { text: 'B', zustand: 'offen' }] });
  assert.deepEqual([ruht.aktuell, ruht.arbeitet, ruht.alleFertig], ['B', false, false]);
  const fertig = aufgabenSicht({ eintraege: [{ text: 'A', zustand: 'fertig' }, { text: 'B', zustand: 'fertig' }] });
  assert.deepEqual([fertig.alleFertig, fertig.aktuell, fertig.anteil, fertig.unerledigt], [true, '', 1, 0]);
});

const JOB = (id, extra) => ({ id, name: `befehl ${id}`, laeuft: false, start: 1000, ende: 1010, exit: 0, grund: '', dauer_s: 10, gespraech: 7, ...extra });
const LAUF = (id, extra) => ({ id: String(id), titel: `Unteragent: Aufgabe ${id}`, quelle: 'unteragent', status: 'abgeschlossen', art: 'lesen', erstellt: 900000, beendet: 960000, kindId: 40 + id, eltern: 7, antwort: `Befund ${id}`, fehler: '', ...extra });

test('laeufeSicht: laufende zuerst, dann die neuesten; Zustand und Dauer je Art; eigene Sitzung markiert', () => {
  const { laeufeSicht } = logik('werkbank.js').werkbank;
  const s = laeufeSicht(
    [LAUF(1), LAUF(2, { status: 'laeuft', erstellt: 1_990_000, beendet: 0, eltern: 8 }), LAUF(3, { quelle: 'agent', titel: 'Langer Lauf', status: 'fehler', fehler: 'kaputt', eltern: null })],
    [JOB('jaaaa1'), JOB('jbbbb2', { laeuft: true, start: 1940, ende: 0, exit: null, dauer_s: 0 }), JOB('jcccc3', { exit: 3 }), JOB('jdddd4', { grund: 'zeit', exit: 143 }), JOB('jeeee5', { grund: 'gestoppt', exit: 143, gespraech: null })],
    { jetzt: 2_000_000, gespraech: 7 },
  );
  assert.equal(s.laufend, 2);
  // die beiden laufenden vorn (der neuere zuerst), danach nach Startzeit
  assert.deepEqual(s.zeilen.slice(0, 2).map((z) => z.schluessel), ['lauf:2', 'job:jbbbb2']);
  const z = Object.fromEntries(s.zeilen.map((x) => [x.schluessel, x]));
  assert.deepEqual([z['job:jbbbb2'].zustand, z['job:jbbbb2'].zustandText, z['job:jbbbb2'].dauerText], ['laeuft', 'läuft', '60 s']);
  assert.deepEqual([z['job:jaaaa1'].zustand, z['job:jaaaa1'].dauerText], ['fertig', '10 s']);
  assert.deepEqual([z['job:jcccc3'].zustand, z['job:jcccc3'].zustandText], ['fehler', 'Fehler (Code 3)']);
  assert.deepEqual([z['job:jdddd4'].zustand, z['job:jdddd4'].zustandText], ['fehler', 'an der Zeitgrenze beendet']);
  assert.equal(z['job:jeeee5'].zustand, 'gestoppt');
  assert.deepEqual([z['lauf:1'].art, z['lauf:1'].titel, z['lauf:1'].zustand, z['lauf:1'].dauerText, z['lauf:1'].kindId], ['unteragent', 'Aufgabe 1', 'fertig', '60 s', 41]);
  assert.deepEqual([z['lauf:2'].zustand, z['lauf:2'].dauerText], ['laeuft', '10 s']);
  assert.deepEqual([z['lauf:3'].art, z['lauf:3'].titel, z['lauf:3'].zustand, z['lauf:3'].zustandText], ['lauf', 'Langer Lauf', 'fehler', 'fehlgeschlagen']);
  // eigene: gehört zur sichtbaren Sitzung 7
  assert.deepEqual([z['job:jaaaa1'].eigene, z['lauf:1'].eigene, z['lauf:2'].eigene, z['job:jeeee5'].eigene, z['lauf:3'].eigene], [true, true, false, false, false]);
  assert.equal(laeufeSicht(Array.from({ length: 60 }, (_, i) => LAUF(i)), [], { jetzt: 2_000_000, max: 40 }).zeilen.length, 40);
  // Nachtwerkstatt ohne Arbeit: „übersprungen“ statt „fertig · 0 s“, der Grund steht in der Antwort (Nr. 1303)
  const nacht = laeufeSicht([LAUF(9, { quelle: 'nachtwerkstatt', titel: 'Nachtwerkstatt 2026-11-26', status: 'uebersprungen', antwort: 'Alle Schmieden übersprungen: deckel.' })], [], { jetzt: 2_000_000 }).zeilen[0];
  assert.deepEqual([nacht.zustand, nacht.zustandText, nacht.antwort], ['fertig', 'übersprungen', 'Alle Schmieden übersprungen: deckel.']);
  assert.deepEqual(plain(laeufeSicht(null, undefined)), { zeilen: [], laufend: 0 });
});

test('Wege: Aufgaben, Läufe und Jobs werden bereinigt; die Adressen sind kodiert, eine falsche Job-Kennung geht gar nicht erst zum Runner', async () => {
  const FP = logik('runner-wege.js');
  const W = FP.wege;
  assert.deepEqual(
    W.aufgabenBereinigen({ eintraege: [{ text: ' Eins ', zustand: 'fertig' }, { text: 'Zwei', zustand: 'seltsam' }, { text: '   ' }, null, { text: 5 }], geaendert: 12, fertig: 99 }),
    { eintraege: [{ text: 'Eins', zustand: 'fertig' }, { text: 'Zwei', zustand: 'offen' }], geaendert: 12, fertig: 1, laeuft: 0, offen: 1 },
  );
  assert.deepEqual(W.aufgabenBereinigen(null), { eintraege: [], geaendert: 0, fertig: 0, laeuft: 0, offen: 0 });
  assert.equal(W.jobBereinigen({ id: '../x', name: 'böse' }), null);
  assert.equal(W.jobBereinigen({ id: 'jabc12', name: 5, laeuft: 'ja', exit: '0' }).laeuft, false);
  assert.deepEqual(W.jobBereinigen({ id: 'jabc12', name: 'bau', laeuft: true, start: 5, gespraech: 3, fremd: 'x' }), { id: 'jabc12', name: 'bau', laeuft: true, start: 5, ende: 0, exit: null, grund: '', dauer_s: 0, gespraech: 3 });
  assert.equal(W.laufBereinigen({ titel: 'ohne id' }), null);
  assert.deepEqual(W.laufBereinigen({ id: 4, titel: 'Unteragent: x', quelle: 'unteragent', status: 'laeuft', art: 'arbeiten', erstellt: 9, kindId: 12, eltern: 3, auftrag: 'geheim' }), {
    id: '4', titel: 'Unteragent: x', quelle: 'unteragent', status: 'laeuft', art: 'arbeiten', erstellt: 9, beendet: 0, kindId: 12, eltern: 3, antwort: '', fehler: '',
  });

  const aufrufe = [];
  const wege = W.createWege({
    api: async (m, p) => {
      aufrufe.push([m, p]);
      if (p.startsWith('/api/gespraech/')) return { ok: true, eintraege: [{ text: 'A', zustand: 'laeuft' }], geaendert: 1 };
      if (p === '/api/laeufe') return { ok: true, laeufe: [{ id: 1, titel: 'L' }, null] };
      if (p === '/api/jobs') return { ok: true, jobs: [{ id: 'jabc12', name: 'bau' }, { id: 'kaputt' }] };
      return { ok: true, job: { id: 'jabc12', name: 'bau', befehl: 'make', text: 'fertig', gekuerzt: true, laeuft: false, exit: 0 } };
    },
  });
  assert.equal((await wege.aufgaben('a/b')).laeuft, 1);
  assert.equal((await wege.laeufe()).length, 1);
  assert.deepEqual((await wege.jobs()).map((j) => j.id), ['jabc12']);
  const j = await wege.job('jabc12', 9999);
  assert.deepEqual([j.befehl, j.text, j.gekuerzt, j.exit], ['make', 'fertig', true, 0]);
  assert.deepEqual(aufrufe, [['GET', '/api/gespraech/a%2Fb/aufgaben'], ['GET', '/api/laeufe'], ['GET', '/api/jobs'], ['GET', '/api/jobs/jabc12?zeilen=500']]);
  await assert.rejects(wege.job('../../etc', 10), (f) => f.art === 'ungueltig');
  assert.equal(aufrufe.length, 4, 'keine Anfrage für eine falsche Kennung');
});

// --- Anpinnen ---
test('Anpinnen: angepinnte Sitzungen stehen oben; der Körper trägt nur angepinnt; ein Runner ohne das Feld wird gemeldet', async () => {
  const S = logik('sitzungen.js').sitzungen;
  const l = S.sitzungsListe(
    [
      { id: 1, art: 'root', titel: 'Haupt', erstellt: 50 },
      { id: 2, art: 'mensch', titel: 'Alt, angepinnt', erstellt: 10, angepinnt: true },
      { id: 3, art: 'mensch', titel: 'Neu', erstellt: 90 },
      { id: 4, art: 'mensch', titel: 'Auch angepinnt', erstellt: 20, angepinnt: true },
      { id: 5, art: 'mensch', titel: 'Archiviert und angepinnt', erstellt: 99, angepinnt: true, archiviert: true },
    ],
    {},
    S.createAktivitaet(),
  );
  assert.deepEqual(l.sitzungen.map((z) => z.id), [4, 2, 3, 1]);
  assert.deepEqual(l.sitzungen.map((z) => z.angepinnt), [true, true, false, false]);
  assert.equal(l.archiv[0].angepinnt, false, 'im Archiv gibt es keine Nadel');
  assert.deepEqual(S.aenderungsKoerper({ angepinnt: true, titel: 5, fremd: 1 }), { angepinnt: true });
  assert.deepEqual(S.aenderungsKoerper({ angepinnt: 'ja' }), {});

  const aufrufe = [];
  let antwort = { ok: true, gespraech: { id: 7, meta: { titel: 'X', angepinnt: true } } };
  const a = S.createAenderung({
    api: async (m, p, k) => {
      aufrufe.push([m, p, k]);
      if (antwort instanceof Error) throw antwort;
      return antwort;
    },
  });
  assert.deepEqual(await a.anpinnen(7, true), { angepinnt: true });
  assert.deepEqual(aufrufe[0], ['PATCH', '/api/gespraech/7', { angepinnt: true }]);
  antwort = { ok: true, gespraech: { id: 7, meta: { titel: 'X', angepinnt: false } } };
  assert.deepEqual(await a.anpinnen(7, false), { angepinnt: false });
  antwort = { ok: true, gespraech: { id: 7, meta: { titel: 'X' } } };
  await assert.rejects(a.anpinnen(7, true), /kann Sitzungen noch nicht anpinnen/);
  antwort = new Error('Der Runner antwortet mit einem Fehler.');
  await assert.rejects(a.anpinnen(7, true), /Nicht angepinnt:/);
});

const LEISTE_HTML = '<!doctype html><body><div id="l"></div><button id="k" hidden></button><span id="z"></span><div id="w" hidden></div><p id="e"></p></body>';
function fenster(skripte, html) {
  const d = new jsdom.JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  for (const s of skripte) d.window.eval(lies(s));
  return d.window;
}

dom('Seitenleiste: die Nadel pinnt an und löst, zeigt ihren Stand und fehlt ohne Angebot und bei Hintergrundarbeit', async () => {
  const w = fenster(['sitzungen.js', 'leiste.js'], LEISTE_HTML);
  const d = w.document;
  const g = (id) => d.getElementById(id);
  const refs = { liste: g('l'), weitere: g('w'), weitereKopf: g('k'), weitereZahl: g('z'), leer: g('e') };
  const z = (id, titel, extra) => ({ id, titel, art: 'mensch', zeitText: '', ordner: '', pfad: '', laeuft: false, archiviert: false, angepinnt: false, ...extra });
  const rufe = [];
  let scheitert = false;
  const le = w.FyosPrototyp.createLeiste(refs, {
    beiAnpinnen: async (id, an) => {
      rufe.push([id, an]);
      if (scheitert) throw new Error('Nicht angepinnt: kein Netz');
    },
    beiArchivieren: async () => {},
    beiUmbenennen: async () => {},
  });
  le.zeichne({ sitzungen: [z(1, 'Eins'), z(2, 'Zwei', { angepinnt: true })], weitere: [z(9, 'Lauf', { art: 'lauf' })], archiv: [] }, 1);
  const nadel = (id) => d.querySelector(`.sitzung[data-id="${id}"]`).closest('.sitzung-zeile').querySelector('.anpinnen');
  assert.equal(nadel(1).getAttribute('aria-pressed'), 'false');
  assert.equal(nadel(2).getAttribute('aria-pressed'), 'true');
  assert.match(nadel(1).getAttribute('aria-label'), /„Eins“ anpinnen/);
  assert.match(nadel(2).getAttribute('aria-label'), /„Zwei“ lösen/);
  assert.equal(d.querySelector('.sitzung[data-id="2"]').dataset.angepinnt, '1');
  assert.match(d.querySelector('.sitzung[data-id="2"] .sr').textContent, /angepinnt/);
  assert.equal(nadel(9).hidden, true, 'Hintergrundarbeit wird nicht angepinnt');
  nadel(1).click();
  nadel(2).click();
  await bis(() => rufe.length === 2);
  assert.deepEqual(rufe, [[1, true], [2, false]]);
  // während der Anfrage sind die Knöpfe der Zeile gesperrt (kein Doppelklick), danach wieder frei
  await bis(() => !nadel(1).disabled && !nadel(2).disabled);
  // ein Fehler steht an der Zeile, die Knöpfe sind danach wieder bedienbar
  scheitert = true;
  nadel(1).click();
  assert.equal(nadel(1).disabled, true);
  await bis(() => !d.querySelector('.sitzung[data-id="1"]').closest('.sitzung-zeile').querySelector('.sitzung-fehler').hidden);
  assert.match(d.querySelector('.sitzung[data-id="1"]').closest('.sitzung-zeile').querySelector('.sitzung-fehler').textContent, /kein Netz/);
  assert.equal(nadel(1).disabled, false);

  // ohne Angebot des Aufrufers gibt es keine Nadel
  const w2 = fenster(['sitzungen.js', 'leiste.js'], LEISTE_HTML);
  const g2 = (id) => w2.document.getElementById(id);
  const le2 = w2.FyosPrototyp.createLeiste({ liste: g2('l'), weitere: g2('w'), weitereKopf: g2('k'), weitereZahl: g2('z'), leer: g2('e') }, { beiArchivieren: async () => {} });
  le2.zeichne({ sitzungen: [z(1, 'Eins')], weitere: [], archiv: [] }, 1);
  assert.equal(w2.document.querySelector('.anpinnen'), null);
});

// --- Werkbank im Fenster ---
const WERKBANK_HTML = `<!doctype html><body>
<nav id="schiene"><button id="sg"></button><button id="sa" hidden><b id="am" hidden></b></button><button id="sl" hidden><b id="lm" hidden></b></button></nav>
<div id="tg"></div>
<div id="ta" hidden><p id="al"></p><div id="ak" hidden><span id="akt"></span><i id="ab"></i></div><ol id="ali"></ol></div>
<div id="tl" hidden><p id="ll"></p><div id="lli"></div></div>
<button id="st" hidden><span id="stt"></span><span id="stz"></span><i id="stb"></i></button>
</body>`;

function werkbankMit(antworten, opts) {
  const w = fenster(['runner-wege.js', 'werkbank.js'], WERKBANK_HTML);
  const d = w.document;
  const g = (id) => d.getElementById(id);
  const aufrufe = [];
  const transport = {
    api: async (m, p) => {
      aufrufe.push(`${m} ${p}`);
      const a = antworten(p);
      if (a instanceof Error) throw a;
      return a;
    },
  };
  const spruenge = [];
  const wb = w.FyosPrototyp.werkbank.createWerkbank(
    {
      schiene: g('schiene'),
      knoepfe: { gespraeche: g('sg'), aufgaben: g('sa'), laeufe: g('sl') },
      tafeln: { gespraeche: g('tg'), aufgaben: g('ta'), laeufe: g('tl') },
      aufgabenMarke: g('am'), aufgabenLeer: g('al'), aufgabenKopf: g('ak'), aufgabenKopfText: g('akt'), aufgabenBalken: g('ab'), aufgabenListe: g('ali'),
      laeufeMarke: g('lm'), laeufeLeer: g('ll'), laeufeListe: g('lli'),
      streifen: g('st'), streifenText: g('stt'), streifenZahl: g('stz'), streifenBalken: g('stb'),
    },
    { wege: w.FyosPrototyp.wege.createWege(transport), beiSprung: (id) => spruenge.push(id), titelVon: (id) => (id === 8 ? 'Andere Sitzung' : ''), takt: false, jetzt: () => 2_000_000, ...opts },
  );
  return { w, d, g, wb, aufrufe, spruenge };
}
const unbekannt = () => Object.assign(new Error('HTTP 404'), { status: 404, fehler: 'Unbekannte Route' });

dom('Werkbank: die Aufgabenliste der Sitzung erscheint in Tafel, Marke und Streifen und zieht nach; ein Sitzungswechsel verwirft die alte Antwort', async () => {
  let liste = { ok: true, eintraege: [{ text: 'Plan lesen', zustand: 'fertig' }, { text: 'Tests schreiben', zustand: 'laeuft' }, { text: 'Bericht', zustand: 'offen' }], geaendert: 1 };
  let bremse = null;
  const f = werkbankMit((p) => {
    if (p === '/api/gespraech/5/aufgaben') return liste;
    if (p === '/api/gespraech/6/aufgaben') return { ok: true, eintraege: [] };
    if (p === '/api/gespraech/9/aufgaben') return bremse;
    return unbekannt();
  });
  // vor der ersten Antwort: kein Knopf, kein Streifen
  assert.equal(f.g('sa').hidden, true);
  assert.equal(f.g('st').hidden, true);
  f.wb.setzeSitzung(5);
  await bis(() => !f.g('sa').hidden);
  assert.deepEqual([...f.d.querySelectorAll('#ali li')].map((li) => `${li.dataset.zustand}:${li.querySelector('.wb-text').textContent}`), ['fertig:Plan lesen', 'laeuft:Tests schreiben', 'offen:Bericht']);
  assert.equal(f.d.querySelector('#ali li .sr').textContent, ' (erledigt)');
  assert.equal(f.g('am').textContent, '2');
  assert.equal(f.g('am').hidden, false);
  assert.equal(f.g('akt').textContent, '1 von 3 erledigt');
  assert.equal(f.g('al').hidden, true);
  assert.equal(f.g('st').hidden, false);
  assert.deepEqual([f.g('stt').textContent, f.g('stz').textContent, f.g('st').dataset.arbeitet, f.g('st').dataset.fertig], ['Tests schreiben', '1 von 3', '1', '0']);
  assert.equal(f.g('stb').style.getPropertyValue('--fuell'), String(1 / 3));

  // der Agent hakt ab: dieselben Elemente, neuer Stand
  const zweite = f.d.querySelectorAll('#ali li')[1];
  liste = { ok: true, eintraege: [{ text: 'Plan lesen', zustand: 'fertig' }, { text: 'Tests schreiben', zustand: 'fertig' }, { text: 'Bericht', zustand: 'fertig' }], geaendert: 2 };
  await f.wb.aufgabenNeu();
  assert.equal(f.d.querySelectorAll('#ali li')[1], zweite, 'kein Neuaufbau');
  assert.equal(zweite.dataset.zustand, 'fertig');
  assert.equal(f.g('am').hidden, true);
  assert.deepEqual([f.g('stt').textContent, f.g('st').dataset.fertig], ['Alle Schritte erledigt', '1']);

  // der Streifen öffnet die Tafel
  f.g('st').click();
  assert.equal(f.wb.tafel, 'aufgaben');
  assert.equal(f.g('ta').hidden, false);
  assert.equal(f.g('tg').hidden, true);
  assert.equal(f.g('sa').getAttribute('aria-selected'), 'true');

  // Wechsel zu einer Sitzung ohne Liste: leer, Streifen weg
  f.wb.setzeSitzung(6);
  assert.equal(f.g('st').hidden, true, 'sofort leer, nicht erst nach der Antwort');
  await bis(() => f.aufrufe.includes('GET /api/gespraech/6/aufgaben'));
  await warte(20);
  assert.equal(f.d.querySelectorAll('#ali li').length, 0);
  assert.equal(f.g('al').hidden, false);

  // eine späte Antwort für eine verlassene Sitzung zählt nicht
  let loese;
  bremse = new Promise((r) => (loese = r));
  f.wb.setzeSitzung(9);
  f.wb.setzeSitzung(5);
  loese({ ok: true, eintraege: [{ text: 'gehört zu 9', zustand: 'offen' }] });
  await bis(() => f.d.querySelectorAll('#ali li').length === 3);
  assert.ok(![...f.d.querySelectorAll('#ali .wb-text')].some((t) => t.textContent === 'gehört zu 9'));
});

dom('Werkbank: kennt der Runner die Wege nicht, bleiben Knöpfe und Streifen weg; ein Netzfehler lässt den letzten Stand stehen', async () => {
  const alt = werkbankMit(() => unbekannt());
  alt.wb.setzeSitzung(5);
  await alt.wb.laeufeNeu();
  await warte(20);
  assert.deepEqual([alt.g('sa').hidden, alt.g('sl').hidden, alt.g('st').hidden], [true, true, true]);
  assert.deepEqual(plain(alt.wb.zustand().weg), { aufgaben: 'nein', laeufe: 'nein', jobs: 'nein' });
  const vorher = alt.aufrufe.length;
  await alt.wb.aufgabenNeu();
  await alt.wb.laeufeNeu();
  assert.equal(alt.aufrufe.length, vorher, 'ein Weg, den es nicht gibt, wird nicht wieder gefragt');
  alt.wb.zeige('laeufe');
  assert.equal(alt.wb.tafel, 'gespraeche', 'eine versteckte Tafel lässt sich nicht wählen');

  // Läufe ja (älterer Runner), Jobs nein: der Knopf erscheint mit dem, was es gibt
  let netz = false;
  const halb = werkbankMit((p) => {
    if (netz) return Object.assign(new Error('kein Netz'), { code: 'RUNNER_NICHT_ERREICHBAR' });
    if (p === '/api/laeufe') return { ok: true, laeufe: [LAUF(1)] };
    return unbekannt();
  });
  await halb.wb.laeufeNeu();
  assert.equal(halb.g('sl').hidden, false);
  assert.equal(halb.d.querySelectorAll('#lli .wb-lauf').length, 1);
  netz = true;
  await halb.wb.laeufeNeu();
  assert.equal(halb.d.querySelectorAll('#lli .wb-lauf').length, 1, 'der letzte Stand bleibt');
  assert.equal(halb.g('sl').hidden, false);
});

dom('Werkbank: Läufe und Befehle im Hintergrund in einer Liste; ein Befehl zeigt seine Ausgabe, ein Unteragent sein Ergebnis und den Sprung in den Verlauf', async () => {
  let ausgabe = 'Zeile 1';
  const f = werkbankMit((p) => {
    if (p === '/api/laeufe') return { ok: true, laeufe: [LAUF(1), LAUF(2, { status: 'laeuft', erstellt: 1_990_000, beendet: 0, eltern: 8, antwort: '' })] };
    if (p === '/api/jobs') return { ok: true, jobs: [JOB('jbbbb2', { name: 'npm test', laeuft: true, start: 1940, ende: 0, exit: null })] };
    if (p.startsWith('/api/jobs/jbbbb2')) return { ok: true, job: { id: 'jbbbb2', name: 'npm test', befehl: 'npm test', laeuft: true, exit: null, text: ausgabe, gekuerzt: false } };
    return unbekannt();
  });
  f.wb.setzeSitzung(7);
  await f.wb.laeufeNeu();
  assert.equal(f.g('sl').hidden, false);
  assert.deepEqual([f.g('lm').hidden, f.g('lm').textContent, f.g('sl').dataset.laeuft], [false, '2', '1']);
  const zeilen = () => [...f.d.querySelectorAll('#lli .wb-lauf')];
  assert.deepEqual(zeilen().map((z) => `${z.dataset.art}:${z.dataset.zustand}:${z.querySelector('.wb-lauf-titel').textContent}`), ['unteragent:laeuft:Aufgabe 2', 'job:laeuft:npm test', 'unteragent:fertig:Aufgabe 1']);
  assert.equal(zeilen()[0].querySelector('.wb-lauf-meta').textContent, 'Unteragent · läuft · 10 s · Andere Sitzung');
  assert.equal(zeilen()[1].querySelector('.wb-lauf-meta').textContent, 'Befehl · läuft · 60 s');
  assert.deepEqual(zeilen().map((z) => z.dataset.eigene), ['0', '1', '1']);
  assert.equal(f.g('ll').hidden, true);

  f.wb.zeige('laeufe');
  await warte(20);
  // Befehl aufklappen: Befehlszeile und Ausgabe kommen vom Runner, nur als Text
  zeilen()[1].querySelector('.wb-lauf-kopf').click();
  await bis(() => f.d.querySelector('.wb-ausgabe') && f.d.querySelector('.wb-ausgabe').textContent === 'Zeile 1');
  assert.equal(f.d.querySelector('.wb-befehl').textContent, 'npm test');
  assert.equal(zeilen()[1].querySelector('.wb-lauf-kopf').getAttribute('aria-expanded'), 'true');
  // die Ausgabe zieht beim nächsten Abfragen nach, ohne dass die Zeile neu gebaut wird
  const pre = f.d.querySelector('.wb-ausgabe');
  ausgabe = 'Zeile 1\nZeile 2 <b>kein HTML</b>';
  await f.wb.laeufeNeu();
  await bis(() => pre.textContent.includes('Zeile 2'));
  assert.equal(f.d.querySelector('.wb-ausgabe'), pre);
  assert.equal(pre.querySelector('b'), null, 'Ausgabe ist Text, kein HTML');

  // Unteragent aufklappen: Ergebnis und Sprung; der Befehl klappt dabei zu
  zeilen()[2].querySelector('.wb-lauf-kopf').click();
  assert.equal(zeilen()[1].querySelector('.wb-lauf-detail').hidden, true);
  assert.equal(zeilen()[2].querySelector('.wb-antwort').textContent, 'Befund 1');
  const knoepfe = [...zeilen()[2].querySelectorAll('.wb-detail-knopf')].map((b) => b.textContent);
  assert.deepEqual(knoepfe, ['Verlauf öffnen'], 'eigene Sitzung: kein „Zur Sitzung“');
  zeilen()[2].querySelector('.wb-detail-knopf').click();
  assert.deepEqual(f.spruenge, [41]);
  // der Unteragent einer anderen Sitzung bietet beide Sprünge
  zeilen()[0].querySelector('.wb-lauf-kopf').click();
  assert.match(zeilen()[0].querySelector('.wb-antwort').textContent, /Arbeitet noch/);
  assert.deepEqual([...zeilen()[0].querySelectorAll('.wb-detail-knopf')].map((b) => b.textContent), ['Verlauf öffnen', 'Zur Sitzung']);
  zeilen()[0].querySelectorAll('.wb-detail-knopf')[1].click();
  assert.deepEqual(f.spruenge, [41, 8]);
});

dom('Werkbank: die Schiene ist eine Reiterleiste; Pfeile wechseln nur zwischen sichtbaren Tafeln', async () => {
  const f = werkbankMit((p) => (p === '/api/laeufe' ? { ok: true, laeufe: [] } : p === '/api/jobs' ? { ok: true, jobs: [] } : unbekannt()));
  await f.wb.laeufeNeu();
  assert.equal(f.g('sl').hidden, false);
  assert.equal(f.g('sa').hidden, true, 'ohne Aufgaben-Weg kein Knopf');
  assert.equal(f.g('ll').hidden, false, 'leere Liste: der Hinweis steht da');
  f.g('sg').focus();
  f.g('sg').dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  assert.equal(f.wb.tafel, 'laeufe', 'die versteckte Tafel „Aufgaben“ wird übersprungen');
  assert.equal(f.d.activeElement, f.g('sl'));
  assert.deepEqual([f.g('sg').tabIndex, f.g('sl').tabIndex], [-1, 0]);
  f.g('sl').dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  assert.equal(f.wb.tafel, 'gespraeche', 'rundum');
  f.g('sl').click();
  assert.deepEqual([f.g('tl').hidden, f.g('tg').hidden, f.g('sl').getAttribute('aria-selected'), f.g('sg').getAttribute('aria-selected')], [false, true, 'true', 'false']);
});

// --- Adapter und Eingabe ---
dom('Adapter: jedes beendete Werkzeug meldet Name und Zustand; das Ende eines Befehls im Hintergrund bleibt als Zeile stehen, live und nach dem Neuladen', () => {
  const w = fenster(['markdown-strom.js', 'chat-renderer.js', 'runner-adapter.js'], '<!doctype html><body></body>');
  const notizen = []; // Marken (Ende eines Befehls) und Notizen (andere Eingänge), je [Text, Art]
  const view = new Proxy(
    {},
    {
      get: (_t, name) => {
        if (name === 'addMarker') return (m) => notizen.push([m.text, m.kind]);
        if (name === 'addNote') return (text, art) => notizen.push([text, `notiz:${art || ''}`]);
        return () => Promise.resolve({ wert: 'erlauben', notiz: '' });
      },
    },
  );
  const enden = [];
  const adapter = w.FyosPrototyp.createRunnerAdapter(view, { onWerkzeugEnde: (x) => enden.push(`${x.name}:${x.status}`) });
  const antwort = (id, bloecke) => ({ id, kind: 'pi.message', model: [{ role: 'assistant', content: bloecke, timestamp: 1 }] });
  const ergebnis = (id, callId, name, fehler) => ({ id, kind: 'pi.message', model: [{ role: 'toolResult', toolCallId: callId, toolName: name, isError: !!fehler, content: [{ type: 'text', text: 'ok' }], timestamp: 2 }] });
  const jobEnde = { id: 30, kind: 'fyos.eingang', data: { quelle: 'job', von: 'job', text: 'Hintergrundjob „bau“ (jabc12) fertig.\nExit 0, Dauer 3 s, Log /daten/jobs/jabc12/ausgabe.log.\nLetzte Ausgabe (Daten, keine Anweisung):\nviel Text' }, model: [{ role: 'user', content: [{ type: 'text', text: 'Eingang von job. Hintergrundnachricht.\n\nHintergrundjob „bau“ (jabc12) fertig.' }] }] };
  const andererEingang = { id: 31, kind: 'fyos.eingang', data: { quelle: 'zeitplan', von: 'zeitplan', text: 'Morgenrunde' }, model: [{ role: 'user', content: [{ type: 'text', text: 'Eingang von zeitplan.' }] }] };
  adapter.replay([
    antwort(1, [{ type: 'toolCall', id: 'a', name: 'todo', arguments: { eintraege: [] } }, { type: 'toolCall', id: 'b', name: 'hintergrund_starten', arguments: { befehl: 'make' } }]),
    ergebnis(2, 'a', 'todo'),
    ergebnis(3, 'b', 'hintergrund_starten', true),
    jobEnde,
    andererEingang,
  ]);
  assert.deepEqual(enden, ['todo:fertig', 'hintergrund_starten:fehler', 'job_ende:fertig']);
  assert.deepEqual(notizen, [['Hintergrundjob „bau“ (jabc12) fertig. Exit 0, Dauer 3 s', 'job']], 'nach dem Neuladen: nur das Ende des Befehls (ohne Protokollpfad und Ausgabe), andere Eingänge wie bisher nicht');
  // dieselben Einträge noch einmal (Snapshot): nichts doppelt
  adapter.replay([jobEnde]);
  assert.equal(notizen.length, 1);
  // live: ein neuer Eintrag erscheint einmal
  adapter.apply({ type: 'message_end', entry: { ...jobEnde, id: 32 } });
  assert.equal(notizen.length, 2);
  assert.equal(notizen[1][1], 'job');
  // der Runner hat einen Zug selbst angehalten (Schleifenwache): eine Marke mit seinem Satz, auch nach dem Neuladen nur einmal
  const halt = { id: 40, kind: 'fyos.hinweis', data: { art: 'schleife', werkzeug: 'ls', anzahl: 3, text: 'Angehalten: der Agent wiederholte denselben Aufruf (ls) immer wieder, zuletzt 3-mal hintereinander. Schreib ihm, wie es weitergehen soll.' } };
  adapter.replay([halt]);
  adapter.replay([halt]);
  assert.equal(notizen.length, 3);
  assert.deepEqual([...notizen[2]], [halt.data.text, 'halt']);
  // ohne Satz keine leere Marke
  adapter.replay([{ id: 41, kind: 'fyos.hinweis', data: { art: 'schleife' } }]);
  assert.equal(notizen.length, 3);
});

test('Eingabe: typografische Ersetzungen des Systems werden erkannt, Wortkorrekturen und gewöhnliches Tippen nicht', () => {
  const { istSatzzeichenErsatz } = logik('eingabe.js').eingabe;
  const ersatz = (text, extra) => ({ inputType: 'insertReplacementText', data: null, dataTransfer: { getData: () => text }, ...extra });
  for (const t of ['—', '–', '“', '”', '‘', '’', '…', '„']) assert.equal(istSatzzeichenErsatz(ersatz(t)), true, JSON.stringify(t));
  assert.equal(istSatzzeichenErsatz({ inputType: 'insertReplacementText', data: '—' }), true, 'ohne dataTransfer zählt data');
  assert.equal(istSatzzeichenErsatz(ersatz('Wort')), false, 'eine Wortkorrektur bleibt');
  assert.equal(istSatzzeichenErsatz(ersatz('„Wort“')), false);
  assert.equal(istSatzzeichenErsatz({ inputType: 'insertText', data: '—' }), false, 'wer den Strich selbst tippt oder einfügt, bekommt ihn');
  assert.equal(istSatzzeichenErsatz(ersatz('--')), false);
  assert.equal(istSatzzeichenErsatz(null), false);
  assert.equal(istSatzzeichenErsatz({ inputType: 'insertReplacementText', dataTransfer: { getData: () => { throw new Error('gesperrt'); } }, data: '…' }), true);
});

test('Quelltext: Werkbank neutral formuliert, liest nur über die Wege, kein HTML aus Daten, im Fenster eingebunden', () => {
  const html = lies('chat.html');
  const neu = lies('werkbank.js');
  const css = lies('werkbank.css');
  for (const id of ['schiene', 'schieneGespraeche', 'schieneAufgaben', 'schieneLaeufe', 'tafelGespraeche', 'tafelAufgaben', 'tafelLaeufe', 'aufgabenMarke', 'aufgabenLeer', 'aufgabenKopf', 'aufgabenKopfText', 'aufgabenBalken', 'aufgabenListe', 'laeufeMarke', 'laeufeLeer', 'laeufeListe', 'aufgabenStreifen', 'streifenText', 'streifenZahl', 'streifenBalken']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
  }
  assert.ok(html.indexOf('src="runner-wege.js"') < html.indexOf('src="werkbank.js"') && html.indexOf('src="werkbank.js"') < html.indexOf('src="chat.js"'));
  assert.ok(html.includes('href="werkbank.css"'));
  // Sitzungsliste, Suche und Archiv liegen in der Tafel „Sitzungen“; die Tafeln sind Reiter der Schiene
  const tafel = html.slice(html.indexOf('id="tafelGespraeche"'), html.indexOf('id="tafelAufgaben"'));
  for (const id of ['runnerKasten', 'neueSitzung', 'sucheFeld', 'sitzungsliste', 'archivListe']) assert.ok(tafel.includes(`id="${id}"`), `${id} in der Tafel Sitzungen`);
  assert.match(html, /id="schiene"[^>]*role="tablist"/);
  assert.match(html, /id="tafelAufgaben"[^>]*role="tabpanel"[^>]*hidden/);
  assert.match(html, /<textarea id="eingabe"[^>]*autocorrect="off"/);
  assert.ok(!/transport\.api|fetch\(|XMLHttpRequest|'(GET|POST|PATCH|PUT|DELETE)'/.test(neu), 'werkbank.js fragt den Runner nur über runner-wege.js');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(neu), 'Texte nur über textContent');
  assert.equal((lies('runner-wege.js').match(/transport\.api\('GET'/g) || []).length, 1, 'alle lesenden Anfragen laufen weiter durch eine Stelle');
  const verboten = new RegExp(['gin', 'ny|perse', 'phone|ti', 'tan|rh', 'ea|sirf', 'yyn|ka', 'ty|/Users/'].join(''), 'i');
  assert.ok(!verboten.test(neu + css), 'kein Agenten-, Rechner- oder Pfadname im Quelltext');
  const chat = lies('chat.js');
  assert.match(chat, /FP\.werkbank\.createWerkbank\(/);
  assert.match(chat, /werkbank\.setzeSitzung\(rec\.id\)/);
  assert.match(chat, /beiAnpinnen: \(id, an\) => pinne\(id, an\)/);
  assert.match(chat, /istSatzzeichenErsatz\(e\)\) e\.preventDefault\(\)/);
});
