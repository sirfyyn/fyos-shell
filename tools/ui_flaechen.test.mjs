// Flächen rechts neben dem Gespräch (Paket B2 in FYOS-AGENT-LOKAL-PLAN): der Bereich mit Reitern (flaechen.js), die Fläche „Diff und Datei“
// (datei-flaeche.js) und die Stellen im Gespräch, die sie öffnen (chat-renderer.js, markdown-strom.js, staende-tafel.js).
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
const httpFehler = (status, fehler) => Object.assign(new Error(`HTTP ${status}`), { status, fehler });

const ORDNER = '/arbeit/projekt';
const BILD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
const PATCH = '--- src/b.txt\n+++ src/b.txt\n@@ -1,3 +1,4 @@\n eins\n-zwei\n+ZWEI\n drei\n+vier\n';

test('Pfade: absolut im Ordner der Sitzung, Anzeige, „pfad:zeile“, was im Text als Pfad gilt', () => {
  const D = logik('datei-flaeche.js').dateiFlaeche;
  assert.equal(D.absolut('src/a.js', ORDNER), `${ORDNER}/src/a.js`);
  assert.equal(D.absolut('./src/../b.txt', `${ORDNER}/`), `${ORDNER}/b.txt`);
  assert.equal(D.absolut('/etc/hosts', ORDNER), '/etc/hosts');
  assert.equal(D.absolut('/a/./b/../c.txt', ''), '/a/c.txt', 'ein absoluter Pfad braucht keinen Ordner');
  assert.equal(D.absolut('../../../x', '/arbeit'), '/x', 'über den Anfang hinaus geht es nicht');
  for (const [p, o] of [['a.js', ''], ['a.js', 'relativ'], ['', ORDNER], ['a\0b', ORDNER], [null, ORDNER]]) assert.equal(D.absolut(p, o), null, `${p} in ${o}`);
  assert.equal(D.anzeigePfad(`${ORDNER}/src/a.js`, ORDNER), 'src/a.js');
  assert.equal(D.anzeigePfad(`${ORDNER}/src/a.js`, `${ORDNER}/`), 'src/a.js');
  assert.equal(D.anzeigePfad(`${ORDNER}2/a.js`, ORDNER), `${ORDNER}2/a.js`, 'ein Nachbarordner mit gleichem Anfang liegt nicht darin');
  assert.equal(D.anzeigePfad('/anderswo/a.js', ''), '/anderswo/a.js');
  assert.deepEqual(D.pfadMitZeile('src/a.js:12'), { pfad: 'src/a.js', zeile: 12 });
  assert.deepEqual(D.pfadMitZeile('src/a.js:12:5'), { pfad: 'src/a.js', zeile: 12 });
  assert.deepEqual(D.pfadMitZeile(' README.md#L7 '), { pfad: 'README.md', zeile: 7 });
  assert.deepEqual(D.pfadMitZeile('src/a.js'), { pfad: 'src/a.js', zeile: 0 });
  for (const ja of ['src/lauf/index.js', 'chat.js:610', 'apps/fyos-shell/app/ui/agent/chat.html:127', './tools/x.mjs', '/arbeit/projekt/a.txt', 'README.md', 'README.md#L12', 'src/x:12', 'package.json', 'a/b.c']) {
    assert.equal(D.siehtWiePfadAus(ja), true, ja);
  }
  for (const nein of ['pi_durable.model.bilder', 'FP.baueDiff', 'v1.2.3', 'localhost:5173', '127.0.0.1:8080', 'https://example.org/a.js', '/api/datei', '/api/gespraech/14', 'GET /api/datei', 'e.g.', 'a/b', 'foo()', 'git status', '0.87', 'x', 'und/oder', 'user@example.com', '', null]) {
    assert.equal(D.siehtWiePfadAus(nein), false, String(nein));
  }
  assert.deepEqual(D.zeilenVon('a\nb\n'), ['a', 'b']);
  assert.deepEqual(D.zeilenVon('a\r\nb'), ['a', 'b']);
  assert.deepEqual(D.zeilenVon('a\n\n'), ['a', '']);
  assert.deepEqual(D.zeilenVon(''), ['']);
});

test('Wege: ein Bild kommt nur mit bekanntem Typ und reinem Base64 durch; ein Runner ohne Bilder ist „Weg fehlt“; kein Bild hat seinen Satz', async () => {
  const W = logik('runner-wege.js').wege;
  const gut = { ok: true, pfad: '/a/b.png', typ: 'image/png', bild: BILD, breite: 400.9, hoehe: 300, groesse: 4096, verkleinert: true, geaendert: 7, fremd: 1 };
  assert.deepEqual(W.dateiBildBereinigen(gut), { pfad: '/a/b.png', typ: 'image/png', bild: BILD, breite: 400, hoehe: 300, groesse: 4096, verkleinert: true, geaendert: 7 });
  assert.equal(W.dateiBildBereinigen({ ...gut, pfad: undefined }, '/gefragt.png').pfad, '/gefragt.png');
  for (const schlecht of [{ ...gut, typ: 'image/svg+xml' }, { ...gut, typ: 'text/html' }, { ...gut, bild: `${BILD}" onerror="x` }, { ...gut, bild: '' }, { ...gut, bild: 5 }, { ...gut, bild: 'A'.repeat(9000001) }, { ok: true, binaer: true, groesse: 9 }, { ok: true, text: 'x' }, null]) {
    assert.equal(W.dateiBildBereinigen(schlecht), null);
  }
  const gefragt = [];
  const mit = (antwort) => W.createWege({ api: async (m, pfad) => (gefragt.push(pfad), antwort instanceof Error ? Promise.reject(antwort) : antwort) });
  const b = await mit(gut).dateiBild('/a/b c.png', { gespraech: 7 });
  assert.equal(b.typ, 'image/png');
  assert.equal(gefragt[0], '/api/datei?pfad=%2Fa%2Fb%20c%2Epng&gespraech=7&bild=1');
  // ein Runner, der bild=1 nicht kennt, antwortet wie immer: Binärdatei
  await assert.rejects(mit({ ok: true, pfad: '/a/b.png', groesse: 9, binaer: true }).dateiBild('/a/b.png'), (f) => f.art === 'weg_fehlt' && /zeigt keine Bilder/.test(f.message));
  await assert.rejects(mit(httpFehler(415, 'kein_bild')).dateiBild('/a/x.txt'), (f) => f.art === 'kein_bild' && f.message === 'Das ist kein Bild, das sich anzeigen lässt (PNG, JPEG, GIF oder WebP).');
  await assert.rejects(mit(httpFehler(413, 'zu_gross')).dateiBild('/a/x.png'), (f) => f.art === 'zu_gross');
});

