/* Tafel „Dateien“ der Seitenleiste (Rest von Paket B1): der Ordner der Sitzung als Baum. Ordner klappen auf und laden dabei ihren Inhalt,
 * ein Klick auf eine Datei öffnet sie rechts als Fläche (datei-flaeche.js), „@“ hängt sie an die Nachricht, und was der Agent in der Sitzung
 * geändert oder angelegt hat, trägt eine Marke. Das Suchfeld findet Dateien im ganzen Ordner nach ihrem Namen.
 *
 * Gelesen wird über runner-wege.js: `ordner` (Einträge eines Ordners, mit Punkt-Dateien, wenn der Runner sie nennt) und `dateiSuche` (nur der
 * lokale Runner; ohne ihn sucht das Feld in den Ordnern, die schon aufgeklappt waren, und sagt das). Geschrieben wird nichts. Namen kommen
 * vom Runner und gehen nur über textContent in die Seite. Die reinen Teile (markenSicht, baumZeilen, sucheGeladen) stehen getrennt vom DOM
 * und sind ohne Fenster prüfbar.
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  const BILD = /\.(png|jpe?g|gif|webp)$/i;
  const istBild = (name) => BILD.test(String(name || ''));
  const verbinde = (ordner, name) => (ordner ? `${ordner}/${name}` : name);
  const nameVon = (rel) => String(rel).slice(String(rel).lastIndexOf('/') + 1);
  const elternVon = (rel) => (String(rel).includes('/') ? String(rel).slice(0, String(rel).lastIndexOf('/')) : '');
  const MARKE = { neu: 'N', geaendert: 'M' };
  const MARKE_TITEL = { neu: 'vom Agenten in dieser Sitzung angelegt', geaendert: 'vom Agenten in dieser Sitzung geändert' };

  function groesseText(n) {
    if (typeof n !== 'number' || !(n >= 0)) return '';
    if (FP.dateiFlaeche && FP.dateiFlaeche.groesseText) return FP.dateiFlaeche.groesseText(n);
    return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1).replace('.', ',')} KB` : `${(n / 1048576).toFixed(1).replace('.', ',')} MB`;
  }

  /**
   * Marken aus den Ständen des Runners (was der Agent mit write und edit geändert hat).
   * dateien: [{ relativ, zustand: 'neu'|'geaendert'|'geloescht' }] → { dateien: Map(relativ → 'neu'|'geaendert'), ordner: Set(Ordner mit Geändertem darin) }
   */
  function markenSicht(dateien) {
    const aus = { dateien: new Map(), ordner: new Set() };
    for (const d of Array.isArray(dateien) ? dateien : []) {
      const rel = d && typeof d.relativ === 'string' ? d.relativ : '';
      if (!rel || rel.startsWith('/') || rel.startsWith('..')) continue; // außerhalb des Ordners der Sitzung: nicht im Baum
      if (d.zustand !== 'neu' && d.zustand !== 'geaendert') continue; // Gelöschtes steht nicht mehr im Baum
      aus.dateien.set(rel, d.zustand);
      for (let o = elternVon(rel); o; o = elternVon(o)) aus.ordner.add(o);
    }
    return aus;
  }

  /**
   * Die Zeilen des Baums in der Reihenfolge der Anzeige.
   * geladen: Map(relativer Ordner → { phase: 'laedt'|'ok'|'fehler', eintraege: [{ name, ordner, groesse }], abgeschnitten, text })
   * auf: Set aufgeklappter Ordner. → [{ art: 'ordner'|'datei'|'hinweis', rel, name, tiefe, offen, laedt, marke, geaendertDarin, versteckt, groesse, text, fehler }]
   */
  function baumZeilen(geladen, auf, marken) {
    const zeilen = [];
    const m = marken || { dateien: new Map(), ordner: new Set() };
    const gehe = (ordner, tiefe) => {
      const d = geladen.get(ordner);
      if (!d) return;
      for (const e of d.eintraege || []) {
        const rel = verbinde(ordner, e.name);
        const versteckt = e.name.startsWith('.');
        if (e.ordner) {
          const offen = auf.has(rel);
          const kind = geladen.get(rel);
          zeilen.push({ art: 'ordner', rel, name: e.name, tiefe, offen, laedt: offen && (!kind || kind.phase === 'laedt') && !(kind && kind.eintraege && kind.eintraege.length), geaendertDarin: m.ordner.has(rel), versteckt });
          if (offen) {
            gehe(rel, tiefe + 1);
            if (kind && kind.phase === 'fehler') zeilen.push({ art: 'hinweis', rel: `${rel}/?`, name: '', tiefe: tiefe + 1, text: kind.text || 'Der Ordner lässt sich nicht lesen.', fehler: true });
            else if (kind && kind.phase === 'ok' && !(kind.eintraege || []).length) zeilen.push({ art: 'hinweis', rel: `${rel}/?`, name: '', tiefe: tiefe + 1, text: 'leer' });
          }
        } else {
          zeilen.push({ art: 'datei', rel, name: e.name, tiefe, marke: m.dateien.get(rel) || '', versteckt, groesse: e.groesse });
        }
      }
      if (d.abgeschnitten) zeilen.push({ art: 'hinweis', rel: `${ordner}/…`, name: '', tiefe, text: 'Weitere Einträge sind nicht gezeigt (500 je Ordner).' });
    };
    gehe('', 0);
    return zeilen;
  }

  /**
   * Suche ohne den Runner: in den Ordnern, die schon geladen sind. Jedes Wort muss im Pfad vorkommen; Treffer im Namen zuerst.
   * → [{ relativ, name }]
   */
  function sucheGeladen(geladen, q, limit) {
    const worte = String(q || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (!worte.length) return [];
    const funde = [];
    for (const [ordner, d] of geladen) {
      for (const e of (d && d.eintraege) || []) {
        if (e.ordner) continue;
        const rel = verbinde(ordner, e.name);
        const klein = rel.toLowerCase();
        if (!worte.every((w) => klein.includes(w))) continue;
        const name = e.name.toLowerCase();
        funde.push([(worte.every((w) => name.includes(w)) ? 0 : 2) + (name.startsWith(worte[0]) ? 0 : 1), rel.length, rel]);
      }
    }
    funde.sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
    return funde.slice(0, limit || 50).map((f) => ({ relativ: f[2], name: nameVon(f[2]) }));
  }

  /** Klartext eines Fehlers der Anfrage, ohne Kennwörter des Protokolls. */
  function fehlerText(f) {
    if (f && f.art === 'ausserhalb') return 'Der Ordner liegt außerhalb der Ordner, die der Runner freigibt.';
    if (f && f.art === 'gesperrt') return 'Dieser Ordner ist gesperrt (deutet auf Geheimnisse hin).';
    if (f && f.art === 'nicht_gefunden') return 'Den Ordner gibt es nicht mehr.';
    if (f && f.art === 'netz') return 'Der Runner ist nicht erreichbar.';
    return (f && f.message) || 'Der Ordner lässt sich nicht lesen.';
  }

  const SVG = 'http://www.w3.org/2000/svg';
  const BILDER = {
    ordner: 'M2 4.5h4l1.5 1.5H14v6.5H2z',
    datei: 'M4 2.5h5.5L12 5v8.5H4z M9.5 2.5V5H12',
    bild: 'M2.5 3.5h11v9h-11z M4.5 10.5l2.5-3 2 2 1.5-1.5 1.5 2.5',
    pfeil: 'M6 4l4 4-4 4',
  };

  /**
   * refs: { knopf (Schiene), ordner (Name des Ordners im Kopf), suche (input), neuKnopf, baum (Behälter, role tree), leer (p), fuss (p) }
   * opts: { wege, gespraech() → id, ordner() → absoluter Ordner der Sitzung oder '', beiDatei({ pfad, relativ, bild }), beiErwaehnen(relativ),
   *         aktiv() → absoluter Pfad der Datei, die rechts vorn liegt, oder '', beiWeg(kennt), sichtbar() → ist die Tafel zu sehen,
   *         warteMs (Verzögerung der Suche, Vorgabe 180), setTimeout, clearTimeout }
   * Rückgabe: { setzeSitzung(id), ordnerNeu(), neu(), zeige(), plane(), setzeMarken(dateien), markiereAktiv(), ende(), zustand() }
   */
  function createDateienTafel(refs, opts) {
    opts = opts || {};
    const doc = refs.baum.ownerDocument;
    const wege = opts.wege;
    const warteMs = typeof opts.warteMs === 'number' ? opts.warteMs : 180;
    const spaeter = opts.setTimeout || ((f, ms) => G.setTimeout(f, ms));
    const dochNicht = opts.clearTimeout || ((t) => G.clearTimeout(t));

    let sitzung = null;
    let wurzel = '';
    let weg = 'unbekannt'; // 'ja' | 'nein' (kein Ordner, oder der Runner listet ihn nicht) | 'unbekannt'
    let geladen = new Map();
    let auf = new Set();
    const gemerkt = new Map(); // Sitzung → aufgeklappte Ordner (bleiben über einen Wechsel der Sitzung)
    let marken = markenSicht([]);
    let lauf = 0; // steigt mit jeder Sitzung: Antworten einer früheren zählen nicht mehr
    let veraltet = false; // der Agent hat etwas getan, die Tafel war zu: beim nächsten Öffnen neu lesen
    let fokusRel = null; // Zeile mit Tabstopp
    let suche = { q: '', lauf: 0, phase: 'aus', treffer: [], gesamt: 0, gekuerzt: false, unvollstaendig: false, nurGeladen: false, text: '' };
    let sucheWeg = 'unbekannt'; // 'ja' | 'nein' (der Runner kennt die Suche nicht)
    let sucheUhr = null;
    let neuUhr = null;
    let beendet = false;

    function el(name, klasse, text) {
      const e = doc.createElement(name);
      if (klasse) e.className = klasse;
      if (text !== undefined && text !== null) e.textContent = text;
      return e;
    }
    function bild(art) {
      const s = doc.createElementNS(SVG, 'svg');
      s.setAttribute('viewBox', '0 0 16 16');
      s.setAttribute('aria-hidden', 'true');
      const p = doc.createElementNS(SVG, 'path');
      p.setAttribute('d', BILDER[art]);
      s.appendChild(p);
      return s;
    }
    const absolut = (rel) => (rel ? `${wurzel}/${rel}` : wurzel);
    const sichtbar = () => (opts.sichtbar ? opts.sichtbar() : true);

    function setzeWeg(neu) {
      const vorher = weg;
      weg = neu;
      if (refs.knopf) refs.knopf.hidden = weg !== 'ja';
      if (vorher !== neu && neu !== 'unbekannt' && opts.beiWeg) opts.beiWeg(neu === 'ja');
    }

    // --- Laden ---------------------------------------------------------------------------------------------------------
    async function lade(rel, still) {
      const meiner = lauf;
      const alt = geladen.get(rel);
      // still: der alte Inhalt bleibt stehen, bis der neue da ist (kein Flackern beim Nachziehen)
      geladen.set(rel, { phase: 'laedt', eintraege: still && alt ? alt.eintraege : [], abgeschnitten: still && alt ? alt.abgeschnitten : false, text: '' });
      if (!still) zeichne();
      try {
        const r = await wege.ordner(absolut(rel), { versteckt: true });
        if (meiner !== lauf || beendet) return false;
        geladen.set(rel, { phase: 'ok', eintraege: r.eintraege, abgeschnitten: r.abgeschnitten === true, text: '' });
        if (rel === '') setzeWeg('ja');
        zeichne();
        return true;
      } catch (f) {
        if (meiner !== lauf || beendet) return false;
        if (rel === '') {
          // der Ordner der Sitzung selbst lässt sich nicht listen: die Tafel gibt es für diese Sitzung nicht
          geladen = new Map();
          setzeWeg('nein');
          zeichne();
          return false;
        }
        // ein Unterordner ist inzwischen weg: zuklappen statt einen Fehler stehen zu lassen
        if (f && f.art === 'nicht_gefunden' && still) {
          auf.delete(rel);
          geladen.delete(rel);
        } else geladen.set(rel, { phase: 'fehler', eintraege: [], abgeschnitten: false, text: fehlerText(f) });
        zeichne();
        return false;
      }
    }

    /** Wurzel und aufgeklappte Ordner neu lesen; der Baum bleibt dabei stehen. */
    async function neu() {
      if (beendet || sitzung === null || !wurzel) return;
      veraltet = false;
      const meiner = lauf;
      const ok = await lade('', geladen.has(''));
      if (!ok || meiner !== lauf) return;
      // Eltern vor Kindern: ein Ordner, den es nicht mehr gibt, nimmt seine Kinder mit
      const offene = [...auf].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));
      for (const rel of offene) {
        if (meiner !== lauf) return;
        const eltern = geladen.get(elternVon(rel));
        const gibtEs = eltern && (eltern.eintraege || []).some((e) => e.ordner && e.name === nameVon(rel));
        if (!gibtEs) {
          auf.delete(rel);
          geladen.delete(rel);
          continue;
        }
        await lade(rel, geladen.has(rel));
      }
      if (meiner === lauf && suche.q) void sucheJetzt();
    }

    /** Der Agent hat etwas getan: gebündelt neu lesen, wenn die Tafel zu sehen ist, sonst beim nächsten Öffnen. */
    function plane() {
      if (beendet || weg !== 'ja') return;
      if (!sichtbar()) {
        veraltet = true;
        return;
      }
      if (neuUhr !== null) return;
      neuUhr = spaeter(() => {
        neuUhr = null;
        void neu();
      }, 300);
    }

    function setzeSitzung(id) {
      if (sitzung !== null) gemerkt.set(String(sitzung), auf);
      lauf += 1;
      sitzung = id === undefined ? null : id;
      wurzel = String((opts.ordner && opts.ordner()) || '').replace(/\/+$/, '');
      geladen = new Map();
      auf = (sitzung !== null && gemerkt.get(String(sitzung))) || new Set();
      marken = markenSicht([]);
      fokusRel = null;
      suche = { q: '', lauf: suche.lauf + 1, phase: 'aus', treffer: [], gesamt: 0, gekuerzt: false, unvollstaendig: false, nurGeladen: false, text: '' };
      sucheWeg = 'unbekannt';
      if (refs.suche) refs.suche.value = '';
      if (refs.ordner) {
        refs.ordner.textContent = wurzel ? nameVon(wurzel) || wurzel : '';
        refs.ordner.title = wurzel;
        refs.ordner.hidden = !wurzel;
      }
      if (sitzung === null || !wurzel) {
        setzeWeg('nein');
        zeichne();
        return;
      }
      weg = 'unbekannt';
      zeichne();
      void neu();
    }

    // --- Suche ---------------------------------------------------------------------------------------------------------
    async function sucheJetzt() {
      const q = suche.q;
      const meiner = ++suche.lauf;
      const sitzungLauf = lauf;
      if (!q) return;
      const lokal = () => {
        const treffer = sucheGeladen(geladen, q, 50);
        suche = { ...suche, phase: 'ok', treffer, gesamt: treffer.length, gekuerzt: false, unvollstaendig: false, nurGeladen: true, text: '' };
        zeichne();
      };
      if (sucheWeg === 'nein' || !wege.dateiSuche) {
        sucheWeg = 'nein';
        lokal();
        return;
      }
      suche = { ...suche, phase: suche.treffer.length ? 'ok' : 'laedt' };
      zeichne();
      try {
        const r = await wege.dateiSuche(sitzung, q, { limit: 50 });
        if (meiner !== suche.lauf || sitzungLauf !== lauf || beendet) return;
        sucheWeg = 'ja';
        suche = { ...suche, phase: 'ok', treffer: r.treffer, gesamt: r.gesamt, gekuerzt: r.gekuerzt, unvollstaendig: r.unvollstaendig, nurGeladen: false, text: '' };
        zeichne();
      } catch (f) {
        if (meiner !== suche.lauf || sitzungLauf !== lauf || beendet) return;
        if (f && f.art === 'weg_fehlt') {
          sucheWeg = 'nein';
          lokal();
          return;
        }
        suche = { ...suche, phase: 'fehler', treffer: [], gesamt: 0, text: f && f.art === 'netz' ? 'Der Runner ist nicht erreichbar.' : (f && f.message) || 'Die Suche ist gescheitert.' };
        zeichne();
      }
    }

    function setzeSuche(q) {
      const neuQ = String(q || '').trim();
      if (neuQ === suche.q) return;
      suche = { ...suche, q: neuQ };
      if (sucheUhr !== null) dochNicht(sucheUhr);
      sucheUhr = null;
      if (!neuQ) {
        suche = { ...suche, lauf: suche.lauf + 1, phase: 'aus', treffer: [], gesamt: 0, text: '' };
        fokusRel = null;
        zeichne();
        return;
      }
      sucheUhr = spaeter(() => {
        sucheUhr = null;
        void sucheJetzt();
      }, warteMs);
    }

    // --- Handeln -------------------------------------------------------------------------------------------------------
    function schalte(rel, an) {
      const offen = an === undefined ? !auf.has(rel) : an;
      if (offen) {
        auf.add(rel);
        if (!geladen.has(rel) || geladen.get(rel).phase === 'fehler') void lade(rel, false);
        else zeichne();
      } else {
        // zuklappen nimmt die Kinder mit: beim nächsten Aufklappen steht nur dieser Ordner offen
        for (const o of [...auf]) if (o === rel || o.startsWith(`${rel}/`)) auf.delete(o);
        zeichne();
      }
    }
    function oeffne(rel) {
      if (opts.beiDatei) opts.beiDatei({ pfad: absolut(rel), relativ: rel, bild: istBild(rel) });
    }
    function erwaehne(rel) {
      if (opts.beiErwaehnen) opts.beiErwaehnen(rel);
    }

    // --- Zeichnen ------------------------------------------------------------------------------------------------------
    function zeilen() {
      if (suche.q) return suche.treffer.map((t) => ({ art: 'datei', rel: t.relativ, name: t.name, tiefe: 0, marke: marken.dateien.get(t.relativ) || '', versteckt: false, ordnerText: elternVon(t.relativ), treffer: true }));
      return baumZeilen(geladen, auf, marken);
    }

    function baueZeile(z, aktivRel) {
      if (z.art === 'hinweis') {
        const h = el('div', `dt-hinweis${z.fehler ? ' fehler' : ''}`, z.text);
        h.style.paddingLeft = `${10 + z.tiefe * 13 + 16}px`;
        h.setAttribute('role', 'none');
        return h;
      }
      // eigene Klassennamen: `.ordner` und `.datei` sind auf der Seite schon vergeben (der Ordner im Kopf trägt ein Symbol davor)
      const zeile = el('div', `dt-zeile dt-${z.art}${z.versteckt ? ' versteckt' : ''}${z.rel === aktivRel ? ' aktiv' : ''}`);
      zeile.setAttribute('role', 'treeitem');
      zeile.setAttribute('aria-level', String(z.tiefe + 1));
      zeile.dataset.rel = z.rel;
      zeile.dataset.art = z.art;
      zeile.tabIndex = -1;
      zeile.style.paddingLeft = `${6 + z.tiefe * 13}px`;
      if (z.art === 'ordner') {
        zeile.setAttribute('aria-expanded', z.offen ? 'true' : 'false');
        const pfeil = el('span', `dt-pfeil${z.offen ? ' offen' : ''}`);
        pfeil.appendChild(bild('pfeil'));
        const sym = el('span', 'dt-symbol');
        sym.appendChild(bild('ordner'));
        zeile.append(pfeil, sym, el('span', 'dt-name', z.name));
        if (z.laedt) zeile.appendChild(el('span', 'dt-laedt', 'lädt …'));
        if (z.geaendertDarin) {
          const punkt = el('span', 'dt-punkt');
          punkt.title = 'Darin hat der Agent in dieser Sitzung etwas geändert.';
          punkt.setAttribute('aria-label', 'enthält Geändertes');
          zeile.appendChild(punkt);
        }
        zeile.title = z.rel;
      } else {
        zeile.setAttribute('aria-selected', z.rel === aktivRel ? 'true' : 'false');
        zeile.draggable = true;
        const sym = el('span', 'dt-symbol');
        sym.appendChild(bild(istBild(z.name) ? 'bild' : 'datei'));
        zeile.append(el('span', 'dt-pfeil leer'), sym, el('span', 'dt-name', z.name));
        if (z.treffer && z.ordnerText) zeile.appendChild(el('span', 'dt-ort', z.ordnerText));
        if (z.marke) {
          const m = el('span', `dt-marke ${z.marke}`, MARKE[z.marke] || '');
          m.title = MARKE_TITEL[z.marke] || '';
          m.setAttribute('aria-label', MARKE_TITEL[z.marke] || '');
          zeile.appendChild(m);
        }
        const an = el('button', 'dt-an', '@');
        an.type = 'button';
        an.tabIndex = -1;
        an.title = 'An die Nachricht hängen (auch mit der Taste @)';
        an.setAttribute('aria-label', `${z.name} an die Nachricht hängen`);
        zeile.appendChild(an);
        const g = groesseText(z.groesse);
        zeile.title = g ? `${z.rel} · ${g}` : z.rel;
      }
      return zeile;
    }

    function zeichne() {
      if (beendet) return;
      const hatteFokus = refs.baum.contains(doc.activeElement) && doc.activeElement !== refs.baum ? doc.activeElement.dataset.rel || null : null;
      const liste = zeilen();
      const aktivAbs = opts.aktiv ? String(opts.aktiv() || '') : '';
      const aktivRel = aktivAbs && wurzel && aktivAbs.startsWith(`${wurzel}/`) ? aktivAbs.slice(wurzel.length + 1) : '';
      const knoten = liste.map((z) => baueZeile(z, aktivRel));
      refs.baum.replaceChildren(...knoten);
      refs.baum.setAttribute('aria-busy', suche.q ? String(suche.phase === 'laedt') : String(!!(geladen.get('') && geladen.get('').phase === 'laedt' && !liste.length)));
      // ein Tabstopp im Baum: die zuletzt benutzte Zeile, sonst die aktive, sonst die erste
      const wahl = knoten.filter((k) => k.dataset && k.dataset.rel !== undefined && k.getAttribute('role') === 'treeitem');
      const ziel = wahl.find((k) => k.dataset.rel === fokusRel) || wahl.find((k) => k.dataset.rel === aktivRel) || wahl[0] || null;
      if (ziel) {
        ziel.tabIndex = 0;
        fokusRel = ziel.dataset.rel;
        if (hatteFokus !== null) (wahl.find((k) => k.dataset.rel === hatteFokus) || ziel).focus();
      }
      // Hinweis über dem Baum und Fußzeile
      let leer = '';
      if (suche.q) {
        if (suche.phase === 'laedt') leer = 'Sucht …';
        else if (suche.phase === 'fehler') leer = suche.text;
        else if (!suche.treffer.length) leer = suche.nurGeladen ? 'Keine Datei passt in den Ordnern, die schon aufgeklappt waren.' : 'Keine Datei passt.';
      } else if (weg === 'ja' && geladen.get('') && geladen.get('').phase === 'ok' && !liste.length) leer = 'Der Ordner ist leer.';
      else if (weg === 'unbekannt' && wurzel) leer = 'Der Ordner wird gelesen …';
      else if (weg === 'nein') leer = wurzel ? 'Der Runner listet den Ordner dieser Sitzung nicht.' : 'Diese Sitzung hat keinen eigenen Ordner.';
      if (refs.leer) {
        refs.leer.textContent = leer;
        refs.leer.hidden = !leer;
      }
      if (refs.fuss) {
        let fuss = 'Klick öffnet die Datei rechts. @ hängt sie an die Nachricht.';
        if (suche.q && suche.phase === 'ok' && suche.treffer.length) {
          fuss = suche.nurGeladen
            ? `${suche.treffer.length} Treffer in den Ordnern, die schon aufgeklappt waren. Dieser Runner sucht nicht im ganzen Ordner.`
            : suche.gekuerzt
              ? `${suche.treffer.length} von ${suche.gesamt} Treffern. Tipp mehr, um einzugrenzen.`
              : `${suche.treffer.length} Treffer.`;
          if (suche.unvollstaendig && !suche.nurGeladen) fuss += ' Der Ordner ist sehr groß: die Liste der Dateien war nicht vollständig.';
        }
        refs.fuss.textContent = fuss;
        refs.fuss.hidden = weg !== 'ja';
      }
      if (refs.suche) refs.suche.disabled = weg !== 'ja';
      if (refs.neuKnopf) refs.neuKnopf.disabled = weg !== 'ja';
    }

    // --- Bedienung -----------------------------------------------------------------------------------------------------
    const zeileVon = (ziel) => (ziel && ziel.closest ? ziel.closest('.dt-zeile') : null);
    const alleZeilen = () => Array.from(refs.baum.querySelectorAll('.dt-zeile'));
    function fokus(zeile) {
      if (!zeile) return;
      for (const z of alleZeilen()) z.tabIndex = z === zeile ? 0 : -1;
      fokusRel = zeile.dataset.rel;
      zeile.focus();
    }

    function beiKlick(e) {
      const zeile = zeileVon(e.target);
      if (!zeile) return;
      fokusRel = zeile.dataset.rel;
      if (e.target.closest && e.target.closest('.dt-an')) {
        erwaehne(zeile.dataset.rel);
        return;
      }
      if (zeile.dataset.art === 'ordner') schalte(zeile.dataset.rel);
      else oeffne(zeile.dataset.rel);
    }
    function beiTaste(e) {
      const zeile = zeileVon(e.target);
      if (!zeile || e.altKey || e.ctrlKey || e.metaKey) return;
      const alle = alleZeilen();
      const i = alle.indexOf(zeile);
      const rel = zeile.dataset.rel;
      const ordner = zeile.dataset.art === 'ordner';
      let getan = true;
      if (e.key === 'ArrowDown') fokus(alle[Math.min(alle.length - 1, i + 1)]);
      else if (e.key === 'ArrowUp') {
        if (i === 0 && refs.suche && !refs.suche.disabled) refs.suche.focus();
        else fokus(alle[Math.max(0, i - 1)]);
      } else if (e.key === 'Home') fokus(alle[0]);
      else if (e.key === 'End') fokus(alle[alle.length - 1]);
      else if (e.key === 'ArrowRight') {
        if (ordner && !auf.has(rel)) schalte(rel, true);
        else if (ordner) fokus(alle[Math.min(alle.length - 1, i + 1)]);
        else getan = false;
      } else if (e.key === 'ArrowLeft') {
        if (ordner && auf.has(rel)) schalte(rel, false);
        else {
          const eltern = elternVon(rel);
          const ziel = eltern ? alle.find((z) => z.dataset.rel === eltern) : null;
          if (ziel) fokus(ziel);
          else getan = false;
        }
      } else if (e.key === 'Enter' || e.key === ' ') {
        if (ordner) schalte(rel);
        else oeffne(rel);
      } else if (e.key === '@' && !ordner) erwaehne(rel);
      else getan = false;
      if (getan) e.preventDefault();
    }
    function beiZiehen(e) {
      const zeile = zeileVon(e.target);
      if (!zeile || zeile.dataset.art !== 'datei' || !e.dataTransfer) return;
      const wert = FP.eingabe && FP.eingabe.dateiWert ? FP.eingabe.dateiWert(zeile.dataset.rel) : `@${zeile.dataset.rel}`;
      e.dataTransfer.setData('text/plain', `${wert} `);
      e.dataTransfer.effectAllowed = 'copy';
    }
    function beiSuchTaste(e) {
      if (e.key === 'ArrowDown') {
        const erste = alleZeilen()[0];
        if (erste) {
          e.preventDefault();
          fokus(erste);
        }
      } else if (e.key === 'Escape' && refs.suche.value) {
        e.preventDefault();
        e.stopPropagation();
        refs.suche.value = '';
        setzeSuche('');
      } else if (e.key === 'Enter' && suche.q && suche.treffer.length) {
        e.preventDefault();
        oeffne(suche.treffer[0].relativ);
      }
    }
    const beiEingabe = () => setzeSuche(refs.suche.value);
    const beiNeu = () => void neu();

    refs.baum.addEventListener('click', beiKlick);
    refs.baum.addEventListener('keydown', beiTaste);
    refs.baum.addEventListener('dragstart', beiZiehen);
    if (refs.suche) {
      refs.suche.addEventListener('input', beiEingabe);
      refs.suche.addEventListener('keydown', beiSuchTaste);
    }
    if (refs.neuKnopf) refs.neuKnopf.addEventListener('click', beiNeu);
    if (refs.knopf) refs.knopf.hidden = true;
    zeichne();

    return {
      setzeSitzung,
      /** Wurzel und aufgeklappte Ordner neu lesen (beim Öffnen der Tafel, mit dem Knopf „Neu laden“). */
      neu,
      plane,
      /** Was der Agent in der Sitzung geändert hat (Stände des Runners): Marken an Dateien und Ordnern. `null`: der Runner führt keine Stände. */
      setzeMarken(dateien) {
        marken = markenSicht(dateien);
        zeichne();
      },
      /** Die Tafel wird sichtbar: nachziehen, wenn sich inzwischen etwas getan hat. */
      zeige() {
        if (veraltet || !geladen.has('')) void neu();
        else zeichne();
      },
      /** Rechts liegt eine andere Datei vorn. */
      markiereAktiv: zeichne,
      /** Der Ordner der Sitzung ist erst jetzt bekannt oder ein anderer geworden: den Baum dafür neu aufbauen. */
      ordnerNeu() {
        const jetzt = String((opts.ordner && opts.ordner()) || '').replace(/\/+$/, '');
        if (sitzung !== null && jetzt !== wurzel) setzeSitzung(sitzung);
      },
      ende() {
        beendet = true;
        if (sucheUhr !== null) dochNicht(sucheUhr);
        if (neuUhr !== null) dochNicht(neuUhr);
        refs.baum.removeEventListener('click', beiKlick);
        refs.baum.removeEventListener('keydown', beiTaste);
        refs.baum.removeEventListener('dragstart', beiZiehen);
        if (refs.suche) {
          refs.suche.removeEventListener('input', beiEingabe);
          refs.suche.removeEventListener('keydown', beiSuchTaste);
        }
        if (refs.neuKnopf) refs.neuKnopf.removeEventListener('click', beiNeu);
      },
      zustand: () => ({ weg, sucheWeg, wurzel, auf: [...auf].sort(), geladen: [...geladen.keys()].sort(), zeilen: zeilen().length, suche: suche.q, veraltet }),
    };
  }

  FP.dateien = { createDateienTafel, markenSicht, baumZeilen, sucheGeladen, istBild };
})(typeof window !== 'undefined' ? window : globalThis);
