// Werkzeugergebnisse in der Agent-Oberfläche (Paket A5 in FYOS-AGENT-LOKAL-PLAN): Exit-Code und gemessene Dauer eines Befehls, Meldungen des
// Laufs getrennt von der Ausgabe, Diff mit echten Zeilennummern aus dem Patch des Runners (runner-adapter.js, chat-renderer.js).
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
function logik(...dateien) {
  const w = { FyosPrototyp: {} };
  for (const n of dateien) new Function('window', 'globalThis', lies(n))(w, w);
  return w.FyosPrototyp;
}
function ansicht() {
  const d = new jsdom.JSDOM('<!doctype html><body><div id="verlauf"><div id="spalte"></div></div><button id="ende" hidden></button><div id="ansage"></div></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = d.window;
  for (const s of ['markdown-strom.js', 'terminal.js', 'chat-renderer.js', 'runner-adapter.js']) w.eval(lies(s));
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
  return { w, d: w.document, FP, view, adapter: FP.createRunnerAdapter(view, {}) };
}
const aufruf = (id, call, name, args, ts) => ({ id, kind: 'pi.message', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: call, name, arguments: args }], stopReason: 'toolUse', timestamp: ts }] });
const ergebnis = (id, call, name, texte, mehr) => ({ id, kind: 'pi.tool', model: [{ role: 'toolResult', toolCallId: call, toolName: name, content: texte.map((text) => ({ type: 'text', text })), isError: false, ...mehr }] });
const klammer = (...zeilen) => `<harness>\n${zeilen.join('\n')}\n</harness>`;

// So liefert der Runner den Patch eines `edit` (Kopfzeilen ohne Zeitstempel, vier Zeilen Umgebung)
const PATCH = [
  '--- src/a.js',
  '+++ src/a.js',
  '@@ -10,7 +10,8 @@',
  ' const a = 1;',
  ' const b = 2;',
  '',
  '-const summe = a - b;',
  '+const summe = a + b;',
  '+const mal = a * b;',
  ' ',
  ' export { summe };',
  ' // Ende',
  '@@ -40,3 +41,2 @@',
  ' function alt() {',
  '-  return 1;',
  ' }',
  '\\ No newline at end of file',
  '',
].join('\n');

test('diffAusPatch: Bereiche mit echten Zeilennummern; leere Umgebungszeilen, „No newline“ und neue Dateien', () => {
  const FP = logik('runner-adapter.js');
  const d = FP.diffAusPatch(PATCH, 'src/a.js');
  assert.equal(d.datei, 'src/a.js');
  assert.deepEqual(d.hunks.map((h) => [h.alt, h.neu, h.zeilen.length]), [[10, 10, 9], [40, 41, 3]]);
  assert.deepEqual(d.hunks[0].zeilen.map((z) => z[0]).join(''), '   -++   ');
  assert.deepEqual(d.hunks[0].zeilen[2], [' ', ''], 'eine ganz leere Zeile im Bereich ist unveränderte Umgebung');
  assert.deepEqual(d.hunks[1].zeilen, [[' ', 'function alt() {'], ['-', '  return 1;'], [' ', '}']]);
  // der Dateiname kommt notfalls aus dem Kopf des Patches
  assert.equal(FP.diffAusPatch(PATCH).datei, 'src/a.js');
  // neue Datei: der leere alte Bereich zählt nicht
  const neu = FP.diffAusPatch('--- /dev/null\n+++ b/neu.txt\n@@ -0,0 +1,2 @@\n+eins\n+zwei\n');
  assert.deepEqual([neu.datei, neu.hunks[0].neu, neu.hunks[0].zeilen], ['neu.txt', 1, [['+', 'eins'], ['+', 'zwei']]]);
  // kein Patch: null (dann gilt der Diff aus der Eingabe)
  for (const x of [undefined, '', 'kein patch', '--- a\n+++ b\n']) assert.equal(FP.diffAusPatch(x), null);
});