/** Der Reiter-Bereich in einem kleinen Gerüst. */
function bereich(opts) {
  const d = new jsdom.JSDOM('<!doctype html><body><aside id="w" hidden><div id="r" role="tablist"></div><button id="z" type="button">Schließen</button><div id="k"><div id="fest" hidden><p>fest</p></div></div></aside></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = d.window;
  w.eval(lies('flaechen.js'));
  const dok = w.document;
  const g = (id) => dok.getElementById(id);
  const z = { offen: [], wechsel: [], zu: [] };
  const roh = w.FyosPrototyp.createFlaechen({ wurzel: g('w'), reiter: g('r'), koerper: g('k'), zu: g('z') }, { beiOffen: (a) => z.offen.push(a), beiWechsel: (id) => z.wechsel.push(id), ...opts });
  // `liste()` kommt aus dem Fenster von jsdom: für Vergleiche als Liste dieses Programms
  const f = { oeffne: roh.oeffne, aktiviere: roh.aktiviere, schliesse: roh.schliesse, schliesseAlle: roh.schliesseAlle, liste: () => [...roh.liste()], get aktiv() { return roh.aktiv; }, get offen() { return roh.offen; } };
  const teil = (text) => {
    const e = dok.createElement('div');
    e.textContent = text;
    return e;
  };
  const reiter = () => [...g('r').querySelectorAll('.fl-reiter-knopf')].map((b) => [b.textContent, b.getAttribute('aria-selected'), b.tabIndex]);
  const fl = (id, titel, extra) => ({ id, titel, teil: teil(`Inhalt ${id}`), beiZu: (grund) => z.zu.push([id, grund]), ...extra });
  return { w, dok, g, f, z, teil, reiter, fl };
}

dom('Reiter-Bereich: er ist nur da, solange etwas offen ist; gezeigt wird genau eine Fläche; schließen wählt die Nachbarin', () => {
  const { g, f, z, reiter, fl, dok } = bereich();
  assert.deepEqual([g('w').hidden, f.offen, f.aktiv, f.liste()], [true, false, null, []]);
  const a = fl('a', 'a.js', { hinweis: 'src/a.js' });
  f.oeffne(a);
  assert.deepEqual([g('w').hidden, f.offen, f.aktiv, z.offen, z.wechsel], [false, true, 'a', [true], ['a']]);
  assert.deepEqual([a.teil.parentNode === g('k'), a.teil.hidden, a.teil.getAttribute('role')], [true, false, 'tabpanel']);
  const knopf = g('r').querySelector('.fl-reiter-knopf');
  assert.deepEqual([knopf.getAttribute('role'), knopf.title, knopf.getAttribute('aria-controls'), a.teil.getAttribute('aria-labelledby')], ['tab', 'src/a.js', a.teil.id, knopf.id]);
  const b = fl('b', '<b>fett</b>.txt');
  const c = fl('c', 'c.md');
  f.oeffne(b);
  f.oeffne(c);
  assert.deepEqual(reiter(), [['a.js', 'false', -1], ['<b>fett</b>.txt', 'false', -1], ['c.md', 'true', 0]]);
  assert.equal(g('r').querySelector('b'), null, 'ein Titel wird nie zu HTML');
  assert.deepEqual([a.teil.hidden, b.teil.hidden, c.teil.hidden], [true, true, false]);
  // noch einmal öffnen holt nach vorn und nimmt den neuen Titel, legt aber nichts doppelt an
  f.oeffne({ id: 'a', titel: 'a.js (neu)', teil: dok.createElement('div') });
  assert.deepEqual([f.liste(), f.aktiv, reiter()[0][0], a.teil.hidden], [['a', 'b', 'c'], 'a', 'a.js (neu)', false]);
  // im Hintergrund öffnen: der Reiter erscheint, vorn bleibt, was vorn war
  const d = fl('d', 'd.txt');
  f.oeffne(d, { imHintergrund: true });
  assert.deepEqual([f.aktiv, d.teil.hidden, f.liste()], ['a', true, ['a', 'b', 'c', 'd']]);
  // ein Klick wechselt; die Seite erfährt jeden Wechsel einmal
  g('r').querySelectorAll('.fl-reiter-knopf')[1].click();
  assert.deepEqual([f.aktiv, z.wechsel], ['b', ['a', 'b', 'c', 'a', 'b']]);
  // schließen über das Kreuz: die rechte Nachbarin kommt nach vorn, der Teil verschwindet aus der Seite, die Fläche erfährt es
  const kreuz = g('r').querySelectorAll('.fl-reiter-zu')[1];
  assert.equal(kreuz.getAttribute('aria-label'), '<b>fett</b>.txt schließen');
  kreuz.click();
  assert.deepEqual([f.liste(), f.aktiv, b.teil.parentNode, z.zu], [['a', 'c', 'd'], 'c', null, [['b', 'mensch']]]);
  // eine verdeckte schließen ändert vorn nichts; „still“ ruft die Fläche nicht
  f.schliesse('a', { still: true });
  assert.deepEqual([f.liste(), f.aktiv, z.zu.length], [['c', 'd'], 'c', 1]);
  f.schliesse('d');
  f.schliesse('c');
  assert.deepEqual([g('w').hidden, f.offen, f.aktiv, z.offen, z.wechsel.at(-1)], [true, false, null, [true, false], null]);
  f.schliesse('gibt-es-nicht');
  assert.deepEqual(z.offen, [true, false]);
});

dom('Reiter-Bereich: Pfeiltasten wechseln, Entf schließt, „Schließen“ schließt alle; feste Teile bleiben in der Seite; zu viele verdrängen die älteste', () => {
  const { w, g, f, z, fl } = bereich({ hoechstens: 3 });
  const fest = { id: 'browser', titel: 'Browser', teil: g('fest'), fest: true, beiZu: (grund) => z.zu.push(['browser', grund]) };
  f.oeffne(fest);
  f.oeffne(fl('a', 'a'));
  f.oeffne(fl('b', 'b'));
  f.oeffne(fl('c', 'c'));
  assert.deepEqual([f.liste(), f.aktiv], [['browser', 'a', 'b', 'c'], 'c']);
  // die vierte schließbare verdrängt die älteste, die nicht vorn liegt; der feste Teil zählt nicht mit
  f.oeffne(fl('d', 'd'));
  assert.deepEqual([f.liste(), z.zu], [['browser', 'b', 'c', 'd'], [['a', 'verdraengt']]]);
  const taste = (key) => {
    const e = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    w.document.activeElement.dispatchEvent(e);
    return e.defaultPrevented;
  };
  g('r').querySelector('.fl-reiter-eintrag.aktiv .fl-reiter-knopf').focus();
  assert.equal(taste('ArrowLeft'), true);
  assert.deepEqual([f.aktiv, w.document.activeElement.textContent], ['c', 'c']);
  taste('ArrowRight');
  taste('ArrowRight');
  assert.deepEqual([f.aktiv, w.document.activeElement.textContent], ['browser', 'Browser'], 'rundherum');
  taste('End');
  assert.equal(f.aktiv, 'd');
  taste('Home');
  assert.equal(f.aktiv, 'browser');
  assert.equal(taste('a'), false, 'andere Tasten gehören nicht dem Bereich');
  // Entf schließt den Reiter, auf dem der Fokus steht; der Fokus bleibt in der Leiste
  taste('ArrowRight');
  taste('Delete');
  assert.deepEqual([f.liste(), f.aktiv, w.document.activeElement.textContent, z.zu.at(-1)], [['browser', 'c', 'd'], 'c', 'c', ['b', 'mensch']]);
  // alle schließen: der feste Teil bleibt in der Seite (versteckt), die anderen sind weg; jede Fläche erfährt es
  g('z').click();
  assert.deepEqual([f.offen, g('w').hidden, g('fest').parentNode === g('k'), g('fest').hidden, g('k').children.length], [false, true, true, true, 1]);
  assert.deepEqual(z.zu.slice(-3), [['browser', 'mensch'], ['c', 'mensch'], ['d', 'mensch']]);
  assert.deepEqual([z.offen.at(-1), z.wechsel.at(-1)], [false, null]);
});

/** Die Fläche „Diff und Datei“ im Reiter-Bereich, mit einem Runner aus dem Test. `dateien`: Pfad → Antwort, `diffs`: Pfad → Antwort. */
function flaeche({ dateien = {}, diffs = {}, hoechstens, get } = {}) {
  const d = new jsdom.JSDOM('<!doctype html><body><aside id="w" hidden><div id="r" role="tablist"></div><button id="z" type="button">Schließen</button><div id="k"><div id="fest" hidden></div></div></aside></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = d.window;
  for (const s of ['markdown-strom.js', 'terminal.js', 'chat-renderer.js', 'runner-adapter.js', 'runner-wege.js', 'flaechen.js', 'datei-flaeche.js']) w.eval(lies(s));
  const FP = w.FyosPrototyp;
  const dok = w.document;
  const g = (id) => dok.getElementById(id);
  const z = { gets: [], spruenge: [], offen: [] };
  const s = { sitzung: 7, ordner: ORDNER, staende: true, geaendert: new Set(), breit: true };
  // jsdom kennt kein Rollen: gemerkt wird, an welche Zeile eine Datei springt und welcher Reiter in Sicht geholt wird
  z.reiterInSicht = [];
  w.Element.prototype.scrollIntoView = function () {
    if (this.tagName === 'TR') z.spruenge.push(this.querySelector('.nr').textContent);
    else z.reiterInSicht.push(this.textContent.replace('×', ''));
  };
  let df = null;
  const flaechen = FP.createFlaechen({ wurzel: g('w'), reiter: g('r'), koerper: g('k'), zu: g('z') }, { hoechstens, beiOffen: (a) => z.offen.push(a), beiWechsel: (id) => df && df.beiWechsel(id) });
  const standard = (pfad) => {
    const u = new URL(pfad, 'http://x');
    const p = u.searchParams.get('pfad');
    if (u.pathname === '/api/datei') {
      const e = typeof dateien[p] === 'function' ? dateien[p](u) : dateien[p];
      if (!e) return httpFehler(404, 'nicht_gefunden');
      if (e instanceof Error) return e;
      if (u.searchParams.get('bild') === '1') return e.bild ? { ok: true, pfad: p, groesse: 4096, geaendert: 1, ...e.bild } : httpFehler(415, 'kein_bild');
      if (e.binaer) return { ok: true, pfad: p, groesse: e.groesse || 9, binaer: true };
      return { ok: true, pfad: p, text: e.text, groesse: e.groesse === undefined ? e.text.length : e.groesse, abgeschnitten: !!e.abgeschnitten, binaer: false, geaendert: 1, ...(e.geschwaerzt ? { geschwaerzt: true } : {}) };
    }
    if (/^\/api\/gespraech\/\d+\/staende\/diff$/.test(u.pathname)) {
      const e = typeof diffs[p] === 'function' ? diffs[p](u) : diffs[p];
      return e || httpFehler(404, 'Die Datei wurde in diesem Gespräch nicht geändert');
    }
    return httpFehler(404, 'Unbekannte Route');
  };
  const transport = {
    api: async (methode, pfad) => {
      z.gets.push(pfad);
      const r = await (get ? get(pfad, standard) : standard(pfad));
      if (r instanceof Error) throw r;
      return r;
    },
  };
  df = FP.createDateiFlaeche({ flaechen }, { doc: dok, wege: FP.wege.createWege(transport), gespraech: () => s.sitzung, ordner: () => s.ordner, kenntStaende: () => s.staende, hatUnterschied: (abs) => s.geaendert.has(abs), breit: () => s.breit });
  df.setzeSitzung(s.sitzung);
  /** der Teil der Fläche, die vorn liegt */
  const vorn = () => [...g('k').children].find((e) => !e.hidden && e.classList.contains('df-teil')) || null;
  const lese = () => {
    const t = vorn();
    if (!t) return null;
    const q = (sel) => t.querySelector(sel);
    return {
      art: t.dataset.art,
      phase: t.dataset.phase,
      pfad: q('.df-pfad').textContent,
      info: q('.df-info').textContent,
      knoepfe: [...t.querySelectorAll('.df-knopf')].map((b) => b.textContent),
      hinweis: q('.df-hinweis').hidden ? '' : q('.df-hinweis').textContent,
      leer: q('.df-leer') ? q('.df-leer').textContent : '',
      zeilen: [...t.querySelectorAll('.df-code tr')].map((tr) => [tr.querySelector('.nr').textContent, tr.querySelector('.code').textContent, tr.classList.contains('ziel')]),
      diff: [...t.querySelectorAll('.diff-tabelle tr')].map((tr) => (tr.classList.contains('trenn') ? ['…', tr.textContent] : [tr.querySelector('.vz').textContent, tr.querySelector('.code').textContent, [...tr.querySelectorAll('.nr')].map((n) => n.textContent).join('|')])),
      bild: q('img.df-bild') ? q('img.df-bild').getAttribute('src') : '',
    };
  };
  const reiter = () => [...g('r').querySelectorAll('.fl-reiter-knopf')].map((b) => b.textContent);
  const klick = (text) => [...vorn().querySelectorAll('.df-knopf')].find((b) => b.textContent === text).click();
  const abfragen = (teilWeg) => z.gets.filter((p) => p.includes(teilWeg)).length;
  return { w, dok, g, df, flaechen, z, s, vorn, lese, reiter, klick, abfragen, FP };
}
const fertig = (f) => bis(() => f.lese() && f.lese().phase !== 'laedt');

dom('Datei: an der Zeile geöffnet und markiert; Zeilenzahl und Größe; Hinweise zu Kürzung, Schwärzung und einer Zeile, die es nicht gibt', async () => {
  const text = Array.from({ length: 30 }, (_, i) => `const wert${i + 1} = ${i + 1};`).join('\n') + '\n';
  const f = flaeche({ dateien: { [`${ORDNER}/src/werte.js`]: { text }, [`${ORDNER}/leer.txt`]: { text: '' }, [`${ORDNER}/<i>x<i>.md`]: { text: '# <b>Titel</b>\n', abgeschnitten: true, geschwaerzt: true, groesse: 900000 }, [`${ORDNER}/roh.bin`]: { binaer: true, groesse: 2048 } } });
  assert.equal(f.df.oeffneDatei({ pfad: 'src/werte.js', zeile: 12 }), true);
  assert.deepEqual([f.lese().phase, f.lese().leer, f.reiter(), f.g('w').hidden], ['laedt', 'Wird gelesen …', ['werte.js'], false]);
  await fertig(f);
  const a = f.lese();
  assert.deepEqual([a.art, a.pfad, a.info, a.knoepfe, a.hinweis], ['datei', 'src/werte.js', '30 Zeilen · 552 B', ['Neu laden'], '']);
  assert.equal(a.zeilen.length, 30);
  assert.deepEqual(a.zeilen[11], ['12', 'const wert12 = 12;', true]);
  assert.equal(a.zeilen.filter((x) => x[2]).length, 1);
  assert.deepEqual(f.z.spruenge, ['12'], 'die Fläche rollt an die Zeile');
  assert.equal(f.z.reiterInSicht.at(-1), 'werte.js', 'bei vielen Reitern bleibt der gewählte in der Leiste zu sehen');
  assert.equal(f.vorn().querySelector('tr.ziel').getAttribute('aria-current'), 'true');
  assert.ok(f.vorn().querySelector('.df-code .tok-kw'), 'mit Hervorhebung der Sprache');
  assert.equal(f.z.gets[0], '/api/datei?pfad=%2Farbeit%2Fprojekt%2Fsrc%2Fwerte%2Ejs&gespraech=7&max=400000');
  assert.equal(f.g('r').querySelector('.fl-reiter-knopf').title, 'src/werte.js');

  // dieselbe Datei an einer anderen Zeile: kein zweiter Reiter, kein zweites Lesen, die Marke wandert
  f.df.oeffneDatei({ pfad: `${ORDNER}/src/werte.js`, zeile: 3 });
  assert.deepEqual([f.reiter(), f.abfragen('werte'), f.lese().zeilen.filter((x) => x[2]).map((x) => x[0]), f.z.spruenge], [['werte.js'], 1, ['3'], ['12', '3']]);
  // eine Zeile hinter dem Ende: gesagt, nichts markiert
  f.df.oeffneDatei({ pfad: 'src/werte.js', zeile: 99 });
  assert.deepEqual([f.lese().hinweis, f.lese().zeilen.some((x) => x[2])], ['Zeile 99 gibt es nicht: die Datei hat 30 Zeilen.', false]);
  // ohne Zeile: keine Marke, kein Sprung
  f.df.oeffneDatei({ pfad: 'src/werte.js' });
  assert.deepEqual([f.lese().hinweis, f.z.spruenge.length], ['', 2]);

  // Neu laden liest noch einmal
  f.klick('Neu laden');
  await bis(() => f.abfragen('werte') === 2);
  await fertig(f);

  f.df.oeffneDatei({ pfad: 'leer.txt' });
  await fertig(f);
  assert.deepEqual([f.lese().info, f.lese().leer, f.lese().zeilen.length], ['0 Zeilen · 0 B', 'Die Datei ist leer.', 0]);

  // gekürzt und geschwärzt; Name und Inhalt nur als Text
  f.df.oeffneDatei({ pfad: '<i>x<i>.md', zeile: 5000 });
  await fertig(f);
  const k = f.lese();
  assert.deepEqual([k.pfad, k.info, k.zeilen], ['<i>x<i>.md', '1 Zeile · 878,9 KB', [['1', '# <b>Titel</b>', false]]]);
  assert.equal(k.hinweis, 'Gekürzt: gezeigt wird nur der Anfang der Datei. Geheimnisse geschwärzt: Teile der Datei sind durch *** ersetzt. Das ist eine Lesehilfe, keine Kopiervorlage. Zeile 5000 liegt hinter dem gezeigten Teil.');
  assert.equal(f.vorn().querySelector('b, i'), null);

  f.df.oeffneDatei({ pfad: 'roh.bin' });
  await fertig(f);
  assert.deepEqual([f.lese().info, f.lese().leer], ['2,0 KB', 'Binärdatei: sie lässt sich hier nicht zeigen.']);

  // was der Runner nicht hergibt, steht mit seinem Satz da; „Neu laden“ bleibt
  f.df.oeffneDatei({ pfad: 'gibt-es-nicht.txt' });
  await fertig(f);
  assert.deepEqual([f.lese().phase, f.lese().leer, f.lese().knoepfe], ['fehler', 'Das gibt es auf dem Runner nicht (mehr).', ['Neu laden']]);
  assert.ok(f.vorn().querySelector('.df-leer').classList.contains('fehler'));
  assert.deepEqual(f.reiter(), ['werte.js', 'leer.txt', '<i>x<i>.md', 'roh.bin', 'gibt-es-nicht.txt']);
  assert.equal(f.g('r').querySelector('i'), null, 'auch der Reiter zeigt den Namen nur als Text');
  // ein relativer Pfad ohne Ordner der Sitzung lässt sich nicht auflösen
  f.s.ordner = '';
  assert.equal(f.df.oeffneDatei({ pfad: 'src/werte.js' }), false);
});

dom('Datei: sehr lange Dateien zeigen die ersten 4000 Zeilen ohne Hervorhebung; Antworten, die zu spät kommen, zählen nicht', async () => {
  const lang = Array.from({ length: 4500 }, (_, i) => `z${i + 1}`).join('\n');
  const offen = [];
  const f = flaeche({
    dateien: { [`${ORDNER}/lang.js`]: { text: lang } },
    get: (pfad, standard) => (pfad.includes('langsam') ? new Promise((ok) => offen.push(() => ok({ ok: true, pfad: `${ORDNER}/langsam.txt`, text: `Antwort ${offen.length}`, groesse: 9, binaer: false }))) : standard(pfad)),
  });
  f.df.oeffneDatei({ pfad: 'lang.js', zeile: 4200 });
  await fertig(f);
  const a = f.lese();
  assert.deepEqual([a.zeilen.length, a.info, a.hinweis], [4000, '4500 Zeilen · 25,3 KB', 'Gezeigt werden die ersten 4000 von 4500 Zeilen. Zeile 4200 liegt hinter dem gezeigten Teil.']);
  assert.equal(f.vorn().querySelector('.df-code [class^="tok-"]'), null, 'über 1500 Zeilen ohne Hervorhebung');

  // zweimal kurz nacheinander gelesen: nur die Antwort auf das zweite Lesen gilt, auch wenn die erste später kommt
  f.df.oeffneDatei({ pfad: 'langsam.txt' });
  f.klick('Neu laden');
  await bis(() => offen.length === 2);
  offen[1]();
  await fertig(f);
  assert.deepEqual(f.lese().zeilen, [['1', 'Antwort 2', false]]);
  offen[0]();
  await warte(20);
  assert.deepEqual(f.lese().zeilen, [['1', 'Antwort 2', false]]);
});

dom('Unterschied: alle Änderungen vom Runner mit echten Zeilennummern; die Änderung eines Aufrufs aus der Karte; Rückfall und Gründe', async () => {
  const b = `${ORDNER}/src/b.txt`;
  const f = flaeche({
    dateien: { [b]: { text: 'eins\nZWEI\ndrei\nvier\n' } },
    diffs: { [b]: { ok: true, relativ: 'src/b.txt', plus: 2, minus: 1, patch: PATCH }, [`${ORDNER}/gross.bin`]: { ok: true, relativ: 'gross.bin', plus: null, minus: null, patch: null, grund: 'nicht_gesichert' } },
  });
  f.s.geaendert.add(b);
  // aus der Tafel „Änderungen“: alle Änderungen des Agenten an der Datei
  assert.equal(f.df.oeffneDiff({ pfad: b }), true);
  await fertig(f);
  const a = f.lese();
  assert.deepEqual([a.art, a.pfad, a.info, a.knoepfe, a.hinweis], ['diff', 'src/b.txt', '+2 −1', ['Datei', 'Neu laden'], 'Alle Änderungen des Agenten an dieser Datei in dieser Sitzung, gegen den Stand davor.']);
  assert.deepEqual(a.diff, [['', 'eins', '1|1'], ['−', 'zwei', '2|'], ['+', 'ZWEI', '|2'], ['', 'drei', '3|3'], ['+', 'vier', '|4']]);
  assert.deepEqual([f.reiter(), f.z.gets[0]], [['± b.txt'], '/api/gespraech/7/staende/diff?pfad=%2Farbeit%2Fprojekt%2Fsrc%2Fb%2Etxt']);
  assert.equal(f.g('r').querySelector('.fl-reiter-knopf').title, 'Unterschied: src/b.txt');
  // von dort zur ganzen Datei und zurück zum Unterschied
  f.klick('Datei');
  await fertig(f);
  assert.deepEqual([f.lese().art, f.lese().knoepfe, f.reiter()], ['datei', ['Unterschied', 'Neu laden'], ['± b.txt', 'b.txt']]);
  f.klick('Unterschied');
  await fertig(f);
  assert.deepEqual([f.lese().art, f.reiter(), f.flaechen.aktiv], ['diff', ['± b.txt', 'b.txt'], `diff:${b}`]);

  // aus einer Karte im Gespräch: die Änderung dieses einen Aufrufs, ohne den Runner zu fragen
  const aufruf = { datei: 'src/b.txt', hunks: [{ alt: 2, neu: 2, zeilen: [['-', 'zwei'], ['+', 'ZWEI']] }] };
  const vorher = f.z.gets.length;
  f.df.oeffneDiff({ pfad: 'src/b.txt', diff: aufruf });
  const e = f.lese();
  assert.deepEqual([e.phase, e.info, e.knoepfe, e.hinweis, e.diff, f.z.gets.length], ['ok', '+1 −1', ['Alle Änderungen', 'Datei'], 'Die Änderung dieses einen Aufrufs.', [['−', 'zwei', '2|'], ['+', 'ZWEI', '|2']], vorher]);
  assert.deepEqual(f.reiter(), ['± b.txt', 'b.txt', '± b.txt · Aufruf'], 'beide Unterschiede derselben Datei sind am Reiter zu unterscheiden');
  assert.equal([...f.g('r').querySelectorAll('.fl-reiter-knopf')].at(-1).title, 'Änderung eines Aufrufs: src/b.txt');
  // eine andere Änderung derselben Datei ersetzt den Inhalt desselben Reiters
  f.df.oeffneDiff({ pfad: 'src/b.txt', diff: { datei: 'src/b.txt', hunks: [{ alt: 4, neu: 4, zeilen: [['+', 'vier']] }] } });
  assert.deepEqual([f.lese().info, f.reiter().length], ['+1 −0', 3]);
  f.klick('Alle Änderungen');
  await fertig(f);
  assert.equal(f.flaechen.aktiv, `diff:${b}`);

  // Gründe des Runners
  f.df.oeffneDiff({ pfad: 'gross.bin' });
  await fertig(f);
  assert.deepEqual([f.lese().leer, f.lese().diff], ['Der Stand vor der Arbeit des Agenten ist nicht gesichert (die Datei war zu groß).', []]);
  // eine Datei ohne Stand: mit der Änderung eines Aufrufs gilt die, ohne sie steht der Grund da
  f.df.oeffneDiff({ pfad: 'fremd.txt' });
  await fertig(f);
  assert.deepEqual([f.lese().phase, f.lese().leer], ['fehler', 'Zu dieser Datei gibt es keinen Stand: der Agent hat sie in dieser Sitzung nicht mit seinen Datei-Werkzeugen geändert.']);
  f.df.oeffneDiff({ pfad: 'neu.txt', diff: { datei: 'neu.txt', hunks: [{ alt: 1, neu: 1, zeilen: [['+', 'neu']] }] }, vonSelbst: true });
  assert.equal(f.flaechen.aktiv, `diff:${ORDNER}/fremd.txt`, 'von selbst geöffnet bleibt sie hinter der Fläche, die der Mensch ansieht');
  f.flaechen.aktiviere(`diff:${ORDNER}/neu.txt`);
  await fertig(f);
  assert.deepEqual([f.lese().phase, f.lese().hinweis, f.lese().info], ['ok', 'Die Änderung dieses einen Aufrufs.', '+1 −0']);

  // ein Runner ohne Stände: die Tafel gibt es dann nicht; aus der Karte gilt die Änderung des Aufrufs, sonst steht da, warum nichts zu sehen ist
  f.s.staende = false;
  const fragen = f.z.gets.length;
  f.df.oeffneDiff({ pfad: 'ohne.txt' });
  assert.deepEqual([f.lese().phase, f.lese().leer], ['fehler', 'Dieser Runner führt keine Stände: es gibt nur die Änderungen der einzelnen Aufrufe im Gespräch.']);
  f.df.oeffneDiff({ pfad: 'karte.txt', diff: aufruf });
  assert.deepEqual([f.lese().knoepfe, f.z.gets.length], [['Datei'], fragen], 'ohne Stände kein „Alle Änderungen“ und keine Anfrage');
});

dom('Bild: ein Anhang oder eine Bilddatei als Bild; verkleinert steht dabei; ein Runner ohne Bilder und eine Datei, die keins ist, sagen es', async () => {
  const anhang = '/daten/anhaenge/g-7/x-1-skizze.png';
  const f = flaeche({ dateien: { [anhang]: { binaer: true, bild: { typ: 'image/png', bild: BILD, breite: 400, hoehe: 300, verkleinert: false } }, [`${ORDNER}/foto.JPG`]: { binaer: true, bild: { typ: 'image/jpeg', bild: BILD, breite: 6000, hoehe: 4000, verkleinert: true, groesse: 9 * 1024 * 1024 } }, [`${ORDNER}/alt.png`]: { binaer: true }, [`${ORDNER}/boese.png`]: { binaer: true, bild: { typ: 'image/svg+xml', bild: BILD } } } });
  assert.equal(f.df.oeffneBild({ pfad: anhang }), true);
  assert.equal(f.lese().leer, 'Bild wird geladen …');
  await fertig(f);
  const a = f.lese();
  assert.deepEqual([a.art, a.pfad, a.info, a.hinweis, a.bild, a.knoepfe], ['bild', anhang, '400 × 300 · 4,0 KB', '', `data:image/png;base64,${BILD}`, ['Neu laden']]);
  assert.equal(f.vorn().querySelector('img').alt, 'Bild x-1-skizze.png');
  assert.equal(f.z.gets[0], '/api/datei?pfad=%2Fdaten%2Fanhaenge%2Fg-7%2Fx-1-skizze%2Epng&gespraech=7&bild=1');
  // eine Bilddatei im Ordner der Sitzung: über „Datei öffnen“ kommt sie als Bild
  f.df.oeffneDatei({ pfad: 'foto.JPG', zeile: 3 });
  await fertig(f);
  assert.deepEqual([f.lese().art, f.lese().info, f.lese().hinweis, f.reiter()], ['bild', '6000 × 4000 · 9,0 MB', 'Verkleinert gezeigt; die Datei selbst ist unverändert.', ['x-1-skizze.png', 'foto.JPG']]);
  // ein Runner ohne Bilder antwortet „Binärdatei“; ein fremder Bildtyp kommt nicht durch
  f.df.oeffneBild({ pfad: 'alt.png' });
  await fertig(f);
  assert.deepEqual([f.lese().phase, f.lese().leer, f.lese().bild], ['fehler', 'Das ist kein Bild, das sich anzeigen lässt (PNG, JPEG, GIF oder WebP).', '']);
  f.df.oeffneBild({ pfad: 'boese.png' });
  await fertig(f);
  assert.deepEqual([f.lese().leer, f.vorn().querySelector('img')], ['Dieser Runner zeigt keine Bilder.', null]);
});

dom('Anhang: Reiter und Kopf tragen den Namen, den der Mensch der Datei gab; der Ort im Datenordner steht nur im Titel', async () => {
  const bild = '/daten/anhaenge/g-7/mwc1-1-skizze.png';
  const text = '/daten/anhaenge/g-7/mwc1-2-lauf.log';
  const f = flaeche({ dateien: { [bild]: { binaer: true, bild: { typ: 'image/png', bild: BILD, breite: 4, hoehe: 3 } }, [text]: { text: 'eins\nzwei\n' } } });
  f.df.oeffneBild({ pfad: bild, name: 'skizze.png' });
  await fertig(f);
  assert.deepEqual([f.reiter(), f.lese().pfad, f.vorn().querySelector('.df-pfad').title, f.vorn().querySelector('img').alt, f.g('r').querySelector('.fl-reiter-knopf').title], [['skizze.png'], 'Anhang · skizze.png', bild, 'Bild skizze.png', 'Bild: Anhang · skizze.png']);
  // eine angehängte Textdatei über „Datei öffnen“; ein angehängtes Bild findet denselben Weg am Namen der Datei
  f.df.oeffneDatei({ pfad: text, name: '<b>lauf</b>.log' });
  await fertig(f);
  assert.deepEqual([f.reiter(), f.lese().pfad, f.lese().zeilen.length, f.vorn().querySelector('.df-inhalt').getAttribute('aria-label')], [['skizze.png', '<b>lauf</b>.log'], 'Anhang · <b>lauf</b>.log', 2, 'Inhalt von Anhang · <b>lauf</b>.log']);
  assert.equal(f.g('w').querySelector('b'), null);
  f.df.oeffneDatei({ pfad: bild, name: 'skizze.png' });
  assert.deepEqual([f.reiter(), f.flaechen.aktiv], [['skizze.png', '<b>lauf</b>.log'], `bild:${bild}`]);
});

dom('Von selbst: ändert der Agent eine Datei, geht ihr Unterschied auf; er drängt sich nicht vor; nach dem Schließen bleibt er zu; im schmalen Fenster gar nicht', async () => {
  const a = `${ORDNER}/a.txt`;
  const b = `${ORDNER}/b.txt`;
  const patch = (name) => ({ ok: true, relativ: name, plus: 1, minus: 0, patch: `--- ${name}\n+++ ${name}\n@@ -0,0 +1 @@\n+neu\n` });
  const f = flaeche({ dateien: { [`${ORDNER}/lies.md`]: { text: 'x\n' } }, diffs: { [a]: patch('a.txt'), [b]: patch('b.txt') } });
  const aufruf = (name) => ({ datei: name, hunks: [{ alt: 1, neu: 1, zeilen: [['+', 'neu']] }] });
  assert.equal(f.df.folgt, true);
  // die erste Änderung: der Bereich geht auf, der Unterschied liegt vorn
  assert.equal(f.df.oeffneDiff({ pfad: 'a.txt', diff: aufruf('a.txt'), vonSelbst: true }), true);
  await fertig(f);
  assert.deepEqual([f.g('w').hidden, f.reiter(), f.lese().hinweis.startsWith('Alle Änderungen'), kopie(f.df.offene().map((x) => [x.id, x.vonSelbst]))], [false, ['± a.txt'], true, [[`diff:${a}`, true]]]);
  // die nächste Datei: vorn liegt eine von selbst geöffnete Fläche, also darf die neue nach vorn
  f.df.oeffneDiff({ pfad: 'b.txt', diff: aufruf('b.txt'), vonSelbst: true });
  await fertig(f);
  assert.deepEqual([f.reiter(), f.flaechen.aktiv], [['± a.txt', '± b.txt'], `diff:${b}`]);
  // der Mensch liest eine Datei: die nächste Änderung öffnet ihren Reiter im Hintergrund
  f.df.oeffneDatei({ pfad: 'lies.md' });
  await fertig(f);
  f.flaechen.schliesse(`diff:${a}`, { still: true });
  f.df.oeffneDiff({ pfad: 'a.txt', diff: aufruf('a.txt'), vonSelbst: true });
  assert.deepEqual([f.flaechen.aktiv, f.reiter()], [`datei:${ORDNER}/lies.md`, ['± b.txt', 'lies.md', '± a.txt']]);
  // der Mensch schließt eine von selbst geöffnete Fläche: ab jetzt bleibt es zu
  [...f.g('r').querySelectorAll('.fl-reiter-zu')].find((x) => x.getAttribute('aria-label') === '± b.txt schließen').click();
  assert.equal(f.df.folgt, false);
  assert.equal(f.df.oeffneDiff({ pfad: 'b.txt', diff: aufruf('b.txt'), vonSelbst: true }), false);
  assert.deepEqual(f.reiter(), ['lies.md', '± a.txt']);
  // öffnet er selbst wieder etwas, folgt die Fläche wieder
  f.df.oeffneDiff({ pfad: 'a.txt' });
  assert.equal(f.df.folgt, true);
  assert.equal(kopie(f.df.offene()).find((x) => x.id === `diff:${a}`).vonSelbst, false, 'selbst geöffnet zählt nicht mehr als von selbst');
  // im schmalen Fenster läge die Fläche über dem Gespräch: dann geht sie nicht von selbst auf
  f.s.breit = false;
  assert.equal(f.df.oeffneDiff({ pfad: 'b.txt', diff: aufruf('b.txt'), vonSelbst: true }), false);
  f.s.breit = true;
  // verdrängt (zu viele offen) ist kein Schließen durch den Menschen
  const g = flaeche({ hoechstens: 1, diffs: { [a]: patch('a.txt'), [b]: patch('b.txt') } });
  g.df.oeffneDiff({ pfad: 'a.txt', diff: aufruf('a.txt'), vonSelbst: true });
  g.df.oeffneDiff({ pfad: 'b.txt', diff: aufruf('b.txt'), vonSelbst: true });
  g.df.oeffneDiff({ pfad: 'c.txt', diff: aufruf('c.txt'), vonSelbst: true });
  assert.deepEqual([g.df.folgt, g.reiter().length], [true, 2], 'eine vorn, eine verdrängt, die neue dazu');
});

dom('Nachziehen: ändert der Agent etwas, liest die sichtbare Fläche still neu (ohne zu flackern, der Rollstand bleibt); verdeckte lesen beim Wechsel', async () => {
  const a = `${ORDNER}/a.txt`;
  let fassung = 1;
  const f = flaeche({
    dateien: { [a]: () => ({ text: `Fassung ${fassung}\n` }), [`${ORDNER}/b.txt`]: () => ({ text: `b ${fassung}\n` }) },
    diffs: { [a]: () => ({ ok: true, relativ: 'a.txt', plus: fassung, minus: 0, patch: `--- a.txt\n+++ a.txt\n@@ -0,0 +1 @@\n+Fassung ${fassung}\n` }) },
  });
  f.df.oeffneDatei({ pfad: 'b.txt' });
  await fertig(f);
  f.df.oeffneDatei({ pfad: 'a.txt' });
  await fertig(f);
  f.df.oeffneDiff({ pfad: 'a.txt', diff: { datei: 'a.txt', hunks: [{ alt: 1, neu: 1, zeilen: [['+', 'Aufruf']] }] } });
  f.flaechen.aktiviere(`datei:${a}`);
  f.vorn().querySelector('.df-inhalt').scrollTop = 120;
  fassung = 2;
  const phasen = [];
  const beobachter = new f.w.MutationObserver(() => phasen.push(f.vorn() ? f.vorn().dataset.phase : '-'));
  beobachter.observe(f.vorn(), { attributes: true, attributeFilter: ['data-phase'] });
  f.df.beiAenderung();
  await bis(() => f.lese().zeilen[0][1] === 'Fassung 2');
  await warte(10);
  beobachter.disconnect();
  assert.ok(!phasen.includes('laedt'), 'die sichtbare Fläche zeigt beim stillen Nachladen nie „Wird gelesen“');
  assert.equal(f.vorn().querySelector('.df-inhalt').scrollTop, 120);
  // die verdeckte Datei las nicht; beim Wechsel holt sie es nach. Die Änderung eines Aufrufs bleibt, was sie war.
  assert.equal(f.abfragen('b%2Etxt'), 1);
  f.flaechen.aktiviere(`datei:${ORDNER}/b.txt`);
  await bis(() => f.lese().zeilen[0] && f.lese().zeilen[0][1] === 'b 2');
  assert.equal(f.abfragen('b%2Etxt'), 2);
  f.flaechen.aktiviere(`aufruf:${a}`);
  await warte(20);
  assert.deepEqual([f.lese().diff, f.abfragen('staende/diff')], [[['+', 'Aufruf', '|1']], 0]);
  // noch einmal wechseln liest nichts neu
  f.flaechen.aktiviere(`datei:${ORDNER}/b.txt`);
  await warte(20);
  assert.equal(f.abfragen('b%2Etxt'), 2);
});

dom('Sitzungswechsel: die offenen Flächen gehören zur Sitzung; zurück in der ersten stehen sie wieder da und lesen neu', async () => {
  const f = flaeche({ dateien: { [`${ORDNER}/a.txt`]: (u) => ({ text: `a in ${u.searchParams.get('gespraech')}\n` }), [`${ORDNER}/b.txt`]: { text: 'b\n' }, '/anders/c.txt': { text: 'c\n' } } });
  f.flaechen.oeffne({ id: 'browser', titel: 'Browser', teil: f.g('fest'), fest: true });
  f.df.oeffneDatei({ pfad: 'a.txt' });
  await fertig(f);
  f.df.oeffneDatei({ pfad: 'b.txt' });
  await fertig(f);
  f.flaechen.aktiviere(`datei:${ORDNER}/a.txt`);
  assert.deepEqual(f.reiter(), ['Browser', 'a.txt', 'b.txt']);
  // andere Sitzung, anderer Ordner: ihre Flächen sind leer, der Browser bleibt
  f.s.sitzung = 8;
  f.s.ordner = '/anders';
  f.df.setzeSitzung(8);
  assert.deepEqual([f.reiter(), f.flaechen.aktiv, kopie(f.df.offene())], [['Browser'], 'browser', []]);
  f.df.oeffneDatei({ pfad: 'c.txt' });
  await fertig(f);
  assert.deepEqual([f.reiter(), f.lese().pfad], [['Browser', 'c.txt'], 'c.txt']);
  // zurück: die beiden Flächen der ersten Sitzung sind wieder da, vorn liegt, was vorn lag, und liest neu
  f.s.sitzung = 7;
  f.s.ordner = ORDNER;
  const vorher = f.abfragen('a%2Etxt');
  f.df.setzeSitzung(7);
  assert.deepEqual([f.reiter(), f.flaechen.aktiv], [['Browser', 'a.txt', 'b.txt'], `datei:${ORDNER}/a.txt`]);
  await bis(() => f.abfragen('a%2Etxt') === vorher + 1);
  await fertig(f);
  assert.deepEqual([f.lese().zeilen, f.abfragen('b%2Etxt')], [[['1', 'a in 7', false]], 1]);
  // dieselbe Sitzung noch einmal setzen ändert nichts
  f.df.setzeSitzung(7);
  assert.deepEqual(f.reiter(), ['Browser', 'a.txt', 'b.txt']);
  // und die zweite hat ihre behalten
  f.s.sitzung = 8;
  f.s.ordner = '/anders';
  f.df.setzeSitzung(8);
  assert.deepEqual(f.reiter(), ['Browser', 'c.txt']);
});

/** Ansicht und Adapter wie im Gespräch, mit den Rückrufen der Seite. */
function ansicht(opts) {
  const d = new jsdom.JSDOM('<!doctype html><body><div id="verlauf"><div id="spalte"></div></div><button id="ende" hidden></button><div id="ansage"></div></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = d.window;
  for (const s of ['markdown-strom.js', 'terminal.js', 'chat-renderer.js', 'runner-adapter.js', 'runner-wege.js', 'flaechen.js', 'datei-flaeche.js']) w.eval(lies(s));
  const FP = w.FyosPrototyp;
  const view = FP.createChatView(w.document.getElementById('spalte'), {
    scroller: w.document.getElementById('verlauf'), zumEnde: w.document.getElementById('ende'), ansage: w.document.getElementById('ansage'),
    raf: (f) => setTimeout(() => f(Date.now()), 0), caf: () => {}, setInterval: () => 1, clearInterval: () => {}, reduceMotion: () => true, pace: false,
    ...opts,
  });
  return { w, d: w.document, FP, view, adapter: FP.createRunnerAdapter(view, (opts && opts.adapter) || {}) };
}
const aufruf = (id, name, args) => ({ id: `e${id}`, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }], stopReason: 'toolUse' }] });
const ergebnis = (id, name, text, details) => ({ id: `r${id}`, kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], isError: false, ...(details ? { details } : {}) }] });

