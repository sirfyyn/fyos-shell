//! Das Chat-Fenster des Profils `agent`: eine lokale Seite der Hülle (`ui/agent/chat.html`), die über die Brücke mit dem Runner spricht.
//!
//! Das Fenster lädt nie Fremdes: Navigation nur zu eigenen Seiten (`tauri://`), Links aus Antworten gehen in den Standardbrowser, ein neues
//! Fenster gibt es nie. Die Content-Security-Policy der Hülle (`connect-src ipc:`) erlaubt der Seite **kein** eigenes Netz: jede Verbindung
//! zum Runner läuft über Rust und nur zur eingestellten Adresse (siehe `bruecke.rs`, `http.rs`).

use crate::fenster as huelle_fenster;
use crate::zustand::{sperre, Huelle};
use shell_core::agent::chat_navigation;
use shell_core::einstellungen;
use shell_core::fensterlage::{Bildschirm, Lage};
use shell_core::navigation::Entscheidung;
use std::sync::Arc;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

pub const CHAT: &str = "chat";

fn sperre_chat(url: &Url) -> bool {
    match chat_navigation(url) {
        Entscheidung::Erlauben => true,
        Entscheidung::Browser => {
            huelle_fenster::im_browser_oeffnen(url);
            false
        }
        Entscheidung::Ablehnen => false,
    }
}

/// Tray-Zeile „N offene Freigaben“: das Chat-Fenster nach vorn und das Freigaben-Panel dort aufklappen. Ein offenes Fenster bekommt das Ereignis
/// `freigaben-zeigen`; ein neu gebautes holt das Flag beim Start mit `ziel_info` ab (die Seite hört noch nicht zu, wenn Rust es sendet).
/// Ohne eingerichteten Runner öffnet sich wie sonst die Verbindungsseite (Einstellungen).
pub fn freigaben_zeigen(app: &AppHandle) {
    let schon_offen = app.get_webview_window(CHAT).is_some();
    if let (Some(a), Some(h)) = (app.try_state::<Arc<super::AgentZustand>>(), app.try_state::<Arc<Huelle>>()) {
        // ohne eingerichteten Runner öffnet `nach_vorn` die Einstellungen, nicht das Chat-Fenster: dann kein Merken
        if !schon_offen && sperre(&h.einstellungen).agent.eingerichtet() {
            a.freigaben_zeigen.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    huelle_fenster::nach_vorn(app);
    if schon_offen {
        let _ = tauri::Emitter::emit_to(app, CHAT, "freigaben-zeigen", ());
    }
}

/// Das Einstellungsfenster („FYOS Agent“: Runner, Adressen, lokaler Runner) öffnen oder nach vorn holen. Ein Weg für den Tray-Eintrag
/// „Einstellungen …“ und den Knopf im Chat-Fenster (Befehl `einstellungen_oeffnen`).
pub fn einstellungen_zeigen(app: &AppHandle) -> tauri::Result<()> {
    huelle_fenster::haupt(app, true)?;
    if let Some(w) = app.get_webview_window(huelle_fenster::HAUPT) {
        let _ = w.unminimize();
    }
    Ok(())
}

/// Öffnet das Chat-Fenster oder holt es nach vorn.
pub fn chat_oeffnen(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(CHAT) {
        let _ = w.unminimize();
        w.show()?;
        w.set_focus()?;
        return Ok(());
    }
    let titel = app.config().product_name.clone().unwrap_or_else(|| "FYOS Agent".into());
    let mut b = WebviewWindowBuilder::new(app, CHAT, WebviewUrl::App("agent/chat.html".into()))
        .title(titel)
        .inner_size(1100.0, 820.0)
        .min_inner_size(640.0, 480.0)
        .on_navigation(|url| sperre_chat(url))
        .on_new_window(|url, _| {
            sperre_chat(&url);
            NewWindowResponse::Deny
        });
    // Letzte Lage, wenn sie noch auf einem angeschlossenen Bildschirm liegt (sonst Standardlage)
    let lage = lage_gemerkt(app);
    if let Some(l) = lage {
        let (x, y, br, ho) = l.logisch();
        b = b.inner_size(br, ho).position(x, y);
    }
    let fenster = b.build()?;
    if lage.is_some_and(|l| l.maximiert) {
        let _ = fenster.maximize();
    }
    Ok(())
}

fn bildschirme(app: &AppHandle) -> Vec<Bildschirm> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| Bildschirm { x: m.position().x, y: m.position().y, breite: m.size().width, hoehe: m.size().height })
        .collect()
}

fn lage_gemerkt(app: &AppHandle) -> Option<Lage> {
    let h = app.try_state::<Arc<Huelle>>()?;
    let l = sperre(&h.einstellungen).agent.chat_lage_wiederherstellen(&bildschirme(app));
    l
}

/// Merkt Position und Größe des Chat-Fensters in den Einstellungen (beim Schließen und Beenden; nicht bei jeder Mausbewegung).
/// Minimiert oder außerhalb aller Bildschirme: die letzte gute Lage bleibt.
pub fn lage_merken(app: &AppHandle) {
    let (Some(f), Some(h)) = (app.get_webview_window(CHAT), app.try_state::<Arc<Huelle>>()) else { return };
    if f.is_minimized().unwrap_or(false) || f.is_fullscreen().unwrap_or(false) {
        return;
    }
    let (Ok(p), Ok(g), Ok(skal)) = (f.outer_position(), f.inner_size(), f.scale_factor()) else { return };
    let lage = Lage { x: p.x, y: p.y, breite: g.width, hoehe: g.height, skalierung: skal, maximiert: f.is_maximized().unwrap_or(false) };
    let mut e = sperre(&h.einstellungen);
    if e.agent.chat_lage_merken(lage, &bildschirme(app)) {
        let _ = einstellungen::speichern(&h.pfade, &e);
    }
}

/// Was beim Start zuerst zu sehen ist: das Chat-Fenster, sobald ein Runner eingetragen ist; sonst die Einstellungen mit der Runner-Verbindung.
pub fn start_fenster(app: &AppHandle, h: &Arc<Huelle>) {
    let eingerichtet = sperre(&h.einstellungen).agent.eingerichtet();
    let ergebnis = if eingerichtet { chat_oeffnen(app) } else { huelle_fenster::haupt(app, true) };
    if let Err(e) = ergebnis {
        eprintln!("Fenster lässt sich nicht öffnen: {e}");
    }
}

/// Ist das Chat-Fenster sichtbar und im Vordergrund? Dann braucht eine neue Freigabe keine Benachrichtigung (die Karte steht im Fenster).
pub fn im_blick(app: &AppHandle) -> bool {
    app.get_webview_window(CHAT)
        .map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
        .unwrap_or(false)
}
