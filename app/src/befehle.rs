//! Befehle, die das Hauptfenster aufrufen darf (Liste in `build.rs`, Rechte in `capabilities/haupt.json`).
//! Fehler gehen als `Meldung` (Code, Ursache, Abhilfe) an die Oberfläche; sie zeigt sie unverändert an.

use crate::aktualisieren::{self, Angebot};
use crate::fenster;
use crate::studio_http;
use crate::zustand::{sperre, BegleiterStand, Huelle};
use serde::Serialize;
use shell_core::autostart::{standard_ordner, Ablage, Art as AutostartArt, Autostart, DateiAblage};
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
    /// Start bei der Anmeldung eingeschaltet (Eintrag vorhanden und zeigt auf dieses Programm)
    autostart: bool,
    /// Ergebnis des letzten Updates oder Rückwegs (nach dem Neustart gemeldet)
    ausgang: Option<AusgangInfo>,
    warnungen: Vec<Meldung>,
    /// Gesetzt, wenn Updates in dieser Fassung nicht möglich sind
    updater: Option<Meldung>,
    begleiter: BegleiterStand,
    /// Woher der Studio-Server kommt: "Einstellungen" oder "Bündel" (leer: keiner)
    begleiter_quelle: String,
    /// Versionen im mitgelieferten Python-Bündel (Python, Studio)
    buendel: Option<(String, String)>,
    /// Plugin-Pakete des Nutzers (Ordner studio-plugins im Datenordner), unverändert
    studio_plugins: Vec<String>,
    /// Angebot „Aus bestehendem Studio übernehmen“ (Studio-Profil): Stand, Ort, Anzahl und Größe
    uebernahme: crate::uebernahme::Anzeige,
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
        autostart: autostart_von(&app).ist_an().unwrap_or(false),
        ausgang,
        warnungen: sperre(&h.warnungen).clone(),
        updater: sperre(&h.updater_fehler).as_ref().map(Fehler::meldung),
        begleiter: sperre(&h.begleiter_stand).clone(),
        begleiter_quelle: sperre(&h.begleiter_quelle).clone(),
        buendel: h.buendel.as_ref().map(|b| (b.python_version.clone(), b.studio_version.clone())),
        studio_plugins: shell_core::buendel::nutzer_plugins_gefunden(&h.pfade.daten),
        uebernahme: crate::uebernahme::anzeige(&app, &h),
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

/// Übernimmt Chats und Einstellungen aus dem bestehenden Python-Studio (einmalig, nur kopierend; `trocken` zeigt nur den Plan).
/// Nach einer echten Übernahme startet der Studio-Server neu, damit er die übernommenen Dateien liest.
#[tauri::command]
pub async fn studio_uebernehmen(app: AppHandle, h: H<'_>, trocken: bool) -> Result<serde_json::Value, Meldung> {
    let h = h.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut ergebnis = crate::uebernahme::ausfuehren(&app, &h, trocken)?;
        if !trocken && ergebnis["neustart_noetig"] == true {
            ergebnis["neustart"] = serde_json::json!(h.begleiter_neustarten().is_ok());
        }
        Ok::<_, Fehler>(ergebnis)
    })
    .await
    .map_err(|e| m(Fehler::UebernahmeFehlgeschlagen { ort: String::new(), grund: e.to_string() }))?
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

/// Der Anmeldestart dieses Profils auf diesem System. `FYOS_SHELL_AUTOSTART_ORDNER` legt den Eintrag in einen anderen Ordner
/// (Tests, Support); sonst: LaunchAgents, XDG-autostart oder Registry-Run-Schlüssel des Benutzers.
pub fn autostart_von(app: &AppHandle) -> Autostart {
    use tauri::Manager;
    let art = AutostartArt::dieses_system();
    let ablage: Box<dyn Ablage> = match std::env::var_os("FYOS_SHELL_AUTOSTART_ORDNER").filter(|p| !p.is_empty()) {
        Some(p) => Box::new(DateiAblage { ordner: p.into() }),
        None => {
            #[cfg(windows)]
            {
                Box::new(shell_core::autostart::registry::RunSchluessel)
            }
            #[cfg(not(windows))]
            {
                let heim = app.path().home_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
                let xdg = std::env::var_os("XDG_CONFIG_HOME").filter(|p| !p.is_empty()).map(std::path::PathBuf::from);
                Box::new(DateiAblage { ordner: standard_ordner(art, &heim, xdg.as_deref()) })
            }
        }
    };
    // Als AppImage startet man das AppImage selbst, nicht das entpackte Programm im temporären Ordner.
    let programm = std::env::var("APPIMAGE")
        .ok()
        .filter(|p| !p.is_empty())
        .or_else(|| std::env::current_exe().ok().map(|p| p.display().to_string()))
        .unwrap_or_default();
    Autostart {
        art,
        bundle_id: app.config().identifier.clone(),
        anzeigename: app.config().product_name.clone().unwrap_or_else(|| "FYOS".into()),
        programm,
        ablage,
    }
}

