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

  /**
   * opts: modell, onEntscheidung(id, 'erlauben'|'ablehnen', notiz), onUsage(usage), onKontext(tokens|null), onAgent(agent), onHinweis(text, fehler),
   *       befehlFuer(freigabeId) → Befehl oder '' (aus GET /api/freigaben), vorMensch(text) (entfernt eine eingereihte Blase)
   */
  function createRunnerAdapter(view, opts) {
    opts = opts || {};
    const bekannt = new Set(); // Eintrags-Ids: Wiederholungen (Snapshot, doppelte Zustellung) zeichnen nichts doppelt
    const werkzeuge = new Map(); // id → { name, args, beendet }
    const entscheidungen = new Map(); // Freigabe-Id → { wert, notiz } aus Entscheidungs-Einträgen
    const aufrufe = []; // beendete Datei-Werkzeuge der Sitzung (siehe merkeAufruf)
    let denkt = false;
    let laeuft = false;
    let live = { texte: {}, denken: {} }; // schon gezeigter Text der laufenden Nachricht je Blockindex
    let argsVon = {}; // toolCall-Blöcke der laufenden Nachricht: id → arguments

    const neuesLive = () => {
      live = { texte: {}, denken: {} };
    };
    const sicherZug = () => {
      if (!laeuft) {
        view.startTurn({ modell: opts.modell });
        laeuft = true;
      }
    };
    const zugZu = () => {
      if (laeuft) {
        denkenZu();
        view.endTurn({});
        laeuft = false;
      }
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
    function werkzeugEnde(id, name, status, output, ts) {
      let w = werkzeuge.get(id);
      if (!w) {
        werkzeugStart(id, name, {});
        w = werkzeuge.get(id);
      }
      if (!w || w.beendet) return;
      w.beendet = true;
      merkeAufruf(id, w, status, output);
      let diff;
      if (status !== 'fehler') {
        const n = String(w.name || '').toLowerCase();
        diff = n === 'edit' || n === 'multiedit' || n === 'str_replace' ? diffAusEdit(w.args) : n === 'write' ? diffAusWrite(w.args) : undefined;
      }
      view.endTool(id, { status, output, diff: diff || undefined, dauerMs: w.ts && ts ? Math.max(0, ts - w.ts) : undefined });
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
        if (opts.vorMensch) opts.vorMensch(t);
        if (t) view.addUserMessage({ text: t });
      } else if (kind === 'fyos.freigabe') {
        sicherZug();
        const id = String(d.id);
        const bef = opts.befehlFuer ? opts.befehlFuer(id) : '';
        const ziel = bef || d.werkzeug || '';
        const p = view.askApproval({ id, aktion: d.aktion, ziel: kurz(ziel, 160), risiko: d.risiko, kontext: d.kontext, werkzeug: d.werkzeug });
        const vorab = entscheidungen.get(id);
        if (vorab) view.resolveApproval(id, vorab.wert, vorab.notiz);
        else p.then((w) => opts.onEntscheidung && opts.onEntscheidung(id, w.wert, w.notiz));
      } else if (kind === 'fyos.freigabe-entscheidung') {
        const wert = d.entscheidung === 'erteilt' ? 'erlauben' : 'ablehnen';
        entscheidungen.set(String(d.id), { wert, notiz: d.notiz || '' });
        view.resolveApproval(String(d.id), wert, d.notiz || '');
      } else if (kind === 'fyos.eingang') {
        view.addNote(`Eingang (${d.quelle || 'hub'}${d.von ? ` von ${d.von}` : ''}): ${kurz(d.text, 200)}`);
      } else if (kind === 'fyos.lauf.auftrag') {
        view.addNote(`Lauf ${d.lauf || ''}: ${d.titel || ''}`.trim());
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
        const ktx = kontextAusNutzung(m.usage);
        if (ktx != null && opts.onKontext) opts.onKontext(ktx);
        const bloecke = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [];
        bloecke.forEach((b, i) => {
          if (!b) return;
          if (b.type === 'thinking' && b.thinking) {
            const schon = abgleich ? (live.denken[i] || '').length : 0;
            const rest = String(b.thinking).slice(schon);
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
            const schon = abgleich ? (live.texte[i] || '').length : 0;
            const rest = String(b.text).slice(schon);
            if (abgleich) live.texte[i] = String(b.text);
            if (rest) {
              denkenZu();
              view.appendText(rest);
            }
          } else if (b.type === "toolCall") werkzeugStart(b.id, b.name, b.arguments, m.timestamp);
        });
        // live bleibt: ein späterer Abgleich weiß, was schon gezeigt ist; neuesLive() setzt es zurück
      } else if (m.role === 'toolResult') {
        werkzeugEnde(m.toolCallId, m.toolName, m.isError ? 'fehler' : 'fertig', inhaltText(m.content), m.timestamp);
      }
    }

    function apply(ev) {
      if (!ev || typeof ev !== 'object') return;
      switch (ev.type) {
        case 'turn_start':
        case 'run_start':
          sicherZug();
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
          for (const a of ev.changes || []) {
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
              denkenZu();
              live.texte[i] = (live.texte[i] || '') + String(a.delta || '');
              view.appendText(String(a.delta || ''));
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
          werkzeugEnde(id, ev.toolName, fehler ? 'fehler' : 'fertig', out);
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
          zugZu();
          break;
        case 'compaction_start':
          hinweis('Verlauf wird verdichtet …', false);
          break;
        case 'compaction_end':
          if (ev.error) hinweis(`Verdichten fehlgeschlagen: ${(ev.error && ev.error.message) || ev.error}`, true);
          break;
        case 'auto_retry_start':
          hinweis(`Das Modell antwortet nicht, neuer Versuch ${ev.attempt || ''}`.trim(), false);
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
      if (snap.usage && opts.onUsage) opts.onUsage(snap.usage);
      if (snap.agent && opts.onAgent) opts.onAgent(snap.agent);
    }

    /** Fertigen Verlauf (Einträge) anhängen: Nutzer, Antworten mit Denken/Text/Werkzeugen, Marker, Freigaben. Bekanntes wird übersprungen. */
    function replay(entries, mitteImLauf) {
      // Entscheidungen vorab einsammeln: Freigaben, über die schon entschieden ist, erscheinen gleich entschieden
      for (const e of entries || []) if (e && e.kind === 'fyos.freigabe-entscheidung' && e.data) entscheidungen.set(String(e.data.id), { wert: e.data.entscheidung === 'erteilt' ? 'erlauben' : 'ablehnen', notiz: e.data.notiz || '' });
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
          if (kind === 'fyos.mensch' || !msgs0.length || kind.startsWith('fyos.freigabe')) {
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
      if (!mitteImLauf) zugZu();
    }

    return { apply, replay, eintrag, snapshot, diffAusEdit, aufrufe: () => aufrufe.slice(), get laeuft() { return laeuft; }, get bekannt() { return bekannt; } };
  }

  FP.createRunnerAdapter = createRunnerAdapter;
  FP.kontextAusNutzung = kontextAusNutzung;
  FP.diffAusEdit = diffAusEdit;
  FP.diffAusWrite = diffAusWrite;
  FP.editPaare = editPaare;
})(typeof globalThis !== 'undefined' ? globalThis : window);
