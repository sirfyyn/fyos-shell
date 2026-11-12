// Modus der Sitzung in der Agent-Oberfläche: der Wähler in der Statuszeile (modus.js), der Wechsel über die Brücke (sitzungen.js),
// die Karte im Verlauf für Pläne und für Rückfragen mit „Für diese Sitzung“ (chat-renderer.js, runner-adapter.js) und das Freigaben-Panel.
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
function fenster(skripte, html) {
  const d = new jsdom.JSDOM(html || '<!doctype html><body><div id="verlauf"><div id="spalte"></div></div><button id="ende" hidden></button><div id="ansage"></div></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  for (const s of skripte) d.window.eval(lies(s));
  return d.window;
}

// --- Wähler ---
test('Modi der Sitzung: vier Stufen von vorsichtig nach frei; der Plan-Modus schaltet in den Modus von vorher zurück', () => {
  const M = logik('waehler.js', 'modus.js').modus;
  assert.deepEqual(M.SITZUNGSMODI.map((m) => m.wert), ['planen', 'fragen', 'frei', 'umgehen']);
  for (const m of M.SITZUNGSMODI) assert.ok(m.text && m.kurz && m.hilfe.length > 30, m.wert);
  assert.equal(M.sitzungsModus('umgehen').text, 'Berechtigungen umgehen');
  assert.equal(M.sitzungsModus('quatsch'), null);
  assert.equal(M.planUmschalten('frei'), 'planen');
  assert.equal(M.planUmschalten('umgehen'), 'planen');
  assert.equal(M.planUmschalten('planen', 'fragen'), 'fragen');
  assert.equal(M.planUmschalten('planen', undefined), 'frei');
  assert.equal(M.planUmschalten('planen', 'planen'), 'frei');
});

const MODUS_HTML = '<!doctype html><body><button id="k"></button><div id="m" hidden></div></body>';
dom('Modus-Wähler: kennt der Runner den Modus je Sitzung, sind die vier wählbar; sonst bleibt die Zeile als Anzeige', () => {
  const w = fenster(['waehler.js', 'modus.js'], MODUS_HTML);
  const d = w.document;
  const gewaehlt = [];
  const mo = w.FyosPrototyp.startModus(d.getElementById('k'), d.getElementById('m'), { beiModus: (x) => void gewaehlt.push(x), beiSendeArt: () => {} });
  const punkte = () => [...d.querySelectorAll('#m [role="option"]')].map((o) => `${o.getAttribute('aria-selected') === 'true' ? '*' : ''}${o.querySelector('.text').firstChild.textContent}${o.getAttribute('aria-disabled') === 'true' ? ' (gesperrt)' : ''}`);

  // ohne Modus je Sitzung: wie bisher eine gesperrte Zeile
  mo.zeichne({ pflicht: ['DESTRUCTIVE'], sitzung: null });
  assert.equal(d.getElementById('k').textContent, 'Zerstörendes fragt');
  assert.equal(d.getElementById('k').dataset.modus, '');
  assert.deepEqual(punkte().slice(0, 1), ['*Werkzeuge laufen durch, nur Zerstörendes fragt (gesperrt)']);

  // mit Modus je Sitzung
  mo.zeichne({ sitzung: 'frei' });
  assert.deepEqual(punkte().slice(0, 4), ['Planen', 'Vor Änderungen fragen', '*Frei, Zerstörendes fragt', 'Berechtigungen umgehen']);
  assert.deepEqual([d.getElementById('k').textContent, d.getElementById('k').dataset.modus], ['Zerstörendes fragt', 'frei']);
  mo.setze(true);
  d.querySelectorAll('#m [role="option"]')[0].click();
  assert.deepEqual(gewaehlt, ['planen']);
  mo.zeichne({ sitzung: 'planen' });
  assert.deepEqual([d.getElementById('k').textContent, d.getElementById('k').dataset.modus], ['Planen', 'planen']);
  assert.match(d.getElementById('k').title, /Modus der Sitzung: Planen\. Nur lesen/);
  mo.zeichne({ sitzung: 'umgehen', sendeArt: 'steuern' });
  assert.equal(d.getElementById('k').textContent, 'Berechtigungen umgehen · greift ein');
  // während des Wechsels: Knopf sagt es, die Punkte sind gesperrt
  mo.zeichne({ sitzung: 'umgehen', sendeArt: 'folgen', wechselt: true });
  assert.equal(d.getElementById('k').textContent, 'wechsle …');
  assert.ok(punkte().slice(0, 4).every((p) => p.endsWith('(gesperrt)')));
  // ein unbekannter Wert vom Runner zeigt die alte Zeile, keinen erfundenen Modus
  mo.zeichne({ sitzung: 'superfrei', wechselt: false });
  assert.equal(d.getElementById('k').textContent, 'Zerstörendes fragt');
});

test('Moduswechsel über die Brücke: PATCH nur mit modus; ein Runner ohne Modus und ein Fehler werden gemeldet', async () => {
  const S = logik('sitzungen.js').sitzungen;
  const aufrufe = [];
  let antwort = { ok: true, gespraech: { id: 7, meta: { titel: 'X', modus: 'planen' } } };
  const a = S.createAenderung({
    api: async (m, p, k) => {
      aufrufe.push([m, p, k]);
      if (antwort instanceof Error) throw antwort;
      return antwort;
    },
  });
  assert.deepEqual(await a.sitzungsmodus('a/b', 'planen'), { modus: 'planen' });
  assert.deepEqual(aufrufe[0], ['PATCH', '/api/gespraech/a%2Fb', { modus: 'planen' }]);
  antwort = { ok: true, gespraech: { id: 7, meta: { titel: 'X' } } };
  await assert.rejects(a.sitzungsmodus(7, 'frei'), /kennt keinen Modus je Sitzung/);
  antwort = Object.assign(new Error('Der Runner antwortet mit einem Fehler.'), { meldung: { details: 'HTTP 400: Unbekannter Modus' } });
  await assert.rejects(a.sitzungsmodus(7, 'x'), /Modus nicht gewechselt:.*Unbekannter Modus/);
});

// --- Karte im Verlauf ---
function ansicht(adapterOpts) {
  const w = fenster(['markdown-strom.js', 'terminal.js', 'chat-renderer.js', 'runner-adapter.js']);
  const FP = w.FyosPrototyp;
  const view = FP.createChatView(w.document.getElementById('spalte'), {
    scroller: w.document.getElementById('verlauf'),
    zumEnde: w.document.getElementById('ende'),
    ansage: w.document.getElementById('ansage'),
    raf: (f) => setTimeout(() => f(Date.now()), 0),
    caf: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    reduceMotion: () => true,
  });
  return { w, d: w.document, FP, view, adapter: FP.createRunnerAdapter(view, adapterOpts || {}) };
}
const knopf = (box, text) => [...box.querySelectorAll('button')].find((b) => b.firstChild.textContent.trim() === text);
const PLAN = '# Umbau\n\n1. `a.js` lesen\n2. **Tests** schreiben\n\n<img src=x onerror=alert(1)>';

dom('Plan-Karte: der Plan steht als gezeichnetes Markdown da; ausführen, ändern (nur mit Anmerkung) oder ablehnen', async () => {
  const gesendet = [];
  const f = ansicht({ onEntscheidung: (id, wert, notiz, extra) => gesendet.push([id, wert, notiz, extra]) });
  f.adapter.eintrag({ id: 1, kind: 'fyos.freigabe', data: { id: 'pl-1', art: 'plan', aktion: 'Umbau', risiko: 'low', kontext: 'Der Agent hat einen Plan vorgelegt.', plan: PLAN, status: 'offen' } });
  f.view.flush();
  const box = f.d.querySelector('.freigabe.plan');
  assert.ok(box, 'Plan-Karte');
  assert.equal(box.getAttribute('aria-label'), 'Plan zur Entscheidung');
  assert.match(box.querySelector('.fz-frage').textContent, /legt einen Plan vor: Umbau/);
  const plan = box.querySelector('.fz-plan');
  assert.equal(plan.querySelectorAll('li').length, 2, 'die Schritte sind eine Liste');
  assert.equal(plan.querySelector('code').textContent, 'a.js');
  assert.equal(plan.querySelector('strong').textContent, 'Tests');
  assert.equal(plan.querySelector('img'), null, 'HTML im Plan bleibt Text');
  assert.ok(plan.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.deepEqual([...box.querySelectorAll('.fz-knoepfe button')].map((b) => b.firstChild.textContent.trim()), ['Plan ausführen', 'Ändern', 'Ablehnen']);

  // „Ändern“ ohne Anmerkung entscheidet nichts und zeigt aufs Feld
  const feld = box.querySelector('.fz-notiz');
  knopf(box, 'Ändern').click();
  assert.equal(box.dataset.zustand, 'offen');
  assert.equal(feld.getAttribute('aria-invalid'), 'true');
  assert.equal(f.d.activeElement, feld);
  await warte(10);
  assert.deepEqual(gesendet, []);
  // Taste 3 mit Anmerkung: geändert
  feld.value = '  erst die Tests ';
  assert.equal(f.view.handleKey({ key: '3' }), true);
  await bis(() => gesendet.length === 1);
  assert.deepEqual(JSON.parse(JSON.stringify(gesendet[0])), ['pl-1', 'aendern', 'erst die Tests', { sitzung: false }]);
  assert.equal(box.dataset.zustand, 'geaendert');
  assert.equal(box.querySelector('.fz-ergebnis').textContent, 'Änderung gewünscht: Umbau · erst die Tests');

  // zweiter Plan: ausführen
  f.adapter.eintrag({ id: 2, kind: 'fyos.freigabe', data: { id: 'pl-2', art: 'plan', aktion: 'Umbau zwei', plan: '1. a\n2. b', status: 'offen' } });
  f.view.flush();
  const zwei = f.d.querySelectorAll('.freigabe.plan')[1];
  knopf(zwei, 'Plan ausführen').click();
  await bis(() => gesendet.length === 2);
  assert.deepEqual(JSON.parse(JSON.stringify(gesendet[1])), ['pl-2', 'erlauben', '', { sitzung: false }]);
  assert.equal(zwei.querySelector('.fz-ergebnis').textContent, 'Plan wird ausgeführt: Umbau zwei');
});

dom('Rückfrage: „Für diese Sitzung“ steht nur da, wenn der Runner es anbietet, und geht als Zustimmung mit sitzung hinaus', async () => {
  const gesendet = [];
  const f = ansicht({ onEntscheidung: (id, wert, notiz, extra) => gesendet.push([id, wert, notiz, extra]) });
  f.adapter.eintrag({ id: 1, kind: 'fyos.freigabe', data: { id: 'fr-1', aktion: 'Datei schreiben: a.txt', risiko: 'low', kontext: 'Modus fragen', werkzeug: 'write', status: 'offen', wartet: true, sitzungMoeglich: true } });
  f.adapter.eintrag({ id: 2, kind: 'fyos.freigabe', data: { id: 'fr-2', aktion: 'Befehl ausführen: rm -rf $X', risiko: 'high', werkzeug: 'bash', status: 'offen', wartet: true } });
  f.view.flush();
  const [eins, zwei] = f.d.querySelectorAll('.freigabe');
  assert.deepEqual([...eins.querySelectorAll('.fz-knoepfe button')].map((b) => b.firstChild.textContent.trim()), ['Erlauben', 'Für diese Sitzung', 'Ablehnen']);
  assert.deepEqual([...zwei.querySelectorAll('.fz-knoepfe button')].map((b) => b.firstChild.textContent.trim()), ['Erlauben', 'Ablehnen'], 'ohne Angebot kein dritter Knopf');
  knopf(eins, 'Für diese Sitzung').click();
  await bis(() => gesendet.length === 1);
  assert.deepEqual(JSON.parse(JSON.stringify(gesendet[0])), ['fr-1', 'erlauben', '', { sitzung: true }]);
  assert.equal(eins.querySelector('.fz-ergebnis').textContent, 'Für diese Sitzung erlaubt: Datei schreiben: a.txt');
  // Taste 3 hat bei der zweiten Karte keine Wirkung, Taste 2 lehnt ab
  assert.equal(f.view.handleKey({ key: '3' }), false);
  assert.equal(f.view.handleKey({ key: '2' }), true);
  await bis(() => gesendet.length === 2);
  assert.deepEqual(JSON.parse(JSON.stringify(gesendet[1])), ['fr-2', 'ablehnen', '', { sitzung: false }]);
});

dom('Entscheidung von außen (Panel, anderes Fenster): die Karte zieht nach, die Seite sendet sie nicht noch einmal', async () => {
  const gesendet = [];
  const f = ansicht({ onEntscheidung: (id, wert) => gesendet.push([id, wert]) });
  f.adapter.eintrag({ id: 1, kind: 'fyos.freigabe', data: { id: 'fr-1', aktion: 'A', status: 'offen', sitzungMoeglich: true } });
  f.adapter.eintrag({ id: 2, kind: 'fyos.freigabe', data: { id: 'pl-1', art: 'plan', aktion: 'P', plan: '1. x\n2. y', status: 'offen' } });
  f.adapter.eintrag({ id: 3, kind: 'fyos.freigabe-entscheidung', data: { id: 'fr-1', entscheidung: 'erteilt', sitzung: true } });
  f.adapter.eintrag({ id: 4, kind: 'fyos.freigabe-entscheidung', data: { id: 'pl-1', entscheidung: 'geaendert', notiz: 'kürzer' } });
  f.view.flush();
  await warte(30);
  const [eins, plan] = f.d.querySelectorAll('.freigabe');
  assert.deepEqual([eins.dataset.zustand, eins.querySelector('.fz-ergebnis').textContent], ['erlaubt', 'Für diese Sitzung erlaubt: A']);
  assert.deepEqual([plan.dataset.zustand, plan.querySelector('.fz-ergebnis').textContent], ['geaendert', 'Änderung gewünscht: P · kürzer']);
  assert.deepEqual(gesendet, [], 'nichts geht ein zweites Mal zum Runner');
  // nach dem Neuladen (Verlauf wird abgespielt) erscheinen sie gleich entschieden
  const g = ansicht({ onEntscheidung: (id, wert) => gesendet.push([id, wert]) });
  g.adapter.replay([
    { id: 1, kind: 'fyos.freigabe', data: { id: 'fr-1', aktion: 'A', status: 'offen' } },
    { id: 3, kind: 'fyos.freigabe-entscheidung', data: { id: 'fr-1', entscheidung: 'abgelehnt' } },
  ]);
  g.view.flush();
  await warte(30);
  assert.equal(g.d.querySelector('.freigabe').dataset.zustand, 'abgelehnt');
  assert.deepEqual(gesendet, []);
});

dom('Karte mit Befehl: er steht ganz und unverändert im Block, die Überschrift nennt ihn nicht noch einmal', () => {
  const lang = `git branch -D gibt-es-nicht\nfor f in a b c; do\n  echo "$f" >> liste.txt   # ${'x'.repeat(300)}\ndone\n<b>kein HTML</b>`;
  const f = ansicht({ befehlFuer: (id) => (id === 'fr-2' ? 'make sauber' : '') });
  f.adapter.eintrag({ id: 1, kind: 'fyos.freigabe', data: { id: 'fr-1', aktion: 'Befehl ausführen', risiko: 'high', kontext: 'Die Wache hat diesen Aufruf angehalten.', werkzeug: 'bash', befehl: lang, status: 'offen', wartet: true, sitzungMoeglich: true } });
  f.adapter.eintrag({ id: 2, kind: 'fyos.freigabe', data: { id: 'fr-2', aktion: 'Aufräumen', werkzeug: 'bash', status: 'offen' } });
  f.adapter.eintrag({ id: 3, kind: 'fyos.freigabe', data: { id: 'fr-3', aktion: 'Datei schreiben: a.txt', werkzeug: 'write', status: 'offen' } });
  f.view.flush();
  const [eins, zwei, drei] = f.d.querySelectorAll('.freigabe');
  // der Befehl am Eintrag: nichts gekürzt (er ist länger als die alte Grenze von 160 Zeichen), Zeilen bleiben, HTML bleibt Text
  assert.equal(eins.querySelector('.fz-befehl').textContent, lang);
  assert.equal(eins.querySelector('.fz-befehl').tagName, 'PRE');
  assert.equal(eins.querySelector('.fz-befehl b'), null);
  assert.match(eins.querySelector('.fz-frage').textContent, /will: Befehl ausführen$/);
  assert.equal(eins.querySelector('.fz-frage code'), null, 'kein zweites Mal in der Überschrift');
  // ohne Befehl am Eintrag kennt ihn die Liste der Freigaben
  assert.equal(zwei.querySelector('.fz-befehl').textContent, 'make sauber');
  // ohne Befehl: wie bisher das Werkzeug neben der Überschrift
  assert.equal(drei.querySelector('.fz-befehl'), null);
  assert.equal(drei.querySelector('.fz-frage code.inline').textContent, 'write');
  const css = lies('chat.css');
  assert.match(css, /\.fz-befehl \{[^}]*white-space: pre-wrap;[^}]*max-height: 30vh; overflow: auto;/);
});

dom('Neuladen während einer Rückfrage: der Zug bleibt offen, bis entschieden ist; ein abgewiesener Aufruf zeigt nur den Grund', () => {
  const aufruf = { id: 10, kind: 'pi.message', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'git branch -D x' } }], stopReason: 'toolUse' }] };
  const frage = { id: 11, kind: 'fyos.freigabe', data: { id: 'fr-1', aktion: 'Befehl ausführen', befehl: 'git branch -D x', werkzeug: 'bash', status: 'offen', wartet: true } };
  const f = ansicht();
  f.adapter.replay([aufruf, frage]);
  f.view.flush();
  assert.equal(f.adapter.laeuft, true, 'der Aufruf wartet: der Zug ist nicht zu Ende');
  assert.equal(f.view.busy, true);
  // der Runner meldet den offenen Lauf, ohne dass gerade etwas zu sehen wäre: die Ansicht bleibt im Zug
  f.adapter.snapshot({ entries: [], run: { id: 'r1' }, tools: [] });
  assert.equal(f.adapter.laeuft, true);
  // abgelehnt: Entscheidung, Ergebnis des Aufrufs in der Klammer des Laufs, Ende des Laufs
  f.adapter.apply({ type: 'entry_appended', entry: { id: 12, kind: 'fyos.freigabe-entscheidung', data: { id: 'fr-1', entscheidung: 'abgelehnt' } } });
  f.adapter.apply({
    type: 'tool_execution_end',
    toolCallId: 'c1',
    toolName: 'bash',
    entry: { id: 13, model: [{ role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: '<harness>\n[error] Tool call blocked: WACHE: vom Menschen abgelehnt.\nNicht ausgeführt.\n</harness>' }], isError: true }] },
  });
  f.adapter.apply({ type: 'run_end' });
  f.view.flush();
  assert.equal(f.adapter.laeuft, false);
  assert.equal(f.view.busy, false);
  assert.equal(f.d.querySelector('.freigabe').dataset.zustand, 'abgelehnt');
  const karte = f.d.querySelector('.karte[data-art="bash"]');
  assert.equal(karte.dataset.zustand, 'fehler');
  // der Grund steht als eigene Zeile da, ohne die Klammer des Laufs; eine Ausgabe gab es nicht
  assert.deepEqual([...karte.querySelectorAll('.karte-hinweis.fehler')].map((h) => h.textContent), ['WACHE: vom Menschen abgelehnt.\nNicht ausgeführt.']);
  assert.ok(!karte.textContent.includes('harness') && !karte.textContent.includes('Tool call blocked'));
  assert.equal(karte.querySelector('.terminal-fuss'), null, 'ein abgewiesener Befehl hat keinen Exit-Code');

  // ist die Rückfrage im Verlauf schon entschieden, schließt das Abspielen den Zug wie bisher
  const g = ansicht();
  g.adapter.replay([aufruf, frage, { id: 12, kind: 'fyos.freigabe-entscheidung', data: { id: 'fr-1', entscheidung: 'erteilt' } }]);
  assert.equal(g.adapter.laeuft, false);
  // eine Freigabe, auf die kein Aufruf wartet (der Agent hat seinen Zug beendet), hält nichts offen
  const h = ansicht();
  h.adapter.replay([aufruf, { id: 11, kind: 'fyos.freigabe', data: { id: 'fr-9', aktion: 'A', status: 'offen' } }]);
  assert.equal(h.adapter.laeuft, false);
  // und ein Snapshot ohne Lauf lässt die Ansicht in Ruhe
  h.adapter.snapshot({ entries: [] });
  assert.equal(h.adapter.laeuft, false);
});

