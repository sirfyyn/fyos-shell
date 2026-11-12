/* Anhänge an eine Nachricht: Büroklammer, Ziehen und Einfügen. Die Seite liest nur Dateien, die der Mensch ausdrücklich wählt, ablegt oder einfügt,
 * und zwar über die File-API des WebViews (Dialog `<input type="file">`, Drop, Zwischenablage). Es gibt keinen Pfadzugriff und keinen Rust-Befehl dafür.
 *
 * Was der Runner annimmt, sagt er selbst (GET /api/anhaenge, Paket A7 in FYOS-AGENT-LOKAL-PLAN). Ohne diesen Weg kennt POST /api/gespraech/:id/nachricht
 * nur `text` (höchstens 40 000 Zeichen): dann werden TEXTDATEIEN als eingebetteter Text an den Satz gehängt (mit Name, Größe und Hinweis), Binärdateien und
 * Bilder lehnt die Seite mit Grund ab. Mit ihm (`setzeFaehig`) gehen auch Bilder, große Textdateien und andere Dateien: als Feld `anhaenge` der Nachricht
 * (`fuerRunner`); kleine Textdateien stehen weiter im Satz.
 *
 * Reine Teile (ohne DOM): pruefeDatei, pruefeFuerRunner, fuerRunner, einbetten, GRENZEN, groesseText. Oberfläche: FP.createAnhaenge(refs, opts).
 * Namen und Inhalte gehen nur über textContent in die Seite; der Inhalt wird nie als HTML gedeutet.
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  const GRENZEN = {
    datei: 100 * 1024, // Byte je Datei
    gesamt: 30000, // Zeichen aller Anhänge zusammen (der Runner schneidet eine Nachricht bei 40 000 Zeichen still ab, darunter bleiben wir mit Platz für den Satz)
    nachricht: 38000, // Zeichen von Satz und Anhängen zusammen
    anzahl: 5,
  };
  const BILD_ENDUNGEN = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|ico|avif)$/i;

  const groesseText = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1).replace('.', ',')} KB` : `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`);
  const sauber = (name) => String(name || 'Datei').replace(/[\r\n`]+/g, ' ').trim().slice(0, 120) || 'Datei';

  /** Bytes einer Datei: arrayBuffer() oder FileReader (ältere Umgebungen). */
  function bytesLesen(datei) {
    if (typeof datei.arrayBuffer === 'function') return datei.arrayBuffer().then((b) => new Uint8Array(b));
    return new Promise((ok, nein) => {
      const FR = G.FileReader;
      if (!FR) return nein(new Error('Dieses Fenster kann Dateien nicht lesen.'));
      const r = new FR();
      r.onload = () => ok(new Uint8Array(r.result));
      r.onerror = () => nein(r.error || new Error('Nicht lesbar.'));
      r.readAsArrayBuffer(datei);
    });
  }

  /**
   * Eine gewählte Datei prüfen und als Text lesen. → { ok: true, name, groesse, text } oder { ok: false, name, grund }.
   * Bilder und Binärdateien lehnt sie ab (der Runner nimmt nur Text an), ebenso Dateien über der Größengrenze und Text, der kein gültiges UTF-8 ist.
   */
  async function pruefeDatei(datei) {
    const name = sauber(datei && datei.name);
    const art = String((datei && datei.type) || '');
    if (/^image\//.test(art) && !/svg/.test(art)) return { ok: false, name, grund: 'Bilder nimmt der Runner heute nicht an (nur Text im Satz).' };
    if (BILD_ENDUNGEN.test(name)) return { ok: false, name, grund: 'Bilder nimmt der Runner heute nicht an (nur Text im Satz).' };
    const groesse = Number(datei && datei.size);
    if (!Number.isFinite(groesse)) return { ok: false, name, grund: 'Die Datei ist nicht lesbar.' };
    if (groesse > GRENZEN.datei) return { ok: false, name, grund: `Zu groß (${groesseText(groesse)}, höchstens ${groesseText(GRENZEN.datei)}).` };
    let bytes;
    try {
      bytes = await bytesLesen(datei);
    } catch (f) {
      return { ok: false, name, grund: 'Die Datei ist nicht lesbar.' };
    }
    const kopf = bytes.subarray(0, 8000);
    for (let i = 0; i < kopf.length; i += 1) if (kopf[i] === 0) return { ok: false, name, grund: 'Das ist eine Binärdatei; der Runner nimmt nur Text an.' };
    let text;
    try {
      text = new G.TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (f) {
      return { ok: false, name, grund: 'Kein UTF-8-Text; der Runner nimmt nur Text an.' };
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { ok: true, name, groesse: bytes.length, text };
  }

  // --- Mit einem Runner, der Anhänge annimmt (GET /api/anhaenge, Paket A7): Bilder, große Textdateien, andere Dateien ---
  const BILD_DIREKT = /^image\/(png|jpeg|gif|webp)$/;
  const DIREKT_BIS = 3 * 1024 * 1024; // größere Bilder verkleinert die Seite vorab, wenn sie zeichnen kann (der Runner verkleinert ohnehin)
  const ZEICHEN_KANTE = 2048;

  /** Bytes → Base64, stückweise (ein einziger Aufruf mit Millionen Argumenten sprengt den Stapel). */
  function base64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return G.btoa(s);
  }

  /** Ein Bild über eine Zeichenfläche auf höchstens `kante` verkleinern und als JPEG lesen; null, wenn das Fenster das nicht kann. */
  async function zeichnen(datei, kante) {
    try {
      if (typeof G.createImageBitmap !== 'function' || !G.document) return null;
      const bild = await G.createImageBitmap(datei);
      const faktor = Math.min(1, kante / Math.max(bild.width, bild.height));
      const flaeche = G.document.createElement('canvas');
      flaeche.width = Math.max(1, Math.round(bild.width * faktor));
      flaeche.height = Math.max(1, Math.round(bild.height * faktor));
      const stift = flaeche.getContext && flaeche.getContext('2d');
      if (!stift) return null;
      stift.drawImage(bild, 0, 0, flaeche.width, flaeche.height);
      if (typeof bild.close === 'function') bild.close();
      const blob = await new Promise((ok) => flaeche.toBlob(ok, 'image/jpeg', 0.9));
      if (!blob) return null;
      return { bytes: new Uint8Array(await blob.arrayBuffer()), typ: 'image/jpeg' };
    } catch (f) {
      return null;
    }
  }

  /**
   * Eine gewählte Datei für einen Runner prüfen, der Anhänge annimmt. → { ok: true, art, name, groesse, … } oder { ok: false, name, grund }.
   *   art 'text'   kleine Textdatei: wird wie bisher in den Satz eingebettet ({ text })
   *   art 'bild'   Bild als Base64 ({ daten, typ }); der Runner verkleinert es und gibt es dem Modell, wenn es Bilder sieht
   *   art 'datei'  große Textdatei ({ text }) oder andere Datei ({ daten }): der Runner legt sie ab, der Agent liest sie mit seinen Werkzeugen
   * `grenzen`: { bildBytes, dateiBytes } vom Runner.
   */
  async function pruefeFuerRunner(datei, grenzen) {
    const name = sauber(datei && datei.name);
    const typ = String((datei && datei.type) || '');
    const groesse = Number(datei && datei.size);
    if (!Number.isFinite(groesse)) return { ok: false, name, grund: 'Die Datei ist nicht lesbar.' };
    const istBild = (/^image\//.test(typ) && !/svg/.test(typ)) || BILD_ENDUNGEN.test(name);
    try {
      if (istBild) {
        const direkt = BILD_DIREKT.test(typ) || /\.(png|jpe?g|gif|webp)$/i.test(name);
        if (!(direkt && groesse <= DIREKT_BIS)) {
          const klein = await zeichnen(datei, ZEICHEN_KANTE);
          if (klein) return { ok: true, art: 'bild', name, groesse: klein.bytes.length, typ: klein.typ, daten: base64(klein.bytes) };
          if (!direkt) return { ok: false, name, grund: 'Dieses Bildformat kann die Seite nicht umwandeln (PNG, JPEG, GIF oder WebP gehen).' };
        }
        if (groesse > grenzen.bildBytes) return { ok: false, name, grund: `Zu groß (${groesseText(groesse)}, höchstens ${groesseText(grenzen.bildBytes)}).` };
        const bytes = await bytesLesen(datei);
        // Nennt das Fenster keinen Typ, gilt die Endung (nur für die kleine Ansicht im Chip; der Runner liest die Art aus den Bytes)
        const nachEndung = /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.gif$/i.test(name) ? 'image/gif' : /\.webp$/i.test(name) ? 'image/webp' : '';
        return { ok: true, art: 'bild', name, groesse: bytes.length, typ: BILD_DIREKT.test(typ) ? typ : nachEndung, daten: base64(bytes) };
      }
      if (groesse > grenzen.dateiBytes) return { ok: false, name, grund: `Zu groß (${groesseText(groesse)}, höchstens ${groesseText(grenzen.dateiBytes)}).` };
      const bytes = await bytesLesen(datei);
      let text = null;
      if (!bytes.subarray(0, 8000).includes(0)) {
        try {
          text = new G.TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        } catch (f) {
          text = null;
        }
      }
      if (text === null) return { ok: true, art: 'datei', name, groesse: bytes.length, daten: base64(bytes) };
      return { ok: true, art: bytes.length <= GRENZEN.datei ? 'text' : 'datei', name, groesse: bytes.length, text };
    } catch (f) {
      return { ok: false, name, grund: 'Die Datei ist nicht lesbar.' };
    }
  }

  /** Was davon als `anhaenge` an den Runner geht (Bilder und abgelegte Dateien; eingebetteter Text steht im Satz). */
  function fuerRunner(liste) {
    return (liste || [])
      .filter((a) => a.art === 'bild' || a.art === 'datei')
      .map((a) => (a.art === 'bild' ? { art: 'bild', name: a.name, daten: a.daten } : typeof a.text === 'string' ? { art: 'datei', name: a.name, text: a.text } : { art: 'datei', name: a.name, daten: a.daten }));
  }
  const eingebettet = (liste) => (liste || []).filter((a) => a.art === undefined || a.art === 'text');

  /** Der Zaun um einen Block: länger als jede Reihe von Rückstrichen im Inhalt, mindestens drei. */
  function zaun(text) {
    let max = 2;
    for (const m of String(text).matchAll(/`+/g)) max = Math.max(max, m[0].length);
    return '`'.repeat(max + 1);
  }

  /** Satz und Anhänge zu dem Text, der an den Runner geht. Ohne Anhänge unverändert. */
  function einbetten(satz, anhaenge) {
    const text = String(satz || '').trim();
    if (!anhaenge || !anhaenge.length) return text;
    const bloecke = anhaenge.map((a) => {
      const z = zaun(a.text);
      return `Datei: ${sauber(a.name)} (${groesseText(a.groesse)})\n${z}\n${a.text.replace(/\n+$/, '')}\n${z}`;
    });
    const kopf = anhaenge.length === 1 ? 'Angehängte Datei (als Text eingebettet, Stand beim Anhängen):' : `Angehängte Dateien (${anhaenge.length}, als Text eingebettet, Stand beim Anhängen):`;
    return `${text ? `${text}\n\n` : ''}${kopf}\n\n${bloecke.join('\n\n')}`;
  }

  /** Passt alles in eine Nachricht? → null oder der Grund. */
  function gesamtPruefen(satz, anhaenge) {
    const voll = einbetten(satz, anhaenge);
    if (voll.length > GRENZEN.nachricht) return `Die Nachricht ist mit den Anhängen zu lang (${voll.length} von höchstens ${GRENZEN.nachricht} Zeichen). Bitte Anhänge entfernen oder kürzen.`;
    return null;
  }

  /**
   * refs: leiste (Behälter der Chips), knopf (Büroklammer), wahl (<input type="file">), zone (Element, auf dem Dateien abgelegt werden), meldung (Zeile für Hinweise)
   * opts: beiAenderung() · melde(text) optional
   */
  function createAnhaenge(refs, opts) {
    opts = opts || {};
    const doc = refs.leiste.ownerDocument;
    // { id, name, groesse, text } (eingebetteter Text); mit einem Runner, der Anhänge annimmt, auch { art: 'bild', daten, typ } und { art: 'datei', text | daten }
    let liste = [];
    let zaehler = 0;
    let uhr = null;
    // Was der Runner annimmt (GET /api/anhaenge): { bilder, grenzen: { anzahl, bildBytes, dateiBytes, gesamtBytes } } oder null: dann nur eingebetteter Text
    let faehig = null;
    const ART_TITEL = { bild: 'als Bild', datei: 'als Datei für den Agenten' };

    function meldung(text) {
      if (!refs.meldung) return;
      refs.meldung.hidden = !text;
      refs.meldung.textContent = text || '';
      if (uhr) clearTimeout(uhr);
      if (text) uhr = setTimeout(() => meldung(''), 9000);
    }
    function zeichne() {
      refs.leiste.textContent = '';
      refs.leiste.hidden = liste.length === 0;
      for (const a of liste) {
        const chip = doc.createElement('span');
        chip.className = 'anhang-chip';
        chip.setAttribute('role', 'listitem');
        chip.dataset.id = String(a.id);
        if (a.art === 'bild' || a.art === 'datei') chip.dataset.art = a.art;
        // Bild: eine kleine Ansicht im Chip (nur aus den eigenen Bytes als data-Adresse, nie eine fremde Adresse)
        if (a.art === 'bild' && a.typ && typeof a.daten === 'string' && a.daten.length <= 4000000) {
          const b = doc.createElement('img');
          b.className = 'anhang-bild';
          b.alt = '';
          b.src = `data:${a.typ};base64,${a.daten}`;
          chip.appendChild(b);
        }
        const n = doc.createElement('span');
        n.className = 'anhang-name';
        n.textContent = a.name;
        n.title = `${a.name} (${groesseText(a.groesse)}, ${ART_TITEL[a.art] || 'als Text eingebettet'})`;
        const g = doc.createElement('span');
        g.className = 'leise anhang-groesse';
        g.textContent = groesseText(a.groesse);
        const x = doc.createElement('button');
        x.type = 'button';
        x.className = 'anhang-weg';
        x.setAttribute('aria-label', `Anhang ${a.name} entfernen`);
        x.title = 'Entfernen';
        x.textContent = '×';
        x.addEventListener('click', () => {
          entferne(a.id);
          if (refs.fokus) refs.fokus();
        });
        chip.append(n, g, x);
        refs.leiste.appendChild(chip);
      }
      if (opts.beiAenderung) opts.beiAenderung();
    }
    function entferne(id) {
      liste = liste.filter((a) => a.id !== id);
      zeichne();
    }
    const summe = () => eingebettet(liste).reduce((s, a) => s + a.text.length, 0);
    const bytesRunner = () => liste.filter((a) => a.art === 'bild' || a.art === 'datei').reduce((s, a) => s + a.groesse, 0);

    /** Dateien (FileList/Array) prüfen und anhängen. Abgelehnte stehen mit Grund in der Meldung, die übrigen werden trotzdem angehängt. */
    async function hinzu(dateien) {
      const abgelehnt = [];
      const hinweise = [];
      for (const d of Array.from(dateien || [])) {
        const anzahl = faehig ? faehig.grenzen.anzahl : GRENZEN.anzahl;
        if (liste.length >= anzahl) {
          abgelehnt.push(`${sauber(d.name)}: Höchstens ${anzahl} Anhänge je Nachricht.`);
          continue;
        }
        const r = faehig ? await pruefeFuerRunner(d, faehig.grenzen) : await pruefeDatei(d);
        if (!r.ok) {
          abgelehnt.push(`${r.name}: ${r.grund}`);
          continue;
        }
        if (!faehig) {
          if (liste.some((a) => a.name === r.name && a.groesse === r.groesse && a.text === r.text)) continue; // dieselbe Datei zweimal
          if (summe() + r.text.length > GRENZEN.gesamt) {
            abgelehnt.push(`${r.name}: Alle Anhänge zusammen dürfen höchstens ${GRENZEN.gesamt.toLocaleString('de-DE')} Zeichen haben.`);
            continue;
          }
          zaehler += 1;
          liste.push({ id: zaehler, name: r.name, groesse: r.groesse, text: r.text });
          continue;
        }
        if (liste.some((a) => a.name === r.name && a.groesse === r.groesse && a.text === r.text && a.daten === r.daten)) continue; // dieselbe Datei zweimal
        // Passt ein Text nicht mehr in den Satz, geht er als Datei an den Agenten statt verloren
        if (r.art === 'text' && summe() + r.text.length > GRENZEN.gesamt) r.art = 'datei';
        if (r.art !== 'text' && bytesRunner() + r.groesse > faehig.grenzen.gesamtBytes) {
          abgelehnt.push(`${r.name}: Alle Anhänge zusammen dürfen höchstens ${groesseText(faehig.grenzen.gesamtBytes)} haben.`);
          continue;
        }
        if (r.art === 'bild' && !faehig.bilder) hinweise.push(`${r.name}: Das Modell sieht keine Bilder; der Agent bekommt das Bild als Datei.`);
        zaehler += 1;
        liste.push({ id: zaehler, art: r.art, name: r.name, groesse: r.groesse, ...(r.text !== undefined ? { text: r.text } : {}), ...(r.daten !== undefined ? { daten: r.daten } : {}), ...(r.typ ? { typ: r.typ } : {}) });
      }
      zeichne();
      meldung([abgelehnt.length ? `Nicht angehängt: ${abgelehnt.join(' ')}` : '', ...hinweise].filter(Boolean).join(' '));
      return { angehaengt: liste.length, abgelehnt };
    }

    // Büroklammer: öffnet den Dialog des Systems; gelesen wird nur, was darin gewählt wird
    if (refs.knopf && refs.wahl) {
      refs.knopf.addEventListener('click', () => refs.wahl.click());
      refs.wahl.addEventListener('change', () => {
        const dateien = Array.from(refs.wahl.files || []);
        refs.wahl.value = '';
        hinzu(dateien);
      });
    }
    // Einfügen: Dateien aus der Zwischenablage (Text bleibt gewöhnliches Einfügen)
    if (refs.feld) {
      refs.feld.addEventListener('paste', (e) => {
        const dt = e.clipboardData;
        const dateien = dt && dt.files ? Array.from(dt.files) : [];
        if (!dateien.length) return;
        e.preventDefault();
        hinzu(dateien);
      });
    }
    // Ziehen: nur Dateien; ohne diese Sperre würde das Fenster die Datei selbst öffnen
    const mitDateien = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
    const zone = refs.zone;
    if (zone) {
      const an = (e) => {
        if (!mitDateien(e)) return;
        e.preventDefault();
        zone.classList.add('zieht');
      };
      zone.addEventListener('dragenter', an);
      zone.addEventListener('dragover', (e) => {
        an(e);
        if (mitDateien(e) && e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      });
      zone.addEventListener('dragleave', (e) => {
        if (!zone.contains(e.relatedTarget)) zone.classList.remove('zieht');
      });
      zone.addEventListener('drop', (e) => {
        zone.classList.remove('zieht');
        if (!mitDateien(e)) return;
        e.preventDefault();
        e.stopPropagation();
        hinzu(e.dataTransfer.files);
      });
    }
    if (refs.dokument) {
      for (const art of ['dragover', 'drop']) {
        refs.dokument.addEventListener(art, (e) => {
          if (mitDateien(e)) e.preventDefault();
        });
      }
    }

    zeichne();
    return {
      hinzu,
      entferne,
      /** Die Anhänge (für den Entwurf der Sitzung) und wieder einsetzen. */
      nimm: () => liste.map((a) => ({ ...a })),
      setze(neu) {
        liste = (neu || []).map((a) => ({ ...a }));
        zaehler = liste.reduce((m, a) => Math.max(m, a.id), zaehler);
        meldung('');
        zeichne();
      },
      leere() {
        liste = [];
        meldung('');
        zeichne();
      },
      anzahl: () => liste.length,
      meldung,
      /** Der Text für den Runner: Satz plus eingebettete Anhänge. */
      text: (satz) => einbetten(satz, eingebettet(liste)),
      pruefen: (satz) => gesamtPruefen(satz, eingebettet(liste)),
      /** Bilder und abgelegte Dateien für das Feld `anhaenge` der Nachricht (leer ohne einen Runner, der sie annimmt). */
      fuerRunner: () => fuerRunner(liste),
      /**
       * Was der Runner annimmt (Antwort von GET /api/anhaenge) oder null. Mit einem solchen Runner nimmt die Büroklammer auch Bilder,
       * große Textdateien und andere Dateien; ohne ihn bleibt alles beim eingebetteten Text.
       */
      setzeFaehig(stand) {
        faehig = stand && stand.an === true && stand.grenzen ? { bilder: stand.bilder === true, grenzen: stand.grenzen } : null;
        if (refs.knopf) {
          refs.knopf.title = faehig
            ? 'Datei oder Bild anhängen (auch per Ziehen oder Einfügen). Kleine Textdateien stehen im Satz, alles andere bekommt der Agent als Datei.'
            : 'Textdatei anhängen (auch per Ziehen oder Einfügen); sie wird als Text in die Nachricht eingebettet';
        }
      },
      get faehig() {
        return faehig;
      },
    };
  }

  FP.createAnhaenge = createAnhaenge;
  FP.anhaenge = { pruefeDatei, pruefeFuerRunner, fuerRunner, einbetten, gesamtPruefen, groesseText, GRENZEN };
})(typeof globalThis !== 'undefined' ? globalThis : window);