dom('Gespräch: „Datei öffnen“ an Lese- und Schreibkarten, „Groß ansehen“ am Unterschied, Kachel eines Anhangs, @Datei und ein Pfad im Text der Antwort', async () => {
  const gewaehlt = [];
  const anhang = [];
  const enden = [];
  const { w, d, view, adapter } = ansicht({ onDatei: (x) => gewaehlt.push(kopie(x)), onAnhang: (a) => anhang.push(kopie(a)), adapter: { onWerkzeugEnde: (x) => enden.push(kopie(x)) } });
  adapter.replay([
    { id: 1, kind: 'fyos.mensch', data: { text: 'Sieh dir @src/b.txt an', von: 'mensch', zeit: 1, anhaenge: [
      { art: 'bild', name: 'skizze.png', groesse: 4096, breite: 4, hoehe: 3, pfad: '/daten/anhaenge/g-1/x-1-skizze.png', vorschau: `data:image/png;base64,${BILD}`, ansModell: true },
      { art: 'datei', name: 'lauf.log', groesse: 99, pfad: '/daten/anhaenge/g-1/x-2-lauf.log' },
      { art: 'datei', name: 'ohne-ort.txt', groesse: 3 },
    ] }, model: [{ role: 'user', content: 'Sieh dir @src/b.txt an' }] },
    aufruf('a', 'read', { path: 'src/b.txt', offset: 40, limit: 20 }),
    ergebnis('a', 'read', 'zeile 40\nzeile 41'),
    aufruf('b', 'edit', { path: 'src/b.txt', edits: [{ oldText: 'zwei', newText: 'ZWEI' }] }),
    ergebnis('b', 'edit', 'ok', { patch: PATCH }),
    aufruf('c', 'bash', { command: 'ls' }),
    ergebnis('c', 'bash', 'a\nb'),
    { id: 9, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'Die Stelle ist `src/b.txt:2`, gebaut mit `FP.baueDiff` und `chat.js`.' }], stopReason: 'stop' }] },
  ], false);
  await bis(() => d.querySelectorAll('.karte').length === 3 && d.querySelector('code.inline'));
  await warte(20);

  // Karten: nur Datei-Werkzeuge tragen den Knopf; bei read mit der gelesenen Stelle
  const karten = [...d.querySelectorAll('.karte')];
  const knopf = (k) => k.querySelector('.karte-aktion');
  assert.deepEqual(karten.map((k) => [k.dataset.art, knopf(k) ? knopf(k).textContent : null, k.querySelector('.karte-aktionen').hidden]), [['lesen', 'Datei öffnen', false], ['edit', 'Datei öffnen', false], ['bash', null, true]]);
  assert.equal(knopf(karten[0]).title, 'Rechts neben dem Gespräch öffnen, an Zeile 40');
  knopf(karten[0]).click();
  knopf(karten[1]).click();
  // Unterschied der Karte groß
  const gross = karten[1].querySelector('.diff-kopf .diff-auf');
  assert.equal(gross.textContent, 'Groß ansehen');
  gross.click();
  assert.deepEqual(gewaehlt.slice(0, 2), [{ art: 'datei', pfad: 'src/b.txt', zeile: 40 }, { art: 'datei', pfad: 'src/b.txt', zeile: 0 }]);
  assert.deepEqual([gewaehlt[2].art, gewaehlt[2].pfad, gewaehlt[2].diff.hunks[0].alt, gewaehlt[2].diff.hunks[0].zeilen.length], ['diff', 'src/b.txt', 1, 5]);

  // Anhänge: was beim Runner liegt, ist ein Knopf; ohne Ort bleibt es ein Schild
  const kacheln = [...d.querySelectorAll('.anhang-kachel')];
  assert.deepEqual(kacheln.map((k) => [k.tagName, k.getAttribute('role')]), [['BUTTON', null], ['BUTTON', null], ['SPAN', 'listitem']]);
  kacheln[0].click();
  kacheln[1].click();
  assert.deepEqual(anhang.map((a) => [a.art, a.name, a.pfad]), [['bild', 'skizze.png', '/daten/anhaenge/g-1/x-1-skizze.png'], ['datei', 'lauf.log', '/daten/anhaenge/g-1/x-2-lauf.log']]);

  // @Datei in der Nachricht des Menschen
  const erw = d.querySelector('.mensch .erwaehnung');
  assert.deepEqual([erw.tagName, erw.textContent], ['BUTTON', '@src/b.txt']);
  erw.click();
  assert.deepEqual(gewaehlt[3], { art: 'datei', pfad: 'src/b.txt', zeile: 0 });

  // Pfade im Text der Antwort: gekennzeichnet, mit Klick und Enter; anderer Code bleibt Code
  const codes = [...d.querySelectorAll('code.inline')];
  assert.deepEqual(codes.map((c) => [c.textContent, c.classList.contains('pfad'), c.getAttribute('role'), c.tabIndex]), [['src/b.txt:2', true, 'link', 0], ['FP.baueDiff', false, null, -1], ['chat.js', true, 'link', 0]]);
  codes[0].click();
  codes[1].click();
  codes[2].dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  codes[2].dispatchEvent(new w.KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
  assert.deepEqual(gewaehlt.slice(4), [{ art: 'datei', pfad: 'src/b.txt', zeile: 2 }, { art: 'datei', pfad: 'chat.js', zeile: 0 }]);

  // der Adapter nennt am Ende eines Datei-Werkzeugs Datei und Änderung (so geht der Unterschied von selbst auf)
  assert.deepEqual(enden.map((x) => [x.name, x.live, x.pfad, !!x.diff]), [['read', false, 'src/b.txt', false], ['edit', false, 'src/b.txt', true], ['bash', false, undefined, false]]);
  adapter.apply({ type: 'tool_execution_start', toolCallId: 'z', toolName: 'write', args: { path: 'neu.txt', content: 'neu\n' } });
  adapter.apply({ type: 'tool_execution_end', toolCallId: 'z', toolName: 'write', entry: { id: 30, model: [{ role: 'toolResult', content: [{ type: 'text', text: 'ok' }], isError: false }] } });
  assert.deepEqual([enden.at(-1).name, enden.at(-1).live, enden.at(-1).pfad, enden.at(-1).diff.datei], ['write', true, 'neu.txt', 'neu.txt']);
});

