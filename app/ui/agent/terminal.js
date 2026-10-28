/* Terminal-Ausgabe: ANSI-Folgen (SGR) in Farb-Klassen übersetzen, alle anderen Steuerfolgen entfernen.
 * Rein und ohne DOM-Zwang: `ansiLeser()` liefert einen Leser mit Zustand über Teilstücke hinweg (Ausgabe kommt in Häppchen),
 * `ansiEntfernen(text)` liefert nur den Text. Ausgabe nie als HTML, nur als Text und Klassen (`an-*`).
 * Fortschrittszeilen (Wagenrücklauf) behalten nur den letzten Stand der Zeile.
 */
(function (G) {
  'use strict';
  const FP = (G.FyosPrototyp = G.FyosPrototyp || {});

  // CSI ... Endbuchstabe (Parameter 0x30-0x3F, Zwischenbytes 0x20-0x2F, Endbyte 0x40-0x7E), OSC ... BEL/ST, einzelne ESC-Zeichen
  const STEUER = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
  const SGR = /^\u001b\[([0-9;:]*)m$/;
  const FARBEN = ['schwarz', 'rot', 'gruen', 'gelb', 'blau', 'magenta', 'cyan', 'weiss'];

  /** Alle Steuerfolgen entfernen (auch Farben); Wagenrücklauf behält je Zeile den letzten Stand. */
  function ansiEntfernen(text) {
    return wagenruecklauf(String(text == null ? '' : text).replace(STEUER, ''));
  }

  function wagenruecklauf(text) {
    if (text.indexOf('\r') < 0) return text;
    return text
      .split('\n')
      .map((zeile) => {
        const teile = zeile.replace(/\r+$/, '').split('\r');
        return teile[teile.length - 1];
      })
      .join('\n');
  }

  function farbKlasse(zustand) {
    const k = [];
    if (zustand.fg) k.push(`an-${zustand.fg}`);
    if (zustand.bg) k.push(`an-bg-${zustand.bg}`);
    if (zustand.fett) k.push('an-fett');
    if (zustand.daemmer) k.push('an-daemmer');
    if (zustand.kursiv) k.push('an-kursiv');
    if (zustand.unter) k.push('an-unter');
    return k.join(' ');
  }

  /** 256-Farben-Index → einer der 16 Grundfarben (grob, für lesbare Ausgabe genügt das). */
  function grundfarbe(n) {
    if (n < 8) return FARBEN[n];
    if (n < 16) return `hell-${FARBEN[n - 8]}`;
    if (n >= 232) return n > 243 ? 'hell-weiss' : 'hell-schwarz';
    const i = n - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    return rgbGrund(r * 51, g * 51, b * 51);
  }
  function rgbGrund(r, g, b) {
    const hell = Math.max(r, g, b) > 170;
    const schwelle = Math.max(r, g, b) * 0.6;
    const bits = (r >= schwelle && r > 60 ? 1 : 0) | (g >= schwelle && g > 60 ? 2 : 0) | (b >= schwelle && b > 60 ? 4 : 0);
    const name = FARBEN[bits === 0 ? (hell ? 7 : 0) : [0, 1, 2, 3, 4, 5, 6, 7][bits]];
    return hell && bits !== 0 ? `hell-${name}` : name;
  }

  function sgrAnwenden(zustand, parameter) {
    const p = parameter === '' ? [0] : parameter.split(/[;:]/).map((x) => (x === '' ? 0 : parseInt(x, 10)));
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === 0) Object.assign(zustand, { fg: '', bg: '', fett: false, daemmer: false, kursiv: false, unter: false });
      else if (c === 1) zustand.fett = true;
      else if (c === 2) zustand.daemmer = true;
      else if (c === 3) zustand.kursiv = true;
      else if (c === 4) zustand.unter = true;
      else if (c === 22) {
        zustand.fett = false;
        zustand.daemmer = false;
      } else if (c === 23) zustand.kursiv = false;
      else if (c === 24) zustand.unter = false;
      else if (c >= 30 && c <= 37) zustand.fg = FARBEN[c - 30];
      else if (c === 39) zustand.fg = '';
      else if (c >= 40 && c <= 47) zustand.bg = FARBEN[c - 40];
      else if (c === 49) zustand.bg = '';
      else if (c >= 90 && c <= 97) zustand.fg = `hell-${FARBEN[c - 90]}`;
      else if (c >= 100 && c <= 107) zustand.bg = `hell-${FARBEN[c - 100]}`;
      else if (c === 38 || c === 48) {
        const ziel = c === 38 ? 'fg' : 'bg';
        if (p[i + 1] === 5 && Number.isFinite(p[i + 2])) {
          zustand[ziel] = grundfarbe(p[i + 2]);
          i += 2;
        } else if (p[i + 1] === 2 && Number.isFinite(p[i + 4])) {
          zustand[ziel] = rgbGrund(p[i + 2], p[i + 3], p[i + 4]);
          i += 4;
        }
      }
    }
  }

  /**
   * Leser mit Zustand: `schreibe(stueck)` → Liste `{ text, klasse }` (Klasse leer = unformatiert).
   * Eine unvollständige Folge am Ende eines Stücks wird für das nächste Stück zurückgehalten.
   */
  function ansiLeser() {
    const zustand = { fg: '', bg: '', fett: false, daemmer: false, kursiv: false, unter: false };
    let rest = '';
    return {
      schreibe(stueck) {
        let text = rest + String(stueck == null ? '' : stueck);
        rest = '';
        // eine angefangene Folge am Ende zurückhalten (höchstens 64 Zeichen, sonst war es keine)
        const esc = text.lastIndexOf('\u001b');
        if (esc >= 0 && text.length - esc < 64) {
          const hinten = text.slice(esc);
          if (!/^\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/.test(hinten)) {
            rest = hinten;
            text = text.slice(0, esc);
          }
        }
        const aus = [];
        let pos = 0;
        STEUER.lastIndex = 0;
        let m;
        const push = (t) => {
          if (!t) return;
          aus.push({ text: t, klasse: farbKlasse(zustand) });
        };
        while ((m = STEUER.exec(text))) {
          push(text.slice(pos, m.index));
          const sgr = SGR.exec(m[0]);
          if (sgr) sgrAnwenden(zustand, sgr[1]);
          pos = m.index + m[0].length;
        }
        push(text.slice(pos));
        return aus;
      },
      zuruecksetzen() {
        Object.assign(zustand, { fg: '', bg: '', fett: false, daemmer: false, kursiv: false, unter: false });
        rest = '';
      },
    };
  }

  FP.ansiEntfernen = ansiEntfernen;
  FP.ansiLeser = ansiLeser;
  FP.wagenruecklauf = wagenruecklauf;
})(typeof globalThis !== 'undefined' ? globalThis : window);
