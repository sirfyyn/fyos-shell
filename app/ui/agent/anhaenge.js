/* Anhänge an eine Nachricht: Büroklammer, Ziehen und Einfügen. Die Seite liest nur Dateien, die der Mensch ausdrücklich wählt, ablegt oder einfügt,
 * und zwar über die File-API des WebViews (Dialog `<input type="file">`, Drop, Zwischenablage). Es gibt keinen Pfadzugriff und keinen Rust-Befehl dafür.
 *
 * Was der Runner annimmt: POST /api/gespraech/:id/nachricht kennt nur `text` (höchstens 40 000 Zeichen), keine Bild-Blöcke und kein Feld `anhaenge`.
 * Darum werden TEXTDATEIEN als eingebetteter Text an den Satz gehängt (mit Name, Größe und Hinweis); Binärdateien und Bilder lehnt die Seite mit Grund ab.
 *
 * Reine Teile (ohne DOM): pruefeDatei, einbetten, GRENZEN, groesseText. Oberfläche: FP.createAnhaenge(refs, opts).
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
    let liste = []; // { id, name, groesse, text }
    let zaehler = 0;
    let uhr = null;

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
        const n = doc.createElement('span');
        n.className = 'anhang-name';
        n.textContent = a.name;
        n.title = `${a.name} (${groesseText(a.groesse)}, als Text eingebettet)`;
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
    const summe = () => liste.reduce((s, a) => s + a.text.length, 0);

    /** Dateien (FileList/Array) prüfen und anhängen. Abgelehnte stehen mit Grund in der Meldung, die übrigen werden trotzdem angehängt. */
    async function hinzu(dateien) {
      const abgelehnt = [];
      for (const d of Array.from(dateien || [])) {
        if (liste.length >= GRENZEN.anzahl) {
          abgelehnt.push(`${sauber(d.name)}: Höchstens ${GRENZEN.anzahl} Anhänge je Nachricht.`);
          continue;
        }
        const r = await pruefeDatei(d);
        if (!r.ok) {
          abgelehnt.push(`${r.name}: ${r.grund}`);
          continue;
        }
        if (liste.some((a) => a.name === r.name && a.groesse === r.groesse && a.text === r.text)) continue; // dieselbe Datei zweimal
        if (summe() + r.text.length > GRENZEN.gesamt) {
          abgelehnt.push(`${r.name}: Alle Anhänge zusammen dürfen höchstens ${GRENZEN.gesamt.toLocaleString('de-DE')} Zeichen haben.`);
          continue;
        }
        zaehler += 1;
        liste.push({ id: zaehler, name: r.name, groesse: r.groesse, text: r.text });
      }
      zeichne();
      meldung(abgelehnt.length ? `Nicht angehängt: ${abgelehnt.join(' ')}` : '');
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
      text: (satz) => einbetten(satz, liste),
      pruefen: (satz) => gesamtPruefen(satz, liste),
    };
  }

  FP.createAnhaenge = createAnhaenge;
  FP.anhaenge = { pruefeDatei, einbetten, gesamtPruefen, groesseText, GRENZEN };
})(typeof globalThis !== 'undefined' ? globalThis : window);
