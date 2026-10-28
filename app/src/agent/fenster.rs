//! Das Chat-Fenster des Profils `agent`: eine lokale Seite der Hülle (`ui/agent/chat.html`), die über die Brücke mit dem Runner spricht.
//!
//! Das Fenster lädt nie Fremdes: Navigation nur zu eigenen Seiten (`tauri://`), Links aus Antworten gehen in den Standardbrowser, ein neues
//! Fenster gibt es nie. Die Content-Security-Policy der Hülle (`connect-src ipc:`) erlaubt der Seite **kein** eigenes Netz: jede Verbindung
//! zum Runner läuft über Rust und nur zur eingestellten Adresse (siehe `bruecke.rs`, `http.rs`).

use crate::fenster as huelle_fenster;
use crate::zustand::{sperre, Huelle};
use shell_core::agent::chat_navigation;
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

/// Öffnet das Chat-Fenster oder holt es nach vorn.
pub fn chat_oeffnen(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(CHAT) {
        let _ = w.unminimize();
        w.show()?;
        w.set_focus()?;
        return Ok(());
    }
    let titel = app.config().product_name.clone().unwrap_or_else(|| "FYOS Agent".into());
    WebviewWindowBuilder::new(app, CHAT, WebviewUrl::App("agent/chat.html".into()))
        .title(titel)
        .inner_size(1100.0, 820.0)
        .min_inner_size(640.0, 480.0)
        .on_navigation(|url| sperre_chat(url))
        .on_new_window(|url, _| {
            sperre_chat(&url);
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

/// Was beim Start zuerst zu sehen ist: das Chat-Fenster, sobald ein Runner eingetragen ist; sonst die Einstellungen mit der Runner-Verbindung.
pub fn start_fenster(app: &AppHandle, h: &Arc<Huelle>) {
    let eingerichtet = sperre(&h.einstellungen).agent.runner_adresse.as_deref().is_some_and(|a| !a.trim().is_empty());
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
