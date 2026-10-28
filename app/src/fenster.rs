//! Fenster der Hülle: das **Hauptfenster** (lokale Seite `ui/`, darf Befehle aufrufen) und das **Inhaltsfenster**
//! (die Seite des Profils, z. B. Studio oder FYOS OS; bekommt keine Capability und damit keinen Zugriff auf Rust).

use crate::zustand::Huelle;
use shell_core::{links, Fehler};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

pub const HAUPT: &str = "haupt";
pub const INHALT: &str = "inhalt";

pub fn haupt(app: &AppHandle, sichtbar: bool) -> tauri::Result<()> {
    if let Some(f) = app.get_webview_window(HAUPT) {
        if sichtbar {
            f.show()?;
            f.set_focus()?;
        }
        return Ok(());
    }
    let titel = app.config().product_name.clone().unwrap_or_else(|| "FYOS".into());
    WebviewWindowBuilder::new(app, HAUPT, WebviewUrl::App("index.html".into()))
        .title(titel)
        .inner_size(760.0, 720.0)
        .min_inner_size(520.0, 480.0)
        .visible(sichtbar)
        .build()?;
    Ok(())
}

/// Zweiter Start oder Tray-Klick: Hauptfenster nach vorn (bei Bedarf neu).
pub fn nach_vorn(app: &AppHandle) {
    if let Err(e) = haupt(app, true) {
        eprintln!("Hauptfenster lässt sich nicht öffnen: {e}");
    }
}

/// Öffnet die Seite des Profils im Inhaltsfenster. Nur http und https.
pub fn inhalt(app: &AppHandle, adresse: &str) -> Result<(), Fehler> {
    let url = Url::parse(adresse)
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https"))
        .ok_or_else(|| Fehler::LinkAbgelehnt { link: adresse.to_string(), grund: "nur http- und https-Adressen werden geöffnet".into() })?;
    let fehler = |e: tauri::Error| Fehler::StudioNichtErreichbar { url: adresse.to_string(), grund: e.to_string() };
    if let Some(f) = app.get_webview_window(INHALT) {
        f.navigate(url).map_err(fehler)?;
        f.show().map_err(fehler)?;
        f.set_focus().map_err(fehler)?;
        return Ok(());
    }
    let titel = app.config().product_name.clone().unwrap_or_else(|| "FYOS".into());
    WebviewWindowBuilder::new(app, INHALT, WebviewUrl::External(url))
        .title(titel)
        .inner_size(1200.0, 800.0)
        .build()
        .map_err(fehler)?;
    Ok(())
}

/// Ein Deeplink (`fyos://` / `fle://`): geprüft, dann relativ zur Start-URL des Profils geöffnet.
/// Abgelehnte Links erscheinen als Meldung im Hauptfenster.
pub fn deeplink(app: &AppHandle, h: &Huelle, link: &str) {
    let ergebnis = links::pruefe(link, h.profil).and_then(|pfad| {
        let basis = Url::parse(&h.start_url()).map_err(|e| Fehler::LinkAbgelehnt { link: link.to_string(), grund: e.to_string() })?;
        let ziel = basis.join(&pfad).map_err(|e| Fehler::LinkAbgelehnt { link: link.to_string(), grund: e.to_string() })?;
        inhalt(app, ziel.as_str())
    });
    if let Err(f) = ergebnis {
        nach_vorn(app);
        let _ = app.emit_to(HAUPT, "meldung", f.meldung());
    }
}
