/* Git je Sitzung (Runner src/arbeitsbaum.js, L10): ein Kasten oben in der Tafel „Änderungen“. Er zeigt Zweig, Commits seit dem
 * Anlegen und geänderte Dateien des eigenen Arbeitsbaums der Sitzung, und er committet und legt einen PR an, beides nur auf Klick.
 *
 *   FP.git = { createGitKasten, gitBereinigen, standText }
 *
 * Gelesen wird über runner-wege.js (`wege.git`), geschrieben (Commit, PR) über den Transport wie in staende-tafel.js. Texte nur als textContent.
 * Der PR pusht den Zweig: deshalb fragt der Knopf ein zweites Mal („Pushen und PR anlegen?“), bevor er etwas tut.
 */
(() => {
  'use strict';
  const FP = (window.FyosPrototyp = window.FyosPrototyp || {});
  const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

  /** Antwort von GET /api/gespraech/<id>/git: nur bekannte Felder. */
  function gitBereinigen(r) {
    r = r && typeof r === 'object' ? r : {};
    return {
      zweig: text(r.zweig, 200),
      kopf: text(r.kopf, 40),
      voraus: Number.isFinite(r.voraus) ? Math.max(0, Math.trunc(r.voraus)) : null,
      sauber: r.sauber === true,
      dateien: (Array.isArray(r.dateien) ? r.dateien : []).filter((d) => d && typeof d.pfad === 'string').slice(0, 200).map((d) => ({ zustand: text(d.zustand, 2) || '?', pfad: d.pfad.slice(0, 500) })),
      fernzweig: text(r.fernzweig, 200) || null,
    };
  }

  /** Eine Zeile über den Stand: „agent/s4-x · 2 Commits · 3 Dateien geändert“. */
  function standText(s) {
    const teile = [s.zweig || 'Zweig unbekannt'];
    if (s.voraus !== null) teile.push(s.voraus === 1 ? '1 Commit' : `${s.voraus} Commits`);
    teile.push(s.sauber ? 'nichts offen' : s.dateien.length === 1 ? '1 Datei geändert' : `${s.dateien.length} Dateien geändert`);
    if (s.fernzweig) teile.push(`gepusht: ${s.fernzweig}`);
    return teile.join(' · ');
  }

  /**
   * el: { kasten, stand, nachricht, commit, pr, meldung }   opts: { wege, transport, sitzung: () => id|null, titel?: () => text }
   */
  function createGitKasten(el, opts) {
    let stand = null;
    let prBereit = false;
    let laeuft = false;
    const melde = (t, fehler) => {
      el.meldung.textContent = t || '';
      el.meldung.hidden = !t;
      el.meldung.classList.toggle('gk-fehler', !!fehler);
    };
    function zeichne() {
      el.kasten.hidden = !stand;
      if (!stand) return;
      el.stand.textContent = standText(stand);
      el.commit.disabled = laeuft || stand.sauber || !el.nachricht.value.trim();
      el.pr.disabled = laeuft || !stand.sauber || stand.voraus === 0;
      el.pr.textContent = prBereit ? 'Wirklich pushen und PR anlegen?' : 'PR anlegen';
      el.pr.title = stand.sauber ? 'Den Zweig pushen und einen Pull Request anlegen' : 'Erst committen';
    }
    async function neu() {
      const id = opts.sitzung();
      if (id === null || id === undefined) {
        stand = null;
        return zeichne();
      }
      try {
        stand = gitBereinigen(await opts.wege.git(id));
      } catch (f) {
        stand = null; // 404: diese Sitzung hat keinen eigenen Arbeitsbaum, oder der Runner kennt Git nicht
      }
      zeichne();
    }
    el.nachricht.addEventListener('input', zeichne);
    el.commit.addEventListener('click', async () => {
      const id = opts.sitzung();
      const n = el.nachricht.value.trim();
      if (!n || laeuft) return;
      laeuft = true;
      zeichne();
      try {
        const r = await opts.transport.api('POST', `/api/gespraech/${encodeURIComponent(id)}/git/commit`, { nachricht: n.slice(0, 4000) });
        el.nachricht.value = '';
        melde(`Committet: ${text(r && r.commit, 40)}`);
      } catch (f) {
        melde(`Nicht committet: ${(f && f.message) || f}`, true);
      } finally {
        laeuft = false;
        await neu();
      }
    });
    el.pr.addEventListener('click', async () => {
      if (laeuft) return;
      if (!prBereit) {
        prBereit = true;
        zeichne();
        setTimeout(() => {
          prBereit = false;
          zeichne();
        }, 6000);
        return;
      }
      prBereit = false;
      laeuft = true;
      zeichne();
      try {
        const titel = (opts.titel && opts.titel()) || (stand && stand.zweig) || 'Änderungen des Agenten';
        const r = await opts.transport.api('POST', `/api/gespraech/${encodeURIComponent(opts.sitzung())}/git/pr`, { titel: String(titel).slice(0, 200) });
        melde(`PR angelegt: ${text(r && r.url, 300)}`);
      } catch (f) {
        melde(`Kein PR: ${(f && f.message) || f}`, true);
      } finally {
        laeuft = false;
        await neu();
      }
    });
    return { neu, get stand() { return stand; } };
  }

  FP.git = { createGitKasten, gitBereinigen, standText };
})();
