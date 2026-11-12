// Palette (Cmd/Strg+K), Paket B3 in FYOS-AGENT-LOKAL-PLAN: ein Feld, das zu Sitzungen, Dateien, Befehlen, Skills, Hub-Werkzeugen und Handgriffen
// führt (palette.js, palette.css). jsdom wie in ui_agent.test.mjs: über FYOS_JSDOM_DIR (Ordner mit node_modules/jsdom) oder ein benachbartes
// fyos-web.
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

// --- ohne Fenster ---------------------------------------------------------------------------------------------------------

test('Bewertung: alle Wörter müssen vorkommen; Anfang vor Teilanfang vor Mitte vor Zusatz; kürzere Namen vorn', () => {
  const { bewerte } = logik('palette.js').palette;
  assert.equal(bewerte('', 'irgendwas'), 1, 'ohne Eingabe passt alles gleich');
  assert.equal(bewerte('xyz', 'Hub antwortet langsam', 'fyos'), 0);
  assert.equal(bewerte('hub fehlt', 'Hub antwortet langsam'), 0, 'ein Wort fehlt');
  const anfang = bewerte('hub', 'Hub antwortet langsam');
  const teil = bewerte('hub', 'src/hub.js');
  const mitte = bewerte('hub', 'github');
  const zusatz = bewerte('hub', 'Werkzeugsuche', 'sucht im Hub');
  assert.ok(anfang > teil && teil > mitte && mitte > zusatz && zusatz > 0, `${anfang} ${teil} ${mitte} ${zusatz}`);
  assert.ok(bewerte('a', 'ab') > bewerte('a', 'a'.repeat(60)), 'kürzer steht vorn');
  assert.ok(bewerte('HUB Langsam', 'Hub antwortet langsam') > 0, 'Groß und klein gleich, zwei Wörter');
});

test('Eingabe: ein Vorzeichen engt auf Gruppen ein', () => {
  const { zerlege } = logik('palette.js').palette;
  assert.deepEqual(kopie(zerlege('  hub ')), { text: 'hub', gruppen: null });
  assert.deepEqual(kopie(zerlege('> leiste')), { text: 'leiste', gruppen: ['aktion'] });
  assert.deepEqual(kopie(zerlege('@src/a')), { text: 'src/a', gruppen: ['datei'] });
  assert.deepEqual(kopie(zerlege('/skill')), { text: 'skill', gruppen: ['befehl', 'skill'] });
  assert.deepEqual(kopie(zerlege('#hub')), { text: 'hub', gruppen: ['werkzeug'] });
  assert.deepEqual(kopie(zerlege(null)), { text: '', gruppen: null });
});

test('Liste: feste Reihenfolge der Gruppen, je Gruppe die besten; ohne Eingabe nur Handgriffe und Sitzungen', () => {
  const { ordne, GRUPPEN } = logik('palette.js').palette;
  const viele = (n, vor) => Array.from({ length: n }, (_, i) => ({ name: `${vor}${i}`, wahl() {} }));
  const e = {
    aktion: [{ name: 'Neue Sitzung', wahl() {} }, { name: 'Hub-Zustand zeigen', wahl() {} }],
    sitzung: [{ name: 'Github-Aktionen' }, { name: 'Hub antwortet langsam', rechts: 'fyos' }],
    datei: [{ name: 'src/hub.js' }, { name: 'README.md' }],
    befehl: [{ name: '/hilfe', zusatz: 'zeigt alle Befehle' }],
    skill: [{ name: '/skill:hub-zuerst', zusatz: 'erst im Hub suchen' }],
    werkzeug: viele(20, 'hub.w'),
    verlauf: [{ name: 'der Hub war langsam', rechts: 'gestern' }],
  };
  assert.deepEqual(kopie(ordne('', e).map((z) => [z.art, z.name])), [['aktion', 'Neue Sitzung'], ['aktion', 'Hub-Zustand zeigen'], ['sitzung', 'Github-Aktionen'], ['sitzung', 'Hub antwortet langsam']]);
  const z = ordne('hub', e);
  assert.deepEqual(kopie([...new Set(z.map((x) => x.art))]), ['aktion', 'sitzung', 'datei', 'skill', 'werkzeug', 'verlauf'], 'Befehl /hilfe passt nicht und fehlt');
  assert.deepEqual(kopie(z.filter((x) => x.art === 'sitzung').map((x) => x.name)), ['Hub antwortet langsam', 'Github-Aktionen'], 'beste zuerst');
  assert.deepEqual(kopie(z.filter((x) => x.art === 'datei').map((x) => x.name)), ['src/hub.js', 'README.md'], 'Antworten des Runners bleiben, auch ohne Wort im Namen');
  assert.equal(z.filter((x) => x.art === 'werkzeug').length, GRUPPEN.find((g) => g[0] === 'werkzeug')[2]);
  assert.equal(z.find((x) => x.art === 'sitzung').titel, 'Sitzung');
  assert.equal(z.find((x) => x.art === 'werkzeug').titel, 'Hub');
  assert.equal(ordne('#hub', e).length, 20, 'mit Vorzeichen mehr Zeilen der einen Gruppe');
  assert.deepEqual(kopie(ordne('/', e).map((x) => x.name)), ['/hilfe', '/skill:hub-zuerst']);
  assert.deepEqual(kopie(ordne('hub', { sitzung: [null, { name: '' }, { name: 5 }, { name: 'Hub' }] }).map((x) => x.name)), ['Hub'], 'Unbrauchbares fällt weg');
});