dom('Gespräch ohne Flächen (die Seite bietet sie nicht an): keine Knöpfe, Kacheln und @Datei bleiben Schilder, ein Klick auf einen Pfad tut nichts', async () => {
  const { d, adapter } = ansicht({});
  adapter.replay([
    { id: 1, kind: 'fyos.mensch', data: { text: 'Sieh dir @src/b.txt an', von: 'mensch', zeit: 1, anhaenge: [{ art: 'datei', name: 'lauf.log', groesse: 99, pfad: '/daten/x-2-lauf.log' }] }, model: [{ role: 'user', content: 'Sieh dir @src/b.txt an' }] },
    aufruf('b', 'edit', { path: 'src/b.txt', edits: [{ oldText: 'zwei', newText: 'ZWEI' }] }),
    ergebnis('b', 'edit', 'ok', { patch: PATCH }),
    { id: 9, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'Siehe `src/b.txt:2`.' }], stopReason: 'stop' }] },
  ], false);
  await bis(() => d.querySelector('.karte .diff') && d.querySelector('code.inline'));
  assert.deepEqual([d.querySelector('.karte-aktion'), d.querySelector('.diff-auf'), d.querySelector('.karte-aktionen').hidden], [null, null, true]);
  assert.deepEqual([d.querySelector('.anhang-kachel').tagName, d.querySelector('.mensch-anhaenge').getAttribute('role'), d.querySelector('.erwaehnung').tagName], ['SPAN', 'list', 'SPAN']);
  d.querySelector('code.inline').click();
});