dom('Was der Runner dem Agenten selbst schreibt, erscheint als Marke zwischen den Zügen, nicht als Nachricht des Menschen', () => {
  const f = ansicht();
  const lang = 'Der Plan pl-1 („Umbau“) ist genehmigt. Setze ihn jetzt Schritt für Schritt um.\n\n[Modus der Sitzung: frei] Du arbeitest wieder ohne Rückfragen.';
  f.adapter.eintrag({ id: 1, kind: 'fyos.mensch', data: { text: 'Bitte räum auf.', von: 'mensch' } });
  f.adapter.eintrag({ id: 2, kind: 'fyos.mensch', data: { text: lang, von: 'runner', kurz: 'Plan genehmigt' } });
  // ohne kurze Zeile (älterer Runner): der erste Satz
  f.adapter.eintrag({ id: 3, kind: 'fyos.mensch', data: { text: lang, von: 'runner' } });
  f.view.flush();
  assert.equal(f.d.querySelectorAll('.mensch').length, 1, 'nur die Nachricht des Menschen ist eine Blase');
  assert.equal(f.d.querySelector('.mensch .blase').textContent, 'Bitte räum auf.');
  assert.deepEqual([...f.d.querySelectorAll('.marker[data-kind="runner"] .marker-text')].map((m) => m.textContent), ['Plan genehmigt', 'Der Plan pl-1 („Umbau“) ist genehmigt.']);
  assert.equal(f.d.querySelectorAll('.zug').length, 0, 'die Marke öffnet keinen leeren Zug');
  // auch eine Hinweiszeile außerhalb eines Zugs (Moduswechsel) steht für sich und macht die Ansicht nicht beschäftigt
  f.view.addNote('Modus der Sitzung: Planen.');
  f.view.flush();
  assert.equal(f.d.querySelector('#spalte > .notiz').textContent, 'Modus der Sitzung: Planen.');
  assert.deepEqual([f.d.querySelectorAll('.zug').length, f.view.busy], [0, false]);
  // in einem laufenden Zug bleibt sie darin
  f.view.startTurn({});
  f.view.addNote('im Zug');
  f.view.flush();
  assert.equal(f.d.querySelector('.zug > .notiz').textContent, 'im Zug');
});

