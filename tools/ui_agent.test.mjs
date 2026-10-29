// Tests für den Arbeitsplatz der Agent-Oberfläche (ui/agent): Terminal-Ansicht (ANSI), Sitzungsliste, Seitenleiste, Diff.
// Aufruf:  node --test tools/ui_agent.test.mjs   (aus apps/fyos-shell)
// jsdom liegt nicht in dieser Hülle: gefunden wird es über FYOS_JSDOM_DIR (Ordner mit node_modules/jsdom) oder ein benachbartes fyos-web.
// Fehlt es, laufen nur die DOM-freien Prüfungen.
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
  const kandidaten = [process.env.FYOS_JSDOM_DIR, path.join(HIER, '..', '..', '..', '..', 'fyos-web')].filter(Boolean);
  for (const k of kandidaten) {
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

function fenster(skripte, html) {
  const d = new jsdom.JSDOM(html || '<!doctype html><body><div id="verlauf"><div id="spalte"></div></div><button id="ende" hidden></button><div id="ansage"></div></body>', { runScripts: 'outside-only' });
  for (const s of skripte) d.window.eval(lies(s));
  return d.window;
}

// --- Terminal (ohne DOM) ---
function terminal() {
  const w = { FyosPrototyp: {} };
  new Function('window', 'globalThis', lies('terminal.js'))(w, w);
  return w.FyosPrototyp;
}

test('ANSI: Farben werden zu Klassen, andere Steuerfolgen verschwinden', () => {
  const FP = terminal();
  const l = FP.ansiLeser();
  const aus = l.schreibe('\u001b[1mfett\u001b[0m normal \u001b[32mgrün\u001b[39m \u001b[91mhellrot\u001b[0m\u001b[2K\u001b[?25h');
  assert.deepEqual(aus.map((x) => x.text), ['fett', ' normal ', 'grün', ' ', 'hellrot']);
  assert.equal(aus[0].klasse, 'an-fett');
  assert.equal(aus[1].klasse, '');
  assert.equal(aus[2].klasse, 'an-gruen');
  assert.equal(aus[3].klasse, '');
  assert.equal(aus[4].klasse, 'an-hell-rot');
});

test('ANSI: eine mitten im Stück geteilte Folge wird festgehalten', () => {
  const l = terminal().ansiLeser();
  const a = l.schreibe('vor \u001b[3');
  const b = l.schreibe('1mrot\u001b[0m');
  assert.deepEqual(a.map((x) => x.text), ['vor ']);
  assert.deepEqual(b.map((x) => [x.text, x.klasse]), [['rot', 'an-rot']]);
});

test('ANSI: 256 Farben, RGB und Hintergrund werden auf Grundfarben abgebildet', () => {
  const l = terminal().ansiLeser();
  const aus = l.schreibe('\u001b[38;5;2mA\u001b[38;2;255;0;0mB\u001b[42mC');
  assert.equal(aus[0].klasse, 'an-gruen');
  assert.match(aus[1].klasse, /an-(hell-)?rot/);
  assert.match(aus[2].klasse, /an-bg-gruen/);
});

test('ANSI: Entfernen und Wagenrücklauf (nur der letzte Stand der Zeile bleibt)', () => {
  const FP = terminal();
  assert.equal(FP.ansiEntfernen('\u001b[31mrot\u001b[0m\u001b]0;Titel\u0007 ok'), 'rot ok');
  assert.equal(FP.ansiEntfernen('10%\r50%\r100%\nfertig\r\n'), '100%\nfertig\n');
});

// --- Sitzungsliste (ohne DOM) ---
function sitzungen() {
  const w = { FyosPrototyp: {} };
  new Function('window', 'globalThis', lies('sitzungen.js'))(w, w);
  return w.FyosPrototyp.sitzungen;
}

test('Sitzungsliste: neueste oben, laufende markiert, Läufe getrennt, Sprache versteckt, Ordner aus dem Arbeitsbereich', () => {
  const S = sitzungen();
  const jetzt = 10_000_000;
  const akt = S.createAktivitaet(() => jetzt);
  const gespraeche = [
    { id: 1, art: 'root', titel: 'Haupt', erstellt: jetzt - 5_000_000, arbeitsbereich: 'a' },
    { id: 2, art: 'mensch', titel: 'Zwei', erstellt: jetzt - 1_000_000, arbeitsbereich: 'b' },
    { id: 3, art: 'lauf', titel: 'Lauf 1', erstellt: jetzt - 100, arbeitsbereich: 'a' },
    { id: 4, art: 'sprache', titel: 'Sprache', erstellt: jetzt },
    { id: 5, art: 'mensch', titel: '', erstellt: jetzt - 9_000_000 },
  ];
  akt.zeile({ gespraech: 1, t: jetzt - 1000, typ: 'werkzeug' });
  const l = S.sitzungsListe(gespraeche, { a: { titel: 'Alpha', pfad: '/x/alpha' }, b: { titel: 'Beta', pfad: '/x/beta/' } }, akt, { jetzt });
  assert.deepEqual(l.sitzungen.map((z) => z.id), [1, 2, 5]);
  assert.deepEqual(l.weitere.map((z) => z.id), [3]);
  assert.equal(l.sitzungen[0].laeuft, true);
  assert.equal(l.sitzungen[1].laeuft, false);
  assert.equal(l.sitzungen[0].ordner, 'alpha');
  assert.equal(l.sitzungen[1].ordner, 'beta');
  assert.equal(l.sitzungen[2].titel, 'Ohne Titel');
  assert.equal(l.sitzungen[0].zeitText, 'gerade eben');
  akt.zeile({ gespraech: 1, t: jetzt, typ: 'fertig' });
  assert.equal(S.sitzungsListe(gespraeche, {}, akt, { jetzt }).sitzungen.find((z) => z.id === 1).laeuft, false);
});

test('Sitzungsliste: ein Lauf ohne Meldung gilt nach der Frist nicht mehr als laufend; Freigabe-Zeilen ändern den Zustand nicht', () => {
  const S = sitzungen();
  let jetzt = 1_000_000;
  const akt = S.createAktivitaet(() => jetzt);
  akt.zeile({ gespraech: 7, t: jetzt, typ: 'eingang' });
  akt.zeile({ gespraech: 7, t: jetzt, typ: 'freigabe' });
  assert.equal(akt.laeuft(7), true);
  jetzt += S.LAUF_FRIST_MS + 1;
  assert.equal(akt.laeuft(7), false);
});

test('Nachbar-Sitzung rundum, Ordneranzeige', () => {
  const S = sitzungen();
  assert.equal(S.nachbar([1, 2, 3], 3, 1), 1);
  assert.equal(S.nachbar([1, 2, 3], 1, -1), 3);
  assert.equal(S.nachbar([], 1, 1), null);
  assert.deepEqual(S.ordnerAnzeige('/a/b/c/', null), { name: 'c', pfad: '/a/b/c/' });
  assert.equal(S.ordnerAnzeige('', { titel: 'T', pfad: '' }).name, 'T');
});

// --- Seitenleiste ---
dom('Seitenleiste: Zeilen bleiben beim Aktualisieren dieselben Elemente, auch beim Umsortieren', () => {
  const w = fenster(['sitzungen.js', 'leiste.js'], '<!doctype html><body><div id="l"></div><button id="k" hidden></button><span id="z"></span><div id="w"></div><p id="e"></p></body>');
  const d = w.document;
  const gewaehlt = [];
  const le = w.FyosPrototyp.createLeiste({ liste: d.getElementById('l'), weitere: d.getElementById('w'), weitereKopf: d.getElementById('k'), weitereZahl: d.getElementById('z'), leer: d.getElementById('e') }, { beiWahl: (id) => gewaehlt.push(id) });
  const z = (id, titel, extra) => ({ id, titel, art: 'mensch', zeitText: 'gerade eben', ordner: 'o', pfad: '/o', laeuft: false, ...extra });
  le.zeichne({ sitzungen: [z(1, 'Eins'), z(2, 'Zwei')], weitere: [] }, 1);
  const eins = d.querySelector('[data-id="1"]');
  const zwei = d.querySelector('[data-id="2"]');
  assert.equal(eins.getAttribute('aria-selected'), 'true');
  assert.equal(eins.tabIndex, 0);
  assert.equal(zwei.tabIndex, -1);
  le.zeichne({ sitzungen: [z(2, 'Zwei', { laeuft: true }), z(1, 'Eins neu'), z(3, 'Drei')], weitere: [z(9, 'Lauf', { art: 'lauf' })] }, 2);
  assert.equal(d.querySelector('[data-id="1"]'), eins, 'Element bleibt');
  assert.equal(d.querySelector('[data-id="2"]'), zwei);
  assert.deepEqual([...d.querySelectorAll('#l .sitzung')].map((b) => b.dataset.id), ['2', '1', '3']);
  assert.equal(eins.querySelector('.sitzung-titel').textContent, 'Eins neu');
  assert.equal(zwei.dataset.laeuft, '1');
  assert.match(zwei.querySelector('.sr').textContent, /arbeitet/);
  assert.equal(d.getElementById('w').children.length, 1);
  assert.equal(d.getElementById('k').hidden, false);
  eins.click();
  assert.deepEqual(gewaehlt, [1]);
  le.zeichne({ sitzungen: [z(2, 'Zwei')], weitere: [] }, 2);
  assert.equal(d.querySelector('[data-id="1"]'), null);
  assert.equal(d.getElementById('k').hidden, true);
});

dom('Seitenleiste: Pfeiltasten bewegen den Fokus, Titel wird nur als Text eingesetzt', () => {
  const w = fenster(['sitzungen.js', 'leiste.js'], '<!doctype html><body><div id="l"></div><button id="k" hidden></button><span id="z"></span><div id="w"></div><p id="e"></p></body>');
  const d = w.document;
  const le = w.FyosPrototyp.createLeiste({ liste: d.getElementById('l'), weitere: d.getElementById('w'), weitereKopf: d.getElementById('k'), weitereZahl: d.getElementById('z'), leer: d.getElementById('e') }, {});
  const z = (id, titel) => ({ id, titel, art: 'mensch', zeitText: '', ordner: '', pfad: '', laeuft: false });
  le.zeichne({ sitzungen: [z(1, '<img src=x onerror=alert(1)>'), z(2, 'B'), z(3, 'C')], weitere: [] }, 1);
  assert.equal(d.querySelector('img'), null);
  const [a, b, c] = d.querySelectorAll('.sitzung');
  a.focus();
  const taste = (key) => d.activeElement.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  taste('ArrowDown');
  assert.equal(d.activeElement, b);
  taste('End');
  assert.equal(d.activeElement, c);
  taste('ArrowUp');
  assert.equal(d.activeElement, b);
  taste('Home');
  assert.equal(d.activeElement, a);
});

// --- Karten im Chat: Terminal und Diff ---
function ansicht() {
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
  return { w, FP, view, adapter: FP.createRunnerAdapter(view, {}) };
}

dom('Bash-Karte: Terminal-Ansicht mit Farben, geteilter Folge und Fortschrittszeile; keine rohen Steuerzeichen', () => {
  const { w, view, adapter } = ansicht();
  adapter.apply({ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { command: 'make' } });
  adapter.apply({ type: 'tool_execution_update', toolCallId: 'b1', output: { append: '\u001b[32mok\u001b[0m und \u001b[3' } });
  adapter.apply({ type: 'tool_execution_update', toolCallId: 'b1', output: { append: '1mfehler\u001b[0m\n10%\r100%\n' } });
  adapter.apply({ type: 'tool_execution_end', toolCallId: 'b1', toolName: 'bash', entry: { id: 9, model: [{ role: 'toolResult', content: [{ type: 'text', text: 'ok und fehler' }], isError: false }] } });
  view.flush();
  const d = w.document;
  const term = d.querySelector('.karte[data-art="bash"] .terminal');
  assert.ok(term, 'Terminal-Ansicht');
  assert.equal(term.querySelector('.terminal-befehl').textContent, '$ make');
  assert.equal(term.querySelector('.an-gruen').textContent, 'ok');
  assert.equal(term.querySelector('.an-rot').textContent, 'fehler');
  const roh = term.querySelector('.ausgabe-pre').textContent;
  assert.ok(!roh.includes('\u001b') && !roh.includes('[32m'));
  assert.ok(roh.includes('100%') && !roh.includes('10%\n'));
  assert.equal(d.querySelector('.karte').dataset.zustand, 'fertig');
});

dom('Bash-Karte: Ausgabe nur im Ergebnis (ohne Zwischenstände) wird ebenfalls farbig dargestellt', () => {
  const { w, view, adapter } = ansicht();
  adapter.apply({ type: 'tool_execution_start', toolCallId: 'b2', toolName: 'bash', args: { command: 'ls' } });
  adapter.apply({ type: 'tool_execution_end', toolCallId: 'b2', toolName: 'bash', entry: { id: 10, model: [{ role: 'toolResult', content: [{ type: 'text', text: '\u001b[34mordner\u001b[0m\ndatei' }], isError: false }] } });
  view.flush();
  const term = w.document.querySelector('.terminal');
  assert.equal(term.querySelector('.an-blau').textContent, 'ordner');
  assert.ok(term.textContent.includes('datei'));
});

dom('Edit-Karte: Diff aus der Werkzeugeingabe mit Dateiname, Zählern und getrennten Änderungen', () => {
  const { w, view, adapter } = ansicht();
  const args = { path: 'src/a.txt', edits: [{ oldText: 'alt\ngleich', newText: 'neu\ngleich\nextra' }, { oldText: 'x', newText: 'y' }] };
  adapter.apply({ type: 'tool_execution_start', toolCallId: 'e1', toolName: 'edit', args });
  adapter.apply({ type: 'tool_execution_end', toolCallId: 'e1', toolName: 'edit', entry: { id: 11, model: [{ role: 'toolResult', content: [{ type: 'text', text: 'ok' }], isError: false }] } });
  view.flush();
  const diff = w.document.querySelector('.diff');
  assert.ok(diff);
  assert.equal(diff.querySelector('.datei').textContent, 'src/a.txt');
  assert.equal(diff.querySelectorAll('tr.add').length, 3); // neu, extra, y
  assert.equal(diff.querySelectorAll('tr.del').length, 2); // alt, x
  assert.equal(diff.querySelectorAll('tr.trenn').length, 1);
  assert.match(diff.querySelector('.diffzahl').textContent, /\+3\s+−2/);
  assert.match(w.document.querySelector('.karte-kopf .diffzahl').textContent, /\+3/);
});

dom('Write-Karte: nur hinzugefügte Zeilen; fehlgeschlagene Edit-Aufrufe zeigen keinen Diff', () => {
  const { w, view, adapter } = ansicht();
  adapter.apply({ type: 'tool_execution_start', toolCallId: 'w1', toolName: 'write', args: { path: 'n.txt', content: 'a\nb\n' } });
  adapter.apply({ type: 'tool_execution_end', toolCallId: 'w1', toolName: 'write', entry: { id: 12, model: [{ role: 'toolResult', content: [{ type: 'text', text: 'ok' }], isError: false }] } });
  adapter.apply({ type: 'tool_execution_start', toolCallId: 'e2', toolName: 'edit', args: { path: 'f', oldText: 'a', newText: 'b' } });
  adapter.apply({ type: 'tool_execution_end', toolCallId: 'e2', toolName: 'edit', entry: { id: 13, model: [{ role: 'toolResult', content: [{ type: 'text', text: 'nicht gefunden' }], isError: true }] } });
  view.flush();
  const diffs = w.document.querySelectorAll('.diff');
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].querySelectorAll('tr.add').length, 2);
  assert.equal(w.document.querySelectorAll('.karte')[1].dataset.zustand, 'fehler');
});

