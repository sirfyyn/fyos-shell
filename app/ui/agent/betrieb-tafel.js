/* Tafel „Betrieb“ der Seitenleiste (Paket B1, Prototyp apps/fyos-agent/prototyp/ausbau.html): Modell, Hub und die Knoten des Clusters mit
 * CPU, Speicher und GPUs. Nur lesend, gelesen über runner-wege.js (`betriebLage`, Runner src/betrieb.js). Kennt der Runner den Weg nicht,
 * bleibt der Knopf der Schiene weg. Offen liest die Tafel alle 10 s neu; der Runner hält den Hub-Teil 15 s, FLE Link 3 s.
 *
 *   FP.betrieb = { createBetriebTafel, knotenZustand, gpuZeile, speicherText }
 *
 * Texte nur als textContent. Kürzel der Klassen: `bt-`.
 */
(() => {
  'use strict';
  const FP = (window.FyosPrototyp = window.FyosPrototyp || {});

  const zahl = (v, stellen = 0) => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('de-DE', { maximumFractionDigits: stellen, minimumFractionDigits: stellen }) : '–');

  /** 'gut' | 'warn' | 'schlecht' für den Punkt vor dem Knoten. */
  function knotenZustand(k) {
    if (!k.bereit) return 'schlecht';
    if (k.abgesperrt || k.probleme > 0) return 'warn';
    return 'gut';
  }

  /** „11,7 / 120,9 GB“; ohne Gesamtgröße nur der belegte Teil. */
  function speicherText(belegtGib, gesamtGib) {
    if (belegtGib === null) return '';
    return gesamtGib === null ? `${zahl(belegtGib, 1)} GB` : `${zahl(belegtGib, 1)} / ${zahl(gesamtGib, 1)} GB`;
  }

  /** Eine Zeile je GPU: „GPU0 · 96 % · 27,4 / 31,5 GB · 69 °C“, dazu der Anteil des VRAM (0–1) für den Balken. */
  function gpuZeile(g) {
    const teile = [`GPU${g.nr}`];
    if (g.auslastungProzent !== null) teile.push(`${zahl(g.auslastungProzent)} %`);
    if (g.vramMib !== null) teile.push(speicherText(g.vramMib / 1024, g.vramGesamtMib === null ? null : g.vramGesamtMib / 1024));
    if (g.temperaturC !== null) teile.push(`${zahl(g.temperaturC)} °C`);
    const anteil = g.vramMib !== null && g.vramGesamtMib ? Math.max(0, Math.min(1, g.vramMib / g.vramGesamtMib)) : null;
    return { text: teile.join(' · '), anteil };
  }

  /** Tempo des Modells aus FLE Link: „41,5 tok/s · Prefill 512 tok/s · Annahme 71 % · Slots 1/1 · 2 warten“; ohne Werte ''. */
  function tempoText(f) {
    if (!f || !f.erreichbar) return '';
    const teile = [];
    if (f.tokS !== null) teile.push(`${zahl(f.tokS, 1)} tok/s${f.ausLetzterAntwort ? ' (letzte Antwort)' : ''}`);
    if (f.prefillTokS !== null) teile.push(`Prefill ${zahl(f.prefillTokS)} tok/s`);
    if (f.annahme !== null) teile.push(`Annahme ${zahl(f.annahme * 100)} %`);
    if (f.slots !== null) teile.push(`Slots ${f.slotsBelegt === null ? '–' : zahl(f.slotsBelegt)}/${zahl(f.slots)}`);
    if (f.wartend) teile.push(`${zahl(f.wartend)} warten`);
    return teile.join(' · ');
  }

  /**
   * refs: { knopf, rumpf, fuss }   opts: { wege, sichtbar: () => bool, beiWeg?: (kennt) => void, setInterval?, clearInterval?, jetzt? }
   */
  function createBetriebTafel(refs, opts) {
    const doc = refs.rumpf.ownerDocument;
    const si = opts.setInterval || ((f, ms) => setInterval(f, ms));
    const ci = opts.clearInterval || ((t) => clearInterval(t));
    const jetzt = opts.jetzt || (() => new Date());
    let uhr = null;
    let laeuft = false;

    const el = (tag, klasse, text) => {
      const e = doc.createElement(tag);
      if (klasse) e.className = klasse;
      if (text !== undefined) e.textContent = String(text);
      return e;
    };
    const chip = (text, art) => el('span', `bt-chip${art ? ` ${art}` : ''}`, text);
    const balken = (anteil, art) => {
      const b = el('span', `bt-balken ${art || ''}`.trim());
      b.setAttribute('aria-hidden', 'true');
      const i = el('i');
      i.style.width = `${Math.round(anteil * 100)}%`;
      b.appendChild(i);
      return b;
    };

    /** Zeilen der GPUs mit Balken für den VRAM (über 90 % gelb). */
    function gpuZeilen(ziel, liste) {
      for (const g of liste) {
        const z2 = gpuZeile(g);
        const zeile = el('div', 'bt-gpu');
        zeile.appendChild(el('span', 'bt-werte', z2.text));
        if (z2.anteil !== null) zeile.appendChild(balken(z2.anteil, z2.anteil > 0.9 ? 'warn' : 'gut'));
        if (g.modell) zeile.title = g.modell;
        ziel.appendChild(zeile);
      }
    }

    function zeichne(l) {
      refs.rumpf.textContent = '';
      const fl = l.flelink && l.flelink.erreichbar ? l.flelink : null;
      // Modell (mit FLE Link auch sein Tempo) und Hub
      const oben = el('div', 'bt-kachel');
      const m = el('div', 'bt-zeile');
      m.append(el('b', null, 'Modell'), el('span', 'bt-name', l.modell.name || (fl && fl.modell) || 'unbekannt'));
      m.append(l.modell.antwortet === true ? chip('antwortet', 'gut') : l.modell.antwortet === false ? chip('antwortet nicht', 'schlecht') : chip('ungeprüft'));
      oben.appendChild(m);
      if (l.flelink) {
        const f = el('div', 'bt-zeile');
        f.append(el('b', null, 'FLE Link'));
        if (fl) {
          f.append(el('span', 'bt-name', fl.modell || fl.zustand || 'läuft'));
          f.append(fl.beschaeftigt ? chip('rechnet', 'laeuft') : chip(fl.zustand === 'ready' || fl.zustand === 'attached' ? 'bereit' : fl.zustand || 'läuft', 'gut'));
        } else f.append(el('span', 'bt-name', 'läuft nicht auf diesem Rechner'));
        oben.appendChild(f);
        const tempo = tempoText(fl);
        if (tempo) oben.appendChild(el('div', 'leise bt-werte bt-tempo', tempo));
      }
      const h = el('div', 'bt-zeile');
      h.append(el('b', null, 'Hub'));
      if (!l.hub.konfiguriert) h.append(el('span', 'bt-name', 'nicht eingerichtet'));
      else {
        h.append(el('span', 'bt-name', l.hub.erreichbar ? 'erreichbar' : l.hub.fehler || 'nicht erreichbar'));
        h.append(l.hub.erreichbar ? chip('verbunden', 'gut') : chip('weg', 'schlecht'));
      }
      oben.append(h);
      refs.rumpf.appendChild(oben);

      // Dieser Rechner: RAM (aus FLE Link oder dem System) und GPUs (nur aus FLE Link)
      if (l.rechner) {
        const r = el('div', 'bt-kachel');
        const kopf = el('div', 'bt-zeile');
        kopf.append(el('b', null, 'Dieser Rechner'), el('span', 'leise bt-rolle', l.rechner.quelle === 'flelink' ? 'gemessen von FLE Link' : 'laut System'));
        r.appendChild(kopf);
        const ram = el('div', 'bt-gpu');
        ram.appendChild(el('span', 'bt-werte', `RAM ${speicherText(l.rechner.ramGib, l.rechner.ramGesamtGib)}`));
        if (l.rechner.ramGib !== null && l.rechner.ramGesamtGib) {
          const a = Math.max(0, Math.min(1, l.rechner.ramGib / l.rechner.ramGesamtGib));
          ram.appendChild(balken(a, a > 0.9 ? 'warn' : 'gut'));
        }
        r.appendChild(ram);
        gpuZeilen(r, l.rechner.gpus);
        refs.rumpf.appendChild(r);
      }

      // Knoten
      refs.rumpf.appendChild(el('h3', 'bt-abschnitt', 'Knoten'));
      const c = l.cluster;
      if (!c) {
        refs.rumpf.appendChild(el('p', 'leise leer-hinweis', l.hub.konfiguriert ? 'Ohne Hub kein Blick in den Cluster.' : 'Der Cluster steht hier, sobald der Runner einen Hub hat.'));
        return;
      }
      if (c.fehler) {
        refs.rumpf.appendChild(el('p', 'leise leer-hinweis bt-fehler', `Cluster nicht lesbar: ${c.fehler}`));
        return;
      }
      if (c.satz) refs.rumpf.appendChild(el('p', 'leise bt-satz', c.satz));
      const liste = el('ul', 'bt-knoten');
      liste.setAttribute('aria-label', 'Knoten des Clusters');
      for (const k of c.knoten) {
        const li = el('li', 'bt-knoten-eintrag');
        const kopf = el('div', 'bt-zeile');
        const z = knotenZustand(k);
        const punkt = el('span', `bt-punkt ${z}`);
        punkt.setAttribute('aria-label', z === 'gut' ? 'bereit' : z === 'warn' ? (k.abgesperrt ? 'abgesperrt' : 'Probleme') : 'nicht bereit');
        kopf.append(punkt, el('b', null, k.name));
        if (k.aufgaben.length) kopf.append(el('span', 'leise bt-rolle', k.aufgaben.join(', ')));
        li.appendChild(kopf);
        const werte = [];
        if (k.cpuProzent !== null) werte.push(`CPU ${zahl(k.cpuProzent)} %`);
        const ram = speicherText(k.ramGib, k.ramGesamtGib);
        if (ram) werte.push(`RAM ${ram}`);
        if (werte.length) li.appendChild(el('div', 'leise bt-werte', werte.join(' · ')));
        gpuZeilen(li, k.gpus);
        liste.appendChild(li);
      }
      refs.rumpf.appendChild(liste);
    }

    async function neu() {
      if (laeuft) return;
      laeuft = true;
      try {
        const l = await opts.wege.betriebLage();
        if (refs.knopf) refs.knopf.hidden = false;
        if (opts.beiWeg) opts.beiWeg(true);
        zeichne(l);
        const d = jetzt();
        refs.fuss.textContent = `Stand ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')} · nur lesend`;
        refs.fuss.hidden = false;
      } catch (f) {
        if (f && f.art === 'weg_fehlt') {
          // dieser Runner kennt die Tafel nicht (voller Runner ohne Schalter)
          if (refs.knopf) refs.knopf.hidden = true;
          if (opts.beiWeg) opts.beiWeg(false);
          halt();
        } else {
          refs.rumpf.textContent = '';
          refs.rumpf.appendChild(el('p', 'leise leer-hinweis bt-fehler', `Betrieb nicht lesbar: ${(f && (f.meldung || f.message)) || 'unbekannter Fehler'}`));
        }
      } finally {
        laeuft = false;
      }
    }
    function halt() {
      if (uhr !== null) ci(uhr);
      uhr = null;
    }
    /** Tafel geöffnet: sofort lesen, dann alle 10 s, solange sie offen ist (tok/s ändert sich schnell). */
    function zeige() {
      void neu();
      halt();
      uhr = si(() => {
        if (opts.sichtbar()) void neu();
        else halt();
      }, 10_000);
    }
    /** Beim Start und nach einem Wechsel des Runners: kennt er den Weg? (zeigt oder verbirgt den Knopf) */
    function pruefe() {
      return neu();
    }
    return { zeige, pruefe, neu, halt };
  }

  FP.betrieb = { createBetriebTafel, knotenZustand, gpuZeile, speicherText, tempoText };
})();