test('ausgabeTeile: Ausgabe ohne die Klammer des Laufs; Exit-Code, Kürzung, Hinweis und Abweisung als eigene Angaben', () => {
  const FP = logik('runner-adapter.js');
  assert.deepEqual(FP.ausgabeTeile('nur Ausgabe'), { text: 'nur Ausgabe', hinweise: [], exit: null, abgewiesen: false });
  const f = FP.ausgabeTeile(`zeile 1\nzeile 2\n${klammer('[info] Full output: /tmp/aus.log', '[warn] Output truncated to its end: 120 lines, 4096 bytes dropped', '[error] Command exited with code 2')}`);
  assert.equal(f.text, 'zeile 1\nzeile 2');
  assert.equal(f.exit, 2);
  assert.deepEqual(f.hinweise, [
    { stufe: 'info', text: 'Ganze Ausgabe: /tmp/aus.log' },
    { stufe: 'warn', text: 'Ausgabe gekürzt, das Ende ist behalten: 120 Zeilen, 4096 Bytes weggelassen' },
  ]);
  // mehrzeilige Meldung, Abweisung ohne Ausgabe
  const a = FP.ausgabeTeile(klammer('[error] Tool call blocked: PLAN-MODUS: Datei schreiben: a.txt ändert etwas.\nLies erst.'));
  assert.deepEqual(a, { text: '', hinweise: [{ stufe: 'error', text: 'PLAN-MODUS: Datei schreiben: a.txt ändert etwas.\nLies erst.' }], exit: null, abgewiesen: true });
  assert.deepEqual(FP.ausgabeTeile(`x\n${klammer('[error] Command timed out after 30 seconds')}`).hinweise, [{ stufe: 'error', text: 'Zeitlimit: nach 30 s abgebrochen' }]);
  // eine Klammer mitten in der Ausgabe (der Befehl hat sie selbst gedruckt) bleibt Ausgabe
  const mitte = `vorher\n${klammer('[info] gedruckt')}\nnachher`;
  assert.deepEqual(FP.ausgabeTeile(mitte), { text: mitte, hinweise: [], exit: null, abgewiesen: false });
  assert.deepEqual(FP.ausgabeTeile(undefined), { text: '', hinweise: [], exit: null, abgewiesen: false });
});

dom('Befehl: Exit-Code in der Fußzeile des Terminals und bei einem Fehler im Kopf; die Dauer ist die vom Runner gemessene', () => {
  const f = ansicht();
  f.adapter.replay([
    aufruf(1, 'b1', 'bash', { command: 'make' }, 1000),
    ergebnis(2, 'b1', 'bash', ['alles gebaut'], { durationMs: 2340, timestamp: 99000 }),
    aufruf(3, 'b2', 'bash', { command: 'make test' }, 100000),
    ergebnis(4, 'b2', 'bash', ['1 Test rot', klammer('[error] Command exited with code 2')], { isError: true, durationMs: 512, timestamp: 100600 }),
    aufruf(5, 'b3', 'bash', { command: 'sleep 99' }, 200000),
    ergebnis(6, 'b3', 'bash', [klammer('[error] Command timed out after 5 seconds')], { isError: true, durationMs: 5003, timestamp: 205100 }),
  ]);
  f.view.flush();
  const [ok, rot, limit] = f.d.querySelectorAll('.karte[data-art="bash"]');
  assert.deepEqual([ok.dataset.zustand, ok.querySelector('.terminal-fuss').textContent, ok.querySelector('.terminal-fuss').className], ['fertig', 'Exit 0', 'terminal-fuss']);
  assert.equal(ok.querySelector('.meta .exit'), null, 'Erfolg steht nicht im Kopf');
  assert.equal(ok.querySelector('.dauer').textContent, '2,3 s', 'gemessene Dauer, nicht der Abstand der Zeitstempel (98 s)');
  assert.equal(ok.querySelector('.ausgabe-pre').textContent, 'alles gebaut');
  assert.deepEqual([rot.dataset.zustand, rot.querySelector('.terminal-fuss').textContent, rot.querySelector('.meta .exit').textContent], ['fehler', 'Exit 2', 'Exit 2']);
  assert.ok(rot.querySelector('.terminal-fuss').classList.contains('fehler'));
  assert.equal(rot.querySelector('.ausgabe-pre').textContent, '1 Test rot', 'die Klammer des Laufs steht nicht in der Ausgabe');
  assert.equal(rot.querySelector('.karte-hinweise'), null, 'der Exit-Code ist kein eigener Hinweis');
  // Zeitlimit: kein Exit-Code, der Grund als Zeile
  assert.equal(limit.querySelector('.terminal-fuss'), null);
  assert.deepEqual([...limit.querySelectorAll('.karte-hinweis.fehler')].map((h) => h.textContent), ['Zeitlimit: nach 5 s abgebrochen']);
  assert.equal(limit.querySelector('.dauer').textContent, '5 s');
});

