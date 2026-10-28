//! Die drei Profile der Hülle. Ein Profil ist eine Konfigurationsmenge (`app/profile/<name>.conf.json`), kein Fork:
//! das Programm erkennt sein Profil an der Bundle-Id aus der Tauri-Konfiguration.

use crate::fehler::Fehler;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profil {
    Studio,
    Agent,
    Os,
}

impl Profil {
    pub const ALLE: [Profil; 3] = [Profil::Studio, Profil::Agent, Profil::Os];

    /// Bundle-Id (`de.sirfyyn.fyos-agent` besteht bereits und bleibt).
    pub fn bundle_id(self) -> &'static str {
        match self {
            Profil::Studio => "de.sirfyyn.fle-studio",
            Profil::Agent => "de.sirfyyn.fyos-agent",
            Profil::Os => "de.sirfyyn.fyos-os",
        }
    }

    /// Kurzname, wie er in Dateinamen, Befehlen und der Dokumentation steht.
    pub fn name(self) -> &'static str {
        match self {
            Profil::Studio => "studio",
            Profil::Agent => "agent",
            Profil::Os => "os",
        }
    }

    pub fn aus_bundle_id(kennung: &str) -> Result<Profil, Fehler> {
        Profil::ALLE
            .into_iter()
            .find(|p| p.bundle_id() == kennung)
            .ok_or_else(|| Fehler::ProfilUnbekannt { kennung: kennung.to_string() })
    }

    /// Deeplink-Schema des Profils (`fle://` für Studio, `fyos://` sonst).
    pub fn schema(self) -> &'static str {
        match self {
            Profil::Studio => "fle",
            Profil::Agent | Profil::Os => "fyos",
        }
    }

    /// Vorgabe der Start-URL des Inhaltsfensters; für D0 ein lokaler Test-Server, die Einstellungen überschreiben sie.
    pub fn standard_start_url(self) -> &'static str {
        match self {
            Profil::Studio => "http://127.0.0.1:8642/",
            Profil::Agent => "http://127.0.0.1:8650/",
            Profil::Os => "https://fyos.sirfyyn.de/os",
        }
    }

    /// Nur Studio führt ein Hilfsprogramm als Kindprozess (Plan S-A).
    pub fn hat_begleiter(self) -> bool {
        self == Profil::Studio
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_ids_gehen_hin_und_zurueck() {
        for p in Profil::ALLE {
            assert_eq!(Profil::aus_bundle_id(p.bundle_id()).unwrap(), p);
        }
    }

    #[test]
    fn die_vereinbarten_bundle_ids() {
        assert_eq!(Profil::Studio.bundle_id(), "de.sirfyyn.fle-studio");
        assert_eq!(Profil::Os.bundle_id(), "de.sirfyyn.fyos-os");
        assert_eq!(Profil::Agent.bundle_id(), "de.sirfyyn.fyos-agent");
    }

    #[test]
    fn unbekannte_kennung_ist_ein_katalogfehler() {
        let f = Profil::aus_bundle_id("de.example.x").unwrap_err();
        assert_eq!(f.code(), "PROFIL_UNBEKANNT");
    }

    #[test]
    fn schemata_und_begleiter() {
        assert_eq!(Profil::Studio.schema(), "fle");
        assert_eq!(Profil::Os.schema(), "fyos");
        assert!(Profil::Studio.hat_begleiter());
        assert!(!Profil::Os.hat_begleiter());
    }
}
