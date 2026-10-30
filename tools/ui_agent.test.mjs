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

// --- Sitzungen benennen, umbenennen, archivieren ---
test('Namen prüfen: getrimmt, nicht leer, höchstens 120 Zeichen; der Körper trägt nur titel und archiviert', () => {
  const S = sitzungen();
  assert.deepEqual(S.titelPruefen('  Mein Projekt  '), { ok: true, titel: 'Mein Projekt' });
  assert.equal(S.titelPruefen('   ').ok, false);
  assert.equal(S.titelPruefen(null).ok, false);
  assert.equal(S.titelPruefen('x'.repeat(120)).ok, true);
  assert.match(S.titelPruefen('x'.repeat(121)).fehler, /120/);
  assert.deepEqual(S.aenderungsKoerper({ titel: 'A', archiviert: true, modell: 'm', arbeitsbereich: 'b', ordner: '/x', id: 5 }), { titel: 'A', archiviert: true });
  assert.deepEqual(S.aenderungsKoerper({ titel: 5, archiviert: 'ja' }), {});
  assert.deepEqual(S.aenderungsKoerper(null), {});
  assert.equal(S.titelAusAntwort({ ok: true, gespraech: { id: 3, meta: { titel: ' Neu ' } } }), 'Neu');
  assert.equal(S.titelAusAntwort({ gespraech: { titel: 'Alt' } }), 'Alt');
  assert.equal(S.titelAusAntwort({}), null);
});

test('Änderung über die Brücke: PATCH nur auf /api/gespraech/<id> mit titel oder archiviert; Fehler des Runners kommen mit Text', async () => {
  const S = sitzungen();
  const aufrufe = [];
  let fehler = null;
  const a = S.createAenderung({
    api: async (m, p, k) => {
      aufrufe.push([m, p, k]);
      if (fehler) throw fehler;
      return { ok: true, gespraech: { id: 7, meta: { titel: 'Gespeichert' } } };
    },
  });
  assert.deepEqual(await a.umbenennen(7, '  Neu  '), { titel: 'Gespeichert' });
  assert.deepEqual(aufrufe[0], ['PATCH', '/api/gespraech/7', { titel: 'Neu' }]);
  await assert.rejects(a.umbenennen(7, '   '), /leer/);
  assert.equal(aufrufe.length, 1, 'ein leerer Name geht gar nicht erst zum Runner');
  assert.deepEqual(await a.archivieren('a/b', true), { archiviert: true });
  assert.deepEqual(aufrufe[1], ['PATCH', '/api/gespraech/a%2Fb', { archiviert: true }], 'Id wird als Pfadteil kodiert');
  await a.archivieren(7, false);
  assert.deepEqual(aufrufe[2], ['PATCH', '/api/gespraech/7', { archiviert: false }]);
  fehler = Object.assign(new Error('Der Runner antwortet mit einem Fehler (Status 500). Die Aktion noch einmal versuchen.'), { meldung: { details: 'HTTP 500: Gespräch nicht gefunden' } });
  await assert.rejects(a.umbenennen(7, 'X'), /Nicht umbenannt:.*Gespräch nicht gefunden/);
  await assert.rejects(a.archivieren(7, true), /Nicht archiviert:/);
});

test('Sitzungsliste: archivierte stehen im Archiv, auch die, die dieses Fenster selbst archiviert hat', () => {
  const S = sitzungen();
  const l = S.sitzungsListe(
    [
      { id: 1, art: 'root', titel: 'Haupt', erstellt: 9 },
      { id: 2, art: 'mensch', titel: 'Zwei', erstellt: 8, archiviert: true },
      { id: 3, art: 'mensch', titel: 'Drei', erstellt: 7 },
      { id: 5, art: 'lauf', titel: 'Lauf', erstellt: 6, archiviert: true },
    ],
    {},
    S.createAktivitaet(),
    { archivLokal: [{ id: 4, art: 'mensch', titel: 'Vier', erstellt: 5 }, { id: 3, art: 'mensch', titel: 'Drei neu', erstellt: 7 }] }
  );
  assert.deepEqual(l.sitzungen.map((z) => z.id), [1]);
  assert.deepEqual(l.archiv.map((z) => z.id).sort(), [2, 3, 4]);
  assert.equal(l.archiv.find((z) => z.id === 3).titel, 'Drei neu', 'die lokale Fassung gewinnt, keine Doppelung');
  assert.ok(l.archiv.every((z) => z.archiviert));
  assert.deepEqual(l.weitere, []);
});

const LEISTE_HTML = '<!doctype html><body><div id="l"></div><button id="k" hidden></button><span id="z"></span><div id="w" hidden></div><p id="e"></p><button id="ak" hidden></button><span id="az"></span><div id="a" hidden></div></body>';
const taste = (w, ziel, key, extra) => ziel.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
const doppelklick = (w, ziel) => ziel.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
const bis = async (fn, frist = 3000) => {
  const ende = Date.now() + frist;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > ende) throw new Error('Zeit abgelaufen: ' + fn);
    await warte(10);
  }
};

function leisteMit(opts) {
  const w = fenster(['sitzungen.js', 'leiste.js'], LEISTE_HTML);
  const d = w.document;
  const g = (id) => d.getElementById(id);
  const le = w.FyosPrototyp.createLeiste({ liste: g('l'), weitere: g('w'), weitereKopf: g('k'), weitereZahl: g('z'), leer: g('e'), archiv: g('a'), archivKopf: g('ak'), archivZahl: g('az') }, opts);
  const z = (id, titel, extra) => ({ id, titel, art: 'mensch', zeitText: '', ordner: '', pfad: '', laeuft: false, archiviert: false, ...extra });
  return { w, d, le, z, g };
}

dom('Seitenleiste: Doppelklick macht den Namen bearbeitbar, Enter speichert, die Zeile bleibt dasselbe Element', async () => {
  const gespeichert = [];
  const { w, d, le, z } = leisteMit({ beiUmbenennen: async (id, titel) => void gespeichert.push([id, titel]) });
  le.zeichne({ sitzungen: [z(1, 'Eins'), z(2, 'Zwei')], weitere: [], archiv: [] }, 1);
  const zeile = d.querySelector('.sitzung[data-id="2"]');
  doppelklick(w, zeile.querySelector('.sitzung-titel'));
  const feld = d.querySelector('.sitzung-editor .titel-eingabe');
  assert.ok(feld, 'Namensfeld');
  assert.equal(feld.value, 'Zwei');
  assert.equal(d.activeElement, feld, 'Fokus im Feld');
  assert.equal(feld.maxLength, 120);
  feld.value = '  Zwei umbenannt ';
  taste(w, feld, 'Enter');
  await bis(() => !d.querySelector('.titel-eingabe'));
  assert.deepEqual(gespeichert, [[2, 'Zwei umbenannt']]);
  // der Aufrufer zeichnet mit dem neuen Namen; dieselben Elemente, kein Neuaufbau
  le.zeichne({ sitzungen: [z(1, 'Eins'), z(2, 'Zwei umbenannt')], weitere: [], archiv: [] }, 1);
  assert.equal(d.querySelector('.sitzung[data-id="2"]'), zeile);
  assert.equal(zeile.querySelector('.sitzung-titel').textContent, 'Zwei umbenannt');
  assert.equal(d.activeElement, zeile, 'Fokus zurück auf der Zeile');
  assert.equal(d.querySelector('.sitzung-editor').hidden, true);
});

dom('Seitenleiste: F2 und der Stift öffnen den Editor, Esc bricht ab ohne Aufruf, ein unveränderter Name ruft den Runner nicht', async () => {
  const gespeichert = [];
  const { w, d, le, z } = leisteMit({ beiUmbenennen: async (id, titel) => void gespeichert.push([id, titel]) });
  le.zeichne({ sitzungen: [z(1, 'Eins'), z(2, 'Zwei')], weitere: [], archiv: [] }, 1);
  const eins = d.querySelector('.sitzung[data-id="1"]');
  eins.focus();
  taste(w, eins, 'F2');
  let feld = d.querySelector('.titel-eingabe');
  assert.ok(feld && feld.value === 'Eins');
  feld.value = 'Etwas anderes';
  taste(w, feld, 'Escape');
  assert.equal(d.querySelector('.titel-eingabe'), null);
  assert.equal(eins.querySelector('.sitzung-titel').textContent, 'Eins');
  assert.equal(d.activeElement, eins);
  d.querySelector('.sitzung-zeile:nth-child(2) .umbenennen').click();
  feld = d.querySelector('.titel-eingabe');
  assert.equal(feld.value, 'Zwei');
  taste(w, feld, 'Enter');
  await bis(() => !d.querySelector('.titel-eingabe'));
  assert.deepEqual(gespeichert, [], 'nichts geändert, nichts gesendet');
  // leerer Name: Meldung, Feld bleibt, kein Aufruf
  le.bearbeite(1);
  feld = d.querySelector('.titel-eingabe');
  feld.value = '   ';
  taste(w, feld, 'Enter');
  assert.match(d.querySelector('.titel-fehler').textContent, /leer/);
  assert.equal(d.querySelector('.titel-eingabe'), feld);
  assert.deepEqual(gespeichert, []);
});

dom('Seitenleiste: lehnt der Runner ab, steht die Meldung an der Zeile, das Feld bleibt offen und der alte Name bleibt', async () => {
  const { w, d, le, z } = leisteMit({ beiUmbenennen: async () => { throw new Error('Nicht umbenannt: Gespräch nicht gefunden'); } });
  le.zeichne({ sitzungen: [z(1, 'Eins')], weitere: [], archiv: [] }, 1);
  le.bearbeite(1);
  const feld = d.querySelector('.titel-eingabe');
  feld.value = 'Neuer Name';
  taste(w, feld, 'Enter');
  await bis(() => d.querySelector('.titel-fehler') && !d.querySelector('.titel-fehler').hidden);
  assert.match(d.querySelector('.titel-fehler').textContent, /Gespräch nicht gefunden/);
  assert.equal(d.querySelector('.titel-fehler').getAttribute('role'), 'alert');
  assert.equal(d.querySelector('.titel-eingabe'), feld, 'Feld bleibt offen, der Text bleibt zum erneuten Versuch');
  assert.equal(feld.disabled, false);
  assert.equal(feld.value, 'Neuer Name');
  assert.equal(d.querySelector('.sitzung[data-id="1"] .sitzung-titel').textContent, 'Eins', 'alter Name bleibt');
  taste(w, feld, 'Escape');
  assert.equal(d.querySelector('.titel-eingabe'), null);
  assert.equal(d.querySelector('.sitzung[data-id="1"] .sitzung-titel').textContent, 'Eins');
});

dom('Seitenleiste: eine Aktualisierung der Liste während des Umbenennens lässt das Feld und den Text stehen', () => {
  const { w, d, le, z } = leisteMit({ beiUmbenennen: async () => {} });
  le.zeichne({ sitzungen: [z(1, 'Eins'), z(2, 'Zwei')], weitere: [], archiv: [] }, 1);
  le.bearbeite(2);
  const feld = d.querySelector('.titel-eingabe');
  feld.value = 'halb getippt';
  le.zeichne({ sitzungen: [z(2, 'Zwei', { laeuft: true }), z(1, 'Eins neu')], weitere: [], archiv: [] }, 1);
  assert.equal(d.querySelector('.titel-eingabe'), feld);
  assert.equal(feld.value, 'halb getippt');
  assert.equal(d.activeElement, feld);
  // verschwindet die Sitzung aus der Liste, geht der Editor mit
  le.zeichne({ sitzungen: [z(1, 'Eins neu')], weitere: [], archiv: [] }, 1);
  assert.equal(d.querySelector('.titel-eingabe'), null);
});

dom('Seitenleiste: Archivieren und Wiederherstellen; das Archiv ist eingeklappt; Hauptsitzung und Hintergrund bieten kein Archivieren an', async () => {
  const aufrufe = [];
  const { d, le, z, g } = leisteMit({ beiArchivieren: async (id, an) => void aufrufe.push([id, an]) });
  le.zeichne({ sitzungen: [z(1, 'Haupt', { art: 'root' }), z(2, 'Zwei')], weitere: [z(9, 'Lauf', { art: 'lauf' })], archiv: [z(3, 'Alt', { archiviert: true })] }, 1);
  assert.equal(d.querySelector('.sitzung-zeile .sitzung[data-id="1"]').closest('.sitzung-zeile').querySelector('.archivieren').hidden, true);
  assert.equal(d.querySelector('.sitzung[data-id="9"]').closest('.sitzung-zeile').querySelector('.archivieren').hidden, true);
  assert.equal(d.querySelector('.sitzung[data-id="2"]').closest('.sitzung-zeile').querySelector('.archivieren').hidden, false);
  assert.equal(g('ak').hidden, false);
  assert.equal(g('az').textContent, '1');
  assert.equal(g('a').hidden, true, 'eingeklappt');
  g('ak').click();
  assert.equal(g('a').hidden, false);
  assert.equal(g('ak').getAttribute('aria-expanded'), 'true');
  const alt = g('a').querySelector('.sitzung');
  assert.equal(alt.querySelector('.sitzung-titel').textContent, 'Alt');
  assert.equal(alt.disabled, true, 'archivierte Zeile ist nur Anzeige');
  d.querySelector('.sitzung[data-id="2"]').closest('.sitzung-zeile').querySelector('.archivieren').click();
  g('a').querySelector('.wiederherstellen').click();
  await bis(() => aufrufe.length === 2);
  assert.deepEqual(aufrufe, [[2, true], [3, false]]);
  // ohne Archivierte verschwindet der Abschnitt
  le.zeichne({ sitzungen: [z(1, 'Haupt', { art: 'root' })], weitere: [], archiv: [] }, 1);
  assert.equal(g('ak').hidden, true);
  assert.equal(g('a').hidden, true);
});

dom('Seitenleiste: ein Fehler beim Archivieren steht an der Zeile', async () => {
  const { d, le, z } = leisteMit({ beiArchivieren: async () => { throw new Error('Nicht archiviert: HTTP 500'); } });
  le.zeichne({ sitzungen: [z(2, 'Zwei')], weitere: [], archiv: [] }, 2);
  d.querySelector('.archivieren').click();
  await bis(() => !d.querySelector('.sitzung-fehler').hidden);
  assert.match(d.querySelector('.sitzung-fehler').textContent, /Nicht archiviert/);
  assert.equal(d.querySelector('.archivieren').disabled, false);
});

// Ganze Seite (chat.html mit allen Skripten) gegen einen kleinen Runner aus dem Speicher: so, wie die Seite im Prüfstand läuft
function arbeitsplatz(opt) {
  opt = opt || {};
  const st = { gespraeche: [{ id: 1, art: 'root', titel: 'Haupt', erstellt: 1000, arbeitsbereich: 'standard', archiviert: false, agent: { cwd: '/probe/standard' } }, { id: 2, art: 'mensch', titel: 'Zweite', erstellt: 900, arbeitsbereich: 'standard', archiviert: false, agent: { cwd: '/probe/standard' } }, ...(opt.archivierte || [])], naechste: 3, aufrufe: [], patchFehler: null };
  const antwort = (code, obj) => Promise.resolve({ ok: code < 400, status: code, json: async () => obj });
  const fetchStub = (url, o) => {
    const methode = (o && o.method) || 'GET';
    const k = o && o.body ? JSON.parse(o.body) : undefined;
    st.aufrufe.push({ methode, url, koerper: k });
    if (/\/ereignisse$|\/api\/strom$/.test(url)) return new Promise(() => {}); // Ströme bleiben offen und still
    if (methode === 'GET' && /^\/api\/gespraeche(\?|$)/.test(url)) {
      // opt.archivWeg: der Runner kennt ?archiv=1|alle (jedes Gespräch trägt archiviert); sonst wie ein älterer Runner: Parameter ignoriert, kein Feld archiviert
      const modus = new URL(url, 'http://x').searchParams.get('archiv');
      if (!opt.archivWeg) return antwort(200, { ok: true, gespraeche: st.gespraeche.filter((g) => !g.archiviert).map(({ archiviert, ...rest }) => rest) });
      if (st.listeFehler && modus === '1') return antwort(500, { ok: false, fehler: 'kaputt' });
      return antwort(200, { ok: true, gespraeche: st.gespraeche.filter((g) => (modus === 'alle' ? true : modus === '1' ? g.archiviert : !g.archiviert)) });
    }
    // Wege der neueren Runner (Suche, Datei lesen, Dateiliste): nur mit opt.runner; sonst antwortet der Speicher-Runner wie ein älterer mit „Unbekannte Route“
    const weg = methode === 'GET' && opt.runner ? /^\/api\/(suche|datei|ordner)\?/.exec(url) : null;
    if (weg && opt.runner[weg[1]]) {
      const r = opt.runner[weg[1]](new URL(url, 'http://x').searchParams, url, st);
      if (r && typeof r.then === 'function') return r.then((x) => antwort(x[0], x[1]));
      return antwort(r[0], r[1]);
    }
    if (methode === 'GET' && /^\/api\/(suche|datei)\?/.test(url)) return antwort(404, { ok: false, fehler: `Unbekannte Route: GET ${url.split('?')[0]}` });
    // Befehle des Runners (GET /api/befehle?gespraech=): nur mit opt.befehle; sonst wie ein älterer Runner
    if (methode === 'GET' && /^\/api\/befehle(\?|$)/.test(url)) {
      if (!opt.befehle) return antwort(404, { ok: false, fehler: 'Unbekannte Route: GET /api/befehle' });
      return antwort(200, { ok: true, befehle: opt.befehle, anzahl: opt.befehle.length });
    }
    if (methode === 'POST' && /^\/api\/gespraech\/\d+\/nachricht$/.test(url)) {
      const r = opt.nachricht ? opt.nachricht(k, st) : { ok: true, id: 7, art: k.art };
      return antwort(r.status || 200, r.status ? { ok: false, fehler: r.fehler } : r);
    }
    if (methode === 'GET' && url === '/api/konfiguration') return antwort(200, { ok: true, arbeitsbereiche: { standard: { titel: 'Standard', pfad: '/probe/standard' } }, modelle: [] });
    if (methode === 'GET' && url === '/api/health') return antwort(200, { ok: true, agent: 'probe' });
    if (methode === 'GET' && /^\/api\/gespraech\/\d+\/ansicht/.test(url)) {
      const g = st.gespraeche.find((x) => '/api/gespraech/' + x.id + '/ansicht?voll=1' === url);
      const roh = opt.ansicht ? opt.ansicht(g ? g.id : null) : {};
      return antwort(200, { entries: roh.entries || [], meta: g ? { titel: g.titel, ...(roh.modell ? { modell: roh.modell } : {}) } : null, usage: roh.usage || null, ...(roh.agent ? { agent: roh.agent } : {}) });
    }
    if (methode === 'GET' && /^\/api\/gespraech\/\d+$/.test(url)) return antwort(200, { ok: true, agent: { cwd: '/probe/standard' } });
    if (methode === 'GET' && url.startsWith('/api/ordner')) return antwort(404, { fehler: 'unbekannt' });
    if (methode === 'GET' && url === '/api/modelle') return antwort(200, { ok: true, modelle: opt.modelle || [] });
    if (methode === 'GET') return antwort(200, { ok: true, freigaben: [], modelle: [] });
    if (methode === 'POST' && url === '/api/gespraeche') {
      const g = { id: st.naechste++, art: 'mensch', titel: String((k && k.titel) || '').slice(0, 120) || 'Neuer Agent', erstellt: Date.now(), arbeitsbereich: 'standard', archiviert: false, agent: { cwd: '/probe/standard' } };
      st.gespraeche.push(g);
      return antwort(201, { ok: true, gespraech: { id: g.id, meta: { titel: g.titel }, agent: { cwd: g.agent.cwd } } });
    }
    const m = methode === 'PATCH' && /^\/api\/gespraech\/(\d+)$/.exec(url);
    if (m) {
      if (st.patchFehler) return antwort(500, { ok: false, fehler: st.patchFehler });
      const g = st.gespraeche.find((x) => String(x.id) === m[1]);
      if (!g) return antwort(500, { ok: false, fehler: 'Gespräch nicht gefunden' });
      if (k.titel !== undefined) g.titel = k.titel.slice(0, 120) || g.titel;
      if (k.archiviert !== undefined) g.archiviert = !!k.archiviert;
      if (k.modell !== undefined) {
        if (opt.modellFehler) return antwort(500, { ok: false, fehler: opt.modellFehler });
        const m = k.modell === null ? null : (opt.modelle || []).find((x) => x.id === k.modell);
        if (k.modell !== null && !m) return antwort(500, { ok: false, fehler: 'Unbekanntes Modell' });
        g.modell = k.modell;
        const wirksam = m || { provider: 'probe', id: 'probe-standard' };
        return antwort(200, { ok: true, gespraech: { id: g.id, meta: { titel: g.titel, modell: k.modell }, agent: { model: { provider: wirksam.provider, modelId: wirksam.id }, cwd: '/probe/standard' } } });
      }
      return antwort(200, { ok: true, gespraech: { id: g.id, meta: { titel: g.titel, archiviert: g.archiviert } } });
    }
    return antwort(404, { fehler: 'unbekannt ' + methode + ' ' + url });
  };
  const html = lies('chat.html').replace(/<script[^>]*><\/script>/g, '');
  const d = new jsdom.JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = d.window;
  w.fetch = fetchStub;
  w.TextDecoder = TextDecoder; // jsdom bringt keinen mit; im WebView gibt es ihn
  if (opt.tauri) {
    // Brücke der Anwendung als Attrappe: Anfragen an den Runner gehen an den Speicher-Runner, alles andere an opt.tauri(befehl, argumente)
    st.tauri = [];
    w.__TAURI__ = {
      core: {
        invoke: (b, a) => {
          st.tauri.push([b, a]);
          if (b === 'runner_anfrage') {
            // Fehler wie aus Rust: Katalogmeldung; der Text des Runners (Feld fehler) steht in details als „HTTP <Status>: <Text>“ (fehler_aus_status in bruecke.rs)
            return fetchStub(a.pfad, { method: a.methode, body: a.koerper == null ? undefined : JSON.stringify(a.koerper) }).then(async (r) => {
              if (r.ok) return r.json();
              const j = await r.json().catch(() => ({}));
              return Promise.reject({ code: 'RUNNER_FEHLER', ursache: `Der Runner antwortet mit einem Fehler (Status ${r.status}).`, abhilfe: 'Noch einmal versuchen.', details: `HTTP ${r.status}${j && j.fehler ? `: ${j.fehler}` : ''}` });
            });
          }
          if (b === 'strom_oeffnen') return Promise.resolve();
          if (b === 'runner_liste') return Promise.resolve({ runner: [] });
          if (b === 'ziel_info') return Promise.resolve({ host: '127.0.0.1', lokal: true, ruhe: false, runner: { id: 'r', name: 'R', art: 'entfernt' }, e2e: false, freigaben_zeigen: false });
          const r = opt.tauri(b, a);
          return r instanceof Error || (r && r.ursache) ? Promise.reject(r) : Promise.resolve(r === undefined ? null : r);
        },
      },
      event: { listen: () => Promise.resolve(() => {}) },
    };
  }
  for (const m of lies('chat.html').matchAll(/<script src="([^"]+)"><\/script>/g)) w.eval(lies(m[1]));
  return { w, d: w.document, st, g: (id) => w.document.getElementById(id), schliesse: () => w.close() };
}

dom('Seite: Neue Sitzung mit Namen (Enter im Namensfeld) schickt titel; ohne Namen schickt keinen', async () => {
  const { w, d, st, g, schliesse } = arbeitsplatz();
  try {
    await bis(() => d.querySelectorAll('#sitzungsliste .sitzung').length === 2);
    assert.equal(g('neuTitel').placeholder, 'Name der Sitzung (optional)');
    g('neueSitzung').click();
    assert.equal(g('neuForm').hidden, false);
    assert.equal(d.activeElement, g('neuTitel'));
    g('neuTitel').value = '  Mein Projekt ';
    taste(w, g('neuTitel'), 'Enter');
    await bis(() => st.aufrufe.some((a) => a.methode === 'POST'));
    const post = st.aufrufe.find((a) => a.methode === 'POST');
    assert.equal(post.url, '/api/gespraeche');
    assert.equal(post.koerper.titel, 'Mein Projekt');
    await bis(() => g('titel').textContent === 'Mein Projekt');
    assert.ok([...d.querySelectorAll('#sitzungsliste .sitzung-titel')].some((t) => t.textContent === 'Mein Projekt'));
    assert.equal(g('neuForm').hidden, true);
    // ohne Namen: das Feld fehlt im Körper, der Runner vergibt seinen Standard
    g('neueSitzung').click();
    assert.equal(g('neuTitel').value, '');
    taste(w, g('neuTitel'), 'Enter');
    await bis(() => st.aufrufe.filter((a) => a.methode === 'POST').length === 2);
    assert.equal('titel' in st.aufrufe.filter((a) => a.methode === 'POST')[1].koerper, false);
    await bis(() => g('titel').textContent === 'Neuer Agent');
    // der Knopf „Anlegen“ geht weiter
    g('neueSitzung').click();
    g('neuTitel').value = 'Per Knopf';
    g('neuAnlegen').click();
    await bis(() => st.aufrufe.filter((a) => a.methode === 'POST').length === 3);
    assert.equal(st.aufrufe.filter((a) => a.methode === 'POST')[2].koerper.titel, 'Per Knopf');
    await bis(() => g('titel').textContent === 'Per Knopf');
  } finally {
    schliesse();
  }
});