test('Quelltext: kein eigenes Netz, kein HTML aus Text, keine Signalfarbe im Stil', () => {
  const js = lies('palette.js');
  assert.doesNotMatch(js, /\bfetch\(|XMLHttpRequest|innerHTML|insertAdjacentHTML|document\.write|transport\.api/);
  assert.doesNotMatch(lies('palette.css'), /--akzent/);
});

// --- mit Fenster ----------------------------------------------------------------------------------------------------------

function palette(extra = {}) {
  const d = new jsdom.JSDOM('<!doctype html><body><textarea id="eingabe"></textarea><div id="palette" hidden></div></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = d.window;
  w.eval(lies('palette.js'));
  const dok = w.document;
  const z = { gewaehlt: [], fragen: [], fehler: [], befehleGelesen: 0 };
  const opts = {
    verzoegerungMs: 0,
    aktionen: () => [
      { name: 'Neue Sitzung', rechts: '⌘⇧O', wahl: () => z.gewaehlt.push(['aktion', 'neu']) },
      { name: 'Einstellungen', wahl: () => z.gewaehlt.push(['aktion', 'einstellungen']) },
    ],
    sitzungen: () => [
      { id: 1, titel: 'Hub antwortet langsam', ort: 'fyos', angepinnt: true },
      { id: 2, titel: BOESE, ort: 'x' },
      { id: 3, titel: 'Altes', archiviert: true },
    ],
    beiSitzung: (id) => z.gewaehlt.push(['sitzung', id]),
    dateien: async (q) => {
      z.fragen.push(['datei', q]);
      return { treffer: [{ relativ: `src/${q}.js`, name: `${q}.js` }] };
    },
    beiDatei: (r) => z.gewaehlt.push(['datei', r]),
    befehle: async () => {
      z.befehleGelesen += 1;
      return [
        { name: 'hilfe', beschreibung: 'zeigt alle Befehle', art: 'anzeige' },
        { name: 'skill:hub-zuerst', beschreibung: 'erst im Hub suchen', art: 'skill' },
        { name: 'shell', beschreibung: 'nur im Terminal', art: 'terminal' },
      ];
    },
    beiBefehl: (n) => z.gewaehlt.push(['befehl', n]),
    werkzeuge: async (q) => {
      z.fragen.push(['werkzeug', q]);
      return [{ name: 'hub.search_tools', beschreibung: 'Werkzeuge suchen' }];
    },
    beiWerkzeug: (n) => z.gewaehlt.push(['werkzeug', n]),
    verlauf: async (q) => {
      z.fragen.push(['verlauf', q]);
      return { treffer: [{ id: 3, titel: 'Altes', auszug: `… ${q} …` }] };
    },
    beiTreffer: (t) => z.gewaehlt.push(['verlauf', t.id]),
    beiFehler: (t) => z.fehler.push(t),
    ...extra,
  };
  const p = w.FyosPrototyp.palette.createPalette({ wurzel: dok.getElementById('palette') }, opts);
  const feld = () => dok.querySelector('.pal-feld');
  const tippe = (text) => {
    feld().value = text;
    feld().dispatchEvent(new w.Event('input', { bubbles: true }));
  };
  const taste = (key) => {
    const e = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    feld().dispatchEvent(e);
    return e;
  };
  const namen = () => p.zustand().zeilen.map((x) => x.name);
  return { w, dok, p, z, feld, tippe, taste, namen };
}

dom('Öffnen und Schließen: Handgriffe und Sitzungen stehen sofort da, der Fokus liegt im Feld und kehrt zurück', async () => {
  const { dok, p, taste, namen } = palette();
  const wurzel = dok.getElementById('palette');
  dok.getElementById('eingabe').focus();
  assert.equal(wurzel.hidden, true);
  p.oeffne();
  assert.equal(p.offen(), true);
  assert.equal(wurzel.hidden, false);
  assert.equal(dok.activeElement, dok.querySelector('.pal-feld'));
  assert.deepEqual(kopie(namen()), ['Neue Sitzung', 'Einstellungen', 'Hub antwortet langsam', BOESE, 'Altes']);
  assert.equal(dok.querySelector('.pal-kasten').getAttribute('role'), 'dialog');
  assert.equal(dok.querySelector('.pal-liste').getAttribute('role'), 'listbox');
  assert.equal(dok.querySelectorAll('.pal-zeile[role="option"]').length, 5);
  assert.equal(dok.querySelector('.pal-feld').getAttribute('aria-activedescendant'), 'palZeile0');
  assert.equal(dok.querySelector('#palZeile0').getAttribute('aria-selected'), 'true');
  // Ein Titel mit spitzen Klammern bleibt Text
  assert.equal(dok.querySelectorAll('.pal-liste img').length, 0);
  assert.equal(dok.querySelectorAll('.pal-rechts')[2].textContent, 'angepinnt');
  assert.equal(dok.querySelectorAll('.pal-rechts')[4].textContent, 'Archiv');
  const e = taste('Escape');
  assert.equal(e.defaultPrevented, true);
  assert.equal(p.offen(), false);
  assert.equal(wurzel.hidden, true);
  assert.equal(dok.activeElement, dok.getElementById('eingabe'), 'der Fokus ist wieder, wo er war');
});

dom('Tippen, Pfeile, Eingabe: die Liste folgt dem Text, die Wahl schließt und ruft genau einen Rückruf', async () => {
  const { dok, p, z, tippe, taste, namen } = palette();
  p.oeffne();
  tippe('hub');
  await bis(() => !p.zustand().sucht && namen().includes('hub.search_tools'));
  assert.deepEqual(kopie(p.zustand().zeilen.map((x) => x.art)), ['sitzung', 'datei', 'skill', 'werkzeug', 'verlauf']);
  assert.deepEqual(kopie(namen()), ['Hub antwortet langsam', 'src/hub.js', '/skill:hub-zuerst', 'hub.search_tools', '… hub …']);
  taste('ArrowDown');
  assert.equal(p.zustand().gewaehlt, 1);
  assert.equal(dok.querySelector('.pal-zeile.gewaehlt .pal-name').textContent, 'src/hub.js');
  taste('ArrowUp');
  taste('ArrowUp');
  assert.equal(p.zustand().gewaehlt, 4, 'oben hinaus geht es unten weiter');
  taste('ArrowDown');
  taste('ArrowDown');
  taste('Enter');
  assert.equal(p.offen(), false);
  await bis(() => z.gewaehlt.length === 1);
  assert.deepEqual(kopie(z.gewaehlt), [['datei', 'src/hub.js']]);
  // Klick wählt ebenso
  p.oeffne();
  dok.querySelectorAll('.pal-zeile')[1].click();
  await bis(() => z.gewaehlt.length === 2);
  assert.deepEqual(kopie(z.gewaehlt[1]), ['aktion', 'einstellungen']);
  assert.equal(p.offen(), false);
});

dom('Vorzeichen: @ nur Dateien, / Befehle und Skills ohne Terminal-Befehle, # nur Hub-Werkzeuge, > nur Handgriffe', async () => {
  const { p, z, tippe, namen } = palette();
  p.oeffne();
  await bis(() => z.befehleGelesen === 1);
  tippe('@a');
  await bis(() => namen().length === 1 && !p.zustand().sucht);
  assert.deepEqual(kopie(namen()), ['src/a.js']);
  assert.deepEqual(kopie(z.fragen), [['datei', 'a']], 'nur die Dateien wurden gefragt, schon ab einem Zeichen');
  tippe('/');
  assert.deepEqual(kopie(namen()), ['/hilfe', '/skill:hub-zuerst']);
  tippe('#se');
  await bis(() => namen().length === 1 && !p.zustand().sucht);
  assert.deepEqual(kopie(namen()), ['hub.search_tools']);
  tippe('> einst');
  assert.deepEqual(kopie(namen()), ['Einstellungen']);
  tippe('/hilfe');
  p.schliesse();
  p.oeffne('/');
  await bis(() => z.befehleGelesen === 2, 3000);
  assert.equal(z.befehleGelesen, 2, 'die Befehle werden je Öffnen einmal gelesen');
});

dom('Nur die Antwort auf die letzte Eingabe zählt; ein einzelnes Zeichen fragt den Runner nicht', async () => {
  let loese;
  const langsam = new Promise((r) => { loese = r; });
  const { p, z, tippe, namen } = palette({
    dateien: async (q) => {
      z.fragen.push(['datei', q]);
      if (q === 'al') await langsam;
      return { treffer: [{ relativ: `gefunden-${q}.txt`, name: 'x' }] };
    },
    werkzeuge: undefined,
    verlauf: undefined,
  });
  p.oeffne();
  tippe('a');
  await warte(20);
  assert.deepEqual(kopie(z.fragen), [], 'ein Zeichen ohne Vorzeichen fragt nicht');
  tippe('al');
  await bis(() => z.fragen.length === 1);
  assert.equal(p.zustand().sucht, true);
  tippe('alt');
  await bis(() => namen().includes('gefunden-alt.txt'));
  loese();
  await warte(30);
  assert.deepEqual(kopie(namen()), ['Altes', 'gefunden-alt.txt'], 'die späte Antwort auf „al“ ist verworfen');
  assert.equal(p.zustand().sucht, false);
});

dom('Eine Quelle scheitert oder fehlt: die Liste zeigt den Rest, die Fußzeile nennt, was nicht ging; eine gescheiterte Wahl wird gemeldet', async () => {
  const { dok, p, z, tippe, taste, namen } = palette({
    werkzeuge: async () => {
      throw new Error('Hub nicht erreichbar');
    },
    verlauf: async () => null,
    befehle: async () => null,
    aktionen: () => [{ name: 'Kaputt', wahl: () => { throw new Error('ging nicht'); } }, { name: 'ohne Wahl' }, null],
  });
  p.oeffne();
  assert.deepEqual(kopie(namen().slice(0, 1)), ['Kaputt'], 'ein Handgriff ohne Wahl steht nicht da');
  tippe('hub');
  await bis(() => !p.zustand().sucht && namen().includes('src/hub.js'));
  assert.deepEqual(kopie(namen()), ['Hub antwortet langsam', 'src/hub.js']);
  assert.match(dok.querySelector('.pal-lage').textContent, /nicht erreichbar: Hub-Werkzeuge/);
  tippe('zzzz-gibt-es-nicht');
  await bis(() => !p.zustand().sucht && namen().length === 1);
  tippe('> kap');
  taste('Enter');
  await bis(() => z.fehler.length === 1);
  assert.deepEqual(kopie(z.fehler), ['ging nicht']);
  // Nichts gefunden steht als Satz da
  p.oeffne('> gibtesnicht');
  assert.equal(dok.querySelector('.pal-leer').hidden, false);
  assert.equal(dok.querySelector('.pal-leer').textContent, 'Nichts gefunden.');
});

dom('Klick neben den Kasten schließt; Tab bleibt im Feld', async () => {
  const { w, dok, p, taste } = palette();
  p.oeffne();
  assert.equal(taste('Tab').defaultPrevented, true);
  dok.querySelector('.pal-kasten').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.equal(p.offen(), true, 'ein Klick im Kasten schließt nicht');
  dok.getElementById('palette').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.equal(p.offen(), false);
});
