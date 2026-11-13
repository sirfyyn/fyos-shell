/* Runner-Ereignisse (gespraech-logik.js / pi-durable) → Renderer-Schnittstelle (chat-renderer.js).
 * Benutzt vom nativen Chat (agent-chat.html über echt.js). Wichtig: nur anhängen, nie neu bauen.
 * Darum merkt sich der Adapter, was schon gezeigt wurde (Eintrags-Ids, laufende Nachricht je Blockindex, gestartete Werkzeuge),
 * und gleicht nach einem Neuverbinden (Snapshot) nur den fehlenden Rest ab.
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  function inhaltText(inhalt) {
    if (typeof inhalt === 'string') return inhalt;
    if (!Array.isArray(inhalt)) return '';
    return inhalt
      .map((b) => (b && b.type === 'text' ? b.text || '' : b && b.type === 'image' ? '[Bild]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  const kurz = (s, n) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };

  /** Edit-Argumente → Diff. Unterstützt { path, oldText/newText }, { edits: [...] } und old_string/new_string. Ohne Zeilennummern (nur Ausschnitt bekannt). */
  function editPaare(args) {
    if (!args || typeof args !== 'object') return [];
    const paare = [];
    const nimm = (o) => {
      const alt = o.oldText ?? o.old_string ?? o.oldString ?? o.old_text;
      const neu = o.newText ?? o.new_string ?? o.newString ?? o.new_text;
      if (typeof alt === 'string' && typeof neu === 'string') paare.push([alt, neu]);
    };
    nimm(args);
    if (Array.isArray(args.edits)) args.edits.forEach((e) => e && typeof e === 'object' && nimm(e));
    return paare;
  }
  function diffAusEdit(args) {
    const paare = editPaare(args);
    if (!paare.length) return null;
    const hunks = paare.map(([a, n]) => ({ alt: null, neu: null, zeilen: FP.diffZeilen(a, n) }));
    return { datei: String(args.path || args.file_path || args.pfad || 'Datei'), hunks };
  }
  /**
   * Unified-Patch → Diff mit echten Zeilennummern ({ datei, hunks: [{ alt, neu, zeilen }] }). Der Runner liefert ihn am Ergebnis von `edit`
   * (`details.patch`: Kopfzeilen `---`/`+++`, Bereiche `@@ -a,b +c,d @@`). Unbekanntes Format: null, dann gilt der Diff aus der Werkzeugeingabe.
   */
  function diffAusPatch(patch, datei) {
    if (typeof patch !== 'string' || !patch.includes('@@')) return null;
    const hunks = [];
    let h = null;
    let restAlt = 0;
    let restNeu = 0;
    let name = datei ? String(datei) : '';
    for (const z of patch.split('\n')) {
      const kopf = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(z);
      if (kopf) {
        restAlt = kopf[2] === undefined ? 1 : Number(kopf[2]);
        restNeu = kopf[4] === undefined ? 1 : Number(kopf[4]);
        // ein leerer Bereich nennt die Zeile davor (0 bei einer neuen Datei): gezählt wird ab der nächsten
        h = { alt: Number(kopf[1]) + (restAlt === 0 ? 1 : 0), neu: Number(kopf[3]) + (restNeu === 0 ? 1 : 0), zeilen: [] };
        hunks.push(h);
        continue;
      }
      if (!h) {
        const m = !name && /^\+\+\+ (.+?)(?:\t.*)?$/.exec(z);
        if (m && m[1] !== '/dev/null') name = m[1].replace(/^b\//, '');
        continue;
      }
      if (z.startsWith('\\')) continue; // „\ No newline at end of file“
      if (restAlt <= 0 && restNeu <= 0) continue; // nach dem Ende des Bereichs (die letzte Leerzeile des Patches)
      const v = z === '' ? ' ' : z[0];
      if (v !== '+' && v !== '-' && v !== ' ') continue;
      h.zeilen.push([v, z.slice(1)]);
      if (v !== '+') restAlt -= 1;
      if (v !== '-') restNeu -= 1;
    }
    const mit = hunks.filter((x) => x.zeilen.length);
    return mit.length ? { datei: name || 'Datei', hunks: mit } : null;
  }

  /** Meldungen des Laufs in der Sprache der Ansicht; Unbekanntes bleibt, wie es ist. */
  function hinweisText(t) {
    let m = /^Tool call blocked: ([\s\S]*)$/.exec(t);
    if (m) return m[1];
    m = /^Output truncated(?: to its (beginning|end))?: (\d+) lines, (\d+) bytes dropped$/.exec(t);
    if (m) return `Ausgabe gekürzt${m[1] === 'beginning' ? ', der Anfang ist behalten' : m[1] === 'end' ? ', das Ende ist behalten' : ''}: ${m[2]} Zeilen, ${m[3]} Bytes weggelassen`;
    m = /^Full output: (.+)$/.exec(t);
    if (m) return `Ganze Ausgabe: ${m[1]}`;
    m = /^Command timed out after (.+) seconds$/.exec(t);
    if (m) return `Zeitlimit: nach ${m[1]} s abgebrochen`;
    if (t === 'Command aborted') return 'Befehl abgebrochen';
    return t;
  }

  /**
   * Der Lauf hängt seine Meldungen als letzten Textblock an ein Werkzeugergebnis (`<harness>` mit Zeilen „[stufe] text“): Exit-Code,
   * Kürzung, Hinweise der Wache, Abweisung. Die Ansicht zeigt sie getrennt von der Ausgabe.
   * → { text (ohne den Block), hinweise: [{ stufe: 'error'|'warn'|'info', text }], exit (Zahl oder null), abgewiesen }
   */
  function ausgabeTeile(text) {
    const s = typeof text === 'string' ? text : '';
    const m = /(?:^|\n)<harness>\n([\s\S]*?)\n<\/harness>\s*$/.exec(s);
    if (!m) return { text: s, hinweise: [], exit: null, abgewiesen: false };
    const roh = [];
    for (const z of m[1].split('\n')) {
      const k = /^\[(error|warn|info)\] ?(.*)$/.exec(z);
      if (k) roh.push({ stufe: k[1], text: k[2] });
      else if (roh.length) roh[roh.length - 1].text += `\n${z}`;
    }
    let exit = null;
    let abgewiesen = false;
    const hinweise = [];
    for (const h of roh) {
      const e = /^Command exited with code (-?\d+)$/.exec(h.text);
      if (e) {
        exit = Number(e[1]);
        continue;
      }
      if (h.text.startsWith('Tool call blocked: ')) abgewiesen = true;
      hinweise.push({ stufe: h.stufe, text: hinweisText(h.text) });
    }
    return { text: s.slice(0, m.index), hinweise, exit, abgewiesen };
  }

  /** Write-Aufruf → Diff mit lauter hinzugefügten Zeilen (bei langen Dateien nur die ersten `max`, Vorgabe 60). */
  function diffAusWrite(args, max) {
    if (!args || typeof args.content !== 'string') return null;
    const z = args.content.replace(/\n$/, '').split('\n');
    const zeilen = z.slice(0, max || 60).map((t) => ['+', t]);
    return { datei: String(args.path || args.file_path || 'Datei'), hunks: [{ alt: null, neu: 1, zeilen }] };
  }

  /**
   * Kontextfüllung aus der `usage` EINER Antwort (pi-ai: input, output, cacheRead, cacheWrite, totalTokens): der Prompt dieses Aufrufs samt
   * Antwort ist der Stand des Gesprächs danach. `totalTokens` zuerst, sonst die Summe der vier Teile; ohne verwertbare Zahl null
   * (abgebrochene oder fehlgeschlagene Antworten tragen Nullen und ändern die Anzeige nicht).
   */
  function kontextAusNutzung(u) {
    if (!u || typeof u !== 'object') return null;
    const n = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
    const t = n(u.totalTokens) || n(u.input) + n(u.output) + n(u.cacheRead) + n(u.cacheWrite);
    return t > 0 ? t : null;
  }

  /** Uhrzeit „17:31“ (Ortszeit) zu einem Zeitpunkt in Millisekunden; ohne gültige Zeit ''. */
  function uhrzeit(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /**
   * Die Zeile zu einem Zurückspulen (Eintrag `fyos.zurueck` des Runners): was mit Dateien und Gespräch geschah.
   * d: { art: 'stand'|'datei', gespraech, standZeit, dateien: [{ relativ, aktion }] }
   */
  function zurueckText(d) {
    d = d || {};
    const dateien = Array.isArray(d.dateien) ? d.dateien : [];
    const her = dateien.filter((x) => x && x.aktion === 'wiederhergestellt').length;
    const weg = dateien.filter((x) => x && x.aktion === 'geloescht').length;
    const offen = dateien.filter((x) => x && x.aktion === 'nicht_gesichert').length;
    const teile = [];
    if (her) teile.push(`${her} ${her === 1 ? 'Datei' : 'Dateien'} wiederhergestellt`);
    if (weg) teile.push(`${weg} gelöscht`);
    if (offen) teile.push(`${offen} nicht gesichert und unverändert`);
    const um = uhrzeit(d.standZeit);
    if (d.art === 'datei') {
      const erste = dateien.find((x) => x && (x.aktion === 'wiederhergestellt' || x.aktion === 'geloescht'));
      const name = erste && typeof erste.relativ === 'string' ? erste.relativ : '';
      return `${name ? `${kurz(name, 80)} zurückgenommen` : 'Datei zurückgenommen'}${erste && erste.aktion === 'geloescht' ? ' (gelöscht)' : ''} · das Gespräch ist unverändert`;
    }
    if (d.gespraech === true) return [`Zurückgesetzt auf den Stand${um ? ` von ${um}` : ''}`, ...teile, 'das Gespräch geht hier weiter'].join(' · ');
    return [`Dateien auf den Stand${um ? ` von ${um}` : ''} zurückgesetzt`, ...(teile.length ? teile : ['nichts zu ändern']), 'das Gespräch ist unverändert'].join(' · ');
  }

  /** Entscheidung des Runners (erteilt, abgelehnt, geaendert) in der Sprache der Ansicht. */
  const entscheidungsWert = (e) => (e === 'erteilt' ? 'erlauben' : e === 'geaendert' ? 'aendern' : 'ablehnen');

  /**
   * opts: modell, onEntscheidung(id, 'erlauben'|'ablehnen'|'aendern', notiz, { sitzung }), onUsage(usage), onKontext(tokens|null), onAgent(agent), onHinweis(text, fehler),
   *       befehlFuer(freigabeId) → Befehl oder '' (aus GET /api/freigaben), vorMensch(text) (entfernt eine eingereihte Blase)
   */
  /**
   * Der Runner meldet einen neuen Text- oder Denkblock als `text_start` / `thinking_start` mit dem Block selbst. Kommt das erste Stück
   * zusammen mit dem Blockanfang, steht es nur dort und nie als Delta: wer nur Deltas liest, verliert den Anfang, und der spätere
   * Abgleich mit der ganzen Nachricht hängt dann das Ende doppelt an. Hier wird der Anfangstext als Delta direkt hinter den Start
   * gestellt; was im selben Stapel noch als Delta folgt, wird abgezogen. Reicht der Runner das Delta schon selbst nach
   * (`ausBlockanfang`), bleibt die Liste, wie sie ist.
   */
  function mitBlockanfang(changes) {
    const liste = Array.isArray(changes) ? changes : [];
    if (!liste.some((c) => c && (c.type === 'text_start' || c.type === 'thinking_start'))) return liste;
    const aus = [];
    liste.forEach((c, i) => {
      aus.push(c);
      if (!c || (c.type !== 'text_start' && c.type !== 'thinking_start')) return;
      const feld = c.type === 'text_start' ? 'text' : 'thinking';
      const deltaTyp = c.type === 'text_start' ? 'text_delta' : 'thinking_delta';
      const danach = liste.slice(i + 1).filter((b) => b && b.type === deltaTyp && b.contentIndex === c.contentIndex);
      if (danach.some((b) => b.ausBlockanfang)) return;
      let anfang = String((c.block && c.block[feld]) || '');
      const folgt = danach.map((b) => String(b.delta || '')).join('');
      if (folgt && anfang.endsWith(folgt)) anfang = anfang.slice(0, anfang.length - folgt.length);
      if (anfang) aus.push({ type: deltaTyp, contentIndex: c.contentIndex, delta: anfang, ausBlockanfang: true });
    });
    return aus;
  }

  /**
   * Was vom ganzen Text noch fehlt, wenn `gezeigt` schon dasteht. Der Abgleich zählte früher nur Zeichen: fehlte dem Gezeigten ein
   * Stück vom Anfang, hängte er so viele Zeichen vom Ende noch einmal an. Jetzt zählt der Inhalt: steht das Gezeigte am Anfang, kommt
   * der Rest; steht es am Ende oder mittendrin (der Anfang ging verloren), kommt nur, was dahinter folgt; sonst das längste Stück, in
   * dem das Ende des Gezeigten in den Anfang des Ganzen übergeht.
   */
  function restNach(gezeigt, ganz) {
    if (!gezeigt) return ganz;
    if (ganz.startsWith(gezeigt)) return ganz.slice(gezeigt.length);
    const stelle = ganz.lastIndexOf(gezeigt);
    if (stelle >= 0) return ganz.slice(stelle + gezeigt.length);
    for (let n = Math.min(gezeigt.length, ganz.length); n > 0; n -= 1) {
      if (gezeigt.endsWith(ganz.slice(0, n))) return ganz.slice(n);
    }
    // nichts passt zusammen: lieber nichts anhängen als ein falsches Ende
    return ganz.length > gezeigt.length ? ganz.slice(gezeigt.length) : '';
  }

  function createRunnerAdapter(view, opts) {
    opts = opts || {};
    const bekannt = new Set(); // Eintrags-Ids: Wiederholungen (Snapshot, doppelte Zustellung) zeichnen nichts doppelt
    const werkzeuge = new Map(); // id → { name, args, beendet }
    const entscheidungen = new Map(); // Freigabe-Id → { wert, notiz } aus Entscheidungs-Einträgen
    const aufrufe = []; // beendete Datei-Werkzeuge der Sitzung (siehe merkeAufruf)
    const aufrufeVor = new Map(); // Kennung einer Nachricht des Menschen → Zahl der Datei-Werkzeuge davor (für das Zurückspulen)
    let denkt = false;
    let laeuft = false;
    let abspielen = 0; // > 0, solange ein Verlauf abgespielt wird (replay, snapshot): was dann endet, ist nicht eben geschehen
    let live = { texte: {}, denken: {} }; // schon gezeigter Text der laufenden Nachricht je Blockindex
    let argsVon = {}; // toolCall-Blöcke der laufenden Nachricht: id → arguments

    let vorab = {}; // Text aus dem Blockanfang je Blockindex, der auf das erste echte Stück wartet

    const neuesLive = () => {
      live = { texte: {}, denken: {} };
      vorab = {};
    };
    const sicherZug = () => {
      if (!laeuft) {
        view.startTurn({ modell: opts.modell });
        laeuft = true;
      }
    };
    let bittetEben = false; // in diesem Zug kam eine Freigabe-Bitte: sein Ende ist dann kein „fertig“
    let letzteZeit = null; // Zeit der letzten Nachricht des laufenden Zugs (für die Zeitmarke am Ende, wenn ein Verlauf abgespielt wird)
    // Wie die letzte Antwort des Modells endete (`stopReason`): „error“ nach allen Versuchen ist kein „fertig“, „aborted“ ein Stopp
    let zugEnde = null;
    const zugZu = (laufEnde) => {
      if (laeuft) {
        denkenZu();
        const ende = zugEnde && zugEnde.fehler ? { fehler: zugEnde.fehler } : zugEnde && zugEnde.abgebrochen ? { stopped: true } : {};
        // live endet der Zug jetzt; beim Abspielen gilt die Zeit der letzten Nachricht, ohne die bleibt die Marke weg
        view.endTurn(abspielen > 0 ? { ...ende, zeit: letzteZeit } : ende);
        laeuft = false;
        // der Lauf ist eben zu Ende und es wartet keine Freigabe (die hat ihren eigenen Moment); eine Nachricht mitten im Zug ist kein „fertig“
        if (laufEnde && abspielen === 0 && opts.onMoment && !bittetEben) opts.onMoment(ende.fehler ? 'fehler' : 'fertig');
      }
      bittetEben = false;
      letzteZeit = null;
      zugEnde = null;
    };
    const denkenZu = () => {
      if (denkt) {
        view.endThinking();
        denkt = false;
      }
    };
    const hinweis = (text, fehler) => {
      if (opts.onHinweis) opts.onHinweis(text, !!fehler);
      else view.addNote(text, fehler ? 'fehler' : '');
    };
    /** Wartezeile der Ansicht (nur live, nie beim Abspielen des Verlaufs): worauf der Agent wartet und seit wann. */
    const wartenAn = (text) => {
      if (typeof view.warte === 'function') view.warte(text || 'Wartet auf das Modell');
    };

    /** Beendete Datei-Werkzeuge (read, write, edit, multiedit, str_replace) in der Reihenfolge ihres Endes: Quelle des Änderungen-Panels (aenderungen.js). */
    const DATEI_WERKZEUGE = new Set(['read', 'write', 'edit', 'multiedit', 'str_replace']);
    const LESE_GRENZE = 400000; // längere Lese-Ergebnisse werden nicht behalten (die Vorschau zeigt ohnehin nur den Anfang)
    function merkeAufruf(id, w, status, output) {
      const n = String(w.name || '').toLowerCase();
      if (!DATEI_WERKZEUGE.has(n)) return;
      const a = { id, name: n, args: w.args || {}, status, output: n === 'read' && typeof output === 'string' && output.length <= LESE_GRENZE ? output : undefined };
      aufrufe.push(a);
      if (opts.onWerkzeug) opts.onWerkzeug(a);
    }

    function werkzeugStart(id, name, args, ts) {
      if (!id) return false;
      const schon = werkzeuge.get(id);
      if (schon) {
        // beim Streamen erscheinen die Argumente erst nach und nach: spätere, vollständigere übernehmen
        if (!schon.beendet && args && Object.keys(args).length) {
          schon.args = args;
          view.updateTool(id, { args });
        }
        return false;
      }
      sicherZug();
      denkenZu();
      werkzeuge.set(id, { name, args: args || {}, beendet: false, ts: ts || 0 });
      view.startTool({ id, name, args: args || {} });
      return true;
    }
    /**
     * `mehr`: was der Runner am Ergebnis mitliefert: `details` (bei `edit` der Patch mit echten Zeilennummern) und `durationMs` (gemessene
     * Dauer des Aufrufs). Fehlt es (älterer Runner, Snapshot), gelten der Diff aus der Eingabe und die Zeit zwischen den Zeitstempeln.
     */
    function werkzeugEnde(id, name, status, output, ts, mehr) {
      let w = werkzeuge.get(id);
      if (!w) {
        werkzeugStart(id, name, {});
        w = werkzeuge.get(id);
      }
      if (!w || w.beendet) return;
      w.beendet = true;
      // Meldungen des Laufs (Exit-Code, Kürzung, Hinweise, Abweisung) stehen getrennt von der Ausgabe
      const teile = ausgabeTeile(output);
      merkeAufruf(id, w, status, typeof output === 'string' ? teile.text : output);
      const n = String(w.name || '').toLowerCase();
      const pfad = w.args && (w.args.path || w.args.file_path || w.args.pfad);
      let diff;
      if (status !== 'fehler') {
        const patch = mehr && mehr.details && typeof mehr.details.patch === 'string' ? mehr.details.patch : null;
        if (n === 'edit' || n === 'multiedit' || n === 'str_replace') diff = (patch && diffAusPatch(patch, pfad)) || diffAusEdit(w.args);
        else if (n === 'write') diff = (patch && diffAusPatch(patch, pfad)) || diffAusWrite(w.args);
      }
      // jedes beendete Werkzeug mit Name und Zustand: Aufgabenliste und Läufe der Seitenleiste ziehen danach nach (werkbank.js).
      // `live`: eben geschehen, nicht aus einem abgespielten Verlauf (dann öffnet sich etwa die Browser-Fläche nicht von selbst).
      // `pfad` und `diff`: bei einem Datei-Werkzeug die Datei und, wenn es sie geändert hat, die Änderung (Fläche „Diff und Datei“).
      if (abspielen === 0 && opts.onMoment && status !== 'abgebrochen') opts.onMoment(status === 'fehler' ? 'fehler' : 'werkzeug');
      // bei bash der Befehl (gekürzt) und der Exit-Code: daraus liest der Abschluss des Zugs, ob Tests liefen (rueckmeldung.js abschlussSicht)
      const befehl = n === 'bash' && w.args && typeof w.args.command === 'string' ? w.args.command.slice(0, 400) : null;
      // der Lauf nennt den Exit-Code nur, wenn er nicht 0 ist (ausgabeTeile); ein fertiger Befehl ohne Angabe ist 0
      const exitCode = n !== 'bash' ? null : teile.exit != null ? teile.exit : status === 'fertig' ? 0 : null;
      if (opts.onWerkzeugEnde) opts.onWerkzeugEnde({ id, name: n, status, live: abspielen === 0, ...(typeof pfad === 'string' && pfad ? { pfad } : {}), ...(diff ? { diff } : {}), ...(befehl ? { befehl } : {}), ...(exitCode !== null ? { exit: exitCode } : {}) });
      const gemessen = mehr && typeof mehr.durationMs === 'number' && Number.isFinite(mehr.durationMs) && mehr.durationMs >= 0 ? mehr.durationMs : null;
      view.endTool(id, {
        status,
        output: typeof output === 'string' ? teile.text : output,
        diff: diff || undefined,
        dauerMs: gemessen != null ? gemessen : w.ts && ts ? Math.max(0, ts - w.ts) : undefined,
        hinweise: teile.hinweise,
        abgewiesen: teile.abgewiesen,
        // Exit-Code eines Befehls: der Lauf nennt ihn nur, wenn er nicht 0 ist
        ...(n === 'bash' ? { exit: teile.exit != null ? teile.exit : status === 'fertig' ? 0 : null } : {}),
      });
    }

    function eintrag(e) {
      if (!e) return;
      if (e.id !== undefined) {
        if (bekannt.has(e.id)) return;
        bekannt.add(e.id);
      }
      const kind = String(e.kind || '');
      const d = e.data || {};
      if (kind === 'pi.reset' || kind === 'pi.compaction') {
        zugZu();
        if (opts.onKontext) {
          const nach = kind === 'pi.compaction' ? d.nachher ?? d.tokensNachher : null;
          opts.onKontext(typeof nach === 'number' && nach > 0 ? nach : null); // nach dem Verdichten: Größe der Zusammenfassung, wenn der Runner sie nennt
        }
        view.addMarker({ kind, von: d.vorher ?? d.tokensVorher, nach: d.nachher ?? d.tokensNachher });
      } else if (kind === 'fyos.mensch') {
        zugZu();
        const t = String(d.text || '').trim();
        // Was der Runner dem Agenten selbst schreibt (Antwort auf einen Plan oder eine Freigabe), ist keine Nachricht des
        // Menschen: eine Marke zwischen den Zügen mit seiner kurzen Zeile (sonst dem ersten Satz); die Entscheidung steht an der Karte.
        if (d.von === 'runner') {
          const satz = String(d.kurz || '').trim() || (/^[\s\S]*?[.!?](?=\s|$)/.exec(t) || [t])[0];
          if (satz) view.addMarker({ kind: 'runner', text: kurz(satz, 120) });
          return;
        }
        if (opts.vorMensch) opts.vorMensch(t);
        // `kenn`: die Kennung des Eintrags; daran hängen Stand und Zurückspulen (Paket A5, dritter Teil)
        if (e.id !== undefined) aufrufeVor.set(String(e.id), aufrufe.length);
        // Anhänge der Nachricht (Paket A7): Bilder mit der kleinen Vorschau des Runners, Dateien mit Namen; eine Nachricht kann nur aus Anhängen bestehen
        const anhaenge = FP.wege && FP.wege.nachrichtAnhaenge ? FP.wege.nachrichtAnhaenge(d.anhaenge) : [];
        if (t || anhaenge.length) view.addUserMessage({ text: t, kenn: e.id, zeit: d.zeit, ...(anhaenge.length ? { anhaenge } : {}) });
      } else if (kind === 'fyos.zurueck') {
        // Der Mensch hat zurückgespult: was ab `ab` kam, zählt nicht mehr und steht blass da; darunter, was geschah
        zugZu();
        // Sind Dateien und Gespräch gemeinsam zurück, gelten auch die Datei-Werkzeuge ab dort nicht mehr (Panel „Änderungen der Sitzung“)
        const abHier = d.gespraech === true && Array.isArray(d.dateien) && d.dateien.length ? aufrufeVor.get(String(d.ab)) : undefined;
        if (abHier !== undefined && abHier < aufrufe.length) {
          aufrufe.length = abHier;
          if (opts.onWerkzeug) opts.onWerkzeug(null);
        }
        if (typeof view.addZurueck === 'function') view.addZurueck({ ab: d.gespraech === true ? d.ab : undefined, text: zurueckText(d) });
        else view.addNote(zurueckText(d));
        if (opts.onZurueck) opts.onZurueck({ gespraech: d.gespraech === true, live: abspielen === 0 });
      } else if (kind === 'fyos.freigabe') {
        sicherZug();
        const id = String(d.id);
        // Der Befehl einer Rückfrage steht am Eintrag selbst, sonst kennt ihn die Liste der Freigaben
        const bef = (typeof d.befehl === 'string' && d.befehl) || (opts.befehlFuer ? opts.befehlFuer(id) : '') || '';
        const istPlan = d.art === 'plan';
        const p = view.askApproval({
          id,
          aktion: d.aktion,
          // Ein Befehl steht ganz in der Karte: gekürzt wird nichts, was der Mensch erlauben soll. Ohne Befehl nennt `ziel` das Werkzeug.
          ...(bef ? { befehl: String(bef) } : { ziel: kurz(d.werkzeug || '', 160) }),
          risiko: d.risiko,
          kontext: d.kontext,
          werkzeug: d.werkzeug,
          // Plan des Agenten (Modus „planen“) und Rückfrage, die für die Sitzung gelten kann
          ...(istPlan ? { art: 'plan', plan: typeof d.plan === 'string' ? d.plan : '' } : {}),
          ...(d.sitzungMoeglich === true ? { sitzung: true } : {}),
        });
        const vorab = entscheidungen.get(id);
        if (!vorab && abspielen === 0) {
          bittetEben = true;
          if (opts.onMoment) opts.onMoment('braucht');
        }
        if (vorab) view.resolveApproval(id, vorab.wert, vorab.notiz, { sitzung: vorab.sitzung });
        // Nur was in diesem Fenster entschieden wurde, geht zum Runner; eine Entscheidung von dort (Panel, anderes Gerät) nicht noch einmal
        else p.then((w) => !w.extern && opts.onEntscheidung && opts.onEntscheidung(id, w.wert, w.notiz, { sitzung: !!w.sitzung }));
      } else if (kind === 'fyos.freigabe-entscheidung') {
        const wert = entscheidungsWert(d.entscheidung);
        entscheidungen.set(String(d.id), { wert, notiz: d.notiz || '', sitzung: d.sitzung === true });
        view.resolveApproval(String(d.id), wert, d.notiz || '', { sitzung: d.sitzung === true });
      } else if (kind === 'fyos.befehl') {
        // Ergebnis eines Befehls des Runners (/modell, /sitzung …): nur Anzeige, das Modell sieht es nicht
        zugZu();
        const t = String(d.text || '').trim();
        view.addNote(`/${d.name || ''}${t ? `: ${t}` : ''}`, d.ok === false ? 'befehl fehler' : 'befehl');
      } else if (kind === 'fyos.eingang') {
        if (d.quelle === 'job') {
          // Das Ende eines Befehls im Hintergrund steht als Marke zwischen den Zügen: die Meldung und ihre Zahlen (Code, Dauer), ohne den
          // Pfad des Protokolls und ohne die Ausgabe (beides zeigt die Tafel „Läufe“)
          zugZu();
          const zeilen = String(d.text || '').split('\n');
          const zahlen = String(zeilen[1] || '').replace(/,?\s*Log\s+\S.*$/, '').replace(/\.\s*$/, '');
          view.addMarker({ kind: 'job', text: kurz([zeilen[0], zahlen].filter(Boolean).join(' '), 240) });
          if (opts.onWerkzeugEnde) opts.onWerkzeugEnde({ id: null, name: 'job_ende', status: 'fertig' });
        } else view.addNote(`Eingang (${d.quelle || 'hub'}${d.von ? ` von ${d.von}` : ''}): ${kurz(d.text, 200)}`);
      } else if (kind === 'fyos.lauf.auftrag') {
        view.addNote(`Lauf ${d.lauf || ''}: ${d.titel || ''}`.trim());
      } else if (kind === 'fyos.hinweis') {
        // Der Runner hat selbst eingegriffen (Schleifenwache: derselbe Aufruf immer wieder, Zug angehalten): eine Marke zwischen
        // den Zügen mit seinem Satz. Nur Anzeige, das Modell sieht sie nicht.
        zugZu();
        const t = String(d.text || '').trim();
        if (t) view.addMarker({ kind: 'halt', text: kurz(t, 320) });
      }
    }

    /** Eine Nachricht aus dem Verlauf (oder dem Snapshot) zeigen; schon Gezeigtes der laufenden Nachricht wird nicht wiederholt. */
    function nachricht(m, abgleich) {
      if (!m) return;
      if (m.role === 'user') {
        zugZu();
        const t = inhaltText(m.content).trim();
        if (t) {
          if (opts.vorMensch) opts.vorMensch(t);
          view.addUserMessage({ text: t });
        }
      } else if (m.role === 'assistant') {
        sicherZug();
        if (typeof m.timestamp === 'number' && m.timestamp > 0) letzteZeit = m.timestamp;
        // die letzte Antwort zählt: ein gelungener Versuch nach einem Fehler macht den Zug wieder gut
        if (m.stopReason === 'error') zugEnde = { fehler: kurz(String(m.errorMessage || 'Das Modell hat nicht geantwortet'), 200) };
        else if (m.stopReason === 'aborted') zugEnde = { abgebrochen: true };
        else if (m.stopReason) zugEnde = null;
        const ktx = kontextAusNutzung(m.usage);
        if (ktx != null && opts.onKontext) opts.onKontext(ktx);
        const bloecke = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [];
        bloecke.forEach((b, i) => {
          if (!b) return;
          if (b.type === 'thinking' && b.thinking) {
            const rest = abgleich ? restNach(live.denken[i] || '', String(b.thinking)) : String(b.thinking);
            if (abgleich) live.denken[i] = String(b.thinking);
            if (rest || !abgleich) {
              if (!denkt) {
                view.startThinking();
                denkt = true;
              }
              if (rest) view.appendThinking(rest);
            }
            if (!abgleich) denkenZu();
          } else if (b.type === 'text' && b.text) {
            const rest = abgleich ? restNach(live.texte[i] || '', String(b.text)) : String(b.text);
            if (abgleich) live.texte[i] = String(b.text);
            if (rest) {
              denkenZu();
              view.appendText(rest);
            }
          } else if (b.type === "toolCall") werkzeugStart(b.id, b.name, b.arguments, m.timestamp);
        });
        // live bleibt: ein späterer Abgleich weiß, was schon gezeigt ist; neuesLive() setzt es zurück
      } else if (m.role === 'toolResult') {
        werkzeugEnde(m.toolCallId, m.toolName, m.isError ? 'fehler' : 'fertig', inhaltText(m.content), m.timestamp, { details: m.details, durationMs: m.durationMs });
      }
    }

    function apply(ev) {
      if (!ev || typeof ev !== 'object') return;
      switch (ev.type) {
        case 'turn_start':
        case 'run_start':
          sicherZug();
          // ab hier wartet der Agent auf das Modell, bis Inhalt kommt (der nimmt die Zeile von selbst weg)
          wartenAn();
          break;
        case 'message_start':
          if (ev.message && ev.message.role === 'assistant') {
            sicherZug();
            neuesLive();
            // die Startnachricht kann schon Inhalt tragen (erste Token): zeigen und merken
            nachricht(ev.message, true);
          }
          break;
        case 'message_update':
          sicherZug();
          for (const a of mitBlockanfang(ev.changes)) {
            const i = a.contentIndex;
            if (a.type === 'message' && a.message) {
              // vollständige Nachricht: nur den noch nicht gezeigten Rest anhängen
              nachricht(a.message, true);
            } else if (a.type === 'thinking_start') {
              if (!denkt) {
                view.startThinking();
                denkt = true;
              }
            } else if (a.type === 'thinking_delta') {
              if (!denkt) {
                view.startThinking();
                denkt = true;
              }
              live.denken[i] = (live.denken[i] || '') + String(a.delta || '');
              view.appendThinking(String(a.delta || ''));
            } else if (a.type === 'thinking_end') denkenZu();
            else if (a.type === 'text_start') denkenZu();
            else if (a.type === 'text_delta') {
              // Der Anfang aus dem Blockstart wartet auf das erste echte Stück und kommt mit ihm zusammen in die Ansicht: dazwischen
              // kann das Denken noch schließen, und ein einzeln gesetzter Anfang stünde dann als eigener Absatz da („Num“ / „mer …“).
              if (a.ausBlockanfang) {
                vorab[i] = (vorab[i] || '') + String(a.delta || '');
                continue;
              }
              // steht der Anfang schon da (die Startnachricht trug ihn), kommt er nicht noch einmal
              const anfang = vorab[i] && !(live.texte[i] || '').endsWith(vorab[i]) ? vorab[i] : '';
              const stueck = anfang + String(a.delta || '');
              vorab[i] = '';
              denkenZu();
              live.texte[i] = (live.texte[i] || '') + stueck;
              view.appendText(stueck);
            } else if (a.type === 'block' && a.block && a.block.type === 'toolCall') {
              argsVon[a.block.id] = a.block.arguments;
              const w = werkzeuge.get(a.block.id);
              if (w && !w.beendet) {
                w.args = a.block.arguments || w.args;
                view.updateTool(a.block.id, { args: w.args });
              }
            } else if (a.type === 'toolcall_start' && a.block && a.block.id) argsVon[a.block.id] = a.block.arguments || {};
          }
          break;
        case 'tool_execution_start': {
          const id = ev.toolCallId || ev.taskId;
          werkzeugStart(id, ev.toolName, ev.args && Object.keys(ev.args).length ? ev.args : argsVon[id]);
          break;
        }
        case 'tool_execution_update': {
          const o = ev.output || {};
          const id = ev.toolCallId || ev.taskId;
          if (typeof o.set === 'string') view.updateTool(id, { set: o.set });
          else if (typeof o.append === 'string') view.updateTool(id, { append: o.append });
          break;
        }
        case 'tool_execution_end': {
          const id = ev.toolCallId || ev.taskId;
          const m = ev.entry && ev.entry.model && ev.entry.model[0];
          const fehler = !!(ev.result && ev.result.isError) || !!(m && m.isError);
          const out = m ? inhaltText(m.content) : typeof ev.result === 'string' ? ev.result : ev.result && ev.result.content ? inhaltText(ev.result.content) : undefined;
          werkzeugEnde(id, ev.toolName, fehler ? 'fehler' : 'fertig', out, undefined, m ? { details: m.details, durationMs: m.durationMs } : { details: ev.result && ev.result.details });
          if (ev.entry && ev.entry.id !== undefined) bekannt.add(ev.entry.id);
          break;
        }
        case 'message_end':
          if (ev.entry) {
            const e = ev.entry;
            const kind = String(e.kind || '');
            const m = e.model && e.model[0];
            if (kind.startsWith('fyos.') || kind === 'pi.reset' || kind === 'pi.compaction') {
              eintrag(e);
              break;
            }
            if (e.id !== undefined && bekannt.has(e.id)) break;
            if (m && m.role === 'assistant') {
              // Rest nachtragen, falls Updates verloren gingen (Verbindungsabbruch mitten in der Nachricht)
              nachricht(m, true);
              neuesLive();
              denkenZu();
            } else if (m) nachricht(m, false);
            if (e.id !== undefined) bekannt.add(e.id);
          }
          break;
        case 'entry_appended':
          eintrag(ev.entry);
          break;
        case 'turn_end':
          break; // ein Lauf hat mehrere Züge (Modell, Werkzeug, Modell): die Antwort bleibt bis run_end eine
        case 'run_end':
          zugZu(true);
          break;
        case 'compaction_start':
          hinweis('Verlauf wird verdichtet …', false);
          break;
        case 'compaction_end':
          if (ev.error) hinweis(`Verdichten fehlgeschlagen: ${(ev.error && ev.error.message) || ev.error}`, true);
          break;
        case 'auto_retry_start':
          hinweis(`Das Modell antwortet nicht, neuer Versuch ${ev.attempt || ''}`.trim(), false);
          // die Zeit zählt für den neuen Versuch von vorn
          wartenAn(`Wartet auf das Modell${ev.attempt ? `, Versuch ${ev.attempt}` : ''}`);
          break;
        case 'task_failed':
          hinweis(`Aufgabe fehlgeschlagen: ${ev.message || ev.kind || ''}`.trim(), true);
          break;
        case 'usage_changed':
          if (opts.onUsage) opts.onUsage(ev.usage);
          break;
        case 'agent_changed':
          if (opts.onAgent) opts.onAgent(ev.agent);
          break;
        case 'snapshot':
          snapshot(ev);
          break;
        default:
          break;
      }
    }

    /** Snapshot nach (Neu-)Verbinden: Unbekanntes anhängen, laufende Nachricht abgleichen, Zug zu, wenn nichts mehr läuft. Nichts wird neu gebaut. */
    function snapshot(snap) {
      if (!snap || typeof snap !== 'object') return;
      replay(snap.entries || [], true);
      const msg = snap.generation && snap.generation.message;
      const aktiv = !!(snap.run || snap.generation);
      if (msg && msg.role === 'assistant') nachricht(msg, true);
      for (const t of [...(snap.tools || []), ...(snap.nestedTools || [])]) {
        const id = t.callId || t.taskId;
        if (id && !werkzeuge.has(id)) werkzeugStart(id, t.name, t.arguments);
        if (id && t.status === 'done' && werkzeuge.has(id)) werkzeugEnde(id, t.name, 'fertig', typeof t.output === 'string' ? t.output : undefined);
        else if (id && typeof t.output === 'string' && t.output && werkzeuge.get(id) && !werkzeuge.get(id).beendet && !werkzeuge.get(id).ausgabeGezeigt) {
          werkzeuge.get(id).ausgabeGezeigt = true;
          view.updateTool(id, { set: t.output });
        }
      }
      if (!aktiv && laeuft) zugZu();
      // Läuft der Zug noch, ohne dass gerade ein Werkzeug oder eine Antwort zu sehen ist (ein Aufruf wartet auf den Menschen),
      // bleibt die Ansicht im Zug: „Stopp“ und „Einreihen“ gelten weiter.
      else if (aktiv) sicherZug();
      // Eine Modellanfrage ist unterwegs und hat noch nichts geliefert: die Wartezeile gilt auch nach dem Neuverbinden
      if (snap.generation && !msg) wartenAn();
      if (snap.usage && opts.onUsage) opts.onUsage(snap.usage);
      if (snap.agent && opts.onAgent) opts.onAgent(snap.agent);
    }

    /** Fertigen Verlauf (Einträge) anhängen: Nutzer, Antworten mit Denken/Text/Werkzeugen, Marker, Freigaben. Bekanntes wird übersprungen. */
    function replay(entries, mitteImLauf) {
      abspielen += 1;
      try {
        verlaufAnhaengen(entries, mitteImLauf);
      } finally {
        abspielen -= 1;
      }
    }
    function verlaufAnhaengen(entries, mitteImLauf) {
      // Entscheidungen vorab einsammeln: Freigaben, über die schon entschieden ist, erscheinen gleich entschieden
      for (const e of entries || []) if (e && e.kind === 'fyos.freigabe-entscheidung' && e.data) entscheidungen.set(String(e.data.id), { wert: entscheidungsWert(e.data.entscheidung), notiz: e.data.notiz || '', sitzung: e.data.sitzung === true });
      for (const e of entries || []) {
        if (!e) continue;
        const kind = String(e.kind || '');
        if (kind === 'fyos.freigabe-entscheidung') {
          eintrag(e);
          continue;
        }
        if (kind.startsWith('fyos.') || kind === 'pi.reset' || kind === 'pi.compaction') {
          if ((kind === 'pi.reset' || kind === 'pi.compaction') && opts.onKontext) opts.onKontext(null); // die Füllung davor gilt nicht mehr
          const msgs0 = Array.isArray(e.model) ? e.model : e.model ? [e.model] : [];
          // Das Ende eines Befehls im Hintergrund bleibt auch nach dem Neuladen als Zeile stehen (live erscheint es ohnehin)
          const jobEnde = kind === 'fyos.eingang' && e.data && e.data.quelle === 'job';
          if (kind === 'fyos.mensch' || !msgs0.length || kind.startsWith('fyos.freigabe') || jobEnde) {
            eintrag(e);
            continue;
          }
          if (e.id !== undefined) bekannt.add(e.id); // fyos.* mit eigener Nutzernachricht: nicht als Blase
          continue;
        }
        if (e.id !== undefined) {
          if (bekannt.has(e.id)) continue;
          bekannt.add(e.id);
        }
        const msgs = Array.isArray(e.model) ? e.model : e.model ? [e.model] : [];
        for (const m of msgs) {
          nachricht(m, !!mitteImLauf && laeuft);
          if (m && m.role === 'assistant') neuesLive();
        }
      }
      // Wartet noch ein Aufruf auf die Entscheidung des Menschen (Rückfrage des Runners), ist der Zug nicht zu Ende: die Antwort
      // bleibt offen, bis der Runner meldet, was läuft (snapshot).
      const wartetNoch = (entries || []).some((e) => e && e.kind === 'fyos.freigabe' && e.data && e.data.wartet === true && !entscheidungen.has(String(e.data.id)));
      if (!mitteImLauf && !wartetNoch) zugZu();
    }

    return { apply, replay, eintrag, snapshot, diffAusEdit, aufrufe: () => aufrufe.slice(), get laeuft() { return laeuft; }, get bekannt() { return bekannt; } };
  }

  FP.createRunnerAdapter = createRunnerAdapter;
  FP.mitBlockanfang = mitBlockanfang;
  FP.restNach = restNach;
  FP.kontextAusNutzung = kontextAusNutzung;
  FP.diffAusEdit = diffAusEdit;
  FP.diffAusWrite = diffAusWrite;
  FP.diffAusPatch = diffAusPatch;
  FP.ausgabeTeile = ausgabeTeile;
  FP.editPaare = editPaare;
  FP.uhrzeit = uhrzeit;
  FP.zurueckText = zurueckText;
})(typeof globalThis !== 'undefined' ? globalThis : window);
