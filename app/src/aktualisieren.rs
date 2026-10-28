//! Update und Rückweg mit dem Tauri-Updater. Die Entscheidungen (Versionen, Adressen, Merken der Vorversion) liegen in
//! `shell-core`; hier steht nur die Anbindung an das Plugin und die Übersetzung seiner Fehler in den Fehlerkatalog.
//!
//! Sicherheit: Der Updater prüft die Minisign-Signatur gegen den **eingebauten** Schlüssel (`plugins.updater.pubkey`);
//! ein Paket ohne passende Signatur wird nie eingespielt. Für den Rückweg wird die Versionsprüfung auf „genau die gemerkte
//! Vorversion“ gesetzt, sonst bleibt die Vorgabe „nur neuere“.

use crate::zustand::{sperre, Huelle};
use serde::Serialize;
use shell_core::update::{ist_rueckweg_ziel, manifest_url, version_lesen};
use shell_core::verlauf::Art;
use shell_core::Fehler;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_updater::{Error as UpdaterFehler, Update, Updater, UpdaterExt};

/// Was ein Update-Angebot der Oberfläche zeigt.
#[derive(Debug, Clone, Serialize)]
pub struct Angebot {
    pub version: String,
    pub notizen: Option<String>,
}

/// Übersetzt Fehler des Updaters in den Katalog. `url` ist das befragte Manifest.
pub fn fehler_aus_updater(e: &UpdaterFehler, url: &str) -> Fehler {
    use UpdaterFehler as E;
    let grund = e.to_string();
    match e {
        E::ReleaseNotFound => Fehler::ManifestFehlt { url: url.to_string() },
        E::Reqwest(r) if r.is_decode() => Fehler::ManifestUnlesbar { url: url.to_string(), grund },
        E::Reqwest(_) | E::Network(_) => Fehler::ServerNichtErreichbar { url: url.to_string(), grund },
        E::Serialization(_)
        | E::Semver(_)
        | E::InvalidUpdaterFormat
        | E::TargetNotFound(_)
        | E::TargetsNotFound(_)
        | E::UnsupportedArch
        | E::UnsupportedOs => Fehler::ManifestUnlesbar { url: url.to_string(), grund },
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) | E::SignedVersionMismatch { .. } | E::MissingSignedVersion => {
            Fehler::SignaturFalsch
        }
        E::Io(io) => match Fehler::aus_io(io, std::path::Path::new("(Update-Ordner)")) {
            voll @ Fehler::PlatteVoll { .. } => voll,
            _ => Fehler::UpdateEinspielenFehlgeschlagen { grund },
        },
        E::InsecureTransportProtocol | E::EmptyEndpoints => Fehler::UpdaterNichtEingerichtet { grund },
        _ => Fehler::UpdateEinspielenFehlgeschlagen { grund },
    }
}

/// Registriert das Updater-Plugin. Fehlt der Schlüssel in der Konfiguration, läuft die Hülle weiter, nur ohne Update.
pub fn plugin_einrichten(app: &AppHandle, h: &Huelle) {
    if let Err(e) = app.plugin(tauri_plugin_updater::Builder::new().build()) {
        *sperre(&h.updater_fehler) = Some(Fehler::UpdaterNichtEingerichtet { grund: e.to_string() });
    }
}

/// Basisadresse der Manifeste: Einstellung, sonst der eingebaute Endpunkt ohne `latest.json`.
fn basis(app: &AppHandle, h: &Huelle) -> Result<String, Fehler> {
    // Nur Debug-Bauten: der Test-Server wird über die Umgebung eingestellt; ein Release ignoriert sie.
    if cfg!(debug_assertions) {
        if let Some(b) = std::env::var("FYOS_SHELL_UPDATE_BASIS").ok().filter(|b| !b.trim().is_empty()) {
            return Ok(b);
        }
    }
    if let Some(b) = sperre(&h.einstellungen).update_basis.clone().filter(|b| !b.trim().is_empty()) {
        return Ok(b);
    }
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("endpoints"))
        .and_then(|e| e.get(0))
        .and_then(|e| e.as_str())
        .map(|e| e.trim_end_matches("latest.json").to_string())
        .ok_or_else(|| Fehler::UpdaterNichtEingerichtet { grund: "keine Update-Adresse eingebaut oder eingestellt".into() })
}

