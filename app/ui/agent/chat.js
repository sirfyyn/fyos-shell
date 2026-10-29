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
  const BEFEHLE = [
    { name: '/verdichten', hilfe: 'Verlauf verdichten' },
    { name: '/leeren', hilfe: 'Neuer Kontext, der Verlauf bleibt sichtbar' },
    { name: '/abzweigen', hilfe: 'Neues Gespräch ab dieser Stelle' },
    { name: '/abbrechen', hilfe: 'Laufenden Zug stoppen' },
  ];
  const MAX_ANSICHTEN = 8; // so viele Sitzungen bleiben aufgebaut; die am längsten nicht benutzte wird abgebaut (ihr Verlauf kommt beim Öffnen vom Runner zurück)
  const MERKE = 'fyos-agent-sitzung';

  const transport = window.__TAURI__ ? FP.tauriTransport(window.__TAURI__) : FP.httpTransport('');
  const tauriInvoke = window.__TAURI__ ? (b, a) => window.__TAURI__.core.invoke(b, a || {}) : null;
  // Rust meldet Fehler als Katalogmeldung { code, ursache, abhilfe }: für die Anzeige ein Error mit beidem im Text
  const alsFehler = (m) => (m && m.ursache ? Object.assign(new Error(`${m.ursache} ${m.abhilfe || ''}`.trim()), { code: m.code }) : m);
  let runnerArt = 'entfernt';
  const modus = FP.startModus($('modus'), $('modusMenue'), {});
  const aktivitaet = FP.sitzungen.createAktivitaet();

  let startFehler = '';
  let gespraeche = [];
  let bereiche = {};
  let modelle = [];
  const ansichten = new Map(); // String(id) → { id, chat, pane, benutzt, entwurf, cwd }
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
    $('modell').textContent = s.modell || '–';
    const m = $('kontext');
    if (s.ctx != null && s.fenster) {
      const an = Math.min(1, s.ctx / s.fenster);
      const pr = Math.round(an * 100);
      m.style.setProperty('--fuell', String(an));
      m.setAttribute('aria-valuenow', String(pr));
      m.dataset.stufe = pr >= 95 ? 'kritisch' : pr >= 85 ? 'warn' : 'ok';
      $('kontextText').textContent = `${pr} %`;
      $('kontextTitel').textContent = `Kontext ${zahl(s.ctx)} von ${zahl(s.fenster)}`;
    } else if (s.ctx != null) {
      m.style.setProperty('--fuell', '0');
      $('kontextText').textContent = zahl(s.ctx);
      $('kontextTitel').textContent = 'Kontext (Fenstergröße unbekannt)';
    }
    $('tokens').textContent = s.tokIn != null || s.tokOut != null ? `${zahl(s.tokIn || 0)} ein · ${zahl(s.tokOut || 0)} aus` : '';
    $('kosten').textContent = s.kosten != null ? `≈ ${s.kosten.toFixed(2).replace('.', ',')} €` : '';
    modus.zeichne(s.modus);
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
    if (aktiv === rec) zeigeOrdner(rec);
  }

  // --- Freigaben: Knopf mit Zahl im Kopf und Panel mit allen offenen Freigaben (alle Sitzungen) ---
  const freigaben = FP.createFreigaben(
    { knopf: $('freigabenKnopf'), zahl: $('freigabenZahl'), panel: $('freigabenPanel'), liste: $('freigabenListe'), zu: $('freigabenZu'), hinweis: $('freigabenHinweis'), banner: $('freigabenBanner') },
    {
      transport,
      // Sprung in die Sitzung der Freigabe: dieselbe Funktion wie in der Leiste, die Ansicht bleibt aufgebaut (kein Neuaufbau)
      beiSprung: (id) => wechsle(id),
      beiAenderung: () => zeigeAktiv(),
    }
  );

  // --- Seitenleiste ---
  // Sitzungen, die dieses Fenster archiviert hat: GET /api/gespraeche nennt archivierte nicht mehr, so bleibt „Wiederherstellen“ möglich (bis zum Neuladen)
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
    },
    { beiWahl: (id) => wechsle(id), beiUmbenennen: (id, text) => umbenenne(id, text), beiArchivieren: (id, an) => archiviere(id, an) }
  );

  /** Umbenennen (Leiste und Kopf): PATCH, dann Liste, Kopf und Ansicht der Sitzung nachziehen, ohne etwas neu aufzubauen. */
  async function umbenenne(id, text) {
    const r = await aenderung.umbenennen(id, text);
    const g = gespraeche.find((x) => String(x.id) === String(id));
    if (g) g.titel = r.titel;
    const a = archivLokal.get(String(id));
    if (a) a.titel = r.titel;
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
    } else {
      const g = archivLokal.get(schluessel);
      await aenderung.archivieren(id, false);
      archivLokal.delete(schluessel);
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
    const daten = FP.sitzungen.sitzungsListe(gespraeche, bereiche, aktivitaet, { laufend, archivLokal: [...archivLokal.values()] });
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
  let listeLaeuft = null;
  function ladeListe() {
    if (listeLaeuft) return listeLaeuft;
    listeLaeuft = transport
      .api('GET', '/api/gespraeche')
      .then((r) => {
        gespraeche = Array.isArray(r.gespraeche) ? r.gespraeche : [];
        planeZeichnen();
        if (aktiv) zeigeOrdner(aktiv);
      })
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
    const rec = { id, pane: d.pane, chat: null, benutzt: Date.now(), entwurf: '', cwd: undefined };
    rec.chat = FP.createEchtChat(transport, {
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
      beiLaufEnde: () => {
        setTimeout(ladeListe, 300);
        planeZeichnen();
      },
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
    waechst();
    merken.schreibe(rec.id);
    window.__aktuelleId = rec.id;
    zeigeAktiv();
    kopfStift();
    zeigeOrdner(rec);
    ladeOrdner(rec);
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
  async function senden(sofort) {
    const t = eingabe.value.trim();
    if (!t || !aktiv) return;
    const rec = aktiv;
    eingabe.value = '';
    rec.entwurf = '';
    waechst();
    schliesse();
    const r = await rec.chat.sende(t, sofort);
    if (r && r.ok === false && !r.befehl && aktiv === rec) eingabe.value = t;
  }

  // Schnellbefehle als Menü
  let m = null;
  function schliesse() {
    m = null;
    menue.hidden = true;
    menue.textContent = '';
    eingabe.setAttribute('aria-expanded', 'false');
    eingabe.removeAttribute('aria-activedescendant');
  }
  function zeichneMenue() {
    menue.textContent = '';
    m.items.forEach((it, i) => {
      const o = document.createElement('div');
      o.className = 'menue-punkt';
      o.id = `mp${i}`;
      o.setAttribute('role', 'option');
      o.setAttribute('aria-selected', i === m.index ? 'true' : 'false');
      const a = document.createElement('span');
      a.className = 'name';
      a.textContent = it.name;
      const b = document.createElement('span');
      b.className = 'hilfe';
      b.textContent = it.hilfe;
      o.append(a, b);
      o.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        m.index = i;
        uebernimm();
      });
      menue.appendChild(o);
    });
    menue.hidden = false;
    eingabe.setAttribute('aria-expanded', 'true');
    eingabe.setAttribute('aria-activedescendant', `mp${m.index}`);
  }
  function uebernimm() {
    eingabe.value = `${m.items[m.index].name} `;
    schliesse();
    waechst();
    eingabe.focus();
  }
  eingabe.addEventListener('input', () => {
    waechst();
    if (/^\/[a-zäöüß]*$/i.test(eingabe.value)) {
      const items = BEFEHLE.filter((b) => b.name.startsWith(eingabe.value.toLowerCase()));
      if (items.length) {
        m = { items, index: 0 };
        return zeichneMenue();
      }
    }
    schliesse();
  });
  eingabe.addEventListener('blur', schliesse);
  eingabe.addEventListener('keydown', (e) => {
    if (m) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        m.index = (m.index + (e.key === 'ArrowDown' ? 1 : m.items.length - 1)) % m.items.length;
        return zeichneMenue();
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        return uebernimm();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        return schliesse();
      }
    }
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
    if (e.key === 'F2' && !mod && !e.altKey && !e.shiftKey && aktiv) {
      e.preventDefault();
      kopfBearbeiten();
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
    eingabe.placeholder = `Nachricht an ${FP.anzeigename} …  /  für Befehle`;
    $('leisteFuss').textContent = h.geraet && h.geraet.name ? `${FP.anzeigename} auf ${h.geraet.name}` : '';
  }

  // Anderer Runner eingestellt (Einstellungen): neu starten, damit Verlauf und Ströme zum neuen Ziel gehören
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen('ziel-gewechselt', () => window.location.reload());
    // Tray-Zeile „Freigaben“: Rust holt das Fenster nach vorn und sagt hier, dass das Panel aufgehen soll
    window.__TAURI__.event.listen('freigaben-zeigen', () => freigaben.zeige(true));
  }
  window.addEventListener('focus', () => freigaben.lade());

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
  window.__arbeitsplatz = { wechsle, ansichten, ladeListe, aktivitaet, neuOeffnen, freigaben, get aktiv() { return aktiv; } };
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
