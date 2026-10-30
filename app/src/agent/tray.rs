//! Tray des Profils `agent`: Zustand (kein Runner / getrennt / bereit / arbeitet / wartet auf dich / pausiert), Zahl offener Freigaben, Ruhe.
//! Die Texte kommen aus `shell_core::agent::anzeige` (getestet); hier stehen nur Menü und Fenster.

use super::AgentZustand;
use crate::{befehle, fenster, tray as huelle_tray, zustand::{sperre, Huelle}};
use shell_core::agent::anzeige::{runner_id_aus_menue, runner_wahl, runner_zeile, runner_zeile_mit_adresse, status_text, text_freigaben, titel_text, tooltip_text, zustand_text, WahlEintrag, RUNNER_WAHL_LEER, RUNNER_WAHL_TITEL};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};

const TRAY_ID: &str = "huelle";

/// Das Untermenü „Runner wechseln“ mit den Einträgen, die gerade darin stehen (nur neu gebaut, wenn sich die Liste ändert).
struct Wahl {
    menue: Submenu<Wry>,
    stand: Mutex<(Vec<WahlEintrag>, Vec<CheckMenuItem<Wry>>)>,
}

pub struct Griffe {
    runner: MenuItem<Wry>,
    wahl: Wahl,
    status: MenuItem<Wry>,
    freigaben: MenuItem<Wry>,
    ruhe: CheckMenuItem<Wry>,
}

