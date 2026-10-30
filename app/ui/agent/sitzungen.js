/* Sitzungsliste (reine Logik, ohne DOM): aus der Gesprächsliste des Runners (GET /api/gespraeche), seiner Konfiguration
 * (GET /api/konfiguration, Feld arbeitsbereiche) und dem Aktivitätsstrom (GET /api/strom, Zeilen je Gespräch) die Zeilen der Seitenleiste bauen.
 * Der Runner liefert kein Feld "läuft": die Anzeige leitet es aus dem Strom ab (Zeile ohne anschließendes "fertig"/"fehler") und aus dem
 * geöffneten Gespräch selbst (genau).
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  /** Wie lange ein Gespräch nach der letzten Zeile ohne "fertig" noch als laufend gilt (ein Zug ohne Meldung wird nicht ewig angezeigt). */
  const LAUF_FRIST_MS = 10 * 60 * 1000;
  /** Hauptliste: Gespräche von Menschen; alles andere (Läufe, Sprache, Maschinen) steht eingeklappt darunter oder gar nicht. */
  const HAUPT_ARTEN = new Set(['root', 'mensch', 'zweig']);
  const VERSTECKT = new Set(['sprache']);

  /** Merkt je Gespräch die letzte Aktivität aus den Zeilen des Aktivitätsstroms. */
  function createAktivitaet(jetzt) {
    jetzt = jetzt || (() => Date.now());
    const karte = new Map(); // id → { t, laeuft }
    return {
      /** Eine Zeile des Stroms: { gespraech, t, typ }. "fertig"/"fehler" beenden den Lauf, jede andere Zeile hält ihn am Leben. */
      zeile(z) {
        if (!z || z.gespraech === undefined || z.gespraech === null) return false;
        const id = String(z.gespraech);
        const typ = String(z.typ || '');
        const t = Number.isFinite(z.t) ? z.t : jetzt();
        const alt = karte.get(id);
        const laeuft = typ !== 'fertig' && typ !== 'fehler' && typ !== 'freigabe' ? true : typ === 'freigabe' ? !!(alt && alt.laeuft) : false;
        karte.set(id, { t, laeuft });
        return !alt || alt.laeuft !== laeuft;
      },
      laeuft(id) {
        const a = karte.get(String(id));
        return !!(a && a.laeuft && jetzt() - a.t < LAUF_FRIST_MS);
      },
      zuletzt(id) {
        const a = karte.get(String(id));
        return a ? a.t : 0;
      },
      loesche() {
        karte.clear();
      },
    };
  }

  function relativ(t, jetzt) {
    if (!Number.isFinite(t) || t <= 0) return '';
    const s = Math.max(0, Math.round((jetzt - t) / 1000));
    if (s < 45) return 'gerade eben';
    const min = Math.round(s / 60);
    if (min < 60) return `vor ${min} Min.`;
    const h = Math.round(min / 60);
    if (h < 24) return `vor ${h} Std.`;
    const d = Math.round(h / 24);
    if (d === 1) return 'gestern';
    if (d < 14) return `vor ${d} Tagen`;
    return new Date(t).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
  }

  function letzterOrdner(pfad) {
    const t = String(pfad || '').replace(/[\\/]+$/, '');
    const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
    return i >= 0 ? t.slice(i + 1) || t : t;
  }

  /**
   * Zeilen der Seitenleiste. Eingabe: gespraeche (Liste des Runners), bereiche ({ name: { titel, pfad } }), aktiv (createAktivitaet),
   * o: { jetzt, offeneIds (Set der ID mit sicher laufendem Zug), auswahlId }.
   * Ausgabe: { sitzungen: [...], weitere: [...], archiv: [...] }, neueste Aktivität oben; Zeile: { id, titel, art, zeit, zeitText, bereich, ordner, pfad, laeuft, archiviert }.
   * o.archivLokal: Archivierte, die nicht in `gespraeche` stehen: die Liste des Runners mit ?archiv=1 und/oder, was dieses Fenster archiviert hat (ältere Runner
   *   nennen archivierte Sitzungen sonst nirgends); sie stehen im Archiv und erlauben „Wiederherstellen“. o.archivImmer: der Runner kennt die Archivliste.
   */
  function sitzungsListe(gespraeche, bereiche, aktiv, o) {
    o = o || {};
    const jetzt = o.jetzt || Date.now();
    const sicher = o.laufend || new Set();
    // Archivierte: was die Liste des Runners trägt (heute lässt GET /api/gespraeche sie weg) und was dieses Fenster selbst archiviert hat (o.archivLokal)
    const lokal = (Array.isArray(o.archivLokal) ? o.archivLokal : []).map((g) => ({ ...g, archiviert: true }));
    const lokaleIds = new Set(lokal.map((g) => String(g && g.id)));
    const alle = (Array.isArray(gespraeche) ? gespraeche : []).filter((g) => !(g && lokaleIds.has(String(g.id)))).concat(lokal);
    const zeilen = alle
      .filter((g) => g && g.id !== undefined && !VERSTECKT.has(g.art))
      .map((g) => {
        const b = (bereiche && bereiche[g.arbeitsbereich]) || null;
        const zeit = Math.max(Number(g.erstellt) || 0, aktiv ? aktiv.zuletzt(g.id) : 0);
        // Der gewählte Ordner steht in der Liste unter agent.cwd (Runner mit „Ordner je Sitzung“); sonst gilt der Arbeitsbereich
        const cwd = g.agent && typeof g.agent.cwd === 'string' ? g.agent.cwd : '';
        return {
          id: g.id,
          titel: String(g.titel || '').trim() || 'Ohne Titel',
          art: g.art || 'mensch',
          zeit,
          zeitText: relativ(zeit, jetzt),
          bereich: b ? b.titel || g.arbeitsbereich : g.arbeitsbereich || '',
          ordner: cwd ? letzterOrdner(cwd) : b && b.pfad ? letzterOrdner(b.pfad) : '',
          pfad: cwd || (b && b.pfad ? b.pfad : ''),
          laeuft: sicher.has(String(g.id)) || !!(aktiv && aktiv.laeuft(g.id)),
          archiviert: !!g.archiviert,
        };
      })
      .sort((a, b) => b.zeit - a.zeit);
    const offen = zeilen.filter((z) => !z.archiviert);
    return {
      sitzungen: offen.filter((z) => HAUPT_ARTEN.has(z.art)),
      weitere: offen.filter((z) => !HAUPT_ARTEN.has(z.art)),
      archiv: zeilen.filter((z) => z.archiviert && HAUPT_ARTEN.has(z.art)),
      // true, wenn der Runner die Archivliste kennt (GET /api/gespraeche?archiv=1): der Abschnitt „Archiv“ steht dann auch ohne Einträge da
      archivImmer: !!o.archivImmer,
    };
  }

  /** Nächste/vorige Sitzung in der sichtbaren Reihenfolge (rundum). */
  function nachbar(ids, aktuell, richtung) {
    if (!ids.length) return null;
    const i = ids.findIndex((x) => String(x) === String(aktuell));
    if (i < 0) return ids[0];
    return ids[(i + (richtung < 0 ? ids.length - 1 : 1)) % ids.length];
  }

  /** Ordnername für die Kopfzeile: aus dem Arbeitsordner der Sitzung (GET /api/gespraech/:id → agent.cwd), sonst aus dem Arbeitsbereich. */
  function ordnerAnzeige(cwd, bereich) {
    const pfad = cwd || (bereich && bereich.pfad) || '';
    return { name: letzterOrdner(pfad) || (bereich && bereich.titel) || '', pfad };
  }

  // --- Benennen, Umbenennen, Archivieren (PATCH /api/gespraech/:id; der Körper trägt nur `titel` und `archiviert`) ---
  /** Längster Name, den der Runner annimmt (POST /api/gespraeche und PATCH schneiden bei 120 Zeichen ab). */
  const TITEL_MAX = 120;

  /** Name prüfen: getrimmt, nicht leer, höchstens TITEL_MAX Zeichen. → { ok, titel } oder { ok: false, fehler }. */
  function titelPruefen(roh) {
    const titel = String(roh === undefined || roh === null ? '' : roh).trim();
    if (!titel) return { ok: false, fehler: 'Der Name darf nicht leer sein.' };
    if (titel.length > TITEL_MAX) return { ok: false, fehler: `Der Name ist zu lang (höchstens ${TITEL_MAX} Zeichen).` };
    return { ok: true, titel };
  }

  /** Der Körper einer Änderung: nur `titel` (Text) und `archiviert` (Wahrheitswert) gehen zum Runner, alles andere fällt weg. */
  function aenderungsKoerper(felder) {
    const k = {};
    if (felder && typeof felder.titel === 'string') k.titel = felder.titel;
    if (felder && typeof felder.archiviert === 'boolean') k.archiviert = felder.archiviert;
    return k;
  }

  /** Der Name in der Antwort des Runners (PATCH und POST liefern { gespraech: { id, meta: { titel } } }); sonst null. */
  function titelAusAntwort(r) {
    const g = r && (r.gespraech || r);
    const t = g && ((g.meta && g.meta.titel) || g.titel);
    return typeof t === 'string' && t.trim() ? t.trim() : null;
  }

  /**
   * Änderungen an einer Sitzung über die Brücke (transport.api → runner_anfrage). Fehler des Runners kommen als Error mit Klartext durch.
   * umbenennen(id, text) → { titel } (der Name, den der Runner gespeichert hat); archivieren(id, an) → { archiviert }.
   */
  function createAenderung(transport) {
    const weg = (id) => `/api/gespraech/${encodeURIComponent(id)}`;
    function melde(f, vorn) {
      let text = (f && (f.message || f.ursache)) || String(f || 'unbekannter Fehler');
      // Die Brücke legt den Text des Runners in details („HTTP 500: Gespräch nicht gefunden“): mitzeigen
      const d = f && f.meldung && typeof f.meldung.details === 'string' ? f.meldung.details.trim() : '';
      if (d && !text.includes(d)) text += ` (${d})`;
      return Object.assign(new Error(`${vorn} ${text}`), { code: f && f.code });
    }
    return {
      async umbenennen(id, text) {
        const p = titelPruefen(text);
        if (!p.ok) throw new Error(p.fehler);
        let r;
        try {
          r = await transport.api('PATCH', weg(id), aenderungsKoerper({ titel: p.titel }));
        } catch (f) {
          throw melde(f, 'Nicht umbenannt:');
        }
        return { titel: titelAusAntwort(r) || p.titel };
      },
      async archivieren(id, an) {
        try {
          await transport.api('PATCH', weg(id), aenderungsKoerper({ archiviert: !!an }));
        } catch (f) {
          throw melde(f, an ? 'Nicht archiviert:' : 'Nicht wiederhergestellt:');
        }
        return { archiviert: !!an };
      },
      /** Modell der Sitzung wechseln (Wähler im Fuß des Eingabefelds): PATCH mit genau einem Feld `modell` (Kennung aus GET /api/modelle, null = Standard des Runners). */
      async modell(id, modellId) {
        if (modellId !== null && (typeof modellId !== 'string' || !modellId)) throw new Error('Nicht gewechselt: Kein Modell gewählt.');
        let r;
        try {
          r = await transport.api('PATCH', weg(id), { modell: modellId });
        } catch (f) {
          throw melde(f, 'Modell nicht gewechselt:');
        }
        return { gespraech: (r && r.gespraech) || null };
      },
    };
  }

  FP.sitzungen = { createAktivitaet, sitzungsListe, nachbar, ordnerAnzeige, relativ, letzterOrdner, LAUF_FRIST_MS, TITEL_MAX, titelPruefen, aenderungsKoerper, titelAusAntwort, createAenderung };
})(typeof globalThis !== 'undefined' ? globalThis : window);