dom('Seite: Umbenennen im Kopf (Doppelklick, Stift, F2) und in der Leiste; Entwurf und Ansicht bleiben, kein Neuaufbau', async () => {
  const { w, d, st, g, schliesse } = arbeitsplatz();
  try {
    await bis(() => g('titel').textContent === 'Haupt' && !g('titelUmbenennen').hidden);
    const pane = d.querySelector('.pane.aktiv');
    const zeile = d.querySelector('#sitzungsliste .sitzung[data-id="1"]');
    g('eingabe').value = 'halber Entwurf';
    const fetchesVorher = st.aufrufe.filter((a) => /ansicht|ereignisse/.test(a.url)).length;
    doppelklick(w, g('titel'));
    assert.equal(g('titelEditor').hidden, false);
    assert.equal(g('titel').hidden, true);
    let feld = g('titelEditor').querySelector('input');
    assert.equal(feld.value, 'Haupt');
    feld.value = 'Hauptgespräch';
    taste(w, feld, 'Enter');
    await bis(() => g('titelEditor').hidden);
    const patch = st.aufrufe.find((a) => a.methode === 'PATCH');
    assert.equal(patch.url, '/api/gespraech/1');
    assert.deepEqual(patch.koerper, { titel: 'Hauptgespräch' });
    assert.equal(g('titel').hidden, false);
    assert.equal(g('titel').textContent, 'Hauptgespräch');
    assert.equal(zeile.querySelector('.sitzung-titel').textContent, 'Hauptgespräch');
    assert.equal(d.querySelector('#sitzungsliste .sitzung[data-id="1"]'), zeile, 'Zeile bleibt dasselbe Element');
    assert.equal(d.querySelector('.pane.aktiv'), pane, 'Ansicht der Sitzung wird nicht neu gebaut');
    assert.equal(g('eingabe').value, 'halber Entwurf');
    assert.equal(st.aufrufe.filter((a) => /ansicht|ereignisse/.test(a.url)).length, fetchesVorher, 'kein erneutes Laden des Verlaufs');
    // der Stift und F2 öffnen dasselbe
    g('titelUmbenennen').click();
    feld = g('titelEditor').querySelector('input');
    assert.equal(feld.value, 'Hauptgespräch');
    taste(w, feld, 'Escape');
    assert.equal(g('titelEditor').hidden, true);
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
    assert.equal(g('titelEditor').hidden, false);
    taste(w, g('titelEditor').querySelector('input'), 'Escape');
    assert.equal(st.aufrufe.filter((a) => a.methode === 'PATCH').length, 1, 'Esc sendet nichts');
    // Leiste: Doppelklick auf eine andere Sitzung benennt diese um, der Kopf der offenen Sitzung bleibt
    const zwei = d.querySelector('#sitzungsliste .sitzung[data-id="2"]');
    doppelklick(w, zwei.querySelector('.sitzung-titel'));
    feld = d.querySelector('.sitzung-editor .titel-eingabe');
    feld.value = 'Zweite umbenannt';
    taste(w, feld, 'Enter');
    await bis(() => st.aufrufe.filter((a) => a.methode === 'PATCH').length === 2);
    assert.equal(st.aufrufe.filter((a) => a.methode === 'PATCH')[1].url, '/api/gespraech/2');
    await bis(() => zwei.querySelector('.sitzung-titel').textContent === 'Zweite umbenannt');
    assert.equal(g('titel').textContent, 'Hauptgespräch');
    // auch beim nächsten Laden der Liste steht der neue Name (der Runner hat ihn)
    await w.__arbeitsplatz.ladeListe();
    await warte(120);
    assert.equal(zwei.querySelector('.sitzung-titel').textContent, 'Zweite umbenannt');
  } finally {
    schliesse();
  }
});

dom('Seite: Ablehnung des Runners beim Umbenennen erscheint als Meldung, der alte Name bleibt in Kopf und Liste', async () => {
  const { w, d, st, g, schliesse } = arbeitsplatz();
  try {
    await bis(() => g('titel').textContent === 'Haupt' && !g('titelUmbenennen').hidden);
    st.patchFehler = 'Gespräch gesperrt';
    g('titelUmbenennen').click();
    const feld = g('titelEditor').querySelector('input');
    feld.value = 'Geht nicht';
    taste(w, feld, 'Enter');
    await bis(() => g('titelEditor').querySelector('.titel-fehler') && !g('titelEditor').querySelector('.titel-fehler').hidden);
    assert.match(g('titelEditor').querySelector('.titel-fehler').textContent, /Nicht umbenannt: .*Gespräch gesperrt/);
    assert.equal(g('titel').textContent, 'Haupt');
    assert.equal(d.querySelector('#sitzungsliste .sitzung[data-id="1"] .sitzung-titel').textContent, 'Haupt');
    // erneuter Versuch klappt, sobald der Runner wieder annimmt
    st.patchFehler = null;
    taste(w, feld, 'Enter');
    await bis(() => g('titelEditor').hidden);
    assert.equal(g('titel').textContent, 'Geht nicht');
  } finally {
    schliesse();
  }
});

dom('Seite: Archivieren und Wiederherstellen (PATCH archiviert); die offene Sitzung weicht auf die Hauptsitzung aus', async () => {
  const { w, d, st, g, schliesse } = arbeitsplatz();
  try {
    await bis(() => d.querySelectorAll('#sitzungsliste .sitzung').length === 2);
    await w.__arbeitsplatz.wechsle(2);
    await bis(() => g('titel').textContent === 'Zweite');
    const zeile2 = d.querySelector('#sitzungsliste .sitzung[data-id="2"]').closest('.sitzung-zeile');
    zeile2.querySelector('.archivieren').click();
    await bis(() => st.aufrufe.some((a) => a.methode === 'PATCH'));
    const patch = st.aufrufe.find((a) => a.methode === 'PATCH');
    assert.equal(patch.url, '/api/gespraech/2');
    assert.deepEqual(patch.koerper, { archiviert: true });
    await bis(() => !d.querySelector('#sitzungsliste .sitzung[data-id="2"]'));
    await bis(() => g('titel').textContent === 'Haupt');
    assert.equal(g('archivKopf').hidden, false);
    assert.equal(g('archivZahl').textContent, '1');
    assert.equal(g('archivListe').hidden, true, 'Archiv ist eingeklappt');
    g('archivKopf').click();
    assert.equal(g('archivListe').querySelector('.sitzung-titel').textContent, 'Zweite');
    // auch nach dem nächsten Laden der Liste (der Runner nennt sie nicht mehr) bleibt sie im Archiv
    await w.__arbeitsplatz.ladeListe();
    await warte(120);
    assert.equal(g('archivListe').querySelectorAll('.sitzung').length, 1);
    g('archivListe').querySelector('.wiederherstellen').click();
    await bis(() => st.aufrufe.filter((a) => a.methode === 'PATCH').length === 2);
    assert.deepEqual(st.aufrufe.filter((a) => a.methode === 'PATCH')[1].koerper, { archiviert: false });
    await bis(() => d.querySelector('#sitzungsliste .sitzung[data-id="2"]'));
    assert.equal(g('archivKopf').hidden, true);
    for (const a of st.aufrufe.filter((x) => x.methode === 'PATCH')) assert.deepEqual(Object.keys(a.koerper).length, 1, 'je Aufruf genau ein Feld');
  } finally {
    schliesse();
  }
});

test('Brücke: PATCH hat genau drei Stellen (umbenennen, archivieren, Modell wechseln) und nur diese Felder (Quelltext-Prüfung)', () => {
  const quelle = lies('sitzungen.js') + lies('leiste.js') + lies('chat.js');
  const patches = quelle.match(/'PATCH'/g) || [];
  assert.equal(patches.length, 3, 'PATCH steht genau dreimal in der Seite (umbenennen, archivieren, Modell)');
  assert.ok(/aenderungsKoerper\(\{ titel: p\.titel \}\)/.test(quelle) && /aenderungsKoerper\(\{ archiviert: !!an \}\)/.test(quelle));
  assert.ok(/transport\.api\('PATCH', weg\(id\), \{ modell: modellId \}\)/.test(quelle), 'der Körper des Modellwechsels trägt nur modell');
  assert.ok(!/'(PUT|DELETE)'/.test(quelle), 'kein PUT oder DELETE in der Seite');
});

// --- Freigaben-Panel (freigaben.js): Zahl, Liste über alle Sitzungen, Karten, Später, Sprung ---
const FREIGABEN_HTML = '<!doctype html><body><button id="kn" hidden></button><button id="ba" hidden></button><b id="za">0</b><aside id="pa" hidden><button id="zu"></button><p id="hi" hidden></p><div id="li"></div></aside></body>';

const plain = (x) => JSON.parse(JSON.stringify(x)); // Werte aus dem jsdom-Fenster haben andere Prototypen: erst vergleichbar machen

/** Form eines Eintrags aus GET /api/freigaben des Runners (siehe deploy/runner/pi-durable/test/freigaben-wege.test.js). */
const fg = (id, conv, extra) => ({ id, conversationId: conv, gespraechTitel: `Sitzung ${conv}`, aktion: `Aktion ${id}`, risiko: 'medium', kontext: `Kontext ${id}`, befehl: null, werkzeug: 'bash', status: 'offen', erstellt: Number(String(id).replace(/\D/g, '')) || 1, ...extra });

function freigabenMit(start, opts = {}) {
  const w = fenster(['freigaben.js'], FREIGABEN_HTML);
  const d = w.document;
  const g = (id) => d.getElementById(id);
  const zustand = { liste: start, aufrufe: [], fehler: null, sprung: [], aenderungen: 0 };
  const transport = {
    api: async (methode, pfad, koerper) => {
      zustand.aufrufe.push([methode, pfad, koerper]);
      if (zustand.fehler && methode === 'POST') throw new Error(zustand.fehler);
      if (methode === 'GET') return { ok: true, freigaben: zustand.liste };
      const id = decodeURIComponent(pfad.split('/').pop());
      zustand.liste = zustand.liste.map((f) => (String(f.id) === id ? { ...f, status: koerper.entscheidung } : f));
      return { ok: true, freigaben: zustand.liste };
    },
  };
  const fp = w.FyosPrototyp.createFreigaben(
    { knopf: g('kn'), zahl: g('za'), panel: g('pa'), liste: g('li'), zu: g('zu'), hinweis: g('hi'), banner: g('ba') },
    { transport, intervallMs: 0, beiSprung: (id) => zustand.sprung.push(id), beiAenderung: () => void (zustand.aenderungen += 1), ...opts },
  );
  const karten = () => [...d.querySelectorAll('.fp-karte')];
  return { w, d, g, fp, zustand, karten };
}

dom('Freigaben: Knopf mit der Zahl ALLER offenen Freigaben (alle Sitzungen), Entschiedenes zählt nicht, bei null ist der Knopf weg', async () => {
  const f = freigabenMit([fg('f1', 1), fg('f2', 2), fg('f3', 2, { status: 'erteilt' }), fg('f4', 3, { status: 'abgelehnt' })]);
  assert.equal(f.g('kn').hidden, true, 'vor dem Laden: nichts zu zeigen');
  await f.fp.lade();
  assert.equal(f.g('kn').hidden, false);
  assert.equal(f.g('za').textContent, '2');
  assert.equal(f.g('kn').getAttribute('aria-expanded'), 'false');
  f.zustand.liste = [];
  await f.fp.lade();
  assert.equal(f.g('za').textContent, '0');
  assert.equal(f.g('kn').hidden, true);
  assert.ok(f.zustand.aenderungen > 0, 'der Aufrufer wird bei jeder Änderung benachrichtigt (Kopfzustand „wartet auf dich“)');
});

dom('Freigaben: Panel zeigt jede offene Freigabe mit Sitzung, Risiko, Aktion, Kontext und Befehl; hohes Risiko ist hervorgehoben; leer: „Keine offenen Freigaben.“', async () => {
  const f = freigabenMit([
    fg('f1', 1, { risiko: 'low', befehl: 'echo eins' }),
    fg('f2', 2, { risiko: 'high', befehl: 'git branch -D alt', aktion: 'Branch löschen', kontext: 'Aufräumen nach dem Merge.' }),
    fg('f3', 2, { risiko: undefined, befehl: null, werkzeug: 'edit' }),
  ]);
  await f.fp.lade();
  assert.equal(f.g('pa').hidden, true);
  f.g('kn').click();
  assert.equal(f.g('pa').hidden, false);
  assert.equal(f.g('kn').getAttribute('aria-expanded'), 'true');
  const k = f.karten();
  assert.equal(k.length, 3);
  assert.deepEqual(k.map((x) => x.dataset.id), ['f1', 'f2', 'f3'], 'älteste zuerst');
  assert.match(k[0].querySelector('.chip.risiko').textContent, /geringes Risiko/);
  assert.equal(k[1].classList.contains('high'), true);
  assert.equal(k[0].classList.contains('high'), false);
  assert.match(k[1].querySelector('.chip.risiko').textContent, /hohes Risiko/);
  assert.match(k[2].querySelector('.chip.risiko').textContent, /mittleres Risiko/, 'ohne Angabe: mittleres Risiko');
  assert.equal(k[1].querySelector('.fp-aktion').textContent, 'Branch löschen');
  assert.equal(k[1].querySelector('.fp-kontext').textContent, 'Aufräumen nach dem Merge.');
  assert.equal(k[1].querySelector('.fp-befehl').textContent, 'git branch -D alt');
  assert.equal(k[2].querySelector('.fp-befehl').textContent, 'edit', 'ohne Befehl das Werkzeug');
  assert.equal(k[1].querySelector('.fp-sitzung-titel').textContent, 'Sitzung 2');
  for (const x of k) assert.deepEqual([...x.querySelectorAll('.fp-knoepfe button')].map((b) => b.textContent), ['Erlauben', 'Ablehnen', 'Später']);
  // leer
  f.zustand.liste = [];
  await f.fp.lade();
  assert.equal(f.karten().length, 0);
  assert.equal(f.g('li').textContent, 'Keine offenen Freigaben.');
  assert.equal(f.g('pa').hidden, false, 'ein geöffnetes Panel bleibt offen, auch wenn nichts mehr offen ist');
  assert.equal(f.g('kn').hidden, false);
});

dom('Freigaben: Texte vom Runner sind nur Text (kein HTML)', async () => {
  const f = freigabenMit([fg('f1', 1, { aktion: '<img src=x onerror=alert(1)>', kontext: '<b>fett</b>', gespraechTitel: '<script>x</script>' })]);
  await f.fp.lade();
  f.fp.zeige(true);
  assert.equal(f.d.querySelectorAll('.fp-liste img, .fp-liste b, .fp-liste script, #li img, #li script').length, 0);
  assert.equal(f.d.querySelector('.fp-aktion').textContent, '<img src=x onerror=alert(1)>');
});

dom('Freigaben: Erlauben und Ablehnen schicken genau erteilt/abgelehnt mit von=mensch an den Weg des Runners; die Antwortliste ersetzt die Anzeige', async () => {
  const f = freigabenMit([fg('f1', 1), fg('f2', 2)]);
  await f.fp.lade();
  f.fp.zeige(true);
  const knopf = (id, text) => [...f.d.querySelectorAll(`.fp-karte[data-id="${id}"] button`)].find((b) => b.textContent === text);
  knopf('f1', 'Erlauben').click();
  await bis(() => f.karten().length === 1);
  const post = f.zustand.aufrufe.filter((a) => a[0] === 'POST');
  assert.deepEqual(plain(post), [['POST', '/api/freigaben/f1', { entscheidung: 'erteilt', von: 'mensch' }]]);
  assert.equal(f.g('za').textContent, '1');
  assert.match(f.g('hi').textContent, /Freigabe erteilt/);
  knopf('f2', 'Ablehnen').click();
  await bis(() => f.karten().length === 0);
  assert.deepEqual(plain(f.zustand.aufrufe.filter((a) => a[0] === 'POST')[1]), ['POST', '/api/freigaben/f2', { entscheidung: 'abgelehnt', von: 'mensch' }]);
  assert.equal(f.g('li').textContent, 'Keine offenen Freigaben.');
  assert.match(f.g('hi').textContent, /Freigabe abgelehnt/);
});

dom('Freigaben: Ids mit Sonderzeichen werden im Weg maskiert; scheitert die Entscheidung, steht der Grund da und die Knöpfe sind wieder frei', async () => {
  const f = freigabenMit([fg('fr-a/b c', 1)]);
  await f.fp.lade();
  f.fp.zeige(true);
  f.zustand.fehler = 'Freigabe ist bereits abgelehnt';
  f.d.querySelector('.fp-erlauben').click();
  await bis(() => /nicht gespeichert/.test(f.g('hi').textContent));
  assert.match(f.g('hi').textContent, /bereits abgelehnt/);
  assert.equal(f.zustand.aufrufe.find((a) => a[0] === 'POST')[1], '/api/freigaben/fr-a%2Fb%20c');
  await bis(() => f.d.querySelector('.fp-erlauben') && !f.d.querySelector('.fp-erlauben').disabled);
  assert.equal(f.d.querySelector('.fp-ablehnen').disabled, false);
});

dom('Freigaben: „Später“ stellt nur im Fenster zurück: nichts wird gesendet, die Zahl bleibt, die Karte bleibt in der Liste, „Jetzt entscheiden“ holt die Knöpfe zurück', async () => {
  const f = freigabenMit([fg('f1', 1), fg('f2', 2)]);
  await f.fp.lade();
  f.fp.zeige(true);
  const aufrufeVorher = f.zustand.aufrufe.length;
  f.d.querySelector('.fp-karte[data-id="f1"] .fp-spaeter').click();
  assert.equal(f.zustand.aufrufe.length, aufrufeVorher, 'kein Aufruf beim Runner');
  assert.equal(f.g('za').textContent, '2', 'bleibt offen und gezählt');
  const k = f.d.querySelector('.fp-karte[data-id="f1"]');
  assert.equal(k.dataset.zustand, 'spaeter');
  assert.match(k.querySelector('.fp-ergebnis').textContent, /bleibt in der Liste und in der Menüleiste offen/);
  assert.deepEqual([...k.querySelectorAll('button')].map((b) => b.textContent).filter((t) => t !== 'Zur Sitzung'), ['Jetzt entscheiden']);
  assert.deepEqual(plain(f.fp.zurueckgestellt()), ['f1']);
  // das nächste Abfragen ändert daran nichts
  await f.fp.lade();
  assert.equal(f.d.querySelector('.fp-karte[data-id="f1"]').dataset.zustand, 'spaeter');
  assert.equal(f.karten().length, 2);
  f.d.querySelector('.fp-karte[data-id="f1"] .fp-jetzt').click();
  assert.equal(f.d.querySelector('.fp-karte[data-id="f1"]').dataset.zustand, 'offen');
  assert.deepEqual([...f.d.querySelectorAll('.fp-karte[data-id="f1"] .fp-knoepfe button')].map((b) => b.textContent), ['Erlauben', 'Ablehnen', 'Später']);
  // zurückgestellt, dann anderswo entschieden: das Merken fällt weg
  f.d.querySelector('.fp-karte[data-id="f2"] .fp-spaeter').click();
  f.zustand.liste = f.zustand.liste.map((x) => (x.id === 'f2' ? { ...x, status: 'erteilt' } : x));
  await f.fp.lade();
  assert.deepEqual(plain(f.fp.zurueckgestellt()), []);
  assert.equal(f.g('za').textContent, '1');
});

dom('Freigaben: der Sprung öffnet die Sitzung der Freigabe (ihre Id), schließt das Panel und ruft nichts beim Runner auf', async () => {
  const f = freigabenMit([fg('f1', 1), fg('f2', 'abc-7')]);
  await f.fp.lade();
  f.fp.zeige(true);
  const vorher = f.zustand.aufrufe.length;
  f.d.querySelector('.fp-karte[data-id="f2"] .fp-sprung').click();
  assert.deepEqual(f.zustand.sprung, ['abc-7']);
  assert.equal(f.g('pa').hidden, true, 'das Panel geht zu, die Karte der Sitzung ist im Verlauf');
  assert.equal(f.zustand.aufrufe.length, vorher);
  assert.equal(f.g('za').textContent, '2', 'die Freigabe bleibt offen');
  assert.equal(f.g('kn').hidden, false);
  // Sprung auch aus einer zurückgestellten Karte
  f.fp.zeige(true);
  f.d.querySelector('.fp-karte[data-id="f1"] .fp-spaeter').click();
  f.d.querySelector('.fp-karte[data-id="f1"] .fp-sprung').click();
  assert.deepEqual(f.zustand.sprung, ['abc-7', '1']);
});

dom('Freigaben: Esc schließt das Panel; 1, 2, J, N und Esc im Panel erreichen nicht die Tastenkürzel der Verlaufskarte am Dokument', async () => {
  const f = freigabenMit([fg('f1', 1)]);
  await f.fp.lade();
  f.fp.zeige(true);
  const amDokument = [];
  f.d.addEventListener('keydown', (e) => amDokument.push(e.key));
  const knopf = f.d.querySelector('.fp-erlauben');
  for (const key of ['1', '2', 'y', 'n']) taste(f.w, knopf, key);
  assert.deepEqual(amDokument, [], 'keine der Tasten kommt am Dokument an');
  assert.equal(f.zustand.aufrufe.filter((a) => a[0] === 'POST').length, 0, 'und entscheidet nichts');
  taste(f.w, knopf, 'Escape');
  assert.equal(f.g('pa').hidden, true);
  assert.deepEqual(amDokument, []);
  // andere Tasten (Tab, Cmd+B) gehen weiter
  f.fp.zeige(true);
  taste(f.w, f.d.querySelector('.fp-erlauben'), 'b', { metaKey: true });
  assert.deepEqual(amDokument, ['b']);
});

dom('Freigaben: bei einem Fehler der Liste bleibt die alte stehen; nach zwei Fehlern steht ein Hinweis im Panel', async () => {
  const w = fenster(['freigaben.js'], FREIGABEN_HTML);
  const g = (id) => w.document.getElementById(id);
  let ok = true;
  const fp = w.FyosPrototyp.createFreigaben(
    { knopf: g('kn'), zahl: g('za'), panel: g('pa'), liste: g('li'), zu: g('zu'), hinweis: g('hi') },
    { intervallMs: 0, transport: { api: async () => { if (!ok) throw new Error('weg'); return { freigaben: [fg('f1', 1)] }; } } },
  );
  await fp.lade();
  fp.zeige(true);
  ok = false;
  await fp.lade();
  assert.equal(w.document.querySelectorAll('.fp-karte').length, 1, 'die alte Liste bleibt');
  assert.ok(!/nicht laden/.test(g('li').textContent), 'ein einzelner Fehler macht keinen Lärm');
  await fp.lade();
  assert.match(g('li').textContent, /lässt sich gerade nicht laden/);
  assert.equal(w.document.querySelectorAll('.fp-karte').length, 1);
});

const tippe = (w, feld, wert) => {
  feld.value = wert;
  feld.dispatchEvent(new w.Event('input', { bubbles: true }));
};
const knopfIn = (f, id, text) => [...f.d.querySelectorAll(`.fp-karte[data-id="${id}"] button`)].find((b) => b.textContent === text);

dom('Freigaben: zerstörerische Freigaben tragen die Marke „zerstörerisch“ neben dem Risiko (Text und Farbklasse), die übrigen nicht', async () => {
  const f = freigabenMit([fg('f1', 1), fg('f2', 2, { zerstoererisch: true }), fg('f3', 3, { risiko: 'high', zerstoererisch: true })]);
  await f.fp.lade();
  f.fp.zeige(true);
  const k = f.karten();
  assert.equal(k[0].querySelector('.chip.zerst'), null);
  assert.equal(k[0].dataset.zerstoererisch, undefined);
  assert.equal(k[1].querySelector('.chip.zerst').textContent, 'zerstörerisch');
  assert.match(k[1].querySelector('.chip.risiko').textContent, /mittleres Risiko/, 'die Marke ersetzt das Risiko nicht');
  assert.equal(k[1].dataset.zerstoererisch, '1');
  assert.ok(k[1].classList.contains('zerst'));
  assert.ok(k[2].querySelector('.chip.zerst') && k[2].querySelector('.chip.risiko'));
});

