// Tafel „Konnektoren“ (konnektoren-tafel.js, Lesen über runner-wege.js `konnektoren`, `kontoPruefen`): bereinigen (nur https), Rechte,
// Zeichnen, Prüfen, Knopf ohne Weg. jsdom wie in ui_agent.test.mjs: über FYOS_JSDOM_DIR oder ein benachbartes fyos-web.
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
const warte = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const LAGE = {
  satz: '2 von 3 Konten verbunden',
  verwalten: 'https://beispiel.invalid/verbindungen',
  konten: [
    { id: 'github', name: 'GitHub', art: 'Anmeldung', verbunden: true, konto: 'nutzer', rechte: ['repo', 'Organisationen lesen', 'read:user', 'user:email'], pruefbar: false, verbinden: '' },
    { id: 'google', name: 'Google', art: 'Anmeldung', verbunden: true, konto: '', rechte: ['Kalender lesen'], pruefbar: true, verbinden: '' },
    { id: 'hetzner', name: 'Hetzner Cloud', art: 'Formular', verbunden: false, konto: '', rechte: [], pruefbar: false, verbinden: 'https://beispiel.invalid/hetzner' },
  ],
  faehigkeiten: [{ name: 'dateien', titel: 'Dateien im Ordner der Sitzung', an: true }, { name: 'git', titel: 'Git je Sitzung', an: false }],
  hub: { konfiguriert: true },
  fehler: '',
};

test('konnektorenBereinigen: nur https-Wege, kein Token, ohne id fällt weg; Rechte gekürzt', () => {
  const FP = logik('runner-wege.js', 'konnektoren-tafel.js');
  const s = FP.wege.konnektorenBereinigen({ ...LAGE, verwalten: 'javascript:alert(1)', konten: [...LAGE.konten, { name: 'ohne' }, { id: 'x', verbinden: 'http://unsicher.invalid', token: 'geheim' }] });
  assert.equal(s.konten.length, 4);
  assert.equal(s.verwalten, '');
  assert.equal(s.konten[3].verbinden, '');
  assert.equal(JSON.stringify(s).includes('geheim'), false);
  assert.deepEqual(Object.keys(s), ['konten', 'satz', 'verwalten', 'fehler', 'faehigkeiten', 'hub']);
  assert.equal(FP.konnektoren.rechteText(LAGE.konten[0].rechte), 'repo, Organisationen lesen, read:user +1');
  assert.equal(FP.konnektoren.rechteText([]), '');
});

test('Quelltext: kein HTML aus Text, kein eigenes Netz; Knopf, Tafel und Skript im HTML; Wege nur über httpsWeg', () => {
  assert.doesNotMatch(lies('konnektoren-tafel.js'), /innerHTML|insertAdjacentHTML|\bfetch\(|XMLHttpRequest/);
  const html = lies('chat.html');
  assert.match(html, /id="schieneKonnektoren"[^>]*hidden/);
  assert.match(html, /id="tafelKonnektoren"/);
  assert.match(html, /<script src="konnektoren-tafel.js"><\/script>/);
  assert.match(lies('runner-wege.js'), /verbinden: httpsWeg\(k\.verbinden\)/);
});

function tafel({ lage = LAGE, pruefung = { geprueft: true, traegt: true, konto: 'a@b.invalid', satz: 'Die Verbindung trägt.' } } = {}) {
  const d = new jsdom.JSDOM('<!doctype html><body><button id="k" hidden></button><div id="r"></div><p id="f" hidden></p></body>', { runScripts: 'outside-only' });
  const w = d.window;
  w.eval(lies('konnektoren-tafel.js'));
  const $ = (id) => w.document.getElementById(id);
  const z = { pruefungen: [], wege: [] };
  const wege = {
    konnektoren: async () => {
      if (lage instanceof Error) throw lage;
      return lage;
    },
    kontoPruefen: async (a) => {
      z.pruefungen.push(a);
      if (pruefung instanceof Error) throw pruefung;
      return pruefung;
    },
  };
  const t = w.FyosPrototyp.konnektoren.createKonnektorenTafel({ knopf: $('k'), rumpf: $('r'), fuss: $('f') }, { wege, beiWeg: (k) => z.wege.push(k) });
  return { $, t, z };
}

dom('Zeichnen: Konten mit Konto, Marke und Rechten; Prüfen nur, wo der Hub es kann; Verbinden nur bei offenen; Fähigkeiten an und aus', async () => {
  const { $, t, z } = tafel();
  await t.pruefe();
  assert.equal($('k').hidden, false);
  assert.deepEqual(z.wege, [true]);
  const konten = $('r').querySelectorAll('.kn-konto');
  assert.equal(konten.length, 3);
  assert.match(konten[0].textContent, /^GitHubnutzerverbunden/);
  assert.equal(konten[0].querySelector('.kn-rechte').textContent, 'repo, Organisationen lesen, read:user +1');
  assert.equal(konten[0].querySelector('button'), null, 'GitHub ist nicht prüfbar');
  assert.ok(konten[1].querySelector('button'), 'Google ist prüfbar');
  const verbinden = konten[2].querySelector('a.kn-weg');
  assert.equal(verbinden.getAttribute('href'), 'https://beispiel.invalid/hetzner');
  assert.equal(verbinden.getAttribute('target'), '_blank');
  assert.equal($('r').querySelector(':scope > a.kn-weg').textContent, 'Verbindungen verwalten');
  const f = [...$('r').querySelectorAll('.kn-faehigkeit')].map((x) => x.textContent);
  assert.deepEqual(f, ['Dateien im Ordner der Sitzungan', 'Git je Sitzungaus']);
  konten[1].querySelector('button').click();
  await warte(10);
  assert.deepEqual(z.pruefungen, ['google']);
  assert.equal(konten[1].querySelector('.kn-ergebnis').textContent, 'Die Verbindung trägt. · a@b.invalid');
});

dom('Ohne Weg kein Knopf; Fehler des Hubs und der Prüfung stehen als Satz da', async () => {
  const ohne = tafel({ lage: Object.assign(new Error('weg'), { art: 'weg_fehlt' }) });
  await ohne.t.pruefe();
  assert.equal(ohne.$('k').hidden, true);
  assert.deepEqual(ohne.z.wege, [false]);

  const rot = tafel({ lage: { ...LAGE, konten: [], fehler: 'Hub-Zeitüberschreitung' } });
  await rot.t.pruefe();
  assert.match(rot.$('r').textContent, /Konten nicht lesbar: Hub-Zeitüberschreitung/);

  const traegtNicht = tafel({ pruefung: { geprueft: true, traegt: false, konto: '', satz: 'Die Verbindung trägt nicht.' } });
  await traegtNicht.t.pruefe();
  const google = traegtNicht.$('r').querySelectorAll('.kn-konto')[1];
  google.querySelector('button').click();
  await warte(10);
  assert.ok(google.querySelector('.kn-ergebnis.kn-fehler'));
});
