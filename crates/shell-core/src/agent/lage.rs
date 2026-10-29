//! Lage des Chat-Fensters (Position und Größe) in den Einstellungen des Profils `agent`: nur Zahlen, kein Token, kein Pfad.
//! Dieselbe Rechnung wie beim Inhaltsfenster des Profils OS ([`crate::fensterlage`]): eine Lage, die auf keinem angeschlossenen Bildschirm
//! mehr greifbar wäre, wird beim Start verworfen (Standardlage), eine zu große auf den Bildschirm begrenzt. Reine Funktionen, getestet.

use super::AgentEinst;
use crate::fensterlage::{Bildschirm, Lage};

impl AgentEinst {
    /// Merkt die Lage des Chat-Fensters. `true`, wenn sich etwas geändert hat (dann ist die Einstellungsdatei zu schreiben).
    /// Eine Lage, die auf keinem Bildschirm sichtbar ist (z. B. minimiert, Position weit außerhalb), wird nicht gemerkt; die letzte gute bleibt.
    pub fn chat_lage_merken(&mut self, lage: Lage, bildschirme: &[Bildschirm]) -> bool {
        if !lage.sichtbar(bildschirme) || self.chat_lage == Some(lage) {
            return false;
        }
        self.chat_lage = Some(lage);
        true
    }

    /// Die zu öffnende Lage: die gemerkte, wenn sie noch auf einem vorhandenen Bildschirm liegt (Größe auf den Bildschirm begrenzt), sonst `None`
    /// (Standardlage).
    pub fn chat_lage_wiederherstellen(&self, bildschirme: &[Bildschirm]) -> Option<Lage> {
        let l = self.chat_lage?;
        if !l.sichtbar(bildschirme) {
            return None;
        }
        // der Bildschirm unter dem Titelleisten-Punkt, auf den `sichtbar` geprüft hat
        let (px, py) = (l.x as i64 + 64, l.y as i64 + 16);
        let b = bildschirme.iter().find(|b| px >= b.x as i64 && px < b.x as i64 + b.breite as i64 && py >= b.y as i64 && py < b.y as i64 + b.hoehe as i64)?;
        Some(Lage { breite: l.breite.min(b.breite), hoehe: l.hoehe.min(b.hoehe), ..l })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lage(x: i32, y: i32) -> Lage {
        Lage { x, y, breite: 2200, hoehe: 1640, skalierung: 2.0, maximiert: false }
    }
    fn schirm(x: i32, y: i32, b: u32, h: u32) -> Bildschirm {
        Bildschirm { x, y, breite: b, hoehe: h }
    }

    #[test]
    fn lage_wird_gemerkt_und_gleiche_nicht_doppelt() {
        let s = [schirm(0, 0, 3024, 1964)];
        let mut e = AgentEinst::default();
        assert_eq!(e.chat_lage, None);
        assert!(e.chat_lage_merken(lage(100, 100), &s));
        assert!(!e.chat_lage_merken(lage(100, 100), &s), "unverändert: nichts zu schreiben");
        assert!(e.chat_lage_merken(lage(200, 100), &s));
        assert_eq!(e.chat_lage, Some(lage(200, 100)));
    }

    #[test]
    fn unsichtbare_lage_wird_nicht_gemerkt() {
        let s = [schirm(0, 0, 3024, 1964)];
        let mut e = AgentEinst::default();
        assert!(e.chat_lage_merken(lage(100, 100), &s));
        // minimiert (Windows meldet -32000), weit außerhalb, winzig: die letzte gute Lage bleibt
        assert!(!e.chat_lage_merken(lage(-32000, -32000), &s));
        assert!(!e.chat_lage_merken(lage(9000, 100), &s));
        assert!(!e.chat_lage_merken(Lage { breite: 10, hoehe: 10, ..lage(100, 100) }, &s));
        assert_eq!(e.chat_lage, Some(lage(100, 100)));
    }

    #[test]
    fn wiederherstellen_nur_auf_vorhandenem_bildschirm() {
        let zwei = [schirm(0, 0, 3024, 1964), schirm(-2560, 0, 2560, 1440)];
        let mut e = AgentEinst::default();
        assert_eq!(e.chat_lage_wiederherstellen(&zwei), None, "nie gemerkt: Standardlage");
        e.chat_lage = Some(Lage { breite: 1200, hoehe: 800, ..lage(-2000, 100) });
        assert_eq!(e.chat_lage_wiederherstellen(&zwei), e.chat_lage);
        assert_eq!(e.chat_lage_wiederherstellen(&zwei[..1]), None, "Monitor abgesteckt: Standardlage");
    }

    #[test]
    fn zu_grosse_lage_wird_auf_den_bildschirm_begrenzt() {
        let s = [schirm(0, 0, 1920, 1080)];
        let mut e = AgentEinst::default();
        e.chat_lage = Some(lage(0, 0));
        let l = e.chat_lage_wiederherstellen(&s).unwrap();
        assert_eq!((l.breite, l.hoehe, l.x, l.y), (1920, 1080, 0, 0));
        assert_eq!(l.skalierung, 2.0);
    }

    #[test]
    fn maximiert_bleibt_erhalten() {
        let s = [schirm(0, 0, 3024, 1964)];
        let mut e = AgentEinst::default();
        assert!(e.chat_lage_merken(Lage { maximiert: true, ..lage(0, 0) }, &s));
        assert!(e.chat_lage_wiederherstellen(&s).unwrap().maximiert);
    }

    #[test]
    fn lage_ueberlebt_die_einstellungsdatei_nur_als_zahlen() {
        let mut e = AgentEinst::default();
        e.chat_lage = Some(lage(10, 20));
        let j = serde_json::to_value(&e).unwrap();
        let l = &j["chat_lage"];
        for k in ["x", "y", "breite", "hoehe", "skalierung", "maximiert"] {
            assert!(l.get(k).is_some_and(|v| v.is_number() || v.is_boolean()), "{k}");
        }
        assert_eq!(serde_json::from_value::<AgentEinst>(j).unwrap(), e);
        // eine ältere Datei ohne das Feld lädt mit Standardlage
        let alt: AgentEinst = serde_json::from_str(r#"{"ruhe":true}"#).unwrap();
        assert_eq!(alt.chat_lage, None);
    }
}
