/* Flächen rechts neben dem Gespräch: ein Bereich mit Reitern, in dem der Browser des Agenten (browser-flaeche.js), Dateien, Unterschiede und
 * Bilder (datei-flaeche.js) liegen. Der Bereich ist nur da, solange mindestens eine Fläche offen ist; gezeigt wird immer genau eine.
 *
 *   createFlaechen(els, opts) → { oeffne(f, o), aktiviere(id), schliesse(id, o), schliesseAlle(), hat(id), nimm(id), setzeTitel(id, titel, hinweis),
 *                                 liste(), aktiv, offen }
 *   els:  wurzel (der Bereich), reiter (Leiste der Reiter, role=tablist), koerper (Behälter der Teile), zu (Knopf „Schließen“, optional)
 *   opts: beiOffen(offen) · beiWechsel(id | null) · hoechstens (so viele schließbare Flächen bleiben offen, Vorgabe 8)
 *
 * Eine Fläche: { id, titel, hinweis (Titelzeile beim Überfahren), teil (Element mit dem Inhalt), fest (das Element bleibt in der Seite, wenn die
 * Fläche zugeht), beiZu(grund) (sie ging zu: 'mensch' hat sie geschlossen, oder 'verdraengt', weil zu viele offen waren) }. Titel kommen nur
 * als Text in die Seite.
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  let zaehler = 0;

  function createFlaechen(els, opts) {
    opts = opts || {};
    const doc = els.wurzel.ownerDocument;
    const hoechstens = Math.max(1, opts.hoechstens || 8);
    /** offene Flächen in der Reihenfolge ihrer Reiter */
    let liste = [];
    let aktiv = null;
    zaehler += 1;
    const praefix = `fl${zaehler}`;

    const finde = (id) => liste.find((f) => f.id === id) || null;

    function zeichne() {
      const offen = liste.length > 0;
      els.wurzel.hidden = !offen;
      for (const f of liste) f.teil.hidden = f.id !== aktiv;
      const fokusId = doc.activeElement && els.reiter.contains(doc.activeElement) ? doc.activeElement.dataset.flaeche : null;
      const warZu = !!(doc.activeElement && doc.activeElement.classList && doc.activeElement.classList.contains('fl-reiter-zu'));
      els.reiter.textContent = '';
      for (const f of liste) {
        const eintrag = doc.createElement('span');
        eintrag.className = 'fl-reiter-eintrag';
        eintrag.setAttribute('role', 'presentation');
        if (f.id === aktiv) eintrag.classList.add('aktiv');
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'fl-reiter-knopf';
        b.id = f.reiterId;
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', f.id === aktiv ? 'true' : 'false');
        b.setAttribute('aria-controls', f.teil.id);
        b.tabIndex = f.id === aktiv ? 0 : -1;
        b.dataset.flaeche = f.id;
        b.textContent = f.titel;
        if (f.hinweis) b.title = f.hinweis;
        b.addEventListener('click', () => aktiviere(f.id));
        const x = doc.createElement('button');
        x.type = 'button';
        x.className = 'fl-reiter-zu';
        x.tabIndex = -1;
        x.dataset.flaeche = f.id;
        x.setAttribute('aria-label', `${f.titel} schließen`);
        x.title = 'Schließen';
        x.textContent = '×';
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          schliesse(f.id);
        });
        eintrag.append(b, x);
        els.reiter.append(eintrag);
      }
      // bei vielen Reitern rollt die Leiste: der gewählte bleibt zu sehen
      const vorn = els.reiter.querySelector('.fl-reiter-eintrag.aktiv');
      if (vorn && typeof vorn.scrollIntoView === 'function') vorn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      // der Fokus bleibt in der Leiste, wenn er dort war (nach einem Wechsel oder Schließen auf dem aktiven Reiter)
      if (fokusId !== null && fokusId !== undefined) {
        const ziel = [...els.reiter.querySelectorAll(warZu && finde(fokusId) ? '.fl-reiter-zu' : '.fl-reiter-knopf')].find((k) => k.dataset.flaeche === (finde(fokusId) ? fokusId : aktiv));
        if (ziel) ziel.focus();
      }
    }

    function meldeOffen(vorher) {
      const jetzt = liste.length > 0;
      if (jetzt !== vorher && opts.beiOffen) opts.beiOffen(jetzt);
    }

    function aktiviere(id) {
      if (!finde(id) || aktiv === id) return;
      aktiv = id;
      zeichne();
      if (opts.beiWechsel) opts.beiWechsel(aktiv);
    }

    /** Eine Fläche öffnen oder, wenn es sie schon gibt, nach vorn holen. `o.imHintergrund`: nicht nach vorn, wenn schon eine andere zu sehen ist. */
    function oeffne(f, o) {
      o = o || {};
      const vorher = liste.length > 0;
      let da = finde(f.id);
      if (!da) {
        da = { id: f.id, titel: String(f.titel || 'Fläche'), hinweis: f.hinweis ? String(f.hinweis) : '', teil: f.teil, fest: f.fest === true, beiZu: f.beiZu || null, reiterId: `${praefix}-reiter-${liste.length}-${Math.random().toString(36).slice(2, 7)}` };
        if (!da.teil.id) da.teil.id = `${praefix}-teil-${Math.random().toString(36).slice(2, 9)}`;
        da.teil.setAttribute('role', 'tabpanel');
        da.teil.setAttribute('aria-labelledby', da.reiterId);
        if (da.teil.parentNode !== els.koerper) els.koerper.append(da.teil);
        liste.push(da);
        // zu viele: die älteste schließbare, die nicht vorn liegt, geht zu
        while (liste.filter((x) => !x.fest).length > hoechstens) {
          const alt = liste.find((x) => !x.fest && x.id !== aktiv && x.id !== da.id);
          if (!alt) break;
          entferne(alt, false, 'verdraengt');
        }
      } else {
        if (f.titel) da.titel = String(f.titel);
        if (f.hinweis !== undefined) da.hinweis = f.hinweis ? String(f.hinweis) : '';
      }
      const wechsel = !(o.imHintergrund && aktiv !== null && finde(aktiv)) && aktiv !== da.id;
      if (wechsel) aktiv = da.id;
      zeichne();
      meldeOffen(vorher);
      if (wechsel && opts.beiWechsel) opts.beiWechsel(aktiv);
      return da.id;
    }

    /** `grund`: 'mensch' (geschlossen) oder 'verdraengt' (zu viele offen, die älteste ging zu). */
    function entferne(f, still, grund) {
      liste = liste.filter((x) => x !== f);
      f.teil.hidden = true;
      if (!f.fest && f.teil.parentNode) f.teil.parentNode.removeChild(f.teil);
      if (!still && f.beiZu) f.beiZu(grund || 'mensch');
    }

    /** Eine Fläche schließen. `o.still`: ohne ihr `beiZu` (sie hat sich selbst geschlossen). */
    function schliesse(id, o) {
      const f = finde(id);
      if (!f) return;
      const vorher = liste.length > 0;
      const stelle = liste.indexOf(f);
      entferne(f, !!(o && o.still));
      let wechsel = false;
      if (aktiv === id) {
        const naechste = liste[stelle] || liste[stelle - 1] || null;
        aktiv = naechste ? naechste.id : null;
        wechsel = true;
      }
      zeichne();
      meldeOffen(vorher);
      if (wechsel && opts.beiWechsel) opts.beiWechsel(aktiv);
    }

    function schliesseAlle() {
      const vorher = liste.length > 0;
      const alle = liste.slice();
      liste = [];
      aktiv = null;
      for (const f of alle) {
        f.teil.hidden = true;
        if (!f.fest && f.teil.parentNode) f.teil.parentNode.removeChild(f.teil);
      }
      zeichne();
      meldeOffen(vorher);
      // erst jetzt melden: eine Fläche, die sich im `beiZu` selbst schließt, findet sich nicht mehr in der Liste
      for (const f of alle) if (f.beiZu) f.beiZu('mensch');
      if (vorher && opts.beiWechsel) opts.beiWechsel(null);
    }

    function setzeTitel(id, titel, hinweis) {
      const f = finde(id);
      if (!f) return;
      if (titel) f.titel = String(titel);
      if (hinweis !== undefined) f.hinweis = hinweis ? String(hinweis) : '';
      zeichne();
    }

    // Pfeiltasten in der Reiterleiste: links und rechts wechseln, Pos1 und Ende springen, Entf schließt
    els.reiter.addEventListener('keydown', (e) => {
      const an = liste.findIndex((f) => f.id === (e.target && e.target.dataset ? e.target.dataset.flaeche : null));
      if (an < 0) return;
      let ziel = -1;
      if (e.key === 'ArrowRight') ziel = (an + 1) % liste.length;
      else if (e.key === 'ArrowLeft') ziel = (an - 1 + liste.length) % liste.length;
      else if (e.key === 'Home') ziel = 0;
      else if (e.key === 'End') ziel = liste.length - 1;
      else if (e.key === 'Delete') {
        e.preventDefault();
        schliesse(liste[an].id);
        return;
      } else return;
      e.preventDefault();
      aktiviere(liste[ziel].id);
      const knopf = [...els.reiter.querySelectorAll('.fl-reiter-knopf')].find((k) => k.dataset.flaeche === liste[ziel].id);
      if (knopf) knopf.focus();
    });
    if (els.zu) els.zu.addEventListener('click', () => schliesseAlle());

    zeichne();
    return {
      oeffne,
      aktiviere,
      schliesse,
      schliesseAlle,
      setzeTitel,
      hat: (id) => !!finde(id),
      nimm: (id) => {
        const f = finde(id);
        return f ? { id: f.id, titel: f.titel, hinweis: f.hinweis, teil: f.teil } : null;
      },
      liste: () => liste.map((f) => f.id),
      get aktiv() {
        return aktiv;
      },
      get offen() {
        return liste.length > 0;
      },
    };
  }

  FP.createFlaechen = createFlaechen;
})(typeof globalThis !== 'undefined' ? globalThis : window);