// --- Ordner je Sitzung und Ordnerwahl ---
test('Sitzungsliste: der gewählte Ordner (agent.cwd) geht vor dem Arbeitsbereich', () => {
  const S = sitzungen();
  const l = S.sitzungsListe(
    [{ id: 1, titel: 'A', art: 'mensch', erstellt: 5, arbeitsbereich: 'standard', agent: { cwd: '/probe/gewaehlt/projekt-x' } }, { id: 2, titel: 'B', art: 'mensch', erstellt: 4, arbeitsbereich: 'standard' }],
    { standard: { titel: 'Standard', pfad: '/probe/standard' } },
    S.createAktivitaet(),
    {}
  );
  assert.equal(l.sitzungen[0].ordner, 'projekt-x');
  assert.equal(l.sitzungen[0].pfad, '/probe/gewaehlt/projekt-x');
  assert.equal(l.sitzungen[1].ordner, 'standard');
});

const ORDNER_HTML = '<!doctype html><body><fieldset id="k" hidden><p id="g"></p><div id="z" hidden></div><button id="d" hidden></button><ul id="b"></ul><p id="f" hidden></p></fieldset></body>';

function ordnerWahl(w, transport, extra) {
  const d = w.document;
  const gemeldet = [];
  const wahl = w.FyosPrototyp.createOrdnerWahl(
    { kasten: d.getElementById('k'), gewaehlt: d.getElementById('g'), zuletzt: d.getElementById('z'), dialog: d.getElementById('d'), baum: d.getElementById('b'), fehler: d.getElementById('f') },
    { transport, beiAenderung: (p) => gemeldet.push(p), ...extra }
  );
  return { wahl, gemeldet, d };
}

