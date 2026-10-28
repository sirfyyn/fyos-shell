//! Fenster der Hülle: das **Hauptfenster** (lokale Seite `ui/`, darf Befehle aufrufen) und das **Inhaltsfenster**
//! (die Seite des Profils, z. B. Studio oder FYOS OS; Seiten von außen bekommen keinen Zugriff auf Rust, nur die eigene Fehlerseite hat drei Befehle, siehe `capabilities/inhalt.json`).

use crate::zustand::Huelle;
use shell_core::fensterlage;
use shell_core::navigation::{self, Entscheidung};
use shell_core::profil::Profil;
use shell_core::{links, Fehler};
use std::process::Stdio;
use std::sync::Arc;
use tauri::webview::NewWindowResponse;
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

/// Zweiter Start oder Tray-Klick: Profil OS öffnet das Fenster zum Server, die anderen das Hauptfenster (bei Bedarf neu).
pub fn nach_vorn(app: &AppHandle) {
    if let Some(h) = app.try_state::<Arc<Huelle>>() {
        if h.profil == Profil::Os {
            crate::os::oeffnen(app, &h);
            return;
        }
    }
    if let Err(e) = haupt(app, true) {
        eprintln!("Hauptfenster lässt sich nicht öffnen: {e}");
    }
}

/// Adresse einer eigenen Seite der Hülle (`ui/`) für das Inhaltsfenster: `tauri://localhost/…`, unter Windows `http://tauri.localhost/…`.
pub fn app_url(pfad: &str) -> Url {
    let basis = if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" };
    Url::parse(basis).and_then(|b| b.join(pfad)).expect("feste Basisadresse")
}

/// Öffnet eine Web-Adresse im Standardbrowser (nur http, https, mailto; ohne Shell). Fehler sind folgenlos.
pub fn im_browser_oeffnen(url: &Url) {
    let Some((programm, args)) = navigation::browser_befehl(std::env::consts::OS, url) else { return };
    // Nur Debug-Bauten (Tests): FYOS_SHELL_BROWSER_BEFEHL ersetzt den Browser durch ein Programm, das die Adresse als Argument bekommt
    #[cfg(debug_assertions)]
    let (programm, args) = match std::env::var("FYOS_SHELL_BROWSER_BEFEHL") {
        Ok(p) if !p.is_empty() => (p, vec![url.as_str().to_string()]),
        _ => (programm, args),
    };
    let _ = std::process::Command::new(programm).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
}

/// Navigationssperre: im Inhaltsfenster nur erlaubte Hosts; Fremdes geht in den Browser (siehe `shell_core::navigation`).
fn sperre_anwenden(app: &AppHandle, url: &Url) -> bool {
    let erlaubt = match app.try_state::<Arc<Huelle>>() {
        Some(h) => crate::os::erlaubte_hosts(&h),
        None => return false,
    };
    match navigation::pruefe(url, &erlaubt) {
        Entscheidung::Erlauben => true,
        Entscheidung::Browser => {
            im_browser_oeffnen(url);
            false
        }
        Entscheidung::Ablehnen => false,
    }
}

/// Inhaltsfenster anlegen: mit Navigationssperre, `window.open` über dieselbe Prüfung, WebView-Daten (Anmeldung) im Datenordner des Profils.
fn inhalt_bauen(app: &AppHandle, ziel: WebviewUrl) -> tauri::Result<()> {
    let titel = app.config().product_name.clone().unwrap_or_else(|| "FYOS".into());
    let (a1, a2) = (app.clone(), app.clone());
    #[allow(unused_mut)]
    let mut b = WebviewWindowBuilder::new(app, INHALT, ziel)
        .title(titel)
        .inner_size(1200.0, 800.0)
        .on_navigation(move |url| sperre_anwenden(&a1, url))
        .on_new_window(move |url, _| {
            // Neues Fenster nie zulassen: erlaubte Adresse im selben Fenster, Fremdes im Browser
            if sperre_anwenden(&a2, &url) {
                if let Some(f) = a2.get_webview_window(INHALT) {
                    let _ = f.navigate(url);
                }
            }
            NewWindowResponse::Deny
        });
    // Cookies und Anmeldung bleiben über Neustarts und Updates im Datenordner. macOS (WKWebView) hält sie im Speicher der App-Kennung.
    #[cfg(not(target_os = "macos"))]
    if let Some(h) = app.try_state::<Arc<Huelle>>() {
        b = b.data_directory(h.pfade.daten.join("webview"));
    }
    // Letzte Position und Größe, wenn sie noch auf einem angeschlossenen Bildschirm liegt
    if let Some(l) = lage_gemerkt(app) {
        let (x, y, br, ho) = l.logisch();
        b = b.inner_size(br, ho).position(x, y);
    }
    let fenster = b.build()?;
    if lage_gemerkt(app).is_some_and(|l| l.maximiert) {
        let _ = fenster.maximize();
    }
    Ok(())
}

fn bildschirme(app: &AppHandle) -> Vec<fensterlage::Bildschirm> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| fensterlage::Bildschirm { x: m.position().x, y: m.position().y, breite: m.size().width, hoehe: m.size().height })
        .collect()
}

fn lage_gemerkt(app: &AppHandle) -> Option<fensterlage::Lage> {
    let h = app.try_state::<Arc<Huelle>>()?;
    fensterlage::laden(&h.pfade.daten).filter(|l| l.sichtbar(&bildschirme(app)))
}

/// Merkt Position und Größe des Inhaltsfensters (beim Schließen und Beenden; nicht bei jeder Mausbewegung).
pub fn lage_merken(app: &AppHandle) {
    let (Some(f), Some(h)) = (app.get_webview_window(INHALT), app.try_state::<Arc<Huelle>>()) else { return };
    // Auf der Fehlerseite oder minimiert ist die Lage nichts wert
    if f.is_minimized().unwrap_or(false) {
        return;
    }
    let (Ok(p), Ok(g), Ok(skal)) = (f.outer_position(), f.inner_size(), f.scale_factor()) else { return };
    let lage = fensterlage::Lage { x: p.x, y: p.y, breite: g.width, hoehe: g.height, skalierung: skal, maximiert: f.is_maximized().unwrap_or(false) };
    fensterlage::speichern(&h.pfade.daten, &lage);
}

/// Zeigt im Inhaltsfenster die eigene Fehlerseite (legt das Fenster an, falls es fehlt).
pub fn fehlerseite(app: &AppHandle) -> tauri::Result<()> {
    if let Some(f) = app.get_webview_window(INHALT) {
        if f.url().map(|u| u.path().ends_with("fehler.html")).unwrap_or(false) {
            return Ok(());
        }
        f.navigate(app_url("fehler.html"))?;
        f.show()?;
        return Ok(());
    }
    inhalt_bauen(app, WebviewUrl::App("fehler.html".into()))
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
    inhalt_bauen(app, WebviewUrl::External(url)).map_err(fehler)
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
