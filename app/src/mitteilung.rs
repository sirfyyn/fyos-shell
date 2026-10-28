//! System-Mitteilungen für das Profil OS: die Seite (FYOS OS im Inhaltsfenster) ruft über die kleine Brücke `window.__FYOS_HUELLE__`
//! den Befehl `os_benachrichtigen`; die Hülle prüft Absender, Länge und Rate und zeigt die Mitteilung über das System
//! (macOS Mitteilungszentrale, Windows, Linux). Sicherheitsmodell: `shell_core::mitteilung` und `docs/current/FYOS-APPS-RUST.md`.
//!
//! Drei Sperren hintereinander, jede genügt allein gegen Sandbox-Rahmen von Hub-Apps (Ursprung `null`):
//! 1. Tauri-ACL: `capabilities/os-meldungen.json` erlaubt den Befehl nur dem Inhaltsfenster und nur Seiten von `https://fyos.sirfyyn.de/*`;
//!    die Capability steht nur in der Konfiguration des Profils os. Die Kopfzeile `Origin` eines Sandbox-Rahmens ist `null` und gilt als ungültig.
//! 2. Dieser Befehl prüft Ursprung und aktuelle Seite erneut (Host der Start-URL, nicht der Anmeldeserver).
//! 3. Die Brücke (Initialisierungsskript) wird nur in den Hauptrahmen des Inhaltsfensters eingefügt und nur im Profil os.

use crate::zustand::{sperre, Huelle};
use serde::{Deserialize, Serialize};
use shell_core::mitteilung::{absender_pruefen, bereinigen, mit_zusammenfassung, Takt, Zulassung};
use shell_core::{Fehler, Meldung, Profil};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, State, Webview};
use tauri_plugin_notification::NotificationExt;

/// Zustand für die Ratenbegrenzung (ein Fenster, ein Takt).
#[derive(Default)]
pub struct Begrenzer(Mutex<Takt>);

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Optionen {
    /// Ohne Ton anzeigen
    still: bool,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Ergebnis {
    /// Das System hat die Mitteilung angenommen
    gezeigt: bool,
    /// Wegen der Rate (6 je Minute) nicht angezeigt; die Seite zeigt sie im Fenster und im Verlauf
    unterdrueckt: bool,
}

/// Das Initialisierungsskript der Brücke. Es steht nur im Hauptrahmen des Inhaltsfensters (kein Sandbox-Rahmen bekommt es) und hält die
/// Funktion `invoke` im Verschluss; die Seite ruft `window.__FYOS_HUELLE__.benachrichtigen(titel, text, optionen)` und nie `__TAURI_INTERNALS__`.
pub fn bruecke_skript(profil: &str, version: &str) -> String {
    // Werte als JSON-Zeichenketten einsetzen (kein Einschleusen aus Version oder Profil)
    let p = serde_json::to_string(profil).unwrap_or_else(|_| "\"os\"".into());
    let v = serde_json::to_string(version).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"(function () {{
  if (window.top !== window || window.__FYOS_HUELLE__) return;
  var intern = window.__TAURI_INTERNALS__;
  if (!intern || typeof intern.invoke !== 'function') return;
  var invoke = intern.invoke.bind(intern);
  var bruecke = Object.freeze({{
    profil: {p},
    version: {v},
    benachrichtigen: function (titel, text, optionen) {{
      return invoke('os_benachrichtigen', {{ titel: String(titel == null ? '' : titel), text: String(text == null ? '' : text), optionen: optionen && typeof optionen === 'object' ? {{ still: !!optionen.still }} : {{}} }});
    }}
  }});
  Object.defineProperty(window, '__FYOS_HUELLE__', {{ value: bruecke, writable: false, configurable: false, enumerable: false }});
}})();"#
    )
}

fn pruefen(webview: &Webview, ursprung: Option<&str>, h: &Huelle) -> Result<(), Fehler> {
    if h.profil != Profil::Os {
        return Err(Fehler::MitteilungAbgelehnt { grund: "Mitteilungen gibt es nur im Profil OS".into() });
    }
    let seite = webview.url().map_err(|e| Fehler::MitteilungAbgelehnt { grund: format!("die Seite des Fensters ist unbekannt ({e})") })?;
    absender_pruefen(ursprung, &seite, &h.start_url(), &crate::os::erlaubte_hosts(h))
}