fn updater_bauen(app: &AppHandle, h: &Huelle, art: Art) -> Result<(Updater, String), Fehler> {
    if let Some(f) = sperre(&h.updater_fehler).clone() {
        return Err(f);
    }
    let basis = basis(app, h)?;
    let ungueltig = |grund: String| Fehler::UpdaterNichtEingerichtet { grund };
    let mut bauer = app.updater_builder().timeout(Duration::from_secs(15));
    let url = match art {
        Art::Update => manifest_url(&basis, None),
        Art::Rueckweg => {
            let ziel = {
                let v = sperre(&h.verlauf);
                version_lesen(v.rueckweg_ziel(&h.version)?)?
            };
            let laufend = version_lesen(&h.version)?;
            let adresse = manifest_url(&basis, Some(&ziel));
            bauer = bauer.version_comparator(move |_, angebot| ist_rueckweg_ziel(&laufend, &angebot.version, &ziel));
            adresse
        }
    };
    let endpunkt = url.parse().map_err(|e: url::ParseError| ungueltig(format!("{url}: {e}")))?;
    let updater = bauer
        .endpoints(vec![endpunkt])
        .and_then(|b| b.build())
        .map_err(|e| fehler_aus_updater(&e, &url))?;
    Ok((updater, url))
}

/// Fragt den Server. `Ok(None)`: nichts zu tun (bei `Art::Update`: aktuell).
pub async fn pruefen(app: &AppHandle, h: &Huelle, art: Art) -> Result<Option<(Update, String)>, Fehler> {
    let (updater, url) = updater_bauen(app, h, art)?;
    let gefunden = updater.check().await.map_err(|e| fehler_aus_updater(&e, &url))?;
    Ok(gefunden.map(|u| (u, url)))
}

impl From<&Update> for Angebot {
    fn from(u: &Update) -> Self {
        Angebot { version: u.version.clone(), notizen: u.body.clone() }
    }
}

/// Lädt, prüft die Signatur und spielt ein. Die Erwartung wird vorher gemerkt; scheitert das Einspielen, wird sie
/// wieder gelöscht, damit der nächste Start keinen falschen Fehler meldet. Gibt die neue Version zurück (`None`: nichts zu tun).
pub async fn einspielen(app: &AppHandle, h: &Huelle, art: Art) -> Result<Option<String>, Fehler> {
    let Some((update, url)) = pruefen(app, h, art).await? else { return Ok(None) };
    {
        let mut v = sperre(&h.verlauf);
        v.vor_update(art, &h.version, &update.version);
        v.speichern(&h.pfade)?;
    }
    if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
        let mut v = sperre(&h.verlauf);
        v.ausstehend = None;
        let _ = v.speichern(&h.pfade);
        return Err(fehler_aus_updater(&e, &url));
    }
    Ok(Some(update.version.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signaturfehler_werden_erkannt() {
        let f = fehler_aus_updater(&UpdaterFehler::SignatureUtf8("x".into()), "u");
        assert_eq!(f, Fehler::SignaturFalsch);
        let f = fehler_aus_updater(&UpdaterFehler::MissingSignedVersion, "u");
        assert_eq!(f, Fehler::SignaturFalsch);
    }

    #[test]
    fn fehlendes_manifest_und_netz() {
        assert_eq!(fehler_aus_updater(&UpdaterFehler::ReleaseNotFound, "http://x/latest.json").code(), "UPDATE_MANIFEST_FEHLT");
        assert_eq!(fehler_aus_updater(&UpdaterFehler::Network("weg".into()), "u").code(), "SERVER_NICHT_ERREICHBAR");
    }

    #[test]
    fn platte_voll_und_sonstige_io() {
        let voll = UpdaterFehler::Io(std::io::Error::from_raw_os_error(28));
        assert_eq!(fehler_aus_updater(&voll, "u").code(), "PLATTE_VOLL");
        let recht = UpdaterFehler::Io(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        assert_eq!(fehler_aus_updater(&recht, "u").code(), "UPDATE_EINSPIELEN_FEHLGESCHLAGEN");
    }

    #[test]
    fn unlesbares_manifest() {
        let kaputt: Result<serde_json::Value, _> = serde_json::from_str("{");
        let f = fehler_aus_updater(&UpdaterFehler::Serialization(kaputt.unwrap_err()), "u");
        assert_eq!(f.code(), "UPDATE_MANIFEST_UNLESBAR");
    }
}
