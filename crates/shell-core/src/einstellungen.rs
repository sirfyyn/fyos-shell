//! Einstellungen des Nutzers. Liegen im Datenordner (`einstellungen.json`), nie im Programmpaket.
//!
//! Zwei Regeln halten "Updates behalten Einstellungen" ein:
//! 1. Jedes Feld hat einen Vorgabewert: eine ältere Datei bekommt neue Felder automatisch.
//! 2. Unbekannte Felder bleiben erhalten (`weitere`): eine neuere Datei wird beim Rückweg auf eine ältere Version
//!    nicht beschnitten.

use crate::begleiter::BegleiterKonfig;
use crate::fehler::Fehler;
use crate::speicher::{json_lesen, json_schreiben, Gelesen, Pfade};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const SCHEMA: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Einstellungen {
    pub schema: u32,
    /// Adresse der Seite im Inhaltsfenster; leer = Vorgabe des Profils.
    pub start_url: Option<String>,
    /// Basisadresse des Update-Servers; leer = die in der Anwendung eingebaute Adresse.
    pub update_basis: Option<String>,
    /// Hilfsprogramm (nur Profil Studio); leer = keines.
    pub begleiter: Option<BegleiterKonfig>,
    /// Beim Anmelden starten (wird in D1 verdrahtet; hier nur gemerkt).
    pub autostart: bool,
    #[serde(flatten)]
    pub weitere: Map<String, Value>,
}

impl Default for Einstellungen {
    fn default() -> Self {
        Einstellungen {
            schema: SCHEMA,
            start_url: None,
            update_basis: None,
            begleiter: None,
            autostart: false,
            weitere: Map::new(),
        }
    }
}

/// Lädt die Einstellungen. Eine beschädigte Datei liefert Standardwerte **und** den Fehler zum Anzeigen.
pub fn laden(pfade: &Pfade) -> (Einstellungen, Option<Fehler>) {
    match json_lesen::<Einstellungen>(&pfade.einstellungen()) {
        Gelesen::Ok(e) => (e, None),
        Gelesen::Fehlt => (Einstellungen::default(), None),
        Gelesen::Kaputt(f) => (Einstellungen::default(), Some(f)),
    }
}

pub fn speichern(pfade: &Pfade, e: &Einstellungen) -> Result<(), Fehler> {
    json_schreiben(&pfade.einstellungen(), e)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn ohne_datei_gelten_die_vorgaben() {
        let d = tempfile::tempdir().unwrap();
        let (e, f) = laden(&Pfade::neu(d.path()));
        assert_eq!(e, Einstellungen::default());
        assert!(f.is_none());
    }

    #[test]
    fn speichern_und_laden() {
        let d = tempfile::tempdir().unwrap();
        let p = Pfade::neu(d.path());
        let mut e = Einstellungen::default();
        e.start_url = Some("http://127.0.0.1:9/".into());
        speichern(&p, &e).unwrap();
        assert_eq!(laden(&p).0, e);
    }

    #[test]
    fn aeltere_datei_bekommt_neue_felder_als_vorgabe() {
        let d = tempfile::tempdir().unwrap();
        let p = Pfade::neu(d.path());
        fs::write(p.einstellungen(), r#"{"schema":1,"start_url":"http://a/"}"#).unwrap();
        let (e, f) = laden(&p);
        assert!(f.is_none());
        assert_eq!(e.start_url.as_deref(), Some("http://a/"));
        assert!(!e.autostart);
        assert!(e.begleiter.is_none());
    }

    #[test]
    fn unbekannte_felder_ueberleben_ein_laden_und_speichern() {
        let d = tempfile::tempdir().unwrap();
        let p = Pfade::neu(d.path());
        fs::write(p.einstellungen(), r#"{"schema":7,"zukunft":{"x":[1,2]},"autostart":true}"#).unwrap();
        let (e, _) = laden(&p);
        speichern(&p, &e).unwrap();
        let roh: Value = serde_json::from_str(&fs::read_to_string(p.einstellungen()).unwrap()).unwrap();
        assert_eq!(roh["zukunft"]["x"][1], 2);
        assert_eq!(roh["schema"], 7);
        assert_eq!(roh["autostart"], true);
    }

    #[test]
    fn kaputte_datei_gibt_vorgaben_und_fehlertext() {
        let d = tempfile::tempdir().unwrap();
        let p = Pfade::neu(d.path());
        fs::write(p.einstellungen(), "nicht json").unwrap();
        let (e, f) = laden(&p);
        assert_eq!(e, Einstellungen::default());
        assert_eq!(f.unwrap().code(), "EINSTELLUNGEN_KAPUTT");
    }
}
