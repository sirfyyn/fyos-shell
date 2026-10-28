//! Tray des Profils `agent`: Zustand (kein Runner / getrennt / bereit / arbeitet / wartet auf dich / pausiert), Zahl offener Freigaben, Ruhe.
//! Die Texte kommen aus `shell_core::agent::anzeige` (getestet); hier stehen nur Menü und Fenster.

use super::AgentZustand;
use crate::{befehle, fenster, tray as huelle_tray, zustand::{sperre, Huelle}};
use shell_core::agent::anzeige::{status_text, text_freigaben, titel_text, zustand_text};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};

const TRAY_ID: &str = "huelle";

pub struct Griffe {
    status: MenuItem<Wry>,
    freigaben: MenuItem<Wry>,
    ruhe: CheckMenuItem<Wry>,
}

pub fn bauen(app: &AppHandle) -> tauri::Result<()> {
    let ruhe_an = app.try_state::<Arc<Huelle>>().map(|h| sperre(&h.einstellungen).agent.ruhe).unwrap_or(false);
    let produkt = app.config().product_name.clone().unwrap_or_else(|| "FYOS Agent".into());
    let status = MenuItem::with_id(app, "status", format!("{produkt}: kein Runner eingerichtet"), false, None::<&str>)?;
    let freigaben = MenuItem::with_id(app, "freigaben", text_freigaben(0), false, None::<&str>)?;
    let ruhe = CheckMenuItem::with_id(app, "ruhe", "Ruhe (keine Benachrichtigungen)", true, ruhe_an, None::<&str>)?;
    let oeffnen = MenuItem::with_id(app, "oeffnen", "Öffnen", true, None::<&str>)?;
    let einstellungen = MenuItem::with_id(app, "einstellungen", "Einstellungen …", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", "Nach Updates suchen …", true, None::<&str>)?;
    let beenden = MenuItem::with_id(app, "beenden", "Beenden", true, None::<&str>)?;
    let (t1, t2) = (PredefinedMenuItem::separator(app)?, PredefinedMenuItem::separator(app)?);
    let menu = Menu::with_items(app, &[&status, &freigaben, &t1, &ruhe, &oeffnen, &einstellungen, &update, &t2, &beenden])?;
    let symbol = app.default_window_icon().cloned().ok_or_else(|| tauri::Error::AssetNotFound("Symbol".into()))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(symbol)
        .tooltip(produkt)
        .menu(&menu)
        .on_menu_event(|app, ereignis| match ereignis.id.as_ref() {
            "oeffnen" | "freigaben" => fenster::nach_vorn(app),
            "einstellungen" => {
                let _ = fenster::haupt(app, true);
            }
            "update" => {
                let _ = fenster::haupt(app, true);
                let _ = app.emit_to(fenster::HAUPT, "tray-update", ());
            }
            "ruhe" => {
                if let Some(h) = app.try_state::<Arc<Huelle>>() {
                    let an = !sperre(&h.einstellungen).agent.ruhe;
                    let _ = super::befehle::ruhe_setzen_intern(app, &h, an);
                }
            }
            "beenden" => befehle::beenden(app),
            _ => {}
        })
        .build(app)?;
    app.manage(Griffe { status, freigaben, ruhe });
    huelle_tray::als_vorhanden_markieren();
    Ok(())
}

/// Texte, Tooltip und (macOS) die Zahl neben dem Symbol nach dem Stand von `AgentZustand` setzen.
pub fn aktualisieren(app: &AppHandle) {
    let (Some(h), Some(a)) = (app.try_state::<Arc<Huelle>>(), app.try_state::<Arc<AgentZustand>>()) else { return };
    let produkt = app.config().product_name.clone().unwrap_or_else(|| "FYOS Agent".into());
    let (eingerichtet, ruhe) = {
        let e = sperre(&h.einstellungen);
        (e.agent.runner_adresse.as_deref().is_some_and(|x| !x.trim().is_empty()), e.agent.ruhe)
    };
    let (verbunden, offene, laeufe) = (a.verbunden.load(Ordering::SeqCst), a.offene.load(Ordering::SeqCst), a.laeufe.load(Ordering::SeqCst));
    let (kopf_art, kopf_busy) = sperre(&a.kopf).clone();
    let zustand = zustand_text(eingerichtet, verbunden, offene, &kopf_art, kopf_busy || laeufe > 0);
    let status = status_text(&produkt, zustand, ruhe);
    let frei = text_freigaben(offene);
    if let Some(g) = app.try_state::<Griffe>() {
        let _ = g.status.set_text(&status);
        let _ = g.freigaben.set_text(&frei);
        let _ = g.freigaben.set_enabled(offene > 0);
        let _ = g.ruhe.set_checked(ruhe);
    }
    if let Some(t) = app.tray_by_id(TRAY_ID) {
        let _ = t.set_tooltip(Some(format!("{status}\n{frei}")));
        let _ = t.set_title(titel_text(offene));
    }
}
