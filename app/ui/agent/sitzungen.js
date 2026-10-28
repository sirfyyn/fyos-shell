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
   * Ausgabe: { sitzungen: [...], weitere: [...] }, neueste Aktivität oben; Zeile: { id, titel, art, zeit, zeitText, bereich, ordner, pfad, laeuft }.
   */
  function sitzungsListe(gespraeche, bereiche, aktiv, o) {
    o = o || {};
    const jetzt = o.jetzt || Date.now();
    const sicher = o.laufend || new Set();
    const zeilen = (Array.isArray(gespraeche) ? gespraeche : [])
      .filter((g) => g && g.id !== undefined && !g.archiviert && !VERSTECKT.has(g.art))
      .map((g) => {
        const b = (bereiche && bereiche[g.arbeitsbereich]) || null;
        const zeit = Math.max(Number(g.erstellt) || 0, aktiv ? aktiv.zuletzt(g.id) : 0);
        return {
          id: g.id,
          titel: String(g.titel || '').trim() || 'Ohne Titel',
          art: g.art || 'mensch',
          zeit,
          zeitText: relativ(zeit, jetzt),
          bereich: b ? b.titel || g.arbeitsbereich : g.arbeitsbereich || '',
          ordner: b && b.pfad ? letzterOrdner(b.pfad) : '',
          pfad: b && b.pfad ? b.pfad : '',
          laeuft: sicher.has(String(g.id)) || !!(aktiv && aktiv.laeuft(g.id)),
        };
      })
      .sort((a, b) => b.zeit - a.zeit);
    return {
      sitzungen: zeilen.filter((z) => HAUPT_ARTEN.has(z.art)),
      weitere: zeilen.filter((z) => !HAUPT_ARTEN.has(z.art)),
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

  FP.sitzungen = { createAktivitaet, sitzungsListe, nachbar, ordnerAnzeige, relativ, letzterOrdner, LAUF_FRIST_MS };
})(typeof globalThis !== 'undefined' ? globalThis : window);
