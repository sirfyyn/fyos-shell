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
    /// Profil mit Begleiter (Studio): beim Start das Inhaltsfenster mit dem Studio öffnen, sobald der Begleiter gesund ist (Vorgabe an).
    pub inhalt_automatisch: bool,
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
            inhalt_automatisch: true,
            weitere: Map::new(),
        }
    }
}

/// Lädt die Einstellungen. Eine beschädigte Datei liefert Standardwerte **und** den Fehler zum Anzeigen.
pub fn laden(pfade: &Pfade) -> (Einstellungen, Option<Fehler>) {
    match json_lesen::<Einstellungen>(&pfade.einstellungen()) {
        // Von Hand eingetragene Geheimnisse werden nicht entfernt (das wäre Datenverlust), aber gemeldet.
        Gelesen::Ok(e) => {
            let warnung = geheimnis_suchen(&e).map(|schluessel| Fehler::GeheimnisInEinstellungen { schluessel });
            (e, warnung)
        }
        Gelesen::Fehlt => (Einstellungen::default(), None),
        Gelesen::Kaputt(f) => (Einstellungen::default(), Some(f)),
    }
}

pub fn speichern(pfade: &Pfade, e: &Einstellungen) -> Result<(), Fehler> {
    if let Some(schluessel) = geheimnis_suchen(e) {
        return Err(Fehler::GeheimnisInEinstellungen { schluessel });
    }
    json_schreiben(&pfade.einstellungen(), e)
}

const GEHEIME_NAMEN: [&str; 8] = ["token", "passwort", "password", "secret", "geheim", "apikey", "api_key", "api-key"];

fn klingt_geheim(name: &str) -> bool {
    let n = name.to_lowercase();
    GEHEIME_NAMEN.iter().any(|g| n.contains(g))
}

fn wert_ist_verweis_oder_leer(w: &Value) -> bool {
    match w {
        Value::Null => true,
        Value::String(s) => s.is_empty() || crate::tresor::hat_verweis(s),
        _ => false,
    }
}

fn json_durchsuchen(pfad: &str, w: &Value) -> Option<String> {
    match w {
        Value::Object(o) => o.iter().find_map(|(k, v)| {
            let hier = format!("{pfad}.{k}");
            if klingt_geheim(k) && !wert_ist_verweis_oder_leer(v) {
                Some(hier)
            } else {
                json_durchsuchen(&hier, v)
            }
        }),
        Value::Array(a) => a.iter().enumerate().find_map(|(i, v)| json_durchsuchen(&format!("{pfad}[{i}]"), v)),
        Value::String(s) => url_mit_passwort(s).then(|| pfad.to_string()),
        _ => None,
    }
}

fn url_mit_passwort(s: &str) -> bool {
    url::Url::parse(s).map(|u| u.password().is_some()).unwrap_or(false)
}

/// Sieht irgendetwas in den Einstellungen nach einem Geheimnis aus (Schlüsselname wie `token`/`password` mit einem Klartextwert, oder eine
/// Adresse mit Passwort)? Liefert den Pfad des ersten Fundes. Verweise der Form `{tresor:NAME}` und leere Werte sind in Ordnung.
pub fn geheimnis_suchen(e: &Einstellungen) -> Option<String> {
    let json = serde_json::to_value(e).ok()?;
    json_durchsuchen("einstellungen", &json)
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

    fn mit_env(name: &str, wert: &str) -> Einstellungen {
        let mut e = Einstellungen::default();
        let mut k = BegleiterKonfig::default();
        k.env.insert(name.to_string(), wert.to_string());
        e.begleiter = Some(k);
        e
    }

    #[test]
    fn klartext_geheimnisse_werden_nicht_gespeichert() {
        let d = tempfile::tempdir().unwrap();
        let p = Pfade::neu(d.path());
        for (name, wert) in [("HF_TOKEN", "hf_abcdef"), ("DB_PASSWORD", "hunter2"), ("api-key", "k")] {
            let f = speichern(&p, &mit_env(name, wert)).unwrap_err();
            assert_eq!(f.code(), "GEHEIMNIS_IN_EINSTELLUNGEN", "{name}");
        }
        assert!(!p.einstellungen().exists(), "es darf nichts geschrieben worden sein");
        // Unbekannte Felder (z. B. aus einer neueren Fassung) zählen auch
        let mut e = Einstellungen::default();
        e.weitere.insert("proxy".into(), serde_json::json!({"passwort": "x"}));
        assert!(speichern(&p, &e).is_err());
    }

    #[test]
    fn verweise_und_leere_werte_sind_erlaubt() {
        let d = tempfile::tempdir().unwrap();
        let p = Pfade::neu(d.path());
        speichern(&p, &mit_env("HF_TOKEN", "{tresor:hf-token}")).unwrap();
        speichern(&p, &mit_env("HF_TOKEN", "")).unwrap();
        speichern(&p, &mit_env("LOG_LEVEL", "debug")).unwrap();
    }

    #[test]
    fn adresse_mit_passwort_ist_ein_geheimnis() {
        let mut e = Einstellungen::default();
        e.update_basis = Some("https://nutzer:geheim@updates.example/studio/".into());
        assert!(geheimnis_suchen(&e).is_some());
        e.update_basis = Some("https://updates.example/studio/".into());
        assert!(geheimnis_suchen(&e).is_none());
    }

    #[test]
    fn handgeschriebenes_geheimnis_wird_gemeldet_aber_nicht_entfernt() {
        let d = tempfile::tempdir().unwrap();
        let p = Pfade::neu(d.path());
        fs::write(p.einstellungen(), r#"{"begleiter":{"programm":"x","env":{"HF_TOKEN":"hf_klar"}}}"#).unwrap();
        let (e, f) = laden(&p);
        assert_eq!(f.unwrap().code(), "GEHEIMNIS_IN_EINSTELLUNGEN");
        assert_eq!(e.begleiter.unwrap().env["HF_TOKEN"], "hf_klar");
        assert!(fs::read_to_string(p.einstellungen()).unwrap().contains("hf_klar"));
    }
}
