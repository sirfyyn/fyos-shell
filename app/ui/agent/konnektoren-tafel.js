/* Tafel „Konnektoren“ der Seitenleiste (Paket B1, Prototyp apps/fyos-agent/prototyp/ausbau.html, „Konnektoren und Plugins“): die Konten bei
 * anderen Diensten über den Hub (verbunden, mit welchem Konto, welche Rechte; „Prüfen“, wo der Hub es kann; „Verwalten“ öffnet die Seite der
 * Verbindungen im Browser) und die Fähigkeiten dieses Runners (welche Schalter an sind). Nur lesend, über runner-wege.js (`konnektoren`,
 * `kontoPruefen`). Kennt der Runner den Weg nicht, bleibt der Knopf der Schiene weg.
 *
 *   FP.konnektoren = { createKonnektorenTafel, rechteText }
 *
 * Texte nur als textContent, Wege nur https (runner-wege.js `httpsWeg`). Kürzel der Klassen: `kn-`.
 */
(() => {
  'use strict';
  const FP = (window.FyosPrototyp = window.FyosPrototyp || {});

  /** „repo, Organisationen lesen, read:user +1“: höchstens drei Rechte, der Rest als Zahl. */
  function rechteText(rechte) {
    const liste = Array.isArray(rechte) ? rechte : [];
    if (!liste.length) return '';
    const sichtbar = liste.slice(0, 3).join(', ');
    return liste.length > 3 ? `${sichtbar} +${liste.length - 3}` : sichtbar;
  }

  /** refs: { knopf, rumpf, fuss }   opts: { wege, beiWeg?: (kennt) => void } */
  function createKonnektorenTafel(refs, opts) {
    const doc = refs.rumpf.ownerDocument;
    let laeuft = false;
    const el = (tag, klasse, text) => {
      const e = doc.createElement(tag);
      if (klasse) e.className = klasse;
      if (text !== undefined) e.textContent = String(text);
      return e;
    };
    const chip = (text, art) => el('span', `bt-chip${art ? ` ${art}` : ''}`, text);
    const weg = (url, text) => {
      const a = el('a', 'leise-knopf kn-weg', text);
      a.setAttribute('href', url);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      return a;
    };

    async function pruefen(k, zeile, knopf) {
      knopf.disabled = true;
      knopf.textContent = 'Prüft …';
      const alt = zeile.querySelector('.kn-ergebnis');
      if (alt) alt.remove();
      const aus = el('div', 'leise kn-ergebnis');
      try {
        const r = await opts.wege.kontoPruefen(k.id);
        aus.textContent = [r.satz, r.konto].filter(Boolean).join(' · ') || 'Keine Antwort.';
        if (r.traegt === false) aus.classList.add('kn-fehler');
      } catch (f) {
        aus.textContent = `Prüfung nicht möglich: ${(f && (f.meldung || f.message)) || 'unbekannter Fehler'}`;
        aus.classList.add('kn-fehler');
      }
      zeile.appendChild(aus);
      knopf.disabled = false;
      knopf.textContent = 'Prüfen';
    }

    function zeichne(l) {
      refs.rumpf.textContent = '';
      refs.rumpf.appendChild(el('h3', 'bt-abschnitt', 'Konten'));
      if (l.fehler) refs.rumpf.appendChild(el('p', 'leise leer-hinweis kn-fehler', `Konten nicht lesbar: ${l.fehler}`));
      else if (l.satz) refs.rumpf.appendChild(el('p', 'leise bt-satz', l.satz));
      const liste = el('ul', 'kn-liste');
      liste.setAttribute('aria-label', 'Konten');
      for (const k of l.konten) {
        const li = el('li', 'kn-konto');
        const kopf = el('div', 'bt-zeile');
        kopf.append(el('b', null, k.name), el('span', 'bt-name', k.konto || k.art));
        kopf.append(k.verbunden ? chip('verbunden', 'gut') : chip('offen'));
        li.appendChild(kopf);
        const r = rechteText(k.rechte);
        if (r) {
          const z = el('div', 'leise kn-rechte', r);
          z.title = k.rechte.join(', ');
          li.appendChild(z);
        }
        const knoepfe = el('div', 'kn-knoepfe');
        if (k.pruefbar) {
          const p = el('button', 'leise-knopf', 'Prüfen');
          p.type = 'button';
          p.title = 'Den Anbieter fragen, ob die Verbindung trägt';
          p.addEventListener('click', () => void pruefen(k, li, p));
          knoepfe.appendChild(p);
        }
        if (!k.verbunden && k.verbinden) knoepfe.appendChild(weg(k.verbinden, 'Verbinden'));
        if (knoepfe.childNodes.length) li.appendChild(knoepfe);
        liste.appendChild(li);
      }
      refs.rumpf.appendChild(liste);
      if (l.verwalten) refs.rumpf.appendChild(weg(l.verwalten, 'Verbindungen verwalten'));

      refs.rumpf.appendChild(el('h3', 'bt-abschnitt', 'Fähigkeiten dieses Runners'));
      const f = el('ul', 'kn-liste');
      f.setAttribute('aria-label', 'Fähigkeiten dieses Runners');
      for (const x of l.faehigkeiten) {
        const li = el('li', 'bt-zeile kn-faehigkeit');
        li.append(el('span', 'bt-name', x.titel), x.an ? chip('an', 'gut') : chip('aus'));
        li.title = x.an ? `${x.titel}: an` : `${x.titel}: aus (am vollen Runner Schalter pi_durable.oberflaeche.${x.name})`;
        f.appendChild(li);
      }
      refs.rumpf.appendChild(f);
      refs.fuss.textContent = 'Zugänge liegen im Hub, nie in der App. Nur lesend.';
      refs.fuss.hidden = false;
    }

    async function neu() {
      if (laeuft) return;
      laeuft = true;
      try {
        const l = await opts.wege.konnektoren();
        if (refs.knopf) refs.knopf.hidden = false;
        if (opts.beiWeg) opts.beiWeg(true);
        zeichne(l);
      } catch (f) {
        if (f && f.art === 'weg_fehlt') {
          if (refs.knopf) refs.knopf.hidden = true;
          if (opts.beiWeg) opts.beiWeg(false);
        } else {
          refs.rumpf.textContent = '';
          refs.rumpf.appendChild(el('p', 'leise leer-hinweis kn-fehler', `Konnektoren nicht lesbar: ${(f && (f.meldung || f.message)) || 'unbekannter Fehler'}`));
        }
      } finally {
        laeuft = false;
      }
    }
    return { pruefe: neu, zeige: neu, neu };
  }

  FP.konnektoren = { createKonnektorenTafel, rechteText };
})();
