// Browser-Fläche der Agent-Oberfläche (browser-flaeche.js, Paket A6/B2 in FYOS-AGENT-LOKAL-PLAN): Stand und Bild vom Runner, Bedienung durch den
// Menschen (Adresse, Klick, Rad, Tasten), Öffnen von selbst, wenn der Agent den Browser bedient; ehrlich, wenn der Runner die Fläche nicht kennt.
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

const BILD = Buffer.from([0xff, 0xd8, 0xff, 0x01]).toString('base64');
const BILD2 = Buffer.from([0xff, 0xd8, 0xff, 0x02]).toString('base64');
const stand = (extra) => ({ ok: true, browser: { an: true, verfuegbar: true, art: 'webkit', herkunft: 'playwright', grund: null, laeuft: false, url: null, titel: null, breite: 1280, hoehe: 800, ...extra } });

/** Die Fläche im echten Gerüst der Seite, mit einem Runner aus dem Test (GET-Antworten in der Reihenfolge, POST mit Protokoll). */
function flaeche({ get, post } = {}) {
  const html = lies('chat.html');
  const d = new jsdom.JSDOM(html.replace(/<script[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, ''), { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = d.window;
  for (const s of ['runner-wege.js', 'browser-flaeche.js']) w.eval(lies(s));
  const FP = w.FyosPrototyp;
  const dok = w.document;
  const g = (id) => dok.getElementById(id);
  const z = { gets: [], posts: [], offen: [], takte: [] };
  const transport = {
    api: async (methode, pfad, koerper) => {
      if (methode === 'GET') {
        z.gets.push(pfad);
        const r = typeof get === 'function' ? get(pfad, z) : get;
        if (r instanceof Error) throw r;
        return r;
      }
      z.posts.push([pfad, JSON.parse(JSON.stringify(koerper))]);
      const r = post ? post(koerper, z) : stand({ laeuft: true, url: 'http://localhost:5173/', titel: 'Seite', kenn: 'aaaaaaaaaaaaaaaa', typ: 'image/jpeg', bild: BILD });
      if (r instanceof Error) throw r;
      return r;
    },
  };
  const f = FP.createBrowserFlaeche(
    {
      wurzel: g('browserFlaeche'), knopf: g('browserKnopf'), form: g('browserForm'), ziel: g('browserZiel'), zurueck: g('browserZurueck'), vor: g('browserVor'),
      neu: g('browserNeu'), beenden: g('browserBeenden'), buehne: g('browserBuehne'), bild: g('browserBild'), hinweis: g('browserHinweis'), lage: g('browserLage'),
    },
    {
      transport,
      wege: FP.wege.createWege(transport),
      gespraech: () => 7,
      beiOffen: (an) => z.offen.push(an),
      sichtbar: () => true,
      setInterval: (fn) => z.takte.push(fn),
      clearInterval: (id) => {
        z.takte[id - 1] = () => {};
      },
    },
  );
  return { w, dok, g, f, z, FP };
}

test('Punkt im Bild → Punkt in der Seite; Zeile unter dem Kopf', () => {
  const B = logik('browser-flaeche.js').browserFlaeche;
  const r = { left: 100, top: 50, width: 640, height: 400 };
  assert.deepEqual(B.seitenPunkt(100, 50, r, 1280, 800), { x: 0, y: 0 });
  assert.deepEqual(B.seitenPunkt(420, 250, r, 1280, 800), { x: 640, y: 400 });
  assert.deepEqual(B.seitenPunkt(740, 450, r, 1280, 800), { x: 1280, y: 800 });
  assert.equal(B.seitenPunkt(99, 60, r, 1280, 800), null, 'links neben dem Bild');
  assert.equal(B.seitenPunkt(200, 451, r, 1280, 800), null, 'unter dem Bild');
  assert.equal(B.seitenPunkt(1, 1, { left: 0, top: 0, width: 0, height: 0 }, 1280, 800), null);
  assert.equal(B.lageText(null), 'Browser wird geprüft …');
  assert.equal(B.lageText({ verfuegbar: false }), 'Kein Browser');
  assert.equal(B.lageText({ verfuegbar: true, laeuft: false }), 'nicht gestartet');
  assert.equal(B.lageText({ verfuegbar: true, laeuft: true, titel: 'Startseite', url: 'http://x' }), 'Startseite');
  assert.equal(B.lageText({ verfuegbar: true, laeuft: true, titel: '', url: 'http://x' }, true), 'lädt …');
});

test('Antwort des Runners wird bereinigt: nur JPEG oder PNG in Base64, feste Formen', () => {
  const W = logik('runner-wege.js').wege;
  const gut = W.browserBereinigen(stand({ laeuft: true, url: 'http://a', titel: 'T', kenn: 'abcdef0123456789', typ: 'image/png', bild: BILD }));
  assert.deepEqual([gut.verfuegbar, gut.laeuft, gut.url, gut.titel, gut.breite, gut.hoehe, gut.kenn, gut.typ, gut.bild], [true, true, 'http://a', 'T', 1280, 800, 'abcdef0123456789', 'image/png', BILD]);
  for (const schlecht of [{ typ: 'image/svg+xml', bild: BILD }, { typ: 'image/jpeg', bild: '<svg onload=alert(1)>' }, { typ: 'text/html', bild: BILD }, { typ: 'image/jpeg', bild: 5 }]) {
    const b = W.browserBereinigen(stand({ laeuft: true, ...schlecht }));
    assert.deepEqual([b.bild, b.typ], [null, ''], JSON.stringify(schlecht));
  }
  const leer = W.browserBereinigen({});
  assert.deepEqual([leer.verfuegbar, leer.laeuft, leer.grund, leer.breite, leer.hoehe, leer.kenn], [false, false, '', 1280, 800, '']);
  assert.equal(W.browserBereinigen(stand({ kenn: 'nicht-hex!' })).kenn, '');
  assert.deepEqual([W.browserBereinigen(stand({ breite: 99999, hoehe: -5 })).breite, W.browserBereinigen(stand({ breite: 99999, hoehe: -5 })).hoehe], [10000, 1]);
});

dom('Kennt der Runner die Fläche nicht, bleibt der Knopf weg; ohne Browser auf dem Rechner sagt die Fläche, was fehlt', async () => {
  const ohne = flaeche({ get: Object.assign(new Error('HTTP 404'), { status: 404, fehler: 'Unbekannte Route: GET /api/browser' }) });
  assert.equal(await ohne.f.pruefe(), false);
  assert.equal(ohne.g('browserKnopf').hidden, true);
  ohne.f.zeige(true);
  assert.equal(ohne.g('browserFlaeche').hidden, true, 'ohne den Weg geht die Fläche nicht auf');
  assert.deepEqual(ohne.z.posts, []);

  const fehlt = flaeche({ get: stand({ verfuegbar: false, grund: 'Kein Browser gefunden. Installiere einen.' }) });
  assert.equal(await fehlt.f.pruefe(), true);
  assert.equal(fehlt.g('browserKnopf').hidden, false);
  fehlt.g('browserKnopf').click();
  await warte(20);
  assert.equal(fehlt.g('browserFlaeche').hidden, false);
  assert.deepEqual(fehlt.z.offen, [true]);
  assert.equal(fehlt.g('browserLage').textContent, 'Kein Browser');
  assert.equal(fehlt.g('browserHinweis').textContent, 'Kein Browser gefunden. Installiere einen.');
  assert.equal(fehlt.g('browserZiel').disabled, true);
  assert.equal(fehlt.g('browserBild').hidden, true);
  assert.equal(fehlt.g('browserBuehne').dataset.zustand, 'fehlt');
});

dom('Adresse öffnen, Bild zeigen, Klick an derselben Stelle der Seite, Rad gesammelt, Tasten als Text und als Taste', async () => {
  // der Runner der Attrappe: der Browser läuft erst, nachdem der Mensch eine Adresse geöffnet hat
  const f = flaeche({
    get: (pfad, z) => (z.posts.length ? stand({ laeuft: true, url: 'http://localhost:5173/', titel: 'Seite', kenn: 'aaaaaaaaaaaaaaaa', unveraendert: true }) : stand()),
  });
  await f.f.pruefe();
  f.g('browserKnopf').click();
  await warte(20);
  assert.equal(f.g('browserBuehne').dataset.zustand, 'ruht');
  assert.match(f.g('browserHinweis').textContent, /startet, sobald du oder der Agent eine Seite öffnet/);
  assert.equal(f.g('browserZiel').disabled, false);
  assert.equal(f.g('browserZurueck').disabled, true);

  // Adresse eingeben: POST mit der sichtbaren Sitzung; danach steht das Bild da und die Adresse folgt der Seite
  f.g('browserZiel').value = '  localhost:5173  ';
  f.g('browserForm').dispatchEvent(new f.w.Event('submit', { cancelable: true }));
  await bis(() => f.z.posts.length === 1);
  assert.deepEqual(f.z.posts[0], ['/api/browser/aktion', { aktion: 'oeffnen', url: 'localhost:5173', gespraech: 7 }]);
  await bis(() => !f.g('browserBild').hidden);
  assert.equal(f.g('browserBild').getAttribute('src'), `data:image/jpeg;base64,${BILD}`);
  assert.equal(f.g('browserBild').alt, 'Seite im Browser: Seite');
  assert.deepEqual([f.g('browserLage').textContent, f.g('browserZiel').value, f.g('browserZurueck').disabled, f.g('browserBeenden').hidden, f.g('browserHinweis').hidden], ['Seite', 'http://localhost:5173/', false, false, true]);

  // Klick: das Bild liegt bei (100, 50) und ist 640 x 400 groß, die Seite 1280 x 800
  f.g('browserBild').getBoundingClientRect = () => ({ left: 100, top: 50, width: 640, height: 400 });
  f.g('browserBild').dispatchEvent(new f.w.MouseEvent('click', { clientX: 420, clientY: 250, bubbles: true }));
  await bis(() => f.z.posts.length === 2);
  assert.deepEqual(f.z.posts[1][1], { aktion: 'klick', x: 640, y: 400, gespraech: 7 });

  // Rad: drei Rasten werden eine Anfrage
  for (const dy of [40, 60, 100]) f.g('browserBuehne').dispatchEvent(new f.w.WheelEvent('wheel', { deltaY: dy, cancelable: true }));
  await bis(() => f.z.posts.length === 3);
  assert.deepEqual(f.z.posts[2][1], { aktion: 'scroll', dx: 0, dy: 200, gespraech: 7 });

  // Tasten: Buchstaben gesammelt als Text, Enter davor abgeschickt als eigene Taste; mit Cmd gehört die Taste der App
  const taste = (key, extra) => {
    const e = new f.w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
    f.g('browserBuehne').dispatchEvent(e);
    return e.defaultPrevented;
  };
  assert.deepEqual([taste('h'), taste('i'), taste('Enter')], [true, true, true]);
  assert.equal(taste('r', { metaKey: true }), false);
  assert.equal(taste('F5'), false, 'unbekannte Sondertasten bleiben liegen');
  await bis(() => f.z.posts.length === 5);
  assert.deepEqual(f.z.posts.slice(3).map((p) => p[1]), [{ aktion: 'tippen', text: 'hi', gespraech: 7 }, { aktion: 'taste', taste: 'Enter', gespraech: 7 }]);

  // Knöpfe der Leiste
  f.g('browserZurueck').click();
  f.g('browserVor').click();
  f.g('browserNeu').click();
  await bis(() => f.z.posts.length === 8);
  assert.deepEqual(f.z.posts.slice(5).map((p) => p[1].aktion), ['zurueck', 'vor', 'neu']);
});

dom('Takt: das Bild zieht nach, solange der Browser läuft; ein unverändertes Bild bleibt stehen; ein Fehler steht als Zeile da', async () => {
  let bild = { kenn: 'aaaaaaaaaaaaaaaa', typ: 'image/jpeg', bild: BILD };
  const f = flaeche({
    get: (pfad) => {
      if (pfad === '/api/browser') return stand({ laeuft: true, url: 'http://a/', titel: 'A' });
      return pfad.endsWith(`kenn=${bild.kenn}`) ? stand({ laeuft: true, url: 'http://a/', titel: 'A', kenn: bild.kenn, unveraendert: true }) : stand({ laeuft: true, url: 'http://a/', titel: 'A', ...bild });
    },
    post: () => Object.assign(new Error('HTTP 400'), { status: 400, fehler: 'Dateien öffnet der Browser nur im Ordner der Sitzung und in den freigegebenen Ordnern.' }),
  });
  await f.f.pruefe();
  f.f.zeige(true);
  await bis(() => f.g('browserBild').getAttribute('src'));
  assert.equal(f.z.takte.length, 1, 'ein Takt, solange die Fläche offen ist');
  const quelle = f.g('browserBild').getAttribute('src');
  // derselbe Stand: die Abfrage nennt die Kennung, das Bild bleibt dasselbe
  f.z.takte[0]();
  await bis(() => f.z.gets.some((p) => p === '/api/browser/bild?kenn=aaaaaaaaaaaaaaaa'));
  await warte(20);
  assert.equal(f.g('browserBild').getAttribute('src'), quelle);
  // die Seite hat sich geändert (der Agent hat geklickt): neues Bild
  bild = { kenn: 'bbbbbbbbbbbbbbbb', typ: 'image/jpeg', bild: BILD2 };
  f.z.takte[0]();
  await bis(() => f.g('browserBild').getAttribute('src') === `data:image/jpeg;base64,${BILD2}`);

  // eine abgelehnte Adresse: die Meldung des Runners steht da, das Bild bleibt
  f.g('browserZiel').value = '/etc/hosts';
  f.g('browserForm').dispatchEvent(new f.w.Event('submit', { cancelable: true }));
  await bis(() => !f.g('browserHinweis').hidden);
  assert.equal(f.g('browserHinweis').textContent, 'Dateien öffnet der Browser nur im Ordner der Sitzung und in den freigegebenen Ordnern.');
  assert.ok(f.g('browserHinweis').classList.contains('fehler'));
  assert.equal(f.g('browserBild').hidden, false);

  // schließen (in der Seite über den Reiter des Bereichs oder den Knopf im Kopf): der Takt endet, die Seite erfährt es
  f.g('browserKnopf').click();
  assert.deepEqual([f.g('browserFlaeche').hidden, f.z.offen], [true, [true, false]]);
  const vorher = f.z.gets.length;
  f.z.takte[0]();
  await warte(20);
  assert.equal(f.z.gets.length, vorher, 'geschlossen fragt nichts mehr');
});

dom('Bedient der Agent den Browser, geht die Fläche von selbst auf; ein abgespielter Verlauf öffnet sie nicht', async () => {
  const f = flaeche({ get: (pfad) => (pfad === '/api/browser' ? stand({ laeuft: true, url: 'http://a/', titel: 'A' }) : stand({ laeuft: true, url: 'http://a/', titel: 'A', kenn: 'cccccccccccccccc', typ: 'image/png', bild: BILD })) });
  await f.f.pruefe();
  f.f.beiWerkzeug({ name: 'bash' });
  assert.equal(f.f.offen, false);
  f.f.beiWerkzeug({ name: 'browser', status: 'fertig', live: true });
  assert.equal(f.f.offen, true);
  await bis(() => f.g('browserBild').getAttribute('src') === `data:image/png;base64,${BILD}`);

  // der Adapter nennt, ob ein Werkzeug eben geendet hat oder aus dem Verlauf stammt
  const w = { FyosPrototyp: {} };
  new Function('window', 'globalThis', lies('runner-adapter.js'))(w, w);
  const enden = [];
  const leer = () => {};
  const view = { startTurn: leer, endTurn: leer, startTool: leer, updateTool: leer, endTool: leer, appendText: leer, startThinking: leer, endThinking: leer, addNote: leer, addMarker: leer, warte: leer };
  const adapter = w.FyosPrototyp.createRunnerAdapter(view, { onWerkzeugEnde: (x) => enden.push([x.name, x.live]) });
  adapter.replay([
    { id: 1, kind: 'pi.message', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'browser', arguments: { aktion: 'oeffnen' } }] }] },
    { id: 2, kind: 'pi.tool', model: [{ role: 'toolResult', toolCallId: 'a', toolName: 'browser', content: [{ type: 'text', text: 'ok' }], isError: false }] },
  ]);
  adapter.apply({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'browser', args: { aktion: 'sehen' } });
  adapter.apply({ type: 'tool_execution_end', toolCallId: 'b', toolName: 'browser', entry: { id: 3, model: [{ role: 'toolResult', content: [{ type: 'text', text: 'ok' }], isError: false }] } });
  assert.deepEqual(enden, [['browser', false], ['browser', true]]);
});