// Beim Prüfen der Flächen gefunden (Befund F41 im Plan): in einem verdeckten Bereich feuern keine Animationsbilder, das Fenster hält sich aber
// für sichtbar. Die Antwort kam an und wurde nie gezeichnet.
dom('Anzeige ohne Animationsbilder: hält sich das Fenster für sichtbar und bekommt doch keine, zieht ein Zeitgeber die Antwort nach', async () => {
  const abgesagt = [];
  const ohne = ansicht({ raf: () => 7, caf: (id) => abgesagt.push(id), pace: true, reduceMotion: () => false, wacheMs: 20 });
  ohne.view.startTurn();
  ohne.view.appendText('Hallo, das ist eine Antwort.');
  ohne.view.startTool({ id: 'a', name: 'bash', args: { command: 'ls' } });
  assert.equal(ohne.d.querySelector('.karte'), null, 'ohne Bild steht noch nichts da');
  await bis(() => ohne.d.querySelector('.karte') && /Hallo, das ist eine Antwort\./.test(ohne.d.getElementById('spalte').textContent));
  assert.ok(ohne.view.stats.wache >= 1 && abgesagt.includes(7), 'die Wache hat das wartende Bild abgesagt und selbst weitergemacht');
  // mit Animationsbildern greift sie nicht ein
  const mit = ansicht({ pace: true, reduceMotion: () => false, wacheMs: 20 });
  mit.view.startTurn();
  mit.view.appendText('Zweite Antwort.');
  await bis(() => /Zweite Antwort\./.test(mit.d.getElementById('spalte').textContent));
  await warte(60);
  assert.equal(mit.view.stats.wache || 0, 0);
  // abgeschaltet (wacheMs: 0) bleibt es beim alten Verhalten
  const aus = ansicht({ raf: () => 7, caf: () => {}, pace: true, reduceMotion: () => false, wacheMs: 0 });
  aus.view.startTurn();
  aus.view.appendText('Nie gezeichnet.');
  await warte(60);
  assert.ok(!/Nie gezeichnet/.test(aus.d.getElementById('spalte').textContent));
  aus.view.flush();
  assert.match(aus.d.getElementById('spalte').textContent, /Nie gezeichnet\./);
});

