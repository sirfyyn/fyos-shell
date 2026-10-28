//! Befehle, die das Hauptfenster aufrufen darf (Liste in `build.rs`, Rechte in `capabilities/haupt.json`).
//! Fehler gehen als `Meldung` (Code, Ursache, Abhilfe) an die Oberfläche; sie zeigt sie unverändert an.

use crate::aktualisieren::{self, Angebot};
use crate::fenster;
use crate::studio_http;
use crate::zustand::{sperre, BegleiterStand, Huelle};
use serde::Serialize;
use shell_core::einstellungen;
use shell_core::studio::StudioZustand;
use shell_core::verlauf::{Ausgang, Art};
use shell_core::{Fehler, Meldung};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, State};

type H<'a> = State<'a, Arc<Huelle>>;

#[derive(Serialize)]
pub struct AusgangInfo {
    ok: bool,
    text: String,
    meldung: Option<Meldung>,
}

#[derive(Serialize)]
pub struct Info {
    profil: &'static str,
    name: String,
    version: String,
    vorherige: Option<String>,
    os: &'static str,
    arch: &'static str,
    daten: String,
    start_url: String,
    update_basis: Option<String>,
    /// Ergebnis des letzten Updates oder Rückwegs (nach dem Neustart gemeldet)
    ausgang: Option<AusgangInfo>,
    warnungen: Vec<Meldung>,
    /// Gesetzt, wenn Updates in dieser Fassung nicht möglich sind
    updater: Option<Meldung>,
    begleiter: BegleiterStand,
}

#[derive(Serialize)]
#[serde(tag = "stand", rename_all = "snake_case")]
pub enum Pruefung {
    Aktuell,
    Verfuegbar(Angebot),
}

#[derive(Serialize)]
pub struct Eingespielt {
    version: String,
}

fn m(f: Fehler) -> Meldung {
    f.meldung()
}

#[tauri::command]
pub fn info(app: AppHandle, h: H<'_>) -> Info {
    let name = app.config().product_name.clone().unwrap_or_default();
    let ausgang = sperre(&h.start_ausgang).as_ref().map(|a| match a {
        Ausgang::Erfolg { .. } => AusgangInfo { ok: true, text: a.text(), meldung: None },
        Ausgang::Misserfolg(f) => AusgangInfo { ok: false, text: a.text(), meldung: Some(f.meldung()) },
    });
    Info {
        profil: h.profil.name(),
        name,
        version: h.version.clone(),
        vorherige: sperre(&h.verlauf).vorherige.clone().filter(|v| *v != h.version),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        daten: h.pfade.daten.display().to_string(),
        start_url: h.start_url(),
        update_basis: sperre(&h.einstellungen).update_basis.clone(),
        ausgang,
        warnungen: sperre(&h.warnungen).clone(),
        updater: sperre(&h.updater_fehler).as_ref().map(Fehler::meldung),
        begleiter: sperre(&h.begleiter_stand).clone(),
    }
}

#[tauri::command]
pub async fn update_pruefen(app: AppHandle, h: H<'_>) -> Result<Pruefung, Meldung> {
    match aktualisieren::pruefen(&app, &h, Art::Update).await.map_err(m)? {
        Some((u, _)) => Ok(Pruefung::Verfuegbar(Angebot::from(&u))),
        None => Ok(Pruefung::Aktuell),
    }
}

/// Spielt das Update ein und startet neu. Die Antwort kommt vor dem Neustart, damit die Oberfläche es anzeigen kann.
#[tauri::command]
pub async fn update_einspielen(app: AppHandle, h: H<'_>) -> Result<Eingespielt, Meldung> {
    einspielen(app, &h, Art::Update).await
}

/// Geht auf die gemerkte Vorversion zurück und startet neu.
#[tauri::command]
pub async fn update_zurueck(app: AppHandle, h: H<'_>) -> Result<Eingespielt, Meldung> {
    einspielen(app, &h, Art::Rueckweg).await
}

async fn einspielen(app: AppHandle, h: &Arc<Huelle>, art: Art) -> Result<Eingespielt, Meldung> {
    let version = aktualisieren::einspielen(&app, h, art)
        .await
        .map_err(m)?
        .ok_or_else(|| m(Fehler::ManifestFehlt { url: "(Server nennt keine passende Version)".into() }))?;
    let h = h.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        h.begleiter_beenden();
        app.restart();
    });
    Ok(Eingespielt { version })
}

#[tauri::command]
pub async fn studio_pruefen(h: H<'_>) -> Result<StudioZustand, Meldung> {
    let url = h.gesundheits_url();
    let kennung = h.kennung();
    tauri::async_runtime::spawn_blocking(move || studio_http::holen(&url, kennung.as_deref()))
        .await
        .map_err(|e| m(Fehler::StudioNichtErreichbar { url: String::new(), grund: e.to_string() }))?
        .map_err(m)
}

#[tauri::command]
pub async fn studio_neustart(h: H<'_>) -> Result<(), Meldung> {
    let h = h.inner().clone();
    tauri::async_runtime::spawn_blocking(move || h.begleiter_neustarten())
        .await
        .map_err(|e| m(Fehler::BegleiterBeendet { grund: e.to_string() }))?
        .map_err(m)
}

#[tauri::command]
pub fn inhalt_oeffnen(app: AppHandle, h: H<'_>) -> Result<(), Meldung> {
    fenster::inhalt(&app, &h.start_url()).map_err(m)
}

/// Ändert eine Einstellung. Erlaubt sind nur die in der Oberfläche vorgesehenen Schlüssel.
#[tauri::command]
pub fn einstellung_setzen(h: H<'_>, schluessel: String, wert: Option<String>) -> Result<(), Meldung> {
    let wert = wert.map(|w| w.trim().to_string()).filter(|w| !w.is_empty());
    let mut e = sperre(&h.einstellungen);
    match schluessel.as_str() {
        "start_url" => e.start_url = wert,
        "update_basis" => e.update_basis = wert,
        _ => return Err(m(Fehler::LinkAbgelehnt { link: schluessel, grund: "diese Einstellung gibt es nicht".into() })),
    }
    einstellungen::speichern(&h.pfade, &e).map_err(m)
}

/// Die Seite meldet, dass sie gezeichnet hat (Selbsttest und Diagnose).
#[tauri::command]
pub fn seite_bereit(h: H<'_>, zeichnet: bool, version: String) {
    *sperre(&h.seite_bereit) = Some((zeichnet, version));
}

/// Sauber beenden: erst den Begleiter, dann die Anwendung.
pub fn beenden(app: &AppHandle) {
    use tauri::Manager;
    if let Some(h) = app.try_state::<Arc<Huelle>>() {
        h.begleiter_beenden();
    }
    app.exit(0);
}