fn zeigen(app: &AppHandle, titel: &str, text: &str, still: bool) -> Result<(), Fehler> {
    let mut b = app.notification().builder().title(titel);
    if !text.is_empty() {
        b = b.body(text);
    }
    if !still {
        b = b.sound("default");
    }
    b.show().map_err(|e| {
        let grund = e.to_string();
        let klein = grund.to_lowercase();
        if klein.contains("permission") || klein.contains("denied") || klein.contains("authoriz") || klein.contains("not allowed") {
            Fehler::MitteilungenNichtErlaubt { grund }
        } else {
            Fehler::MitteilungFehlgeschlagen { grund }
        }
    })
}

/// Zeigt eine System-Mitteilung. Nur die Seite des Servers selbst darf (Capability `os-meldungen`, zusätzlich hier geprüft).
#[tauri::command]
pub fn os_benachrichtigen(
    app: AppHandle,
    webview: Webview,
    kopf: tauri::ipc::Request<'_>,
    h: State<'_, Arc<Huelle>>,
    begrenzer: State<'_, Begrenzer>,
    titel: String,
    text: String,
    optionen: Option<Optionen>,
) -> Result<Ergebnis, Meldung> {
    let ursprung = kopf.headers().get("origin").and_then(|v| v.to_str().ok());
    pruefen(&webview, ursprung, &h).map_err(|f| f.meldung())?;
    let (titel, text) = bereinigen(&titel, &text).map_err(|f| f.meldung())?;
    let zulassung = sperre(&begrenzer.0).pruefen(Instant::now());
    match zulassung {
        Zulassung::Verwerfen => Ok(Ergebnis { gezeigt: false, unterdrueckt: true }),
        Zulassung::Zeigen { nachgeholt } => {
            let text = mit_zusammenfassung(&text, nachgeholt);
            zeigen(&app, &titel, &text, optionen.unwrap_or_default().still).map_err(|f| f.meldung())?;
            Ok(Ergebnis { gezeigt: true, unterdrueckt: false })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skript_setzt_die_bruecke_nur_im_hauptrahmen_und_haelt_invoke_im_verschluss() {
        let s = bruecke_skript("os", "0.0.4");
        assert!(s.contains("window.top !== window"));
        assert!(s.contains("Object.freeze"));
        assert!(s.contains("\"os\"") && s.contains("\"0.0.4\""));
        assert!(s.contains("os_benachrichtigen"));
        // die Brücke gibt invoke nicht weiter
        assert!(!s.contains("invoke:"));
    }

    fn json(s: &str) -> serde_json::Value {
        serde_json::from_str(s).expect("gültiges JSON")
    }

    /// Beleg der Capability-Liste: Meldungsbefehl nur für das Inhaltsfenster, nur remote https://fyos.sirfyyn.de/*, nur ein Recht, nur im Profil os.
    #[test]
    fn capability_erlaubt_nur_den_server_nur_den_einen_befehl_und_nur_im_profil_os() {
        let c = json(include_str!("../capabilities/os-meldungen.json"));
        assert_eq!(c["windows"], serde_json::json!(["inhalt"]));
        assert_eq!(c["local"], serde_json::json!(false));
        assert_eq!(c["remote"]["urls"], serde_json::json!(["https://fyos.sirfyyn.de/*"]));
        assert_eq!(c["permissions"], serde_json::json!(["allow-os-benachrichtigen"]));
        // weder Anmeldeserver noch Plugin-Rechte der Seite
        let roh = include_str!("../capabilities/os-meldungen.json");
        assert!(!roh.contains("auth.sirfyyn.de") && !roh.contains("notification:"));
        // Die Grundkonfiguration (Studio, Agent) listet sie nicht, das Profil os schon
        let basis = json(include_str!("../tauri.conf.json"));
        assert_eq!(basis["app"]["security"]["capabilities"], serde_json::json!(["haupt", "inhalt"]));
        let os = json(include_str!("../profile/os.conf.json"));
        assert_eq!(os["app"]["security"]["capabilities"], serde_json::json!(["haupt", "inhalt", "os-meldungen"]));
        for anderes in [include_str!("../profile/studio.conf.json"), include_str!("../profile/agent.conf.json")] {
            assert!(!anderes.contains("os-meldungen"));
        }
        // Keine andere Capability gibt dem Inhaltsfenster Notification-Rechte oder remote-Zugriff
        for datei in [include_str!("../capabilities/haupt.json"), include_str!("../capabilities/inhalt.json")] {
            let c = json(datei);
            assert!(c.get("remote").is_none() && !c["permissions"].to_string().contains("notification"));
        }
    }

    #[test]
    fn skript_schleust_nichts_aus_der_version_ein() {
        let s = bruecke_skript("os", "1\"});alert(1);({\"");
        assert!(s.contains(r#"\"});alert(1);({\""#));
    }
}
