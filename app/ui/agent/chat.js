/* Nativer Chat (agent-chat.html): Verdrahtung von Eingabe, Statuszeile und Menüs mit prototyp/echt.js.
 * Im Tauri-Fenster über die Brücke (runner_anfrage, strom_oeffnen, Ereignis runner-strom); sonst (Prüfstand, Browser) per HTTP
 * am selben Ursprung, wo ein Proxy den Zugangsschlüssel anhängt.
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

  const transport = window.__TAURI__ ? FP.tauriTransport(window.__TAURI__) : FP.httpTransport('');
  const modus = FP.startModus($('modus'), $('modusMenue'), {});

  let startFehler = '';
  // Kopfzustand an Rust melden (Tray), nur bei Änderung
  let gemeldet = '';
  function meldeZustand(art, arbeitet) {
    const schluessel = `${art}|${arbeitet ? 1 : 0}`;
    if (!window.__TAURI__ || schluessel === gemeldet) return;
    gemeldet = schluessel;
    window.__TAURI__.core.invoke('zustand_melden', { art: art === 'wartet' ? 'wartet' : art, arbeitet: !!arbeitet }).catch(() => {});
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

  const chat = FP.createEchtChat(transport, {
    spalte: $('spalte'),
    scroller: $('verlauf'),
    zumEnde: $('zumEnde'),
    ansage: $('ansage'),
    reduceMotion: () => mq.matches,
    darfFokus: () => !eingabe.value && document.activeElement !== eingabe,
    onStatus: zeige,
  });
  setInterval(() => zeige({ ...chat.S, busy: chat.view.busy, wartet: chat.view.zustand().wartetAufFreigabe }), 1000);

  function waechst() {
    eingabe.style.height = 'auto';
    eingabe.style.height = `${Math.min(200, eingabe.scrollHeight)}px`;
  }
  async function senden(sofort) {
    const t = eingabe.value.trim();
    if (!t) return;
    eingabe.value = '';
    waechst();
    schliesse();
    const r = await chat.sende(t, sofort);
    if (r && r.ok === false && !r.befehl) eingabe.value = t;
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
  $('stopp').addEventListener('click', () => chat.stopp());
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const a = document.activeElement;
    const tippt = (a === eingabe && eingabe.value.length > 0) || (a && a.tagName === 'INPUT');
    if (!tippt && chat.view.handleKey(e)) return;
    if (e.key === 'Escape' && chat.view.busy) {
      e.preventDefault();
      chat.stopp();
    }
  });

  // Fehlerbericht (Textdatei auf den Schreibtisch, ohne Geheimnisse, nichts wird hochgeladen)
  $('bericht').addEventListener('click', async () => {
    if (!window.__TAURI__) return;
    try {
      const pfad = await window.__TAURI__.core.invoke('bericht_speichern', { meldung: null });
      chat.view.addNote(`Bericht gespeichert: ${pfad} (ohne Passwörter; es wurde nichts hochgeladen).`);
    } catch (m) {
      chat.view.addNote(`Bericht nicht gespeichert: ${(m && m.ursache) || (m && m.message) || m}`, 'fehler');
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
  }

  // Anderer Runner eingestellt (Einstellungen): neu starten, damit Verlauf und Ströme zum neuen Ziel gehören
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen('ziel-gewechselt', () => window.location.reload());
  }

  window.__chat = chat;
  // Prüfskript (tools/e2e_agent.py): nur wenn Rust es erlaubt (Debug-Bau mit gesetzter Umgebung), nie im Betrieb
  if (window.__TAURI__) {
    window.__TAURI__.core.invoke('ziel_info').then((i) => {
      if (i && i.e2e) {
        const s = document.createElement('script');
        s.src = 'e2e.js';
        document.body.appendChild(s);
      }
    }).catch(() => {});
  }
  transport.api('GET', '/api/health').then(nameSetzen).catch((f) => {
    // Runner nicht erreichbar oder Token abgelehnt: die Katalogmeldung (Ursache und Abhilfe) bleibt im Banner, die Seite versucht es alle 8 s neu
    startFehler = `${(f && f.message) || f}${f && f.code ? ` (${f.code})` : ''}`;
    $('verbindung').textContent = 'kein Runner';
    setTimeout(() => window.location.reload(), 8000);
  });
  chat.start().catch((f) => {
    $('verbindung').textContent = 'kein Runner';
    chat.view.addNote(`Start fehlgeschlagen: ${(f && f.message) || f}`, 'fehler');
  });
})();
