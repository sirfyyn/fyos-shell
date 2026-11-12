// Git je Sitzung in der Oberfläche (git-kasten.js): Stand bereinigen, Zeile, Kasten mit Commit und PR (zweiter Klick).
// jsdom wie in ui_agent.test.mjs: über FYOS_JSDOM_DIR oder ein benachbartes fyos-web.
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

test('gitBereinigen: nur bekannte Felder, Grenzen, Unsinn wird leer', () => {
  const { gitBereinigen } = logik('git-kasten.js').git;
  const s = gitBereinigen({ zweig: 'agent/s4-x', kopf: 'abc1234', voraus: 2.7, sauber: false, dateien: [{ zustand: 'M', pfad: 'src/a.js' }, { pfad: 3 }, null], fernzweig: '', geheim: 'x' });
  assert.deepEqual(Object.keys(s), ['zweig', 'kopf', 'voraus', 'sauber', 'dateien', 'fernzweig']);
  assert.deepEqual([s.voraus, s.sauber, s.dateien, s.fernzweig], [2, false, [{ zustand: 'M', pfad: 'src/a.js' }], null]);
  assert.deepEqual(gitBereinigen(null), { zweig: '', kopf: '', voraus: null, sauber: false, dateien: [], fernzweig: null });
});

test('standText: Zweig, Commits, offene Dateien, Fernziel', () => {
  const { standText } = logik('git-kasten.js').git;
  assert.equal(standText({ zweig: 'agent/s4-x', voraus: 1, sauber: false, dateien: [{}, {}], fernzweig: null }), 'agent/s4-x · 1 Commit · 2 Dateien geändert');
  assert.equal(standText({ zweig: 'agent/s4-x', voraus: 0, sauber: true, dateien: [], fernzweig: 'origin/agent/s4-x' }), 'agent/s4-x · 0 Commits · nichts offen · gepusht: origin/agent/s4-x');
});

test('Quelltext: kein HTML aus Text, kein eigenes Netz', () => {
  assert.doesNotMatch(lies('git-kasten.js'), /innerHTML|insertAdjacentHTML|\bfetch\(|XMLHttpRequest/);
});

function kasten(antworten) {
  const d = new jsdom.JSDOM('<!doctype html><body><section id="k" hidden><p id="s"></p><input id="n"><button id="c">Committen</button><button id="p">PR anlegen</button><p id="m" hidden></p></section></body>', { runScripts: 'outside-only' });
  const w = d.window;
  w.eval(lies('git-kasten.js'));
  const $ = (id) => w.document.getElementById(id);
  const z = { commits: [], prs: [], stand: antworten.stand };
  const wege = {
    git: async () => {
      if (z.stand instanceof Error) throw z.stand;
      return z.stand;
    },
  };
  const transport = {
    api: async (methode, pfad, koerper) => {
      assert.equal(methode, 'POST');
      if (pfad === '/api/gespraech/4/git/commit') {
        z.commits.push([4, koerper.nachricht]);
        z.stand = { ...z.stand, sauber: true, dateien: [], voraus: (z.stand.voraus || 0) + 1 };
        return { commit: 'def5678', dateien: 1 };
      }
      if (pfad === '/api/gespraech/4/git/pr') {
        z.prs.push([4, koerper.titel]);
        return { url: 'https://example.invalid/pull/9' };
      }
      throw new Error(`unerwartet: ${pfad}`);
    },
  };
  const k = w.FyosPrototyp.git.createGitKasten({ kasten: $('k'), stand: $('s'), nachricht: $('n'), commit: $('c'), pr: $('p'), meldung: $('m') }, { wege, transport, sitzung: () => 4, titel: () => 'Probe' });
  return { w, $, k, z };
}

dom('Kasten: ohne Arbeitsbaum verborgen; mit offenen Dateien committen, danach PR erst beim zweiten Klick', async () => {
  const ohne = kasten({ stand: Object.assign(new Error('Diese Sitzung hat keinen eigenen Arbeitsbaum'), { status: 404 }) });
  await ohne.k.neu();
  assert.equal(ohne.$('k').hidden, true);

  const { $, k, z, w } = kasten({ stand: { zweig: 'agent/s4-probe', kopf: 'abc', voraus: 0, sauber: false, dateien: [{ zustand: '??', pfad: 'b.txt' }] } });
  await k.neu();
  assert.equal($('k').hidden, false);
  assert.equal($('s').textContent, 'agent/s4-probe · 0 Commits · 1 Datei geändert');
  assert.equal($('c').disabled, true, 'ohne Nachricht kein Commit');
  assert.equal($('p').disabled, true, 'mit offenen Dateien kein PR');
  $('n').value = 'b ergänzt';
  $('n').dispatchEvent(new w.Event('input'));
  assert.equal($('c').disabled, false);
  $('c').click();
  for (let i = 0; i < 20 && !z.commits.length; i++) await warte();
  await warte(20);
  assert.deepEqual(z.commits, [[4, 'b ergänzt']]);
  assert.equal($('m').textContent, 'Committet: def5678');
  assert.equal($('s').textContent, 'agent/s4-probe · 1 Commit · nichts offen');
  assert.equal($('p').disabled, false);
  $('p').click();
  await warte(20);
  assert.equal(z.prs.length, 0, 'der erste Klick fragt nur');
  assert.equal($('p').textContent, 'Wirklich pushen und PR anlegen?');
  $('p').click();
  for (let i = 0; i < 20 && !z.prs.length; i++) await warte();
  await warte(20);
  assert.deepEqual(z.prs, [[4, 'Probe']]);
  assert.equal($('m').textContent, 'PR angelegt: https://example.invalid/pull/9');
});
