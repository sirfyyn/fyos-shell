//! Profil `agent`: Oberfläche und Brückenlogik zu einem Runner, der anderswo läuft (eigener Rechner, LAN oder Tunnel).
//!
//! Die Hülle liefert **keinen** Runner mit: weder Programm noch Systemtexte noch Konfiguration. Sie kennt nur die Adresse und das Token
//! (im Tresor) des Runners und spricht dessen `/api/…` über eine Brücke in Rust. Alles hier ist rein (ohne Fenster, ohne Netz) und getestet.
//!
//! - [`adresse`]: Runner-Adresse prüfen (http nur im eigenen Netz), `api_url`
//! - [`bruecke`]: welche Wege und Ströme die Seite öffnen darf, SSE lesen, Wartetreppe, Fehler aus HTTP-Status
//! - [`freigaben`]: offene Freigaben lesen, „neu“ erkennen, Meldungstext
//! - [`anzeige`]: Texte für Tray und Tooltip (Zustand, Zahl offener Freigaben)

pub mod adresse;
pub mod anzeige;
pub mod bruecke;
pub mod freigaben;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

/// Name des Tokens im Tresor (Dienst = Bundle-Id des Profils, `de.sirfyyn.fyos-agent`; derselbe Dienst wie in der bisherigen Agent-App).
pub const TOKEN_NAME: &str = "runner-token";
/// Verweis in den Einstellungen auf das Token im Tresor.
pub const TOKEN_VERWEIS: &str = "{tresor:runner-token}";

/// Einstellungen des Profils `agent`. Keine Geheimnisse: das Token steht als Verweis (`{tresor:runner-token}`) in der Datei, der Wert im Tresor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentEinst {
    /// Adresse des Runners, z. B. `http://rechner:18438` (Heimnetz) oder `https://runner.example.org`. Leer = noch nicht eingerichtet.
    pub runner_adresse: Option<String>,
    /// Verweis auf das Token im Tresor; leer = der Runner verlangt keines (nur sinnvoll auf dem eigenen Rechner).
    pub runner_token: String,
    /// Ruhe: keine Benachrichtigungen (offene Freigaben bleiben in Tray und Fenster sichtbar).
    pub ruhe: bool,
    /// Schon gemeldete Freigaben (`<id>@<erstellt>`), damit ein Neustart nichts doppelt meldet.
    pub gemeldet: BTreeSet<String>,
}

impl Default for AgentEinst {
    fn default() -> Self {
        AgentEinst { runner_adresse: None, runner_token: TOKEN_VERWEIS.to_string(), ruhe: false, gemeldet: BTreeSet::new() }
    }
}

/// Navigationssperre des Chat-Fensters. Das Fenster lädt nur eigene Seiten der Hülle (`tauri://`, unter Windows `tauri.localhost`); jede
/// Web-Adresse (auch die des Runners) geht in den Standardbrowser, `javascript:`, `file:`, `data:` werden abgelehnt. Die Seite selbst
/// braucht kein Netz: der Runner wird ausschließlich über die Brücke in Rust erreicht.
pub fn chat_navigation(url: &url::Url) -> crate::navigation::Entscheidung {
    crate::navigation::pruefe(url, &[])
}

/// Ein Runner der bisherigen Agent-App (Entwicklungsfassung), wie er in deren `einstellungen.json` stand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AltZiel {
    pub name: String,
    pub url: String,
    /// Konto im Schlüsselbund (Dienst = Bundle-Id): `runner:<id>`.
    pub konto: String,
}

/// Findet in den unbekannten Feldern der Einstellungen (`weitere`) den zuletzt benutzten Runner der bisherigen Agent-App
/// (`remotes: [{id, name, url}]`, `aktiv: <id>`). Die Hülle liest dieselbe Datei im selben Datenordner; die alten Felder bleiben unberührt erhalten.
pub fn alt_ziel(weitere: &Map<String, Value>) -> Option<AltZiel> {
    let liste = weitere.get("remotes")?.as_array()?;
    let aktiv = weitere.get("aktiv").and_then(Value::as_str);
    let text = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let bevorzugt = aktiv.and_then(|a| liste.iter().find(|r| r.get("id").and_then(Value::as_str) == Some(a)));
    let r = bevorzugt.or_else(|| liste.first())?;
    let id = text(r, "id")?;
    let url = text(r, "url")?;
    Some(AltZiel { name: text(r, "name").unwrap_or_else(|| id.clone()), url, konto: format!("runner:{id}") })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn vorgaben_verweisen_auf_den_tresor() {
        let e = AgentEinst::default();
        assert_eq!(e.runner_adresse, None);
        assert_eq!(e.runner_token, "{tresor:runner-token}");
        assert!(!e.ruhe);
    }

    #[test]
    fn chat_fenster_laedt_nur_eigene_seiten_nie_den_runner() {
        use crate::navigation::Entscheidung::*;
        let u = |s: &str| url::Url::parse(s).unwrap();
        for ok in ["tauri://localhost/agent/chat.html", "http://tauri.localhost/agent/chat.html", "about:blank"] {
            assert_eq!(chat_navigation(&u(ok)), Erlauben, "{ok}");
        }
        // auch die Adresse des Runners selbst und Loopback sind kein Ziel des Fensters: sie gehen in den Browser
        for browser in ["http://127.0.0.1:18438/", "http://localhost:18438/api/health", "https://runner.example.org/", "https://example.com/"] {
            assert_eq!(chat_navigation(&u(browser)), Browser, "{browser}");
        }
        for nein in ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "blob:https://example.com/a", "ftp://example.com/"] {
            assert_eq!(chat_navigation(&u(nein)), Ablehnen, "{nein}");
        }
    }

    #[test]
    fn alter_runner_wird_gefunden_aktiver_zuerst() {
        let w = json!({"remotes":[{"id":"a","name":"Eins","url":"http://x:1"},{"id":"b","name":"Zwei","url":"http://y:2"}],"aktiv":"b"});
        let z = alt_ziel(w.as_object().unwrap()).unwrap();
        assert_eq!((z.name.as_str(), z.url.as_str(), z.konto.as_str()), ("Zwei", "http://y:2", "runner:b"));
        let ohne_aktiv = json!({"remotes":[{"id":"a","url":"http://x:1"}],"aktiv":"geraet"});
        let z = alt_ziel(ohne_aktiv.as_object().unwrap()).unwrap();
        assert_eq!((z.name.as_str(), z.konto.as_str()), ("a", "runner:a"));
        assert!(alt_ziel(json!({}).as_object().unwrap()).is_none());
        assert!(alt_ziel(json!({"remotes":[]}).as_object().unwrap()).is_none());
        assert!(alt_ziel(json!({"remotes":[{"id":"a"}]}).as_object().unwrap()).is_none());
    }
}
