/* Arbeitsplatz (chat.html): Seitenleiste mit Sitzungen, je geöffneter Sitzung eine eigene Chat-Ansicht (bleibt beim Wechsel im Dokument),
 * Eingabe, Statuszeile und Menüs. Im Tauri-Fenster über die Brücke (runner_anfrage, strom_oeffnen, Ereignis runner-strom); sonst (Prüfstand,
 * Browser) per HTTP am selben Ursprung, wo ein Proxy den Zugangsschlüssel anhängt.
 *
 * Sitzungswechsel: die Ansicht der Sitzung wird beim ersten Öffnen gebaut und danach nur noch ein- und ausgeblendet. Der Ereignisstrom gehört
 * immer der sichtbaren Sitzung (ein Kanal der Brücke); beim Zurückkehren schickt der Runner einen Snapshot, der Adapter hängt nur an, was fehlt.
 */
(function () {
  'use strict';
  const FP = window.FyosPrototyp;
  const $ = (id) => document.getElementById(id);
  const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const eingabe = $('eingabe');
  const menue = $('menue');
  const MAX_ANSICHTEN = 8; // so viele Sitzungen bleiben aufgebaut; die am längsten nicht benutzte wird abgebaut (ihr Verlauf kommt beim Öffnen vom Runner zurück)
  const MERKE = 'fyos-agent-sitzung';

  const transport = window.__TAURI__ ? FP.tauriTransport(window.__TAURI__) : FP.httpTransport('');
  const tauriInvoke = window.__TAURI__ ? (b, a) => window.__TAURI__.core.invoke(b, a || {}) : null;
  // Rust meldet Fehler als Katalogmeldung { code, ursache, abhilfe }: für die Anzeige ein Error mit beidem im Text
  const alsFehler = (m) => (m && m.ursache ? Object.assign(new Error(`${m.ursache} ${m.abhilfe || ''}`.trim()), { code: m.code }) : m);
  let runnerArt = 'entfernt';
  // Modus: Freigabe (Anzeige des Runner-Zustands) und die Art der Nachricht, während der Agent arbeitet (je Sitzung in diesem Fenster)
  const modus = FP.startModus($('modus'), $('modusMenue'), {
    beiSendeArt: (art) => {
      if (!aktiv) return;
      aktiv.sendeArt = art === 'steuern' ? 'steuern' : 'folgen';
      zeigeAktiv();
    },
    // Modus der Sitzung (planen, fragen, frei, umgehen), wenn der Runner ihn kennt
    beiModus: (wert) => wechsleModus(wert),
  });
  const aktivitaet = FP.sitzungen.createAktivitaet();

  let startFehler = '';
  let gespraeche = [];
  let bereiche = {};
  let modelle = [];
  const ansichten = new Map(); // String(id) → { id, chat, pane, benutzt, entwurf, anhaenge, sendeArt, wechselt, cwd }
  let aktiv = null;
  let wechselKette = Promise.resolve();
  let stromBesitzer = null; // Id der Sitzung, deren Ereignisstrom offen ist

  // --- Merken (nur Annehmlichkeit, fehlt es, geht alles weiter) ---
  const merken = {
    lies() {
      try {
        return window.localStorage.getItem(MERKE);
      } catch (e) {
        return null;
      }
    },
    schreibe(id) {
      try {
        window.localStorage.setItem(MERKE, String(id));
      } catch (e) {
        /* ohne Speicher geht es weiter */
      }
    },
  };

  // --- Kopf und Statuszeile (zeigen immer die sichtbare Sitzung) ---
  let gemeldet = '';
  function meldeZustand(art, arbeitet) {
    const schluessel = `${art}|${arbeitet ? 1 : 0}`;
    if (!window.__TAURI__ || schluessel === gemeldet) return;
    gemeldet = schluessel;
    window.__TAURI__.core.invoke('zustand_melden', { art, arbeitet: !!arbeitet }).catch(() => {});
  }
  const zahl = (n) => FP.zahlK(Math.round(n));
  function zeige(s) {
    const art = s.wartet ? 'wartet' : s.pausiert ? 'pausiert' : s.busy ? 'arbeitet' : 'bereit';
    $('zustand').className = `zustand ${art === 'pausiert' ? 'bereit' : art}`;
    $('zustandText').textContent = s.trennung ? 'getrennt' : s.wartet ? 'wartet auf dich' : s.pausiert ? 'pausiert' : s.busy ? 'arbeitet' : 'bereit';
    $('titel').textContent = s.titel || FP.anzeigename || 'Agent';
    $('verbindung').textContent = s.trennung ? 'getrennt' : s.verbunden ? 'verbunden' : 'verbinde …';
    const b = $('banner');
    const grund = s.trennung && s.trennung.fehler ? ` (${s.trennung.fehler})` : '';
    const text = startFehler ? `Kein Runner erreichbar: ${startFehler}` : s.trennung ? `Verbindung zum Runner getrennt${grund}, neuer Versuch in ${Math.max(0, Math.round((s.trennung.bis - Date.now()) / 1000))} s. Der Verlauf kommt danach vollständig zurück.` : s.stille ? s.stille.text : '';
    meldeZustand(art, s.busy);
    b.hidden = !text;
    b.textContent = text;
    $('stopp').hidden = !s.busy;
    $('senden').textContent = s.busy ? 'Einreihen' : 'Senden';
    // Ein Hauptknopf zur Zeit: arbeitet der Agent („Einreihen“) oder liegt eine Karte zur Entscheidung vor, ist dieser Knopf ruhig
    $('senden').dataset.art = s.busy ? 'einreihen' : s.wartet ? 'wartet' : 'senden';
    // Anzeigename aus der Modellliste des Runners (GET /api/modelle), sonst, was die Sitzung meldet
    const modellEintrag = aktiv ? FP.wege.modellEintrag(modelle, aktiv.chat.modellRoh() || s.modell) : null;
    $('modell').textContent = aktiv && aktiv.wechselt ? 'wechsle …' : (modellEintrag && (modellEintrag.name || modellEintrag.id)) || s.modell || '–';
    zeichneModellWahl();
    const m = $('kontext');
    // Nur ein plausibler Wert (bekannt, höchstens so groß wie das Fenster) wird gezeigt, sonst „–“ (FP.kontextAnzeige)
    const k = FP.kontextAnzeige(s.ctx, s.fenster);
    m.style.setProperty('--fuell', String(k.anteil));
    m.setAttribute('aria-valuenow', String(k.prozent));
    m.dataset.stufe = k.stufe;
    m.dataset.bekannt = k.bekannt ? '1' : '0';
    $('kontextText').textContent = k.text;
    $('kontextTitel').textContent = k.bekannt ? k.titel : '';
    m.title = k.titel;
    // Summe der ganzen Sitzung (jeder Modellaufruf zählt seinen Prompt erneut, Cache-Lesen inklusive): nicht der Kontext
    $('tokens').textContent = s.tokIn != null || s.tokOut != null ? `gesamt ${zahl(s.tokIn || 0)} ein · ${zahl(s.tokOut || 0)} aus` : '';
    $('tokens').title = 'Summe der ganzen Sitzung: gesendete Token (mit Cache-Lesen) und erzeugte Token. Das ist nicht der aktuelle Kontext.';
    $('kosten').textContent = s.kosten != null ? `≈ ${s.kosten.toFixed(2).replace('.', ',')} €` : '';
    modus.zeichne({ ...s.modus, sendeArt: aktiv ? aktiv.sendeArt : 'folgen', sitzung: aktivModus(), wechselt: !!(aktiv && aktiv.modusWechselt) });
  }
  /** Der Modus der sichtbaren Sitzung, wie ihn die Liste des Runners nennt; null, wenn der Runner keinen Modus je Sitzung kennt. */
  function aktivModus() {
    const g = aktiv ? gespraeche.find((x) => String(x.id) === String(aktiv.id)) : null;
    return g && typeof g.modus === 'string' && FP.modus.sitzungsModus(g.modus) ? g.modus : null;
  }
  /** Modus der sichtbaren Sitzung wechseln (Wähler in der Statuszeile, Strg/Cmd+Umschalt+P für den Plan-Modus). */
  async function wechsleModus(wert) {
    const rec = aktiv;
    const g = rec ? gespraeche.find((x) => String(x.id) === String(rec.id)) : null;
    if (!rec || !g || rec.modusWechselt || g.modus === wert) return;
    rec.modusWechselt = true;
    zeigeAktiv();
    try {
      const r = await aenderung.sitzungsmodus(rec.id, wert);
      if (g.modus !== 'planen') rec.modusDavor = g.modus;
      g.modus = r.modus;
      const m = FP.modus.sitzungsModus(r.modus);
      rec.chat.view.addNote(`Modus der Sitzung: ${m ? m.text : r.modus}. Der Agent erfährt es mit deiner nächsten Nachricht.`);
    } catch (f) {
      rec.chat.view.addNote(String((f && f.message) || f), 'fehler');
    } finally {
      rec.modusWechselt = false;
      zeigeAktiv();
    }
  }
  function zeigeAktiv() {
    if (!aktiv) return;
    const c = aktiv.chat;
    // „wartet auf dich“ gilt auch, wenn die offene Freigabe in einer anderen Sitzung liegt
    zeige({ ...c.S, busy: c.view.busy, wartet: c.view.zustand().wartetAufFreigabe || freigaben.offene().length > 0 });
  }
  setInterval(zeigeAktiv, 1000);

  /** Arbeitsordner der sichtbaren Sitzung: die Sitzung selbst nennt ihn (GET /api/gespraech/:id → agent.cwd), sonst der Arbeitsbereich. */
  function zeigeOrdner(rec) {
    const g = gespraeche.find((x) => String(x.id) === String(rec.id));
    const a = FP.sitzungen.ordnerAnzeige(rec.cwd, g ? bereiche[g.arbeitsbereich] : null);
    const o = $('ordner');
    o.hidden = !a.name;
    o.textContent = a.name;
    o.title = a.pfad ? `Arbeitsordner: ${a.pfad}` : '';
  }
  async function ladeOrdner(rec) {
    if (rec.cwd !== undefined) return;
    try {
      const r = await transport.api('GET', `/api/gespraech/${encodeURIComponent(rec.id)}`);
      rec.cwd = (r.agent && r.agent.cwd) || '';
    } catch (e) {
      rec.cwd = ''; // der Arbeitsbereich aus der Liste genügt
    }
    if (aktiv === rec) {
      zeigeOrdner(rec);
      planeAenderungen(); // relative Pfade hängen am Arbeitsordner
      dateienTafel.ordnerNeu(); // der Baum der Tafel „Dateien“ gehört zu diesem Ordner
    }
  }

  // --- Freigaben: Knopf mit Zahl im Kopf und Panel mit allen offenen Freigaben (alle Sitzungen) ---
  const freigaben = FP.createFreigaben(
    { knopf: $('freigabenKnopf'), zahl: $('freigabenZahl'), panel: $('freigabenPanel'), liste: $('freigabenListe'), zu: $('freigabenZu'), hinweis: $('freigabenHinweis'), banner: $('freigabenBanner') },
    {
      transport,
      // Sprung in die Sitzung der Freigabe: dieselbe Funktion wie in der Leiste, die Ansicht bleibt aufgebaut (kein Neuaufbau)
      beiSprung: (id) => wechsle(id),
      beiAenderung: () => zeigeAktiv(),
      // ein genehmigter Plan ändert beim Runner den Modus der Sitzung: die Liste zieht nach
      beiEntschieden: () => setTimeout(ladeListe, 300),
    }
  );

  // --- Vorgänge, Kalender, Ereignisse des Runners (plattform.js); ohne Plattform beim Runner bleibt die Leiste beim Chat ---
  const plattform = FP.createPlattform(
    { nav: $('bereiche'), zahl: $('vorgaengeZahl'), haupt: document.querySelector('.haupt'), panes: $('panes'), wurzel: $('plattform') },
    { transport, beiChat: () => eingabe.focus() }
  );
  void plattform.pruefe();

  // --- Änderungen der Sitzung: Knopf „Änderungen (N)“ und Panel; abgeleitet aus den Datei-Werkzeugen im Verlauf der sichtbaren Sitzung ---
  // Lesende Wege zum Runner für Archiv, Suche und Datei-Vorschau (GET über die Brücke, runner-wege.js)
  const wege = FP.wege.createWege(transport);
  let staendePfade = null; // Pfade, die der Runner als geändert nennt (Tafel „Änderungen“); null: Runner ohne Stände
  const aenderungen = FP.createAenderungen(
    {
      knopf: $('aenderungenKnopf'),
      zahl: $('aenderungenZahl'),
      panel: $('aenderungenPanel'),
      zu: $('aenderungenZu'),
      reiter: $('aenderungenReiter'),
      reiterListe: $('aenderungenReiterListe'),
      reiterBaum: $('aenderungenReiterBaum'),
      inhalt: $('aenderungenInhalt'),
    },
    {
      // Vorschau und Dateibaum lesen den echten Stand vom Runner (GET /api/datei, GET /api/ordner?dateien=1); fehlt der Weg, bleibt der Stand aus dem Verlauf
      datei: (abs, id) => wege.datei(abs, { gespraech: id, max: 200000 }),
      ordner: (abs) => wege.ordner(abs),
      // führt der Runner Stände, gilt als geändert nur, was er nennt (eine zurückgenommene Datei verschwindet auch hier)
      nurDiese: () => staendePfade,
    }
  );
  /** Arbeitsordner der Sitzung für relative Pfade: die Sitzung selbst, sonst der Arbeitsbereich aus der Liste. */
  function ordnerPfad(rec) {
    if (rec.cwd) return rec.cwd;
    const g = gespraeche.find((x) => String(x.id) === String(rec.id));
    const b = g && bereiche[g.arbeitsbereich];
    return (b && b.pfad) || '';
  }
  let aenderungenGeplant = false;
  function aenderungenNachziehen() {
    aenderungenGeplant = false;
    eingabeHilfe.vergiss(); // der Agent hat Dateien berührt: die gemerkten Ordnerlisten der @-Auswahl sind veraltet
    if (!aktiv || !aktiv.chat.adapter) return;
    aenderungen.setze(aktiv.chat.adapter.aufrufe(), ordnerPfad(aktiv), aktiv.id);
  }
  /** Gebündelt (beim Abspielen des Verlaufs enden viele Werkzeuge auf einmal): ein Neuzeichnen pro Runde. */
  function planeAenderungen() {
    if (aenderungenGeplant) return;
    aenderungenGeplant = true;
    Promise.resolve().then(aenderungenNachziehen);
  }

  // --- Seitenleiste ---
  // Archiv: Neuere Runner liefern die archivierten Sitzungen dauerhaft (GET /api/gespraeche?archiv=1, `archivServer`). Bei älteren Runnern nennt GET /api/gespraeche
  // archivierte nicht mehr: dann stehen im Archiv nur die Sitzungen, die dieses Fenster archiviert hat (`archivLokal`, bis zum Neuladen), so bleibt „Wiederherstellen“ möglich.
  let archivServer = []; // Einträge der Liste des Runners mit archiviert: true
  let archivWeg = 'unbekannt'; // 'ja' (Runner kennt ?archiv=1), 'nein' (älterer Runner), 'unbekannt' (noch nicht geprüft oder Netzfehler)
  const archivLokal = new Map(); // String(id) → Eintrag der Liste
  const aenderung = FP.sitzungen.createAenderung(transport);
  const leiste = FP.createLeiste(
    {
      liste: $('sitzungsliste'),
      weitere: $('weitereListe'),
      weitereKopf: $('weitereKopf'),
      weitereZahl: $('weitereZahl'),
      leer: $('sitzungenLeer'),
      archiv: $('archivListe'),
      archivKopf: $('archivKopf'),
      archivZahl: $('archivZahl'),
      archivLeer: $('archivLeer'),
    },
    { beiWahl: (id) => wechsle(id), beiUmbenennen: (id, text) => umbenenne(id, text), beiArchivieren: (id, an) => archiviere(id, an), beiAnpinnen: (id, an) => pinne(id, an) }
  );

  // --- Werkbank: Schiene der Leiste, Aufgabenliste des Agenten mit Streifen über der Eingabe, Läufe (Unteragenten, Befehle im Hintergrund) ---
  const werkbank = FP.werkbank.createWerkbank(
    {
      schiene: $('schiene'),
      knoepfe: { gespraeche: $('schieneGespraeche'), aufgaben: $('schieneAufgaben'), laeufe: $('schieneLaeufe'), aenderungen: $('schieneAenderungen'), dateien: $('schieneDateien') },
      tafeln: { gespraeche: $('tafelGespraeche'), aufgaben: $('tafelAufgaben'), laeufe: $('tafelLaeufe'), aenderungen: $('tafelAenderungen'), dateien: $('tafelDateien') },
      aufgabenMarke: $('aufgabenMarke'),
      aufgabenLeer: $('aufgabenLeer'),
      aufgabenKopf: $('aufgabenKopf'),
      aufgabenKopfText: $('aufgabenKopfText'),
      aufgabenBalken: $('aufgabenBalken'),
      aufgabenListe: $('aufgabenListe'),
      laeufeMarke: $('laeufeMarke'),
      laeufeLeer: $('laeufeLeer'),
      laeufeListe: $('laeufeListe'),
      streifen: $('aufgabenStreifen'),
      streifenText: $('streifenText'),
      streifenZahl: $('streifenZahl'),
      streifenBalken: $('streifenBalken'),
    },
    {
      wege,
      // Sprung in eine Sitzung oder in den Verlauf eines Unteragenten: dieselbe Funktion wie in der Leiste
      beiSprung: (id) => wechsle(id),
      titelVon: (id) => {
        const g = gespraeche.find((x) => String(x.id) === String(id));
        return g ? String(g.titel || '') : '';
      },
      beiStreifen: () => leisteUmschalten(true),
      // die Tafel „Änderungen“ liest beim Öffnen den Stand neu; „Dateien“ zieht nach, wenn der Agent inzwischen etwas getan hat
      beiTafel: (name) => {
        if (name === 'aenderungen') void staendeTafel.neu();
        else if (name === 'dateien') dateienTafel.zeige();
      },
    }
  );
  // --- Flächen rechts neben dem Gespräch (flaechen.js): ein Bereich mit Reitern für den Browser, Dateien, Unterschiede und Bilder. ---
  // Er ist nur da, solange eine Fläche offen ist; das Gespräch wird daneben schmaler.
  const flaechen = FP.createFlaechen(
    { wurzel: $('flaechen'), reiter: $('flaechenReiter'), koerper: $('flaechenKoerper'), zu: $('flaechenZu') },
    {
      beiOffen: (an) => $('app').classList.toggle('flaeche-auf', an),
      // was jetzt vorn liegt, zieht nach: der Browser sein Bild, eine Datei ihren Inhalt
      beiWechsel: (id) => {
        if (id === 'browser') void browserFlaeche.auffrischen();
        else dateiFlaeche.beiWechsel(id);
        // im Baum der Tafel „Dateien“ steht die Datei markiert, die rechts vorn liegt
        dateienTafel.markiereAktiv();
      },
    }
  );
  // --- Fläche „Diff und Datei“ (datei-flaeche.js): eine Datei an einer Zeile, der Unterschied einer Datei, ein Bild. Geöffnet aus der Tafel
  // „Änderungen“, aus den Karten und Pfaden im Gespräch und von den Anhängen einer Nachricht; ändert der Agent eine Datei, geht ihr Unterschied auf. ---
  const dateiFlaeche = FP.createDateiFlaeche(
    { flaechen },
    {
      wege,
      gespraech: () => (aktiv ? aktiv.id : null),
      ordner: () => (aktiv ? ordnerPfad(aktiv) : ''),
      // führt der Runner Stände, gibt es je Datei alle Änderungen der Sitzung; sonst nur die Änderung des einzelnen Aufrufs
      kenntStaende: () => staendePfade !== null,
      hatUnterschied: (abs) => !!staendePfade && staendePfade.has(FP.dateiFlaeche.anzeigePfad(abs, aktiv ? ordnerPfad(aktiv) : '')),
      // von selbst geht die Fläche nur auf, wenn sie neben dem Gespräch liegt (im schmalen Fenster läge sie darüber)
      breit: () => !(window.matchMedia && window.matchMedia('(max-width: 1180px)').matches),
    }
  );
  // --- Tafel „Änderungen“: was der Agent in der Sitzung geändert hat, Unterschied je Datei, Stände und Zurückspulen (staende-tafel.js). ---
  // Kennt der Runner die Stände nicht, bleibt der Knopf der Schiene weg.
  const staendeTafel = FP.staende.createStaendeTafel(
    {
      knopf: $('schieneAenderungen'),
      marke: $('staendeMarke'),
      leer: $('staendeLeer'),
      dateien: $('staendeDateien'),
      staendeKopf: $('staendeKopf'),
      staende: $('staendeListe'),
      fuss: $('staendeFuss'),
    },
    {
      wege,
      transport,
      // unter jeder Nachricht, vor der es einen Stand gibt, steht „Stand 17:31 · Hierher zurück“; der Klick öffnet die Rückfrage in der Tafel
      beiStaende: (liste) => {
        if (!aktiv) return;
        aktiv.chat.view.zeigeStaende(liste, (id) => {
          leisteUmschalten(true);
          werkbank.zeige('aenderungen');
          staendeTafel.oeffneStand(id);
        });
      },
      // zurückgespult: die Nachricht, vor die es zurückging, kommt ins leere Eingabefeld (ändern und neu senden); die Aufgabenliste zieht nach
      beiZurueck: (r) => {
        if (r.gespraech && r.nachricht && !eingabe.value.trim()) {
          eingabe.value = r.nachricht;
          waechst();
        }
        eingabe.focus();
        planeWerkbank('aufgaben');
      },
      beiDateien: (pfade, dateien) => {
        staendePfade = pfade ? new Set(pfade) : null;
        aenderungenNachziehen();
        // der Runner hat die Stände neu genannt (nach einer Änderung oder einem Zurückspulen): offene Dateien und Unterschiede ziehen nach
        dateiFlaeche.beiAenderung();
        // im Baum der Tafel „Dateien“ tragen diese Dateien eine Marke, und neu angelegte erscheinen
        dateienTafel.setzeMarken(dateien);
        dateienTafel.plane();
      },
      // ein Klick auf eine Datei der Tafel öffnet ihren Unterschied rechts als Fläche (statt in der schmalen Leiste)
      beiDatei: (d) => dateiFlaeche.oeffneDiff({ pfad: d.pfad }),
      beiWeg: (kennt) => {
        if (!kennt && werkbank.tafel === 'aenderungen') werkbank.zeige('gespraeche');
      },
    }
  );
  // --- Tafel „Dateien“ (dateien-tafel.js): der Ordner der Sitzung als Baum. Ein Klick öffnet die Datei rechts als Fläche, „@“ hängt sie an die
  // Nachricht, die Suche findet Dateien im ganzen Ordner. Listet der Runner den Ordner der Sitzung nicht, bleibt der Knopf der Schiene weg. ---
  const dateienTafel = FP.dateien.createDateienTafel(
    {
      knopf: $('schieneDateien'),
      ordner: $('dateienOrdner'),
      suche: $('dateienSuche'),
      neuKnopf: $('dateienNeu'),
      baum: $('dateienBaum'),
      leer: $('dateienLeer'),
      fuss: $('dateienFuss'),
    },
    {
      wege,
      gespraech: () => (aktiv ? aktiv.id : null),
      ordner: () => (aktiv ? ordnerPfad(aktiv) : ''),
      sichtbar: () => werkbank.tafel === 'dateien',
      // die Datei, die rechts vorn liegt (Kennungen der Flächen: „datei:<pfad>“, „diff:<pfad>“, „bild:<pfad>“)
      aktiv: () => {
        const id = String(flaechen.aktiv || '');
        const i = id.indexOf(':');
        return i > 0 ? id.slice(i + 1) : '';
      },
      beiDatei: (d) => (d.bild ? dateiFlaeche.oeffneBild({ pfad: d.pfad }) : dateiFlaeche.oeffneDatei({ pfad: d.pfad })),
      beiErwaehnen: (relativ) => erwaehne(relativ),
      beiWeg: (kennt) => {
        if (!kennt && werkbank.tafel === 'dateien') werkbank.zeige('gespraeche');
      },
    }
  );
  /** Eine Datei aus der Tafel an die Nachricht hängen: `@pfad` an der Schreibmarke, wie die @-Auswahl es einsetzt. */
  function erwaehne(relativ) {
    const wert = FP.eingabe.dateiWert(relativ);
    const start = typeof eingabe.selectionStart === 'number' ? eingabe.selectionStart : eingabe.value.length;
    const ende = typeof eingabe.selectionEnd === 'number' ? eingabe.selectionEnd : start;
    const davor = eingabe.value.slice(0, start);
    const text = `${davor && !/\s$/.test(davor) ? ' ' : ''}${wert} `;
    eingabe.value = davor + text + eingabe.value.slice(ende);
    const marke = davor.length + text.length;
    eingabe.setSelectionRange(marke, marke);
    eingabe.dispatchEvent(new Event('input', { bubbles: true }));
    waechst();
    eingabe.focus();
  }
  /** Gebündelt nachziehen: nach Datei-Werkzeugen, am Ende eines Laufs und nach einem Zurückspulen. */
  let staendeGeplant = false;
  function planeStaende() {
    // der Baum der Tafel „Dateien“ zieht mit (auch bei einem Runner ohne Stände: dort nennt niemand sonst neue Dateien)
    dateienTafel.plane();
    if (staendeGeplant) return;
    staendeGeplant = true;
    setTimeout(() => {
      staendeGeplant = false;
      void staendeTafel.neu();
    }, 250);
  }
  // --- Browser-Fläche: der Browser, den der Agent bedient, als Reiter im Bereich der Flächen (browser-flaeche.js). Kennt der Runner sie nicht, bleibt der Knopf weg. ---
  const browserFlaeche = FP.createBrowserFlaeche(
    {
      wurzel: $('browserFlaeche'),
      knopf: $('browserKnopf'),
      form: $('browserForm'),
      ziel: $('browserZiel'),
      zurueck: $('browserZurueck'),
      vor: $('browserVor'),
      neu: $('browserNeu'),
      beenden: $('browserBeenden'),
      buehne: $('browserBuehne'),
      bild: $('browserBild'),
      hinweis: $('browserHinweis'),
      lage: $('browserLage'),
    },
    {
      transport,
      wege,
      // Dateien und relative Pfade gelten im Ordner der sichtbaren Sitzung
      gespraech: () => (aktiv ? aktiv.id : null),
      // offen heißt: sie hat einen Reiter; ob sie vorn liegt, weiß der Bereich
      beiOffen: (an) => {
        if (an) flaechen.oeffne({ id: 'browser', titel: 'Browser', hinweis: 'Der Browser, den der Agent bedient', teil: $('flaecheBrowser'), fest: true, beiZu: () => browserFlaeche.zeige(false) });
        else flaechen.schliesse('browser', { still: true });
      },
      sichtbar: () => !document.hidden && flaechen.aktiv === 'browser',
      verdeckt: () => flaechen.aktiv !== 'browser',
      nachVorn: () => flaechen.aktiviere('browser'),
    }
  );
  void browserFlaeche.pruefe();

  /** Gebündelt nachziehen: beim Abspielen eines Verlaufs enden viele Werkzeuge auf einmal, gefragt wird danach einmal. */
  const werkbankGeplant = { aufgaben: false, laeufe: false };
  function planeWerkbank(was) {
    if (werkbankGeplant[was]) return;
    werkbankGeplant[was] = true;
    setTimeout(() => {
      werkbankGeplant[was] = false;
      if (was === 'aufgaben') werkbank.aufgabenNeu();
      else werkbank.laeufeNeu();
    }, 200);
  }

  /** Anpinnen (Leiste): PATCH, dann die Liste nachziehen; angepinnte Sitzungen stehen oben. */
  async function pinne(id, an) {
    const r = await aenderung.anpinnen(id, an);
    const g = gespraeche.find((x) => String(x.id) === String(id));
    if (g) g.angepinnt = r.angepinnt;
    zeichneListe();
    return r;
  }

  // --- Suche über die Sitzungen (Feld oben in der Leiste; Cmd/Strg+K oder / holt den Fokus dorthin) ---
  const suche = FP.createSuche(
    { kasten: $('sucheKasten'), feld: $('sucheFeld'), meldung: $('sucheMeldung'), ergebnis: $('sucheErgebnis'), behaelter: $('leisteListe') },
    { wege, beiWahl: (t) => waehleTreffer(t), beiEsc: () => eingabe.focus() }
  );
  const normal = (t) => String(t).toLowerCase().replace(/\s+/g, ' ');
  /** Zur Stelle des Treffers blättern, wenn der geladene Verlauf sie enthält (sonst bleibt es beim Wechsel). Kein HTML: nur Textknoten werden verglichen. */
  function springeZuTreffer(rec, t) {
    const m = t.markierungen && t.markierungen[0];
    if (!m || t.quelle === 'titel') return false;
    const nadel = normal(t.ausschnitt.slice(m.start, m.start + m.laenge));
    if (nadel.length < 2) return false;
    const kontext = normal(t.ausschnitt.slice(Math.max(0, m.start - 20), m.start + m.laenge + 20));
    const wurzel = rec.pane.querySelector('.spalte');
    if (!wurzel) return false;
    const lauf = document.createTreeWalker(wurzel, NodeFilter.SHOW_TEXT);
    let beste = null;
    let punkte = 0;
    for (let n = lauf.nextNode(); n; n = lauf.nextNode()) {
      if (!normal(n.nodeValue).includes(nadel)) continue;
      const block = n.parentElement && n.parentElement.closest('p, li, pre, td, h1, h2, h3, h4, blockquote, div');
      const p = block && normal(block.textContent).includes(kontext) ? 2 : 1;
      if (p > punkte) {
        beste = n.parentElement;
        punkte = p;
        if (p === 2) break;
      }
    }
    if (!beste) return false;
    if (typeof beste.scrollIntoView === 'function') beste.scrollIntoView({ block: 'center' });
    beste.classList.add('treffer-blitz');
    setTimeout(() => beste.classList.remove('treffer-blitz'), 2500);
    return true;
  }
  async function waehleTreffer(t) {
    await wechsle(t.id);
    if (!aktiv || String(aktiv.id) !== String(t.id)) return;
    if (t.archiviert && !aktiv.archivHinweis) {
      aktiv.archivHinweis = true;
      aktiv.chat.view.addNote('Diese Sitzung ist archiviert. Zum Weiterarbeiten im Abschnitt „Archiv“ der Seitenleiste „Wiederherstellen“ wählen.');
    }
    springeZuTreffer(aktiv, t);
  }
  function sucheOeffnen() {
    if (!suche.verfuegbar) return false;
    leisteUmschalten(true);
    return suche.fokussiere();
  }

  /** Umbenennen (Leiste und Kopf): PATCH, dann Liste, Kopf und Ansicht der Sitzung nachziehen, ohne etwas neu aufzubauen. */
  async function umbenenne(id, text) {
    const r = await aenderung.umbenennen(id, text);
    const g = gespraeche.find((x) => String(x.id) === String(id));
    if (g) g.titel = r.titel;
    const a = archivLokal.get(String(id));
    if (a) a.titel = r.titel;
    const s = archivServer.find((x) => String(x.id) === String(id));
    if (s) s.titel = r.titel;
    const rec = ansichten.get(String(id));
    if (rec) rec.chat.S.titel = r.titel;
    zeichneListe();
    zeigeAktiv();
    return r;
  }

  async function archiviere(id, an) {
    const schluessel = String(id);
    if (an) {
      const g = gespraeche.find((x) => String(x.id) === schluessel);
      if (!g) throw new Error('Die Sitzung steht nicht mehr in der Liste.');
      // Die Hauptsitzung (root) bleibt: ohne sie hätte die App keinen Anfang
      if (g.art === 'root') throw new Error('Die Hauptsitzung kann nicht archiviert werden.');
      await aenderung.archivieren(id, true);
      archivLokal.set(schluessel, { ...g, archiviert: true });
      gespraeche = gespraeche.filter((x) => String(x.id) !== schluessel);
      if (aktiv && String(aktiv.id) === schluessel) {
        const naechste = gespraeche.find((x) => x.art === 'root') || gespraeche.find((x) => ['root', 'mensch', 'zweig'].includes(x.art));
        zeichneListe();
        if (naechste) await wechsle(naechste.id);
        else zeichneListe();
      } else {
        zeichneListe();
      }
      ladeListe(); // neuere Runner: das Archiv kommt von dort zurück (dauerhaft)
    } else {
      const g = archivLokal.get(schluessel) || archivServer.find((x) => String(x.id) === schluessel);
      await aenderung.archivieren(id, false);
      archivLokal.delete(schluessel);
      archivServer = archivServer.filter((x) => String(x.id) !== schluessel);
      if (g && !gespraeche.some((x) => String(x.id) === schluessel)) gespraeche.push({ ...g, archiviert: false });
      zeichneListe();
      ladeListe();
    }
  }
  let zeichnenGeplant = false;
  function zeichneListe() {
    zeichnenGeplant = false;
    const laufend = new Set();
    // die sichtbare Sitzung weiß es genau; die übrigen kennt nur der Aktivitätsstrom
    if (aktiv && aktiv.chat.view.busy) laufend.add(String(aktiv.id));
    // Archiv = Liste des Runners (dauerhaft) plus, was dieses Fenster eben archiviert hat und die Liste noch nicht nennt; je Id ein Eintrag, die lokale Fassung gewinnt
    const archivAlle = new Map();
    for (const g of archivServer) archivAlle.set(String(g.id), g);
    for (const [k, g] of archivLokal) archivAlle.set(k, g);
    const daten = FP.sitzungen.sitzungsListe(gespraeche, bereiche, aktivitaet, { laufend, archivLokal: [...archivAlle.values()], archivImmer: archivWeg === 'ja' });
    if (aktiv) {
      const z = [...daten.sitzungen, ...daten.weitere].find((x) => String(x.id) === String(aktiv.id));
      if (z && !aktiv.chat.view.busy) z.laeuft = false;
    }
    leiste.zeichne(daten, aktiv ? aktiv.id : null);
    window.__liste = daten;
  }
  function planeZeichnen() {
    if (zeichnenGeplant) return;
    zeichnenGeplant = true;
    setTimeout(zeichneListe, 80);
  }
  /** Archivierte Sitzungen vom Runner holen (nur wenn er die Archivliste kennt). Netzfehler lassen den alten Stand stehen. */
  async function ladeArchiv() {
    if (archivWeg === 'nein') return;
    try {
      const a = await wege.archiv();
      if (!a.unterstuetzt) {
        // Der Runner hat den Parameter ignoriert (Antwort ohne `archiviert: true`): altes Verhalten, nur die selbst archivierten Sitzungen
        archivWeg = 'nein';
        archivServer = [];
        return;
      }
      archivWeg = 'ja';
      archivServer = a.liste;
      // Der Runner ist die Quelle: was dieses Fenster zwischenzeitlich selbst vermerkt hat, steht jetzt in seiner Liste
      archivLokal.clear();
    } catch (f) {
      if (f && f.art === 'weg_fehlt') archivWeg = 'nein';
    }
  }
  let listeLaeuft = null;
  let listeNochmal = false;
  /** Liste neu laden (Sitzungen und Archiv). Kommt während des Ladens eine neue Anforderung, läuft danach genau ein weiterer Durchgang (kein veralteter Stand nach einer Änderung). */
  function ladeListe() {
    if (listeLaeuft) {
      listeNochmal = true;
      return listeLaeuft;
    }
    const einmal = async () => {
      // erst die Sitzungen, dann das Archiv (nacheinander: scheitert die erste Anfrage, etwa mit abgelehntem Token, bleibt es bei einer Anfrage)
      const r = await transport.api('GET', '/api/gespraeche').catch(() => null);
      if (r) gespraeche = Array.isArray(r.gespraeche) ? r.gespraeche : [];
      planeZeichnen();
      if (aktiv) zeigeOrdner(aktiv);
      if (r) {
        await ladeArchiv();
        planeZeichnen();
      }
    };
    listeLaeuft = (async () => {
      do {
        listeNochmal = false;
        await einmal();
      } while (listeNochmal);
    })()
      .catch(() => {})
      .then(() => {
        listeLaeuft = null;
      });
    return listeLaeuft;
  }
  setInterval(ladeListe, 30000);
  setInterval(planeZeichnen, 20000);

  function leisteUmschalten(offen) {
    const zu = offen === undefined ? !$('app').classList.contains('leiste-zu') : !offen;
    $('app').classList.toggle('leiste-zu', zu);
    $('leisteSchalter').setAttribute('aria-expanded', zu ? 'false' : 'true');
    if ($('leiste').inert !== undefined) $('leiste').inert = zu;
  }
  $('leisteSchalter').addEventListener('click', () => leisteUmschalten());
  if (window.innerWidth < 760) leisteUmschalten(false);

  // --- Ansichten der Sitzungen ---
  function paneBauen(id) {
    const pane = document.createElement('div');
    pane.className = 'pane';
    pane.dataset.id = String(id);
    pane.setAttribute('aria-hidden', 'true');
    pane.inert = true;
    const verlauf = document.createElement('main');
    verlauf.className = 'verlauf';
    verlauf.tabIndex = 0;
    verlauf.setAttribute('role', 'log');
    verlauf.setAttribute('aria-live', 'off');
    verlauf.setAttribute('aria-label', 'Gespräch');
    const spalte = document.createElement('div');
    spalte.className = 'spalte';
    verlauf.appendChild(spalte);
    const zumEnde = document.createElement('button');
    zumEnde.type = 'button';
    zumEnde.className = 'zum-ende';
    zumEnde.hidden = true;
    zumEnde.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v9 M4 8.5l4 4 4-4" /></svg>';
    zumEnde.appendChild(document.createTextNode(' Zum Ende'));
    pane.append(verlauf, zumEnde);
    $('panes').appendChild(pane);
    return { pane, verlauf, spalte, zumEnde };
  }

  function ansichtErzeugen(id) {
    const d = paneBauen(id);
    const rec = { id, pane: d.pane, chat: null, benutzt: Date.now(), entwurf: '', anhaenge: [], sendeArt: 'folgen', wechselt: false, cwd: undefined };
    rec.chat = FP.createEchtChat(transport, {
      modelle: () => modelle, // contextWindow je Modell (GET /api/modelle): Fenster der Kontextanzeige
      spalte: d.spalte,
      scroller: d.verlauf,
      zumEnde: d.zumEnde,
      ansage: $('ansage'),
      reduceMotion: () => mq.matches,
      darfFokus: () => aktiv === rec && !eingabe.value && document.activeElement !== eingabe,
      onStatus: (s) => {
        if (aktiv === rec) zeige(s);
        planeZeichnen();
      },
      // der Verlauf hat die Liste geholt oder eine Karte entschieden: Zahl und Panel ziehen nach
      beiFreigaben: (liste) => freigaben.setze(liste),
      // ein Datei-Werkzeug (read, write, edit …) der Sitzung ist zu Ende: gilt nur für die sichtbare Sitzung, die anderen holen es beim Wechsel nach
      beiWerkzeug: () => {
        if (aktiv === rec) planeAenderungen();
      },
      // irgendein Werkzeug der sichtbaren Sitzung ist zu Ende: die Aufgabenliste (todo) oder die Läufe ziehen nach
      beiWerkzeugEnde: (w) => {
        if (aktiv !== rec || !w) return;
        if (w.name === 'todo') planeWerkbank('aufgaben');
        else if (/^(hintergrund_|unteragent$|job_ende$)/.test(w.name)) planeWerkbank('laeufe');
        // der Agent hat eben den Browser bedient (nicht beim Abspielen eines alten Verlaufs): die Fläche geht auf und zieht nach
        else if (w.name === 'browser' && w.live) browserFlaeche.beiWerkzeug(w);
        // eben eine Datei geschrieben oder bearbeitet (auch ein Unteragent kann das): die Tafel „Änderungen“ zieht nach
        if (w.live && (w.name === 'write' || w.name === 'edit' || w.name === 'unteragent')) planeStaende();
        // und der Unterschied der Datei geht rechts auf (nur neben dem Gespräch, und nur, solange der Mensch das nicht weggeklickt hat)
        if (w.live && w.diff && w.pfad && (w.name === 'write' || w.name === 'edit')) dateiFlaeche.oeffneDiff({ pfad: w.pfad, diff: w.diff, vonSelbst: true });
      },
      // im Gespräch angeklickt: eine Datei (auch an einer Zeile) oder die Änderung eines Aufrufs öffnet sich rechts als Fläche
      beiDatei: (d) => {
        if (aktiv !== rec || !d) return;
        const ging = d.art === 'diff' ? dateiFlaeche.oeffneDiff({ pfad: d.pfad, diff: d.diff }) : dateiFlaeche.oeffneDatei({ pfad: d.pfad, zeile: d.zeile });
        if (!ging) rec.chat.view.addNote('Diese Datei lässt sich nicht öffnen: der Ordner der Sitzung ist nicht bekannt.', 'fehler');
      },
      // ein Anhang an einer Nachricht: ein Bild groß, eine Datei mit ihrem Inhalt
      beiAnhang: (a) => {
        if (aktiv !== rec || !a || !a.pfad) return;
        if (a.art === 'bild') dateiFlaeche.oeffneBild({ pfad: a.pfad, name: a.name });
        else dateiFlaeche.oeffneDatei({ pfad: a.pfad, name: a.name });
      },
      beiLaufEnde: () => {
        setTimeout(ladeListe, 300);
        planeZeichnen();
        if (aktiv === rec) {
          planeWerkbank('laeufe');
          planeStaende();
        }
      },
      // im Verlauf steht ein Zurückspulen (auch von einem anderen Fenster aus): Dateien und Stände neu lesen
      beiZurueck: (z) => {
        if (aktiv === rec && z && z.live) planeStaende();
      },
      // eine Entscheidung ist beim Runner angekommen: ein genehmigter Plan ändert dort den Modus der Sitzung, die Liste zieht nach
      beiEntscheidung: () => setTimeout(ladeListe, 300),
      // /abzweigen: die neue Sitzung öffnet sich in der Leiste, diese bleibt wie sie ist
      beiNeueSitzung: (neuId) => {
        ladeListe().then(() => wechsle(neuId));
      },
    });
    ansichten.set(String(id), rec);
    return rec;
  }

  function abbauen() {
    while (ansichten.size > MAX_ANSICHTEN) {
      let aelteste = null;
      for (const r of ansichten.values()) if (r !== aktiv && (!aelteste || r.benutzt < aelteste.benutzt)) aelteste = r;
      if (!aelteste) return;
      aelteste.chat.ende();
      aelteste.pane.remove();
      ansichten.delete(String(aelteste.id));
    }
  }

  // --- Name der offenen Sitzung im Kopf ändern (gleiche Funktion wie in der Leiste) ---
  let kopfEditor = null;
  function kopfStift() {
    $('titelUmbenennen').hidden = !aktiv || !!kopfEditor;
  }
  function kopfBearbeiten() {
    if (!aktiv || kopfEditor) return;
    const rec = aktiv;
    $('titel').hidden = true;
    $('titelUmbenennen').hidden = true;
    $('titelEditor').hidden = false;
    kopfEditor = FP.createTitelEditor($('titelEditor'), {
      wert: rec.chat.S.titel || '',
      label: 'Neuer Name der Sitzung',
      pruefen: FP.sitzungen.titelPruefen,
      speichern: (t) => umbenenne(rec.id, t),
      beiEnde: () => {
        kopfEditor = null;
        $('titelEditor').hidden = true;
        $('titel').hidden = false;
        kopfStift();
        if (!document.activeElement || document.activeElement === document.body) $('titelUmbenennen').focus();
      },
    });
  }
  $('titelUmbenennen').addEventListener('click', kopfBearbeiten);
  $('titel').addEventListener('dblclick', kopfBearbeiten);

  function setzeAktiv(rec) {
    if (aktiv === rec) return;
    if (kopfEditor) kopfEditor.schliesse();
    const alt = aktiv;
    if (alt) {
      alt.entwurf = eingabe.value;
      alt.anhaenge = anhaenge.nimm();
      alt.chat.ruhen();
      alt.pane.classList.remove('aktiv');
      alt.pane.setAttribute('aria-hidden', 'true');
      alt.pane.inert = true;
    }
    aktiv = rec;
    rec.benutzt = Date.now();
    rec.pane.classList.add('aktiv');
    rec.pane.setAttribute('aria-hidden', 'false');
    rec.pane.inert = false;
    eingabe.value = rec.entwurf || '';
    anhaenge.setze(rec.anhaenge || []);
    eingabeHilfe.schliesse();
    eingabeHilfe.vergiss();
    waechst();
    merken.schreibe(rec.id);
    window.__aktuelleId = rec.id;
    zeigeAktiv();
    kopfStift();
    zeigeOrdner(rec);
    ladeOrdner(rec);
    aenderungenNachziehen();
    werkbank.setzeSitzung(rec.id);
    staendeTafel.setzeSitzung(rec.id);
    dateiFlaeche.setzeSitzung(rec.id);
    dateienTafel.setzeSitzung(rec.id);
    zeichneListe();
    abbauen();
  }

  /** Eine Sitzung sichtbar machen. Aufrufe laufen nacheinander, damit der eine Ereignisstrom immer zur sichtbaren Sitzung gehört. */
  function wechsle(id) {
    wechselKette = wechselKette.then(() => wechsleJetzt(id)).catch((f) => {
      if (aktiv) aktiv.chat.view.addNote(`Sitzung nicht geöffnet: ${(f && f.message) || f}`, 'fehler');
    });
    return wechselKette;
  }
  async function wechsleJetzt(id) {
    const schluessel = String(id);
    if (aktiv && String(aktiv.id) === schluessel) {
      eingabe.focus();
      return;
    }
    let rec = ansichten.get(schluessel);
    if (!rec) {
      rec = ansichtErzeugen(id);
      stromBesitzer = id; // start() öffnet den Strom selbst (und schließt den bisherigen)
      await rec.chat.start({ id });
      setzeAktiv(rec);
    } else {
      setzeAktiv(rec);
      if (String(stromBesitzer) !== schluessel) {
        stromBesitzer = id;
        await rec.chat.aktiviere();
      }
    }
    stromBesitzer = id;
    // kurz warten, bis die Ansicht steht, dann Fokus in die Eingabe (nicht, solange die Leiste per Tastatur bedient wird)
    if (!document.activeElement || document.activeElement === document.body || !$('leiste').contains(document.activeElement)) eingabe.focus();
  }

  function naechste(richtung) {
    const ids = [...$('sitzungsliste').querySelectorAll('.sitzung')].map((b) => b.dataset.id);
    const ziel = FP.sitzungen.nachbar(ids, aktiv ? aktiv.id : null, richtung);
    if (ziel !== null) wechsle(ziel);
  }

  // --- Runner wählen (Liste aus den Einstellungen; Umschalten lädt die Seite neu, die App läuft weiter) ---
  let runnerGewaehlt = '';
  function runnerHinweis(text) {
    $('runnerHinweis').hidden = !text;
    $('runnerHinweis').textContent = text || '';
  }
  async function ladeRunner() {
    if (!tauriInvoke) {
      $('runnerKasten').hidden = true;
      return;
    }
    try {
      const v = await tauriInvoke('runner_liste');
      const wahl = $('runnerWahl');
      wahl.textContent = '';
      for (const r of v.runner || []) {
        const o = document.createElement('option');
        o.value = r.id;
        o.textContent = r.art === 'lokal' ? `${r.name} (lokal)` : r.name;
        wahl.appendChild(o);
        if (r.aktiv) {
          runnerArt = r.art;
          runnerGewaehlt = r.id;
        }
      }
      wahl.value = runnerGewaehlt;
      $('runnerKasten').hidden = !(v.runner || []).length;
    } catch (f) {
      $('runnerKasten').hidden = true;
    }
  }
  $('runnerWahl').addEventListener('change', async () => {
    const id = $('runnerWahl').value;
    runnerHinweis(id === 'lokal' ? 'Starte den lokalen Runner …' : 'Wechsle …');
    $('runnerWahl').disabled = true;
    try {
      await tauriInvoke('runner_wechseln', { id });
      // Rust meldet „ziel-gewechselt“, die Seite lädt neu
      runnerGewaehlt = id;
    } catch (f) {
      const e = alsFehler(f);
      runnerHinweis(`Nicht gewechselt: ${(e && e.message) || e}`);
      $('runnerWahl').value = runnerGewaehlt;
    } finally {
      $('runnerWahl').disabled = false;
    }
  });
  ladeRunner();
  // Die Liste ändert sich in den Einstellungen, also in einem anderen Fenster. Beim Zurückkehren neu lesen: sonst fehlte ein
  // eben eingetragener lokaler Runner in der Auswahl, bis die Anwendung neu gestartet wurde.
  let runnerLaedt = false;
  async function runnerAuffrischen() {
    if (runnerLaedt || $('runnerWahl').disabled) return;
    runnerLaedt = true;
    try {
      await ladeRunner();
    } finally {
      runnerLaedt = false;
    }
  }
  window.addEventListener('focus', runnerAuffrischen);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') runnerAuffrischen();
  });

  // --- Einstellungen: dasselbe Fenster wie der Tray-Eintrag „Einstellungen …“ (Befehl ohne Argumente; Verbindungsdaten bleiben in Rust) ---
  let einstellungenUhr = null;
  function einstellungenFehler(text) {
    const p = $('einstellungenFehler');
    p.hidden = !text;
    p.textContent = text || '';
    if (einstellungenUhr) clearTimeout(einstellungenUhr);
    if (text) einstellungenUhr = setTimeout(() => einstellungenFehler(''), 8000);
  }
  async function einstellungenOeffnen() {
    if (!tauriInvoke) return;
    try {
      await tauriInvoke('einstellungen_oeffnen');
      einstellungenFehler('');
    } catch (f) {
      const e = alsFehler(f);
      einstellungenFehler(`Einstellungen lassen sich nicht öffnen: ${(e && e.message) || e}`);
    }
  }
  $('einstellungenKnopf').addEventListener('click', einstellungenOeffnen);
  $('einstellungenKnopf').hidden = !tauriInvoke;

  // --- Ordnerwahl ---
  let ordnerNutzbar = false;
  const ordnerAuswahl = FP.createOrdnerWahl(
    { kasten: $('ordnerKasten'), gewaehlt: $('ordnerGewaehlt'), zuletzt: $('ordnerZuletzt'), dialog: $('ordnerDialog'), baum: $('ordnerBaum'), fehler: $('ordnerFehler') },
    {
      transport,
      waehleLokal: () => (tauriInvoke ? tauriInvoke('ordner_waehlen').catch((m) => { throw alsFehler(m); }) : Promise.reject(new Error('Der Systemdialog gibt es nur in der Anwendung.'))),
      zuletztLaden: async () => (tauriInvoke ? ((await tauriInvoke('ordner_zuletzt')).ordner || []) : []),
    }
  );

  // --- Neue Sitzung ---
  const neuForm = $('neuForm');
  function neuOeffnen() {
    leisteUmschalten(true);
    const ordnerWahl = $('neuOrdner');
    ordnerWahl.textContent = '';
    for (const [name, b] of Object.entries(bereiche)) {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = b.titel || name;
      ordnerWahl.appendChild(o);
    }
    // vorgewählt: der Arbeitsbereich der sichtbaren Sitzung
    const g = aktiv && gespraeche.find((x) => String(x.id) === String(aktiv.id));
    if (g && bereiche[g.arbeitsbereich]) ordnerWahl.value = g.arbeitsbereich;
    const mw = $('neuModell');
    mw.textContent = '';
    const std = document.createElement('option');
    std.value = '';
    std.textContent = 'Standard des Runners';
    mw.appendChild(std);
    for (const m of modelle) {
      if (!m || !m.id) continue;
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.name || m.id;
      mw.appendChild(o);
    }
    $('neuModell').hidden = $('neuModellLabel').hidden = modelle.length === 0;
    $('neuOrdner').disabled = Object.keys(bereiche).length === 0;
    pfadZeigen();
    $('neuFehler').hidden = true;
    $('neuTitel').value = '';
    neuForm.hidden = false;
    $('neuTitel').focus();
    // Ordnerwahl: Baum (entfernt) oder Systemdialog (lokal); ohne Ordnerliste auf dem Runner bleibt die Auswahl der Arbeitsbereiche
    ordnerNutzbar = false;
    const legacy = (aus) => {
      $('neuOrdner').hidden = $('neuOrdnerLabel').hidden = $('neuPfad').hidden = aus;
    };
    legacy(false);
    ordnerAuswahl.starte(runnerArt).then((ok) => {
      ordnerNutzbar = ok;
      legacy(ok);
    });
  }
  function pfadZeigen() {
    const b = bereiche[$('neuOrdner').value];
    $('neuPfad').textContent = b && b.pfad ? b.pfad : '';
  }
  function neuSchliessen() {
    neuForm.hidden = true;
    $('neueSitzung').focus();
  }
  $('neuOrdner').addEventListener('change', pfadZeigen);
  $('neueSitzung').addEventListener('click', () => (neuForm.hidden ? neuOeffnen() : neuSchliessen()));
  $('neuAbbrechen').addEventListener('click', neuSchliessen);
  // Enter im Namensfeld startet die Sitzung wie der Knopf „Anlegen“
  $('neuTitel').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.shiftKey) return;
    e.preventDefault();
    if (!$('neuAnlegen').disabled) neuForm.requestSubmit();
  });
  neuForm.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      neuSchliessen();
    }
  });
  neuForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('neuAnlegen').disabled = true;
    $('neuFehler').hidden = true;
    try {
      const koerper = { titel: $('neuTitel').value.trim() || undefined };
      const ordner = ordnerNutzbar ? ordnerAuswahl.wert() : '';
      if (ordner) koerper.ordner = ordner;
      else if ($('neuOrdner').value && !ordnerNutzbar) koerper.arbeitsbereich = $('neuOrdner').value;
      if ($('neuModell').value) koerper.modell = $('neuModell').value;
      const r = await transport.api('POST', '/api/gespraeche', koerper);
      const neu = r.gespraech || r;
      if (neu.id === undefined) throw new Error('Der Runner hat keine Sitzung zurückgegeben.');
      if (ordner && tauriInvoke) tauriInvoke('ordner_merken', { pfad: ordner }).catch(() => {});
      neuForm.hidden = true;
      await ladeListe();
      await wechsle(neu.id);
    } catch (f) {
      $('neuFehler').textContent = `Nicht angelegt: ${(f && f.message) || f}`;
      $('neuFehler').hidden = false;
    } finally {
      $('neuAnlegen').disabled = false;
    }
  });

  // --- Eingabe ---
  function waechst() {
    eingabe.style.height = 'auto';
    eingabe.style.height = `${Math.min(200, eingabe.scrollHeight)}px`;
  }
  // Befehle bleiben, wie sie getippt sind: kein Gedankenstrich aus „--“, keine gebogenen Anführungszeichen (eingabe.js)
  eingabe.addEventListener('beforeinput', (e) => {
    if (FP.eingabe.istSatzzeichenErsatz(e)) e.preventDefault();
  });
  // @Dateien und /Befehle: Vorschläge aus dem Arbeitsordner der Sitzung und den Befehlen des Runners (eingabe.js)
  const eingabeHilfe = FP.createEingabe(
    { feld: eingabe, liste: menue, ansage: $('ansage') },
    {
      basis: () => (aktiv ? ordnerPfad(aktiv) : ''),
      ordner: (abs) => wege.ordner(abs),
      beruehrt: () => {
        if (!aktiv || !aktiv.chat.adapter) return [];
        return FP.aenderungen.sammle(aktiv.chat.adapter.aufrufe(), ordnerPfad(aktiv)).beruehrt.map((d) => d.pfad).filter((p) => p && !p.startsWith('/'));
      },
      befehle: () => (aktiv ? aktiv.chat.befehle() : Promise.resolve(null)),
      beiAenderung: waechst,
    }
  );
  // Anhänge: Textdateien werden in die Nachricht eingebettet. Bilder, große und andere Dateien nimmt die Büroklammer nur, wenn der Runner
  // sagt, dass er sie annimmt (GET /api/anhaenge, anhaenge.js `setzeFaehig`); sonst lehnt die Seite sie wie bisher mit Grund ab.
  const anhaenge = FP.createAnhaenge(
    { leiste: $('anhaenge'), knopf: $('anhangKnopf'), wahl: $('anhangWahl'), zone: $('eingabeForm'), meldung: $('anhangMeldung'), feld: eingabe, dokument: document, fokus: () => eingabe.focus() },
    { beiAenderung: () => {} }
  );
  let anhaengeGeprueft = false;
  /** Fragt den Runner einmal, was er an einer Nachricht annimmt; ein Runner ohne den Weg bleibt beim eingebetteten Text. */
  async function pruefeAnhaenge() {
    try {
      anhaenge.setzeFaehig(await wege.anhaenge());
      anhaengeGeprueft = true;
    } catch (f) {
      anhaenge.setzeFaehig(null);
      anhaengeGeprueft = !!(f && f.art === 'weg_fehlt'); // ein Netzfehler heißt: später noch einmal fragen
    }
  }
  void pruefeAnhaenge();
  async function senden(sofort) {
    const satz = eingabe.value.trim();
    if ((!satz && !anhaenge.anzahl()) || !aktiv) return;
    const zuLang = anhaenge.pruefen(satz);
    if (zuLang) {
      anhaenge.meldung(zuLang);
      return;
    }
    const rec = aktiv;
    const text = anhaenge.text(satz);
    // Bilder und abgelegte Dateien gehen als eigenes Feld an den Runner (nur wenn er sie annimmt, sonst ist die Liste leer)
    const fuerRunner = anhaenge.fuerRunner();
    const angehaengt = anhaenge.nimm();
    eingabe.value = '';
    rec.entwurf = '';
    rec.anhaenge = [];
    anhaenge.leere();
    waechst();
    eingabeHilfe.schliesse();
    const r = await rec.chat.sende(text, sofort || rec.sendeArt === 'steuern', fuerRunner);
    if (r && r.ok === false && !r.befehl && aktiv === rec) {
      eingabe.value = satz;
      anhaenge.setze(angehaengt);
      waechst();
    }
  }

  // --- Modell der Sitzung wählen (GET /api/modelle, PATCH /api/gespraech/:id mit modell) ---
  const modellWahl = FP.createWaehler($('modell'), $('modellMenue'), {
    beschriftung: 'Modell der Sitzung',
    beiWahl: (wert) => modellWechseln(wert === '' ? null : wert),
  });
  let modellSchluessel = '';
  let modellFehlerUhr = null;
  function modellFehler(text) {
    const p = $('modellFehler');
    p.hidden = !text;
    p.textContent = text || '';
    if (modellFehlerUhr) clearTimeout(modellFehlerUhr);
    if (text) modellFehlerUhr = setTimeout(() => modellFehler(''), 9000);
  }
  /** Die Liste des Wählers nur neu bauen, wenn sich etwas geändert hat (die Statuszeile ruft jede Sekunde). */
  function zeichneModellWahl() {
    if (!aktiv) return;
    const eintrag = FP.wege.modellEintrag(modelle, aktiv.chat.modellRoh() || aktiv.chat.S.modell);
    const schluessel = `${aktiv.id}|${eintrag ? eintrag.id : ''}|${modelle.map((x) => x && x.id).join(',')}`;
    const aus = modelle.length === 0;
    $('modell').disabled = aus || aktiv.wechselt;
    $('modell').title = aus ? 'Der Runner nennt keine Modelle.' : 'Modell dieser Sitzung wechseln';
    if (schluessel === modellSchluessel) return;
    modellSchluessel = schluessel;
    modellWahl.setze([
      {
        id: 'modell',
        punkte: [
          ...modelle
            .filter((x) => x && x.id)
            .map((x) => ({ wert: x.id, text: x.name || x.id, hilfe: typeof x.contextWindow === 'number' ? `Kontextfenster ${zahl(x.contextWindow)}` : '', gewaehlt: !!eintrag && eintrag.id === x.id && eintrag.provider === x.provider })),
          { wert: '', text: 'Standard des Runners', hilfe: 'Das Modell, das der Runner ohne eigene Wahl nimmt.', gewaehlt: false },
        ],
      },
    ]);
  }
  async function modellWechseln(modellId) {
    const rec = aktiv;
    if (!rec || rec.wechselt) return;
    rec.wechselt = true;
    modellFehler('');
    zeigeAktiv();
    try {
      const r = await aenderung.modell(rec.id, modellId);
      rec.chat.setzeModell(r.gespraech);
      modellSchluessel = '';
    } catch (f) {
      modellFehler((f && f.message) || String(f));
    } finally {
      rec.wechselt = false;
      zeigeAktiv();
      if (aktiv === rec) eingabe.focus();
    }
  }

  // Menü für @Dateien und /Befehle
  eingabe.addEventListener('input', () => {
    waechst();
    eingabeHilfe.beiInput();
  });
  eingabe.addEventListener('keydown', (e) => {
    if (eingabeHilfe.beiTaste(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      senden(e.metaKey || e.ctrlKey);
    }
  });
  $('eingabeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    senden(false);
  });
  $('stopp').addEventListener('click', () => aktiv && aktiv.chat.stopp());

  // Tastatur: Sitzungen wechseln (Cmd/Strg+Alt+Pfeil, Cmd/Strg+1..9), neue Sitzung (Cmd/Strg+Umschalt+O), Leiste (Cmd/Strg+B)
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const mod = e.metaKey || e.ctrlKey;
    // Suche: Cmd/Strg+K immer, „/“ nur wenn der Fokus nicht in einem Eingabefeld liegt (sonst tippt man einen Schrägstrich)
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      if (sucheOeffnen()) e.preventDefault();
      return;
    }
    if (e.key === '/' && !mod && !e.altKey) {
      const a0 = document.activeElement;
      const feld = a0 && (a0.tagName === 'INPUT' || a0.tagName === 'TEXTAREA' || a0.tagName === 'SELECT' || a0.isContentEditable);
      if (!feld && sucheOeffnen()) {
        e.preventDefault();
        return;
      }
    }
    if (e.key === 'F2' && !mod && !e.altKey && !e.shiftKey && aktiv) {
      e.preventDefault();
      kopfBearbeiten();
      return;
    }
    // Cmd+, (macOS) und Strg+, öffnen die Einstellungen
    if (mod && !e.shiftKey && !e.altKey && e.key === ',') {
      e.preventDefault();
      einstellungenOeffnen();
      return;
    }
    if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      neuForm.hidden ? neuOeffnen() : neuSchliessen();
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      leisteUmschalten();
      return;
    }
    // Plan-Modus an und aus (zurück in den Modus von vorher); nur, wenn der Runner einen Modus je Sitzung kennt
    if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
      const jetzt = aktivModus();
      if (!jetzt) return;
      e.preventDefault();
      wechsleModus(FP.modus.planUmschalten(jetzt, aktiv && aktiv.modusDavor));
      return;
    }
    if (mod && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      naechste(e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      const ziele = [...$('sitzungsliste').querySelectorAll('.sitzung')];
      const z = ziele[Number(e.key) - 1];
      if (z) {
        e.preventDefault();
        wechsle(z.dataset.id);
      }
      return;
    }
    if (!aktiv) return;
    const a = document.activeElement;
    const tippt = (a === eingabe && eingabe.value.length > 0) || (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA' && a !== eingabe));
    if (!tippt && aktiv.chat.view.handleKey(e)) return;
    if (e.key === 'Escape' && aktiv.chat.view.busy) {
      e.preventDefault();
      aktiv.chat.stopp();
    }
  });

  // Fehlerbericht (Textdatei auf den Schreibtisch, ohne Geheimnisse, nichts wird hochgeladen)
  $('bericht').addEventListener('click', async () => {
    if (!window.__TAURI__) return;
    try {
      const pfad = await window.__TAURI__.core.invoke('bericht_speichern', { meldung: null });
      aktiv.chat.view.addNote(`Bericht gespeichert: ${pfad} (ohne Passwörter; es wurde nichts hochgeladen).`);
    } catch (f) {
      if (aktiv) aktiv.chat.view.addNote(`Bericht nicht gespeichert: ${(f && f.ursache) || (f && f.message) || f}`, 'fehler');
    }
  });

  // Der Name des Agenten kommt vom Runner (Feld agent der Gesundheitsantwort), nicht aus dieser Seite
  function nameSetzen(h) {
    const roh = h && typeof h.agent === 'string' ? h.agent.trim() : '';
    if (!roh) return;
    FP.anzeigename = roh.charAt(0).toUpperCase() + roh.slice(1);
    $('avatar').textContent = FP.anzeigename.charAt(0);
    document.title = FP.anzeigename;
    eingabe.setAttribute('aria-label', `Nachricht an ${FP.anzeigename}`);
    eingabe.placeholder = `Nachricht an ${FP.anzeigename} …  @ für Dateien, / für Befehle`;
    $('leisteFuss').textContent = h.geraet && h.geraet.name ? `${FP.anzeigename} auf ${h.geraet.name}` : '';
  }

  // Anderer Runner eingestellt (Einstellungen): neu starten, damit Verlauf und Ströme zum neuen Ziel gehören
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen('ziel-gewechselt', () => window.location.reload());
    // Tray-Zeile „Freigaben“: Rust holt das Fenster nach vorn und sagt hier, dass das Panel aufgehen soll
    window.__TAURI__.event.listen('freigaben-zeigen', () => freigaben.zeige(true));
  }
  window.addEventListener('focus', () => freigaben.lade());
  // War der Runner beim Laden der Seite noch nicht erreichbar, fragt die Browser-Fläche beim Zurückkehren noch einmal
  window.addEventListener('focus', () => {
    if (!browserFlaeche.kennt) void browserFlaeche.pruefe();
    if (!anhaengeGeprueft) void pruefeAnhaenge();
  });

  // Aktivitätsstrom (alle Sitzungen): markiert, wo gerade gearbeitet wird, und meldet neue Sitzungen
  transport.onStrom((p) => {
    if (!p || p.kanal !== 'strom') return;
    if (p.art === 'verbunden') aktivitaet.loesche();
    else if (p.art === 'zeile' && p.daten) {
      const bekannt = gespraeche.some((g) => String(g.id) === String(p.daten.gespraech));
      aktivitaet.zeile(p.daten);
      // eine neue Freigabe (in irgendeiner Sitzung) gleich in Zahl und Panel zeigen, nicht erst beim nächsten Abfragen
      freigaben.beiStromZeile(p.daten);
      if (!bekannt && p.daten.art !== 'lauf') ladeListe();
      planeZeichnen();
    }
  });

  // Die Seite stellt sich dem Prüfskript (tools/e2e_agent.py) nur zur Verfügung, wenn Rust es erlaubt (Debug-Bau mit gesetzter Umgebung)
  Object.defineProperty(window, '__chat', { get: () => (aktiv ? aktiv.chat : null) });
  window.__arbeitsplatz = { wechsle, ansichten, ladeListe, aktivitaet, neuOeffnen, freigaben, aenderungen, suche, wege, werkbank, get aktiv() { return aktiv; } };
  if (window.__TAURI__) {
    window.__TAURI__.core.invoke('ziel_info').then((i) => {
      // Das Fenster wurde durch einen Klick auf die Freigaben-Zeile im Tray geöffnet (noch ohne Zuhörer für das Ereignis)
      if (i && i.freigaben_zeigen) freigaben.zeige(true);
      if (i && i.e2e) {
        const s = document.createElement('script');
        s.src = `${i.e2e_skript || 'e2e'}.js`;
        document.body.appendChild(s);
      }
    }).catch(() => {});
  }

  // Runner nicht erreichbar oder Token abgelehnt: die Katalogmeldung (Ursache und Abhilfe) bleibt im Banner stehen, die Prüfung wiederholt
  // sich alle 8 s an Ort und Stelle (kein Neuladen der Seite: sonst blitzt der Hinweis nur auf und die Ursache ist nicht zu lesen).
  let gesundheitVersuche = 0;
  function gesundheitPruefen() {
    transport.api('GET', '/api/health').then((r) => {
      if (gesundheitVersuche > 0) {
        $('banner').hidden = true;
        startFehler = '';
      }
      nameSetzen(r);
    }).catch((f) => {
      gesundheitVersuche += 1;
      startFehler = `${(f && f.message) || f}${f && f.code ? ` (${f.code})` : ''}`;
      $('verbindung').textContent = 'kein Runner';
      zeigeAktiv();
      $('banner').hidden = false;
      $('banner').textContent = `Kein Runner erreichbar: ${startFehler}`;
      setTimeout(gesundheitPruefen, 8000);
    });
  }
  gesundheitPruefen();

  async function start() {
    transport.oeffneStrom('strom', '/api/strom').catch(() => {});
    freigaben.start();
    const [konfig, mod] = await Promise.all([
      transport.api('GET', '/api/konfiguration').catch(() => null),
      transport.api('GET', '/api/modelle').catch(() => null),
      ladeListe(),
    ]).then((r) => [r[0], r[1]]);
    if (konfig && konfig.arbeitsbereiche && typeof konfig.arbeitsbereiche === 'object') bereiche = konfig.arbeitsbereiche;
    modelle = (mod && Array.isArray(mod.modelle) && mod.modelle) || (konfig && Array.isArray(konfig.modelle) && konfig.modelle) || [];
    planeZeichnen();
    werkbank.laeufeNeu(); // zeigt den Knopf „Läufe“ nur, wenn der Runner die Wege kennt
    const gemerkt = merken.lies();
    const root = gespraeche.find((g) => g.art === 'root') || gespraeche[0];
    const ziel = gemerkt && gespraeche.some((g) => String(g.id) === gemerkt) ? gemerkt : root && root.id;
    if (ziel === undefined || ziel === null || ziel === false) {
      $('banner').hidden = false;
      $('banner').textContent = 'Der Runner kennt noch keine Sitzung. Mit „Neue Sitzung“ beginnt eine.';
      return;
    }
    await wechsle(ziel);
  }
  start().catch((f) => {
    $('verbindung').textContent = 'kein Runner';
    $('banner').hidden = false;
    $('banner').textContent = `Start fehlgeschlagen: ${(f && f.message) || f}`;
  });
})();