dom('Live angekommene Ausgabe wird am Ende mit der gespeicherten abgeglichen; kurze Aufrufe zeigen Millisekunden', () => {
  const f = ansicht();
  // nur die erste Zeile kam als Stück an, die Fehlerausgabe fehlte: am Ende steht die ganze gespeicherte Ausgabe da
  f.adapter.apply({ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { command: 'echo a; ls /gibt/es/nicht; exit 3' } });
  f.adapter.apply({ type: 'tool_execution_update', toolCallId: 'b1', output: { append: 'a\n' } });
  f.adapter.apply({
    type: 'tool_execution_end',
    toolCallId: 'b1',
    toolName: 'bash',
    entry: { id: 9, model: [{ role: 'toolResult', content: [{ type: 'text', text: 'a\nls: /gibt/es/nicht: No such file or directory\n' }, { type: 'text', text: klammer('[error] Command exited with code 3') }], isError: true, durationMs: 7 }] },
  });
  // vollständig live angekommen: nichts wird neu gesetzt (derselbe Textknoten bleibt)
  f.adapter.apply({ type: 'tool_execution_start', toolCallId: 'b2', toolName: 'bash', args: { command: 'echo b' } });
  f.adapter.apply({ type: 'tool_execution_update', toolCallId: 'b2', output: { append: 'b\n' } });
  f.view.flush();
  const knoten = f.d.querySelectorAll('.karte[data-art="bash"]')[1].querySelector('.ausgabe-pre .kopfzeilen').firstChild;
  f.adapter.apply({ type: 'tool_execution_end', toolCallId: 'b2', toolName: 'bash', entry: { id: 10, model: [{ role: 'toolResult', content: [{ type: 'text', text: 'b\n' }], isError: false, durationMs: 11 }] } });
  f.view.flush();
  const [eins, zwei] = f.d.querySelectorAll('.karte[data-art="bash"]');
  assert.equal(eins.querySelector('.ausgabe-pre').textContent.trimEnd(), 'a\nls: /gibt/es/nicht: No such file or directory');
  assert.deepEqual([eins.querySelector('.terminal-fuss').textContent, eins.querySelector('.dauer').textContent], ['Exit 3', '7 ms']);
  assert.equal(zwei.querySelector('.ausgabe-pre').textContent.trimEnd(), 'b');
  assert.equal(zwei.querySelector('.ausgabe-pre .kopfzeilen').firstChild, knoten, 'die Ausgabe wurde nicht neu gebaut');
  assert.equal(zwei.querySelector('.dauer').textContent, '11 ms');
});