test('Signalfarbe sparsam: nur der Hauptknopf und Laufendes tragen sie; Gewähltes, Fokus und Rahmen sind neutral', () => {
  const dateien = ['chat.css', 'arbeitsplatz.css', 'plattform.css', 'werkbank.css', 'aenderungen.css', 'freigaben.css'];
  const regeln = dateien.flatMap((n) => lies(n).split('\n').map((zeile) => ({ n, zeile })).filter((x) => /var\(--akzent\)|255, 45, 149|ff2d95/i.test(x.zeile)));
  // erlaubt: die Variable selbst, der Hauptknopf, und was läuft (Punkt, Cursor, Symbol, Zeiger der Aufgabe, Zahl an der Schiene)
  const erlaubt = [
    /^\s*--akzent: #ff2d95;/,
    /^button\.primaer \{/,
    /^\.zustand\.arbeitet \.punkt \{/,
    /^\s*background: var\(--akzent\); animation: cursor /,
    /^\.karte\[data-zustand="laeuft"\] \.symbol, \.gruppe\[data-zustand="laeuft"\] \.symbol \{/,
    /^\.sitzung\[data-laeuft="1"\] \.sitzung-punkt \{/,
    /^\.schiene-knopf\[data-laeuft="1"\] \.schiene-marke \{/,
    /^\.wb-aufgabe\[data-zustand="laeuft"\] \.wb-marke \{/,
    /^\.wb-lauf\[data-zustand="laeuft"\] \.wb-punkt \{/,
    /^\.wb-streifen\[data-arbeitet="1"\] \.wb-punkt \{/,
  ];
  const fremd = regeln.filter((x) => !erlaubt.some((re) => re.test(x.zeile)));
  assert.deepEqual(fremd.map((x) => `${x.n}: ${x.zeile.trim().slice(0, 90)}`), [], 'die Signalfarbe steht nur an den genannten Stellen');
  assert.equal(regeln.length, erlaubt.length, 'jede erlaubte Stelle gibt es genau einmal');
  const css = lies('chat.css');
  for (const v of ['--linie-stark', '--wahl', '--fokus', '--verweis']) assert.match(css, new RegExp(`\\n  ${v}: `), v);
  // Ein Hauptknopf zur Zeit: „Neue Sitzung“ ist keiner mehr, und „Senden“ ist ruhig, solange der Agent arbeitet oder eine Karte wartet
  assert.match(lies('chat.html'), /<button id="neueSitzung" type="button" class="neu-knopf"/);
  assert.match(css, /button\.primaer\[data-art="einreihen"\], button\.primaer\[data-art="wartet"\] \{ background: var\(--flaeche2\);/);
  assert.match(lies('chat.js'), /\$\('senden'\)\.dataset\.art = s\.busy \? 'einreihen' : s\.wartet \? 'wartet' : 'senden';/);
});

// --- Freigaben-Panel ---
const FREIGABEN_HTML = '<!doctype html><body><button id="kn" hidden></button><button id="ba" hidden></button><b id="za">0</b><aside id="pa" hidden><button id="zu"></button><p id="hi" hidden></p><div id="li"></div></aside></body>';
function panelMit(liste) {
  const w = fenster(['freigaben.js'], FREIGABEN_HTML);
  const d = w.document;
  const g = (id) => d.getElementById(id);
  const z = { liste, posts: [], entschieden: [] };
  const transport = {
    api: async (methode, pfad, koerper) => {
      if (methode === 'GET') return { ok: true, freigaben: z.liste };
      z.posts.push([decodeURIComponent(pfad.split('/').pop()), koerper]);
      z.liste = z.liste.map((f) => (String(f.id) === z.posts.at(-1)[0] ? { ...f, status: koerper.entscheidung } : f));
      return { ok: true, freigaben: z.liste };
    },
  };
  const fp = w.FyosPrototyp.createFreigaben(
    { knopf: g('kn'), zahl: g('za'), panel: g('pa'), liste: g('li'), zu: g('zu'), hinweis: g('hi'), banner: g('ba') },
    { transport, beiEntschieden: (id, e) => z.entschieden.push([id, e]) },
  );
  fp.setze(liste);
  fp.zeige(true);
  return { w, d, fp, z, karte: (id) => d.querySelector(`.fp-karte[data-id="${id}"]`) };
}
const fg = (id, extra) => ({ id, conversationId: 3, gespraechTitel: 'Sitzung 3', aktion: `Aktion ${id}`, risiko: 'medium', kontext: `Kontext ${id}`, befehl: null, werkzeug: null, status: 'offen', erstellt: 1, ...extra });

dom('Freigaben-Panel: ein Plan zeigt seinen Text und Ausführen, Ändern, Nein; „Für diese Sitzung“ geht mit sitzung hinaus, Zerstörendes erst nach der zweiten Bestätigung', async () => {
  const f = panelMit([
    fg('pl-1', { art: 'plan', aktion: 'Umbau', plan: '1. eins\n2. <b>zwei</b>', risiko: 'low' }),
    fg('fr-1', { sitzungMoeglich: true, wartet: true, werkzeug: 'write' }),
    fg('fr-2', { sitzungMoeglich: true, wartet: true, zerstoererisch: true, risiko: 'high', befehl: 'git reset --hard' }),
    fg('fr-3', {}),
  ]);
  await warte(20);
  const plan = f.karte('pl-1');
  assert.equal(plan.querySelector('.fp-titel').textContent, 'Plan');
  assert.equal(plan.querySelector('.fp-plan').textContent, '1. eins\n2. <b>zwei</b>');
  assert.equal(plan.querySelector('.fp-plan b'), null, 'der Plan ist Text');
  assert.deepEqual([...plan.querySelectorAll('.fp-knoepfe button')].map((b) => b.textContent), ['Ausführen', 'Ändern', 'Nein', 'Später']);
  assert.deepEqual([...f.karte('fr-1').querySelectorAll('.fp-knoepfe button')].map((b) => b.textContent), ['Erlauben', 'Für diese Sitzung', 'Ablehnen', 'Später']);
  assert.deepEqual([...f.karte('fr-3').querySelectorAll('.fp-knoepfe button')].map((b) => b.textContent), ['Erlauben', 'Ablehnen', 'Später'], 'ohne Angebot kein Knopf');

  f.karte('fr-1').querySelector('.fp-sitzung-erlauben').click();
  await bis(() => f.z.posts.length === 1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.z.posts[0])), ['fr-1', { entscheidung: 'erteilt', von: 'mensch', sitzung: true }]);
  // nach der Antwort des Runners: Hinweis im Panel, und der Aufrufer erfährt es (er zieht die Sitzungsliste nach)
  await bis(() => f.z.entschieden.length === 1);
  assert.equal(f.d.getElementById('hi').textContent, 'Für diese Sitzung erlaubt.');
  assert.deepEqual(f.z.entschieden, [['fr-1', 'erteilt']]);

  // zerstörerisch: „Für diese Sitzung“ fragt erst nach, die Bestätigung nennt die Sitzung
  f.karte('fr-2').querySelector('.fp-sitzung-erlauben').click();
  await warte(20);
  assert.equal(f.z.posts.length, 1, 'noch nichts gesendet');
  assert.match(f.karte('fr-2').querySelector('.fp-warnung').textContent, /Wirklich für die ganze Sitzung erlauben\?/);
  assert.equal(f.karte('fr-2').querySelector('.fp-wirklich').textContent, 'Wirklich für die Sitzung erlauben');
  f.karte('fr-2').querySelector('.fp-wirklich').click();
  await bis(() => f.z.posts.length === 2);
  assert.deepEqual(JSON.parse(JSON.stringify(f.z.posts[1])), ['fr-2', { entscheidung: 'erteilt', von: 'mensch', sitzung: true }]);

  // Plan: Ändern braucht die Anmerkung, Ausführen geht sofort
  plan.querySelector('.fp-aendern').click();
  await warte(20);
  assert.equal(f.z.posts.length, 2);
  f.karte('pl-1').querySelector('.fp-erlauben').click();
  await bis(() => f.z.posts.length === 3);
  assert.deepEqual(JSON.parse(JSON.stringify(f.z.posts[2])), ['pl-1', { entscheidung: 'erteilt', von: 'mensch' }]);
});

test('Quelltext: Entscheidungen tragen nur bekannte Felder; Moduswechsel und Kürzel sind eingebunden; neutral formuliert', () => {
  const echt = lies('echt.js');
  assert.match(echt, /wert === 'erlauben' \? 'erteilt' : wert === 'aendern' \? 'geaendert' : 'abgelehnt'/);
  assert.match(echt, /if \(extra && extra\.sitzung && wert === 'erlauben'\) koerper\.sitzung = true/);
  const chat = lies('chat.js');
  assert.match(chat, /beiModus: \(wert\) => wechsleModus\(wert\)/);
  assert.match(chat, /aenderung\.sitzungsmodus\(rec\.id, wert\)/);
  assert.match(chat, /e\.key\.toLowerCase\(\) === 'p'/);
  assert.match(chat, /sitzung: aktivModus\(\)/);
  const neu = lies('modus.js');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|transport\.api|fetch\(/.test(neu), 'der Wähler zeichnet nur Text und fragt den Runner nicht selbst');
  const verboten = new RegExp(['gin', 'ny|perse', 'phone|ti', 'tan|rh', 'ea|sirf', 'yyn|ka', 'ty|/Users/'].join(''), 'i');
  assert.ok(!verboten.test(neu), 'kein Agenten-, Rechner- oder Pfadname im Quelltext');
  // die Karte zeichnet den Plan mit dem Markdown-Zeichner, nicht als HTML
  const karte = lies('chat-renderer.js');
  assert.match(karte, /planEl = el\('div', 'fz-plan md'\);\s+const md = FP\.createMarkdownStream\(planEl\);/);
});