dom('Freigaben: Notizfeld ist optional, auf 500 Zeichen begrenzt, geht getrimmt im POST mit und fehlt dort, wenn es leer ist', async () => {
  const f = freigabenMit([fg('f1', 1), fg('f2', 2), fg('f3', 3)]);
  await f.fp.lade();
  f.fp.zeige(true);
  const feld = (id) => f.d.querySelector(`.fp-karte[data-id="${id}"] textarea.fp-notiz`);
  assert.equal(feld('f1').maxLength, 500);
  assert.match(feld('f1').getAttribute('aria-label'), /Notiz/);
  tippe(f.w, feld('f1'), '  Nur in der Testumgebung.  ');
  knopfIn(f, 'f1', 'Erlauben').click();
  await bis(() => f.zustand.aufrufe.some((a) => a[0] === 'POST'));
  assert.deepEqual(plain(f.zustand.aufrufe.filter((a) => a[0] === 'POST')[0]), ['POST', '/api/freigaben/f1', { entscheidung: 'erteilt', von: 'mensch', notiz: 'Nur in der Testumgebung.' }]);
  await bis(() => f.karten().length === 2);
  // leer oder nur Leerraum: kein Feld notiz
  tippe(f.w, feld('f2'), '   ');
  knopfIn(f, 'f2', 'Ablehnen').click();
  await bis(() => f.zustand.aufrufe.filter((a) => a[0] === 'POST').length === 2);
  assert.deepEqual(plain(f.zustand.aufrufe.filter((a) => a[0] === 'POST')[1][2]), { entscheidung: 'abgelehnt', von: 'mensch' });
  await bis(() => f.karten().length === 1);
  // länger als 500 (z. B. eingefügt am Feld vorbei): die Hülle kürzt selbst
  tippe(f.w, feld('f3'), 'a'.repeat(700));
  knopfIn(f, 'f3', 'Ablehnen').click();
  await bis(() => f.zustand.aufrufe.filter((a) => a[0] === 'POST').length === 3);
  assert.equal(f.zustand.aufrufe.filter((a) => a[0] === 'POST')[2][2].notiz.length, 500);
});

dom('Freigaben: eine getippte Notiz überlebt das Neuzeichnen (neue Abfrage) und „Später“; nach der Entscheidung ist sie weg', async () => {
  const f = freigabenMit([fg('f1', 1)]);
  await f.fp.lade();
  f.fp.zeige(true);
  tippe(f.w, f.d.querySelector('.fp-notiz'), 'erst prüfen');
  f.zustand.liste = [fg('f1', 1, { aktion: 'Aktion geändert' }), fg('f2', 2)];
  await f.fp.lade(); // andere Liste: die Karten werden neu gebaut
  assert.equal(f.d.querySelector('.fp-karte[data-id="f1"] .fp-aktion').textContent, 'Aktion geändert');
  assert.equal(f.d.querySelector('.fp-karte[data-id="f1"] .fp-notiz').value, 'erst prüfen');
  assert.equal(f.d.querySelector('.fp-karte[data-id="f2"] .fp-notiz').value, '');
  f.d.querySelector('.fp-karte[data-id="f1"] .fp-spaeter').click();
  f.d.querySelector('.fp-karte[data-id="f1"] .fp-jetzt').click();
  assert.equal(f.d.querySelector('.fp-karte[data-id="f1"] .fp-notiz').value, 'erst prüfen');
});

dom('Freigaben: zerstörerisch fragt zweimal („Wirklich erlauben“), Ablehnen und nicht zerstörerisch fragen nicht; „Zurück“ nimmt die Nachfrage zurück', async () => {
  const f = freigabenMit([fg('f1', 1, { zerstoererisch: true, risiko: 'high' }), fg('f2', 2)]);
  await f.fp.lade();
  f.fp.zeige(true);
  const posts = () => f.zustand.aufrufe.filter((a) => a[0] === 'POST');
  tippe(f.w, f.d.querySelector('.fp-karte[data-id="f1"] .fp-notiz'), 'bewusst');
  knopfIn(f, 'f1', 'Erlauben').click();
  assert.equal(posts().length, 0, 'der erste Klick sendet nichts');
  assert.deepEqual([...f.d.querySelectorAll('.fp-karte[data-id="f1"] .fp-knoepfe button')].map((b) => b.textContent), ['Wirklich erlauben', 'Ablehnen', 'Zurück']);
  assert.match(f.d.querySelector('.fp-karte[data-id="f1"] .fp-warnung').textContent, /zerstörerisch/);
  assert.equal(f.d.activeElement.textContent, 'Wirklich erlauben', 'der Fokus steht auf der zweiten Bestätigung');
  assert.equal(f.d.querySelector('.fp-karte[data-id="f1"] .fp-notiz').value, 'bewusst', 'die Notiz bleibt');
  // eine neue Abfrage nimmt die Nachfrage nicht weg
  await f.fp.lade();
  assert.ok(knopfIn(f, 'f1', 'Wirklich erlauben'));
  // Zurück
  knopfIn(f, 'f1', 'Zurück').click();
  assert.deepEqual([...f.d.querySelectorAll('.fp-karte[data-id="f1"] .fp-knoepfe button')].map((b) => b.textContent), ['Erlauben', 'Ablehnen', 'Später']);
  assert.equal(f.d.querySelector('.fp-karte[data-id="f1"] .fp-warnung'), null);
  assert.equal(posts().length, 0);
  // zweimal: genau ein POST
  knopfIn(f, 'f1', 'Erlauben').click();
  knopfIn(f, 'f1', 'Wirklich erlauben').click();
  await bis(() => posts().length === 1);
  assert.deepEqual(plain(posts()[0]), ['POST', '/api/freigaben/f1', { entscheidung: 'erteilt', von: 'mensch', notiz: 'bewusst' }]);
  await bis(() => f.karten().length === 1);
  // nicht zerstörerisch: ein Klick genügt
  knopfIn(f, 'f2', 'Erlauben').click();
  await bis(() => posts().length === 2);
  assert.equal(posts()[1][2].entscheidung, 'erteilt');
});

dom('Freigaben: Ablehnen einer zerstörerischen Freigabe braucht keine zweite Bestätigung', async () => {
  const f = freigabenMit([fg('f1', 1, { zerstoererisch: true })]);
  await f.fp.lade();
  f.fp.zeige(true);
  knopfIn(f, 'f1', 'Ablehnen').click();
  await bis(() => f.zustand.aufrufe.some((a) => a[0] === 'POST'));
  assert.equal(f.zustand.aufrufe.find((a) => a[0] === 'POST')[2].entscheidung, 'abgelehnt');
});

dom('Freigaben: Banner „Eine Freigabe wartet“ / „N Freigaben warten“ nur bei offener Freigabe und geschlossenem Panel; Klick öffnet das Panel', async () => {
  const f = freigabenMit([fg('f1', 1)]);
  assert.equal(f.g('ba').hidden, true, 'vor dem Laden');
  await f.fp.lade();
  assert.equal(f.g('ba').hidden, false);
  assert.equal(f.g('ba').textContent, 'Eine Freigabe wartet');
  f.zustand.liste = [fg('f1', 1), fg('f2', 2), fg('f3', 3, { status: 'erteilt' })];
  await f.fp.lade();
  assert.equal(f.g('ba').textContent, '2 Freigaben warten');
  f.g('ba').click();
  assert.equal(f.g('pa').hidden, false, 'der Klick öffnet das Panel');
  assert.equal(f.g('ba').hidden, true, 'bei offenem Panel kein Banner');
  f.g('zu').click();
  assert.equal(f.g('ba').hidden, false, 'nach dem Schließen wartet das Banner wieder');
  f.zustand.liste = [];
  await f.fp.lade();
  assert.equal(f.g('ba').hidden, true, 'nichts offen: kein Banner');
});

dom('Freigaben: eine Freigabe-Zeile im Aktivitätsstrom (/api/strom) aktualisiert Zahl und Banner sofort, ohne auf das Abfragen zu warten; andere Zeilen nicht', async () => {
  const f = freigabenMit([], { intervallMs: 0 });
  await f.fp.lade();
  assert.equal(f.g('za').textContent, '0');
  const gets = () => f.zustand.aufrufe.filter((a) => a[0] === 'GET').length;
  const vorher = gets();
  f.zustand.liste = [fg('f1', 1)];
  assert.equal(f.fp.beiStromZeile({ typ: 'sagt', gespraech: 1, text: 'Hallo' }), false);
  assert.equal(f.fp.beiStromZeile(null), false);
  assert.equal(gets(), vorher, 'andere Zeilen holen nichts');
  assert.equal(f.fp.beiStromZeile({ typ: 'freigabe', gespraech: 1, text: 'wartet auf Freigabe: Aktion f1' }), true);
  await bis(() => f.g('za').textContent === '1');
  assert.equal(gets(), vorher + 1);
  assert.equal(f.g('ba').hidden, false);
  // Entscheidung anderswo (Zeile „Freigabe erteilt“): die Zahl fällt sofort
  f.zustand.liste = [fg('f1', 1, { status: 'erteilt' })];
  f.fp.beiStromZeile({ typ: 'freigabe', gespraech: 1, text: 'Freigabe erteilt (f1)' });
  await bis(() => f.g('za').textContent === '0');
  assert.equal(f.g('ba').hidden, true);
});