dom('Hinweise des Runners stehen unter der Ausgabe; ein abgewiesener Aufruf klappt auf', () => {
  const f = ansicht();
  f.adapter.replay([
    aufruf(1, 'w1', 'write', { path: 'a.txt', content: 'x' }, 1),
    ergebnis(2, 'w1', 'write', [klammer('[error] Tool call blocked: PLAN-MODUS: Datei schreiben: a.txt ändert etwas und läuft jetzt nicht.')], { isError: true }),
    aufruf(3, 'b1', 'bash', { command: 'sudo ls' }, 2),
    ergebnis(4, 'b1', 'bash', ['a\nb', klammer('[warn] Wache: Der Befehl läuft mit erhöhten Rechten (sudo). Das ist nur ein Hinweis, der Aufruf lief.')], { durationMs: 20 }),
  ]);
  f.view.flush();
  const [schreiben, befehl] = f.d.querySelectorAll('.karte');
  assert.equal(schreiben.dataset.zustand, 'fehler');
  assert.equal(schreiben.querySelector('.karte-hinweis.fehler').textContent, 'PLAN-MODUS: Datei schreiben: a.txt ändert etwas und läuft jetzt nicht.');
  assert.equal(schreiben.querySelector('.karte-kopf').getAttribute('aria-expanded'), 'true', 'der Grund ist ohne Klick zu sehen');
  assert.equal(schreiben.querySelector('.diff'), null, 'ein abgewiesenes Schreiben zeigt keinen Diff');
  assert.equal(befehl.querySelector('.karte-hinweis.warn').textContent, 'Wache: Der Befehl läuft mit erhöhten Rechten (sudo). Das ist nur ein Hinweis, der Aufruf lief.');
  assert.equal(befehl.querySelector('.ausgabe-pre').textContent, 'a\nb');
  assert.equal(befehl.querySelector('.terminal-fuss').textContent, 'Exit 0');
});

dom('Gruppe „gelesen“: was abgewiesen oder abgebrochen wurde, zählt nicht als gelesen; die Abweisung klappt die Gruppe auf', () => {
  const f = ansicht();
  const wache = '[error] Tool call blocked: SCHLEIFENWACHE: Derselbe Aufruf (ls) mit denselben Argumenten lief schon 3-mal hintereinander und wird nicht noch einmal ausgeführt.';
  // drei Aufrufe in einer Antwort stehen in einer Gruppe
  const drei = { id: 1, kind: 'pi.message', model: [{ role: 'assistant', content: ['l1', 'l2', 'l3'].map((id) => ({ type: 'toolCall', id, name: 'ls', arguments: { path: '.' } })), stopReason: 'toolUse', timestamp: 1 }] };
  f.adapter.replay([
    drei,
    ergebnis(2, 'l1', 'ls', ['a.txt\nb.txt'], { durationMs: 2 }),
    ergebnis(3, 'l2', 'ls', [klammer(wache)], { isError: true }),
    ergebnis(4, 'l3', 'ls', [klammer('[error] Tool ls was aborted')], { isError: true }),
  ]);
  f.view.flush();
  const gruppe = f.d.querySelector('.gruppe');
  assert.equal(f.d.querySelectorAll('.gruppe').length, 1, 'dieselbe Gruppe');
  assert.equal(gruppe.querySelector('.label').textContent, '1 Datei gelesen · 2 nicht gelungen');
  assert.equal(gruppe.querySelector('.gruppe-kopf').getAttribute('aria-expanded'), 'true', 'der Grund der Abweisung ist ohne Klick zu sehen');
  const karten = gruppe.querySelectorAll('.karte');
  assert.deepEqual([...karten].map((k) => k.dataset.zustand), ['fertig', 'fehler', 'fehler']);
  assert.equal(karten[1].querySelector('.karte-kopf').getAttribute('aria-expanded'), 'true');
  assert.match(karten[1].querySelector('.karte-hinweis.fehler').textContent, /^SCHLEIFENWACHE: Derselbe Aufruf \(ls\)/);
  // nur Misslungenes: die Gruppe behauptet nicht, etwas gelesen zu haben; gelingt alles, bleibt sie zu
  const g = ansicht();
  g.adapter.replay([aufruf(1, 'r1', 'read', { path: 'fehlt.txt' }, 1), ergebnis(2, 'r1', 'read', ['ENOENT: no such file'], { isError: true })]);
  g.view.flush();
  assert.equal(g.d.querySelector('.gruppe .label').textContent, '1 nicht gelungen');
  assert.equal(g.d.querySelector('.gruppe-kopf').getAttribute('aria-expanded'), 'false', 'ein gewöhnlicher Fehler klappt nichts auf');
  const h = ansicht();
  h.adapter.replay([aufruf(1, 'r1', 'read', { path: 'a.txt' }, 1), ergebnis(2, 'r1', 'read', ['Inhalt']), aufruf(3, 's1', 'grep', { pattern: 'x' }, 2), ergebnis(4, 's1', 'grep', ['a.txt:1:x'])]);
  h.view.flush();
  assert.deepEqual([...h.d.querySelectorAll('.gruppe .label')].map((n) => n.textContent).join(' | ').includes('nicht gelungen'), false);
});

