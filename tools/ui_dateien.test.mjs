// Tafel „Dateien“ der Schiene (Rest von Paket B1 in FYOS-AGENT-LOKAL-PLAN): der Ordner der Sitzung als Baum, Suche nach Dateinamen, Klick
// öffnet rechts, „@“ hängt an die Nachricht (dateien-tafel.js, dateien.css, Wege in runner-wege.js). jsdom wie in ui_agent.test.mjs: über
// FYOS_JSDOM_DIR (Ordner mit node_modules/jsdom) oder ein benachbartes fyos-web.
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
const httpFehler = (status, fehler) => Object.assign(new Error(`HTTP ${status}`), { status, fehler });

const ORDNER = '/arbeit/projekt';
const BOESE = '<img src=x onerror=alert(1)>.txt';
/** Der Ordner der Probe: relativer Ordner → Einträge [Name, istOrdner, Größe], in der Reihenfolge des Runners (Ordner zuerst). */
const baumVorlage = () => ({
  '': [['.github', 1], ['docs', 1], ['src', 1], ['.gitignore', 0, 12], [BOESE, 0, 3], ['bild.png', 0, 2048], ['liesmich.md', 0, 300]],
  '.github': [['ci.yml', 0, 9]],
  docs: [],
  src: [['tief', 1], ['a.js', 0, 100], ['b.js', 0, 200]],
  'src/tief': [['c.js', 0, 5]],
});
const eintraege = (liste) => liste.map(([name, ordner, groesse]) => (ordner ? { name, ordner: true } : { name, ordner: false, groesse }));

// --- ohne Fenster ---------------------------------------------------------------------------------------------------------

test('Sicht ohne Fenster: Marken aus den Ständen, Zeilen des Baums, Suche in geladenen Ordnern', () => {
  const D = logik('dateien-tafel.js').dateien;
  const m = D.markenSicht([
    { relativ: 'src/tief/c.js', zustand: 'geaendert' },
    { relativ: 'neu.txt', zustand: 'neu' },
    { relativ: 'weg.txt', zustand: 'geloescht' },
    { relativ: '/ausserhalb/x', zustand: 'geaendert' },
    { relativ: '../oben', zustand: 'neu' },
    null,
  ]);
  assert.deepEqual([...m.dateien], [['src/tief/c.js', 'geaendert'], ['neu.txt', 'neu']]);
  assert.deepEqual([...m.ordner].sort(), ['src', 'src/tief']);
  assert.deepEqual([...D.markenSicht(null).dateien], []);

  const vorlage = baumVorlage();
  const geladen = new Map([
    ['', { phase: 'ok', eintraege: eintraege(vorlage['']), abgeschnitten: true }],
    ['src', { phase: 'ok', eintraege: eintraege(vorlage.src) }],
    ['docs', { phase: 'ok', eintraege: [] }],
    ['.github', { phase: 'fehler', eintraege: [], text: 'gesperrt' }],
  ]);
  const zeilen = D.baumZeilen(geladen, new Set(['src', 'docs', '.github', 'src/tief']), m);
  assert.deepEqual(
    zeilen.map((z) => `${'  '.repeat(z.tiefe)}${z.art === 'ordner' ? (z.offen ? 'v ' : '> ') : z.art === 'hinweis' ? '~ ' : ''}${z.name || z.text}${z.marke ? ` [${z.marke}]` : ''}${z.geaendertDarin ? ' *' : ''}${z.laedt ? ' (lädt)' : ''}`),
    [
      'v .github',
      '  ~ gesperrt',
      'v docs',
      '  ~ leer',
      'v src *',
      '  v tief * (lädt)',
      '  a.js',
      '  b.js',
      '.gitignore',
      BOESE,
      'bild.png',
      'liesmich.md',
      '~ Weitere Einträge sind nicht gezeigt (500 je Ordner).',
    ],
  );
  assert.equal(zeilen.find((z) => z.name === '.gitignore').versteckt, true);
  assert.equal(zeilen.find((z) => z.name === 'a.js').versteckt, false);
  assert.equal(zeilen.find((z) => z.name === 'liesmich.md').groesse, 300);
  // ohne geladene Wurzel gibt es keine Zeile
  assert.deepEqual(D.baumZeilen(new Map(), new Set(), m), []);

  assert.deepEqual(D.sucheGeladen(geladen, 'js', 10), [{ relativ: 'src/a.js', name: 'a.js' }, { relativ: 'src/b.js', name: 'b.js' }]);
  assert.deepEqual(D.sucheGeladen(geladen, 'SRC b', 10), [{ relativ: 'src/b.js', name: 'b.js' }], 'jedes Wort muss im Pfad stehen, Groß und Klein zählen nicht');
  assert.deepEqual(D.sucheGeladen(geladen, 'lies', 10).map((t) => t.relativ), ['liesmich.md']);
  assert.deepEqual(D.sucheGeladen(geladen, '   ', 10), []);
  assert.deepEqual(D.sucheGeladen(geladen, 'tief', 10), [], 'Ordner sind keine Treffer, und src/tief ist nicht geladen');
  assert.deepEqual([D.istBild('a.PNG'), D.istBild('b.jpeg'), D.istBild('c.svg'), D.istBild('png'), D.istBild('')], [true, true, false, false, false]);
});

