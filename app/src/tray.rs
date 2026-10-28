//! Tray-Symbol (Menüleiste / Infobereich). Fehlt er (Linux ohne StatusNotifier), bleibt „Fenster schließen = beenden“.

use crate::befehle;
use crate::fenster;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter};

static VORHANDEN: AtomicBool = AtomicBool::new(false);

pub fn vorhanden() -> bool {
    VORHANDEN.load(Ordering::SeqCst)
}

/// Für den eigenen Tray eines Profils (z. B. `agent::tray`): meldet, dass ein Tray-Symbol existiert (Schließen versteckt dann nur).
pub fn als_vorhanden_markieren() {
    VORHANDEN.store(true, Ordering::SeqCst);
}

pub fn bauen(app: &AppHandle) -> tauri::Result<()> {
    let name = app.config().product_name.clone().unwrap_or_else(|| "FYOS".into());
    let anzeigen = MenuItem::with_id(app, "anzeigen", "Öffnen", true, None::<&str>)?;
    let einstellungen = MenuItem::with_id(app, "einstellungen", "Einstellungen …", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", "Nach Updates suchen …", true, None::<&str>)?;
    let trenner = PredefinedMenuItem::separator(app)?;
    let beenden = MenuItem::with_id(app, "beenden", "Beenden", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&anzeigen, &einstellungen, &update, &trenner, &beenden])?;
    let symbol = app.default_window_icon().cloned().ok_or_else(|| tauri::Error::AssetNotFound("Symbol".into()))?;
    TrayIconBuilder::with_id("huelle")
        .icon(symbol)
        .tooltip(name)
        .menu(&menu)
        .on_menu_event(|app, ereignis| match ereignis.id.as_ref() {
            "anzeigen" => fenster::nach_vorn(app),
            "einstellungen" => {
                let _ = fenster::haupt(app, true);
            }
            "update" => {
                let _ = fenster::haupt(app, true);
                let _ = app.emit_to(fenster::HAUPT, "tray-update", ());
            }
            "beenden" => befehle::beenden(app),
            _ => {}
        })
        .build(app)?;
    VORHANDEN.store(true, Ordering::SeqCst);
    Ok(())
}
