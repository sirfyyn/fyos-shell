//! Tresor-Schnittstelle für Geheimnisse (Tokens, Schlüssel). Geheimnisse gehören nie in `einstellungen.json`.
//!
//! D0 definiert nur die Schnittstelle und eine Fassung im Speicher (für Tests und Systeme ohne Tresor). Die Systemfassungen
//! (macOS Schlüsselbund, Windows Anmeldeinformationsverwaltung, Linux Secret Service über das Crate `keyring`) folgen in D1
//! hinter demselben Merkmal; die Agent-App hat die macOS-Fassung bereits (`apps/fyos-agent/src-tauri/src/schluessel.rs`).

use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TresorFehler {
    /// Das System bietet keinen Tresor an (z. B. Linux ohne Secret Service).
    NichtVerfuegbar(String),
    Zugriff(String),
}

pub trait Tresor: Send + Sync {
    fn lesen(&self, name: &str) -> Result<Option<String>, TresorFehler>;
    fn schreiben(&self, name: &str, wert: &str) -> Result<(), TresorFehler>;
    fn loeschen(&self, name: &str) -> Result<(), TresorFehler>;
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
    }
}
