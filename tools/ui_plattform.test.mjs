// Vorgänge, Kalender und Ereignisse im Arbeitsplatz (app/ui/agent/plattform.js) mit jsdom und einem Attrappen-Transport.
// Aufruf:  node --test tools/ui_plattform.test.mjs   (aus apps/fyos-shell)
// jsdom liegt nicht in dieser Hülle: gefunden wird es über FYOS_JSDOM_DIR (Ordner mit node_modules/jsdom) oder ein benachbartes fyos-web.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const hier = path.dirname(fileURLToPath(import.meta.url));
const ui = path.join(hier, '..', 'app', 'ui', 'agent');
const lies = (n) => readFileSync(path.join(ui, n), 'utf8');

function findeJsdom() {
  const kandidaten = [process.env.FYOS_JSDOM_DIR, path.join(hier, '..', '..', '..', 'fyos-web')].filter(Boolean);
  for (const k of kandidaten) {
    try {
      return createRequire(path.join(k, 'x.js'))('jsdom');
    } catch {
      /* nächster Ort */
    }
  }
  return null;
}
const jsdom = findeJsdom();
const dom = (name, fn) => test(name, { skip: jsdom ? false : 'jsdom nicht gefunden (FYOS_JSDOM_DIR setzen)' }, fn);

const HTML = `<!doctype html><body>
  <nav id="bereiche" hidden>
    <button data-bereich="chat" class="aktiv">Chat</button>
    <button data-bereich="vorgaenge">Vorgänge <b id="zahl" hidden>0</b></button>
    <button data-bereich="kalender">Kalender</button>
    <button data-bereich="ereignisse">Ereignisse</button>
  </nav>
  <div class="haupt"><div id="panes"></div><div id="wurzel" hidden></div></div>
</body>`;

const warte = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const JETZT = Date.parse('2026-11-06T10:00:00Z');

function ticket(id, status, extra = {}) {
  return { id, type: id.split('-')[0], title: `Titel ${id}`, status, severity: 'medium', assignee: 'agent', reporter: 'agent', updated_at: '2026-11-06T09:00:00Z', created_at: '2026-11-06T08:00:00Z', ...extra };
}

/** Ein Transport, der Antworten je `METHODE weg` kennt und jeden Aufruf mitschreibt. */
function attrappe(antworten = {}) {
  const aufrufe = [];
  const hoerer = [];
  const strome = [];
  return {
    aufrufe,
    strome,
    sende: (p) => hoerer.forEach((h) => h(p)),
    oeffneStrom: async (kanal, pfad) => strome.push({ kanal, pfad }),
    schliesseStrom: async (kanal) => strome.push({ kanal, zu: true }),
    onStrom: (h) => hoerer.push(h),
    api: async (methode, pfad, koerper) => {
      aufrufe.push({ methode, pfad, koerper });
      const schluessel = `${methode} ${pfad.split('?')[0]}`;
      const a = antworten[schluessel];
      if (a === undefined) throw Object.assign(new Error(`HTTP 404`), { status: 404, fehler: 'unbekannt' });
      if (a instanceof Error) throw a;
      return typeof a === 'function' ? a(koerper, pfad) : a;
    },
  };
}

