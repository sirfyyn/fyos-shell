//! `shell-core`: der Kern der FYOS-Hülle ohne Tauri und ohne Fenster. Alles hier ist mit `cargo test` prüfbar.
//!
//! - [`fehler`]: Katalog mit Ursache und Abhilfe
//! - [`profil`]: studio, agent, os
//! - [`speicher`], [`einstellungen`], [`verlauf`]: Datenordner, Einstellungen, Vorversion (Rückweg)
//! - [`update`]: Versionsvergleich und Manifest-Adressen
//! - [`links`]: Deeplink-Prüfung
//! - [`bericht`]: Fehlerbericht ohne Geheimnisse
//! - [`begleiter`]: Schnittstelle und Kindprozess für den Studio-Server
//! - [`prozessgruppe`]: Prozessbaum beenden (Unix: Prozessgruppe, Windows: Job-Objekt)
//! - [`studio`]: Lesen von `/api/state`
//! - [`tresor`]: Schnittstelle für Geheimnisse

pub mod autostart;
pub mod begleiter;
pub mod buendel;
pub mod bericht;
pub mod einstellungen;
pub mod fehler;
pub mod fensterlage;
pub mod links;
pub mod mitteilung;
pub mod navigation;
pub mod netz;
pub mod profil;
pub mod prozessgruppe;
pub mod speicher;
pub mod studio;
pub mod tresor;
pub mod uebernahme;
pub mod update;
pub mod verlauf;

pub use fehler::{Fehler, Meldung};
pub use profil::Profil;
