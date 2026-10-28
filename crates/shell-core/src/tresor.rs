//! Tresor für Geheimnisse (Tokens, Zugangsschlüssel). Geheimnisse gehören nie in `einstellungen.json`.
//!
//! Der Kern kennt nur die Schnittstelle [`Tresor`] und den Speicher-Tresor für Tests. Die Systemfassung (macOS Schlüsselbund, Windows
//! Anmeldeinformationsverwaltung, Linux Secret Service über das Crate `keyring`) liegt in `crates/shell-tresor`, damit dieser Kern keine
//! Systembibliotheken braucht. Die Einstellungen verweisen auf Geheimnisse mit `{tresor:NAME}`; [`aufloesen`] setzt sie erst beim Start ein.

use crate::fehler::Fehler;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TresorFehler {
    /// Das System bietet keinen Tresor an (z. B. Linux ohne Secret Service).
    NichtVerfuegbar(String),
    Zugriff(String),
}

impl From<TresorFehler> for Fehler {
    fn from(f: TresorFehler) -> Fehler {
        match f {
            TresorFehler::NichtVerfuegbar(grund) => Fehler::TresorNichtVerfuegbar { grund },
            TresorFehler::Zugriff(grund) => Fehler::TresorZugriff { grund },
        }
    }
}

pub trait Tresor: Send + Sync {
    /// `Ok(None)`, wenn es den Eintrag nicht gibt.
    fn lesen(&self, name: &str) -> Result<Option<String>, TresorFehler>;
    fn schreiben(&self, name: &str, wert: &str) -> Result<(), TresorFehler>;
    /// Löschen eines nicht vorhandenen Eintrags ist kein Fehler.
    fn loeschen(&self, name: &str) -> Result<(), TresorFehler>;
}

/// Zulässige Namen: Kleinbuchstaben, Ziffern, `.`, `-`, `_`, höchstens 64 Zeichen.
pub fn name_pruefen(name: &str) -> Result<(), Fehler> {
    let ok = !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-' | '_'));
    if ok {
        Ok(())
    } else {
        Err(Fehler::TresorNameUnzulaessig { name: name.to_string() })
    }
}

/// Ersetzt jedes `{tresor:NAME}` in `text` durch das Geheimnis. Fehlt der Eintrag: `TRESOR_EINTRAG_FEHLT`; ist der Tresor unerreichbar:
/// dessen Fehler. Text ohne Verweis kommt unverändert zurück (der Tresor wird dann nicht berührt).
pub fn aufloesen(text: &str, tresor: &dyn Tresor) -> Result<String, Fehler> {
    const ANFANG: &str = "{tresor:";
    let mut aus = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find(ANFANG) {
        aus.push_str(&rest[..i]);
        let nach = &rest[i + ANFANG.len()..];
        let Some(ende) = nach.find('}') else {
            // kein schließendes } : unverändert lassen
            aus.push_str(&rest[i..]);
            return Ok(aus);
        };
        let name = &nach[..ende];
        name_pruefen(name)?;
        let wert = tresor.lesen(name)?.ok_or_else(|| Fehler::TresorEintragFehlt { name: name.to_string() })?;
        aus.push_str(&wert);
        rest = &nach[ende + 1..];
    }
    aus.push_str(rest);
    Ok(aus)
}

/// Enthält `text` einen Verweis `{tresor:…}`?
pub fn hat_verweis(text: &str) -> bool {
    text.contains("{tresor:")
}

/// Tresor im Arbeitsspeicher: überlebt keinen Neustart. Nur für Tests und als Zwischenlösung ohne Systemtresor.
#[derive(Default)]
pub struct SpeicherTresor {
    inhalt: Mutex<HashMap<String, String>>,
}

impl Tresor for SpeicherTresor {
    fn lesen(&self, name: &str) -> Result<Option<String>, TresorFehler> {
        Ok(self.inhalt.lock().map_err(|e| TresorFehler::Zugriff(e.to_string()))?.get(name).cloned())
    }