pub fn bauen(app: &AppHandle) -> tauri::Result<()> {
    let ruhe_an = app.try_state::<Arc<Huelle>>().map(|h| sperre(&h.einstellungen).agent.ruhe).unwrap_or(false);
    let produkt = app.config().product_name.clone().unwrap_or_else(|| "FYOS Agent".into());
    let runner = MenuItem::with_id(app, "runner_kopf", runner_zeile(None), false, None::<&str>)?;
    let wahl_menue = Submenu::with_id(app, "runner_wahl", RUNNER_WAHL_TITEL, true)?;
    let status = MenuItem::with_id(app, "status", format!("{produkt}: kein Runner eingerichtet"), false, None::<&str>)?;
    let freigaben = MenuItem::with_id(app, "freigaben", text_freigaben(0), false, None::<&str>)?;
    let ruhe = CheckMenuItem::with_id(app, "ruhe", "Ruhe (keine Benachrichtigungen)", true, ruhe_an, None::<&str>)?;
    let oeffnen = MenuItem::with_id(app, "oeffnen", "Öffnen", true, None::<&str>)?;
    let einstellungen = MenuItem::with_id(app, "einstellungen", "Einstellungen …", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", "Nach Updates suchen …", true, None::<&str>)?;
    let beenden = MenuItem::with_id(app, "beenden", "Beenden", true, None::<&str>)?;
    let (t1, t2) = (PredefinedMenuItem::separator(app)?, PredefinedMenuItem::separator(app)?);
    let menu = Menu::with_items(app, &[&runner, &status, &freigaben, &t1, &wahl_menue, &ruhe, &oeffnen, &einstellungen, &update, &t2, &beenden])?;
    let symbol = app.default_window_icon().cloned().ok_or_else(|| tauri::Error::AssetNotFound("Symbol".into()))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(symbol)
        .tooltip(produkt)
        .menu(&menu)
        .on_menu_event(|app, ereignis| match ereignis.id.as_ref() {
            "oeffnen" => fenster::nach_vorn(app),
            "freigaben" => super::fenster::freigaben_zeigen(app),
            "einstellungen" => {
                let _ = super::fenster::einstellungen_zeigen(app);
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
            andere => {
                if let Some(id) = runner_id_aus_menue(andere) {
                    runner_waehlen(app, id.to_string());
                }
            }
        })
        .build(app)?;
    app.manage(Griffe { runner, wahl: Wahl { menue: wahl_menue, stand: Mutex::new((Vec::new(), Vec::new())) }, status, freigaben, ruhe });
    huelle_tray::als_vorhanden_markieren();
    Ok(())
}

/// Wechselt den Runner über denselben Weg wie der Befehl `runner_wechseln` (auch der lokale Runner wird dabei gestartet). Scheitert es, bleibt der
/// bisherige aktiv und eine System-Mitteilung nennt die Ursache (Text der Meldung, nie ein Token).
fn runner_waehlen(app: &AppHandle, id: String) {
    let (Some(h), Some(a)) = (app.try_state::<Arc<Huelle>>(), app.try_state::<Arc<AgentZustand>>()) else { return };
    let (app, h, a) = (app.clone(), h.inner().clone(), a.inner().clone());
    tauri::async_runtime::spawn(async move {
        if let Err(meldung) = super::runner_befehle::wechseln_intern(app.clone(), h, a, id).await {
            use tauri_plugin_notification::NotificationExt;
            let titel = app.config().product_name.clone().unwrap_or_else(|| "FYOS Agent".into());
            let _ = app.notification().builder().title(titel).body(format!("{} {}", meldung.ursache, meldung.abhilfe)).show();
        }
        aktualisieren(&app); // Haken zurück auf den tatsächlich aktiven Runner
    });
}

/// Untermenü neu aufbauen, wenn sich die Liste geändert hat; sonst nur die Haken setzen (ein Klick schaltet den Haken von selbst um).
fn wahl_anzeigen(app: &AppHandle, w: &Wahl, neu: Vec<WahlEintrag>) {
    let mut stand = sperre(&w.stand);
    if stand.0.len() != neu.len() || stand.0.iter().zip(&neu).any(|(a, b)| a.menue_id != b.menue_id || a.text != b.text) {
        for alt in w.menue.items().unwrap_or_default() {
            let _ = w.menue.remove(&alt);
        }
        let mut griffe = Vec::new();
        for e in &neu {
            if let Ok(i) = CheckMenuItem::with_id(app, &e.menue_id, &e.text, true, e.aktiv, None::<&str>) {
                let _ = w.menue.append(&i);
                griffe.push(i);
            }
        }
        if neu.is_empty() {
            if let Ok(i) = MenuItem::with_id(app, "runner_leer", RUNNER_WAHL_LEER, false, None::<&str>) {
                let _ = w.menue.append(&i);
            }
        }
        stand.1 = griffe;
    } else {
        for (g, e) in stand.1.iter().zip(&neu) {
            let _ = g.set_checked(e.aktiv);
        }
    }
    stand.0 = neu;
}

/// Texte, Tooltip und (macOS) die Zahl neben dem Symbol nach dem Stand von `AgentZustand` setzen.
pub fn aktualisieren(app: &AppHandle) {
    let (Some(h), Some(a)) = (app.try_state::<Arc<Huelle>>(), app.try_state::<Arc<AgentZustand>>()) else { return };
    let produkt = app.config().product_name.clone().unwrap_or_else(|| "FYOS Agent".into());
    let (eingerichtet, ruhe, runner_name, wahl, zwei_adressen) = {
        let mut e = sperre(&h.einstellungen).agent.clone();
        e.runner_uebernehmen();
        let liste: Vec<(String, String)> = e.runner.iter().map(|r| (r.id.clone(), r.name.clone())).collect();
        let aktiv = e.aktiver().map(|r| (r.id.clone(), r.name.clone()));
        let zwei = e.aktiver().is_some_and(|r| r.adresse2.as_deref().is_some_and(|a| !a.trim().is_empty()));
        (e.eingerichtet(), e.ruhe, aktiv.as_ref().map(|r| r.1.clone()), runner_wahl(&liste, aktiv.as_ref().map(|r| r.0.as_str())), zwei)
    };
    let (verbunden, offene, laeufe) = (a.verbunden.load(Ordering::SeqCst), a.offene.load(Ordering::SeqCst), a.laeufe.load(Ordering::SeqCst));
    let (kopf_art, kopf_busy) = sperre(&a.kopf).clone();
    let zustand = zustand_text(eingerichtet, verbunden, offene, &kopf_art, kopf_busy || laeufe > 0);
    let status = status_text(&produkt, zustand, ruhe);
    let frei = text_freigaben(offene);
    let zeile = runner_zeile(runner_name.as_deref());
    if let Some(g) = app.try_state::<Griffe>() {
        let _ = g.runner.set_text(&zeile);
        wahl_anzeigen(app, &g.wahl, wahl);
        let _ = g.status.set_text(&status);
        let _ = g.freigaben.set_text(&frei);
        let _ = g.freigaben.set_enabled(offene > 0);
        let _ = g.ruhe.set_checked(ruhe);
    }
    if let Some(t) = app.tray_by_id(TRAY_ID) {
        // bei zwei Adressen steht im Tooltip (nicht im Menü), welche gerade genutzt wird
        let kopf = if zwei_adressen { runner_zeile_mit_adresse(&zeile, a.genutzt().as_deref()) } else { zeile.clone() };
        let _ = t.set_tooltip(Some(tooltip_text(&kopf, &status, &frei)));
        let _ = t.set_title(titel_text(offene));
    }
}