test('Quelltext: gelesen wird über runner-wege.js, eingesetzt nur Text und geprüfte Bilder; die Seite bindet die Fläche ein', () => {
  const q = lies('browser-flaeche.js');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|fetch\(/.test(q));
  assert.ok(!/transport\.api\('GET'/.test(q), 'Lesen nur über runner-wege.js');
  assert.equal((q.match(/transport\.api\('POST', '\/api\/browser\/aktion'/g) || []).length, 1, 'eine Stelle schickt die Bedienung');
  const verboten = new RegExp(['gin', 'ny|perse', 'phone|ti', 'tan|rh', 'ea|sirf', 'yyn|ka', 'ty|/Users/'].join(''), 'i');
  assert.ok(!verboten.test(q), 'kein Agenten-, Rechner- oder Pfadname im Quelltext');
  const html = lies('chat.html');
  for (const id of ['browserFlaeche', 'browserKnopf', 'browserForm', 'browserZiel', 'browserZurueck', 'browserVor', 'browserNeu', 'browserBeenden', 'browserBuehne', 'browserBild', 'browserHinweis', 'browserLage']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  // die Fläche liegt als Teil im Bereich der Flächen (flaechen.js); geschlossen wird sie über ihren Reiter
  assert.match(html, /<aside id="flaechen" class="flaeche"[^>]*hidden>[\s\S]*<div id="flaecheBrowser" class="fl-teil" hidden>\s*<div id="browserFlaeche" class="bf-wurzel"/);
  assert.ok(!html.includes('id="browserZu"'));
  assert.match(html, /<link rel="stylesheet" href="browser-flaeche\.css">/);
  assert.match(html, /<script src="browser-flaeche\.js"><\/script>\s*<script src="ordner\.js">/);
  const chat = lies('chat.js');
  assert.match(chat, /else if \(w\.name === 'browser' && w\.live\) browserFlaeche\.beiWerkzeug\(w\);/);
  assert.match(chat, /beiOffen: \(an\) => \$\('app'\)\.classList\.toggle\('flaeche-auf', an\)/);
  const css = lies('browser-flaeche.css');
  assert.match(css, /\.app\.flaeche-auf \{ grid-template-columns: var\(--leiste-breite, 332px\) minmax\(0, 1fr\) minmax\(380px, 40%\); \}/);
  assert.match(css, /\.app\.flaeche-auf \.haupt \{ grid-template-columns: minmax\(0, 1fr\); \}/, 'das Gespräch schrumpft neben der Fläche, statt darunter zu ragen');
  assert.ok(!/var\(--akzent\)|255, 45, 149|ff2d95/i.test(css), 'die Fläche bringt kein Pink mit');
});
