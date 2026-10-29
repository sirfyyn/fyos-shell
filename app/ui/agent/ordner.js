/* Ordnerwahl bei „Neue Sitzung“.
 * - entfernter Runner: Ordnerbaum aus GET /api/ordner (Wurzeln, aufklappen, wählen). Kennt der Runner den Weg nicht (alte Fassung),
 *   meldet `starte` false und die Seite bleibt bei der Auswahl der Arbeitsbereiche.
 * - lokaler Runner: Knopf „Ordner wählen …“ (Systemdialog über den Befehl `ordner_waehlen`, nicht über die Seite).
 * - beide: Liste der zuletzt benutzten Ordner (nur lokal in den Einstellungen gemerkt).
 * Nur Text, nie HTML aus dem Runner.
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  /** Pfad eines Eintrags: mit dem Trenner, den der Elternpfad benutzt. */
  function unter(eltern, name) {
    const win = eltern.includes('\\') && !eltern.includes('/');
    const sep = win ? '\\' : '/';
    return eltern.endsWith(sep) ? eltern + name : eltern + sep + name;
  }

  /**
   * refs: { kasten, gewaehlt, zuletzt, dialog, baum, fehler }
   * opts: { transport, waehleLokal(): Promise<{pfad,name}|null>, zuletztLaden(): Promise<[{pfad,name}]>, beiAenderung(pfad) }
   */
  function createOrdnerWahl(refs, opts) {
    const doc = refs.baum.ownerDocument;
    let art = 'entfernt';
    let pfad = '';

    const fehlerText = (f) => (f && f.message) || String(f);
    function zeigeFehler(f) {
      refs.fehler.hidden = !f;
      refs.fehler.textContent = f ? fehlerText(f) : '';
    }
    function setze(p) {
      pfad = p || '';
      refs.gewaehlt.textContent = pfad ? `Gewählt: ${pfad}` : 'Noch kein Ordner gewählt.';
      refs.gewaehlt.title = pfad;
      for (const b of refs.baum.querySelectorAll('.baum-name')) b.setAttribute('aria-selected', b.dataset.pfad === pfad ? 'true' : 'false');
      if (opts.beiAenderung) opts.beiAenderung(pfad);
    }

    function knotenBauen(p, name, ebene) {
      const li = doc.createElement('li');
      li.setAttribute('role', 'treeitem');
      li.setAttribute('aria-expanded', 'false');
      li.dataset.pfad = p;
      li.style.setProperty('--ebene', String(ebene));
      const zeile = doc.createElement('div');
      zeile.className = 'baum-zeile';
      const auf = doc.createElement('button');
      auf.type = 'button';
      auf.className = 'baum-auf';
      auf.setAttribute('aria-label', `${name} aufklappen`);
      auf.textContent = '▸';
      const wahl = doc.createElement('button');
      wahl.type = 'button';
      wahl.className = 'baum-name';
      wahl.dataset.pfad = p;
      wahl.setAttribute('aria-selected', 'false');
      wahl.textContent = name;
      wahl.title = p;
      const kinder = doc.createElement('ul');
      kinder.setAttribute('role', 'group');
      kinder.hidden = true;
      let geladen = false;
      async function umschalten() {
        const offen = li.getAttribute('aria-expanded') === 'true';
        if (offen) {
          li.setAttribute('aria-expanded', 'false');
          kinder.hidden = true;
          auf.textContent = '▸';
          return;
        }
        if (!geladen) {
          auf.disabled = true;
          try {
            const r = await opts.transport.api('GET', `/api/ordner?pfad=${encodeURIComponent(p)}`);
            kinder.textContent = '';
            const eintraege = (Array.isArray(r.eintraege) ? r.eintraege : []).filter((e) => e && e.ordner !== false && e.name);
            for (const e of eintraege) kinder.appendChild(knotenBauen(unter(p, e.name), e.name, ebene + 1));
            if (!eintraege.length) {
              const leer = doc.createElement('li');
              leer.className = 'baum-leer leise';
              leer.textContent = 'Keine Unterordner.';
              kinder.appendChild(leer);
            }
            if (r.abgeschnitten) {
              const mehr = doc.createElement('li');
              mehr.className = 'baum-leer leise';
              mehr.textContent = 'Die Liste ist gekürzt.';
              kinder.appendChild(mehr);
            }
            geladen = true;
            zeigeFehler(null);
          } catch (f) {
            zeigeFehler(f);
            auf.disabled = false;
            return;
          }
          auf.disabled = false;
        }
        li.setAttribute('aria-expanded', 'true');
        kinder.hidden = false;
        auf.textContent = '▾';
      }
      auf.addEventListener('click', umschalten);
      wahl.addEventListener('click', () => {
        zeigeFehler(null);
        setze(p);
      });
      zeile.append(auf, wahl);
      li.append(zeile, kinder);
      return li;
    }

    async function zuletztZeigen() {
      refs.zuletzt.textContent = '';
      let liste = [];
      try {
        liste = opts.zuletztLaden ? await opts.zuletztLaden() : [];
      } catch (e) {
        liste = [];
      }
      refs.zuletzt.hidden = !liste.length;
      if (!liste.length) return;
      const k = doc.createElement('span');
      k.className = 'leise';
      k.textContent = 'Zuletzt benutzt';
      refs.zuletzt.appendChild(k);
      for (const z of liste) {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'zuletzt-knopf';
        b.textContent = z.name || z.pfad;
        b.title = z.pfad;
        b.addEventListener('click', () => {
          zeigeFehler(null);
          setze(z.pfad);
        });
        refs.zuletzt.appendChild(b);
      }
    }

    refs.dialog.addEventListener('click', async () => {
      zeigeFehler(null);
      refs.dialog.disabled = true;
      try {
        const r = await opts.waehleLokal();
        if (r && r.pfad) setze(r.pfad);
      } catch (f) {
        zeigeFehler(f);
      } finally {
        refs.dialog.disabled = false;
      }
    });

    return {
      /** Bereitet die Wahl für den Runner vor. Rückgabe: ob eine Ordnerwahl angeboten wird (sonst gelten die Arbeitsbereiche). */
      async starte(runnerArt) {
        art = runnerArt === 'lokal' ? 'lokal' : 'entfernt';
        pfad = '';
        refs.baum.textContent = '';
        zeigeFehler(null);
        setze('');
        refs.dialog.hidden = art !== 'lokal';
        refs.baum.hidden = art === 'lokal';
        if (art === 'entfernt') {
          try {
            const r = await opts.transport.api('GET', '/api/ordner');
            const wurzeln = Array.isArray(r.wurzeln) ? r.wurzeln : [];
            for (const w of wurzeln) refs.baum.appendChild(knotenBauen(String(w), String(w), 0));
            if (!wurzeln.length) zeigeFehler(new Error('Der Runner gibt keine Ordner frei.'));
          } catch (f) {
            // ein Runner ohne Ordnerliste (404 oder unbekannter Weg): die Seite bleibt bei den Arbeitsbereichen
            refs.kasten.hidden = true;
            return false;
          }
        }
        refs.kasten.hidden = false;
        await zuletztZeigen();
        return true;
      },
      wert: () => pfad,
      setze,
      art: () => art,
    };
  }

  FP.createOrdnerWahl = createOrdnerWahl;
  FP.ordnerUnter = unter;
})(typeof globalThis !== 'undefined' ? globalThis : window);
