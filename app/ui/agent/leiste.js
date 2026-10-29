/* Seitenleiste mit den Sitzungen: Zeilen bleiben beim Aktualisieren erhalten (nach Id abgeglichen, nur umsortiert), damit
 * Fokus, Hover und Auswahl nicht flackern. Tastatur: Pfeile hoch/runter, Pos1/Ende, Enter wählt, F2 benennt um (Liste mit Tabulatorstopp auf der Auswahl).
 * Je Zeile (div.sitzung-zeile): der Knopf der Sitzung, kleine Knöpfe „Umbenennen“ und „Archivieren“ (beim Überfahren und bei Fokus sichtbar), der
 * Namenseditor (statt des Knopfs, solange man umbenennt) und eine Meldung an der Zeile. Archivierte Sitzungen stehen in einem eingeklappten Abschnitt
 * „Archiv“ mit „Wiederherstellen“. Nur Text, nie HTML aus dem Runner.
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  const NAME_MAX = 120;

  /**
   * Kleiner Namenseditor (Zeile der Leiste und Kopf der Sitzung): ein Textfeld mit Meldungszeile im Behälter.
   * Enter speichert, Esc bricht ab, ein Klick daneben speichert nur eine echte Änderung. Lehnt der Runner ab, bleibt das Feld offen, die Meldung
   * steht darunter und der alte Name bleibt, wo er angezeigt wird (der Aufrufer ändert die Anzeige erst nach Erfolg).
   * o: { wert, label, speichern(titel) → Promise, beiEnde(grund: 'gespeichert'|'abgebrochen'|'unveraendert'), pruefen(text) → { ok, titel, fehler } }
   */
  function createTitelEditor(behaelter, o) {
    const doc = behaelter.ownerDocument;
    const pruefen =
      o.pruefen ||
      ((t) => {
        const titel = String(t || '').trim();
        return titel ? { ok: true, titel } : { ok: false, fehler: 'Der Name darf nicht leer sein.' };
      });
    const eingabe = doc.createElement('input');
    eingabe.type = 'text';
    eingabe.className = 'titel-eingabe';
    eingabe.maxLength = NAME_MAX;
    eingabe.value = o.wert || '';
    eingabe.setAttribute('aria-label', o.label || 'Neuer Name der Sitzung');
    eingabe.autocomplete = 'off';
    const meldung = doc.createElement('p');
    meldung.className = 'titel-fehler';
    meldung.setAttribute('role', 'alert');
    meldung.hidden = true;
    behaelter.append(eingabe, meldung);
    let beschaeftigt = false;
    let fertig = false;
    let fehlerGezeigt = false;

    function ende(grund) {
      if (fertig) return;
      fertig = true;
      eingabe.remove();
      meldung.remove();
      if (o.beiEnde) o.beiEnde(grund);
    }
    async function speichere() {
      if (beschaeftigt || fertig) return;
      const p = pruefen(eingabe.value);
      if (!p.ok) {
        meldung.textContent = p.fehler;
        meldung.hidden = false;
        fehlerGezeigt = true;
        eingabe.setAttribute('aria-invalid', 'true');
        return;
      }
      if (p.titel === String(o.wert || '').trim()) return ende('unveraendert');
      beschaeftigt = true;
      eingabe.disabled = true;
      meldung.hidden = true;
      eingabe.removeAttribute('aria-invalid');
      try {
        await o.speichern(p.titel);
        beschaeftigt = false;
        ende('gespeichert');
      } catch (f) {
        beschaeftigt = false;
        if (fertig) return;
        eingabe.disabled = false;
        eingabe.setAttribute('aria-invalid', 'true');
        meldung.textContent = (f && f.message) || String(f);
        meldung.hidden = false;
        fehlerGezeigt = true;
        eingabe.focus();
        eingabe.select();
      }
    }
    eingabe.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        speichere();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (!beschaeftigt) ende('abgebrochen');
      } else {
        e.stopPropagation(); // Tasten im Namensfeld gehören dem Feld (nicht der Liste, nicht den Kurzbefehlen der Seite)
      }
    });
    eingabe.addEventListener('blur', () => {
      if (beschaeftigt || fertig || (o.ignoriereBlur && o.ignoriereBlur())) return;
      // nach einer Ablehnung schließt ein Klick daneben ohne erneuten Versuch; sonst wird nur eine echte Änderung gespeichert
      if (fehlerGezeigt || pruefen(eingabe.value).titel === String(o.wert || '').trim()) ende('abgebrochen');
      else speichere();
    });
    eingabe.focus();
    eingabe.select();
    return { schliesse: () => ende('abgebrochen'), eingabe, get offen() { return !fertig; } };
  }

  /**
   * refs: { liste, weitere, weitereKopf, weitereZahl, leer, archiv?, archivKopf?, archivZahl? }
   * opts: { beiWahl(id), beiUmbenennen(id, titel) → Promise, beiArchivieren(id, archiviert) → Promise }
   * Rückgabe: { zeichne(daten, aktivId), fokus(id), bearbeite(id), fehler(id, text), zeilen() }
   */
  function createLeiste(refs, opts) {
    opts = opts || {};
    const doc = refs.liste.ownerDocument;
    const knoten = new Map(); // String(id) → { huelle, knopf, z } (Liste und Hintergrund)
    const archivKnoten = new Map(); // dasselbe für das Archiv (eine Sitzung kann dort und in der Liste nicht zugleich stehen)
    const editoren = new Map(); // String(id) → Editor
    let aktivId = null;
    const pruefen = FP.sitzungen && FP.sitzungen.titelPruefen;

    function svg(pfad) {
      const ns = 'http://www.w3.org/2000/svg';
      const s = doc.createElementNS(ns, 'svg');
      s.setAttribute('viewBox', '0 0 16 16');
      s.setAttribute('aria-hidden', 'true');
      const p = doc.createElementNS(ns, 'path');
      p.setAttribute('d', pfad);
      s.appendChild(p);
      return s;
    }
    function aktionsKnopf(klasse, name, symbol) {
      const k = doc.createElement('button');
      k.type = 'button';
      k.className = `sitzung-aktion ${klasse}`;
      k.setAttribute('aria-label', name);
      k.title = name;
      if (symbol) k.appendChild(symbol);
      return k;
    }

    function zeileBauen(z, imArchiv) {
      const huelle = doc.createElement('div');
      huelle.className = 'sitzung-zeile';
      huelle.setAttribute('role', 'none');
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'sitzung';
      b.setAttribute('role', 'option');
      const punkt = doc.createElement('span');
      punkt.className = 'sitzung-punkt';
      punkt.setAttribute('aria-hidden', 'true');
      const text = doc.createElement('span');
      text.className = 'sitzung-text';
      const titel = doc.createElement('span');
      titel.className = 'sitzung-titel';
      const meta = doc.createElement('span');
      meta.className = 'sitzung-meta';
      text.append(titel, meta);
      const sr = doc.createElement('span');
      sr.className = 'sr';
      b.append(punkt, text, sr);
      const aktionen = doc.createElement('span');
      aktionen.className = 'sitzung-aktionen';
      const editor = doc.createElement('div');
      editor.className = 'sitzung-editor';
      editor.hidden = true;
      const fehler = doc.createElement('p');
      fehler.className = 'sitzung-fehler';
      fehler.setAttribute('role', 'alert');
      fehler.hidden = true;
      if (imArchiv) {
        b.disabled = true;
        const zurueck = doc.createElement('button');
        zurueck.type = 'button';
        zurueck.className = 'sitzung-aktion wiederherstellen';
        zurueck.textContent = 'Wiederherstellen';
        zurueck.addEventListener('click', () => aendern(z.id, 'wiederherstellen'));
        aktionen.appendChild(zurueck);
      } else {
        b.addEventListener('click', () => opts.beiWahl && opts.beiWahl(z.id));
        b.addEventListener('dblclick', (e) => {
          e.preventDefault();
          bearbeite(z.id);
        });
        const stift = aktionsKnopf('umbenennen', 'Sitzung umbenennen', svg('M10.5 2.5l3 3L6 13l-3.5.5L3 10z'));
        stift.addEventListener('click', () => bearbeite(z.id));
        const ablage = aktionsKnopf('archivieren', 'Sitzung archivieren', svg('M2.5 4h11v2.5h-11z M3.5 6.5v6.5h9V6.5 M6.5 9h3'));
        ablage.addEventListener('click', () => aendern(z.id, 'archivieren'));
        aktionen.append(stift, ablage);
      }
      huelle.append(b, aktionen, editor, fehler);
      return { huelle, knopf: b, z };
    }

    function fuelle(r, z, imArchiv) {
      const b = r.knopf;
      r.z = z;
      b.dataset.id = String(z.id);
      b.dataset.art = z.art;
      b.dataset.laeuft = z.laeuft ? '1' : '0';
      const titel = b.querySelector('.sitzung-titel');
      if (titel.textContent !== z.titel) titel.textContent = z.titel;
      const meta = [z.ordner || z.bereich, z.laeuft ? 'arbeitet' : z.zeitText].filter(Boolean).join(' · ');
      const m = b.querySelector('.sitzung-meta');
      if (m.textContent !== meta) m.textContent = meta;
      b.title = [z.titel, z.pfad || z.bereich].filter(Boolean).join('\n');
      const sr = b.querySelector('.sr');
      const srText = z.laeuft ? ', arbeitet gerade' : '';
      if (sr.textContent !== srText) sr.textContent = srText;
      const gewaehlt = !imArchiv && String(z.id) === String(aktivId);
      b.setAttribute('aria-selected', gewaehlt ? 'true' : 'false');
      b.tabIndex = gewaehlt ? 0 : -1;
      b.classList.toggle('aktiv', gewaehlt);
      const stift = r.huelle.querySelector('.umbenennen');
      if (stift) stift.setAttribute('aria-label', `Sitzung „${z.titel}“ umbenennen`);
      const ablage = r.huelle.querySelector('.archivieren');
      if (ablage) {
        ablage.setAttribute('aria-label', `Sitzung „${z.titel}“ archivieren`);
        ablage.hidden = z.art !== 'mensch' && z.art !== 'zweig'; // die Hauptsitzung und Hintergrundarbeit bleiben
      }
      const zurueck = r.huelle.querySelector('.wiederherstellen');
      if (zurueck) zurueck.setAttribute('aria-label', `Sitzung „${z.titel}“ wiederherstellen`);
    }

    /** Die Zeilen eines Behälters der Liste anpassen: vorhandene behalten, fehlende bauen, übrige entfernen, Reihenfolge herstellen. */
    function abgleichen(behaelter, zeilen, karte, imArchiv) {
      const soll = new Set(zeilen.map((z) => String(z.id)));
      for (const [id, r] of [...karte]) {
        if (r.huelle.parentNode === behaelter && !soll.has(id)) {
          const e = editoren.get(id);
          if (e && !imArchiv) e.schliesse();
          r.huelle.remove();
          karte.delete(id);
        }
      }
      let vorher = null;
      for (const z of zeilen) {
        const id = String(z.id);
        let r = karte.get(id);
        if (!r) {
          r = zeileBauen(z, imArchiv);
          karte.set(id, r);
        }
        fuelle(r, z, imArchiv);
        const sollNach = vorher ? vorher.nextSibling : behaelter.firstChild;
        if (r.huelle !== sollNach) behaelter.insertBefore(r.huelle, sollNach);
        vorher = r.huelle;
      }
    }

    let zeichnet = false;
    function zeichne(daten, aktiv) {
      aktivId = aktiv;
      const fokusId = doc.activeElement && doc.activeElement.classList && doc.activeElement.classList.contains('sitzung') ? doc.activeElement.dataset.id : null;
      // Wird beim Umsortieren eine Zeile mit offenem Namensfeld verschoben, verliert das Feld den Fokus: danach zurückgeben (mit Auswahl), ohne dass das als „Klick daneben“ zählt
      const feldAktiv = doc.activeElement && doc.activeElement.classList && doc.activeElement.classList.contains('titel-eingabe') && refs.liste.parentNode.contains(doc.activeElement) ? doc.activeElement : null;
      const auswahl = feldAktiv ? [feldAktiv.selectionStart, feldAktiv.selectionEnd] : null;
      zeichnet = true;
      abgleichen(refs.liste, daten.sitzungen || [], knoten, false);
      abgleichen(refs.weitere, daten.weitere || [], knoten, false);
      zeichnet = false;
      if (feldAktiv && feldAktiv.isConnected && doc.activeElement !== feldAktiv) {
        feldAktiv.focus();
        try {
          feldAktiv.setSelectionRange(auswahl[0], auswahl[1]);
        } catch (e) {
          /* ohne Auswahl geht es weiter */
        }
      }
      if (refs.archiv) {
        abgleichen(refs.archiv, daten.archiv || [], archivKnoten, true);
        if (refs.archivKopf) refs.archivKopf.hidden = !(daten.archiv || []).length;
        if (refs.archivZahl) refs.archivZahl.textContent = String((daten.archiv || []).length);
        if (!(daten.archiv || []).length) refs.archiv.hidden = true;
      }
      refs.leer.hidden = (daten.sitzungen || []).length > 0;
      refs.weitereKopf.hidden = !(daten.weitere || []).length;
      refs.weitereZahl.textContent = String((daten.weitere || []).length);
      // Falls die gewählte Sitzung nicht in der Liste steht (z. B. gerade erst angelegt), bleibt ein Tabulatorstopp auf der ersten Zeile
      if (![...knoten.values()].some((r) => r.knopf.tabIndex === 0)) {
        const erste = refs.liste.querySelector('.sitzung');
        if (erste) erste.tabIndex = 0;
      }
      const fokusZeile = fokusId && knoten.get(fokusId);
      if (fokusZeile && doc.activeElement !== fokusZeile.knopf) fokusZeile.knopf.focus();
    }

    // --- Umbenennen, Archivieren ---
    function meldeAnZeile(id, text) {
      const r = knoten.get(String(id)) || archivKnoten.get(String(id));
      if (!r) return;
      const f = r.huelle.querySelector('.sitzung-fehler');
      f.textContent = text || '';
      f.hidden = !text;
      if (r.fehlerUhr) clearTimeout(r.fehlerUhr);
      if (text) r.fehlerUhr = setTimeout(() => meldeAnZeile(id, ''), 8000);
    }

    function bearbeite(id) {
      const schluessel = String(id);
      const r = knoten.get(schluessel);
      if (!r || !opts.beiUmbenennen || editoren.has(schluessel)) return;
      meldeAnZeile(id, '');
      const editorBox = r.huelle.querySelector('.sitzung-editor');
      r.huelle.classList.add('bearbeitet');
      editorBox.hidden = false;
      const roh = r.z.titel === 'Ohne Titel' ? '' : r.z.titel;
      const e = createTitelEditor(editorBox, {
        wert: roh,
        label: `Neuer Name für „${r.z.titel}“`,
        pruefen,
        ignoriereBlur: () => zeichnet,
        speichern: (titel) => opts.beiUmbenennen(id, titel),
        beiEnde: (grund) => {
          editoren.delete(schluessel);
          r.huelle.classList.remove('bearbeitet');
          editorBox.hidden = true;
          // Fokus zurück auf die Zeile, wenn er mit dem Feld verschwunden ist (Enter, Esc); nach einem Klick woanders bleibt er dort
          const aktuell = knoten.get(schluessel);
          if (aktuell && (!doc.activeElement || doc.activeElement === doc.body)) aktuell.knopf.focus();
        },
      });
      editoren.set(schluessel, e);
      return e;
    }

    async function aendern(id, was) {
      if (!opts.beiArchivieren) return;
      meldeAnZeile(id, '');
      const r = knoten.get(String(id)) || archivKnoten.get(String(id));
      const knoepfe = r ? [...r.huelle.querySelectorAll('.sitzung-aktion')] : [];
      knoepfe.forEach((k) => (k.disabled = true));
      try {
        await opts.beiArchivieren(id, was === 'archivieren');
      } catch (f) {
        meldeAnZeile(id, (f && f.message) || String(f));
      } finally {
        knoepfe.forEach((k) => (k.disabled = false));
      }
    }

    function sichtbar() {
      return [...refs.liste.querySelectorAll('.sitzung'), ...(refs.weitere.hidden ? [] : refs.weitere.querySelectorAll('.sitzung'))];
    }
    function taste(e) {
      const ziele = sichtbar();
      const i = ziele.indexOf(doc.activeElement);
      if (i < 0) return;
      if (e.key === 'F2') {
        e.preventDefault();
        bearbeite(ziele[i].dataset.id);
        return;
      }
      let n = -1;
      if (e.key === 'ArrowDown') n = Math.min(ziele.length - 1, i + 1);
      else if (e.key === 'ArrowUp') n = Math.max(0, i - 1);
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = ziele.length - 1;
      if (n < 0) return;
      e.preventDefault();
      ziele[n].focus();
    }
    refs.liste.addEventListener('keydown', taste);
    refs.weitere.addEventListener('keydown', taste);

    // Abschnitte „Hintergrund“ und „Archiv“ ein- und ausklappen
    function klappe(kopf, liste) {
      if (!kopf || !liste) return;
      kopf.addEventListener('click', () => {
        const auf = liste.hidden;
        liste.hidden = !auf;
        kopf.setAttribute('aria-expanded', auf ? 'true' : 'false');
      });
    }
    klappe(refs.weitereKopf, refs.weitere);
    klappe(refs.archivKopf, refs.archiv);

    return {
      zeichne,
      fokus(id) {
        const r = knoten.get(String(id));
        if (r) r.knopf.focus();
      },
      bearbeite,
      fehler: meldeAnZeile,
      zeilen: () => [...knoten.values()].map((r) => r.knopf),
    };
  }

  FP.createTitelEditor = createTitelEditor;
  FP.createLeiste = createLeiste;
})(typeof globalThis !== 'undefined' ? globalThis : window);
