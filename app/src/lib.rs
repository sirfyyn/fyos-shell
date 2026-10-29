//! FYOS-Hülle: eine Tauri-2-Anwendung, drei Profile (studio, agent, os).
//!
//! Das Profil ergibt sich aus der Bundle-Id der Konfiguration (`profile/<name>.conf.json`), nicht aus dem Quelltext.
//! Alle Entscheidungen liegen in `shell-core`; hier stehen nur Fenster, Tray, Updater-Anbindung und Befehle.
//! Übersicht und Bedienung: `apps/fyos-shell/README.md`.

mod agent;
mod aktualisieren;
mod befehle;
mod cli;
mod fenster;
mod headless;
mod mitteilung;
mod os;
mod studio_http;
mod tray;
mod uebernahme;
mod zustand;

use cli::Modus;
use shell_core::speicher::Pfade;
use shell_core::{Fehler, Profil};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use shell_core::buendel::Buendel;
use zustand::Huelle;

/// Datenordner: `FYOS_SHELL_DATEN` (Tests), sonst der Datenordner des Systems für diese Bundle-Id.
/// Er liegt außerhalb des Programmpakets, ein Update fasst ihn nie an.
fn datenordner(app: &tauri::AppHandle) -> Result<PathBuf, Fehler> {
    if let Some(p) = std::env::var_os("FYOS_SHELL_DATEN").filter(|p| !p.is_empty()) {
        return Ok(PathBuf::from(p));
    }
    app.path().app_data_dir().map_err(|e| Fehler::DatenordnerNichtBeschreibbar { pfad: "(Datenordner des Systems)".into(), grund: e.to_string() })
}