test('Freigaben-Panel: eingebunden in chat.js (Sprung = wechsle, Strom, Tray-Ereignis) und neutral formuliert (Quelltext-Prüfung)', () => {
  const chat = lies('chat.js');
  assert.match(chat, /FP\.createFreigaben\(/);
  assert.match(chat, /beiSprung: \(id\) => wechsle\(id\)/, 'der Sprung nutzt den Sitzungswechsel der Leiste (kein Neuaufbau der Ansichten)');
  assert.match(chat, /freigaben\.beiStromZeile\(p\.daten\)/, 'eine neue Freigabe im Aktivitätsstrom lädt die Liste sofort');
  assert.match(chat, /banner: \$\('freigabenBanner'\)/, 'das Banner gehört zum Panel');
  assert.match(chat, /listen\('freigaben-zeigen'/, 'Tray-Zeile öffnet das Panel');
  assert.match(chat, /i\.freigaben_zeigen/, 'neu geöffnetes Fenster holt das Flag mit ziel_info');
  assert.match(chat, /beiFreigaben: \(liste\) => freigaben\.setze\(liste\)/, 'Entscheidung in der Verlaufskarte zieht das Panel nach');
  const html = lies('chat.html');
  for (const id of ['freigabenKnopf', 'freigabenZahl', 'freigabenPanel', 'freigabenListe', 'freigabenZu', 'freigabenHinweis', 'freigabenBanner']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes('src="freigaben.js"') && html.includes('href="freigaben.css"'));
  const eigene = lies('freigaben.js') + lies('freigaben.css') + html;
  // die Namen stehen hier zerlegt, damit der Export-Scan diese Datei nicht selbst trifft
  const verboten = new RegExp(['gin', 'ny|perse', 'phone|ti', 'tan|rh', 'ea|sirf', 'yyn'].join(''), 'i');
  assert.ok(!verboten.test(eigene), 'kein Agenten- oder Rechnername im Quelltext des Panels');
  // einziger Schreibweg: die Entscheidung über den Weg der Altfassung und der Verlaufskarten
  assert.equal((lies('freigaben.js').match(/'POST'/g) || []).length, 1);
  assert.ok(lies('freigaben.js').includes("`/api/freigaben/${encodeURIComponent(id)}`") && lies('freigaben.js').includes("'/api/freigaben'"));
});

// --- Einstellungen: zwei Adressen je Runner (Rückfalladresse) ---
const OBERFLAECHE = path.join(HIER, '..', 'app', 'ui');

/** Die echte Seite index.html mit agent-einstellungen.js; `antworten[name]` ist eine Funktion (Argumente) -> Antwort oder null (= Fehler gezeigt). */
function einstellungen(antworten) {
  const html = fs.readFileSync(path.join(OBERFLAECHE, 'index.html'), 'utf8');
  const d = new jsdom.JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  d.window.eval(fs.readFileSync(path.join(OBERFLAECHE, 'agent-einstellungen.js'), 'utf8'));
  const aufrufe = [];
  const aufruf = async (name, args) => {
    aufrufe.push([name, plain(args || {})]);
    const f = antworten[name];
    return f ? f(args || {}) : null;
  };
  d.window.FyosAgentEinstellungen.start(aufruf, () => ({}), aufruf);
  const g = (id) => d.window.document.getElementById(id);
  return { d, g, aufrufe, aufruf, E: d.window.FyosAgentEinstellungen, ende: () => d.window.close() };
}

dom('Einstellungen: unter „Adresse“ steht das Feld „Rückfalladresse (optional)“ mit Hilfetext', () => {
  const e = einstellungen({});
  try {
    const f = e.g('a-adresse2');
    assert.ok(f, 'Feld a-adresse2');
    assert.match(f.getAttribute('aria-label'), /Rückfalladresse/);
    assert.equal(f.getAttribute('placeholder'), 'Rückfalladresse (optional)');
    const hilfe = e.g('a-adresse2-hilfe').textContent;
    assert.match(hilfe, /^z\. B\. der \w+-Name, damit der Runner auch unterwegs erreichbar ist$/);
    assert.equal(f.getAttribute('aria-describedby'), 'a-adresse2-hilfe');
    // Reihenfolge: Adresse, dann Rückfalladresse, dann Token
    const pos = (a, b) => e.g(a).compareDocumentPosition(e.g(b)) & e.d.window.Node.DOCUMENT_POSITION_FOLLOWING;
    assert.ok(pos('a-adresse', 'a-adresse2') && pos('a-adresse2', 'a-token'));
  } finally {
    e.ende();
  }
});

dom('Einstellungen: Speichern schickt adresse2 (getrimmt, leer = keine), Fehler lassen das Formular stehen', async () => {
  let antwort = { runner: [{ id: 'x', name: 'X', art: 'entfernt', adresse: 'http://heim:1', adresse2: 'http://fern:1', hat_token: true }] };
  const e = einstellungen({ runner_speichern: () => antwort, runner_liste: () => antwort, lokaler_runner_status: () => null });
  try {
    e.g('a-adresse').value = 'heim:1';
    e.g('a-adresse2').value = '  fern:1  ';
    e.g('a-speichern').click();
    await new Promise((r) => setTimeout(r, 20));
    const s = e.aufrufe.find((a) => a[0] === 'runner_speichern');
    assert.equal(s[1].adresse, 'heim:1');
    assert.equal(s[1].adresse2, 'fern:1');
    assert.equal(e.g('a-adresse2').value, '', 'nach dem Speichern ist das Formular leer');
    assert.match(e.g('r-liste').textContent, /X \(http:\/\/heim:1, Rückfall http:\/\/fern:1\)/);
    // leere Rückfalladresse: null (die Brücke speichert dann keine)
    e.g('a-adresse').value = 'heim:1';
    e.g('a-adresse2').value = '   ';
    e.g('a-speichern').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(e.aufrufe.filter((a) => a[0] === 'runner_speichern')[1][1].adresse2, null);
    // Katalogfehler (aufruf liefert null und zeigt die Meldung selbst): nichts wird geleert
    antwort = null;
    e.g('a-adresse').value = 'http://runner.example.org';
    e.g('a-adresse2').value = 'http://runner.example.org';
    e.g('a-speichern').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(e.g('a-adresse2').value, 'http://runner.example.org');
    assert.equal(e.g('a-adresse').value, 'http://runner.example.org');
  } finally {
    e.ende();
  }
});

dom('Einstellungen: Ändern füllt die Rückfalladresse ein; Prüfen meldet, ob sie antwortet', async () => {
  const r = { id: 'x', name: 'X', art: 'entfernt', adresse: 'http://heim:1', adresse2: 'http://fern:1', hat_token: true };
  let pruef = { ok: true, adresse: 'http://heim:1', zweite: { adresse: 'http://fern:1', ok: true } };
  const e = einstellungen({ agent_verbindung_pruefen: () => pruef });
  try {
    e.E.zeichneListe({ runner: [r] });
    [...e.g('r-liste').querySelectorAll('button')].find((b) => b.textContent === 'Ändern').click();
    assert.equal(e.g('a-adresse').value, 'http://heim:1');
    assert.equal(e.g('a-adresse2').value, 'http://fern:1');
    e.g('a-pruefen').click();
    await new Promise((x) => setTimeout(x, 20));
    const p = e.aufrufe.find((a) => a[0] === 'agent_verbindung_pruefen');
    assert.equal(p[1].adresse2, 'http://fern:1', 'das Formular gilt, nicht die gespeicherte Adresse');
    assert.match(e.g('a-text').textContent, /Verbindung steht\..*Rückfalladresse antwortet auch/);
    pruef = { ok: true, adresse: 'http://heim:1', zweite: { adresse: 'http://fern:1', ok: false } };
    e.g('a-pruefen').click();
    await new Promise((x) => setTimeout(x, 20));
    assert.match(e.g('a-text').textContent, /Rückfalladresse antwortet nicht/);
    // ohne zweite Adresse bleibt die Meldung wie früher
    pruef = { ok: true, adresse: 'http://heim:1', zweite: null };
    e.g('a-pruefen').click();
    await new Promise((x) => setTimeout(x, 20));
    assert.equal(e.g('a-text').textContent, 'Verbindung steht.');
    // „Neuer Runner“ leert auch die Rückfalladresse
    e.g('a-neu').click();
    assert.equal(e.g('a-adresse2').value, '');
  } finally {
    e.ende();
  }
});

test('Runner-Auswahl im Chat-Fenster zeigt den Namen, nie eine Adresse (Quelltext-Prüfung)', () => {
  const chat = lies('chat.js');
  assert.match(chat, /o\.textContent = r\.art === 'lokal' \? `\$\{r\.name\} \(lokal\)` : r\.name;/);
  assert.ok(!/adresse/i.test(chat), 'chat.js liest keine Adresse');
});

// --- Einstellungen im Chat-Fenster (Knopf, Cmd+,) -------------------------------------------------------------------------------------

test('Einstellungen-Knopf: eigener Befehl ohne Argumente, nur im Chat-Fenster erlaubt, Knopf mit Titel und Beschriftung (Quelltext-Prüfung)', () => {
  const html = lies('chat.html');
  const knopf = /<button id="einstellungenKnopf"[^>]*>/.exec(html);
  assert.ok(knopf, 'Knopf in chat.html');
  assert.match(knopf[0], /title="[^"]*Einstellungen[^"]*"/);
  assert.match(knopf[0], /aria-label="Einstellungen öffnen"/);
  const chat = lies('chat.js');
  assert.match(chat, /tauriInvoke\('einstellungen_oeffnen'\)/, 'der Befehl wird ohne Argumente aufgerufen');
  const caps = fs.readFileSync(path.join(HIER, '..', 'app', 'capabilities', 'agent-chat.json'), 'utf8');
  assert.match(caps, /"allow-einstellungen-oeffnen"/);
  const haupt = fs.readFileSync(path.join(HIER, '..', 'app', 'capabilities', 'agent-haupt.json'), 'utf8');
  assert.ok(!/einstellungen-oeffnen/.test(haupt), 'die Einstellungen selbst brauchen den Befehl nicht');
});

dom('Einstellungen-Knopf: ein Klick ruft einstellungen_oeffnen (ohne Argumente) auf; ein Fehler steht als Meldung da', async () => {
  let fehler = null;
  const { d, st, g, schliesse } = arbeitsplatz({ tauri: (b) => (b === 'einstellungen_oeffnen' && fehler ? fehler : undefined) });
  try {
    await bis(() => d.querySelectorAll('#sitzungsliste .sitzung').length === 2);
    assert.equal(g('einstellungenKnopf').hidden, false);
    assert.equal(g('einstellungenKnopf').title.includes('Einstellungen'), true);
    g('einstellungenKnopf').click();
    await bis(() => st.tauri.some(([b]) => b === 'einstellungen_oeffnen'));
    assert.deepEqual(Object.keys(st.tauri.find(([b]) => b === 'einstellungen_oeffnen')[1]), [], 'keine Argumente von der Seite');
    assert.equal(g('einstellungenFehler').hidden, true);
    fehler = { ursache: 'Fenster nicht zu öffnen.', abhilfe: 'Neu starten.' };
    g('einstellungenKnopf').click();
    await bis(() => !g('einstellungenFehler').hidden);
    assert.match(g('einstellungenFehler').textContent, /Einstellungen lassen sich nicht öffnen: Fenster nicht zu öffnen\./);
  } finally {
    schliesse();
  }
});

dom('Einstellungen: Cmd+, und Strg+, öffnen sie; Umschalt+Cmd+, und ein bloßes Komma nicht', async () => {
  const { w, d, st, g, schliesse } = arbeitsplatz({ tauri: () => undefined });
  try {
    await bis(() => d.querySelectorAll('#sitzungsliste .sitzung').length === 2);
    const zahl = () => st.tauri.filter(([b]) => b === 'einstellungen_oeffnen').length;
    taste(w, d.body, ',', { metaKey: true });
    await bis(() => zahl() === 1);
    taste(w, d.body, ',', { ctrlKey: true });
    await bis(() => zahl() === 2);
    taste(w, d.body, ',', { metaKey: true, shiftKey: true });
    taste(w, d.body, ',');
    taste(w, d.body, ',', { metaKey: true, altKey: true });
    await new Promise((x) => setTimeout(x, 30));
    assert.equal(zahl(), 2);
  } finally {
    schliesse();
  }
});

dom('Einstellungen-Knopf: im Browser-Prüfstand ohne Anwendung (keine Brücke) ist er versteckt', async () => {
  const { d, g, schliesse } = arbeitsplatz();
  try {
    await bis(() => d.querySelectorAll('#sitzungsliste .sitzung').length === 2);
    assert.equal(g('einstellungenKnopf').hidden, true);
  } finally {
    schliesse();
  }
});

// --- Kontextanzeige --------------------------------------------------------------------------------------------------------------------

// Gemeldete Anzeige vom 30.10.2026 (Sitzung „Hauptgespräch“): „100 % Kontext 9729,4k von 128k · 193038,2k ein · 2121,5k aus ≈ 0,00 €“. Das UsageDoc des Runners
// ist die Lebenszeit-Summe je Modell: input 9,7 Mio., input + cacheRead 193,0 Mio., output 2,1 Mio.
const MAX_USAGE = { models: { 'rhea/rhea': { input: 9729400, output: 2121500, cacheRead: 183308800, cacheWrite: 0, totalTokens: 195159700, cost: { total: 0 } } }, tools: {} };
const antwortMit = (id, usage) => ({ id, kind: 'pi.message', model: [{ role: 'assistant', content: [{ type: 'text', text: `Antwort ${id}` }], usage, stopReason: 'stop', timestamp: 1000 + id }] });
const frage = (id) => ({ id, kind: 'pi.message', model: [{ role: 'user', content: [{ type: 'text', text: `Frage ${id}` }], timestamp: 900 + id }] });
const nutzung = (input, cacheRead, output) => ({ input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost: { total: 0 } });

test('Kontextanzeige (rein): die gemeldeten Zahlen sind kein Kontext; gezeigt wird nur ein Wert, der ins Fenster passt', () => {
  const FP = { zahlK: (n) => (n >= 1000 ? `${(Math.round(n / 100) / 10).toString().replace('.', ',')}k` : String(n)) };
  const w = { FyosPrototyp: FP };
  new Function('window', 'globalThis', lies('echt.js'))(w, w);
  // das UsageDoc liefert nur Summen: ctx bleibt unbekannt
  const sicht = FP.usageSicht(MAX_USAGE);
  assert.equal(sicht.ctx, null);
  assert.equal(sicht.tokIn, 193038200);
  assert.equal(sicht.tokOut, 2121500);
  // unmöglich: 9,7 Mio. bei 128k Fenster -> „–“, nie „100 %“
  const unmoeglich = FP.kontextAnzeige(9729400, 128000);
  assert.equal(unmoeglich.bekannt, false);
  assert.equal(unmoeglich.text, '–');
  assert.match(unmoeglich.titel, /über dem Fenster/);
  // plausibel
  const ok = FP.kontextAnzeige(64000, 128000);
  assert.deepEqual([ok.bekannt, ok.text, ok.prozent, ok.stufe], [true, '50 %', 50, 'ok']);
  assert.equal(FP.kontextAnzeige(110000, 128000).stufe, 'warn');
  assert.equal(FP.kontextAnzeige(125000, 128000).stufe, 'kritisch');
  assert.equal(FP.kontextAnzeige(128000, 128000).text, '100 %', 'genau voll ist möglich');
  // unbekannt oder unsinnig
  for (const schlecht of [null, undefined, NaN, -5, '12']) assert.equal(FP.kontextAnzeige(schlecht, 128000).text, '–', String(schlecht));
  // ohne Fenster: nur die Zahl
  assert.equal(FP.kontextAnzeige(5000, null).text, '5k');
});

test('Kontext aus der letzten Antwort: totalTokens, sonst die Summe der Teile; Nullen (Abbruch) und Unsinn ergeben nichts', () => {
  const w = { FyosPrototyp: {} };
  new Function('window', 'globalThis', lies('runner-adapter.js'))(w, w);
  const k = w.FyosPrototyp.kontextAusNutzung;
  assert.equal(k({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 100 }), 100);
  assert.equal(k({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }), 10);
  for (const leer of [null, undefined, {}, { input: 0, output: 0, totalTokens: 0 }, 'x', { totalTokens: NaN }]) assert.equal(k(leer), null);
});

dom('Statuszeile: die gemeldete Sitzung (Summe 9,7 Mio. / 193 Mio.) zeigt „–“ statt „100 %“, wenn die letzte Antwort unmögliche Werte trägt; die Summen heißen „gesamt“', async () => {
  const { d, g, schliesse } = arbeitsplatz({ ansicht: () => ({ entries: [frage(1), antwortMit(2, nutzung(9729400, 0, 100))], usage: MAX_USAGE }) });
  try {
    await bis(() => /gesamt/.test(g('tokens').textContent));
    assert.equal(g('kontextText').textContent, '–');
    assert.equal(g('kontext').dataset.bekannt, '0');
    assert.ok(!/100 %/.test(d.body.textContent) && !/9729/.test(d.body.textContent), 'weder „100 %“ noch 9729,4k');
    assert.match(g('tokens').textContent, /^gesamt 193 M ein · 2,1 M aus$/);
    assert.match(g('tokens').title, /Summe der ganzen Sitzung/);
    assert.match(g('kontext').title, /über dem Fenster/);
  } finally {
    schliesse();
  }
});

dom('Statuszeile: dieselbe Sitzung mit plausibler letzter Antwort zeigt die Füllung dieser Antwort (nicht die Summe)', async () => {
  const { g, schliesse } = arbeitsplatz({ ansicht: () => ({ entries: [frage(1), antwortMit(2, nutzung(40000, 100000, 500)), frage(3), antwortMit(4, nutzung(3000, 60000, 500))], usage: MAX_USAGE }) });
  try {
    await bis(() => g('kontext').dataset.bekannt === '1');
    // 3000 + 60000 + 500 = 63,5k von 128k: die LETZTE Antwort, nicht die größte und nicht die Summe
    assert.equal(g('kontextText').textContent, '50 %');
    assert.equal(g('kontextTitel').textContent, 'Kontext 63,5k von 128k');
    assert.equal(g('kontext').getAttribute('aria-valuenow'), '50');
    assert.match(g('tokens').textContent, /gesamt 193 M ein/);
  } finally {
    schliesse();
  }
});

dom('Statuszeile: ohne Antwort im Verlauf (nur die Summe) und nach einem Marker (leeren, verdichten) steht „–“', async () => {
  const nur = arbeitsplatz({ ansicht: () => ({ entries: [frage(1)], usage: MAX_USAGE }) });
  try {
    await bis(() => /gesamt/.test(nur.g('tokens').textContent));
    assert.equal(nur.g('kontextText').textContent, '–');
    assert.equal(nur.g('kontext').dataset.bekannt, '0');
  } finally {
    nur.schliesse();
  }
  const marker = arbeitsplatz({ ansicht: () => ({ entries: [frage(1), antwortMit(2, nutzung(3000, 60000, 500)), { id: 3, kind: 'pi.reset', data: {} }], usage: MAX_USAGE }) });
  try {
    await bis(() => /gesamt/.test(marker.g('tokens').textContent));
    assert.equal(marker.g('kontextText').textContent, '–', 'nach dem Marker ist die alte Füllung weg');
  } finally {
    marker.schliesse();
  }
});

// --- Änderungen der Sitzung (aenderungen.js): Liste, Diff, Vorschau, Baum, Knopf, Tasten ---
const AE_HTML = '<!doctype html><body><div id="verlauf"><div id="spalte"></div></div><button id="ende" hidden></button><div id="ansage"></div>'
  + '<button id="kn" hidden>Änderungen (<b id="za">0</b>)</button>'
  + '<aside id="pa" hidden><button id="zu"></button><div id="re"><button id="rl" aria-selected="true"></button><button id="rb" aria-selected="false"></button></div><div id="in"></div></aside></body>';
const A_SKRIPTE = ['markdown-strom.js', 'terminal.js', 'chat-renderer.js', 'runner-adapter.js', 'aenderungen.js'];
const aufruf = (name, args, extra) => ({ id: `t${Math.random().toString(36).slice(2, 8)}`, name, args, status: 'fertig', ...extra });
const schreibe = (pfad, content) => aufruf('write', { path: pfad, content });
const aendere = (pfad, alt, neu) => aufruf('edit', { path: pfad, edits: [{ oldText: alt, newText: neu }] });
const lese = (pfad, output, args) => aufruf('read', { path: pfad, ...args }, { output });

function aenderungenMit(aufrufe, cwd = '/probe/standard') {
  const w = fenster(A_SKRIPTE, AE_HTML);
  const d = w.document;
  const g = (id) => d.getElementById(id);
  const ae = w.FyosPrototyp.createAenderungen({ knopf: g('kn'), zahl: g('za'), panel: g('pa'), zu: g('zu'), reiter: g('re'), reiterListe: g('rl'), reiterBaum: g('rb'), inhalt: g('in') });
  const f = { w, d, g, ae, cwd, sammle: (a) => plain(w.FyosPrototyp.aenderungen.sammle(a, cwd)) };
  f.setze = (a) => ae.setze(a, cwd, 's1');
  if (aufrufe) f.setze(aufrufe);
  return f;
}
const datei = (erg, pfad) => erg.dateien.find((x) => x.pfad === pfad);

dom('Änderungen: Liste aus den Werkzeugaufrufen, neu gegen geändert, mehrere Änderungen derselben Datei, Zähler', () => {
  const f = aenderungenMit();
  const erg = f.sammle([
    schreibe('/probe/standard/src/neu.js', 'eins\nzwei\ndrei\n'),
    aendere('/probe/standard/src/neu.js', 'zwei', 'zwei\nzwei-b'),
    lese('src/alt.js', 'a\nb\nc\n'),
    aendere('src/alt.js', 'b', 'B'),
    aendere('src/alt.js', 'c', 'C\nD'),
    aufruf('bash', { command: 'ls' }),
    aendere('src/nie.js', 'x', 'y', {}),
  ]);
  assert.deepEqual(erg.dateien.map((x) => x.pfad), ['src/neu.js', 'src/alt.js', 'src/nie.js'], 'relativ zum Arbeitsordner, in der Reihenfolge der ersten Änderung; bash zählt nicht');
  const neu = datei(erg, 'src/neu.js');
  assert.equal(neu.art, 'neu');
  assert.equal(neu.name, 'neu.js');
  assert.equal(neu.ordner, 'src');
  assert.deepEqual([neu.plus, neu.minus], [4, 0], 'eine neue Datei zählt ihren heutigen Inhalt: 4 Zeilen, nichts entfernt');
  assert.equal(neu.aenderungen, 2);
  const alt = datei(erg, 'src/alt.js');
  assert.equal(alt.art, 'geaendert');
  assert.equal(alt.aenderungen, 2);
  assert.equal(alt.hunks.length, 2, 'ein Hunk je Änderung, in der Reihenfolge');
  assert.deepEqual([alt.plus, alt.minus], [3, 2], 'B + C + D hinzugefügt, b + c entfernt');
  assert.equal(erg.beruehrt.length, 3);
});

dom('Änderungen: fehlgeschlagene Aufrufe zählen nicht, Pfade außerhalb des Arbeitsordners werden markiert, ein Schreiben gegen den bekannten Stand zeigt nur die Änderung', () => {
  const f = aenderungenMit();
  const erg = f.sammle([
    aufruf('edit', { path: 'a.txt', edits: [{ oldText: 'x', newText: 'y' }] }, { status: 'fehler' }),
    schreibe('/anderswo/b.txt', 'b\n'),
    lese('c.txt', 'eins\nzwei\ndrei\nvier\nfuenf\nsechs\nsieben\nacht\nneun\nzehn\n'),
    schreibe('c.txt', 'eins\nzwei\ndrei\nvier\nfuenf\nsechs\nsieben\nacht\nneun\nZEHN\n'),
  ]);
  assert.equal(datei(erg, 'a.txt'), undefined);
  const b = datei(erg, '/anderswo/b.txt');
  assert.equal(b.ausserhalb, true);
  const c = datei(erg, 'c.txt');
  assert.equal(c.art, 'geaendert', 'zuvor gelesen: das Schreiben ändert eine bestehende Datei');
  assert.deepEqual([c.plus, c.minus], [1, 1]);
  assert.equal(c.hunks.length, 1);
  assert.equal(c.hunks[0].alt, 8, 'Zeilennummer des Ausschnitts (2 Zeilen Kontext davor)');
  assert.ok(c.hunks[0].zeilen.length <= 6);
});

dom('Änderungen: Knopf „Änderungen (N)“ zählt Dateien, ist bei null versteckt und bleibt bei offenem Panel sichtbar', () => {
  const f = aenderungenMit();
  assert.equal(f.g('kn').hidden, true);
  f.setze([schreibe('a.txt', 'a\n')]);
  assert.equal(f.g('kn').hidden, false);
  assert.equal(f.g('za').textContent, '1');
  f.setze([schreibe('a.txt', 'a\n'), aendere('a.txt', 'a', 'b'), schreibe('b.txt', 'b\n'), lese('c.txt', 'c')]);
  assert.equal(f.g('za').textContent, '2', 'Dateien, nicht Aufrufe; nur Gelesenes zählt nicht');
  f.g('kn').click();
  assert.equal(f.g('pa').hidden, false);
  assert.equal(f.g('kn').getAttribute('aria-expanded'), 'true');
  f.ae.setze([], f.cwd, 's1');
  assert.equal(f.g('kn').hidden, false, 'bei offenem Panel bleibt der Knopf, damit man es schließen kann');
  assert.match(f.g('in').textContent, /noch keine Dateien geändert/);
  f.g('zu').click();
  assert.equal(f.g('kn').hidden, true);
});

dom('Änderungen: Liste mit Name, Ordner, Art und +/−; der Diff je Datei klappt auf und zu (zusammengefasst über alle Änderungen)', () => {
  const f = aenderungenMit([
    schreibe('src/neu.js', 'eins\nzwei\n'),
    lese('src/alt.js', 'a\nb\nc\n'),
    aendere('src/alt.js', 'b', 'B'),
    aendere('src/alt.js', 'c', 'C\nD'),
  ]);
  f.ae.zeige(true);
  const zeilen = [...f.d.querySelectorAll('.ae-datei')];
  assert.equal(zeilen.length, 2);
  assert.equal(zeilen[0].querySelector('.ae-dname').textContent, 'neu.js');
  assert.equal(zeilen[0].querySelector('.ae-dordner').textContent, 'src');
  assert.equal(zeilen[0].querySelector('.ae-art').textContent, 'neu');
  assert.equal(zeilen[1].querySelector('.ae-art').textContent, 'geändert');
  assert.match(zeilen[1].querySelector('.diffzahl').textContent, /\+3\s+−2/);
  assert.equal(f.d.querySelector('.ae-diff'), null, 'Diffs sind eingeklappt');
  zeilen[1].querySelector('.ae-auf').click();
  const diff = f.d.querySelector('.ae-datei[data-pfad="src/alt.js"] .diff');
  assert.ok(diff, 'Diff aufgeklappt');
  assert.equal(diff.querySelector('.datei').textContent, 'src/alt.js');
  assert.equal(diff.querySelectorAll('tr.add').length, 3);
  assert.equal(diff.querySelectorAll('tr.del').length, 2);
  assert.equal(diff.querySelectorAll('tr.trenn').length, 1, 'zwei Änderungen, getrennt');
  assert.equal(f.d.querySelector('.ae-auf.offen').getAttribute('aria-expanded'), 'true');
  f.d.querySelector('.ae-datei[data-pfad="src/alt.js"] .ae-auf').click();
  assert.equal(f.d.querySelector('.ae-diff'), null, 'wieder eingeklappt');
  // die neue Datei: lauter hinzugefügte Zeilen
  f.d.querySelector('.ae-datei[data-pfad="src/neu.js"] .ae-auf').click();
  const neu = f.d.querySelector('.ae-datei[data-pfad="src/neu.js"] .diff');
  assert.equal(neu.querySelectorAll('tr.add').length, 2);
  assert.equal(neu.querySelectorAll('tr.del').length, 0);
});

dom('Änderungen: Dateivorschau mit Zeilennummern; der Stand folgt den späteren Bearbeitungen; Zurück führt zur Liste', () => {
  const f = aenderungenMit([schreibe('n.txt', 'eins\nzwei\ndrei\n'), aendere('n.txt', 'zwei', 'ZWEI')]);
  f.ae.zeige(true);
  f.d.querySelector('.ae-name').click();
  assert.equal(f.ae.modus, 'vorschau');
  assert.equal(f.g('re').hidden, true, 'Reiter in der Vorschau weg');
  const zeilen = [...f.d.querySelectorAll('.ae-code tr')].map((tr) => [tr.querySelector('.nr').textContent, tr.querySelector('.code').textContent]);
  assert.deepEqual(zeilen, [['1', 'eins'], ['2', 'ZWEI'], ['3', 'drei']]);
  assert.match(f.d.querySelector('.ae-quelle').textContent, /geschrieben/);
  f.d.querySelector('.ae-zurueck').click();
  assert.equal(f.ae.modus, 'liste');
  assert.equal(f.d.activeElement.className, 'ae-name', 'der Fokus kehrt zum Dateinamen zurück');
});

dom('Änderungen: Vorschau aus dem letzten Lesen, Binärdatei, unbekannter Inhalt und Größenlimit', () => {
  const f = aenderungenMit([lese('l.txt', 'lesen\n'), aendere('l.txt', 'lesen', 'gelesen'), aendere('ohne.txt', 'a', 'b'), schreibe('bild.bin', 'PNG\u0000\u0001\u0002ä'), schreibe('gross.txt', Array.from({ length: 2500 }, (_, i) => `z${i}`).join('\n'))]);
  f.ae.zeige(true);
  f.ae.oeffneVorschau('l.txt');
  assert.equal(f.d.querySelector('.ae-code .code').textContent, 'gelesen');
  assert.match(f.d.querySelector('.ae-quelle').textContent, /Lesen/);
  f.d.querySelector('.ae-zurueck').click();
  f.ae.oeffneVorschau('ohne.txt');
  assert.match(f.d.querySelector('.ae-fehlt').textContent, /nicht verfügbar/);
  assert.match(f.d.querySelector('.ae-fehlt').textContent, /keinen Weg/);
  f.d.querySelector('.ae-zurueck').click();
  f.ae.oeffneVorschau('bild.bin');
  assert.equal(f.d.querySelector('.ae-binaer').textContent, 'Binärdatei, 8 Byte');
  assert.equal(f.d.querySelector('.ae-code'), null, 'kein Inhalt einer Binärdatei');
  f.d.querySelector('.ae-zurueck').click();
  f.ae.oeffneVorschau('gross.txt');
  assert.equal(f.d.querySelectorAll('.ae-code tr').length, 2000);
  assert.match(f.d.querySelector('.ae-quelle').textContent, /Gekürzt/);
  // Diff einer großen neuen Datei: Zähler für die ganze Datei, gezeigt werden 400 Zeilen
  f.d.querySelector('.ae-zurueck').click();
  f.ae.schalteDiff('gross.txt');
  const diff = f.d.querySelector('.ae-datei[data-pfad="gross.txt"] .diff');
  assert.equal(diff.querySelectorAll('tr.add').length, 400);
  assert.match(diff.querySelector('.diffzahl').textContent, /\+2500/);
  assert.match(diff.querySelector('tr.trenn').textContent, /2100 weitere Zeilen/);
});

dom('Änderungen: ein Lese-Ergebnis in der Größe der Kürzungsgrenze des Werkzeugs (2000 Zeilen, 50 KB) und ein teilweises Lesen gelten nicht als Stand der Datei', () => {
  const f = aenderungenMit([
    lese('lang.txt', Array.from({ length: 2000 }, (_, i) => `z${i}`).join('\n')),
    aendere('lang.txt', 'z1', 'Z1'),
    lese('teil.txt', 'ab Zeile 5', { offset: 5 }),
    aendere('teil.txt', 'ab', 'AB'),
  ]);
  f.ae.zeige(true);
  assert.equal(datei({ dateien: f.ae.dateien() }, 'lang.txt').inhalt, null);
  assert.equal(datei({ dateien: f.ae.dateien() }, 'teil.txt').inhalt, null);
  f.ae.oeffneVorschau('lang.txt');
  assert.match(f.d.querySelector('.ae-fehlt').textContent, /nicht verfügbar/);
});

dom('Änderungen: unlesbarer Inhalt wird nur als Text eingesetzt (kein HTML)', () => {
  const f = aenderungenMit([schreibe('<img src=x onerror=alert(1)>.html', '<script>x</script>\n<b>fett</b>\n')]);
  f.ae.zeige(true);
  f.ae.schalteDiff('<img src=x onerror=alert(1)>.html');
  f.ae.oeffneVorschau('<img src=x onerror=alert(1)>.html');
  assert.equal(f.d.querySelectorAll('#in img, #in script, #in b').length, 0, 'nichts davon wurde zu einem Element');
  assert.match(f.d.querySelector('.ae-code').textContent, /<script>x<\/script>/);
});

dom('Änderungen: Dateibaum aus den berührten Dateien mit aufklappbaren Ordnern, Marken und Sprung in die Vorschau', () => {
  const f = aenderungenMit([schreibe('src/a/neu.js', 'x\n'), lese('src/b.js', 'b'), aendere('src/b.js', 'b', 'c'), lese('README.md', 'text'), schreibe('/anderswo/x.txt', 'x')]);
  f.ae.zeige(true);
  f.g('rb').click();
  assert.equal(f.ae.modus, 'baum');
  assert.equal(f.g('rb').getAttribute('aria-selected'), 'true');
  const baumTexte = [...f.d.querySelectorAll('.ae-knoten')].map((b) => `${b.dataset.ordner !== undefined ? 'O' : 'D'}:${b.querySelector('.ae-dname').textContent}`);
  assert.deepEqual(baumTexte, ['O:(außerhalb)', 'O:anderswo', 'D:x.txt', 'O:src', 'O:a', 'D:neu.js', 'D:b.js', 'D:README.md'], 'Ordner vor Dateien, alphabetisch');
  assert.equal(f.d.querySelector('.ae-knoten[data-datei="README.md"] .ae-art').textContent, 'gelesen');
  assert.equal(f.d.querySelector('.ae-knoten[data-datei="src/b.js"] .ae-art').textContent, 'geändert');
  assert.equal(f.d.querySelector('.ae-knoten[data-datei="src/a/neu.js"] .ae-art').textContent, 'neu');
  assert.match(f.d.querySelector('.ae-fuss').textContent, /nicht als Dateiliste/);
  // Ordner zuklappen
  f.d.querySelector('.ae-knoten[data-ordner="src/a"]').click();
  assert.equal(f.d.querySelector('.ae-knoten[data-datei="src/a/neu.js"]'), null);
  f.d.querySelector('.ae-knoten[data-ordner="src/a"]').click();
  assert.ok(f.d.querySelector('.ae-knoten[data-datei="src/a/neu.js"]'));
  // Datei anklicken: Vorschau; Zurück kehrt in den Baum zurück
  f.d.querySelector('.ae-knoten[data-datei="src/b.js"]').click();
  assert.equal(f.d.querySelector('.ae-code .code').textContent, 'c');
  f.d.querySelector('.ae-zurueck').click();
  assert.equal(f.ae.modus, 'baum');
});

dom('Änderungen: Tasten – Pfeile in der Liste, Enter öffnet den Diff, Umschalt+Enter die Vorschau, Esc geht zurück und schließt; die Tasten erreichen den Verlauf nicht', () => {
  const f = aenderungenMit([schreibe('a.txt', 'a\n'), schreibe('b.txt', 'b\n'), schreibe('c.txt', 'c\n')]);
  const amDokument = [];
  f.d.addEventListener('keydown', (e) => amDokument.push(e.key));
  f.g('kn').click();
  const namen = () => [...f.d.querySelectorAll('.ae-name')];
  assert.equal(f.d.activeElement, namen()[0], 'Öffnen setzt den Fokus in die Liste');
  taste(f.w, f.d.activeElement, 'ArrowDown');
  assert.equal(f.d.activeElement, namen()[1]);
  taste(f.w, f.d.activeElement, 'ArrowDown');
  taste(f.w, f.d.activeElement, 'ArrowDown');
  assert.equal(f.d.activeElement, namen()[2], 'am Ende ist Schluss');
  taste(f.w, f.d.activeElement, 'ArrowUp');
  assert.equal(f.d.activeElement, namen()[1]);
  taste(f.w, f.d.activeElement, 'Enter');
  assert.ok(f.d.querySelector('.ae-datei[data-pfad="b.txt"] .diff'), 'Enter öffnet den Diff');
  assert.equal(f.d.activeElement, namen()[1], 'der Fokus bleibt auf der Zeile');
  taste(f.w, f.d.activeElement, 'ArrowLeft');
  assert.equal(f.d.querySelector('.ae-diff'), null);
  taste(f.w, f.d.activeElement, 'Enter', { shiftKey: true });
  assert.equal(f.ae.modus, 'vorschau');
  assert.equal(f.d.querySelector('.ae-code .code').textContent, 'b');
  taste(f.w, f.d.activeElement, 'Escape');
  assert.equal(f.ae.modus, 'liste', 'Esc in der Vorschau führt zurück');
  assert.equal(f.g('pa').hidden, false);
  assert.equal(f.d.activeElement.dataset.fokus, 'name:b.txt');
  taste(f.w, f.d.activeElement, 'Escape');
  assert.equal(f.g('pa').hidden, true, 'Esc in der Liste schließt');
  assert.equal(f.d.activeElement, f.g('kn'));
  assert.deepEqual(amDokument, [], 'das Dokument (chat.js: Stopp, Freigabe-Tasten) hört nichts davon');
  // Tasten mit Cmd/Strg gehören weiter der Seite
  f.ae.zeige(true);
  taste(f.w, f.d.activeElement, 'b', { metaKey: true });
  assert.deepEqual(amDokument, ['b']);
});

dom('Änderungen: Tasten im Baum – Pfeile, Rechts/Links klappen Ordner, Enter öffnet die Vorschau', () => {
  const f = aenderungenMit([schreibe('o/a.txt', 'a\n'), schreibe('o/b.txt', 'b\n')]);
  f.ae.zeige(true);
  f.g('rb').click();
  f.d.querySelector('.ae-knoten').focus();
  assert.equal(f.d.activeElement.dataset.ordner, 'o');
  taste(f.w, f.d.activeElement, 'ArrowLeft');
  assert.equal(f.d.querySelectorAll('.ae-knoten').length, 1, 'zugeklappt');
  assert.equal(f.d.activeElement.dataset.ordner, 'o', 'Fokus bleibt');
  taste(f.w, f.d.activeElement, 'ArrowRight');
  assert.equal(f.d.querySelectorAll('.ae-knoten').length, 3);
  taste(f.w, f.d.activeElement, 'ArrowDown');
  taste(f.w, f.d.activeElement, 'ArrowDown');
  assert.equal(f.d.activeElement.dataset.datei, 'o/b.txt');
  f.d.activeElement.click();
  assert.equal(f.d.querySelector('.ae-code .code').textContent, 'b');
});

dom('Änderungen: eine andere Sitzung setzt Diffs, Vorschau und Baum zurück; gleiche Aufrufe zeichnen nichts neu', () => {
  const f = aenderungenMit([schreibe('a.txt', 'a\n')]);
  f.ae.zeige(true);
  f.ae.schalteDiff('a.txt');
  const diff = f.d.querySelector('.ae-diff');
  assert.equal(f.ae.setze([schreibe('a.txt', 'a\n')], f.cwd, 's1'), false, 'keine Änderung: kein Neuzeichnen');
  f.ae.oeffneVorschau('a.txt');
  f.ae.setze([schreibe('z.txt', 'z\n')], f.cwd, 's2');
  assert.equal(f.ae.modus, 'liste');
  assert.equal(f.d.querySelector('.ae-datei').dataset.pfad, 'z.txt');
  assert.equal(f.d.querySelector('.ae-diff'), null);
  assert.ok(diff);
});

// Die ganze Seite: Verlauf mit Werkzeugaufrufen laden, live ergänzen, Sitzung wechseln
const toolCall = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
const verlaufMit = (...schritte) => schritte.flatMap(([name, args, ergebnis, fehler], i) => [
  { id: 100 + i * 2, kind: 'pi.message', model: [{ role: 'assistant', content: [toolCall(`c${i}`, name, args)], stopReason: 'toolUse' }] },
  { id: 101 + i * 2, kind: 'pi.tool', model: [{ role: 'toolResult', toolCallId: `c${i}`, toolName: name, content: [{ type: 'text', text: ergebnis || 'ok' }], isError: !!fehler }] },
]);

dom('Seite: der Knopf zählt die geänderten Dateien aus dem Verlauf, das Panel zeigt Liste, Diff und Vorschau; neue Werkzeugergebnisse ziehen nach', async () => {
  const entries = verlaufMit(
    ['write', { path: '/probe/standard/neu.txt', content: 'a\nb\n' }],
    ['read', { path: 'src/x.js' }, 'eins\nzwei\n'],
    ['edit', { path: 'src/x.js', edits: [{ oldText: 'zwei', newText: 'zwei\ndrei' }] }],
    ['edit', { path: 'kaputt.js', edits: [{ oldText: 'a', newText: 'b' }] }, 'nicht gefunden', true],
  );
  const { w, d, g, schliesse } = arbeitsplatz({ ansicht: (id) => ({ entries: id === 1 ? entries : [] }) });
  try {
    await bis(() => !g('aenderungenKnopf').hidden);
    assert.equal(g('aenderungenZahl').textContent, '2', 'neu.txt und src/x.js; das fehlgeschlagene Bearbeiten zählt nicht');
    assert.match(g('aenderungenKnopf').textContent, /Änderungen \(2\)/);
    g('aenderungenKnopf').click();
    assert.equal(g('aenderungenPanel').hidden, false);
    const pfade = [...d.querySelectorAll('#aenderungenInhalt .ae-datei')].map((x) => x.dataset.pfad);
    assert.deepEqual(pfade, ['neu.txt', 'src/x.js'], 'Pfad relativ zum Arbeitsordner der Sitzung');
    d.querySelector('.ae-datei[data-pfad="src/x.js"] .ae-auf').click();
    assert.equal(d.querySelectorAll('.ae-datei[data-pfad="src/x.js"] tr.add').length, 1, 'nur „drei“ ist neu');
    d.querySelector('.ae-datei[data-pfad="src/x.js"] .ae-name').click();
    // der Runner dieses Speicher-Runners kennt /api/datei nicht (älterer Runner): die Vorschau fällt auf den Verlauf zurück
    await bis(() => d.querySelectorAll('.ae-code .code').length === 3);
    assert.deepEqual([...d.querySelectorAll('.ae-code .code')].map((x) => x.textContent), ['eins', 'zwei', 'drei'], 'Stand aus dem Lesen plus Bearbeiten');
    d.querySelector('.ae-zurueck').click();
    // live: ein weiteres Werkzeug der offenen Sitzung zu Ende
    const ad = w.__chat.adapter;
    ad.apply({ type: 'tool_execution_start', toolCallId: 'live1', toolName: 'write', args: { path: 'live.md', content: 'x\n' } });
    assert.equal(g('aenderungenZahl').textContent, '2', 'solange das Werkzeug läuft, zählt es nicht');
    ad.apply({ type: 'tool_execution_end', toolCallId: 'live1', toolName: 'write', entry: { id: 900, model: [{ role: 'toolResult', content: [{ type: 'text', text: 'ok' }], isError: false }] } });
    await bis(() => g('aenderungenZahl').textContent === '3');
    assert.ok(d.querySelector('.ae-datei[data-pfad="live.md"]'), 'die offene Liste zeichnet sich neu');
    // Panel und Freigaben-Panel sind getrennte Schubladen
    assert.equal(g('freigabenPanel').hidden, true);
    // Sitzungswechsel: die andere Sitzung hat keine Änderungen
    await w.__arbeitsplatz.wechsle(2);
    await bis(() => g('titel').textContent === 'Zweite');
    await bis(() => g('aenderungenZahl').textContent === '0');
    assert.match(d.querySelector('#aenderungenInhalt').textContent, /noch keine Dateien geändert/);
    g('aenderungenZu').click();
    assert.equal(g('aenderungenKnopf').hidden, true, 'bei null Änderungen ist der Knopf weg');
    await w.__arbeitsplatz.wechsle(1);
    await bis(() => g('aenderungenZahl').textContent === '3');
    assert.equal(g('aenderungenKnopf').hidden, false);
  } finally {
    schliesse();
  }
});

dom('Seite: Esc im Änderungen-Panel hält den laufenden Lauf nicht an; mit dem Freigaben-Panel liegen beide nebeneinander', async () => {
  const entries = verlaufMit(['write', { path: 'a.txt', content: 'a\n' }]);
  const { w, d, g, st, schliesse } = arbeitsplatz({ ansicht: () => ({ entries }) });
  try {
    await bis(() => !g('aenderungenKnopf').hidden);
    g('aenderungenKnopf').click();
    taste(w, d.activeElement, 'Escape');
    assert.equal(g('aenderungenPanel').hidden, true);
    assert.equal(st.aufrufe.filter((a) => /abbrechen/.test(a.url)).length, 0, 'kein Stopp');
    // Panels getrennt zu öffnen
    g('aenderungenKnopf').click();
    g('freigabenPanel').hidden = false;
    assert.equal(g('aenderungenPanel').hidden, false);
    assert.ok(lies('aenderungen.css').includes('.fp-panel:not([hidden]) ~ .ae-panel'), 'bei beiden offen rückt das Änderungen-Panel nach links');
    assert.ok(d.querySelector('#freigabenPanel').compareDocumentPosition(d.querySelector('#aenderungenPanel')) & 4, 'das Änderungen-Panel steht nach dem Freigaben-Panel');
  } finally {
    schliesse();
  }
});

test('Änderungen: eingebunden in chat.js, neutral formuliert, keine eigenen Wege zum Runner (Quelltext-Prüfung)', () => {
  const chat = lies('chat.js');
  assert.match(chat, /FP\.createAenderungen\(/);
  assert.match(chat, /beiWerkzeug: \(\) => \{\s*if \(aktiv === rec\) planeAenderungen\(\);/, 'jedes beendete Datei-Werkzeug der offenen Sitzung zieht das Panel nach');
  assert.match(chat, /aenderungen\.setze\(aktiv\.chat\.adapter\.aufrufe\(\), ordnerPfad\(aktiv\), aktiv\.id\)/);
  const html = lies('chat.html');
  for (const id of ['aenderungenKnopf', 'aenderungenZahl', 'aenderungenPanel', 'aenderungenZu', 'aenderungenReiter', 'aenderungenReiterListe', 'aenderungenReiterBaum', 'aenderungenInhalt']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes('src="aenderungen.js"') && html.includes('href="aenderungen.css"'));
  assert.ok(html.indexOf('src="chat-renderer.js"') < html.indexOf('src="aenderungen.js"') && html.indexOf('src="aenderungen.js"') < html.indexOf('src="chat.js"'));
  const eigen = lies('aenderungen.js');
  assert.ok(!/transport|fetch|XMLHttp|\/api\//.test(eigen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')), 'das Panel spricht nie selbst mit dem Runner: Datei und Dateiliste kommen über opts.datei und opts.ordner (chat.js)');
  assert.ok(!/innerHTML\s*=\s*(?!icon)/.test(eigen.replace(/e\.innerHTML = icon;[^\n]*/, '')), 'innerHTML nur für die festen Symbole');
  const verboten = new RegExp(['gin', 'ny|perse', 'phone|ti', 'tan|rh', 'ea|sirf', 'yyn|/Users/'].join(''), 'i');
  assert.ok(!verboten.test(eigen + lies('aenderungen.css') + html), 'kein Agenten-, Rechner- oder Pfadname im Quelltext');
});

// --- Archiv vom Runner, Suche, Datei-Vorschau und Dateibaum über den Runner, Kontextfenster (Abschnitt 9h) -------------------------------------------------

function wegeLogik() {
  const w = { FyosPrototyp: {} };
  new Function('window', 'globalThis', lies('runner-wege.js'))(w, w);
  return w.FyosPrototyp.wege;
}

test('Wege: Werte werden URL-kodiert, auch Punkte (die Brücke weist ".." in jedem Weg ab); Archivliste nur, wenn jeder Eintrag archiviert: true trägt', () => {
  const W = wegeLogik();
  assert.equal(W.kodiere('a b/c.d..e'), 'a%20b%2Fc%2Ed%2E%2Ee');
  assert.equal(W.kodiere('../etc'), '%2E%2E%2Fetc');
  assert.deepEqual(plain(W.archivListePruefen({ gespraeche: [{ id: 1, archiviert: true }] })), { unterstuetzt: true, liste: [{ id: 1, archiviert: true }] });
  assert.equal(W.archivListePruefen({ gespraeche: [] }).unterstuetzt, true, 'leer ist gültig (neuerer Runner ohne Archivierte)');
  assert.equal(W.archivListePruefen({ gespraeche: [{ id: 1 }, { id: 2 }] }).unterstuetzt, false, 'älterer Runner: Parameter ignoriert, kein Feld archiviert');
  assert.equal(W.archivListePruefen({ gespraeche: [{ id: 1, archiviert: false }] }).unterstuetzt, false);
  assert.equal(W.archivListePruefen({}).unterstuetzt, false);
});

test('Wege: Fehler werden zugeordnet (HTTP-Transport und Rust-Brücke), ein Weg, den der Runner nicht kennt, ist weg_fehlt', () => {
  const W = wegeLogik();
  const http = (status, fehler) => Object.assign(new Error(fehler || `HTTP ${status}`), { status, fehler: fehler || '' });
  const rust = (status, text) => Object.assign(new Error('Der Runner antwortet mit einem Fehler.'), { code: 'RUNNER_FEHLER', meldung: { code: 'RUNNER_FEHLER', details: `HTTP ${status}${text ? `: ${text}` : ''}` } });
  const art = (f) => W.klassifiziere(f).art;
  assert.equal(art(http(403, 'gesperrt')), 'gesperrt');
  assert.equal(art(rust(403, 'gesperrt')), 'gesperrt');
  assert.equal(art(rust(403, 'verwehrt')), 'verwehrt');
  assert.equal(art(rust(403, 'ausserhalb')), 'ausserhalb');
  assert.equal(art(Object.assign(new Error('x'), { code: 'ORDNER_AUSSERHALB' })), 'ausserhalb');
  assert.equal(art(rust(404, 'nicht_gefunden')), 'nicht_gefunden');
  assert.equal(art(rust(404, 'gespraech_nicht_gefunden')), 'gespraech');
  assert.equal(art(rust(404, 'Unbekannte Route: GET /api/suche')), 'weg_fehlt');
  assert.equal(art(rust(404, 'Nicht gefunden')), 'weg_fehlt');
  assert.equal(art(http(404)), 'weg_fehlt', 'HTTP-Transport ohne Text');
  assert.equal(art(rust(429, 'Es läuft schon eine Suche')), 'zu_viele');
  assert.equal(art(rust(400, 'q muss mindestens 2 Zeichen haben')), 'ungueltig');
  assert.equal(art(rust(413, 'zu_gross')), 'zu_gross');
  assert.equal(art(Object.assign(new Error('x'), { code: 'RUNNER_NICHT_ERREICHBAR' })), 'netz');
  assert.equal(art(new TypeError('Failed to fetch')), 'netz');
  assert.equal(art(Object.assign(new Error('x'), { code: 'TOKEN_ABGELEHNT' })), 'zugang');
  assert.equal(art(rust(500, 'kaputt')), 'andere');
  assert.ok(!/Hostname|\/Users\//.test(W.klassifiziere(rust(403, 'gesperrt')).message), 'die Meldung nennt keine Namen');
});

test('Wege: Markierungen werden bereinigt (ganze Zahlen, im Ausschnitt, aufsteigend, ohne Überlappung, höchstens 10), Treffer ohne Id fallen weg', () => {
  const W = wegeLogik();
  const m = W.markierungenPruefen('abcdefghij', [{ start: 6, laenge: 2 }, { start: 0, laenge: 3 }, { start: 2, laenge: 2 }, { start: 99, laenge: 1 }, { start: -1, laenge: 2 }, { start: 8, laenge: 99 }, { start: 'x', laenge: 1 }, null], 0, 0);
  assert.deepEqual(plain(m), [{ start: 0, laenge: 3 }, { start: 6, laenge: 2 }, { start: 8, laenge: 2 }]);
  assert.deepEqual(plain(W.markierungenPruefen('abc', undefined, 1, 2)), [{ start: 1, laenge: 2 }], 'ohne markierungen gilt der erste Treffer');
  assert.deepEqual(plain(W.markierungenPruefen('abc', [], 0, 0)), []);
  assert.equal(W.trefferBereinigen({ titel: 'x' }), null);
  const t = W.trefferBereinigen({ id: 4, titel: '  ', ausschnitt: 'hallo', markierungen: [{ start: 0, laenge: 5 }], zahl: -3, archiviert: 'ja', quelle: 'sonstwas' });
  assert.deepEqual(plain({ ...t }), { id: 4, titel: 'Ohne Titel', archiviert: false, aktualisiert: 0, quelle: 'verlauf', ausschnitt: 'hallo', markierungen: [{ start: 0, laenge: 5 }], zahl: 0 });
});

test('Wege: Fenstergröße aus der Modellliste (Id, Anbieter/Id, Name, Objekt) – ohne Eintrag null', () => {
  const W = wegeLogik();
  const liste = [{ id: 'm1', provider: 'a', name: 'Modell Eins', contextWindow: 262144 }, { id: 'm1', provider: 'b', name: 'Anderes', contextWindow: 65536 }, { id: 'x', provider: 'a', name: 'X' }];
  assert.equal(W.fensterAusModellen(liste, 'm1'), 262144);
  assert.equal(W.fensterAusModellen(liste, 'b/m1'), 65536);
  assert.equal(W.fensterAusModellen(liste, 'Modell Eins'), 262144);
  assert.equal(W.fensterAusModellen(liste, { provider: 'b', modelId: 'm1' }), 65536);
  assert.equal(W.fensterAusModellen(liste, { provider: 'a', id: 'm1' }), 262144);
  assert.equal(W.fensterAusModellen(liste, 'x'), null, 'ohne contextWindow');
  assert.equal(W.fensterAusModellen(liste, 'unbekannt'), null);
  assert.equal(W.fensterAusModellen(null, 'm1'), null);
});

// Suchfeld und Trefferliste (suche.js) mit einem Runner aus dem Speicher
const SUCHE_HTML = '<!doctype html><body><div id="k"><input id="f" type="search"><p id="m" role="alert" hidden></p></div><nav id="n"><div id="e" hidden></div><div id="liste">Sitzungen</div></nav><textarea id="eingabe"></textarea></body>';
const treffer = (id, extra) => ({ id, titel: `Sitzung ${id}`, archiviert: false, aktualisiert: Date.now() - 60000, quelle: 'verlauf', ausschnitt: 'ein Text mit Fehler darin', start: 11, laenge: 6, markierungen: [{ start: 11, laenge: 6 }], zahl: 2, ...extra });

function sucheMit(wegeExtra, opts) {
  const w = fenster(['sitzungen.js', 'suche.js'], SUCHE_HTML);
  const d = w.document;
  const g = (id) => d.getElementById(id);
  const z = { aufrufe: [], gewaehlt: [], esc: 0 };
  const wege = { suche: async (q, o) => { z.aufrufe.push([q, o]); return { treffer: [treffer(1)], abgeschnitten: false }; }, ...wegeExtra };
  const s = w.FyosPrototyp.createSuche({ kasten: g('k'), feld: g('f'), meldung: g('m'), ergebnis: g('e'), behaelter: g('n') }, { wege, beiWahl: (t) => z.gewaehlt.push(t), beiEsc: () => z.esc++, ...opts });
  const tippe2 = (wert) => {
    g('f').value = wert;
    g('f').dispatchEvent(new w.Event('input', { bubbles: true }));
  };
  return { w, d, g, s, z, tippe: tippe2 };
}

dom('Suche: erst nach 250 ms Pause, nur die letzte Eingabe wird gesucht, mindestens 2 Zeichen', async () => {
  const f = sucheMit();
  f.tippe('f');
  await warte(320);
  assert.equal(f.z.aufrufe.length, 0, 'ein Zeichen: keine Anfrage');
  assert.match(f.g('e').textContent, /Mindestens 2 Zeichen/);
  assert.equal(f.g('n').classList.contains('suche-aktiv'), true, 'die Trefferliste ersetzt die Sitzungsliste');
  f.tippe('fe');
  await warte(120);
  f.tippe('feh');
  await warte(120);
  f.tippe('fehl');
  assert.equal(f.z.aufrufe.length, 0, 'während des Tippens keine Anfrage');
  await warte(150);
  assert.equal(f.z.aufrufe.length, 0, 'noch nicht 250 ms nach der letzten Eingabe');
  await bis(() => f.z.aufrufe.length === 1);
  assert.deepEqual(plain(f.z.aufrufe[0]), ['fehl', { limit: 20, archiv: 'alle' }]);
  await warte(320);
  assert.equal(f.z.aufrufe.length, 1, 'nicht mehr als eine Anfrage');
  // Leerzeichen am Rand zählen nicht
  f.tippe('  a  ');
  await warte(320);
  assert.equal(f.z.aufrufe.length, 1);
});

dom('Suche: Treffer als Text – Titel, Ausschnitt mit Hervorhebung, Archiv-Marke, Zeit, Zahl; Angriffstext wird nie zu HTML', async () => {
  const angriff = '<img src=x onerror=alert(1)> Fehler <b>fett</b> & <script>x()</script>';
  const f = sucheMit({
    suche: async () => ({
      treffer: [
        treffer(1, { titel: '<b>Titel</b><img src=x onerror=alert(2)>', ausschnitt: angriff, markierungen: [{ start: angriff.indexOf('Fehler'), laenge: 6 }, { start: angriff.indexOf('fett'), laenge: 4 }], zahl: 3 }),
        treffer(2, { archiviert: true, quelle: 'titel', titel: 'Fehler im Titel', ausschnitt: 'Fehler im Titel', markierungen: [{ start: 0, laenge: 6 }], zahl: 1 }),
        treffer(3, { zahl: 1 }),
      ],
      abgeschnitten: true,
    }),
  });
  f.tippe('fehler');
  await bis(() => f.d.querySelectorAll('.suche-treffer').length === 3);
  assert.equal(f.d.querySelectorAll('#e img, #e b, #e script').length, 0, 'nichts davon wurde ein Element');
  const eins = f.d.querySelector('.suche-treffer[data-id="1"]');
  assert.equal(eins.querySelector('.suche-titel').textContent, '<b>Titel</b><img src=x onerror=alert(2)>');
  assert.equal(eins.querySelector('.suche-ausschnitt').textContent, angriff, 'der Ausschnitt ist unverändert Text');
  assert.deepEqual([...eins.querySelectorAll('mark')].map((m) => m.textContent), ['Fehler', 'fett'], 'genau die Offsets sind hervorgehoben');
  assert.match(eins.querySelector('.suche-meta').textContent, /vor 1 Min\. · 3 Fundstellen/);
  const zwei = f.d.querySelector('.suche-treffer[data-id="2"]');
  assert.equal(zwei.querySelector('.suche-archiv').textContent, 'archiviert');
  assert.equal(zwei.querySelector('.suche-titel mark').textContent, 'Fehler', 'Treffer im Titel: der Titel selbst ist hervorgehoben');
  assert.equal(zwei.querySelector('.suche-ausschnitt'), null);
  assert.match(zwei.querySelector('.suche-meta').textContent, /1 Fundstelle$/);
  assert.equal(f.d.querySelector('.suche-treffer[data-id="3"] .suche-archiv'), null);
  assert.match(f.g('e').textContent, /Die Suche war begrenzt/);
  // Klick wählt, Zeile bekommt aria-current
  zwei.click();
  assert.equal(f.z.gewaehlt.length, 1);
  assert.equal(f.z.gewaehlt[0].id, 2);
  assert.equal(zwei.getAttribute('aria-current'), 'true');
});

dom('Suche: Antworten veralteter Eingaben werden verworfen (nur die letzte zählt), die alte Liste bleibt bis zur neuen stehen', async () => {
  const offen = [];
  const f = sucheMit({ suche: (q) => new Promise((ok) => offen.push({ q, ok })) }, { verzoegerung: 10 });
  f.tippe('alt');
  await bis(() => offen.length === 1);
  f.tippe('neu');
  await bis(() => offen.length === 2);
  // die neuere Antwort kommt zuerst, die ältere danach: sie darf nichts überschreiben
  offen[1].ok({ treffer: [treffer(2, { titel: 'neuer Treffer' })], abgeschnitten: false });
  await bis(() => f.d.querySelector('.suche-treffer'));
  offen[0].ok({ treffer: [treffer(1, { titel: 'alter Treffer' })], abgeschnitten: false });
  await warte(30);
  assert.deepEqual([...f.d.querySelectorAll('.suche-titel')].map((t) => t.textContent), ['neuer Treffer']);
  // Tippen während einer Anfrage entwertet sie, auch wenn danach nichts mehr abgeschickt wird (Feld geleert)
  f.tippe('dritte');
  await bis(() => offen.length === 3);
  f.tippe('');
  offen[2].ok({ treffer: [treffer(3)], abgeschnitten: false });
  await warte(30);
  assert.equal(f.d.querySelector('.suche-treffer'), null);
  assert.equal(f.g('e').hidden, true);
  assert.equal(f.g('n').classList.contains('suche-aktiv'), false, 'die Sitzungsliste ist zurück');
});

dom('Suche: Fehler stehen als kurze Meldung unter dem Feld, es gibt keine Wiederholung von selbst; 404 blendet das Feld aus', async () => {
  const fehler = (art, message) => async () => { throw Object.assign(new Error(message), { art }); };
  let art = 'zu_viele';
  const f = sucheMit({ suche: async (q) => { f.z.aufrufe.push([q]); throw Object.assign(new Error(`Fehler ${art}`), { art }); } }, { verzoegerung: 10 });
  f.tippe('abc');
  await bis(() => !f.g('m').hidden);
  assert.match(f.g('m').textContent, /zu viele Suchen/);
  assert.equal(f.g('m').getAttribute('role'), 'alert');
  await warte(250);
  assert.equal(f.z.aufrufe.length, 1, 'keine Dauerschleife');
  // 400 und Netz
  art = 'ungueltig';
  f.tippe('abcd');
  await bis(() => /lässt sich nicht suchen/.test(f.g('m').textContent));
  art = 'netz';
  f.tippe('abcde');
  await bis(() => /nicht erreichbar/.test(f.g('m').textContent));
  assert.equal(f.d.querySelector('.suche-treffer'), null);
  // eine neue Eingabe räumt die Meldung weg
  f.tippe('');
  assert.equal(f.g('m').hidden, true);
  // älterer Runner: 404 → das Feld verschwindet und das Kürzel greift nicht mehr
  art = 'weg_fehlt';
  f.tippe('abcdef');
  await bis(() => f.g('k').hidden);
  assert.equal(f.g('f').value, '');
  assert.equal(f.s.verfuegbar, false);
  assert.equal(f.s.fokussiere(), false);
  assert.equal(f.g('n').classList.contains('suche-aktiv'), false);
  void fehler;
});

dom('Suche: Esc leert das Feld (und stoppt die Ansicht nicht), ein zweites Esc gibt den Fokus zurück; Enter wählt den ersten Treffer; Pfeil runter geht in die Liste', async () => {
  const f = sucheMit({ suche: async () => ({ treffer: [treffer(1), treffer(2)], abgeschnitten: false }) }, { verzoegerung: 10 });
  const amDokument = [];
  f.d.addEventListener('keydown', (e) => amDokument.push(e.key));
  f.g('f').focus();
  f.tippe('fehler');
  await bis(() => f.d.querySelectorAll('.suche-treffer').length === 2);
  taste(f.w, f.g('f'), 'ArrowDown');
  assert.equal(f.d.activeElement, f.d.querySelector('.suche-treffer[data-id="1"]'));
  taste(f.w, f.d.activeElement, 'ArrowDown');
  assert.equal(f.d.activeElement, f.d.querySelector('.suche-treffer[data-id="2"]'));
  taste(f.w, f.d.activeElement, 'ArrowUp');
  taste(f.w, f.d.activeElement, 'ArrowUp');
  assert.equal(f.d.activeElement, f.g('f'), 'Pfeil hoch aus der ersten Zeile geht ins Feld');
  taste(f.w, f.g('f'), 'Enter');
  assert.equal(f.z.gewaehlt.at(-1).id, 1, 'Enter wählt den ersten Treffer');
  taste(f.w, f.g('f'), 'Escape');
  assert.equal(f.g('f').value, '');
  assert.equal(f.g('e').hidden, true);
  assert.equal(f.z.esc, 0);
  taste(f.w, f.g('f'), 'Escape');
  assert.equal(f.z.esc, 1, 'zweites Esc: zurück in die Eingabe');
  assert.deepEqual(amDokument, [], 'einfache Tasten im Feld erreichen die Kürzel der Seite nicht');
  taste(f.w, f.g('f'), 'b', { metaKey: true });
  assert.deepEqual(amDokument, ['b'], 'Cmd+Taste bleibt der Seite');
});

// Ganze Seite: Archiv vom Runner, Suche, Kürzel
const archiviert = (id, titel, extra) => ({ id, art: 'mensch', titel, erstellt: 500, arbeitsbereich: 'standard', archiviert: true, agent: { cwd: '/probe/standard' }, ...extra });
const FRUEHER = () => [archiviert(7, 'Früher archiviert')];

dom('Seite: das Archiv kommt vom Runner (GET /api/gespraeche?archiv=1), lädt beim Start und nach jeder Änderung neu; leer steht „Keine archivierten Sitzungen.“', async () => {
  const f = arbeitsplatz({ archivWeg: true });
  try {
    await bis(() => f.d.querySelectorAll('#sitzungsliste .sitzung').length === 2);
    assert.ok(f.st.aufrufe.some((a) => a.url === '/api/gespraeche?archiv=1'), 'Archivliste beim Start');
    assert.equal(f.g('archivKopf').hidden, false, 'der Abschnitt steht auch ohne Einträge da (der Runner kennt die Liste)');
    assert.equal(f.g('archivZahl').textContent, '0');
    assert.equal(f.g('archivLeer').hidden, true, 'eingeklappt: kein Hinweis');
    f.g('archivKopf').click();
    assert.equal(f.g('archivLeer').hidden, false);
    assert.equal(f.g('archivLeer').textContent, 'Keine archivierten Sitzungen.');
    // eine Sitzung, die schon vorher archiviert war (anderes Fenster, früherer Start): erscheint nach dem nächsten Laden
    f.st.gespraeche.push(archiviert(7, 'Früher archiviert'));
    await f.w.__arbeitsplatz.ladeListe();
    await bis(() => f.g('archivZahl').textContent === '1');
    assert.equal(f.g('archivLeer').hidden, true);
    assert.equal(f.g('archivListe').querySelector('.sitzung-titel').textContent, 'Früher archiviert');
    assert.equal(f.d.querySelector('#sitzungsliste .sitzung[data-id="7"]'), null, 'nicht in der Hauptliste');
    // Archivieren: PATCH, danach kommt die Liste vom Runner (ohne lokale Hilfsliste)
    const vorher = f.st.aufrufe.filter((a) => a.url === '/api/gespraeche?archiv=1').length;
    f.d.querySelector('#sitzungsliste .sitzung[data-id="2"]').closest('.sitzung-zeile').querySelector('.archivieren').click();
    await bis(() => f.g('archivZahl').textContent === '2');
    assert.ok(f.st.aufrufe.filter((a) => a.url === '/api/gespraeche?archiv=1').length > vorher, 'nach der Änderung neu geladen');
    // Wiederherstellen: aus dem Archiv des Runners
    f.g('archivListe').querySelector('.sitzung[data-id="7"]').closest('.sitzung-zeile').querySelector('.wiederherstellen').click();
    await bis(() => f.d.querySelector('#sitzungsliste .sitzung[data-id="7"]'));
    assert.deepEqual(f.st.aufrufe.filter((a) => a.methode === 'PATCH').map((a) => [a.url, a.koerper]).at(-1), ['/api/gespraech/7', { archiviert: false }]);
    await bis(() => f.g('archivZahl').textContent === '1');
  } finally {
    f.schliesse();
  }
});

dom('Seite: ein älterer Runner (Parameter ignoriert, kein Feld archiviert) lässt alles beim Alten: kein Archiv-Abschnitt ohne selbst Archiviertes, keine Fehler', async () => {
  const f = arbeitsplatz();
  try {
    await bis(() => f.d.querySelectorAll('#sitzungsliste .sitzung').length === 2);
    assert.equal(f.g('archivKopf').hidden, true);
    assert.equal(f.g('archivLeer').hidden, true);
    // zweimal laden: die Archivliste wird nach dem ersten Mal nicht mehr erfragt
    await f.w.__arbeitsplatz.ladeListe();
    assert.equal(f.st.aufrufe.filter((a) => a.url === '/api/gespraeche?archiv=1').length, 1);
    assert.equal(f.d.querySelectorAll('#sitzungsliste .sitzung').length, 2, 'die Sitzungen sind nicht doppelt');
  } finally {
    f.schliesse();
  }
});

const SUCHE_RUNNER = (antworten) => ({
  suche: (p, url, st) => {
    st.sucheUrls = (st.sucheUrls || []).concat(url);
    return antworten(p, st);
  },
});

dom('Seite: Suchfeld – Anfrage mit q, limit=20 und archiv=alle, Trefferliste statt Sitzungsliste, Treffer in einer archivierten Sitzung wechselt dorthin mit Hinweis, Esc bringt die Liste zurück', async () => {
  const f = arbeitsplatz({
    archivWeg: true,
    archivierte: FRUEHER(),
    runner: SUCHE_RUNNER((p) => [200, { ok: true, treffer: [
      { id: 2, titel: 'Zweite', archiviert: false, aktualisiert: Date.now(), quelle: 'verlauf', ausschnitt: 'ein Satz mit Süßes & <b>x</b>', start: 11, laenge: 5, markierungen: [{ start: 11, laenge: 5 }], zahl: 1 },
      { id: 7, titel: 'Früher archiviert', archiviert: true, aktualisiert: Date.now() - 86400000, quelle: 'titel', ausschnitt: 'Früher archiviert', start: 0, laenge: 5, markierungen: [{ start: 0, laenge: 5 }], zahl: 1 },
    ], abgeschnitten: false, durchsucht: 3, gesamt: 3 }]),
  });
  try {
    await bis(() => f.d.querySelectorAll('#sitzungsliste .sitzung').length === 2 && f.g('archivZahl').textContent === '1');
    f.g('sucheFeld').value = 'Süßes ä';
    f.g('sucheFeld').dispatchEvent(new f.w.Event('input', { bubbles: true }));
    await bis(() => f.d.querySelectorAll('.suche-treffer').length === 2);
    assert.equal(f.st.sucheUrls.length, 1);
    assert.equal(f.st.sucheUrls[0], '/api/suche?q=S%C3%BC%C3%9Fes%20%C3%A4&limit=20&archiv=alle');
    assert.equal(f.g('leisteListe').classList.contains('suche-aktiv'), true);
    assert.equal(f.g('sucheErgebnis').hidden, false);
    // Hinweis zu den gefundenen Sitzungen: die Seitenleistenlisten sind verdeckt (CSS), nicht entfernt
    assert.ok(lies('arbeitsplatz.css').includes('.leiste-liste.suche-aktiv > :not(.suche-ergebnis)'));
    // Treffer in einer archivierten Sitzung: Wechsel mit Hinweis
    f.d.querySelector('.suche-treffer[data-id="7"]').click();
    await bis(() => f.g('titel').textContent === 'Früher archiviert');
    await bis(() => /ist archiviert/.test(f.d.querySelector('.pane.aktiv').textContent));
    assert.equal(f.w.__arbeitsplatz.aktiv.id, 7);
    // wieder zum Treffer in der aktiven Sitzung
    f.d.querySelector('.suche-treffer[data-id="2"]').click();
    await bis(() => f.g('titel').textContent === 'Zweite');
    // Esc leert, die Sitzungsliste ist zurück
    f.g('sucheFeld').focus();
    taste(f.w, f.g('sucheFeld'), 'Escape');
    assert.equal(f.g('sucheFeld').value, '');
    assert.equal(f.g('leisteListe').classList.contains('suche-aktiv'), false);
    assert.equal(f.g('sucheErgebnis').hidden, true);
  } finally {
    f.schliesse();
  }
});

dom('Seite: Cmd+K und „/“ holen den Fokus ins Suchfeld; „/“ im Eingabefeld tippt einen Schrägstrich; ältere Runner ohne /api/suche (404) blenden das Feld aus', async () => {
  const f = arbeitsplatz();
  try {
    await bis(() => f.d.querySelectorAll('#sitzungsliste .sitzung').length === 2);
    await bis(() => f.d.activeElement === f.g('eingabe'));
    // „/“ im Eingabefeld: kein Sprung
    const imFeld = new f.w.KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    f.g('eingabe').dispatchEvent(imFeld);
    assert.equal(imFeld.defaultPrevented, false);
    assert.equal(f.d.activeElement, f.g('eingabe'));
    // „/“ außerhalb eines Feldes
    f.g('leisteSchalter').focus();
    const schraeg = new f.w.KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    f.g('leisteSchalter').dispatchEvent(schraeg);
    assert.equal(schraeg.defaultPrevented, true);
    assert.equal(f.d.activeElement, f.g('sucheFeld'));
    // Cmd+K auch aus der Eingabe
    f.g('eingabe').focus();
    f.g('eingabe').dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }));
    assert.equal(f.d.activeElement, f.g('sucheFeld'));
    f.g('eingabe').focus();
    f.g('eingabe').dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    assert.equal(f.d.activeElement, f.g('sucheFeld'));
    // Cmd+Umschalt+K ist es nicht
    f.g('eingabe').focus();
    f.g('eingabe').dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'k', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    assert.equal(f.d.activeElement, f.g('eingabe'));
    // Dieser Speicher-Runner kennt /api/suche nicht (404 „Unbekannte Route“): das Feld verschwindet
    f.g('sucheFeld').value = 'abc';
    f.g('sucheFeld').dispatchEvent(new f.w.Event('input', { bubbles: true }));
    await bis(() => f.g('sucheKasten').hidden);
    assert.equal(f.w.__arbeitsplatz.suche.verfuegbar, false);
    f.g('leisteSchalter').focus();
    const nochmal = new f.w.KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    f.g('leisteSchalter').dispatchEvent(nochmal);
    assert.equal(nochmal.defaultPrevented, false, 'ohne Suche kein Abfangen des Schrägstrichs');
    assert.equal(f.g('leisteListe').classList.contains('suche-aktiv'), false);
  } finally {
    f.schliesse();
  }
});

dom('Seite: ein Treffer blättert zur Stelle, wenn der geladene Verlauf sie enthält (Text wird nur verglichen, nie eingesetzt)', async () => {
  const entries = [frage(1), antwortMit(2, nutzung(10, 10, 10)), { id: 3, kind: 'pi.message', model: [{ role: 'assistant', content: [{ type: 'text', text: 'Der seltene Zielsatz steht hier.' }], stopReason: 'stop', timestamp: 2000 }] }];
  const f = arbeitsplatz({
    archivWeg: true,
    ansicht: (id) => ({ entries: id === 2 ? entries : [] }),
    runner: SUCHE_RUNNER(() => [200, { ok: true, treffer: [{ id: 2, titel: 'Zweite', archiviert: false, aktualisiert: Date.now(), quelle: 'verlauf', ausschnitt: 'Der seltene Zielsatz steht hier.', start: 4, laenge: 7, markierungen: [{ start: 4, laenge: 7 }], zahl: 1 }], abgeschnitten: false }]),
  });
  try {
    await bis(() => f.d.querySelectorAll('#sitzungsliste .sitzung').length === 2);
    f.g('sucheFeld').value = 'seltene';
    f.g('sucheFeld').dispatchEvent(new f.w.Event('input', { bubbles: true }));
    await bis(() => f.d.querySelector('.suche-treffer'));
    f.d.querySelector('.suche-treffer').click();
    await bis(() => f.d.querySelector('.treffer-blitz'));
    assert.match(f.d.querySelector('.treffer-blitz').textContent, /seltene Zielsatz/);
  } finally {
    f.schliesse();
  }
});

// Datei-Vorschau über GET /api/datei
const DATEI_VERLAUF = verlaufMit(['write', { path: '/probe/standard/neu.txt', content: 'aus dem Verlauf\n' }], ['read', { path: 'src/x.js' }, 'eins\nzwei\n']);

function dateiRunner(antwort) {
  return { datei: (p, url, st) => { st.dateiUrls = (st.dateiUrls || []).concat(url); return antwort(p, st); } };
}
const oeffneDatei = async (f, pfad) => {
  await bis(() => !f.g('aenderungenKnopf').hidden);
  f.g('aenderungenKnopf').click();
  f.d.querySelector(`.ae-datei[data-pfad="${pfad}"] .ae-name`).click();
};
const vorschauText = (f) => [...f.d.querySelectorAll('.ae-code .code')].map((x) => x.textContent);

dom('Vorschau über den Runner: Weg und Abfrage stimmen (absoluter Pfad, Sitzung, max), der Inhalt kommt vom Runner, nicht aus dem Verlauf; Hinweise für Kürzung und Schwärzung', async () => {
  const f = arbeitsplatz({
    tauri: () => undefined,
    ansicht: (id) => ({ entries: id === 1 ? DATEI_VERLAUF : [] }),
    runner: dateiRunner((p) => [200, { ok: true, pfad: p.get('pfad'), groesse: 4000000, text: 'echt vom Runner\nzweite <b>Zeile</b>\n', abgeschnitten: true, binaer: false, geaendert: 1793350000000, geschwaerzt: true }]),
  });
  try {
    await oeffneDatei(f, 'neu.txt');
    await bis(() => vorschauText(f).length === 2);
    assert.deepEqual(vorschauText(f), ['echt vom Runner', 'zweite <b>Zeile</b>']);
    assert.equal(f.d.querySelectorAll('.ae-code b').length, 0, 'kein HTML aus der Datei');
    assert.equal(f.st.dateiUrls.length, 1);
    assert.equal(f.st.dateiUrls[0], '/api/datei?pfad=%2Fprobe%2Fstandard%2Fneu%2Etxt&gespraech=1&max=200000');
    const stand = f.d.querySelector('.ae-quelle').textContent;
    assert.match(stand, /aktuell vom Runner gelesen/);
    assert.match(stand, /Gekürzt: gezeigt werden die ersten \d+ von 4000000 Byte/);
    assert.match(f.d.querySelector('.ae-geschwaerzt').textContent, /Geheimnisse geschwärzt/);
    assert.ok(!f.st.tauri.some(([b, a]) => b === 'runner_anfrage' && a.methode !== 'GET' && /datei|suche/.test(a.pfad)), 'nur GET');
    // ein Datei-Pfad, der über die Brücke geht, enthält keine Roh-Punkte (".." wird dort abgewiesen)
    assert.ok(!/\.\./.test(f.st.dateiUrls[0]));
  } finally {
    f.schliesse();
  }
});

dom('Vorschau über den Runner: Binärdatei, leere Datei, Wird gelesen …', async () => {
  let antwort = [200, { ok: true, pfad: '/x', groesse: 2048, binaer: true }];
  let freigabe;
  const f = arbeitsplatz({ ansicht: (id) => ({ entries: id === 1 ? DATEI_VERLAUF : [] }), runner: dateiRunner(() => (freigabe ? new Promise((ok) => (freigabe.ok = () => ok(antwort))) : antwort)) });
  try {
    await oeffneDatei(f, 'neu.txt');
    await bis(() => f.d.querySelector('.ae-binaer'));
    assert.equal(f.d.querySelector('.ae-binaer').textContent, 'Binärdatei, 2048 Byte');
    assert.equal(f.d.querySelector('.ae-code'), null);
    f.d.querySelector('.ae-zurueck').click();
    antwort = [200, { ok: true, pfad: '/x', groesse: 0, text: '', abgeschnitten: false, binaer: false, geaendert: 0 }];
    f.d.querySelector('.ae-datei[data-pfad="neu.txt"] .ae-name').click();
    await bis(() => f.d.querySelector('.ae-leer'));
    assert.equal(f.d.querySelector('.ae-leer').textContent, 'Die Datei ist leer.');
    f.d.querySelector('.ae-zurueck').click();
    freigabe = {};
    antwort = [200, { ok: true, pfad: '/x', groesse: 3, text: 'abc', abgeschnitten: false, binaer: false, geaendert: 0 }];
    f.d.querySelector('.ae-datei[data-pfad="neu.txt"] .ae-name').click();
    assert.equal(f.d.querySelector('.ae-laedt').textContent, 'Wird gelesen …');
    await bis(() => freigabe.ok);
    freigabe.ok();
    await bis(() => vorschauText(f).join() === 'abc');
  } finally {
    f.schliesse();
  }
});

dom('Vorschau über den Runner: gesperrt, keine Leserechte, Sitzung weg – klare Meldung, KEIN Umweg über den Verlauf (HTTP-Transport und Rust-Brücke gleich)', async () => {
  for (const tauri of [false, true]) {
    for (const [status, kennwort, grund, text] of [[403, 'gesperrt', 'gesperrt', /gesperrt/], [403, 'verwehrt', 'verwehrt', /Leserechte/], [404, 'gespraech_nicht_gefunden', 'gespraech', /Sitzung gibt es/], [400, 'keine_datei', 'keine_datei', /keine reguläre Datei/], [413, 'zu_gross', 'zu_gross', /zu groß/]]) {
      const f = arbeitsplatz({ ...(tauri ? { tauri: () => undefined } : {}), ansicht: (id) => ({ entries: id === 1 ? DATEI_VERLAUF : [] }), runner: dateiRunner(() => [status, { ok: false, fehler: kennwort, meldung: 'Text des Runners' }]) });
      try {
        await oeffneDatei(f, 'neu.txt');
        await bis(() => f.d.querySelector('.ae-grund'));
        assert.equal(f.d.querySelector('.ae-grund').dataset.grund, grund, `${tauri ? 'Brücke' : 'HTTP'} ${kennwort}`);
        assert.match(f.d.querySelector('.ae-grund').textContent, text);
        assert.equal(f.d.querySelector('.ae-code'), null, 'der Verlaufsstand wird hier nicht gezeigt');
        assert.ok(!/aus dem Verlauf/.test(f.g('aenderungenInhalt').textContent));
        assert.ok(!/Token/i.test(f.g('aenderungenInhalt').textContent), 'ein 403 auf der Datei ist kein Tokenfehler');
      } finally {
        f.schliesse();
      }
    }
  }
});

dom('Vorschau über den Runner: Datei außerhalb der freigegebenen Ordner – der Stand aus dem Verlauf mit Hinweis, ohne Verlaufsstand die Meldung', async () => {
  const f = arbeitsplatz({ tauri: () => undefined, ansicht: (id) => ({ entries: id === 1 ? DATEI_VERLAUF : [] }), runner: dateiRunner(() => [403, { ok: false, fehler: 'ausserhalb', meldung: 'Pfad liegt außerhalb der erlaubten Wurzeln' }]) });
  try {
    await oeffneDatei(f, 'neu.txt');
    await bis(() => vorschauText(f).length);
    assert.deepEqual(vorschauText(f), ['aus dem Verlauf']);
    assert.match(f.d.querySelector('.ae-quelle').textContent, /nicht zum Lesen frei; gezeigt wird der Stand aus dem Verlauf/);
    f.d.querySelector('.ae-zurueck').click();
    f.w.__arbeitsplatz.aenderungen.oeffneVorschau('nie-gesehen.txt');
    await bis(() => f.d.querySelector('.ae-grund'));
    assert.equal(f.d.querySelector('.ae-grund').dataset.grund, 'ausserhalb');
    assert.match(f.d.querySelector('.ae-grund').textContent, /außerhalb der Ordner, die der Runner freigibt/);
  } finally {
    f.schliesse();
  }
});

dom('Vorschau über den Runner: Datei nicht (mehr) da → Stand aus dem Verlauf mit Hinweis; älterer Runner (Weg fehlt) → Verlauf ohne Hinweis; Netzfehler → Verlauf mit Hinweis', async () => {
  const f = arbeitsplatz({ tauri: () => undefined, ansicht: (id) => ({ entries: id === 1 ? DATEI_VERLAUF : [] }), runner: dateiRunner(() => [404, { ok: false, fehler: 'nicht_gefunden', meldung: 'Datei nicht gefunden' }]) });
  try {
    await oeffneDatei(f, 'neu.txt');
    await bis(() => vorschauText(f).length);
    assert.deepEqual(vorschauText(f), ['aus dem Verlauf']);
    assert.match(f.d.querySelector('.ae-quelle').textContent, /gibt es auf dem Runner nicht \(mehr\); gezeigt wird der Stand aus dem Verlauf/);
    assert.match(f.d.querySelector('.ae-quelle').textContent, /zuletzt vom Agenten/);
    // eine Datei, die nur gelesen wurde und weg ist, ohne Verlaufsstand: Meldung
    f.d.querySelector('.ae-zurueck').click();
  } finally {
    f.schliesse();
  }
  // älterer Runner: Standard des Speicher-Runners ist 404 „Unbekannte Route“
  const alt = arbeitsplatz({ tauri: () => undefined, ansicht: (id) => ({ entries: id === 1 ? DATEI_VERLAUF : [] }) });
  try {
    await oeffneDatei(alt, 'neu.txt');
    await bis(() => vorschauText(alt).length);
    assert.deepEqual(vorschauText(alt), ['aus dem Verlauf']);
    assert.ok(!/nicht (mehr)|nicht geliefert/.test(alt.d.querySelector('.ae-quelle').textContent), 'kein Fehlerhinweis, wenn es den Weg schlicht nicht gibt');
  } finally {
    alt.schliesse();
  }
  const netz = arbeitsplatz({ ansicht: (id) => ({ entries: id === 1 ? DATEI_VERLAUF : [] }), runner: dateiRunner(() => Promise.reject(new TypeError('Failed to fetch'))) });
  try {
    await oeffneDatei(netz, 'neu.txt');
    await bis(() => vorschauText(netz).length);
    assert.deepEqual(vorschauText(netz), ['aus dem Verlauf']);
    assert.match(netz.d.querySelector('.ae-quelle').textContent, /Runner hat die Datei nicht geliefert/);
  } finally {
    netz.schliesse();
  }
});

dom('Vorschau über den Runner: eine Datei, die der Agent nur gelesen hat und die weg ist, und eine Datei ohne Verlaufsstand zeigen die Meldung', async () => {
  const verlauf = verlaufMit(['write', { path: 'a.txt', content: 'a\n' }]);
  const f = arbeitsplatz({ ansicht: (id) => ({ entries: id === 1 ? verlauf : [] }), runner: dateiRunner(() => [404, { ok: false, fehler: 'nicht_gefunden' }]) });
  try {
    await bis(() => !f.g('aenderungenKnopf').hidden);
    f.g('aenderungenKnopf').click();
    f.w.__arbeitsplatz.aenderungen.oeffneVorschau('nie-gesehen.txt');
    await bis(() => f.d.querySelector('.ae-grund'));
    assert.match(f.d.querySelector('.ae-grund').textContent, /gibt es auf dem Runner nicht \(mehr\)/);
  } finally {
    f.schliesse();
  }
});

// Dateibaum über GET /api/ordner?dateien=1
const BAUM = {
  '/probe/standard': { eintraege: [{ name: 'src', ordner: true }, { name: 'docs', ordner: true }, { name: 'liesmich.txt', ordner: false, groesse: 2048 }, { name: 'neu.txt', ordner: false, groesse: 16 }] },
  '/probe/standard/src': { eintraege: [{ name: 'x.js', ordner: false, groesse: 11 }, { name: 'y.js', ordner: false, groesse: 5 }] },
  '/probe/standard/docs': { eintraege: [{ name: 'a.md', ordner: false, groesse: 1 }], abgeschnitten: true },
};
function ordnerRunner(extra) {
  return {
    ordner: (p, url, st) => {
      st.ordnerUrls = (st.ordnerUrls || []).concat(url);
      const pfad = p.get('pfad');
      if (extra && extra[pfad]) return extra[pfad];
      return BAUM[pfad] ? [200, { ok: true, wurzeln: ['/probe'], pfad, erlaubt: true, ...BAUM[pfad] }] : [404, { ok: false, fehler: 'nicht_gefunden' }];
    },
  };
}
const knoten = (f) => [...f.d.querySelectorAll('#aenderungenInhalt .ae-knoten')].map((b) => `${b.dataset.ordner !== undefined ? 'O' : 'D'}:${b.querySelector('.ae-dname').textContent}`);

dom('Dateibaum über den Runner: Wurzel mit dateien=1, Ordner mit berührten Dateien klappen von selbst auf, berührte Dateien sind hervorgehoben, andere Ordner laden erst beim Aufklappen', async () => {
  const f = arbeitsplatz({ tauri: () => undefined, ansicht: (id) => ({ entries: id === 1 ? DATEI_VERLAUF : [] }), runner: ordnerRunner() });
  try {
    await bis(() => !f.g('aenderungenKnopf').hidden);
    f.g('aenderungenKnopf').click();
    f.g('aenderungenReiterBaum').click();
    await bis(() => knoten(f).includes('O:docs') && knoten(f).includes('D:y.js'));
    assert.equal(f.st.ordnerUrls[0], '/api/ordner?pfad=%2Fprobe%2Fstandard&dateien=1');
    assert.ok(f.st.ordnerUrls.includes('/api/ordner?pfad=%2Fprobe%2Fstandard%2Fsrc&dateien=1'), 'der Ordner mit der berührten Datei wurde geladen');
    assert.ok(!f.st.ordnerUrls.some((u) => /docs/.test(u)), 'docs lädt erst beim Aufklappen');
    assert.deepEqual(knoten(f), ['O:docs', 'O:src', 'D:x.js', 'D:y.js', 'D:liesmich.txt', 'D:neu.txt']);
    const x = f.d.querySelector('.ae-knoten[data-datei="src/x.js"]');
    assert.equal(x.dataset.beruehrt, '1');
    assert.equal(x.querySelector('.ae-art').textContent, 'gelesen');
    const neu = f.d.querySelector('.ae-knoten[data-datei="neu.txt"]');
    assert.equal(neu.dataset.beruehrt, '1');
    assert.equal(neu.querySelector('.ae-art').textContent, 'neu');
    assert.equal(f.d.querySelector('.ae-knoten[data-datei="liesmich.txt"]').dataset.beruehrt, undefined);
    assert.match(f.d.querySelector('.ae-knoten[data-datei="liesmich.txt"] .ae-groesse').textContent, /2,0 KB/);
    // lazy: docs aufklappen
    f.d.querySelector('.ae-knoten[data-ordner="docs"]').click();
    await bis(() => knoten(f).includes('D:a.md'));
    assert.ok(f.st.ordnerUrls.includes('/api/ordner?pfad=%2Fprobe%2Fstandard%2Fdocs&dateien=1'));
    assert.match(f.d.querySelector('#aenderungenInhalt').textContent, /Nur die ersten 500 Einträge/);
    // zuklappen und wieder aufklappen lädt nicht neu
    const n = f.st.ordnerUrls.length;
    f.d.querySelector('.ae-knoten[data-ordner="docs"]').click();
    assert.ok(!knoten(f).includes('D:a.md'));
    f.d.querySelector('.ae-knoten[data-ordner="docs"]').click();
    assert.ok(knoten(f).includes('D:a.md'));
    assert.equal(f.st.ordnerUrls.length, n);
    // Klick auf eine Datei, die der Agent nicht berührt hat: Vorschau über den Runner
    assert.equal(f.w.__arbeitsplatz.aenderungen.lebend, true);
    f.d.querySelector('.ae-knoten[data-datei="liesmich.txt"]').click();
    assert.equal(f.w.__arbeitsplatz.aenderungen.modus, 'vorschau');
    await bis(() => f.d.querySelector('.ae-grund, .ae-code, .ae-fehlt'));
    assert.equal(f.d.querySelector('.ae-vname').textContent, 'liesmich.txt');
    // Pfeil rechts/links auf einem Ordner des lebenden Baums
    f.d.querySelector('.ae-zurueck').click();
    f.d.querySelector('.ae-knoten[data-ordner="src"]').focus();
    taste(f.w, f.d.activeElement, 'ArrowLeft');
    assert.ok(!knoten(f).includes('D:x.js'), 'zugeklappt');
    taste(f.w, f.d.activeElement, 'ArrowRight');
    assert.ok(knoten(f).includes('D:x.js'), 'wieder auf');
  } finally {
    f.schliesse();
  }
});

dom('Dateibaum über den Runner: Fehler beim Aufklappen stehen unter dem Ordner; liegt der Arbeitsordner außerhalb der Wurzeln (403) oder kennt der Runner die Liste nicht, bleibt der Baum bei den berührten Dateien', async () => {
  const f = arbeitsplatz({ tauri: () => undefined, ansicht: (id) => ({ entries: id === 1 ? DATEI_VERLAUF : [] }), runner: ordnerRunner({ '/probe/standard/docs': [403, { ok: false, fehler: 'gesperrt' }] }) });
  try {
    await bis(() => !f.g('aenderungenKnopf').hidden);
    f.g('aenderungenKnopf').click();
    f.g('aenderungenReiterBaum').click();
    await bis(() => knoten(f).includes('O:docs'));
    f.d.querySelector('.ae-knoten[data-ordner="docs"]').click();
    await bis(() => /Nicht lesbar/.test(f.d.querySelector('#aenderungenInhalt').textContent));
    assert.match(f.d.querySelector('.ae-baum-meldung.fehler').textContent, /gesperrt/);
  } finally {
    f.schliesse();
  }
  const aussen = arbeitsplatz({ tauri: () => undefined, ansicht: (id) => ({ entries: id === 1 ? DATEI_VERLAUF : [] }), runner: ordnerRunner({ '/probe/standard': [403, { ok: false, fehler: 'ausserhalb' }] }) });
  try {
    await bis(() => !aussen.g('aenderungenKnopf').hidden);
    aussen.g('aenderungenKnopf').click();
    aussen.g('aenderungenReiterBaum').click();
    await bis(() => /außerhalb der Ordner, die der Runner freigibt/.test(aussen.d.querySelector('#aenderungenInhalt').textContent));
    assert.equal(aussen.w.__arbeitsplatz.aenderungen.lebend, false);
    assert.deepEqual(knoten(aussen), ['O:src', 'D:x.js', 'D:neu.txt'], 'weiter die berührten Dateien');
  } finally {
    aussen.schliesse();
  }
  // älterer Runner: GET /api/ordner mit Pfad nur Ordner (404 hier): Baum aus berührten Dateien, Fußzeile wie bisher
  const alt = arbeitsplatz({ ansicht: (id) => ({ entries: id === 1 ? DATEI_VERLAUF : [] }) });
  try {
    await bis(() => !alt.g('aenderungenKnopf').hidden);
    alt.g('aenderungenKnopf').click();
    alt.g('aenderungenReiterBaum').click();
    await bis(() => alt.d.querySelector('.ae-fuss'));
    await warte(60);
    assert.deepEqual(knoten(alt), ['O:src', 'D:x.js', 'D:neu.txt']);
    assert.equal(alt.w.__arbeitsplatz.aenderungen.lebend, false);
  } finally {
    alt.schliesse();
  }
});

// Kontextanzeige mit usage.context und contextWindow
const MIT_KONTEXT = (tokens, fenster) => ({ ...MAX_USAGE, context: { tokens, window: fenster } });

dom('Kontext: usage.context = { tokens, window } aus der Ansicht gilt (Rhea 262144: 100000 Token = 38 %), auch gegen die Summe aus dem UsageDoc', async () => {
  const f = arbeitsplatz({ ansicht: () => ({ entries: [frage(1), antwortMit(2, nutzung(5, 5, 5))], usage: MIT_KONTEXT(100000, 262144) }) });
  try {
    await bis(() => f.g('kontext').dataset.bekannt === '1');
    assert.equal(f.g('kontextText').textContent, '38 %');
    assert.equal(f.g('kontextTitel').textContent, 'Kontext 100k von 262,1k');
    assert.equal(f.g('kontext').getAttribute('aria-valuenow'), '38');
    assert.match(f.g('tokens').textContent, /gesamt 193 M ein/);
  } finally {
    f.schliesse();
  }
});

dom('Kontext: das Fenster kommt aus contextWindow von GET /api/modelle, wenn usage.context fehlt; usage.context.window gewinnt; ohne beides bleibt es bei 128000', async () => {
  const modelle = [{ id: 'probe-modell', provider: 'probe', name: 'Probe-Modell', contextWindow: 262144 }];
  const antwort = antwortMit(2, nutzung(3000, 60000, 500)); // 63,5k
  // Modell der Sitzung bekannt (agent.model), Fenster aus der Modellliste
  const a = arbeitsplatz({ modelle, ansicht: () => ({ entries: [frage(1), antwort], usage: MAX_USAGE, agent: { model: { provider: 'probe', modelId: 'probe-modell' } } }) });
  try {
    await bis(() => a.g('kontext').dataset.bekannt === '1');
    assert.equal(a.g('kontextText').textContent, '24 %');
    assert.equal(a.g('kontextTitel').textContent, 'Kontext 63,5k von 262,1k');
  } finally {
    a.schliesse();
  }
  // Modellname als Text (meta.modell)
  const b = arbeitsplatz({ modelle, ansicht: () => ({ entries: [frage(1), antwort], usage: MAX_USAGE, modell: 'probe-modell' }) });
  try {
    await bis(() => b.g('kontext').dataset.bekannt === '1');
    assert.equal(b.g('kontextTitel').textContent, 'Kontext 63,5k von 262,1k');
  } finally {
    b.schliesse();
  }
  // usage.context.window gewinnt vor der Modellliste
  const c = arbeitsplatz({ modelle, ansicht: () => ({ entries: [frage(1), antwort], usage: MIT_KONTEXT(63500, 65536), agent: { model: { provider: 'probe', modelId: 'probe-modell' } } }) });
  try {
    await bis(() => c.g('kontext').dataset.bekannt === '1');
    assert.equal(c.g('kontextText').textContent, '97 %');
    assert.equal(c.g('kontext').dataset.stufe, 'kritisch');
  } finally {
    c.schliesse();
  }
  // ohne usage.context und ohne contextWindow: wie bisher 128000
  const d = arbeitsplatz({ ansicht: () => ({ entries: [frage(1), antwort], usage: MAX_USAGE }) });
  try {
    await bis(() => d.g('kontext').dataset.bekannt === '1');
    assert.equal(d.g('kontextTitel').textContent, 'Kontext 63,5k von 128k');
  } finally {
    d.schliesse();
  }
});

dom('Kontext: tokens null (nach leeren/verdichten) zeigt „–“; ein usage_changed mit neuem context ersetzt die Anzeige', async () => {
  const f = arbeitsplatz({ ansicht: () => ({ entries: [frage(1), antwortMit(2, nutzung(3000, 60000, 500))], usage: MIT_KONTEXT(null, 262144) }) });
  try {
    await bis(() => /gesamt/.test(f.g('tokens').textContent));
    assert.equal(f.g('kontextText').textContent, '–', 'der Runner kennt die Füllung nicht: keine Zahl aus dem alten Verlauf');
    assert.equal(f.g('kontext').dataset.bekannt, '0');
    // Strom: usage_changed mit der neuen Füllung
    f.w.__chat.adapter.apply({ type: 'usage_changed', usage: MIT_KONTEXT(52428, 262144) });
    await bis(() => f.g('kontext').dataset.bekannt === '1');
    assert.equal(f.g('kontextText').textContent, '20 %');
    f.w.__chat.adapter.apply({ type: 'usage_changed', usage: MIT_KONTEXT(null, 262144) });
    await bis(() => f.g('kontext').dataset.bekannt === '0');
    assert.equal(f.g('kontextText').textContent, '–');
  } finally {
    f.schliesse();
  }
});

test('Quelltext: neue Module neutral formuliert, nur lesende Wege (GET), kein innerHTML mit Daten des Runners, im Fenster eingebunden', () => {
  const html = lies('chat.html');
  const neu = lies('runner-wege.js') + lies('suche.js');
  for (const id of ['sucheKasten', 'sucheFeld', 'sucheMeldung', 'sucheErgebnis', 'leisteListe', 'archivLeer']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.indexOf('src="runner-wege.js"') < html.indexOf('src="echt.js"') && html.indexOf('src="suche.js"') < html.indexOf('src="chat.js"'));
  assert.ok(!/'(POST|PATCH|PUT|DELETE)'/.test(lies('runner-wege.js')), 'runner-wege.js liest nur');
  assert.equal((lies('runner-wege.js').match(/transport\.api\('GET'/g) || []).length, 1, 'alle Anfragen laufen durch eine Stelle');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(neu), 'Namen und Texte nur über textContent');
  const verboten = new RegExp(['gin', 'ny|perse', 'phone|ti', 'tan|rh', 'ea|sirf', 'yyn|/Users/'].join(''), 'i');
  assert.ok(!verboten.test(neu + html + lies('arbeitsplatz.css')), 'kein Agenten-, Rechner- oder Pfadname im Quelltext');
  assert.match(html, /placeholder="Sitzungen durchsuchen"/);
  const chat = lies('chat.js');
  assert.match(chat, /key\.toLowerCase\(\) === 'k'/);
  assert.match(chat, /e\.key === '\/'/);
});

// --- Eingabe: @Dateien, /Befehle, Anhänge, Modell und Modus (eingabe.js, anhaenge.js, waehler.js, modus.js) ---
function eingabeLogik() {
  const w = { FyosPrototyp: {} };
  new Function('window', 'globalThis', lies('eingabe.js'))(w, w);
  return w.FyosPrototyp.eingabe;
}
function anhangLogik() {
  const w = { FyosPrototyp: {}, TextDecoder };
  new Function('window', 'globalThis', lies('anhaenge.js'))(w, w);
  return w.FyosPrototyp.anhaenge;
}
const dateiLike = (name, inhalt, extra) => {
  const bytes = typeof inhalt === 'string' ? new TextEncoder().encode(inhalt) : inhalt;
  return { name, size: bytes.length, type: '', arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), ...extra };
};

test('@-Auslöser: nur am Wortanfang, mit Anführungszeichen für Leerzeichen; „/“ nur als erstes Wort', () => {
  const E = eingabeLogik();
  const t = (text, c) => E.aktiverToken(text, c);
  assert.deepEqual({ ...t('@', 1) }, { art: 'datei', start: 0, ende: 1, anfrage: '', gequotet: false });
  assert.equal(t('Lies @src/ap', 12).anfrage, 'src/ap');
  assert.equal(t('Lies @src/ap', 12).start, 5);
  assert.equal(t('mail a@b.de', 11), null, 'ein @ mitten im Wort ist keine Auswahl');
  assert.equal(t('Lies @a und mehr', 7).anfrage, 'a', 'die Schreibmarke bestimmt das Wort');
  assert.equal(t('Lies @a und mehr', 16), null);
  assert.deepEqual({ ...t('Lies @"mein ord', 15) }, { art: 'datei', start: 5, ende: 15, anfrage: 'mein ord', gequotet: true });
  assert.equal(t('/ver', 4).art, 'befehl');
  assert.equal(t('/ver', 4).anfrage, 'ver');
  assert.equal(t('/ver rest', 3).ende, 4, 'ein Befehl wird als ganzes Wort ersetzt');
  assert.equal(t('/ver rest', 8), null, 'hinter dem Befehlswort ist es Text');
  assert.equal(t('Pfad /usr', 9), null, 'ein Schrägstrich mitten im Satz ist keiner');
  assert.equal(t('', 0), null);
});

test('Unscharf: gleich vor Anfang vor Teilstück vor Reihenfolge; Pfade mit .. und absolute fallen weg', () => {
  const E = eingabeLogik();
  const p = (q, t) => E.unscharf(q, t);
  assert.ok(p('app', 'app') > p('app', 'app.js') && p('app', 'app.js') > p('app', 'x-app.js') && p('app', 'x-app.js') > p('apj', 'app.js'));
  assert.equal(p('zzz', 'app.js'), -1);
  assert.ok(p('ReaDme', 'README.md') > 0, 'Groß/Klein egal');
  assert.ok(p('rm', 'read-me.md') > p('rm', 'xxrxxm.md'), 'Wortanfänge zählen mehr als Lücken');
  assert.deepEqual({ ...E.pfadTeile('src/ap') }, { ordner: 'src', filter: 'ap' });
  assert.deepEqual({ ...E.pfadTeile('a/b/') }, { ordner: 'a/b', filter: '' });
  assert.deepEqual({ ...E.pfadTeile('x') }, { ordner: '', filter: 'x' });
  assert.equal(E.pfadTeile('../x'), null);
  assert.equal(E.pfadTeile('/etc/x'), null);
  assert.equal(E.dateiWert('a b/c.txt'), '@"a b/c.txt"');
  assert.equal(E.dateiWert('a/c.txt'), '@a/c.txt');
  const eintr = [{ name: 'util.js', ordner: false, rel: 'src/util.js' }, { name: 'app.js', ordner: false, rel: 'src/app.js' }, { name: 'src', ordner: true, rel: 'src' }];
  assert.deepEqual(E.rangiere(eintr, '').map((x) => x.rel), ['src', 'src/util.js', 'src/app.js'], 'ohne Anfrage Ordner zuerst, sonst Reihenfolge des Runners');
  assert.equal(E.rangiere(eintr, 'app')[0].rel, 'src/app.js');
});

test('Befehlsliste: Pi-Terminalbefehle fallen weg, Namensanfang vor Teilstück, Aliase zählen', () => {
  const E = eingabeLogik();
  const b = (name, art, aliase) => ({ name, beschreibung: `Hilfe ${name}`, argumente: '', art: art || 'anzeige', aliase: aliase || [] });
  const alle = [b('hilfe', 'anzeige', ['help']), b('verdichten', 'verlauf', ['compact']), b('settings', 'terminal'), b('skill:review', 'skill'), b('stopp', 'bruecke', ['abbrechen'])];
  assert.deepEqual(E.befehlsListe(alle, '').map((x) => x.name), ['hilfe', 'skill:review', 'stopp', 'verdichten'].sort((x, y) => x.localeCompare(y)).filter((n) => n !== 'skill:review').concat(['skill:review']), 'ohne Anfrage: alphabetisch, Skills zuletzt, kein settings');
  assert.deepEqual(E.befehlsListe(alle, 'ver').map((x) => x.name), ['verdichten']);
  assert.deepEqual(E.befehlsListe(alle, 'abbr').map((x) => x.name), ['stopp'], 'Alias');
  assert.deepEqual(E.befehlsListe(alle, 'compact').map((x) => x.name), ['verdichten']);
  assert.deepEqual(E.befehlsListe(alle, 'review').map((x) => x.name), ['skill:review'], 'Teilstück');
  assert.deepEqual(E.befehlsListe(alle, 'qq'), []);
});

test('Anhang prüfen: Text kommt durch, Bild, Binär, zu groß und kein UTF-8 werden mit Grund abgelehnt', async () => {
  const A = anhangLogik();
  const ok = await A.pruefeDatei(dateiLike('notiz.txt', 'Hallo Welt\n'));
  assert.deepEqual({ ...ok }, { ok: true, name: 'notiz.txt', groesse: 11, text: 'Hallo Welt\n' });
  const bom = await A.pruefeDatei(dateiLike('b.txt', new Uint8Array([0xef, 0xbb, 0xbf, 0x41])));
  assert.equal(bom.text, 'A', 'Byte-Reihenfolge-Marke fällt weg');
  const bild = await A.pruefeDatei(dateiLike('foto.png', 'x', { type: 'image/png' }));
  assert.match(bild.grund, /Bilder nimmt der Runner heute nicht an/);
  assert.match((await A.pruefeDatei(dateiLike('x.JPG', 'x'))).grund, /Bilder/);
  assert.equal((await A.pruefeDatei(dateiLike('logo.svg', '<svg/>', { type: 'image/svg+xml' }))).ok, true, 'SVG ist Text');
  const bin = await A.pruefeDatei(dateiLike('a.bin', new Uint8Array([1, 2, 0, 3])));
  assert.match(bin.grund, /Binärdatei/);
  const gross = await A.pruefeDatei(dateiLike('gross.txt', 'a', { size: A.GRENZEN.datei + 1 }));
  assert.match(gross.grund, /Zu groß/);
  const latin = await A.pruefeDatei(dateiLike('alt.txt', new Uint8Array([0x63, 0x61, 0x66, 0xe9])));
  assert.match(latin.grund, /UTF-8/);
  assert.match((await A.pruefeDatei(dateiLike('kaputt.txt', 'x', { arrayBuffer: async () => { throw new Error('weg'); } }))).grund, /nicht lesbar/);
});

test('Einbetten: Name, Größe, Hinweis; der Zaun ist länger als jede Rückstrich-Reihe im Inhalt; ohne Anhänge bleibt der Satz unverändert; zu lang wird gemeldet', () => {
  const A = anhangLogik();
  assert.equal(A.einbetten('  Hallo  ', []), 'Hallo');
  const t = A.einbetten('Bitte prüfen', [{ name: 'a.md', groesse: 20, text: 'Text mit ```code``` darin\n\n' }]);
  assert.match(t, /^Bitte prüfen\n\nAngehängte Datei \(als Text eingebettet, Stand beim Anhängen\):\n\nDatei: a\.md \(20 B\)\n````\nText mit ```code``` darin\n````$/);
  const zwei = A.einbetten('', [{ name: 'a`\nb', groesse: 2048, text: 'x' }, { name: 'b', groesse: 1, text: 'y' }]);
  assert.match(zwei, /^Angehängte Dateien \(2, als Text/);
  assert.match(zwei, /Datei: a b \(2,0 KB\)/, 'Rückstrich und Zeilenumbruch im Namen sind weg');
  assert.equal(A.gesamtPruefen('kurz', [{ name: 'x', groesse: 1, text: 'y' }]), null);
  assert.match(A.gesamtPruefen('x'.repeat(A.GRENZEN.nachricht), [{ name: 'x', groesse: 1, text: 'y' }]), /zu lang/);
});

const ORDNER_WURZEL = [
  { name: 'src', ordner: true },
  { name: 'docs', ordner: true },
  { name: 'node_modules', ordner: true },
  { name: 'README.md', ordner: false, groesse: 1200 },
  { name: 'notizen alt.txt', ordner: false, groesse: 10 },
  { name: '<b>fett</b>.txt', ordner: false, groesse: 5 },
];
const ORDNER_RUNNER = (aufrufe) => (sp) => {
  const pfad = sp.get('pfad');
  aufrufe.push(pfad);
  const e = { '/probe/standard': ORDNER_WURZEL, '/probe/standard/src': [{ name: 'app.js', ordner: false, groesse: 2048 }, { name: 'util.js', ordner: false, groesse: 10 }], '/probe/standard/docs': [{ name: 'anleitung.md', ordner: false, groesse: 99 }] }[pfad];
  return e ? [200, { ok: true, wurzeln: ['/probe'], pfad, eintraege: e, erlaubt: true }] : [404, { ok: false, fehler: 'nicht_gefunden' }];
};
const punkteNamen = (d) => [...d.querySelectorAll('#menue [role="option"] .name')].map((x) => x.textContent);
const POSTS = (st) => st.aufrufe.filter((a) => a.methode === 'POST' && /nachricht$/.test(a.url));

dom('@-Auswahl: Dateien des Arbeitsordners, Ordner zuerst, Pfeile/Enter/Tab/Esc/Maus, Filter, Einsetzen nur des Namens, Rückfall ohne Leserecht', async () => {
  const gelesen = [];
  const f = arbeitsplatz({ runner: { ordner: ORDNER_RUNNER(gelesen) } });
  const { w, d, g, st } = f;
  try {
    await bis(() => g('titel').textContent === 'Haupt');
    const e = g('eingabe');
    tippe(w, e, 'Lies @');
    await bis(() => !g('menue').hidden && punkteNamen(d).length === 9 - 0 || punkteNamen(d).length > 0);
    assert.deepEqual(punkteNamen(d), ['src/', 'docs/', 'node_modules/', 'README.md', 'notizen alt.txt', '<b>fett</b>.txt'], 'Ordner zuerst, dann Dateien, in der Reihenfolge des Runners');
    assert.ok(st.aufrufe.some((a) => a.url === '/api/ordner?pfad=%2Fprobe%2Fstandard&dateien=1'), 'GET /api/ordner?pfad=<Arbeitsordner>&dateien=1');
    assert.equal(g('menue').getAttribute('role'), 'listbox');
    assert.equal(e.getAttribute('role'), 'combobox');
    assert.equal(e.getAttribute('aria-expanded'), 'true');
    assert.equal(e.getAttribute('aria-activedescendant'), 'mp0');
    assert.equal(d.querySelector('#menue [role="option"][aria-selected="true"]').id, 'mp0');
    // Namen nur als Text: kein Element aus einem Dateinamen
    assert.equal(g('menue').querySelector('b'), null);
    assert.ok(punkteNamen(d).includes('<b>fett</b>.txt'));
    // Pfeile, rundum
    taste(w, e, 'ArrowDown');
    assert.equal(e.getAttribute('aria-activedescendant'), 'mp1');
    taste(w, e, 'ArrowUp');
    taste(w, e, 'ArrowUp');
    assert.equal(e.getAttribute('aria-activedescendant'), 'mp5', 'von oben rundum nach unten');
    // Esc schließt, ohne den Text zu ändern
    taste(w, e, 'Escape');
    assert.equal(g('menue').hidden, true);
    assert.equal(e.getAttribute('aria-expanded'), 'false');
    assert.equal(e.value, 'Lies @');
    // Filter durch Weitertippen (unscharf, Groß/Klein egal), Enter setzt @Name und ein Leerzeichen
    tippe(w, e, 'Lies @readme');
    await bis(() => punkteNamen(d)[0] === 'README.md');
    taste(w, e, 'Enter');
    assert.equal(e.value, 'Lies @README.md ');
    assert.equal(g('menue').hidden, true);
    assert.equal(POSTS(st).length, 0, 'Enter in der Auswahl sendet nicht');
    // Leerzeichen im Namen: Anführungszeichen
    tippe(w, e, '@notizen');
    await bis(() => punkteNamen(d)[0] === 'notizen alt.txt');
    taste(w, e, 'Tab');
    assert.equal(e.value, '@"notizen alt.txt" ');
    // ein Ordner: hinein statt einsetzen, die Liste bleibt offen und lädt den Inhalt (lazy)
    tippe(w, e, '@sr');
    await bis(() => punkteNamen(d)[0] === 'src/');
    taste(w, e, 'Enter');
    assert.equal(e.value, '@src/');
    await bis(() => punkteNamen(d).join() === 'src/app.js,src/util.js');
    assert.ok(gelesen.includes('/probe/standard/src'));
    const mp = d.querySelector('#menue [role="option"]:nth-of-type(2)');
    mp.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    assert.equal(e.value, '@src/util.js ', 'Maus wählt');
    // Suche über Unterordner ohne Schrägstrich: die Unterordner werden nachgeladen (node_modules nie)
    tippe(w, e, 'Sieh @anleit');
    await bis(() => punkteNamen(d).includes('docs/anleitung.md'));
    assert.ok(!gelesen.includes('/probe/standard/node_modules'), 'node_modules wird nie von selbst geladen');
    taste(w, e, 'Escape');
    // ein @ mitten im Wort öffnet nichts
    tippe(w, e, 'mail a@b');
    assert.equal(g('menue').hidden, true);
    // Senden: nur der Name geht mit, kein Dateiinhalt, kein Lesen der Datei
    tippe(w, e, 'Lies @readme');
    await bis(() => punkteNamen(d)[0] === 'README.md');
    taste(w, e, 'Enter');
    taste(w, e, 'Enter');
    await bis(() => POSTS(st).length === 1);
    assert.equal(POSTS(st)[0].koerper.text, 'Lies @README.md');
    assert.ok(!st.aufrufe.some((a) => /\/api\/datei/.test(a.url)), 'die Auswahl liest keine Dateien');
  } finally {
    f.schliesse();
  }
});

dom('@-Auswahl: kann der Runner den Ordner nicht lesen (außerhalb der Wurzeln), kommen die berührten Dateien der Sitzung mit Hinweis', async () => {
  const entries = verlaufMit(['write', { path: '/probe/standard/neu.txt', content: 'a\n' }], ['read', { path: 'src/x.js' }, 'eins\n']);
  const f = arbeitsplatz({ runner: { ordner: () => [403, { ok: false, fehler: 'ausserhalb' }] }, ansicht: (id) => ({ entries: id === 1 ? entries : [] }) });
  const { w, d, g } = f;
  try {
    await bis(() => !g('aenderungenKnopf').hidden);
    tippe(w, g('eingabe'), '@');
    await bis(() => !g('menue').hidden && punkteNamen(d).length === 2);
    assert.deepEqual(punkteNamen(d), ['neu.txt', 'src/x.js']);
    assert.match(g('menue').querySelector('.menue-hinweis').textContent, /außerhalb dessen, was der Runner freigibt.*berührt/);
    tippe(w, g('eingabe'), '@x.js');
    await bis(() => punkteNamen(d).join() === 'src/x.js').catch((x) => { throw new Error(x.message + g('menue').textContent + '|' + g('menue').hidden); });
    taste(w, g('eingabe'), 'Enter');
    assert.equal(g('eingabe').value, '@src/x.js ');
    // ohne jede Datei: nur der Hinweis, kein Absturz
    const f2 = arbeitsplatz({ runner: { ordner: () => [404, { ok: false, fehler: 'unbekannt' }] } });
    try {
      await bis(() => f2.g('titel').textContent === 'Haupt');
      tippe(f2.w, f2.g('eingabe'), '@');
      await bis(() => !f2.g('menue').hidden);
      assert.equal(punkteNamen(f2.d).length, 0);
      assert.match(f2.g('menue').textContent, /nicht lesen/);
      assert.equal(f2.g('eingabe').hasAttribute('aria-activedescendant'), false);
    } finally {
      f2.schliesse();
    }
  } finally {
    f.schliesse();
  }
});

const BEFEHLE = [
  { name: 'hilfe', beschreibung: 'Zeigt die Befehle dieses Gesprächs', argumente: null, art: 'anzeige', aliase: ['help'] },
  { name: 'verdichten', beschreibung: 'Verdichtet den Kontext', argumente: '[Hinweis]', art: 'verlauf', aliase: ['compact'] },
  { name: 'modell', beschreibung: 'Zeigt die Modelle oder wechselt das Modell', argumente: '[modell|standard]', art: 'modell', aliase: [] },
  { name: 'stopp', beschreibung: 'Bricht den laufenden Zug ab', argumente: null, art: 'bruecke', aliase: ['abbrechen'] },
  { name: 'settings', beschreibung: 'Pi: Einstellungsmenü', argumente: null, art: 'terminal', aliase: [] },
  { name: 'skill:pruefen', beschreibung: 'Prüft etwas', argumente: '[Text]', art: 'skill', aliase: [] },
];

dom('/-Liste: die Befehle des Runners (GET /api/befehle) mit Beschreibung, Filter, Tab/Enter, Terminalbefehle fehlen; Befehle gehen als Nachricht an den Runner, Unbekanntes als Text', async () => {
  const f = arbeitsplatz({
    befehle: BEFEHLE,
    nachricht: (k) => (/^\/stopp$/.test(k.text) ? { ok: true, id: null, art: k.art, befehl: { name: 'stopp', ok: true, text: 'Kein Zug läuft.', aktion: null } } : { ok: true, id: 7, art: k.art }),
  });
  const { w, d, g, st } = f;
  try {
    await bis(() => g('titel').textContent === 'Haupt');
    const e = g('eingabe');
    tippe(w, e, '/');
    await bis(() => !g('menue').hidden && punkteNamen(d).length > 0);
    assert.deepEqual(punkteNamen(d), ['/hilfe', '/modell', '/stopp', '/verdichten', '/skill:pruefen'], 'alphabetisch, Skills zuletzt, kein /settings');
    assert.ok(st.aufrufe.some((a) => a.url === '/api/befehle?gespraech=1'), 'die Befehle gehören zur Sitzung');
    const hilfe = [...d.querySelectorAll('#menue [role="option"]')].map((x) => x.textContent);
    assert.match(hilfe[3], /\[Hinweis\].*Verdichtet den Kontext/);
    assert.match(hilfe[4], /Skill/);
    assert.equal(g('menue').getAttribute('aria-label'), 'Befehle');
    // Tippen filtert
    tippe(w, e, '/ver');
    await bis(() => punkteNamen(d).join() === '/verdichten');
    taste(w, e, 'Tab');
    assert.equal(e.value, '/verdichten ');
    // Enter bei einem Befehl mit Argument ergänzt nur
    tippe(w, e, '/modell');
    await bis(() => punkteNamen(d)[0] === '/modell');
    taste(w, e, 'Enter');
    assert.equal(e.value, '/modell ');
    assert.equal(POSTS(st).length, 0);
    // ein vollständig getippter Befehl ohne Argument wird gesendet, über denselben Weg wie jede Nachricht
    tippe(w, e, '/stopp');
    await bis(() => punkteNamen(d)[0] === '/stopp');
    taste(w, e, 'Enter');
    await bis(() => POSTS(st).length === 1);
    assert.equal(POSTS(st)[0].url, '/api/gespraech/1/nachricht');
    assert.equal(POSTS(st)[0].koerper.text, '/stopp');
    assert.equal(e.value, '');
    assert.equal(d.querySelectorAll('.mensch.queued, .user.queued').length, 0);
    // Alias findet den Befehl
    tippe(w, e, '/compact');
    await bis(() => punkteNamen(d).join() === '/verdichten');
    taste(w, e, 'Escape');
    // Unbekannter Befehl: Text wie jeder andere
    tippe(w, e, '/gibtsnicht hallo');
    assert.equal(g('menue').hidden, true);
    taste(w, e, 'Enter');
    await bis(() => POSTS(st).length === 2);
    assert.equal(POSTS(st)[1].koerper.text, '/gibtsnicht hallo');
    // /verdichten geht NICHT über den alten Sonderweg
    tippe(w, e, '/verdichten');
    await bis(() => punkteNamen(d)[0] === '/verdichten');
    taste(w, e, 'Enter');
    taste(w, e, 'Enter');
    await bis(() => POSTS(st).length === 3);
    assert.ok(!st.aufrufe.some((a) => a.url === '/api/gespraech/1/verdichten'), 'der Runner wertet den Befehl aus');
    // mitten im Satz kein Menü
    tippe(w, e, 'der Pfad /usr');
    assert.equal(g('menue').hidden, true);
    // das Ergebnis eines Befehls steht als Hinweis im Verlauf (Eintrag fyos.befehl)
    w.__chat.adapter.replay([{ id: 900, kind: 'fyos.befehl', data: { name: 'stopp', ok: false, text: 'Kein Zug läuft.\nZweite Zeile' } }], false);
    await bis(() => d.querySelector('.notiz.befehl.fehler'));
    assert.equal(d.querySelector('.notiz.befehl.fehler').textContent, '/stopp: Kein Zug läuft.\nZweite Zeile');
  } finally {
    f.schliesse();
  }
});

dom('/-Liste bei einem älteren Runner (kein GET /api/befehle): die vier Grundbefehle, ausgeführt über die alten Wege', async () => {
  const f = arbeitsplatz({});
  const { w, d, g, st } = f;
  try {
    await bis(() => g('titel').textContent === 'Haupt');
    tippe(w, g('eingabe'), '/');
    await bis(() => punkteNamen(d).length === 4);
    assert.deepEqual(punkteNamen(d), ['/abbrechen', '/abzweigen', '/leeren', '/verdichten']);
    tippe(w, g('eingabe'), '/verdichten');
    await bis(() => punkteNamen(d)[0] === '/verdichten');
    taste(w, g('eingabe'), 'Enter');
    await bis(() => st.aufrufe.some((a) => a.url === '/api/gespraech/1/verdichten'));
    assert.equal(POSTS(st).length, 0, 'kein Befehl als Nachricht an einen Runner, der sie nicht kennt');
  } finally {
    f.schliesse();
  }
});

const dateiMit = (w, name, inhalt, extra) => {
  const f = new w.File([inhalt], name, extra);
  return f;
};
const wahlDateien = (w, d, dateien) => {
  const wahl = d.getElementById('anhangWahl');
  Object.defineProperty(wahl, 'files', { configurable: true, value: dateien });
  wahl.dispatchEvent(new w.Event('change', { bubbles: true }));
};

dom('Anhänge: Büroklammer, Einfügen und Ziehen; Chips mit Entfernen; Textdatei wird eingebettet, Binär/Bild/zu groß abgelehnt; Namen nur als Text', async () => {
  const f = arbeitsplatz({});
  const { w, d, g, st } = f;
  try {
    await bis(() => g('titel').textContent === 'Haupt');
    assert.equal(g('anhaenge').hidden, true);
    assert.equal(g('anhangKnopf').getAttribute('aria-label'), 'Datei anhängen');
    // Büroklammer öffnet den Dialog des Systems (das <input type="file">)
    let geklickt = 0;
    g('anhangWahl').addEventListener('click', () => (geklickt += 1));
    g('anhangKnopf').click();
    assert.equal(geklickt, 1);
    wahlDateien(w, d, [dateiMit(w, '<img src=x onerror=alert(1)>.txt', 'Zeile eins\n```\nZaun\n```\n'), dateiMit(w, 'foto.png', 'x', { type: 'image/png' }), dateiMit(w, 'roh.bin', new Uint8Array([1, 0, 2])), dateiMit(w, 'gross.txt', 'a'.repeat(110 * 1024))]);
    await bis(() => g('anhaenge').querySelectorAll('.anhang-chip').length === 1);
    assert.equal(g('anhaenge').hidden, false);
    assert.equal(g('anhaenge').querySelector('img'), null, 'ein Dateiname wird nie zu HTML');
    assert.equal(g('anhaenge').querySelector('.anhang-name').textContent, '<img src=x onerror=alert(1)>.txt');
    await bis(() => !g('anhangMeldung').hidden);
    const meldung = g('anhangMeldung').textContent;
    assert.match(meldung, /foto\.png: Bilder nimmt der Runner heute nicht an/);
    assert.match(meldung, /roh\.bin: Das ist eine Binärdatei/);
    assert.match(meldung, /gross\.txt: Zu groß/);
    // Einfügen aus der Zwischenablage (Datei), Text bleibt gewöhnliches Einfügen
    const einfuegen = (dateien) => {
      const ev = new w.Event('paste', { bubbles: true, cancelable: true });
      ev.clipboardData = { files: dateien };
      g('eingabe').dispatchEvent(ev);
      return ev;
    };
    assert.equal(einfuegen([]).defaultPrevented, false, 'ohne Datei bleibt es gewöhnliches Einfügen');
    const ev = einfuegen([dateiMit(w, 'zweite.md', '# Titel')]);
    assert.equal(ev.defaultPrevented, true);
    await bis(() => g('anhaenge').querySelectorAll('.anhang-chip').length === 2);
    // Ziehen: nur Dateien, der Rahmen zeigt es an
    const ziehen = (art, dateien, typen) => {
      const e = new w.Event(art, { bubbles: true, cancelable: true });
      e.dataTransfer = { types: typen || ['Files'], files: dateien || [] };
      g('eingabeForm').dispatchEvent(e);
      return e;
    };
    assert.equal(ziehen('dragover').defaultPrevented, true);
    assert.equal(g('eingabeForm').classList.contains('zieht'), true);
    assert.equal(ziehen('dragover', [], ['text/plain']).defaultPrevented, false, 'Text ziehen bleibt wie es war');
    ziehen('drop', [dateiMit(w, 'dritte.txt', 'drei')]);
    assert.equal(g('eingabeForm').classList.contains('zieht'), false);
    await bis(() => g('anhaenge').querySelectorAll('.anhang-chip').length === 3);
    // Entfernen
    const weg = g('anhaenge').querySelector('.anhang-chip[data-id="2"] .anhang-weg');
    assert.equal(weg.getAttribute('aria-label'), 'Anhang zweite.md entfernen');
    weg.click();
    assert.deepEqual([...g('anhaenge').querySelectorAll('.anhang-name')].map((x) => x.textContent), ['<img src=x onerror=alert(1)>.txt', 'dritte.txt']);
    // Senden: Satz plus eingebettete Dateien in EINER Nachricht, danach sind die Chips weg
    tippe(w, g('eingabe'), 'Bitte lesen');
    taste(w, g('eingabe'), 'Enter');
    await bis(() => POSTS(st).length === 1);
    const text = POSTS(st)[0].koerper.text;
    assert.match(text, /^Bitte lesen\n\nAngehängte Dateien \(2, als Text eingebettet, Stand beim Anhängen\):/);
    assert.match(text, /Datei: dritte\.txt \(4 B\)\n```\ndrei\n```/);
    assert.match(text, /````\nZeile eins\n```\nZaun\n```\n````/, 'der Zaun ist länger als die Zäune im Inhalt');
    assert.equal(g('anhaenge').hidden, true);
    assert.equal(g('eingabe').value, '');
    // nur Anhang, kein Satz: geht auch
    wahlDateien(w, d, [dateiMit(w, 'allein.txt', 'nur Datei')]);
    await bis(() => g('anhaenge').querySelectorAll('.anhang-chip').length === 1);
    taste(w, g('eingabe'), 'Enter');
    await bis(() => POSTS(st).length === 2);
    assert.match(POSTS(st)[1].koerper.text, /^Angehängte Datei \(als Text eingebettet/);
  } finally {
    f.schliesse();
  }
});

dom('Anhänge: höchstens 5 und 30 000 Zeichen zusammen; ein Fehler beim Senden stellt Text und Chips wieder her; ein Chip gehört zur Sitzung', async () => {
  const f = arbeitsplatz({ nachricht: () => ({ status: 500, fehler: 'kaputt' }) });
  const { w, d, g, st } = f;
  try {
    await bis(() => g('titel').textContent === 'Haupt');
    wahlDateien(w, d, ['1', '2', '3', '4', '5', '6'].map((n) => dateiMit(w, `d${n}.txt`, `Inhalt ${n}`)));
    await bis(() => g('anhaenge').querySelectorAll('.anhang-chip').length === 5);
    assert.match(g('anhangMeldung').textContent, /d6\.txt: Höchstens 5 Anhänge/);
    g('anhaenge').querySelectorAll('.anhang-weg').forEach((b) => b.click());
    assert.equal(g('anhaenge').querySelectorAll('.anhang-chip').length, 0);
    wahlDateien(w, d, [dateiMit(w, 'a.txt', 'a'.repeat(20000)), dateiMit(w, 'b.txt', 'b'.repeat(20000))]);
    await bis(() => g('anhaenge').querySelectorAll('.anhang-chip').length === 1 && /b\.txt/.test(g('anhangMeldung').textContent));
    assert.match(g('anhangMeldung').textContent, /b\.txt: Alle Anhänge zusammen dürfen höchstens/);
    // Satz so lang, dass es mit dem Anhang nicht mehr in eine Nachricht passt: nichts wird gesendet, nichts geht verloren
    tippe(w, g('eingabe'), 'x'.repeat(19000));
    taste(w, g('eingabe'), 'Enter');
    assert.match(g('anhangMeldung').textContent, /zu lang/);
    assert.equal(POSTS(st).length, 0);
    assert.equal(g('eingabe').value.length, 19000);
    // Fehler beim Senden: Text und Chip kommen zurück
    tippe(w, g('eingabe'), 'kurz');
    taste(w, g('eingabe'), 'Enter');
    await bis(() => POSTS(st).length === 1);
    await bis(() => g('eingabe').value === 'kurz');
    assert.equal(g('anhaenge').querySelectorAll('.anhang-chip').length, 1, 'der Anhang ist wieder da');
    // Sitzungswechsel: der Chip bleibt bei seiner Sitzung
    await w.__arbeitsplatz.wechsle(2);
    await bis(() => g('titel').textContent === 'Zweite');
    assert.equal(g('anhaenge').querySelectorAll('.anhang-chip').length, 0);
    await w.__arbeitsplatz.wechsle(1);
    await bis(() => g('titel').textContent === 'Haupt');
    assert.equal(g('anhaenge').querySelectorAll('.anhang-chip').length, 1);
  } finally {
    f.schliesse();
  }
});

const MODELLE = [
  { id: 'rhea', provider: 'probe', name: 'Modell A (rhea)', max: false, contextWindow: 262144 },
  { id: 'rhea-max', provider: 'probe', name: 'Modell A (rhea-max, Vorfahrt)', max: true, contextWindow: 262144 },
];
const mitModell = { modelle: MODELLE, ansicht: (id) => ({ entries: [], agent: { model: { provider: 'probe', modelId: 'rhea' } } }) };

dom('Modell-Wähler: zeigt das Modell der Sitzung, die Liste kommt aus GET /api/modelle, Wechsel per PATCH mit modell, Anzeige zieht nach, Tastatur und Esc', async () => {
  const f = arbeitsplatz(mitModell);
  const { w, d, g, st } = f;
  try {
    await bis(() => g('modell').textContent === 'Modell A (rhea)');
    assert.equal(g('modell').getAttribute('aria-haspopup'), 'listbox');
    assert.equal(g('modell').disabled, false);
    g('modell').click();
    assert.equal(g('modellMenue').hidden, false);
    assert.equal(g('modell').getAttribute('aria-expanded'), 'true');
    const opts = [...g('modellMenue').querySelectorAll('[role="option"]')];
    assert.deepEqual(opts.map((o) => o.querySelector('.text').firstChild.textContent), ['Modell A (rhea)', 'Modell A (rhea-max, Vorfahrt)', 'Standard des Runners']);
    assert.deepEqual(opts.map((o) => o.getAttribute('aria-selected')), ['true', 'false', 'false']);
    assert.equal(d.activeElement, g('modellMenue'), 'der Fokus liegt in der Liste');
    taste(w, g('modellMenue'), 'ArrowDown');
    assert.equal(g('modellMenue').getAttribute('aria-activedescendant'), opts[1].id);
    taste(w, g('modellMenue'), 'Escape');
    assert.equal(g('modellMenue').hidden, true);
    assert.equal(d.activeElement, g('modell'), 'Esc gibt den Fokus zurück');
    assert.equal(st.aufrufe.filter((a) => a.methode === 'PATCH').length, 0);
    // Pfeil unten am Knopf öffnet; Enter wählt
    taste(w, g('modell'), 'ArrowDown');
    assert.equal(g('modellMenue').hidden, false);
    taste(w, g('modellMenue'), 'ArrowDown');
    taste(w, g('modellMenue'), 'Enter');
    await bis(() => st.aufrufe.some((a) => a.methode === 'PATCH'));
    const patch = st.aufrufe.find((a) => a.methode === 'PATCH');
    assert.equal(patch.url, '/api/gespraech/1');
    assert.deepEqual(patch.koerper, { modell: 'rhea-max' });
    await bis(() => g('modell').textContent === 'Modell A (rhea-max, Vorfahrt)');
    assert.equal(g('modellFehler').hidden, true);
    // die Liste zeigt den neuen Stand
    g('modell').click();
    assert.deepEqual([...g('modellMenue').querySelectorAll('[role="option"]')].map((o) => o.getAttribute('aria-selected')), ['false', 'true', 'false']);
    // „Standard des Runners“: modell null
    [...g('modellMenue').querySelectorAll('[role="option"]')][2].click();
    await bis(() => st.aufrufe.filter((a) => a.methode === 'PATCH').length === 2);
    assert.deepEqual(st.aufrufe.filter((a) => a.methode === 'PATCH')[1].koerper, { modell: null });
    await bis(() => !g('modell').disabled);
    await warte(150);
  } finally {
    f.schliesse();
  }
});

dom('Modell-Wähler: Fehler des Runners erscheinen als Meldung, das Modell bleibt; ohne Modellliste ist der Knopf gesperrt', async () => {
  const f = arbeitsplatz({ ...mitModell, modellFehler: 'Unbekanntes Modell' });
  const { w, d, g } = f;
  try {
    await bis(() => g('modell').textContent === 'Modell A (rhea)');
    g('modell').click();
    [...g('modellMenue').querySelectorAll('[role="option"]')][1].click();
    await bis(() => !g('modellFehler').hidden);
    assert.match(g('modellFehler').textContent, /Modell nicht gewechselt:.*Unbekanntes Modell/);
    assert.equal(g('modell').textContent, 'Modell A (rhea)');
    assert.equal(g('modell').disabled, false);
  } finally {
    f.schliesse();
  }
  const leer = arbeitsplatz({ ansicht: () => ({ entries: [], agent: { model: { provider: 'probe', modelId: 'rhea' } } }) });
  try {
    await bis(() => leer.g('titel').textContent === 'Haupt' && leer.g('modell').disabled);
    assert.match(leer.g('modell').title, /nennt keine Modelle/);
    leer.g('modell').click();
    assert.equal(leer.g('modellMenue').hidden, true);
  } finally {
    leer.schliesse();
  }
});

dom('Modus-Wähler: nur echte Modi – die Freigabe des Runners als Anzeige, die Art der Nachricht während der Arbeit (Einreihen/Eingreifen) je Sitzung', async () => {
  const f = arbeitsplatz({});
  const { w, d, g, st } = f;
  try {
    await bis(() => g('titel').textContent === 'Haupt');
    assert.equal(g('modus').textContent, 'Zerstörendes fragt');
    g('modus').click();
    assert.equal(g('modusMenue').hidden, false);
    assert.equal(g('modusMenue').getAttribute('role'), 'listbox');
    const opts = [...g('modusMenue').querySelectorAll('[role="option"]')];
    assert.equal(opts.length, 3);
    assert.match(opts[0].textContent, /nur Zerstörendes fragt/);
    assert.equal(opts[0].getAttribute('aria-disabled'), 'true', 'die Freigabe ist Konfiguration des Runners, hier nicht wählbar');
    assert.ok(!/Jede Aktion fragen|umgehen/i.test(g('modusMenue').textContent), 'kein erfundener Modus');
    assert.deepEqual(opts.map((o) => o.getAttribute('aria-selected')), ['true', 'true', 'false']);
    // ein gesperrter Punkt lässt sich nicht wählen
    opts[0].click();
    assert.equal(g('modusMenue').hidden, false);
    opts[2].click();
    assert.equal(g('modusMenue').hidden, true);
    assert.match(g('modus').textContent, /greift ein/);
    // Nachricht in dieser Sitzung geht als „steuern“, in der anderen weiter als „folgen“
    tippe(w, g('eingabe'), 'jetzt');
    taste(w, g('eingabe'), 'Enter');
    await bis(() => POSTS(st).length === 1);
    assert.equal(POSTS(st)[0].koerper.art, 'steuern');
    await w.__arbeitsplatz.wechsle(2);
    await bis(() => g('titel').textContent === 'Zweite');
    assert.equal(g('modus').textContent, 'Zerstörendes fragt');
    tippe(w, g('eingabe'), 'später');
    taste(w, g('eingabe'), 'Enter');
    await bis(() => POSTS(st).length === 2);
    assert.equal(POSTS(st)[1].koerper.art, 'folgen');
    // Esc schließt
    g('modus').click();
    taste(w, g('modusMenue'), 'Escape');
    assert.equal(g('modusMenue').hidden, true);
    await warte(250);
  } finally {
    f.schliesse();
  }
});

test('Eingabe: Quelltext – Namen nur über textContent, neutral formuliert, jede Brücken-Anfrage kommt aus der Liste der erlaubten Befehle der Seite', () => {
  const neu = ['eingabe.js', 'anhaenge.js', 'waehler.js', 'modus.js'].map(lies).join('\n');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(neu), 'Namen und Inhalte nur über textContent');
  const verboten = new RegExp(['gin', 'ny|perse', 'phone|ti', 'tan|rh', 'ea|sirf', 'yyn|/Users/'].join(''), 'i');
  const html = lies('chat.html');
  assert.ok(!verboten.test(neu + html + lies('arbeitsplatz.css')), 'kein Agenten-, Rechner- oder Pfadname im Quelltext');
  // Die Seite hat nur die Befehle ihrer Capability (Datei lesen geht über die File-API des WebViews, nicht über Rust)
  const kap = JSON.parse(fs.readFileSync(path.join(HIER, '..', 'app', 'capabilities', 'agent-chat.json'), 'utf8'));
  const erlaubt = new Set(kap.permissions.filter((p) => p.startsWith('allow-')).map((p) => p.slice(6).replace(/-/g, '_')));
  const alle = fs.readdirSync(UI).filter((n) => n.endsWith('.js') && !/^e2e/.test(n)).map(lies).join('\n');
  const benutzt = new Set([...alle.matchAll(/invoke\('([a-z_]+)'/g)].map((m) => m[1]).concat([...alle.matchAll(/tauriInvoke\('([a-z_]+)'/g)].map((m) => m[1])));
  for (const b of benutzt) assert.ok(erlaubt.has(b), `Befehl ${b} steht nicht in der Capability agent-chat`);
  assert.ok(!/plugin:dialog|plugin-dialog|plugin:fs|__TAURI_PLUGIN|readFile|readTextFile/.test(alle), 'kein Dialog- oder Dateisystem-Plugin');
  assert.ok(!kap.permissions.some((p) => /dialog|fs:|shell|opener/.test(p)), 'die Capability bekommt keine Datei- oder Dialogrechte');
  // eingebunden, in der richtigen Reihenfolge
  for (const n of ['waehler.js', 'modus.js', 'eingabe.js', 'anhaenge.js']) assert.ok(html.includes(`src="${n}"`), n);
  assert.ok(html.indexOf('src="waehler.js"') < html.indexOf('src="modus.js"') && html.indexOf('src="anhaenge.js"') < html.indexOf('src="chat.js"'));
  for (const id of ['anhaenge', 'anhangKnopf', 'anhangWahl', 'anhangMeldung', 'modellMenue', 'modellFehler', 'modusMenue']) assert.ok(html.includes(`id="${id}"`), id);
  // das Aufrufen von Befehlen geht nur durch die Nachricht
  assert.ok(!/\/api\/befehle'[^)]*'POST'/.test(lies('echt.js')), 'Befehle werden nicht an einen eigenen Weg geschickt');
});