dom('Tafel „Änderungen“: mit der Seite öffnet ein Klick auf den Namen den Unterschied als Fläche; ohne sie klappt er wie bisher in der Leiste auf', async () => {
  const html = lies('chat.html');
  const bau = (mitSeite) => {
    const d = new jsdom.JSDOM(html.replace(/<script[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, ''), { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = d.window;
    for (const s of ['markdown-strom.js', 'terminal.js', 'chat-renderer.js', 'runner-adapter.js', 'runner-wege.js', 'staende-tafel.js']) w.eval(lies(s));
    const FP = w.FyosPrototyp;
    const g = (id) => w.document.getElementById(id);
    const gewaehlt = [];
    const gets = [];
    const transport = {
      api: async (m, pfad) => {
        gets.push(pfad);
        if (/staende\/diff/.test(pfad)) return { ok: true, relativ: 'src/b.txt', plus: 2, minus: 1, patch: PATCH };
        return { ok: true, ordner: ORDNER, dateien: [{ pfad: `${ORDNER}/src/b.txt`, relativ: 'src/b.txt', zustand: 'geaendert', plus: 2, minus: 1, aenderungen: 1, fremd: false, gesichert: true }], staende: [], gesamt: { dateien: 1, plus: 2, minus: 1 } };
      },
    };
    const t = FP.staende.createStaendeTafel(
      { knopf: g('schieneAenderungen'), marke: g('staendeMarke'), leer: g('staendeLeer'), dateien: g('staendeDateien'), staendeKopf: g('staendeKopf'), staende: g('staendeListe'), fuss: g('staendeFuss') },
      { wege: FP.wege.createWege(transport), transport, ...(mitSeite ? { beiDatei: (x) => (gewaehlt.push(x.pfad), mitSeite === 'ja') } : {}) },
    );
    return { g, t, gewaehlt, gets };
  };
  const mit = bau('ja');
  mit.t.setzeSitzung(7);
  await bis(() => mit.g('staendeDateien').querySelector('.st-name'));
  const name = mit.g('staendeDateien').querySelector('.st-name');
  assert.equal(name.hasAttribute('aria-expanded'), false, 'nichts klappt in der Leiste auf');
  name.click();
  await warte(20);
  assert.deepEqual([[...mit.gewaehlt], mit.g('staendeDateien').querySelector('.st-diff'), mit.gets.filter((p) => /diff/.test(p)).length], [[`${ORDNER}/src/b.txt`], null, 0]);
  // die Seite konnte nicht (sie antwortet false): der Unterschied klappt in der Leiste auf
  const halb = bau('nein');
  halb.t.setzeSitzung(7);
  await bis(() => halb.g('staendeDateien').querySelector('.st-name'));
  halb.g('staendeDateien').querySelector('.st-name').click();
  await bis(() => halb.g('staendeDateien').querySelector('.st-diff .diff-tabelle'));
  // ohne die Seite: wie bisher
  const ohne = bau(null);
  ohne.t.setzeSitzung(7);
  await bis(() => ohne.g('staendeDateien').querySelector('.st-name'));
  assert.equal(ohne.g('staendeDateien').querySelector('.st-name').getAttribute('aria-expanded'), 'false');
  ohne.g('staendeDateien').querySelector('.st-name').click();
  await bis(() => ohne.g('staendeDateien').querySelector('.st-diff .diff-tabelle'));
});

test('Quelltext: gelesen wird über runner-wege.js, nichts geschrieben, Texte nur als Text, keine Signalfarbe; die Seite bindet beides ein', () => {
  for (const n of ['flaechen.js', 'datei-flaeche.js']) {
    const q = lies(n);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|fetch\(/.test(q), n);
    assert.ok(!/transport\.api|api\('(GET|POST|PATCH|PUT|DELETE)'/.test(q), `${n}: kein eigener Weg zum Runner`);
    const verboten = new RegExp(['gin', 'ny|perse', 'phone|ti', 'tan|rh', 'ea|sirf', 'yyn|ka', 'ty|/Users/'].join(''), 'i');
    assert.ok(!verboten.test(q), `${n}: kein Agenten-, Rechner- oder Pfadname im Quelltext`);
  }
  const css = lies('flaechen.css');
  assert.ok(!/var\(--akzent\)|255, 45, 149|ff2d95/i.test(css), 'die Flächen bringen kein Pink mit');
  const html = lies('chat.html');
  for (const id of ['flaechen', 'flaechenReiter', 'flaechenKoerper', 'flaechenZu', 'flaecheBrowser']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /<link rel="stylesheet" href="flaechen\.css">/);
  assert.match(html, /<script src="flaechen\.js"><\/script>\s*<script src="datei-flaeche\.js"><\/script>\s*<script src="browser-flaeche\.js">/);
  const chat = lies('chat.js');
  assert.match(chat, /beiDatei: \(d\) => dateiFlaeche\.oeffneDiff\(\{ pfad: d\.pfad \}\)/, 'die Tafel „Änderungen“ öffnet den Unterschied als Fläche');
  assert.match(chat, /dateiFlaeche\.oeffneDiff\(\{ pfad: w\.pfad, diff: w\.diff, vonSelbst: true \}\)/, 'eine Änderung des Agenten öffnet ihren Unterschied');
  assert.match(chat, /dateiFlaeche\.setzeSitzung\(rec\.id\);/);
  assert.match(chat, /sichtbar: \(\) => !document\.hidden && flaechen\.aktiv === 'browser'/, 'der Browser zieht sein Bild nur nach, wenn er vorn liegt');
  const wege = lies('runner-wege.js');
  assert.match(wege, /&bild=1/);
});