/// Ressourcenordner der App (dort liegt das Python-Bündel). `FYOS_SHELL_RESSOURCEN` überschreibt ihn.
fn ressourcenordner(app: &tauri::AppHandle) -> PathBuf {
    if let Some(p) = std::env::var_os("FYOS_SHELL_RESSOURCEN").filter(|p| !p.is_empty()) {
        return PathBuf::from(p);
    }
    app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Der Tresor: im Betrieb der Systemtresor. **Nur in Debug-Bauten** (Tests) kann `FYOS_SHELL_TRESOR_SAAT=name=wert;name2=wert2` einen Tresor im
/// Arbeitsspeicher mit diesen Einträgen vorgeben, damit e2e-Läufe nie den Schlüsselbund des Entwicklers berühren. Release-Bauten kennen die Variable nicht.
fn tresor_waehlen(dienst: &str) -> Arc<dyn shell_core::tresor::Tresor> {
    #[cfg(debug_assertions)]
    if let Some(saat) = std::env::var_os("FYOS_SHELL_TRESOR_SAAT").filter(|s| !s.is_empty()) {
        let t = shell_core::tresor::SpeicherTresor::default();
        for paar in saat.to_string_lossy().split(';') {
            if let Some((n, w)) = paar.split_once('=') {
                let _ = shell_core::tresor::Tresor::schreiben(&t, n.trim(), w.trim());
            }
        }
        return Arc::new(t);
    }
    Arc::new(shell_tresor::SystemTresor::neu(dienst))
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
        // Systemmitteilungen: nur Rust ruft das Plugin (mitteilung.rs); das Plugin bekommt in keiner Capability Rechte für Seiten
        .plugin(tauri_plugin_notification::init())
        // Systemdialog „Ordner wählen“: nur Rust ruft ihn (agent/runner_befehle.rs, `ordner_waehlen`); keine Capability gibt einer Seite Rechte des Plugins
        .plugin(tauri_plugin_dialog::init())
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
            befehle::bericht_speichern,
            befehle::autostart_setzen,
            befehle::tresor_pruefen,
            befehle::geheimnis_setzen,
            befehle::geheimnis_loeschen,
            befehle::geheimnis_vorhanden,
            befehle::studio_uebernehmen,
            os::os_stand,
            os::os_wiederholen,
            agent::bruecke::runner_anfrage,
            agent::bruecke::strom_oeffnen,
            agent::bruecke::strom_schliessen,
            agent::befehle::agent_verbindung_pruefen,
            agent::runner_befehle::runner_liste,
            agent::runner_befehle::runner_speichern,
            agent::runner_befehle::runner_entfernen,
            agent::runner_befehle::runner_wechseln,
            agent::runner_befehle::lokaler_runner_einstellen,
            agent::runner_befehle::lokaler_runner_status,
            agent::runner_befehle::lokaler_runner_starten,
            agent::runner_befehle::lokaler_runner_stoppen,
            agent::runner_befehle::ordner_waehlen,
            agent::runner_befehle::ordner_zuletzt,
            agent::runner_befehle::ordner_merken,
            agent::befehle::agent_alt_uebernehmen,
            agent::befehle::agent_chat_oeffnen,
            agent::befehle::ziel_info,
            agent::befehle::ruhe_setzen,
            agent::befehle::zustand_melden,
            mitteilung::os_benachrichtigen,
        ])
        .on_window_event(|fenster, ereignis| {
            // Mit Tray: Schließen des Hauptfensters versteckt nur (die Hülle lebt im Tray weiter). Ohne Tray beendet es.
            if let WindowEvent::CloseRequested { api, .. } = ereignis {
                if (fenster.label() == fenster::HAUPT || fenster.label() == agent::fenster::CHAT) && tray::vorhanden() {
                    api.prevent_close();
                    let _ = fenster.hide();
                }
                if fenster.label() == fenster::INHALT {
                    fenster::lage_merken(fenster.app_handle());
                }
                if fenster.label() == agent::fenster::CHAT {
                    agent::fenster::lage_merken(fenster.app_handle());
                }
                // Profil OS ohne Tray: das Fenster zum Server ist die Anwendung, Schließen beendet sie (das versteckte Hauptfenster hielte sie sonst am Leben)
                if fenster.label() == fenster::INHALT && !tray::vorhanden() {
                    if let Some(h) = fenster.app_handle().try_state::<Arc<Huelle>>() {
                        if h.profil == Profil::Os {
                            befehle::beenden(fenster.app_handle());
                        }
                    }
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
            // Python-Bündel mit dem Studio-Server: im Ressourcenordner der App (FYOS_SHELL_RESSOURCEN überschreibt ihn für Entwicklung und Tests)
            let (buendel, buendel_fehler) = match Buendel::lesen(&ressourcenordner(&handle)) {
                Ok(b) => (b.filter(|_| profil.hat_begleiter()), None),
                Err(f) => (None, Some(f)),
            };
            let huelle = Arc::new(
                Huelle::laden(profil, &version, Pfade::neu(daten))
                    .map_err(melde)?
                    .mit_tresor(tresor_waehlen(&handle.config().identifier))
                    .mit_buendel(buendel),
            );
            if let Some(f) = buendel_fehler {
                zustand::sperre(&huelle.warnungen).push(f.meldung());
            }
            if profil == Profil::Agent {
                // bisheriger einzelner Runner → erster Eintrag der Liste (gleicher Tresor-Eintrag, nichts muss neu eingerichtet werden)
                let mut e = zustand::sperre(&huelle.einstellungen);
                if e.agent.runner_uebernehmen() {
                    let _ = shell_core::einstellungen::speichern(&huelle.pfade, &e);
                }
            }
            app.manage(huelle.clone());
            // Prüfbau (nur Debug, nur mit FYOS_SHELL_AGENT_E2E=1): kein Dock-Symbol, kein Fokusraub während der Prüfläufe
            #[cfg(all(debug_assertions, target_os = "macos"))]
            if std::env::var("FYOS_SHELL_AGENT_E2E").as_deref() == Ok("1") {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            app.manage(os::Fluss::default());
            let agent_zustand = Arc::new(agent::AgentZustand::neu());
            app.manage(agent_zustand.clone());
            app.manage(mitteilung::Begrenzer::default());
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
                let tray_ergebnis = if profil == Profil::Agent { agent::tray::bauen(&handle) } else { tray::bauen(&handle) };
                if let Err(e) = tray_ergebnis {
                    eprintln!("Tray nicht verfügbar ({e}); Schließen des Fensters beendet die Anwendung.");
                }
                if profil == Profil::Agent {
                    // Ist der lokale Runner der aktive, startet ihn die Hülle im Hintergrund (das Fenster zeigt „startet …“ und lädt neu)
                    let (hl, al, apl) = (huelle.clone(), agent_zustand.clone(), handle.clone());
                    std::thread::spawn(move || {
                        let lokal = zustand::sperre(&hl.einstellungen).agent.aktiver().is_some_and(|r| r.art == shell_core::agent::runner::Art::Lokal);
                        if lokal {
                            match al.lokal.starten(&hl, agent::lokal::start_wurzeln(&hl)) {
                                Ok(()) => agent::befehle::nach_aenderung(&apl, &al),
                                Err(f) => zustand::sperre(&hl.warnungen).push(f.meldung()),
                            }
                        }
                    });
                    // Beobachter für offene Freigaben und laufende Läufe (Tray, auch bei geschlossenem Fenster)
                    agent::beobachter::starte(handle.clone(), huelle.clone(), agent_zustand.clone());
                    agent::tray::aktualisieren(&handle);
                }
                // Anmeldestart erneuern, wenn eingeschaltet: das Programm kann seit dem Einschalten verschoben oder aktualisiert worden sein
                let autostart_an = zustand::sperre(&huelle.einstellungen).autostart;
                if autostart_an {
                    if let Err(f) = befehle::autostart_schalten(&handle, &huelle, true) {
                        zustand::sperre(&huelle.warnungen).push(f.meldung());
                    }
                }
                // Begleiter im Hintergrund starten, das Fenster wartet nicht darauf (die Oberfläche zeigt „startet …“)
                let (h3, app3) = (huelle.clone(), handle.clone());
                std::thread::spawn(move || {
                    // Profil Studio: ist der Server gesund, zeigt die Hülle gleich das Studio (Einstellung `inhalt_automatisch`, Vorgabe an;
                    // nicht beim Anmeldestart mit --versteckt)
                    if h3.begleiter_starten().is_ok() && h3.profil.hat_begleiter() && !versteckt && zustand::sperre(&h3.einstellungen).inhalt_automatisch {
                        if matches!(*zustand::sperre(&h3.begleiter_stand), zustand::BegleiterStand::Laeuft) {
                            if let Err(f) = fenster::inhalt(&app3, &h3.start_url()) {
                                zustand::sperre(&h3.warnungen).push(f.meldung());
                            }
                        }
                    }
                });
                // Wächter: meldet einen von allein beendeten Begleiter
                let h4 = huelle.clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(Duration::from_secs(2));
                    h4.begleiter_pruefen();
                });
                if profil == Profil::Os {
                    // Reines Fenster zum Server: kein Hauptfenster beim Start (ein verborgenes kostete einen eigenen WebContent-Prozess, gemessen);
                    // Einstellungen und Update öffnet das Tray-Menü bei Bedarf. Die Anwendung bleibt über das Tray-Symbol am Leben (siehe `ExitRequested`).
                    if !versteckt || !tray::vorhanden() {
                        os::oeffnen(&handle, &huelle);
                    }
                } else if profil == Profil::Agent {
                    // Chat-Fenster, sobald ein Runner eingetragen ist; sonst die Einstellungen mit der Runner-Verbindung
                    if !versteckt || !tray::vorhanden() {
                        agent::fenster::start_fenster(&handle, &huelle);
                    }
                } else if !versteckt || !tray::vorhanden() {
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
        // Profil OS lebt im Tray weiter, wenn das letzte Fenster geschlossen wird (der WebView ist dann freigegeben); „Beenden“ ruft app.exit(0) mit Code
        if let RunEvent::ExitRequested { api, code, .. } = &ereignis {
            agent::fenster::lage_merken(app); // auch beim Beenden über das Programmmenü (Cmd+Q)
            if code.is_none() && tray::vorhanden() && app.try_state::<Arc<Huelle>>().is_some_and(|h| h.profil == Profil::Os) {
                api.prevent_exit();
            }
        }
        if let RunEvent::Exit = ereignis {
            if let Some(h) = app.try_state::<Arc<Huelle>>() {
                h.begleiter_beenden();
            }
            if let Some(a) = app.try_state::<Arc<agent::AgentZustand>>() {
                a.lokal.stoppen();
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