/// Schaltet den Start bei der Anmeldung ein oder aus und merkt es in den Einstellungen (Opt-in; Vorgabe aus).
pub fn autostart_schalten(app: &AppHandle, h: &Huelle, an: bool) -> Result<(), Fehler> {
    autostart_von(app).setzen(an)?;
    let mut e = sperre(&h.einstellungen);
    e.autostart = an;
    einstellungen::speichern(&h.pfade, &e)
}

#[tauri::command]
pub fn autostart_setzen(app: AppHandle, h: H<'_>, an: bool) -> Result<(), Meldung> {
    autostart_schalten(&app, &h, an).map_err(m)
}

/// Ordner für Berichte: der Schreibtisch des Nutzers, sonst `berichte/` im Datenordner.
fn bericht_ordner(app: &AppHandle, h: &Huelle) -> std::path::PathBuf {
    use tauri::Manager;
    if let Some(p) = std::env::var_os("FYOS_SHELL_BERICHTE").filter(|p| !p.is_empty()) {
        return std::path::PathBuf::from(p); // Tests und Support: anderer Ordner
    }
    app.path().desktop_dir().ok().filter(|p| p.is_dir()).unwrap_or_else(|| h.pfade.daten.join("berichte"))
}

/// Schreibt den Fehlerbericht (Version, System, Meldungen mit Ursache und Abhilfe, geschwärzte Einstellungen und Protokoll) als Datei.
/// Nichts wird hochgeladen. `zusatz` ist die Meldung, die der Nutzer gerade sieht. Auch für `--bericht` auf der Kommandozeile.
pub fn bericht_schreiben(app: &AppHandle, h: &Huelle, zusatz: Option<Meldung>) -> Result<std::path::PathBuf, Fehler> {
    let produkt = app.config().product_name.clone().unwrap_or_else(|| "FYOS".into());
    shell_core::bericht::speichern(&bericht_ordner(app, h), &h.bericht(&produkt, zusatz))
}

#[tauri::command]
pub fn bericht_speichern(app: AppHandle, h: H<'_>, meldung: Option<Meldung>) -> Result<String, Meldung> {
    bericht_schreiben(&app, &h, meldung).map(|p| p.display().to_string()).map_err(m)
}

/// Ist der Tresor erreichbar? Liest einen Eintrag, den es nicht gibt; so entsteht kein Eintrag und keine Rückfrage des Systems.
/// Wird nur auf Wunsch aufgerufen (Knopf „Tresor prüfen“), nie beim Start.
#[tauri::command]
pub fn tresor_pruefen(h: H<'_>) -> Result<(), Meldung> {
    h.tresor.lesen("tresor-probe").map(|_| ()).map_err(|f| m(f.into()))
}

/// Legt ein Geheimnis im Tresor ab (nie in einer Datei). Der Wert kommt nicht wieder zur Oberfläche zurück.
#[tauri::command]
pub fn geheimnis_setzen(h: H<'_>, name: String, wert: String) -> Result<(), Meldung> {
    shell_core::tresor::name_pruefen(&name).map_err(m)?;
    h.tresor.schreiben(&name, &wert).map_err(|f| m(f.into()))
}

#[tauri::command]
pub fn geheimnis_loeschen(h: H<'_>, name: String) -> Result<(), Meldung> {
    shell_core::tresor::name_pruefen(&name).map_err(m)?;
    h.tresor.loeschen(&name).map_err(|f| m(f.into()))
}

/// Gibt es den Eintrag? (Antwort ja/nein, nie der Wert.)
#[tauri::command]
pub fn geheimnis_vorhanden(h: H<'_>, name: String) -> Result<bool, Meldung> {
    shell_core::tresor::name_pruefen(&name).map_err(m)?;
    h.tresor.lesen(&name).map(|w| w.is_some()).map_err(|f| m(f.into()))
}

/// Sauber beenden: erst den Begleiter, dann die Anwendung.
pub fn beenden(app: &AppHandle) {
    use tauri::Manager;
    fenster::lage_merken(app);
    if let Some(h) = app.try_state::<Arc<Huelle>>() {
        h.begleiter_beenden();
    }
    if let Some(a) = app.try_state::<Arc<crate::agent::AgentZustand>>() {
        a.lokal.stoppen();
    }
    app.exit(0);
}
