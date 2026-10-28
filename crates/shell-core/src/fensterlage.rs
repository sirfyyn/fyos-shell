//! Merkt Position und Größe des Inhaltsfensters über Neustarts (`fenster-inhalt.json` im Datenordner). Reine Datei- und Rechenlogik,
//! die Anwendung liest und setzt die Werte am Fenster. Eine Lage, die auf keinem angeschlossenen Bildschirm mehr sichtbar wäre
//! (anderer Monitor abgesteckt, Auflösung geändert), wird verworfen: das Fenster öffnet dann an der Standardstelle.

use crate::speicher::atomar_schreiben;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const DATEI: &str = "fenster-inhalt.json";

/// Alles in physischen Pixeln (wie `outer_position` / `inner_size`), samt Skalierung, damit sie sich auf logische Größen umrechnen lässt.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Lage {
    pub x: i32,
    pub y: i32,
    pub breite: u32,
    pub hoehe: u32,
    pub skalierung: f64,
    pub maximiert: bool,
}

/// Ein Bildschirm: Ursprung und Größe in physischen Pixeln.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bildschirm {
    pub x: i32,
    pub y: i32,
    pub breite: u32,
    pub hoehe: u32,
}

impl Lage {
    /// Sichtbar, wenn ein Streifen der Titelleiste (Punkt 64 px rechts und 16 px unterhalb der linken oberen Ecke) auf einem Bildschirm liegt
    /// und die Größe vernünftig ist (mindestens 320 x 240).
    pub fn sichtbar(&self, bildschirme: &[Bildschirm]) -> bool {
        if self.breite < 320 || self.hoehe < 240 || !(self.skalierung.is_finite() && self.skalierung > 0.0) {
            return false;
        }
        let (px, py) = (self.x as i64 + 64, self.y as i64 + 16);
        bildschirme.iter().any(|b| px >= b.x as i64 && px < b.x as i64 + b.breite as i64 && py >= b.y as i64 && py < b.y as i64 + b.hoehe as i64)
    }

    /// Logische Größe und Position für den Fensterbauer.
    pub fn logisch(&self) -> (f64, f64, f64, f64) {
        let s = self.skalierung;
        (self.x as f64 / s, self.y as f64 / s, self.breite as f64 / s, self.hoehe as f64 / s)
    }
}

pub fn laden(daten: &Path) -> Option<Lage> {
    serde_json::from_slice(&std::fs::read(daten.join(DATEI)).ok()?).ok()
}

pub fn speichern(daten: &Path, lage: &Lage) -> bool {
    serde_json::to_vec_pretty(lage).ok().is_some_and(|b| atomar_schreiben(&daten.join(DATEI), &b).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lage(x: i32, y: i32) -> Lage {
        Lage { x, y, breite: 1200, hoehe: 800, skalierung: 2.0, maximiert: false }
    }
    fn schirm(x: i32, y: i32, b: u32, h: u32) -> Bildschirm {
        Bildschirm { x, y, breite: b, hoehe: h }
    }

    #[test]
    fn sichtbar_auf_dem_bildschirm() {
        let s = [schirm(0, 0, 3024, 1964)];
        assert!(lage(100, 100).sichtbar(&s));
        assert!(!lage(5000, 100).sichtbar(&s), "rechts daneben");
        assert!(!lage(100, 3000).sichtbar(&s), "darunter");
        assert!(lage(-30, 10).sichtbar(&s), "Rand links ragt hinaus, Titelleiste noch greifbar");
    }

    #[test]
    fn zweiter_bildschirm_links_mit_negativer_position() {
        let zwei = [schirm(0, 0, 3024, 1964), schirm(-2560, 0, 2560, 1440)];
        assert!(lage(-2000, 100).sichtbar(&zwei));
        assert!(!lage(-2000, 100).sichtbar(&zwei[..1]), "Monitor abgesteckt: verwerfen");
    }

    #[test]
    fn unsinnige_werte_werden_verworfen() {
        let s = [schirm(0, 0, 3024, 1964)];
        assert!(!Lage { breite: 10, ..lage(0, 0) }.sichtbar(&s));
        assert!(!Lage { skalierung: 0.0, ..lage(0, 0) }.sichtbar(&s));
        assert!(!Lage { skalierung: f64::NAN, ..lage(0, 0) }.sichtbar(&s));
    }

    #[test]
    fn logische_werte_und_datei() {
        let d = tempfile::tempdir().unwrap();
        assert!(laden(d.path()).is_none());
        let l = lage(200, 100);
        assert!(speichern(d.path(), &l));
        assert_eq!(laden(d.path()), Some(l));
        assert_eq!(l.logisch(), (100.0, 50.0, 600.0, 400.0));
        std::fs::write(d.path().join(DATEI), "kaputt").unwrap();
        assert!(laden(d.path()).is_none(), "beschädigte Datei = Standardstelle");
    }
}