    fn schreiben(&self, name: &str, wert: &str) -> Result<(), TresorFehler> {
        self.inhalt.lock().map_err(|e| TresorFehler::Zugriff(e.to_string()))?.insert(name.into(), wert.into());
        Ok(())
    }

    fn loeschen(&self, name: &str) -> Result<(), TresorFehler> {
        self.inhalt.lock().map_err(|e| TresorFehler::Zugriff(e.to_string()))?.remove(name);
        Ok(())
    }
}

/// Ein Tresor, der nie erreichbar ist (zeigt die Fehlertexte; Tests; Systeme ohne Tresor).
pub struct KeinTresor(pub String);

impl Tresor for KeinTresor {
    fn lesen(&self, _: &str) -> Result<Option<String>, TresorFehler> {
        Err(TresorFehler::NichtVerfuegbar(self.0.clone()))
    }
    fn schreiben(&self, _: &str, _: &str) -> Result<(), TresorFehler> {
        Err(TresorFehler::NichtVerfuegbar(self.0.clone()))
    }
    fn loeschen(&self, _: &str) -> Result<(), TresorFehler> {
        Err(TresorFehler::NichtVerfuegbar(self.0.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schreiben_lesen_loeschen() {
        let t: Box<dyn Tresor> = Box::new(SpeicherTresor::default());
        assert_eq!(t.lesen("a").unwrap(), None);
        t.schreiben("a", "geheim").unwrap();
        assert_eq!(t.lesen("a").unwrap().as_deref(), Some("geheim"));
        t.loeschen("a").unwrap();
        assert_eq!(t.lesen("a").unwrap(), None);
        t.loeschen("a").unwrap();
    }

    #[test]
    fn namen() {
        for gut in ["hf-token", "a.b_c-1", &"x".repeat(64)] {
            assert!(name_pruefen(gut).is_ok(), "{gut}");
        }
        for schlecht in ["", "Gross", "mit leer", "a/b", "ä", &"x".repeat(65), "a}b"] {
            assert_eq!(name_pruefen(schlecht).unwrap_err().code(), "TRESOR_NAME_UNZULAESSIG", "{schlecht}");
        }
    }

    #[test]
    fn verweise_werden_aufgeloest() {
        let t = SpeicherTresor::default();
        t.schreiben("hf-token", "hf_abc").unwrap();
        t.schreiben("zweiter", "Z").unwrap();
        assert_eq!(aufloesen("--token={tresor:hf-token}", &t).unwrap(), "--token=hf_abc");
        assert_eq!(aufloesen("{tresor:hf-token}/{tresor:zweiter}!", &t).unwrap(), "hf_abc/Z!");
        assert_eq!(aufloesen("ohne Verweis", &t).unwrap(), "ohne Verweis");
        assert_eq!(aufloesen("offen {tresor:x", &t).unwrap(), "offen {tresor:x");
    }

    #[test]
    fn fehlender_eintrag_und_kein_tresor_haben_katalogfehler() {
        let t = SpeicherTresor::default();
        assert_eq!(aufloesen("{tresor:nix}", &t).unwrap_err().code(), "TRESOR_EINTRAG_FEHLT");
        let kein = KeinTresor("Dienst läuft nicht".into());
        let f = aufloesen("{tresor:nix}", &kein).unwrap_err();
        assert_eq!(f.code(), "TRESOR_NICHT_VERFUEGBAR");
        assert!(f.meldung().abhilfe.contains("Linux"));
        // ohne Verweis wird der Tresor gar nicht berührt
        assert!(aufloesen("einfach", &kein).is_ok());
    }

    #[test]
    fn unzulaessiger_name_im_verweis() {
        let t = SpeicherTresor::default();
        assert_eq!(aufloesen("{tresor:Boese Name}", &t).unwrap_err().code(), "TRESOR_NAME_UNZULAESSIG");
    }
}