const warte = (ms = 5) => new Promise((r) => setTimeout(r, ms));

dom('Ordnerwahl entfernt: Wurzeln, Aufklappen, Wählen, Pfad mit dem Trenner des Runners', async () => {
  const w = fenster(['ordner.js'], ORDNER_HTML);
  const aufrufe = [];
  const transport = {
    api: async (m, p) => {
      aufrufe.push(p);
      if (p === '/api/ordner') return { wurzeln: ['/probe/w1', '/probe/w2'], eintraege: [], erlaubt: false };
      if (p === '/api/ordner?pfad=' + encodeURIComponent('/probe/w1')) return { pfad: '/probe/w1', eintraege: [{ name: 'a', ordner: true }, { name: 'b', ordner: true }], erlaubt: true, abgeschnitten: true };
      throw new Error('unerwartet ' + p);
    },
  };
  const { wahl, gemeldet, d } = ordnerWahl(w, transport);
  assert.equal(await wahl.starte('entfernt'), true);
  assert.equal(d.getElementById('k').hidden, false);
  assert.equal(d.getElementById('d').hidden, true, 'kein Systemdialog bei entfernten Runnern');
  const wurzeln = [...d.querySelectorAll('#b > li > .baum-zeile .baum-name')].map((b) => b.textContent);
  assert.deepEqual(wurzeln, ['/probe/w1', '/probe/w2']);
  d.querySelector('#b > li .baum-auf').click();
  await warte();
  const kinder = [...d.querySelectorAll('#b > li:first-child ul .baum-name')].map((b) => b.dataset.pfad);
  assert.deepEqual(kinder, ['/probe/w1/a', '/probe/w1/b']);
  assert.match(d.querySelector('#b > li:first-child ul .baum-leer').textContent, /gekürzt/);
  assert.equal(d.querySelector('#b > li').getAttribute('aria-expanded'), 'true');
  d.querySelector('#b > li:first-child ul .baum-name').click();
  assert.equal(wahl.wert(), '/probe/w1/a');
  assert.equal(d.querySelector('.baum-name[data-pfad="/probe/w1/a"]').getAttribute('aria-selected'), 'true');
  assert.match(d.getElementById('g').textContent, /\/probe\/w1\/a/);
  assert.equal(gemeldet.at(-1), '/probe/w1/a');
  // zuklappen lädt nicht neu
  d.querySelector('#b > li .baum-auf').click();
  assert.equal(d.querySelector('#b > li').getAttribute('aria-expanded'), 'false');
  assert.equal(aufrufe.filter((p) => p.includes('w1')).length, 1);
  assert.equal(w.FyosPrototyp.ordnerUnter('C:\\Probe', 'x'), 'C:\\Probe\\x');
  assert.equal(w.FyosPrototyp.ordnerUnter('/', 'x'), '/x');
});

