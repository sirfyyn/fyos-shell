/* Anbindung an den echten Runner: Transport (Tauri-Brücke oder HTTP am selben Ursprung), Verlauf laden, Strom lesen,
 * Ereignisse seriell in den Adapter geben, Freigaben, Senden, Stopp, Befehle, Verbindungs- und Stille-Anzeige.
 * Transport-Schnittstelle: api(methode, pfad, body) → Promise<json>; oeffneStrom(kanal, pfad); schliesseStrom(kanal); onStrom(cb).
 * Die Strom-Nutzlast hat dieselbe Form wie das Tauri-Ereignis `runner-strom`: { kanal, pfad, art, daten, wartezeitMs, fehler }.
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  // --- Transporte ---------------------------------------------------------------
  function tauriTransport(tauri) {
    // Rust meldet Fehler als Katalogmeldung { code, ursache, abhilfe, details }: daraus wird ein Error mit Ursache und Abhilfe im Text
    const alsFehler = (m) => (m && m.ursache ? Object.assign(new Error(`${m.ursache} ${m.abhilfe || ''}`.trim()), { meldung: m, code: m.code }) : m);
    const invoke = (b, a) => tauri.core.invoke(b, a || {}).catch((m) => { throw alsFehler(m); });
    return {
      art: 'tauri',
      api: (methode, pfad, koerper) => invoke('runner_anfrage', { methode, pfad, koerper: koerper === undefined ? null : koerper }),
      oeffneStrom: (kanal, pfad) => invoke('strom_oeffnen', { kanal, pfad }),
      schliesseStrom: (kanal) => invoke('strom_schliessen', { kanal }).catch(() => {}),
      onStrom: (cb) => tauri.event.listen('runner-strom', (e) => cb(e.payload)),
    };
  }

  /** HTTP am selben Ursprung (Prüfstand: ein Proxy hängt den Zugangsschlüssel an, die Seite kennt ihn nicht). */
  function httpTransport(basis, o) {
    o = o || {};
    const f = o.fetch || G.fetch.bind(G);
    const hoerer = new Set();
    const strome = new Map(); // kanal → { abbruch, pfad, stop }
    const sende = (p) => hoerer.forEach((cb) => cb(p));
    async function api(methode, pfad, koerper) {
      const r = await f(basis + pfad, { method: methode, headers: koerper === undefined || koerper === null ? {} : { 'Content-Type': 'application/json' }, body: koerper === undefined || koerper === null ? undefined : JSON.stringify(koerper) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.fehler || j.error || `HTTP ${r.status}`);
      return j;
    }
    async function lesen(kanal, pfad, st) {
      let versuch = 0;
      while (!st.stop) {
        const ac = new AbortController();
        st.abbruch = ac;
        try {
          const r = await f(basis + pfad, { signal: ac.signal, headers: { Accept: 'text/event-stream' } });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          sende({ kanal, pfad, art: 'verbunden' });
          versuch = 0;
          const leser = r.body.getReader();
          const dek = new TextDecoder();
          let puffer = '';
          for (;;) {
            const { done, value } = await leser.read();
            if (done) break;
            puffer += dek.decode(value, { stream: true });
            let i;
            while ((i = puffer.indexOf('\n\n')) >= 0) {
              const block = puffer.slice(0, i);
              puffer = puffer.slice(i + 2);
              const ev = /^event: (.+)$/m.exec(block);
              const da = /^data: (.+)$/m.exec(block);
              if (ev && da) {
                try {
                  sende({ kanal, pfad, art: ev[1], daten: JSON.parse(da[1]) });
                } catch (e) {
                  /* kaputte Zeile überspringen */
                }
              }
            }
          }
          throw new Error('Strom beendet');
        } catch (fehler) {
          if (st.stop) return;
          const warte = Math.min(15000, 1000 * 2 ** Math.min(versuch, 4)) / (o.tempo || 1);
          versuch++;
          sende({ kanal, pfad, art: 'getrennt', fehler: String((fehler && fehler.message) || fehler), wartezeitMs: warte });
          await new Promise((res) => setTimeout(res, warte));
        }
      }
    }
    return {
      art: 'http',
      api,
      oeffneStrom(kanal, pfad) {
        const alt = strome.get(kanal);
        if (alt) {
          alt.stop = true;
          alt.abbruch && alt.abbruch.abort();
        }
        const st = { stop: false, pfad };
        strome.set(kanal, st);
        lesen(kanal, pfad, st);
        return Promise.resolve();
      },
      schliesseStrom(kanal) {
        const st = strome.get(kanal);
        if (st) {
          st.stop = true;
          st.abbruch && st.abbruch.abort();
          strome.delete(kanal);
        }
      },
      onStrom(cb) {
        hoerer.add(cb);
        return () => hoerer.delete(cb);
      },
      /** Nur für Prüfungen: die Verbindung kappen, der Leser versucht von selbst neu. */
      kappe(kanal) {
        const st = strome.get(kanal);
        if (st && st.abbruch) st.abbruch.abort();
      },
    };
  }

  // --- Anzeige-Werte aus usage ---------------------------------------------------------
  function zahl(...w) {
    for (const x of w) if (typeof x === 'number' && Number.isFinite(x)) return x;
    return null;
  }
  /** usage (UsageDoc/usage_changed) → { ctx, fenster, tokIn, tokOut, kosten }; unbekannte Felder werden zu null. */
  function usageSicht(u) {
    if (!u || typeof u !== 'object') return {};
    if (u.models && typeof u.models === 'object') {
      // Runner (UsageDoc, usage_changed): { models: { 'rhea/rhea': { input, output, cacheRead, cacheWrite, totalTokens, cost: { total } } } }
      // Das UsageDoc des Runners ist die SUMME über die ganze Lebenszeit der Sitzung (pro Modell, jeder Modellaufruf zählt seinen ganzen Prompt
      // erneut). Daraus lässt sich die aktuelle Kontextfüllung nicht ablesen: `ctx` bleibt hier null. Die Füllung kommt aus der `usage` der
      // LETZTEN Antwort im Verlauf (runner-adapter.js, onKontext). Früher stand hier max(input, cacheWrite) der Summe: Millionen Token „Kontext“.
      let tokIn = 0;
      let tokOut = 0;
      let kosten = 0;
      for (const m of Object.values(u.models)) {
        tokIn += (m.input || 0) + (m.cacheRead || 0);
        tokOut += m.output || 0;
        kosten += (m.cost && m.cost.total) || 0;
      }
      return { ctx: null, fenster: null, tokIn, tokOut, kosten };
    }
    const t = u.totals || u.total || u;
    const c = u.context || {};
    return {
      ctx: zahl(c.tokens, c.used, u.contextTokens, u.contextUsed, u.lastContext, u.last && u.last.totalTokens, u.last && u.last.input),
      fenster: zahl(c.window, c.max, u.contextWindow, u.contextMax),
      tokIn: zahl(t.input, t.inputTokens, u.input),
      tokOut: zahl(t.output, t.outputTokens, u.output),
      kosten: zahl(t.cost && t.cost.total, typeof t.cost === 'number' ? t.cost : null, u.cost && u.cost.total, typeof u.cost === 'number' ? u.cost : null),
    };
  }
  /**
   * Was die Statuszeile zur Kontextfüllung zeigt. Nur ein plausibler Wert wird gezeigt: bekannt, nicht negativ und höchstens so groß wie das
   * Fenster (ein Prompt passt nie über das Fenster hinaus). Alles andere ist „–“ mit Erklärung im Titel, nie eine erfundene Zahl.
   * → { bekannt, text, titel, anteil (0..1), prozent, stufe: 'ok'|'warn'|'kritisch' }
   */
  function kontextAnzeige(ctx, fenster) {
    const zk = (n) => (FP.zahlK ? FP.zahlK(Math.round(n)) : String(Math.round(n)));
    const gut = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
    if (!gut(ctx)) return { bekannt: false, text: '–', titel: 'Kontext noch unbekannt (nach der nächsten Antwort des Agenten)', anteil: 0, prozent: 0, stufe: 'ok' };
    if (gut(fenster) && fenster > 0) {
      if (ctx > fenster) {
        return { bekannt: false, text: '–', titel: `Kontext nicht anzeigbar: gemeldeter Wert ${zk(ctx)} liegt über dem Fenster ${zk(fenster)}`, anteil: 0, prozent: 0, stufe: 'ok' };
      }
      const anteil = ctx / fenster;
      const prozent = Math.round(anteil * 100);
      return { bekannt: true, text: `${prozent} %`, titel: `Kontext ${zk(ctx)} von ${zk(fenster)}`, anteil, prozent, stufe: prozent >= 95 ? 'kritisch' : prozent >= 85 ? 'warn' : 'ok' };
    }
    return { bekannt: true, text: zk(ctx), titel: 'Kontext (Fenstergröße unbekannt)', anteil: 0, prozent: 0, stufe: 'ok' };
  }
  function modellName(agent) {
    const m = agent && agent.model;
    if (!m) return '';
    return typeof m === 'string' ? m : String(m.name || m.id || '');
  }

  // --- Regler -----------------------------------------------------------------------------
  /**
   * opts: spalte, scroller, zumEnde, ansage (Elemente), onStatus(status), reduceMotion(), darfFokus(), pace, stilleMs, jetzt()
   */
  function createEchtChat(transport, opts) {
    opts = opts || {};
    const jetzt = opts.jetzt || (() => Date.now());
    const S = {
      gespraeche: [],
      id: null,
      titel: '',
      modell: '',
      ctx: null,
      fenster: opts.fensterStandard || 128000, // Der Runner nennt die Fenstergröße noch nicht (/api/modelle hat kein contextWindow)
      tokIn: null,
      tokOut: null,
      kosten: null,
      verbunden: false,
      trennung: null,
      pausiert: false,
      busy: false,
      letzteAktivitaet: 0,
      stille: null,
      freigaben: [],
      modus: { umgehen: true, quelle: 'standard' },
    };
    const eingereiht = []; // { text, handle }
    let lauf = 0;
    let kette = Promise.resolve();
    let adapter = null;
    let zeitgeber = null;
    let abmelden = null;
    const status =() => opts.onStatus && opts.onStatus({ ...S, busy: view.busy, wartet: view.zustand().wartetAufFreigabe });
    const view = FP.createChatView(opts.spalte, {
      scroller: opts.scroller,
      zumEnde: opts.zumEnde,
      ansage: opts.ansage,
      pace: opts.pace,
      reduceMotion: opts.reduceMotion,
      darfFokus: opts.darfFokus,
      raf: opts.raf,
      setInterval: opts.setInterval,
      clearInterval: opts.clearInterval,
      setTimeout: opts.setTimeout,
      now: opts.now,
      onZustand: () => status(),
      onEntscheidung: () => {},
    });

    function neuerAdapter() {
      adapter = FP.createRunnerAdapter(view, {
        modell: S.modell,
        onEntscheidung: (id, wert, notiz) => entscheide(id, wert, notiz),
        // Kontextfüllung = Größe des letzten Prompts samt Antwort (usage der letzten Antwort); null nach leeren/verdichten bis zur nächsten Antwort
        onKontext: (tokens) => {
          S.ctx = tokens;
          status();
        },
        onUsage: (u) => {
          const s = usageSicht(u);
          if (s.ctx != null) S.ctx = s.ctx;
          if (s.fenster != null) S.fenster = s.fenster;
          if (s.tokIn != null) S.tokIn = s.tokIn;
          if (s.tokOut != null) S.tokOut = s.tokOut;
          if (s.kosten != null) S.kosten = s.kosten;
          status();
        },
        onAgent: (a) => {
          S.modell = modellName(a) || S.modell;
          status();
        },
        onHinweis: (text, fehler) => view.addNote(text, fehler ? 'fehler' : ''),
        befehlFuer: (id) => {
          const f = S.freigaben.find((x) => String(x.id) === String(id));
          return f ? f.befehl || '' : '';
        },
        vorMensch: (text) => {
          const i = eingereiht.findIndex((e) => e.text.trim() === text);
          if (i >= 0) eingereiht.splice(i, 1)[0].handle.entfernen();
        },
      });
    }

    async function ladeFreigaben() {
      try {
        const r = await transport.api('GET', '/api/freigaben');
        S.freigaben = Array.isArray(r.freigaben) ? r.freigaben : [];
        if (opts.beiFreigaben) opts.beiFreigaben(S.freigaben);
      } catch (e) {
        /* nächste Gelegenheit */
      }
    }
    async function entscheide(id, wert, notiz) {
      try {
        const r = await transport.api('POST', `/api/freigaben/${encodeURIComponent(id)}`, { entscheidung: wert === 'erlauben' ? 'erteilt' : 'abgelehnt', notiz: notiz || undefined, von: 'mensch' });
        if (Array.isArray(r.freigaben)) {
          S.freigaben = r.freigaben;
          if (opts.beiFreigaben) opts.beiFreigaben(S.freigaben);
        }
      } catch (f) {
        view.addNote(`Entscheidung nicht gespeichert: ${f.message || f}`, 'fehler');
      }
    }
    async function ladeHealth() {
      try {
        const h = await transport.api('GET', '/api/health');
        const w = h.pausiert ?? h.pause ?? h.spielmodus;
        S.pausiert = !!(w && typeof w === 'object' ? w.an ?? w.aktiv ?? w.pausiert : w === true || w === 'an');
        const pf = h.konfiguration && h.konfiguration.security && h.konfiguration.security.freigabePflicht;
        S.modus = { umgehen: true, quelle: 'runner', pflicht: Array.isArray(pf) ? pf : ['DESTRUCTIVE'] };
      } catch (e) {
        /* Anzeige bleibt */
      }
      status();
    }

    async function oeffne(id) {
      const mein = ++lauf;
      S.id = id;
      // Zahlen der vorigen Sitzung nicht stehen lassen
      S.ctx = null;
      S.tokIn = null;
      S.tokOut = null;
      S.kosten = null;
      view.clear();
      eingereiht.length = 0;
      neuerAdapter();
      transport.schliesseStrom('gespraech');
      const g = S.gespraeche.find((x) => String(x.id) === String(id));
      S.titel = (g && g.titel) || '';
      await ladeFreigaben();
      try {
        const a = await transport.api('GET', `/api/gespraech/${encodeURIComponent(id)}/ansicht?voll=1`);
        if (mein !== lauf) return;
        adapter.replay(a.entries || [], false);
        if (a.usage && adapter) {
          const s = usageSicht(a.usage);
          Object.assign(S, Object.fromEntries(Object.entries({ ctx: s.ctx, fenster: s.fenster, tokIn: s.tokIn, tokOut: s.tokOut, kosten: s.kosten }).filter(([, v]) => v != null)));
        }
        if (a.meta && a.meta.titel) S.titel = a.meta.titel;
        if (a.meta && a.meta.modell) S.modell = a.meta.modell;
      } catch (f) {
        view.addNote(`Verlauf nicht ladbar: ${f.message || f}`, 'fehler');
      }
      view.flush();
      view.folge.zumEnde();
      status();
      transport.oeffneStrom('gespraech', `/api/gespraech/${encodeURIComponent(id)}/ereignisse`).catch((f) => {
        S.trennung = { fehler: String(f), bis: jetzt() };
        status();
      });
    }

    /** Ein Strom-Ereignis; Ereignisse laufen strikt nacheinander (Freigaben holen zuerst den Befehl). */
    function beiStrom(p) {
      if (!p || typeof p !== 'object') return;
      if (p.kanal === 'gespraech') {
        if (S.id === null || p.pfad !== `/api/gespraech/${encodeURIComponent(S.id)}/ereignisse`) return;
        kette = kette.then(() => verarbeite(p)).catch(() => {});
      }
    }
    async function verarbeite(p) {
      S.letzteAktivitaet = jetzt();
      switch (p.art) {
        case 'verbunden':
          S.verbunden = true;
          S.trennung = null;
          break;
        case 'getrennt':
          S.verbunden = false;
          S.trennung = { fehler: p.fehler || '', bis: jetzt() + (p.wartezeitMs || 0) };
          break;
        case 'snapshot':
          S.verbunden = true;
          S.trennung = null;
          if ((p.daten.entries || []).some((e) => e && e.kind === 'fyos.freigabe')) await ladeFreigaben();
          adapter.snapshot(p.daten);
          if (p.daten.agent) S.modell = modellName(p.daten.agent) || S.modell;
          break;
        case 'ereignisse': {
          const liste = Array.isArray(p.daten) ? p.daten : [];
          if (liste.some((e) => e && e.type === 'entry_appended' && e.entry && e.entry.kind === 'fyos.freigabe')) await ladeFreigaben();
          for (const ev of liste) adapter.apply(ev);
          if (liste.some((e) => e && e.type === 'run_end')) {
            if (opts.beiLaufEnde) opts.beiLaufEnde(S.id);
            else setTimeout(() => ladeGespraeche(), 300);
          }
          break;
        }
        default:
          break;
      }
      status();
    }

    async function ladeGespraeche() {
      try {
        const r = await transport.api('GET', '/api/gespraeche');
        S.gespraeche = Array.isArray(r.gespraeche) ? r.gespraeche : [];
      } catch (e) {
        /* ... */
      }
    }

    // --- Aktionen -----------------------------------------------------------------------
    async function sende(text, sofort) {
      text = String(text || '').trim();
      if (!text || S.id === null) return { ok: false };
      const b = /^\/([a-zäöüß]+)(?:\s+(\S+))?$/i.exec(text);
      if (b) {
        const r = await befehl(b[1].toLowerCase(), b[2]);
        if (r !== null) return r;
      }
      const lauftSchon = view.busy;
      let handle = null;
      if (lauftSchon) {
        handle = view.addUserMessage({ text, queued: true });
        eingereiht.push({ text, handle });
      }
      try {
        await transport.api('POST', `/api/gespraech/${encodeURIComponent(S.id)}/nachricht`, { text, art: sofort ? 'steuern' : 'folgen', requestId: `agent-chat:${jetzt()}:${Math.random().toString(36).slice(2, 8)}` });
        S.letzteAktivitaet = jetzt();
      } catch (f) {
        if (handle) {
          handle.entfernen();
          eingereiht.pop();
        }
        view.addNote(`Nicht gesendet: ${f.message || f}`, 'fehler');
        return { ok: false, fehler: String(f.message || f) };
      }
      return { ok: true };
    }
    async function befehl(name, arg) {
      const pfad = (s) => `/api/gespraech/${encodeURIComponent(S.id)}/${s}`;
      try {
        if (name === 'verdichten') await transport.api('POST', pfad('verdichten'), {});
        else if (name === 'leeren' || name === 'neu') await transport.api('POST', pfad('leeren'), {});
        else if (name === 'abbrechen') await transport.api('POST', pfad('abbrechen'), {});
        else if (name === 'abzweigen') {
          const r = await transport.api('POST', pfad('zweig'), {});
          view.addNote('Abgezweigt: neues Gespräch angelegt');
          if (r.gespraech && r.gespraech.id !== undefined) {
            // mit Seitenleiste: die Sitzung wird dort geöffnet, diese hier bleibt unverändert erhalten
            if (opts.beiNeueSitzung) opts.beiNeueSitzung(r.gespraech.id);
            else {
              await ladeGespraeche();
              await oeffne(r.gespraech.id);
            }
          }
        } else return null;
        return { ok: true, befehl: name };
      } catch (f) {
        view.addNote(`/${name} fehlgeschlagen: ${f.message || f}`, 'fehler');
        return { ok: false };
      }
    }
    async function stopp() {
      if (S.id === null) return;
      try {
        await transport.api('POST', `/api/gespraech/${encodeURIComponent(S.id)}/abbrechen`, {});
      } catch (f) {
        view.addNote(`Stopp fehlgeschlagen: ${f.message || f}`, 'fehler');
      }
    }

    function stilleTakt() {
      const grenze = opts.stilleMs || 90000;
      const ms = jetzt() - S.letzteAktivitaet;
      const neu = view.busy && S.letzteAktivitaet && ms >= grenze && !view.zustand().wartetAufFreigabe ? { ms, text: `Seit ${FP.dauerText(ms)} nichts gemeldet.` } : null;
      if ((neu && neu.text) !== (S.stille && S.stille.text)) {
        S.stille = neu;
        status();
      }
    }

    /** `o.id`: genau dieses Gespräch öffnen (Seitenleiste); ohne: das Hauptgespräch. */
    async function start(o) {
      o = o || {};
      abmelden = transport.onStrom(beiStrom);
      await Promise.all([ladeGespraeche(), ladeHealth(), ladeFreigaben()]);
      const ziel = o.id !== undefined && o.id !== null ? { id: o.id } : S.gespraeche.find((g) => g.art === 'root') || S.gespraeche[0];
      if (!ziel) {
        view.addNote('Der Runner kennt noch kein Gespräch.', 'fehler');
        status();
        return;
      }
      await oeffne(ziel.id);
      zeitgeber = setInterval(stilleTakt, 5000);
    }
    /** Eine zurückgestellte Sitzung wieder anschließen: Strom öffnen, der Snapshot ergänzt nur, was inzwischen dazukam (nichts wird neu gebaut). */
    function aktiviere() {
      if (S.id === null) return Promise.resolve();
      S.stille = null;
      return transport.oeffneStrom('gespraech', `/api/gespraech/${encodeURIComponent(S.id)}/ereignisse`).catch((f) => {
        S.trennung = { fehler: String(f), bis: jetzt() };
        status();
      });
    }
    /** Zurückstellen: die Anzeige bleibt im Dokument, nur der Strom gehört jetzt der anderen Sitzung. */
    function ruhen() {
      S.verbunden = false;
    }
    function ende() {
      if (zeitgeber) clearInterval(zeitgeber);
      // tauriTransport.onStrom liefert ein Versprechen auf die Abmeldefunktion, httpTransport die Funktion selbst
      Promise.resolve(abmelden).then((f) => typeof f === 'function' && f()).catch(() => {});
      abmelden = null;
    }

    return { start, ende, aktiviere, ruhen, oeffne, sende, stopp, view, S, entscheide, stilleTakt, beiStrom, get adapter() { return adapter; }, warteAuf: () => kette };
  }

  Object.assign(FP, { tauriTransport, httpTransport, createEchtChat, usageSicht, kontextAnzeige, modellName });
})(typeof globalThis !== 'undefined' ? globalThis : window);