dom('edit: der Diff zeigt die echten Zeilennummern aus dem Patch des Runners; ohne Patch bleibt der Diff aus der Eingabe', () => {
  const f = ansicht();
  const args = { path: 'src/a.js', edits: [{ oldText: 'const summe = a - b;', newText: 'const summe = a + b;\nconst mal = a * b;' }] };
  f.adapter.replay([
    aufruf(1, 'e1', 'edit', args, 1),
    ergebnis(2, 'e1', 'edit', ['Successfully replaced 1 block(s) in src/a.js.'], { details: { diff: 'egal', patch: PATCH, firstChangedLine: 13 }, durationMs: 4 }),
    aufruf(3, 'e2', 'edit', args, 2),
    ergebnis(4, 'e2', 'edit', ['Successfully replaced 1 block(s) in src/a.js.'], {}),
  ]);
  f.view.flush();
  const [mit, ohne] = f.d.querySelectorAll('.karte[data-art="edit"]');
  const zeilen = (k) => [...k.querySelectorAll('.diff-tabelle tr')].map((tr) => (tr.classList.contains('trenn') ? `~${tr.textContent}` : [...tr.querySelectorAll('td.nr')].map((td) => td.textContent).join('|') + tr.querySelector('td.vz').textContent));
  assert.deepEqual(zeilen(mit), ['10|10', '11|11', '12|12', '13|−', '|13+', '|14+', '14|15', '15|16', '16|17', '~23 unveränderte Zeilen', '40|41', '41|−', '42|42']);
  assert.equal(mit.querySelector('.diffzahl').textContent, '+2 −2');
  assert.equal(mit.querySelector('.diff .datei').textContent, 'src/a.js');
  // ohne Patch (älterer Runner): Zeilen ohne Nummern, wie bisher
  assert.deepEqual(zeilen(ohne), ['|−', '|+', '|+']);
});