dom('Ordnerwahl entfernt: 403 und 404 erscheinen als klare Meldung, Namen nur als Text', async () => {
  const w = fenster(['ordner.js'], ORDNER_HTML);
  const transport = {
    api: async (m, p) => {
      if (p === '/api/ordner') return { wurzeln: ['/probe/w'] };
      throw Object.assign(new Error('Dieser Ordner liegt außerhalb der Ordner, die der Runner freigibt. Einen Ordner unterhalb wählen.'), { code: 'ORDNER_AUSSERHALB' });
    },
  };
  const { wahl, d } = ordnerWahl(w, transport);
  await wahl.starte('entfernt');
  d.querySelector('.baum-auf').click();
  await warte();
  assert.equal(d.getElementById('f').hidden, false);
  assert.match(d.getElementById('f').textContent, /außerhalb/);
  assert.equal(d.querySelector('#b > li').getAttribute('aria-expanded'), 'false', 'nach dem Fehler bleibt der Knoten zu');
  assert.equal(wahl.wert(), '');
});

dom('Ordnerwahl: ein Runner ohne Ordnerliste lässt die Arbeitsbereiche gelten', async () => {
  const w = fenster(['ordner.js'], ORDNER_HTML);
  const transport = { api: async () => { throw new Error('HTTP 404'); } };
  const { wahl, d } = ordnerWahl(w, transport);
  assert.equal(await wahl.starte('entfernt'), false);
  assert.equal(d.getElementById('k').hidden, true);
});

