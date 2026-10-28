//! Beobachter: fragt den Runner nach offenen Freigaben (`GET /api/freigaben`) und laufenden Läufen (`GET /api/laeufe`), aktualisiert Tray und
//! Zähler und merkt jede neue offene Freigabe genau einmal. Das geschieht auch bei geschlossenem Chat-Fenster (die Anwendung lebt im Tray).
//!
//! **Benachrichtigungen:** für neue Freigaben zeigt Rust selbst eine System-Mitteilung (`melden`): nur „Freigabe wartet“, nie der Befehl; nicht in Ruhe,
//! nicht bei sichtbarem Chat-Fenster; Länge und Rate wie `mitteilung.rs` (`shell_core::mitteilung`, höchstens 6 je Minute). Keine Seite ruft sie auf,
//! deshalb gibt es dafür keine Capability und kein Plugin-Recht für Fenster.

use super::{fenster, http, merke_fehler, vergiss_fehler, AgentZustand};
use crate::zustand::{sperre, Huelle};
use shell_core::agent::adresse::{api_url, ist_loopback};
use shell_core::agent::freigaben;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use shell_core::mitteilung::{bereinigen, Takt, Zulassung};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// Zeigt die Mitteilung zu neuen Freigaben (Fehler werden still gemerkt, der Tray zeigt die Zahl ohnehin).
fn melden(app: &AppHandle, neu: &[freigaben::Offene]) {
    static TAKT: OnceLock<Mutex<Takt>> = OnceLock::new();
    let (titel, text) = freigaben::meldung(neu);
    let Ok((titel, text)) = bereinigen(&titel, &text) else { return };
    if matches!(sperre(TAKT.get_or_init(Default::default)).pruefen(Instant::now()), Zulassung::Verwerfen) {
        return;
    }
    let _ = app.notification().builder().title(titel).body(text).show();
}

pub fn starte(app: AppHandle, h: Arc<Huelle>, a: Arc<AgentZustand>) {
    let _ = std::thread::Builder::new().name("agent-beobachter".into()).spawn(move || loop {
        let pause = tick(&app, &h, &a);
        std::thread::sleep(pause);
    });
}

/// Ein Durchgang; liefert die Pause bis zum nächsten (auf dem eigenen Rechner öfter, ohne Ziel oder bei Tresorfehlern selten).
fn tick(app: &AppHandle, h: &Arc<Huelle>, a: &Arc<AgentZustand>) -> Duration {
    let ziel = match a.ziel(h) {
        Ok(z) => z,
        Err(_) => {
            // Nicht eingerichtet oder Tresor nicht erreichbar: nicht im Sekundentakt nachfragen (kein Dauerfeuer auf den Schlüsselbund)
            if a.verbunden.swap(false, Ordering::SeqCst) {
                super::tray::aktualisieren(app);
            }
            return Duration::from_secs(10);
        }
    };
    let lokal = url::Url::parse(&ziel.basis).ok().and_then(|u| u.host_str().map(|x| ist_loopback(x.trim_matches(|c| c == '[' || c == ']')))).unwrap_or(false);
    let pause = Duration::from_secs(if lokal { 2 } else { 5 });
    let antwort = http::anfrage("GET", &api_url(&ziel.basis, "/api/freigaben"), &ziel.token, None, Duration::from_secs(5));
    let laeufe = if antwort.is_ok() {
        http::anfrage("GET", &api_url(&ziel.basis, "/api/laeufe"), &ziel.token, None, Duration::from_secs(5)).map(|v| freigaben::laufende(&v)).unwrap_or(0)
    } else {
        0
    };
    // Zwischenzeitlich anderes Ziel eingestellt: Ergebnis verwerfen
    if a.ziel(h).map(|z| z.basis != ziel.basis).unwrap_or(true) {
        return pause;
    }
    match antwort {
        Ok(v) => {
            vergiss_fehler(h);
            let offene = freigaben::offene(&v);
            let (neu, ruhe) = {
                let mut e = sperre(&h.einstellungen);
                let neu = freigaben::neue(&offene, &mut e.agent.gemeldet);
                freigaben::beschneiden(&mut e.agent.gemeldet, 500);
                if !neu.is_empty() {
                    let _ = shell_core::einstellungen::speichern(&h.pfade, &e);
                }
                (neu, e.agent.ruhe)
            };
            let war_verbunden = a.verbunden.swap(true, Ordering::SeqCst);
            let alt = a.offene.swap(offene.len(), Ordering::SeqCst);
            let alte_laeufe = a.laeufe.swap(laeufe, Ordering::SeqCst);
            if !neu.is_empty() && !ruhe && !fenster::im_blick(app) {
                melden(app, &neu);
            }
            if !war_verbunden || alt != offene.len() || alte_laeufe != laeufe {
                super::tray::aktualisieren(app);
            }
        }
        Err(f) => {
            merke_fehler(h, &f);
            if a.verbunden.swap(false, Ordering::SeqCst) {
                super::tray::aktualisieren(app);
            }
        }
    }
    pause
}

#[cfg(test)]
mod tests {
    /// Mitteilungen zeigt nur Rust: keine Capability des Profils agent gibt einer Seite Rechte des Notification-Plugins oder den Meldungsbefehl des OS.
    /// Die Capabilities des Chat-Fensters und der Einstellungen gelten nur, wenn das Profil sie listet (sonst darf die Seite keinen Befehl aufrufen).
    #[test]
    fn profil_agent_listet_seine_capabilities_und_nur_dort() {
        let agent: serde_json::Value = serde_json::from_str(include_str!("../../profile/agent.conf.json")).unwrap();
        assert_eq!(agent["app"]["security"]["capabilities"], serde_json::json!(["haupt", "inhalt", "agent-chat", "agent-haupt"]));
        for anderes in [include_str!("../../profile/studio.conf.json"), include_str!("../../profile/os.conf.json")] {
            assert!(!anderes.contains("agent-chat") && !anderes.contains("agent-haupt"));
        }
    }

    #[test]
    fn keine_capability_des_profils_agent_gibt_seiten_mitteilungsrechte() {
        for datei in [include_str!("../../capabilities/agent-chat.json"), include_str!("../../capabilities/agent-haupt.json")] {
            assert!(!datei.contains("notification") && !datei.contains("benachrichtigen"), "{datei}");
            assert!(!datei.contains("\"remote\""));
        }
    }
}
