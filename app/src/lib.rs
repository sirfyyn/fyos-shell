//! FYOS-Hülle: eine Tauri-2-Anwendung, drei Profile (studio, agent, os).
//!
//! Das Profil ergibt sich aus der Bundle-Id der Konfiguration (`profile/<name>.conf.json`), nicht aus dem Quelltext.
//! Alle Entscheidungen liegen in `shell-core`; hier stehen nur Fenster, Tray, Updater-Anbindung und Befehle.
//! Übersicht und Bedienung: `apps/fyos-shell/README.md`.

mod aktualisieren;
mod befehle;
mod cli;
mod fenster;
mod headless;
mod studio_http;
mod tray;
mod zustand;

use cli::Modus;
use shell_core::speicher::Pfade;
use shell_core::{Fehler, Profil};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use zustand::Huelle;

/// Datenordner: `FYOS_SHELL_DATEN` (Tests), sonst der Datenordner des Systems für diese Bundle-Id.
/// Er liegt außerhalb des Programmpakets, ein Update fasst ihn nie an.
fn datenordner(app: &tauri::AppHandle) -> Result<PathBuf, Fehler> {
    if let Some(p) = std::env::var_os("FYOS_SHELL_DATEN").filter(|p| !p.is_empty()) {
        return Ok(PathBuf::from(p));
    }
    app.path().app_data_dir().map_err(|e| Fehler::DatenordnerNichtBeschreibbar { pfad: "(Datenordner des Systems)".into(), grund: e.to_string() })
}

/// Deeplinks aus Argumenten (Windows/Linux: der zweite Start reicht sie weiter).
fn deeplinks_aus(args: &[String], schema: &str) -> Vec<String> {
    let praefix = format!("{schema}://");
    args.iter().filter(|a| a.starts_with(&praefix)).cloned().collect()
}

pub fn run() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let modus = match cli::auswerten(&args) {
        Ok(m) => m,
        Err(text) => {
            let hilfe = text.starts_with("Aufruf:");
            eprintln!("{text}");
            std::process::exit(if hilfe { 0 } else { 64 });
        }
    };

    let mut bauer = tauri::Builder::default();
    if matches!(modus, Modus::Fenster { .. }) {
        // Einzelinstanz: der zweite Start holt das Fenster nach vorn und reicht Deeplinks weiter
        bauer = bauer.plugin(tauri_plugin_single_instance::init(|app, argumente, _verzeichnis| {
            fenster::nach_vorn(app);
            if let Some(h) = app.try_state::<Arc<Huelle>>() {
                for link in deeplinks_aus(&argumente, h.profil.schema()) {
                    fenster::deeplink(app, &h, &link);
                }
            }
        }));
    }

    let app = bauer
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            befehle::info,
            befehle::update_pruefen,
            befehle::update_einspielen,
            befehle::update_zurueck,
            befehle::studio_pruefen,
            befehle::studio_neustart,
            befehle::inhalt_oeffnen,
            befehle::einstellung_setzen,
            befehle::seite_bereit,
        ])
        .on_window_event(|fenster, ereignis| {
            // Mit Tray: Schließen des Hauptfensters versteckt nur (die Hülle lebt im Tray weiter). Ohne Tray beendet es.
            if let WindowEvent::CloseRequested { api, .. } = ereignis {
                if fenster.label() == fenster::HAUPT && tray::vorhanden() {
                    api.prevent_close();
                    let _ = fenster.hide();
                }
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let melde = |f: Fehler| -> Box<dyn std::error::Error> {
                eprintln!("{f}");
                Box::new(f)
            };
            let profil = Profil::aus_bundle_id(&handle.config().identifier).map_err(melde)?;
            let daten = datenordner(&handle).map_err(melde)?;
            let version = handle.package_info().version.to_string();
            let huelle = Arc::new(Huelle::laden(profil, &version, Pfade::neu(daten)).map_err(melde)?);
            app.manage(huelle.clone());
            aktualisieren::plugin_einrichten(&handle, &huelle);

            // SIGINT/SIGTERM: sauber beenden, damit der Begleiter nicht als Waise weiterläuft
            let fuer_signal = handle.clone();
            if let Err(e) = ctrlc::set_handler(move || befehle::beenden(&fuer_signal)) {
                eprintln!("Signalbehandlung nicht eingerichtet: {e}");
            }

            if let Modus::Fenster { versteckt } = modus {
                // Deeplinks: macOS über das System (nur aus installierter App), sonst über Argumente (oben) und Registrierung zur Laufzeit
                let (h2, app2) = (huelle.clone(), handle.clone());
                app.deep_link().on_open_url(move |ereignis| {
                    for url in ereignis.urls() {
                        fenster::deeplink(&app2, &h2, url.as_str());
                    }
                });
                #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
                if let Err(e) = app.deep_link().register_all() {
                    eprintln!("Deeplink-Schema nicht registriert: {e}");
                }
                if let Err(e) = tray::bauen(&handle) {
                    eprintln!("Tray nicht verfügbar ({e}); Schließen des Fensters beendet die Anwendung.");
                }
                // Begleiter im Hintergrund starten, das Fenster wartet nicht darauf (die Oberfläche zeigt „startet …“)
                let h3 = huelle.clone();
                std::thread::spawn(move || {
                    let _ = h3.begleiter_starten();
                });
                // Wächter: meldet einen von allein beendeten Begleiter
                let h4 = huelle.clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(Duration::from_secs(2));
                    h4.begleiter_pruefen();
                });
                if !versteckt || !tray::vorhanden() {
                    fenster::haupt(&handle, true)?;
                }
                for link in deeplinks_aus(&std::env::args().collect::<Vec<_>>(), profil.schema()) {
                    fenster::deeplink(&handle, &huelle, &link);
                }
            } else {
                headless::starten(handle, huelle, modus);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Die Hülle konnte nicht gebaut werden (Konfiguration prüfen)");

    app.run(|app, ereignis| {
        if let RunEvent::Exit = ereignis {
            if let Some(h) = app.try_state::<Arc<Huelle>>() {
                h.begleiter_beenden();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deeplinks_aus_argumenten() {
        let args: Vec<String> = ["--versteckt", "fle://oeffnen?ziel=seite:x", "fyos://oeffnen?ziel=app:y"].map(String::from).to_vec();
        assert_eq!(deeplinks_aus(&args, "fle"), vec!["fle://oeffnen?ziel=seite:x".to_string()]);
    }
}
