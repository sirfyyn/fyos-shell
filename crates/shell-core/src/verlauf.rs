//! Versionsverlauf: merkt die Vorversion (Rückweg) und prüft nach dem Neustart, ob das Update wirklich wirksam wurde.
//!
//! Ablauf: vor dem Einspielen `vor_update`, speichern; nach dem Neustart `beim_start` mit der laufenden Version.
//! Läuft das Ziel, gilt das Update als gelungen und die alte Version wird zur Vorversion. Sonst entsteht der Fehler
//! `UPDATE_NICHT_WIRKSAM`. Der Verlauf liegt im Datenordner und übersteht Updates und Deinstallation.

use crate::fehler::Fehler;
use crate::speicher::{json_lesen, json_schreiben, Gelesen, Pfade};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Art {
    Update,
    Rueckweg,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ausstehend {
    pub art: Art,
    pub von: String,
    pub ziel: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Verlauf {
    pub aktuell: Option<String>,
    pub vorherige: Option<String>,
    pub ausstehend: Option<Ausstehend>,
}

/// Ergebnis der Prüfung nach dem Start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ausgang {
    Erfolg { art: Art, von: String, auf: String },
    Misserfolg(Fehler),
}

impl Ausgang {
    /// Ein Satz für das Fenster.
    pub fn text(&self) -> String {
        match self {
            Ausgang::Erfolg { art: Art::Update, von, auf } => format!("Aktualisiert von Version {von} auf {auf}. Einstellungen sind unverändert."),
            Ausgang::Erfolg { art: Art::Rueckweg, von, auf } => format!("Zurück von Version {von} auf {auf}. Einstellungen sind unverändert."),
            Ausgang::Misserfolg(f) => f.to_string(),
        }
    }
}

impl Verlauf {
    pub fn laden(pfade: &Pfade) -> Verlauf {
        match json_lesen::<Verlauf>(&pfade.verlauf()) {
            Gelesen::Ok(v) => v,
            Gelesen::Fehlt | Gelesen::Kaputt(_) => Verlauf::default(),
        }
    }

    pub fn speichern(&self, pfade: &Pfade) -> Result<(), Fehler> {
        json_schreiben(&pfade.verlauf(), self)
    }

    /// Merkt vor dem Einspielen, was erwartet wird.
    pub fn vor_update(&mut self, art: Art, laufend: &str, ziel: &str) {
        self.aktuell = Some(laufend.to_string());
        self.ausstehend = Some(Ausstehend { art, von: laufend.to_string(), ziel: ziel.to_string() });
    }

    /// Nach jedem Start mit der laufenden Version aufrufen.
    pub fn beim_start(&mut self, laufend: &str) -> Option<Ausgang> {
        if let Some(a) = self.ausstehend.take() {
            self.aktuell = Some(laufend.to_string());
            if a.ziel == laufend {
                self.vorherige = Some(a.von.clone());
                return Some(Ausgang::Erfolg { art: a.art, von: a.von, auf: a.ziel });
            }
            return Some(Ausgang::Misserfolg(Fehler::UpdateNichtWirksam { erwartet: a.ziel, laeuft: laufend.to_string() }));
        }
        if self.aktuell.as_deref() != Some(laufend) {
            // Von Hand über eine andere Fassung installiert: die bisherige wird zur Vorversion.
            if let Some(alt) = self.aktuell.take() {
                self.vorherige = Some(alt);
            }
            self.aktuell = Some(laufend.to_string());
        }
        None
    }

    /// Die Version, auf die „zurück“ geht.
    pub fn rueckweg_ziel(&self, laufend: &str) -> Result<&str, Fehler> {
        match self.vorherige.as_deref() {
            Some(v) if v != laufend => Ok(v),
            _ => Err(Fehler::KeineVorversion),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erster_start_merkt_nur_die_version() {
        let mut v = Verlauf::default();
        assert!(v.beim_start("0.0.1").is_none());
        assert_eq!(v.aktuell.as_deref(), Some("0.0.1"));
        assert_eq!(v.rueckweg_ziel("0.0.1").unwrap_err().code(), "RUECKWEG_KEINE_VORVERSION");
    }

    #[test]
    fn gelungenes_update_merkt_die_vorversion() {
        let mut v = Verlauf::default();
        v.beim_start("0.0.1");
        v.vor_update(Art::Update, "0.0.1", "0.0.2");
        let a = v.beim_start("0.0.2").unwrap();
        assert_eq!(a, Ausgang::Erfolg { art: Art::Update, von: "0.0.1".into(), auf: "0.0.2".into() });
        assert!(a.text().contains("Einstellungen sind unverändert"));
        assert_eq!(v.rueckweg_ziel("0.0.2").unwrap(), "0.0.1");
        assert!(v.ausstehend.is_none());
    }

    #[test]
    fn nicht_wirksames_update_wird_gemeldet_und_aendert_die_vorversion_nicht() {
        let mut v = Verlauf::default();
        v.beim_start("0.0.1");
        v.vor_update(Art::Update, "0.0.1", "0.0.2");
        match v.beim_start("0.0.1").unwrap() {
            Ausgang::Misserfolg(f) => assert_eq!(f.code(), "UPDATE_NICHT_WIRKSAM"),
            a => panic!("{a:?}"),
        }
        assert!(v.vorherige.is_none());
        assert!(v.ausstehend.is_none());
    }

    #[test]
    fn rueckweg_vertauscht_die_rollen() {
        let mut v = Verlauf::default();
        v.beim_start("0.0.1");
        v.vor_update(Art::Update, "0.0.1", "0.0.2");
        v.beim_start("0.0.2");
        v.vor_update(Art::Rueckweg, "0.0.2", "0.0.1");
        let a = v.beim_start("0.0.1").unwrap();
        assert!(matches!(a, Ausgang::Erfolg { art: Art::Rueckweg, .. }));
        assert!(a.text().starts_with("Zurück"));
        assert_eq!(v.vorherige.as_deref(), Some("0.0.2"));
    }

    #[test]
    fn handinstallation_einer_anderen_fassung_wird_zur_vorversion() {
        let mut v = Verlauf::default();
        v.beim_start("0.0.1");
        assert!(v.beim_start("0.0.3").is_none());
        assert_eq!(v.vorherige.as_deref(), Some("0.0.1"));
    }

    #[test]
    fn speichern_und_laden_ueber_den_neustart() {
        let d = tempfile::tempdir().unwrap();
        let p = Pfade::neu(d.path());
        let mut v = Verlauf::default();
        v.beim_start("0.0.1");
        v.vor_update(Art::Update, "0.0.1", "0.0.2");
        v.speichern(&p).unwrap();
        let mut neu = Verlauf::laden(&p);
        assert_eq!(neu, v);
        assert!(neu.beim_start("0.0.2").is_some());
    }

    #[test]
    fn kaputte_datei_ist_ein_leerer_verlauf() {
        let d = tempfile::tempdir().unwrap();
        let p = Pfade::neu(d.path());
        std::fs::write(p.verlauf(), "{x").unwrap();
        assert_eq!(Verlauf::laden(&p), Verlauf::default());
    }
}