dom('Ordnerwahl lokal: Systemdialog, Abbruch ändert nichts, zuletzt benutzte Ordner', async () => {
  const w = fenster(['ordner.js'], ORDNER_HTML);
  let antwort = { pfad: '/probe/gewaehlt', name: 'gewaehlt' };
  const { wahl, d } = ordnerWahl(w, { api: async () => { throw new Error('nicht für lokal'); } }, {
    waehleLokal: async () => antwort,
    zuletztLaden: async () => [{ pfad: '/probe/a', name: 'a' }, { pfad: '/probe/b', name: 'b' }],
  });
  assert.equal(await wahl.starte('lokal'), true);
  assert.equal(d.getElementById('d').hidden, false);
  assert.equal(d.getElementById('b').hidden, true);
  assert.deepEqual([...d.querySelectorAll('.zuletzt-knopf')].map((b) => b.title), ['/probe/a', '/probe/b']);
  d.getElementById('d').click();
  await warte();
  assert.equal(wahl.wert(), '/probe/gewaehlt');
  antwort = null; // Nutzer bricht ab
  d.getElementById('d').click();
  await warte();
  assert.equal(wahl.wert(), '/probe/gewaehlt');
  d.querySelectorAll('.zuletzt-knopf')[1].click();
  assert.equal(wahl.wert(), '/probe/b');
  // Fehler des Dialogs werden angezeigt
  const f = ordnerWahl(fenster(['ordner.js'], ORDNER_HTML), {}, { waehleLokal: async () => { throw new Error('Der lokale Runner läuft nicht.'); } });
  await f.wahl.starte('lokal');
  f.d.getElementById('d').click();
  await warte();
  assert.match(f.d.getElementById('f').textContent, /läuft nicht/);
});