function fenster(antworten, opts = {}) {
  const d = new jsdom.JSDOM(HTML, { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = d.window;
  w.eval(lies('runner-wege.js'));
  w.eval(lies('plattform.js'));
  const transport = attrappe(antworten);
  const p = w.FyosPrototyp.createPlattform(
    {
      nav: w.document.getElementById('bereiche'),
      zahl: w.document.getElementById('zahl'),
      haupt: w.document.querySelector('.haupt'),
      panes: w.document.getElementById('panes'),
      wurzel: w.document.getElementById('wurzel'),
    },
    { transport, intervallMs: 0, jetzt: () => JETZT, ...opts },
  );
  return { w, p, transport, $: (s) => w.document.querySelector(s), $$: (s) => [...w.document.querySelectorAll(s)] };
}
const plain = (x) => JSON.parse(JSON.stringify(x));

const VORGAENGE = {
  'GET /api/tickets/waiting': { anzahl: 2 },
  'GET /api/tickets': {
    tickets: [
      ticket('INC-P1', 'new', { severity: 'low' }),
      ticket('INC-P2', 'new', { severity: 'critical', occurrences: 3 }),
      ticket('CHG-P3', 'waiting_approval', { freigabe_kontext: 'Kontext', freigabe_risiko: 'high', freigabe_zerstoererisch: 'ja' }),
      ticket('VOR-P4', 'triage', { wiedervorlage: '2026-11-20' }),
      ticket('PRB-P5', 'closed'),
    ],
    total: 5,
  },
};

dom('Plattform fehlt beim Runner: nur der Chat, keine Leiste', async () => {
  const { p, $ } = fenster({ 'GET /api/tickets/waiting': Object.assign(new Error('HTTP 503'), { status: 503 }) });
  await p.pruefe();
  assert.equal($('#bereiche').hidden, true);
  assert.equal(p.verfuegbar(), false);
});

dom('Netzfehler versteckt nichts: der Stand bleibt', async () => {
  let frage = 0;
  const { p, $ } = fenster({
    'GET /api/tickets/waiting': () => {
      frage += 1;
      if (frage > 1) throw Object.assign(new Error('weg'), { code: 'RUNNER_NICHT_ERREICHBAR' });
      return { anzahl: 1 };
    },
  });
  await p.pruefe();
  assert.equal($('#bereiche').hidden, false);
  await p.pruefe();
  assert.equal($('#bereiche').hidden, false);
  assert.equal($('#zahl').textContent, '1');
});

dom('Zahl im Knopf: was auf den Besitzer wartet; bei null kein Abzeichen', async () => {
  const { p, $ } = fenster({ 'GET /api/tickets/waiting': { anzahl: 2 } });
  await p.pruefe();
  assert.equal($('#zahl').hidden, false);
  assert.equal($('#zahl').textContent, '2');
  const leer = fenster({ 'GET /api/tickets/waiting': { anzahl: 0 } });
  await leer.p.pruefe();
  assert.equal(leer.$('#zahl').hidden, true);
});

dom('Bereichswechsel: Chat aus, Ansicht an, Knopf markiert, zurück zum Chat', async () => {
  let chat = 0;
  const { p, $, $$ } = fenster(VORGAENGE, { beiChat: () => (chat += 1) });
  await p.pruefe();
  await p.wechsle('vorgaenge');
  assert.equal($('#panes').hidden, true);
  assert.equal($('#wurzel').hidden, false);
  assert.ok($('.haupt').classList.contains('pf-an'));
  assert.ok($('[data-bereich=vorgaenge]').classList.contains('aktiv'));
  $$('.pf-zum-chat').find((b) => !b.closest('.pf-bereich').hidden).click();
  await warte();
  assert.equal(p.bereich(), 'chat');
  assert.equal($('#panes').hidden, false);
  assert.equal(chat, 1);
});

dom('Brett: Spalten in fester Folge, Schwerstes zuerst, Geschlossene nur auf Wunsch', async () => {
  const { p, $, $$, transport } = fenster(VORGAENGE);
  await p.wechsle('vorgaenge');
  assert.deepEqual($$('.pf-spalte').map((s) => s.dataset.status), ['new', 'in_progress', 'waiting_approval', 'triage', 'resolved']);
  assert.deepEqual($$('.pf-s-new .pf-karte').map((k) => k.dataset.id), ['INC-P2', 'INC-P1']);
  assert.match($('[data-id="INC-P2"]').textContent, /3×/);
  assert.match($('[data-id="VOR-P4"]').textContent, /zurück 2026-11-20/);
  assert.doesNotMatch(transport.aufrufe.at(-1).pfad, /closed/);
  const haken = $('.pf-schalter input');
  haken.checked = true;
  haken.dispatchEvent(new (haken.ownerDocument.defaultView.Event)('change'));
  await warte();
  assert.match(decodeURIComponent(transport.aufrufe.at(-1).pfad), /closed/);
  assert.ok($$('.pf-spalte').some((s) => s.dataset.status === 'closed'));
});

dom('Fremder Text wird nie zu HTML', async () => {
  const boese = '<img src=x onerror=alert(1)>';
  const { p, $ } = fenster({
    ...VORGAENGE,
    'GET /api/tickets': { tickets: [ticket('INC-P1', 'new', { title: boese })] },
    'GET /api/tickets/INC-P1': { ticket: ticket('INC-P1', 'new', { title: boese, description: boese, verlauf: [{ ts: '2026-11-06T09:00:00Z', event: 'comment', actor: 'x', detail: boese }] }) },
  });
  await p.wechsle('vorgaenge');
  $('[data-id="INC-P1"]').click();
  await warte();
  assert.equal($('#wurzel img'), null);
  assert.ok($('.pf-detail-titel').textContent.includes('<img'));
});

const FREIGABE = (zerst) => ({
  ...VORGAENGE,
  'GET /api/tickets/CHG-P3': { ticket: ticket('CHG-P3', 'waiting_approval', { freigabe_kontext: 'Kontext', freigabe_risiko: 'medium', freigabe_zerstoererisch: zerst ? 'ja' : 'nein', verlauf: [] }) },
  'PATCH /api/tickets/CHG-P3': (k) => ({ ticket: ticket('CHG-P3', k.status) }),
});

dom('Freigabe: Erlauben schickt in_progress mit dem erwarteten Status, ohne Akteur aus der Seite', async () => {
  const { p, $, $$, transport } = fenster(FREIGABE(false));
  await p.wechsle('vorgaenge');
  $('[data-id="CHG-P3"]').click();
  await warte();
  $$('.pf-freigabe button').find((b) => b.textContent === 'Erlauben').click();
  await warte();
  const patch = transport.aufrufe.find((a) => a.methode === 'PATCH');
  assert.deepEqual(plain(patch.koerper), { expected_status: 'waiting_approval', status: 'in_progress' });
});

dom('Freigabe: Ablehnen schickt triage', async () => {
  const { p, $, $$, transport } = fenster(FREIGABE(false));
  await p.wechsle('vorgaenge');
  $('[data-id="CHG-P3"]').click();
  await warte();
  $$('.pf-freigabe button').find((b) => b.textContent === 'Ablehnen').click();
  await warte();
  assert.equal(transport.aufrufe.find((a) => a.methode === 'PATCH').koerper.status, 'triage');
});

dom('Zerstörerische Freigabe: erst der zweite, bewusste Klick erlaubt', async () => {
  const { p, $, $$, transport } = fenster(FREIGABE(true));
  await p.wechsle('vorgaenge');
  $('[data-id="CHG-P3"]').click();
  await warte();
  $$('.pf-freigabe button').find((b) => b.textContent === 'Erlauben').click();
  await warte();
  assert.equal(transport.aufrufe.filter((a) => a.methode === 'PATCH').length, 0);
  $$('.pf-freigabe button').find((b) => b.textContent === 'Wirklich erlauben').click();
  await warte();
  assert.equal(transport.aufrufe.filter((a) => a.methode === 'PATCH').length, 1);
});

dom('Fehler des Runners steht in der Ansicht, mit seinem Text', async () => {
  const { p, $, $$ } = fenster({ ...FREIGABE(false), 'PATCH /api/tickets/CHG-P3': Object.assign(new Error('CHG-P3 wurde schon entschieden'), { status: 409, fehler: 'CHG-P3 wurde schon entschieden' }) });
  await p.wechsle('vorgaenge');
  $('[data-id="CHG-P3"]').click();
  await warte();
  $$('.pf-freigabe button').find((b) => b.textContent === 'Erlauben').click();
  await warte();
  assert.match($$('.pf-hinweis').find((h) => !h.hidden).textContent, /schon entschieden/);
});

dom('Neuer Vorgang und Kommentar gehen über die richtigen Wege; ein Entwurf überlebt das Neuladen', async () => {
  const antworten = {
    ...VORGAENGE,
    'POST /api/tickets': (k) => ({ ticket: ticket('INC-P9', 'new', k), created: true }),
    'GET /api/tickets/INC-P9': { ticket: ticket('INC-P9', 'new', { verlauf: [] }) },
    'POST /api/tickets/INC-P9/comments': { entry: {} },
  };
  const { p, $, transport, w } = fenster(antworten);
  await p.wechsle('vorgaenge');
  const form = $('.pf-form');
  form.elements.title.value = 'Neu';
  form.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await warte(10);
  assert.equal(transport.aufrufe.find((a) => a.methode === 'POST').koerper.title, 'Neu');
  const ta = $('.pf-kommentar textarea');
  ta.value = 'Mein Entwurf';
  ta.dispatchEvent(new w.Event('input'));
  await p.takt();
  assert.equal($('.pf-kommentar textarea').value, 'Mein Entwurf');
  $('.pf-kommentar').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await warte(10);
  const c = transport.aufrufe.find((a) => a.pfad.endsWith('/comments'));
  assert.equal(c.koerper.text, 'Mein Entwurf');
});

const TERMIN = { id: 'k1', title: 'Wartung', from: '2026-11-06T17:00:00.000Z', to: '2026-11-06T19:00:00.000Z', exklusiv: 'rechner-a', updated_at: 'a', source: 'planned' };

dom('Kalender: Woche ab Montag, Eintrag am richtigen Tag, nicht lesbare Quelle wird genannt', async () => {
  const { p, $, $$, transport } = fenster({ 'GET /api/calendar': { entries: [TERMIN], unreachable: [{ source: 'icloud', reason: 'Zeitüberschreitung' }], complete: false } });
  await p.wechsle('kalender');
  assert.equal($$('.pf-tag').length, 7);
  const pfad = decodeURIComponent(transport.aufrufe.at(-1).pfad);
  const von = new Date(/from=([^&]+)/.exec(pfad)[1].replaceAll('%2E', '.'));
  assert.equal(von.getDay(), 1, 'die Woche beginnt montags');
  assert.ok($('.pf-tag.heute .pf-termin'));
  assert.match($('.pf-termin').textContent, /belegt rechner-a/);
  assert.equal($('.pf-luecke').hidden, false);
  assert.match($('.pf-luecke').textContent, /icloud/);
});

dom('Kalender: anlegen und verschieben schicken ISO-Zeiten, Löschen nur am bestehenden Eintrag', async () => {
  const { p, $, $$, transport, w } = fenster({
    'GET /api/calendar': { entries: [TERMIN], unreachable: [] },
    'POST /api/calendar': (k) => ({ entry: k }),
    'PATCH /api/calendar/k1': (k) => ({ entry: k }),
    'DELETE /api/calendar/k1': { entry: TERMIN },
  });
  await p.wechsle('kalender');
  $$('.pf-kopf button').find((b) => b.textContent === 'Neuer Termin').click();
  const form = $$('.pf-form').find((f) => !f.hidden);
  assert.equal(form.querySelector('.gefahr').hidden, true);
  form.elements.title.value = 'Neu';
  form.elements.from.value = '2026-11-07T10:00';
  form.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await warte(10);
  const neu = transport.aufrufe.find((a) => a.methode === 'POST');
  assert.equal(neu.koerper.from, new Date('2026-11-07T10:00').toISOString());
  assert.equal(neu.koerper.exklusiv, null);
  $('.pf-termin').click();
  assert.equal(form.querySelector('.gefahr').hidden, false);
  assert.equal(form.elements.title.value, 'Wartung');
  form.elements.title.value = 'Wartung 2';
  form.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await warte(10);
  assert.equal(transport.aufrufe.find((a) => a.methode === 'PATCH').koerper.title, 'Wartung 2');
  $('.pf-termin').click();
  form.querySelector('.gefahr').click();
  await warte(10);
  assert.ok(transport.aufrufe.some((a) => a.methode === 'DELETE'));
});

const BUS = (seq, extra = {}) => ({ seq, topic: 'inbox', id: `e${seq}`, t: JETZT, source: 'ci', class: 'hintergrund', text: `Ereignis ${seq}`, ...extra });
const EREIGNISSE = {
  'GET /api/bus/state': { topics: [{ topic: 'inbox', events: 2, head: 2 }], cursors: [{ consumer: 'agent', topic: 'inbox', seq: 1 }] },
  'GET /api/bus': { events: [BUS(1), BUS(2, { class: 'max', severity: 'high' })], last: 2 },
};

dom('Ereignisse: neueste zuerst, Vorfahrt markiert, Rückstand genannt, Strom ab dem letzten Stand', async () => {
  const { p, $, $$, transport } = fenster(EREIGNISSE);
  await p.wechsle('ereignisse');
  await warte();
  assert.deepEqual($$('.pf-ereignis').map((e) => e.dataset.seq), ['2', '1']);
  assert.ok($('.pf-ereignis.besitzer .pf-besitzer'));
  assert.match($$('.pf-spanne').find((s) => !s.closest('.pf-bereich').hidden).textContent, /1 noch nicht angenommen/);
  assert.deepEqual(plain(transport.strome[0]), { kanal: 'bus', pfad: '/api/bus/stream?topic=inbox&after=2' });
});

dom('Ereignisse live: neu erscheint oben, Doppeltes nach dem Neuverbinden nicht, fremdes Thema nicht; beim Verlassen schließt der Strom', async () => {
  const { p, $$, transport } = fenster(EREIGNISSE);
  await p.wechsle('ereignisse');
  await warte();
  transport.sende({ kanal: 'bus', art: 'bus', daten: BUS(3) });
  transport.sende({ kanal: 'bus', art: 'bus', daten: BUS(3) });
  transport.sende({ kanal: 'bus', art: 'bus', daten: BUS(4, { topic: 'tickets' }) });
  transport.sende({ kanal: 'gespraech', art: 'bus', daten: BUS(5) });
  assert.deepEqual($$('.pf-ereignis').map((e) => e.dataset.seq), ['3', '2', '1']);
  await p.wechsle('chat');
  assert.ok(transport.strome.some((s) => s.kanal === 'bus' && s.zu));
});

dom('Ereignisse: Thema wechseln öffnet den Strom neu, ein Einwurf nennt nie eine Klasse', async () => {
  const { p, $, $$, transport, w } = fenster({
    ...EREIGNISSE,
    'POST /api/bus': { event: {} },
  });
  await p.wechsle('ereignisse');
  await warte();
  $$('.pf-chip').find((c) => c.textContent === 'Vorgänge').click();
  await warte();
  assert.match(transport.strome.at(-1).pfad, /topic=tickets/);
  $$('.pf-chip').find((c) => c.textContent === 'Eingang').click();
  await warte();
  const form = $$('.pf-form').at(-1);
  form.elements.text.value = 'Probe';
  form.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await warte(10);
  const post = transport.aufrufe.find((a) => a.methode === 'POST').koerper;
  assert.equal(post.text, 'Probe');
  assert.equal(post.source, 'webhook');
  assert.equal('class' in post, false);
  assert.equal('actor' in post, false);
});

dom('Logik: Woche über die Zeitumstellung, Eintrag über Mitternacht an beiden Tagen, Eingabezeit hin und zurück', () => {
  const d = new jsdom.JSDOM('', { runScripts: 'outside-only' });
  d.window.eval(lies('plattform.js'));
  const L = d.window.FyosPrototyp.plattformLogik;
  const start = L.wochenStart(Date.parse('2026-10-28T12:00:00'));
  const tage = L.wochenTage(start, []);
  assert.equal(tage.length, 7);
  for (const t of tage) assert.equal(new Date(t.von).getHours(), 0);
  const montag = L.wochenStart(JETZT);
  const ueber = [{ from: new Date(montag + 23 * 3600_000).toISOString(), to: new Date(montag + 25 * 3600_000).toISOString() }];
  assert.deepEqual(plain(L.wochenTage(montag, ueber).map((t) => t.eintraege.length)), [1, 1, 0, 0, 0, 0, 0]);
  assert.equal(L.fuerEingabe('kaputt'), '');
  assert.equal(L.ausEingabe(''), null);
  assert.equal(L.ausEingabe(L.fuerEingabe('2026-11-07T10:00:00.000Z')), '2026-11-07T10:00:00.000Z');
});

test('Oberfläche: eingebunden, ohne eigenes Netz, ohne Mail-Adressen, Farben aus den Variablen', () => {
  const html = lies('chat.html');
  assert.ok(html.includes('src="plattform.js"') && html.includes('href="plattform.css"'));
  assert.ok(html.indexOf('plattform.js') < html.indexOf('chat.js'), 'vor chat.js');
  const js = lies('plattform.js');
  assert.doesNotMatch(js, /\bfetch\(|XMLHttpRequest|innerHTML|insertAdjacentHTML|document\.write/);
  // Fremde Namen prüft der Scan des Exports (tools/oeffentlich_pruefen.py) für alle Dateien; hier nur: keine Mail-Adresse.
  assert.doesNotMatch(js + lies('plattform.css'), /[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  const css = lies('chat.css');
  for (const [name, wert] of [['--akzent', '#ff2d95'], ['--hg', '#0b0e14'], ['--flaeche', '#10141c'], ['--text', '#e9edf3'], ['--gut', '#34d399'], ['--warn', '#fbbf24'], ['--schlecht', '#f87171']]) {
    assert.ok(css.includes(`${name}: ${wert};`), name);
  }
  assert.doesNotMatch(lies('chat.css') + lies('arbeitsplatz.css') + lies('freigaben.css') + lies('aenderungen.css'), /2dd4bf|45, 212, 191/);
});