test('Wege: die Dateiliste bittet um Punkt-Dateien, die Suche wird bereinigt, ein Runner ohne den Weg heißt weg_fehlt', async () => {
  const FP = logik('runner-wege.js');
  const gets = [];
  let antwort = null;
  const wege = FP.wege.createWege({
    api: async (methode, pfad) => {
      gets.push([methode, pfad]);
      if (antwort instanceof Error) throw antwort;
      return antwort;
    },
  });
  antwort = { ok: true, eintraege: [{ name: 'src', ordner: true }, { name: '.gitignore', ordner: false, groesse: 12 }, { name: '' }, null] };
  assert.deepEqual(await wege.ordner('/a/b c'), { eintraege: [{ name: 'src', ordner: true, groesse: null }, { name: '.gitignore', ordner: false, groesse: 12 }], abgeschnitten: false });
  await wege.ordner('/a/b c', { versteckt: true });
  assert.deepEqual(gets, [['GET', '/api/ordner?pfad=%2Fa%2Fb%20c&dateien=1'], ['GET', '/api/ordner?pfad=%2Fa%2Fb%20c&dateien=1&versteckt=1']]);

  antwort = {
    ok: true,
    treffer: [{ relativ: 'src/chat.js', name: 'gelogen.js' }, { relativ: '/etc/passwd' }, { relativ: 'a/../../b' }, { relativ: '' }, null, { relativ: 'liesmich.md' }],
    gesamt: 40,
    gekuerzt: true,
    unvollstaendig: 'ja',
  };
  const r = await wege.dateiSuche(7, 'chat js', { limit: 500 });
  assert.equal(gets.at(-1)[1], '/api/gespraech/7/dateien?q=chat%20js&limit=200');
  assert.deepEqual(r, { treffer: [{ relativ: 'src/chat.js', name: 'chat.js' }, { relativ: 'liesmich.md', name: 'liesmich.md' }], gesamt: 40, gekuerzt: true, unvollstaendig: false });
  antwort = { ok: true };
  await assert.rejects(wege.dateiSuche(7, 'x'), (f) => f.art === 'weg_fehlt');
  antwort = httpFehler(404, 'Unbekannte Route');
  await assert.rejects(wege.dateiSuche(7, 'x'), (f) => f.art === 'weg_fehlt');
  assert.equal(gets.at(-1)[1], '/api/gespraech/7/dateien?q=x&limit=50');
});

// --- mit Fenster ----------------------------------------------------------------------------------------------------------

/**
 * Die Tafel in der echten Seite (ohne die übrigen Skripte), mit einem gestellten Runner: `baum` ist der Ordner (wird gelesen, wie er gerade
 * ist), `suche(q)` antwortet auf die Dateisuche (ohne sie: 404 wie beim vollen Runner), `ordnerFehler(rel)` lässt einen Ordner scheitern.
 */