test('Brücke: die Seite öffnet weder fremde Wege noch den reservierten Weg zum Erlauben von Ordnern (Quelltext-Prüfung der Seite)', () => {
  const quelle = lies('chat.js') + lies('ordner.js') + lies('echt.js');
  assert.ok(!quelle.includes('ordner/erlauben'), 'nur Rust meldet dem lokalen Runner einen gewählten Ordner');
  assert.ok(!/plugin:dialog|plugin-dialog|__TAURI_PLUGIN/.test(quelle), 'die Seite hat keinen Zugriff auf das Dialog-Plugin');
});

test('Gesundheitsprobe: ein Fehler bleibt als Hinweis stehen und die Probe wiederholt sich, ohne die Seite neu zu laden (Quelltext-Prüfung)', () => {
  const quelle = lies('chat.js');
  const probe = quelle.slice(quelle.indexOf('function gesundheitPruefen'), quelle.indexOf('gesundheitPruefen();'));
  assert.ok(probe.includes('setTimeout(gesundheitPruefen, 8000)'), 'die Probe wiederholt sich alle 8 s an Ort und Stelle');
  assert.ok(!/location\.reload/.test(probe), 'kein Neuladen: sonst blitzt der Hinweis nur auf');
  assert.match(probe, /Kein Runner erreichbar/);
});