dom('Wartezeile: nach dem Start eines Zugs wartet der Agent sichtbar auf das Modell, bis Inhalt kommt; ein neuer Versuch zählt von vorn', () => {
  // eigene Uhr und eigener Takt, damit die Zeit im Test läuft
  let jetzt = 1_000_000;
  const takte = [];
  const d = new jsdom.JSDOM('<!doctype html><body><div id="verlauf"><div id="spalte"></div></div><button id="ende" hidden></button><div id="ansage"></div></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = d.window;
  for (const s of ['markdown-strom.js', 'terminal.js', 'chat-renderer.js', 'runner-adapter.js']) w.eval(lies(s));
  const FP = w.FyosPrototyp;
  const view = FP.createChatView(w.document.getElementById('spalte'), {
    scroller: w.document.getElementById('verlauf'),
    zumEnde: w.document.getElementById('ende'),
    ansage: w.document.getElementById('ansage'),
    raf: (f) => setTimeout(() => f(Date.now()), 0),
    caf: () => {},
    now: () => jetzt,
    setInterval: (f) => takte.push(f),
    clearInterval: (id) => {
      takte[id - 1] = () => {};
    },
    reduceMotion: () => true,
  });
  const adapter = FP.createRunnerAdapter(view, {});
  const dok = w.document;
  const zeile = () => dok.querySelector('.wartezeile');
  const tick = (ms) => {
    jetzt += ms;
    for (const f of takte) f();
  };

  adapter.apply({ type: 'run_start' });
  adapter.apply({ type: 'turn_start' });
  view.flush();
  assert.ok(zeile(), 'die Zeile steht im Zug');
  assert.equal(zeile().hidden, true, 'in der ersten Sekunde bleibt sie unsichtbar');
  tick(1000);
  assert.deepEqual([zeile().hidden, zeile().querySelector('.wz-text').textContent, zeile().querySelector('.wz-zeit').textContent], [false, 'Wartet auf das Modell', '1 s']);
  tick(41000);
  assert.equal(zeile().querySelector('.wz-zeit').textContent, '42 s');
  // neuer Versuch: Hinweis im Verlauf, die Zeile zählt von vorn und nennt den Versuch
  adapter.apply({ type: 'auto_retry_start', attempt: 2 });
  view.flush();
  assert.equal(dok.querySelectorAll('.wartezeile').length, 1);
  assert.equal(zeile().querySelector('.wz-text').textContent, 'Wartet auf das Modell, Versuch 2');
  assert.equal(zeile().hidden, true);
  tick(3000);
  assert.equal(zeile().querySelector('.wz-zeit').textContent, '3 s');
  // die Antwort beginnt: die Zeile ist weg
  adapter.apply({ type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: 'Hallo' }] } });
  view.flush();
  assert.equal(zeile(), null);

  // nächste Anfrage im selben Lauf; ein Werkzeug in einer bestehenden Gruppe nimmt die Zeile ebenfalls weg
  adapter.apply({ type: 'tool_execution_start', toolCallId: 'r1', toolName: 'read', args: { path: 'a.txt' } });
  adapter.apply({ type: 'tool_execution_end', toolCallId: 'r1', toolName: 'read', entry: { id: 5, model: [{ role: 'toolResult', content: [{ type: 'text', text: 'a' }], isError: false, durationMs: 3 }] } });
  adapter.apply({ type: 'turn_start' });
  view.flush();
  assert.ok(zeile());
  adapter.apply({ type: 'tool_execution_start', toolCallId: 'r2', toolName: 'read', args: { path: 'b.txt' } });
  view.flush();
  assert.equal(zeile(), null, 'ein laufendes Werkzeug ist kein Warten auf das Modell');
  adapter.apply({ type: 'tool_execution_end', toolCallId: 'r2', toolName: 'read', entry: { id: 6, model: [{ role: 'toolResult', content: [{ type: 'text', text: 'b' }], isError: false, durationMs: 2 }] } });
  adapter.apply({ type: 'turn_start' });
  view.flush();
  assert.ok(zeile());
  // Ende des Laufs: weg
  adapter.apply({ type: 'run_end' });
  view.flush();
  assert.equal(zeile(), null);

  // beim Abspielen eines Verlaufs gibt es keine Wartezeile; nach dem Neuverbinden nur, wenn eine Anfrage unterwegs ist
  adapter.replay([aufruf(10, 'b9', 'bash', { command: 'ls' }, 1), ergebnis(11, 'b9', 'bash', ['x'], { durationMs: 5 })]);
  view.flush();
  assert.equal(zeile(), null);
  adapter.snapshot({ entries: [], run: { id: 'r' } });
  view.flush();
  assert.equal(zeile(), null, 'ein offener Lauf ohne Anfrage (ein Aufruf wartet auf den Menschen) zeigt keine Wartezeile');
  adapter.snapshot({ entries: [], run: { id: 'r' }, generation: { attempt: 1 } });
  view.flush();
  assert.equal(zeile().querySelector('.wz-text').textContent, 'Wartet auf das Modell');
});

