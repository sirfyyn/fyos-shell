/* Werkbank: die Schiene der Seitenleiste (Sitzungen, Aufgaben, Läufe), die Aufgabenliste, die der Agent in einer Sitzung führt, mit dem
 * Streifen über der Eingabe, und die Läufe: Unteragenten und Befehle im Hintergrund, laufende zuerst.
 *
 * Reine Logik (dauerText, aufgabenSicht, laeufeSicht) steht getrennt vom DOM und ist ohne Fenster prüfbar. Gelesen wird nur über
 * runner-wege.js (aufgaben, laeufe, jobs, job). Kennt der Runner einen Weg nicht, verschwindet der Knopf dazu, statt leer zu bleiben.
 * Texte des Runners gehen nur über textContent in die Seite.
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  /** Sekunden als kurze Dauer: „45 s“, „12 min“, „2 h 5 min“. */
  function dauerText(sekunden) {
    const s = Math.max(0, Math.round(Number(sekunden) || 0));
    if (s < 90) return `${s} s`;
    const min = Math.floor(s / 60);
    if (min < 90) return `${min} min`;
    const h = Math.floor(min / 60);
    const rest = min % 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
  }

  /**
   * Die Aufgabenliste (wege.aufgaben) so, wie Tafel und Streifen sie zeigen.
   * → { eintraege, gesamt, fertig, laeuft, offen, unerledigt, anteil (0 bis 1), aktuell (Text des laufenden, sonst des nächsten offenen Schritts),
   *     arbeitet, alleFertig, leer, kurz („2 von 5“) }
   */
  function aufgabenSicht(a) {
    const eintraege = a && Array.isArray(a.eintraege) ? a.eintraege : [];
    const gesamt = eintraege.length;
    const fertig = eintraege.filter((e) => e.zustand === 'fertig').length;
    const laufende = eintraege.filter((e) => e.zustand === 'laeuft');
    const alleFertig = gesamt > 0 && fertig === gesamt;
    const naechster = laufende[0] || eintraege.find((e) => e.zustand === 'offen') || null;
    return {
      eintraege,
      gesamt,
      fertig,
      laeuft: laufende.length,
      offen: gesamt - fertig - laufende.length,
      unerledigt: gesamt - fertig,
      anteil: gesamt ? fertig / gesamt : 0,
      aktuell: alleFertig || !naechster ? '' : naechster.text,
      arbeitet: laufende.length > 0,
      alleFertig,
      leer: gesamt === 0,
      kurz: gesamt ? `${fertig} von ${gesamt}` : '',
    };
  }

  const ART_NAME = { job: 'Befehl', unteragent: 'Unteragent', lauf: 'Lauf' };

  function jobZeile(j, jetzt) {
    let zustand = 'fertig';
    let zustandText = 'fertig';
    if (j.laeuft) {
      zustand = 'laeuft';
      zustandText = 'läuft';
    } else if (j.grund === 'gestoppt') {
      zustand = 'gestoppt';
      zustandText = 'gestoppt';
    } else if (j.grund === 'zeit') {
      zustand = 'fehler';
      zustandText = 'an der Zeitgrenze beendet';
    } else if (j.grund === 'abgebrochen') {
      zustand = 'abgebrochen';
      zustandText = 'abgebrochen';
    } else if (j.exit !== 0) {
      zustand = 'fehler';
      zustandText = j.exit === null ? 'beendet' : `Fehler (Code ${j.exit})`;
    }
    const dauer = j.laeuft && j.start ? Math.max(0, jetzt / 1000 - j.start) : j.dauer_s;
    return { schluessel: `job:${j.id}`, art: 'job', id: j.id, titel: j.name, zustand, zustandText, dauerText: dauerText(dauer), zeit: (j.start || 0) * 1000, gespraech: j.gespraech, kindId: null, antwort: '', fehler: '' };
  }

  const LAUF_ZUSTAND = {
    laeuft: ['laeuft', 'läuft'],
    abgeschlossen: ['fertig', 'fertig'],
    fehler: ['fehler', 'fehlgeschlagen'],
    abgebrochen: ['abgebrochen', 'abgebrochen'],
    abgelehnt: ['abgebrochen', 'abgelehnt'],
  };

  function laufZeile(l, jetzt) {
    const [zustand, zustandText] = LAUF_ZUSTAND[l.status] || ['fertig', l.status || 'beendet'];
    const unter = l.quelle === 'unteragent';
    const ende = zustand === 'laeuft' ? jetzt : l.beendet || 0;
    return {
      schluessel: `lauf:${l.id}`,
      art: unter ? 'unteragent' : 'lauf',
      id: l.id,
      // der Runner stellt dem Titel eines Unteragenten das Wort voran; hier steht die Art in der Zeile darunter
      titel: unter ? l.titel.replace(/^Unteragent:\s*/, '') || l.titel : l.titel,
      zustand,
      zustandText,
      dauerText: l.erstellt && ende > l.erstellt ? dauerText((ende - l.erstellt) / 1000) : '',
      zeit: l.erstellt,
      gespraech: l.eltern,
      kindId: l.kindId,
      antwort: l.antwort,
      fehler: l.fehler,
    };
  }

  /**
   * Läufe (wege.laeufe) und Hintergrundjobs (wege.jobs) als eine Liste: laufende zuerst, dann die neuesten; höchstens o.max (Vorgabe 40).
   * o: { jetzt (ms), gespraech (Id der sichtbaren Sitzung), max }. Zeile: { schluessel, art: 'job'|'unteragent'|'lauf', id, titel, zustand:
   * 'laeuft'|'fertig'|'fehler'|'gestoppt'|'abgebrochen', zustandText, dauerText, gespraech, kindId, antwort, fehler, eigene }.
   * → { zeilen, laufend }
   */
  function laeufeSicht(laeufe, jobs, o) {
    o = o || {};
    const jetzt = o.jetzt || Date.now();
    const hat = (x) => x !== undefined && x !== null && x !== '';
    const alle = [...(Array.isArray(jobs) ? jobs : []).map((j) => jobZeile(j, jetzt)), ...(Array.isArray(laeufe) ? laeufe : []).map((l) => laufZeile(l, jetzt))]
      .map((z) => ({ ...z, eigene: hat(o.gespraech) && hat(z.gespraech) && String(z.gespraech) === String(o.gespraech) }))
      .sort((a, b) => Number(b.zustand === 'laeuft') - Number(a.zustand === 'laeuft') || b.zeit - a.zeit);
    return { zeilen: alle.slice(0, o.max || 40), laufend: alle.filter((z) => z.zustand === 'laeuft').length };
  }

  /**
   * refs: { schiene, knoepfe: { gespraeche, aufgaben, laeufe, aenderungen? }, tafeln: { gespraeche, aufgaben, laeufe, aenderungen? }, aufgabenMarke, aufgabenLeer,
   *         aufgabenKopf, aufgabenKopfText, aufgabenBalken, aufgabenListe, laeufeMarke, laeufeLeer, laeufeListe, streifen, streifenText, streifenZahl, streifenBalken }
   * opts: { wege, beiSprung(id) (Sitzung oder Verlauf eines Unteragenten öffnen), titelVon(id) → Name der Sitzung oder '', beiStreifen(), jetzt, takt (false: keine Uhr),
   *         beiTafel(name) (eine Tafel wurde gewählt) }
   * Rückgabe: { zeige(name), setzeSitzung(id), aufgabenNeu(), laeufeNeu(), ende(), tafel, zustand() }
   */
  function createWerkbank(refs, opts) {
    opts = opts || {};
    const doc = refs.schiene.ownerDocument;
    const wege = opts.wege;
    const jetzt = opts.jetzt || (() => Date.now());
    // „aenderungen“ (staende-tafel.js) gehört zur Schiene, sobald die Seite Knopf und Tafel dafür mitgibt; ihren Inhalt führt jenes Modul.
    // „dateien“ (dateien-tafel.js) ebenso: der Ordner der Sitzung als Baum.
    const TAFELN = ['gespraeche', 'aufgaben', 'laeufe', 'aenderungen', 'dateien'].filter((n) => refs.knoepfe[n] && refs.tafeln[n]);
    let tafel = 'gespraeche';
    let sitzung = null;
    let aufgaben = aufgabenSicht(null);
    let sicht = { zeilen: [], laufend: 0 };
    const daten = { laeufe: [], jobs: [] };
    // 'ja' | 'nein' (älterer Runner kennt den Weg nicht) | 'unbekannt'
    const weg = { aufgaben: 'unbekannt', laeufe: 'unbekannt', jobs: 'unbekannt' };
    const zeilenKnoten = new Map(); // Schlüssel → Element der Zeile
    let offen = null; // Schlüssel der aufgeklappten Zeile
    let ausgabeLauf = 0;
    let aufgabenLauf = 0;
    let laeufeLauf = 0;
    let uhr = null;
    let beendet = false;

    function el(name, klasse, text) {
      const e = doc.createElement(name);
      if (klasse) e.className = klasse;
      if (text !== undefined) e.textContent = text;
      return e;
    }

    // --- Schiene ---
    function zeige(name, mitFokus) {
      if (!TAFELN.includes(name) || refs.knoepfe[name].hidden) name = 'gespraeche';
      tafel = name;
      for (const n of TAFELN) {
        const an = n === name;
        refs.knoepfe[n].setAttribute('aria-selected', an ? 'true' : 'false');
        refs.knoepfe[n].tabIndex = an ? 0 : -1;
        refs.knoepfe[n].classList.toggle('aktiv', an);
        refs.tafeln[n].hidden = !an;
      }
      if (mitFokus) refs.knoepfe[name].focus();
      if (name === 'aufgaben') aufgabenNeu();
      if (name === 'laeufe') laeufeNeu();
      else plane();
      if (opts.beiTafel) opts.beiTafel(name);
    }
    for (const n of TAFELN) refs.knoepfe[n].addEventListener('click', () => zeige(n));
    refs.schiene.addEventListener('keydown', (e) => {
      const sichtbar = TAFELN.filter((n) => !refs.knoepfe[n].hidden);
      const i = sichtbar.findIndex((n) => refs.knoepfe[n] === doc.activeElement);
      if (i < 0) return;
      let n = -1;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') n = (i + 1) % sichtbar.length;
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') n = (i + sichtbar.length - 1) % sichtbar.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = sichtbar.length - 1;
      if (n < 0) return;
      e.preventDefault();
      zeige(sichtbar[n], true);
    });

    // --- Aufgaben ---
    const SR_ZUSTAND = { fertig: ' (erledigt)', laeuft: ' (in Arbeit)', offen: ' (offen)' };
    function zeichneAufgaben() {
      const s = aufgaben;
      refs.aufgabenLeer.hidden = !s.leer;
      refs.aufgabenKopf.hidden = s.leer;
      refs.aufgabenKopfText.textContent = s.leer ? '' : `${s.kurz} erledigt`;
      refs.aufgabenKopf.dataset.fertig = s.alleFertig ? '1' : '0';
      refs.aufgabenBalken.style.setProperty('--fuell', String(s.anteil));
      const liste = refs.aufgabenListe;
      while (liste.children.length > s.eintraege.length) liste.lastChild.remove();
      s.eintraege.forEach((e, i) => {
        let li = liste.children[i];
        if (!li) {
          li = el('li', 'wb-aufgabe');
          const marke = el('span', 'wb-marke');
          marke.setAttribute('aria-hidden', 'true');
          li.append(marke, el('span', 'wb-text'), el('span', 'sr'));
          liste.appendChild(li);
        }
        if (li.dataset.zustand !== e.zustand) li.dataset.zustand = e.zustand;
        const t = li.querySelector('.wb-text');
        if (t.textContent !== e.text) t.textContent = e.text;
        const sr = li.querySelector('.sr');
        if (sr.textContent !== SR_ZUSTAND[e.zustand]) sr.textContent = SR_ZUSTAND[e.zustand];
      });
      refs.aufgabenMarke.hidden = s.unerledigt === 0;
      refs.aufgabenMarke.textContent = String(s.unerledigt);
      refs.knoepfe.aufgaben.title = s.leer ? 'Aufgaben des Agenten' : `Aufgaben des Agenten: ${s.kurz} erledigt`;
      const st = refs.streifen;
      st.hidden = s.leer;
      st.dataset.fertig = s.alleFertig ? '1' : '0';
      st.dataset.arbeitet = s.arbeitet ? '1' : '0';
      refs.streifenText.textContent = s.alleFertig ? 'Alle Schritte erledigt' : s.aktuell;
      refs.streifenZahl.textContent = s.kurz;
      refs.streifenBalken.style.setProperty('--fuell', String(s.anteil));
    }

    async function aufgabenNeu() {
      if (!wege || sitzung === null || weg.aufgaben === 'nein') return;
      const fuer = sitzung;
      const lauf = ++aufgabenLauf;
      try {
        const a = await wege.aufgaben(fuer);
        if (beendet || lauf !== aufgabenLauf || fuer !== sitzung) return;
        weg.aufgaben = 'ja';
        refs.knoepfe.aufgaben.hidden = false;
        aufgaben = aufgabenSicht(a);
      } catch (f) {
        if (beendet || lauf !== aufgabenLauf || fuer !== sitzung) return;
        if (f && f.art === 'weg_fehlt') {
          weg.aufgaben = 'nein';
          refs.knoepfe.aufgaben.hidden = true;
          aufgaben = aufgabenSicht(null);
          if (tafel === 'aufgaben') zeige('gespraeche');
        }
        // jeder andere Fehler (Netz, Sitzung gerade nicht lesbar): der letzte Stand bleibt stehen
      }
      zeichneAufgaben();
    }

    /** Die sichtbare Sitzung hat gewechselt: ihre Aufgabenliste holen, eigene Läufe hervorheben. */
    function setzeSitzung(id) {
      const neu = id === undefined ? null : id;
      if (String(neu) === String(sitzung)) return;
      sitzung = neu;
      aufgabenLauf += 1; // eine Antwort für die alte Sitzung zählt nicht mehr
      aufgaben = aufgabenSicht(null);
      zeichneAufgaben();
      zeichneLaeufe();
      aufgabenNeu();
    }

    // --- Läufe und Hintergrundjobs ---
    function baueZeile(z) {
      const huelle = el('div', 'wb-lauf');
      huelle.setAttribute('role', 'listitem');
      const kopf = el('button', 'wb-lauf-kopf');
      kopf.type = 'button';
      kopf.setAttribute('aria-expanded', 'false');
      const punkt = el('span', 'wb-punkt');
      punkt.setAttribute('aria-hidden', 'true');
      const text = el('span', 'wb-lauf-text');
      text.append(el('span', 'wb-lauf-titel'), el('span', 'wb-lauf-meta'));
      kopf.append(punkt, text);
      const detail = el('div', 'wb-lauf-detail');
      detail.hidden = true;
      huelle.append(kopf, detail);
      kopf.addEventListener('click', () => klappe(z.schluessel));
      return huelle;
    }

    function fuelleZeile(huelle, z) {
      huelle.dataset.art = z.art;
      huelle.dataset.zustand = z.zustand;
      huelle.dataset.eigene = z.eigene ? '1' : '0';
      const titel = huelle.querySelector('.wb-lauf-titel');
      if (titel.textContent !== z.titel) titel.textContent = z.titel;
      const woanders = !z.eigene && z.gespraech !== null && z.gespraech !== undefined && opts.titelVon ? opts.titelVon(z.gespraech) : '';
      const meta = [ART_NAME[z.art], z.zustandText, z.dauerText, woanders].filter(Boolean).join(' · ');
      const m = huelle.querySelector('.wb-lauf-meta');
      if (m.textContent !== meta) m.textContent = meta;
      const kopf = huelle.querySelector('.wb-lauf-kopf');
      kopf.title = z.titel;
      const auf = offen === z.schluessel;
      kopf.setAttribute('aria-expanded', auf ? 'true' : 'false');
      huelle.querySelector('.wb-lauf-detail').hidden = !auf;
    }

    function knopf(text, beiKlick) {
      const b = el('button', 'wb-detail-knopf', text);
      b.type = 'button';
      b.addEventListener('click', beiKlick);
      return b;
    }

    /** Den Inhalt der aufgeklappten Zeile bauen (Unteragent: Ergebnis und Sprung; Befehl: Befehlszeile und Ausgabe, die nachgeladen wird). */
    function zeichneDetail(z) {
      const huelle = zeilenKnoten.get(z.schluessel);
      if (!huelle) return;
      const detail = huelle.querySelector('.wb-lauf-detail');
      if (z.art === 'job') {
        if (!detail.querySelector('.wb-ausgabe')) {
          detail.textContent = '';
          detail.append(el('pre', 'wb-befehl'), el('p', 'wb-hinweis leise'), el('pre', 'wb-ausgabe'));
          detail.querySelector('.wb-hinweis').hidden = true;
          detail.querySelector('.wb-ausgabe').tabIndex = 0;
        }
        ladeAusgabe(z);
        return;
      }
      detail.textContent = '';
      const inhalt = z.zustand === 'laeuft' ? 'Arbeitet noch. Das Ergebnis steht hier, sobald er fertig ist.' : z.fehler && z.zustand !== 'fertig' ? z.fehler : z.antwort || 'Kein Ergebnis gespeichert.';
      detail.append(el('p', 'wb-antwort', inhalt.length > 600 ? `${inhalt.slice(0, 599)}…` : inhalt));
      const knoepfe = el('div', 'wb-detail-knoepfe');
      if (z.kindId !== null && z.kindId !== undefined && opts.beiSprung) knoepfe.append(knopf('Verlauf öffnen', () => opts.beiSprung(z.kindId)));
      if (!z.eigene && z.gespraech !== null && z.gespraech !== undefined && opts.beiSprung) knoepfe.append(knopf('Zur Sitzung', () => opts.beiSprung(z.gespraech)));
      if (knoepfe.children.length) detail.append(knoepfe);
    }

    async function ladeAusgabe(z) {
      if (!wege) return;
      const lauf = ++ausgabeLauf;
      const huelle = zeilenKnoten.get(z.schluessel);
      const detail = huelle && huelle.querySelector('.wb-lauf-detail');
      if (!detail) return;
      const hinweis = detail.querySelector('.wb-hinweis');
      try {
        const j = await wege.job(z.id, 120);
        if (beendet || lauf !== ausgabeLauf || offen !== z.schluessel) return;
        detail.querySelector('.wb-befehl').textContent = j.befehl;
        const aus = detail.querySelector('.wb-ausgabe');
        const unten = aus.scrollTop + aus.clientHeight >= aus.scrollHeight - 4;
        const neu = j.text || (j.laeuft ? '(noch keine Ausgabe)' : '(keine Ausgabe)');
        if (aus.textContent !== neu) aus.textContent = neu;
        if (unten) aus.scrollTop = aus.scrollHeight;
        hinweis.hidden = !j.gekuerzt;
        hinweis.textContent = j.gekuerzt ? 'Nur das Ende der Ausgabe.' : '';
      } catch (f) {
        if (beendet || lauf !== ausgabeLauf || offen !== z.schluessel) return;
        hinweis.hidden = false;
        hinweis.textContent = (f && f.message) || 'Ausgabe nicht lesbar.';
      }
    }

    function klappe(schluessel) {
      const vorher = offen;
      offen = offen === schluessel ? null : schluessel;
      for (const k of [vorher, offen]) {
        const z = k && sicht.zeilen.find((x) => x.schluessel === k);
        const huelle = k && zeilenKnoten.get(k);
        if (z && huelle) fuelleZeile(huelle, z);
      }
      const z = offen && sicht.zeilen.find((x) => x.schluessel === offen);
      if (z) zeichneDetail(z);
    }

    function zeichneLaeufe() {
      sicht = laeufeSicht(daten.laeufe, daten.jobs, { jetzt: jetzt(), gespraech: sitzung });
      refs.laeufeMarke.hidden = sicht.laufend === 0;
      refs.laeufeMarke.textContent = String(sicht.laufend);
      refs.knoepfe.laeufe.dataset.laeuft = sicht.laufend ? '1' : '0';
      refs.knoepfe.laeufe.title = sicht.laufend ? `Läufe: ${sicht.laufend} laufen` : 'Läufe: Befehle im Hintergrund und Unteragenten';
      refs.laeufeLeer.hidden = sicht.zeilen.length > 0;
      const soll = new Set(sicht.zeilen.map((z) => z.schluessel));
      for (const [k, huelle] of [...zeilenKnoten]) {
        if (soll.has(k)) continue;
        huelle.remove();
        zeilenKnoten.delete(k);
        if (offen === k) offen = null;
      }
      let vorher = null;
      for (const z of sicht.zeilen) {
        let huelle = zeilenKnoten.get(z.schluessel);
        if (!huelle) {
          huelle = baueZeile(z);
          zeilenKnoten.set(z.schluessel, huelle);
        }
        fuelleZeile(huelle, z);
        const sollNach = vorher ? vorher.nextSibling : refs.laeufeListe.firstChild;
        if (huelle !== sollNach) refs.laeufeListe.insertBefore(huelle, sollNach);
        vorher = huelle;
      }
      // die aufgeklappte Zeile zieht nach: Ausgabe eines laufenden Befehls, Ergebnis eines Unteragenten
      const z = offen && sicht.zeilen.find((x) => x.schluessel === offen);
      if (z && tafel === 'laeufe') zeichneDetail(z);
    }

    function plane() {
      if (beendet || opts.takt === false) return;
      if (uhr) clearTimeout(uhr);
      const schnell = tafel === 'laeufe' || sicht.laufend > 0;
      uhr = setTimeout(() => {
        uhr = null;
        laeufeNeu();
      }, schnell ? 3000 : 20000);
    }

    async function hole(name, lesen) {
      if (weg[name] === 'nein') return null;
      try {
        const r = await lesen();
        weg[name] = 'ja';
        return r;
      } catch (f) {
        if (f && f.art === 'weg_fehlt') {
          weg[name] = 'nein';
          return [];
        }
        return null; // Netzfehler: der letzte Stand bleibt stehen
      }
    }

    async function laeufeNeu() {
      if (!wege || beendet) return;
      const lauf = ++laeufeLauf;
      const [l, j] = await Promise.all([hole('laeufe', () => wege.laeufe()), hole('jobs', () => wege.jobs())]);
      if (beendet || lauf !== laeufeLauf) return;
      if (l) daten.laeufe = l;
      if (j) daten.jobs = j;
      const da = weg.laeufe === 'ja' || weg.jobs === 'ja';
      refs.knoepfe.laeufe.hidden = !da;
      if (!da && tafel === 'laeufe') zeige('gespraeche');
      zeichneLaeufe();
      plane();
    }

    refs.streifen.addEventListener('click', () => {
      if (opts.beiStreifen) opts.beiStreifen();
      zeige('aufgaben', true);
    });

    zeichneAufgaben();
    zeichneLaeufe();
    zeige('gespraeche');

    return {
      zeige,
      setzeSitzung,
      aufgabenNeu,
      laeufeNeu,
      ende() {
        beendet = true;
        if (uhr) clearTimeout(uhr);
        uhr = null;
      },
      get tafel() {
        return tafel;
      },
      zustand: () => ({ aufgaben, laeufe: sicht, weg: { ...weg }, offen }),
    };
  }

  FP.werkbank = { dauerText, aufgabenSicht, laeufeSicht, createWerkbank };
})(typeof globalThis !== 'undefined' ? globalThis : window);
