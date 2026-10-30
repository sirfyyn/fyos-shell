/* Suche über die Sitzungen (Seitenleiste): ein Feld oben, die Trefferliste ersetzt die Sitzungsliste, solange das Feld Text hat.
 *
 * Ablauf: Tippen → 250 ms Pause → mindestens 2 Zeichen → opts.wege.suche(text) (GET /api/suche, siehe runner-wege.js). Jede Eingabe entwertet die vorige
 * Anfrage: nur die Antwort der letzten zählt (kein Flackern, keine veralteten Treffer). Bis die neue Antwort da ist, bleibt die alte Liste stehen.
 * Fehler stehen kurz unter dem Feld und lösen nichts von selbst aus (kein erneutes Versuchen); kennt der Runner die Suche nicht (404), verschwindet das Feld.
 * Alle Texte (Titel, Ausschnitt) kommen vom Runner und werden NUR über textContent eingesetzt; die Treffer im Ausschnitt sind Offsets (start/laenge), kein HTML.
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  /** Text in `el` einsetzen, die Markierungen (Offsets in UTF-16-Einheiten, aufsteigend, ohne Überlappung) als <mark> mit textContent. */
  function hebeHervor(el, text, markierungen) {
    const doc = el.ownerDocument;
    el.textContent = '';
    let pos = 0;
    for (const m of markierungen || []) {
      if (m.start > pos) el.appendChild(doc.createTextNode(text.slice(pos, m.start)));
      const k = doc.createElement('mark');
      k.textContent = text.slice(m.start, m.start + m.laenge);
      el.appendChild(k);
      pos = m.start + m.laenge;
    }
    if (pos < text.length) el.appendChild(doc.createTextNode(text.slice(pos)));
  }

  const FEHLER_TEXT = {
    zu_viele: 'Es laufen gerade zu viele Suchen. Bitte einen Moment warten und weitertippen.',
    ungueltig: 'Diese Eingabe lässt sich nicht suchen.',
    netz: 'Der Runner ist nicht erreichbar. Die Suche versucht es beim nächsten Tippen wieder.',
    zugang: 'Der Runner hat die Anmeldung abgelehnt (Token in den Einstellungen prüfen).',
  };

  /**
   * refs: { kasten, feld, meldung, ergebnis, behaelter } (behaelter: die Liste, die beim Suchen verschwindet; bekommt die Klasse "suche-aktiv")
   * opts: { wege: { suche(text, { limit, archiv }) }, beiWahl(treffer), beiEsc(), verzoegerung (250), mindest (2), jetzt() }
   */
  function createSuche(refs, opts) {
    opts = opts || {};
    const doc = refs.feld.ownerDocument;
    const verzoegerung = opts.verzoegerung === undefined ? 250 : opts.verzoegerung;
    const mindest = opts.mindest || 2;
    const jetzt = opts.jetzt || (() => Date.now());
    let nr = 0; // zählt jede Eingabe; eine Antwort zählt nur, wenn ihre Nummer noch die letzte ist
    let uhr = null;
    let treffer = [];
    let signatur = '';
    let verfuegbar = true;

    function meldung(text) {
      refs.meldung.textContent = text || '';
      refs.meldung.hidden = !text;
    }
    function aktiv(an) {
      refs.behaelter.classList.toggle('suche-aktiv', an);
      refs.ergebnis.hidden = !an;
      refs.feld.setAttribute('aria-expanded', an ? 'true' : 'false');
    }
    function leerAnzeigen(text, klasse) {
      refs.ergebnis.replaceChildren();
      const p = doc.createElement('p');
      p.className = `leise suche-leer ${klasse || ''}`.trim();
      p.textContent = text;
      refs.ergebnis.appendChild(p);
      signatur = '';
      treffer = [];
    }

    function zeile(t) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'suche-treffer';
      b.setAttribute('role', 'option');
      b.dataset.id = String(t.id);
      b.dataset.archiviert = t.archiviert ? '1' : '0';
      const kopf = doc.createElement('span');
      kopf.className = 'suche-kopf';
      const titel = doc.createElement('span');
      titel.className = 'suche-titel';
      if (t.quelle === 'titel') hebeHervor(titel, t.ausschnitt || t.titel, t.markierungen);
      else titel.textContent = t.titel;
      kopf.appendChild(titel);
      if (t.archiviert) {
        const chip = doc.createElement('span');
        chip.className = 'chip suche-archiv';
        chip.textContent = 'archiviert';
        kopf.appendChild(chip);
      }
      b.appendChild(kopf);
      if (t.quelle !== 'titel' && t.ausschnitt) {
        const a = doc.createElement('span');
        a.className = 'suche-ausschnitt';
        hebeHervor(a, t.ausschnitt, t.markierungen);
        b.appendChild(a);
      }
      const meta = doc.createElement('span');
      meta.className = 'suche-meta';
      const rel = FP.sitzungen && FP.sitzungen.relativ ? FP.sitzungen.relativ(t.aktualisiert, jetzt()) : '';
      meta.textContent = [rel, t.zahl > 0 ? (t.zahl === 1 ? '1 Fundstelle' : `${t.zahl} Fundstellen`) : ''].filter(Boolean).join(' · ');
      b.appendChild(meta);
      b.addEventListener('click', () => {
        refs.ergebnis.querySelectorAll('.suche-treffer').forEach((x) => x.removeAttribute('aria-current'));
        b.setAttribute('aria-current', 'true');
        if (opts.beiWahl) opts.beiWahl(t);
      });
      return b;
    }

    function zeichne(r) {
      const sig = JSON.stringify([r.treffer, r.abgeschnitten]);
      if (sig === signatur) return;
      signatur = sig;
      treffer = r.treffer;
      refs.ergebnis.replaceChildren();
      if (!r.treffer.length) {
        const p = doc.createElement('p');
        p.className = 'leise suche-leer';
        p.textContent = 'Keine Treffer.';
        refs.ergebnis.appendChild(p);
      } else {
        for (const t of r.treffer) refs.ergebnis.appendChild(zeile(t));
      }
      if (r.abgeschnitten) {
        const p = doc.createElement('p');
        p.className = 'leise suche-leer suche-grenze';
        p.textContent = 'Die Suche war begrenzt; ältere Stellen langer Sitzungen werden vielleicht nicht gefunden.';
        refs.ergebnis.appendChild(p);
      }
    }

    async function starte(text, mein) {
      let r;
      try {
        r = await opts.wege.suche(text, { limit: 20, archiv: 'alle' });
      } catch (f) {
        if (mein !== nr) return;
        if (f && f.art === 'weg_fehlt') {
          // älterer Runner ohne Suche: das Feld verschwindet, die Liste kommt zurück
          verfuegbar = false;
          refs.feld.value = '';
          refs.kasten.hidden = true;
          aktiv(false);
          meldung('');
          return;
        }
        refs.ergebnis.replaceChildren();
        signatur = '';
        treffer = [];
        meldung(FEHLER_TEXT[f && f.art] || `Die Suche ist nicht möglich: ${(f && f.message) || f}`);
        return;
      }
      if (mein !== nr) return; // inzwischen wurde weitergetippt: diese Antwort ist veraltet
      meldung('');
      zeichne(r);
    }

    function eingabe() {
      if (uhr) clearTimeout(uhr);
      uhr = null;
      const mein = ++nr;
      const text = refs.feld.value.trim();
      meldung('');
      if (!text) {
        aktiv(false);
        refs.ergebnis.replaceChildren();
        signatur = '';
        treffer = [];
        return;
      }
      aktiv(true);
      if (text.length < mindest) {
        leerAnzeigen(`Mindestens ${mindest} Zeichen eingeben.`);
        return;
      }
      uhr = setTimeout(() => {
        uhr = null;
        starte(text, mein);
      }, verzoegerung);
    }

    function leeren() {
      refs.feld.value = '';
      eingabe();
    }

    refs.feld.addEventListener('input', eingabe);
    refs.feld.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (refs.feld.value) leeren();
        else {
          refs.feld.blur();
          if (opts.beiEsc) opts.beiEsc();
        }
      } else if (e.key === 'ArrowDown') {
        const erste = refs.ergebnis.querySelector('.suche-treffer');
        if (erste) {
          e.preventDefault();
          erste.focus();
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const erste = refs.ergebnis.querySelector('.suche-treffer');
        if (erste) erste.click();
      }
      if (!e.metaKey && !e.ctrlKey) e.stopPropagation(); // einfache Tasten im Suchfeld gehören dem Feld (nicht den Kürzeln der Seite); Cmd/Strg+Taste bleibt der Seite
    });
    refs.ergebnis.addEventListener('keydown', (e) => {
      const alle = [...refs.ergebnis.querySelectorAll('.suche-treffer')];
      const i = alle.indexOf(doc.activeElement);
      if (i < 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (alle[i + 1]) alle[i + 1].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        (alle[i - 1] || refs.feld).focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        leeren();
        refs.feld.focus();
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        alle[e.key === 'Home' ? 0 : alle.length - 1].focus();
      }
      if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
    });

    return {
      leeren,
      /** Fokus ins Feld (Kürzel Cmd+K oder /). false, wenn es die Suche nicht gibt. */
      fokussiere() {
        if (!verfuegbar) return false;
        refs.feld.focus();
        refs.feld.select();
        return true;
      },
      get verfuegbar() {
        return verfuegbar;
      },
      get treffer() {
        return treffer;
      },
    };
  }

  FP.hebeHervor = hebeHervor;
  FP.createSuche = createSuche;
})(typeof globalThis !== 'undefined' ? globalThis : window);