test('Quelltext: der Adapter reicht Details und gemessene Dauer durch; die Ansicht setzt Meldungen nur als Text ein', () => {
  const adapter = lies('runner-adapter.js');
  assert.match(adapter, /\{ details: m\.details, durationMs: m\.durationMs \}/);
  assert.ok(!/ohneKlammer/.test(adapter), 'die frühere Sonderbehandlung ist in ausgabeTeile aufgegangen');
  const karte = lies('chat-renderer.js');
  assert.match(karte, /el\('div', r\.exit === 0 \? 'terminal-fuss' : 'terminal-fuss fehler', `Exit \$\{r\.exit\}`\)/);
  assert.match(karte, /box\.appendChild\(el\('div', `karte-hinweis /);
  const css = lies('chat.css');
  for (const k of ['.terminal-fuss', '.meta .exit', '.karte-hinweis.warn', '.karte-hinweis.fehler']) assert.ok(css.includes(`${k} {`), k);
});

test('Blockanfang: Text, der schon im Start des Blocks steht, wird als Stück nachgereicht; was noch als Stück folgt, zählt nicht doppelt', () => {
  const { mitBlockanfang } = logik('runner-adapter.js');
  const kurz = (l) => JSON.parse(JSON.stringify(l.map((c) => [c.type, c.delta || ''])));
  // der Anfang steht nur im Block
  assert.deepEqual(kurz(mitBlockanfang([{ type: 'text_start', contentIndex: 0, block: { type: 'text', text: 'Num' } }, { type: 'text_delta', contentIndex: 0, delta: 'mer 21' }])), [['text_start', ''], ['text_delta', 'Num'], ['text_delta', 'mer 21']]);
  // der Block trägt schon, was im selben Stapel noch folgt
  assert.deepEqual(kurz(mitBlockanfang([{ type: 'text_start', contentIndex: 0, block: { type: 'text', text: 'Nummer' } }, { type: 'text_delta', contentIndex: 0, delta: 'mer' }])), [['text_start', ''], ['text_delta', 'Num'], ['text_delta', 'mer']]);
  // Denken ebenso, je Block für sich; ein leerer Blockanfang ändert nichts
  assert.deepEqual(kurz(mitBlockanfang([{ type: 'thinking_start', contentIndex: 0, block: { thinking: 'Ich ' } }, { type: 'text_start', contentIndex: 1, block: { text: '' } }, { type: 'text_delta', contentIndex: 1, delta: 'ok' }])), [['thinking_start', ''], ['thinking_delta', 'Ich '], ['text_start', ''], ['text_delta', 'ok']]);
  // reicht der Runner das Stück schon selbst nach, bleibt die Liste
  const schon = [{ type: 'text_start', contentIndex: 0, block: { text: 'Num' } }, { type: 'text_delta', contentIndex: 0, delta: 'Num', ausBlockanfang: true }];
  assert.equal(mitBlockanfang(schon).length, 2);
  assert.deepEqual(mitBlockanfang(null), []);
});

dom('Blockanfang im Gespräch: der Anfang der Antwort fehlt nicht, und der Abgleich mit der ganzen Nachricht hängt das Ende nicht doppelt an', () => {
  const { d, view, adapter } = ansicht();
  const ganz = 'Nummer 21 fertig. Weiter mit FLE-NACHTPLAN.md.';
  adapter.apply({ type: 'run_start' });
  adapter.apply({ type: 'message_start', message: { role: 'assistant', content: [] } });
  adapter.apply({ type: 'message_update', changes: [{ type: 'text_start', contentIndex: 0, block: { type: 'text', text: 'Num' } }, { type: 'text_delta', contentIndex: 0, delta: 'mer 21 fertig. Weiter mit FLE-NACHTPLAN' }] });
  adapter.apply({ type: 'message_update', changes: [{ type: 'text_delta', contentIndex: 0, delta: '.md.' }] });
  adapter.apply({ type: 'message_update', changes: [{ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: ganz }] } }] });
  view.flush();
  assert.equal(d.getElementById('spalte').textContent.includes(ganz), true, d.getElementById('spalte').textContent);
  assert.equal(d.getElementById('spalte').textContent.split('.md.').length, 2, 'das Ende steht einmal da');
});