function tafel({ baum = baumVorlage(), suche, ordnerFehler, ordner = ORDNER, sitzung = 7, sichtbar = true, aktiv = '' } = {}) {
  const html = lies('chat.html');
  const d = new jsdom.JSDOM(html.replace(/<script[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, ''), { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = d.window;
  for (const s of ['runner-wege.js', 'eingabe.js', 'dateien-tafel.js']) w.eval(lies(s));
  const FP = w.FyosPrototyp;
  const dok = w.document;
  const g = (id) => dok.getElementById(id);
  const z = { gets: [], dateien: [], erwaehnt: [], weg: [], baum, ordner, sichtbar, aktiv, halt: null };
  const transport = {
    api: async (methode, pfad) => {
      z.gets.push(pfad);
      if (z.halt) await z.halt;
      const url = new URL(pfad, 'http://runner/');
      if (url.pathname === '/api/ordner') {
        const abs = url.searchParams.get('pfad');
        const rel = abs === ORDNER ? '' : abs.startsWith(`${ORDNER}/`) ? abs.slice(ORDNER.length + 1) : null;
        const f = ordnerFehler ? ordnerFehler(rel, abs) : null;
        if (f) throw f;
        if (rel === null) throw httpFehler(403, 'ausserhalb');
        if (!z.baum[rel]) throw httpFehler(404, 'nicht_gefunden');
        return { ok: true, pfad: abs, eintraege: eintraege(z.baum[rel]), ...(z.baum[rel].abgeschnitten ? { abgeschnitten: true } : {}) };
      }
      if (/^\/api\/gespraech\/[^/]+\/dateien$/.test(url.pathname)) {
        if (!suche) throw httpFehler(404, 'Unbekannte Route');
        const r = await suche(url.searchParams.get('q'), z);
        if (r instanceof Error) throw r;
        return r;
      }
      throw httpFehler(404, 'Unbekannte Route');
    },
  };
  const t = FP.dateien.createDateienTafel(
    { knopf: g('schieneDateien'), ordner: g('dateienOrdner'), suche: g('dateienSuche'), neuKnopf: g('dateienNeu'), baum: g('dateienBaum'), leer: g('dateienLeer'), fuss: g('dateienFuss') },
    {
      wege: FP.wege.createWege(transport),
      gespraech: () => sitzung,
      ordner: () => z.ordner,
      sichtbar: () => z.sichtbar,
      aktiv: () => z.aktiv,
      beiDatei: (x) => z.dateien.push(kopie(x)),
      beiErwaehnen: (rel) => z.erwaehnt.push(rel),
      beiWeg: (k) => z.weg.push(k),
      warteMs: 1,
    },
  );
  const zeilen = () => [...g('dateienBaum').children].map((k) => `${'  '.repeat(Number(k.getAttribute('aria-level') || 1) - 1)}${k.classList.contains('dt-hinweis') ? '~ ' : k.dataset.art === 'ordner' ? (k.getAttribute('aria-expanded') === 'true' ? 'v ' : '> ') : ''}${k.classList.contains('dt-hinweis') ? k.textContent : k.querySelector('.dt-name').textContent}`);
  const zeile = (rel) => [...g('dateienBaum').querySelectorAll('.dt-zeile')].find((k) => k.dataset.rel === rel);
  const taste = (ziel, key) => ziel.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const tippe = (text) => {
    g('dateienSuche').value = text;
    g('dateienSuche').dispatchEvent(new w.Event('input', { bubbles: true }));
  };
  return { w, dok, g, t, z, zeilen, zeile, taste, tippe, FP };
}
const ordnerAnfragen = (z) => z.gets.filter((p) => p.startsWith('/api/ordner'));

dom('Ohne Ordner oder ohne Dateiliste des Runners bleibt der Knopf der Schiene weg', async () => {
  const ohne = tafel({ ordner: '' });
  ohne.t.setzeSitzung(7);
  await warte(20);
  assert.equal(ohne.g('schieneDateien').hidden, true);
  assert.deepEqual(ohne.z.gets, [], 'ohne Ordner fragt die Tafel den Runner nicht');
  assert.equal(ohne.t.zustand().weg, 'nein');
  assert.equal(ohne.g('dateienLeer').textContent, 'Diese Sitzung hat keinen eigenen Ordner.');

  const draussen = tafel({ ordnerFehler: () => httpFehler(403, 'ausserhalb') });
  draussen.t.setzeSitzung(7);
  await bis(() => draussen.t.zustand().weg === 'nein');
  assert.equal(draussen.g('schieneDateien').hidden, true);
  assert.deepEqual(draussen.z.weg, [false]);
  assert.equal(draussen.g('dateienSuche').disabled, true);
  assert.equal(draussen.g('dateienLeer').textContent, 'Der Runner listet den Ordner dieser Sitzung nicht.');
});

dom('Baum: Wurzel mit Punkt-Dateien, Ordner laden beim Aufklappen, Klick öffnet, „@“ hängt an; Namen nur als Text', async () => {
  const f = tafel();
  assert.equal(f.g('schieneDateien').hidden, true, 'vor der ersten Sitzung');
  f.t.setzeSitzung(7);
  await bis(() => f.t.zustand().weg === 'ja');
  assert.equal(f.g('schieneDateien').hidden, false);
  assert.deepEqual(f.z.weg, [true]);
  assert.deepEqual(ordnerAnfragen(f.z), ['/api/ordner?pfad=%2Farbeit%2Fprojekt&dateien=1&versteckt=1']);
  assert.equal(f.g('dateienOrdner').textContent, 'projekt');
  assert.equal(f.g('dateienOrdner').title, ORDNER);
  assert.deepEqual(f.zeilen(), ['> .github', '> docs', '> src', '.gitignore', BOESE, 'bild.png', 'liesmich.md']);
  assert.equal(f.g('dateienBaum').querySelector('img'), null, 'ein Dateiname wird nie zu Markup');
  assert.ok(f.zeile('.gitignore').classList.contains('versteckt'));
  assert.ok(!f.zeile('liesmich.md').classList.contains('versteckt'));
  assert.equal(f.zeile('liesmich.md').title, 'liesmich.md · 300 B');
  assert.equal(f.g('dateienFuss').hidden, false);
  assert.match(f.g('dateienFuss').textContent, /Klick öffnet die Datei rechts/);

  // aufklappen lädt, die Kinder stehen eingerückt darunter
  f.zeile('src').click();
  await bis(() => f.zeile('src/a.js'));
  assert.deepEqual(f.zeilen(), ['> .github', '> docs', 'v src', '  > tief', '  a.js', '  b.js', '.gitignore', BOESE, 'bild.png', 'liesmich.md']);
  assert.equal(ordnerAnfragen(f.z).at(-1), '/api/ordner?pfad=%2Farbeit%2Fprojekt%2Fsrc&dateien=1&versteckt=1');
  f.zeile('src/tief').click();
  await bis(() => f.zeile('src/tief/c.js'));
  assert.equal(f.zeile('src/tief/c.js').getAttribute('aria-level'), '3');
  // ein leerer Ordner sagt das, gleich unter seinem Namen
  f.zeile('docs').click();
  await bis(() => f.zeilen().includes('~ leer'));
  assert.equal(f.zeilen()[f.zeilen().indexOf('v docs') + 1], '~ leer');
  // zuklappen nimmt die Kinder mit; wieder aufklappen lädt nicht neu und zeigt nur diesen Ordner offen
  const n = ordnerAnfragen(f.z).length;
  f.zeile('src').click();
  assert.ok(!f.zeile('src/a.js'));
  f.zeile('src').click();
  const abSrc = f.zeilen().indexOf('v src');
  assert.deepEqual(f.zeilen().slice(abSrc, abSrc + 4), ['v src', '  > tief', '  a.js', '  b.js']);
  assert.equal(ordnerAnfragen(f.z).length, n);

  // Klick auf eine Datei: die Seite öffnet sie rechts; ein Bild als Bild
  f.zeile('src/a.js').click();
  f.zeile('bild.png').click();
  assert.deepEqual(f.z.dateien, [
    { pfad: `${ORDNER}/src/a.js`, relativ: 'src/a.js', bild: false },
    { pfad: `${ORDNER}/bild.png`, relativ: 'bild.png', bild: true },
  ]);
  // „@“ an der Zeile und die Taste @ hängen an die Nachricht, ohne zu öffnen
  f.zeile('src/b.js').querySelector('.dt-an').click();
  f.taste(f.zeile('liesmich.md'), '@');
  assert.deepEqual(f.z.erwaehnt, ['src/b.js', 'liesmich.md']);
  assert.equal(f.z.dateien.length, 2);
  // Ziehen legt `@pfad` als Text bereit (das Eingabefeld nimmt ihn beim Ablegen)
  const gezogen = {};
  const zieh = new f.w.Event('dragstart', { bubbles: true });
  Object.defineProperty(zieh, 'dataTransfer', { value: { setData: (art, wert) => (gezogen[art] = wert), effectAllowed: '' } });
  f.zeile('src/a.js').dispatchEvent(zieh);
  assert.deepEqual(gezogen, { 'text/plain': '@src/a.js ' });
  assert.equal(f.zeile('src/a.js').draggable, true);
  assert.equal(f.zeile('src').draggable, false);
});

dom('Tasten: Pfeile wandern, rechts klappt auf, links zu oder zum Ordner darüber, Eingabe öffnet; genau ein Tabstopp', async () => {
  const f = tafel();
  f.t.setzeSitzung(7);
  await bis(() => f.zeile('src'));
  const stopps = () => [...f.g('dateienBaum').querySelectorAll('.dt-zeile')].filter((k) => k.tabIndex === 0).map((k) => k.dataset.rel);
  assert.deepEqual(stopps(), ['.github'], 'der erste Eintrag ist erreichbar');
  f.zeile('.github').focus();
  f.taste(f.dok.activeElement, 'ArrowDown');
  f.taste(f.dok.activeElement, 'ArrowDown');
  assert.equal(f.dok.activeElement.dataset.rel, 'src');
  assert.deepEqual(stopps(), ['src']);
  f.taste(f.dok.activeElement, 'ArrowRight');
  await bis(() => f.zeile('src/a.js'));
  assert.equal(f.dok.activeElement.dataset.rel, 'src', 'der Fokus bleibt beim Nachladen auf dem Ordner');
  f.taste(f.dok.activeElement, 'ArrowRight');
  assert.equal(f.dok.activeElement.dataset.rel, 'src/tief', 'ein offener Ordner führt mit rechts zu seinem ersten Eintrag');
  f.taste(f.dok.activeElement, 'ArrowDown');
  assert.equal(f.dok.activeElement.dataset.rel, 'src/a.js');
  f.taste(f.dok.activeElement, 'Enter');
  assert.deepEqual(f.z.dateien.map((x) => x.relativ), ['src/a.js']);
  f.taste(f.dok.activeElement, 'ArrowLeft');
  assert.equal(f.dok.activeElement.dataset.rel, 'src', 'links auf einer Datei geht zum Ordner darüber');
  f.taste(f.dok.activeElement, 'ArrowLeft');
  assert.ok(!f.zeile('src/a.js'), 'links auf einem offenen Ordner klappt ihn zu');
  assert.equal(f.dok.activeElement.dataset.rel, 'src');
  f.taste(f.dok.activeElement, ' ');
  await bis(() => f.zeile('src/a.js'));
  f.taste(f.dok.activeElement, 'End');
  assert.equal(f.dok.activeElement.dataset.rel, 'liesmich.md');
  f.taste(f.dok.activeElement, 'Home');
  assert.equal(f.dok.activeElement.dataset.rel, '.github');
  // nach oben aus dem Baum geht es ins Suchfeld, von dort mit Pfeil runter zurück
  f.taste(f.dok.activeElement, 'ArrowUp');
  assert.equal(f.dok.activeElement, f.g('dateienSuche'));
  f.taste(f.g('dateienSuche'), 'ArrowDown');
  assert.equal(f.dok.activeElement.dataset.rel, '.github');
  assert.equal(stopps().length, 1);
});

dom('Marken: was der Agent geändert oder angelegt hat, steht am Namen, und der Ordner darüber trägt einen Punkt; die Datei rechts vorn ist markiert', async () => {
  const f = tafel();
  f.t.setzeSitzung(7);
  await bis(() => f.zeile('src'));
  f.zeile('src').click();
  await bis(() => f.zeile('src/a.js'));
  assert.equal(f.g('dateienBaum').querySelector('.dt-marke, .dt-punkt'), null);
  f.t.setzeMarken([{ relativ: 'src/a.js', zustand: 'geaendert' }, { relativ: 'liesmich.md', zustand: 'neu' }, { relativ: 'src/tief/c.js', zustand: 'geaendert' }]);
  assert.equal(f.zeile('src/a.js').querySelector('.dt-marke').textContent, 'M');
  assert.equal(f.zeile('src/a.js').querySelector('.dt-marke').title, 'vom Agenten in dieser Sitzung geändert');
  assert.equal(f.zeile('liesmich.md').querySelector('.dt-marke').textContent, 'N');
  assert.ok(f.zeile('liesmich.md').querySelector('.dt-marke').classList.contains('neu'));
  assert.ok(f.zeile('src').querySelector('.dt-punkt'), 'im Ordner src liegt Geändertes');
  assert.ok(f.zeile('src/tief').querySelector('.dt-punkt'), 'auch im zugeklappten Unterordner');
  assert.equal(f.zeile('docs').querySelector('.dt-punkt'), null);
  f.t.setzeMarken(null);
  assert.equal(f.g('dateienBaum').querySelector('.dt-marke, .dt-punkt'), null, 'ein Runner ohne Stände: keine Marken');

  assert.equal(f.g('dateienBaum').querySelector('.dt-zeile.aktiv'), null);
  f.z.aktiv = `${ORDNER}/src/b.js`;
  f.t.markiereAktiv();
  assert.deepEqual([...f.g('dateienBaum').querySelectorAll('.dt-zeile.aktiv')].map((k) => k.dataset.rel), ['src/b.js']);
  assert.equal(f.zeile('src/b.js').getAttribute('aria-selected'), 'true');
  f.z.aktiv = '/woanders/x.js';
  f.t.markiereAktiv();
  assert.equal(f.g('dateienBaum').querySelector('.dt-zeile.aktiv'), null);
});

dom('Nachziehen: sichtbar liest die Tafel still neu (kein Flackern), verdeckt erst beim Öffnen; ein verschwundener Ordner klappt zu', async () => {
  const f = tafel();
  f.t.setzeSitzung(7);
  await bis(() => f.zeile('src'));
  f.zeile('src').click();
  await bis(() => f.zeile('src/a.js'));
  f.zeile('src/tief').click();
  await bis(() => f.zeile('src/tief/c.js'));
  // der Agent legt eine Datei an und löscht einen Ordner
  f.z.baum.src = [['a.js', 0, 100], ['b.js', 0, 200], ['neu.js', 0, 1]];
  delete f.z.baum['src/tief'];
  const vorher = ordnerAnfragen(f.z).length;
  let leerGesehen = false;
  const beobachter = new f.w.MutationObserver(() => {
    if (!f.zeile('src/a.js') || !f.zeile('liesmich.md')) leerGesehen = true;
  });
  beobachter.observe(f.g('dateienBaum'), { childList: true });
  f.t.plane();
  f.t.plane();
  await bis(() => f.zeile('src/neu.js'));
  beobachter.disconnect();
  assert.equal(leerGesehen, false, 'der Baum stand beim Nachziehen nie leer da');
  assert.deepEqual(f.zeilen().slice(2, 6), ['v src', '  a.js', '  b.js', '  neu.js']);
  assert.deepEqual([...f.t.zustand().auf], ['src'], 'der gelöschte Ordner ist nicht mehr aufgeklappt');
  assert.equal(ordnerAnfragen(f.z).length, vorher + 2, 'zweimal geplant, einmal gelesen: Wurzel und der offene Ordner');

  // verdeckt: nichts lesen, aber merken; beim Öffnen nachziehen
  f.z.sichtbar = false;
  f.z.baum[''] = [...f.z.baum[''], ['spaet.txt', 0, 1]];
  const n = ordnerAnfragen(f.z).length;
  f.t.plane();
  await warte(350);
  assert.equal(ordnerAnfragen(f.z).length, n);
  assert.equal(f.t.zustand().veraltet, true);
  f.z.sichtbar = true;
  f.t.zeige();
  await bis(() => f.zeile('spaet.txt'));
  assert.equal(f.t.zustand().veraltet, false);
  // „Neu laden“ liest von Hand
  f.z.baum[''] = f.z.baum[''].filter((e) => e[0] !== 'spaet.txt');
  f.g('dateienNeu').click();
  await bis(() => !f.zeile('spaet.txt'));
});

dom('Sitzungen: aufgeklappte Ordner bleiben je Sitzung gemerkt, späte Antworten der alten Sitzung zählen nicht; der Ordner kommt nach', async () => {
  let sitzung = 7;
  const f = tafel();
  f.t.setzeSitzung(sitzung);
  await bis(() => f.zeile('src'));
  f.zeile('src').click();
  await bis(() => f.zeile('src/a.js'));
  // Wechsel, während eine Antwort noch aussteht
  let los;
  f.z.halt = new Promise((r) => (los = r));
  f.zeile('docs').click();
  sitzung = 8;
  f.z.ordner = '/arbeit/anderes';
  f.t.setzeSitzung(sitzung);
  f.z.halt = null;
  los();
  await bis(() => f.t.zustand().weg === 'nein');
  assert.deepEqual(f.zeilen(), [], 'die andere Sitzung liegt außerhalb: kein Baum, auch nicht der alte');
  assert.equal(f.g('schieneDateien').hidden, true);
  // zurück: src ist wieder offen und wird neu gelesen
  f.z.ordner = ORDNER;
  f.t.setzeSitzung(7);
  await bis(() => f.zeile('src/a.js'));
  assert.equal(f.g('schieneDateien').hidden, false);
  assert.ok(f.t.zustand().auf.includes('src'));
  // der Ordner einer Sitzung wird erst nach dem Wechsel bekannt
  const g = tafel({ ordner: '' });
  g.t.setzeSitzung(9);
  assert.equal(g.t.zustand().weg, 'nein');
  g.z.ordner = ORDNER;
  g.t.ordnerNeu();
  await bis(() => g.zeile('src'));
  assert.equal(g.g('schieneDateien').hidden, false);
  const n = g.z.gets.length;
  g.t.ordnerNeu();
  await warte(20);
  assert.equal(g.z.gets.length, n, 'derselbe Ordner: nichts neu gelesen');
});

dom('Suche über den Runner: Treffer mit Ordner, Zahl in der Fußzeile, Eingabe öffnet den ersten, Esc zurück zum Baum; späte Antworten zählen nicht', async () => {
  const antworten = {
    cha: { ok: true, treffer: [{ relativ: 'src/chat.js' }, { relativ: 'docs/chat.md' }], gesamt: 40, gekuerzt: true },
    chat: { ok: true, treffer: [{ relativ: 'src/chat.js' }], gesamt: 1, gekuerzt: false, unvollstaendig: true },
    nix: { ok: true, treffer: [], gesamt: 0 },
  };
  let bremse = null;
  const f = tafel({
    suche: async (q) => {
      if (q === 'cha' && bremse) await bremse;
      return antworten[q] || httpFehler(500, 'kaputt');
    },
  });
  f.t.setzeSitzung(7);
  await bis(() => f.zeile('src'));
  f.tippe('cha');
  await bis(() => f.zeile('src/chat.js'));
  assert.equal(f.z.gets.at(-1), '/api/gespraech/7/dateien?q=cha&limit=50');
  assert.deepEqual(f.zeilen(), ['chat.js', 'chat.md']);
  assert.equal(f.zeile('src/chat.js').querySelector('.dt-ort').textContent, 'src');
  assert.equal(f.g('dateienFuss').textContent, '2 von 40 Treffern. Tipp mehr, um einzugrenzen.');
  f.t.setzeMarken([{ relativ: 'src/chat.js', zustand: 'geaendert' }]);
  assert.equal(f.zeile('src/chat.js').querySelector('.dt-marke').textContent, 'M', 'Marken auch an Treffern');
  // Eingabe im Suchfeld öffnet den ersten Treffer; ein Klick einen anderen
  f.taste(f.g('dateienSuche'), 'Enter');
  f.zeile('docs/chat.md').click();
  assert.deepEqual(f.z.dateien.map((x) => x.pfad), [`${ORDNER}/src/chat.js`, `${ORDNER}/docs/chat.md`]);
  // eine späte Antwort auf die frühere Eingabe überschreibt die neuere nicht
  let los;
  bremse = new Promise((r) => (los = r));
  f.tippe('cha ');
  f.tippe('cha');
  await warte(15);
  f.tippe('chat');
  await bis(() => f.g('dateienFuss').textContent.startsWith('1 Treffer'));
  los();
  await warte(20);
  assert.deepEqual(f.zeilen(), ['chat.js']);
  assert.equal(f.g('dateienFuss').textContent, '1 Treffer. Der Ordner ist sehr groß: die Liste der Dateien war nicht vollständig.');
  // nichts gefunden, Fehler des Runners
  f.tippe('nix');
  await bis(() => f.g('dateienLeer').textContent === 'Keine Datei passt.');
  assert.deepEqual(f.zeilen(), []);
  f.tippe('bumm');
  await bis(() => !f.g('dateienLeer').hidden && /Nicht möglich/.test(f.g('dateienLeer').textContent));
  // Esc leert das Feld, der Baum steht wieder da
  f.taste(f.g('dateienSuche'), 'Escape');
  assert.equal(f.g('dateienSuche').value, '');
  assert.deepEqual(f.zeilen().slice(0, 3), ['> .github', '> docs', '> src']);
  assert.equal(f.g('dateienLeer').hidden, true);
  assert.equal(f.t.zustand().sucheWeg, 'ja');
});

dom('Suche ohne den Weg (voller Runner): gesucht wird in den aufgeklappten Ordnern, und die Fußzeile sagt das', async () => {
  const f = tafel();
  f.t.setzeSitzung(7);
  await bis(() => f.zeile('src'));
  f.zeile('src').click();
  await bis(() => f.zeile('src/a.js'));
  f.tippe('js');
  await bis(() => f.t.zustand().sucheWeg === 'nein' && f.zeile('src/a.js'));
  assert.deepEqual(f.zeilen(), ['a.js', 'b.js']);
  assert.equal(f.g('dateienFuss').textContent, '2 Treffer in den Ordnern, die schon aufgeklappt waren. Dieser Runner sucht nicht im ganzen Ordner.');
  const n = f.z.gets.length;
  f.tippe('c.js');
  await bis(() => f.g('dateienLeer').textContent === 'Keine Datei passt in den Ordnern, die schon aufgeklappt waren.');
  assert.equal(f.z.gets.length, n, 'der Runner wird nicht noch einmal nach der Suche gefragt');
  // eine andere Sitzung fragt wieder (ein anderer Runner könnte es können)
  f.t.setzeSitzung(7);
  assert.equal(f.t.zustand().sucheWeg, 'unbekannt');
});

test('Quelltext: gelesen wird über runner-wege.js, Namen nur als Text, keine Signalfarbe, die Seite bindet die Tafel ein', () => {
  const quelle = lies('dateien-tafel.js');
  assert.doesNotMatch(quelle, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.doesNotMatch(quelle, /\.api\(|fetch\(/, 'gelesen wird nur über runner-wege.js');
  const stil = lies('dateien.css');
  assert.doesNotMatch(stil, /--akzent/);
  const seite = lies('chat.html');
  assert.match(seite, /<script src="dateien-tafel\.js"><\/script>/);
  assert.match(seite, /<link rel="stylesheet" href="dateien\.css">/);
  assert.match(seite, /id="schieneDateien"[^>]*hidden/);
  assert.match(seite, /id="dateienBaum"[^>]*role="tree"/);
  const chat = lies('chat.js');
  assert.match(chat, /dateien: \$\('schieneDateien'\)/);
  assert.match(chat, /dateienTafel\.setzeSitzung\(rec\.id\)/);
  // in runner-wege.js bleibt es bei der einen Stelle, die liest
  assert.equal((lies('runner-wege.js').match(/transport\.api\('GET'/g) || []).length, 1);
});
