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
    // dieselbe Auflösung wie die Brücke: gemerkte Adresse zuerst, bei Verbindungsfehler die andere
    let hole = |weg: &'static str| a.versuchen(&ziel, |basis, weitere| http::anfrage_folge("GET", &api_url(basis, weg), &ziel.token, None, Duration::from_secs(5), super::bruecke::verbinden_frist(weitere)));
    let vorher = a.genutzt();
    let antwort = hole("/api/freigaben");
    let laeufe = if antwort.is_ok() { hole("/api/laeufe").map(|v| freigaben::laufende(&v)).unwrap_or(0) } else { 0 };
    // Zwischenzeitlich anderes Ziel eingestellt: Ergebnis verwerfen
    if a.ziel(h).map(|z| z.basen() != ziel.basen()).unwrap_or(true) {
        return pause;
    }
    // Die Anfrage hat auf die andere Adresse gewechselt: der Tray nennt sie im Tooltip
    if a.genutzt() != vorher {
        super::tray::aktualisieren(app);
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

    fn rechte(datei: &str) -> std::collections::BTreeSet<String> {
        let v: serde_json::Value = serde_json::from_str(datei).unwrap();
        v["permissions"].as_array().unwrap().iter().map(|p| p.as_str().unwrap().to_string()).collect()
    }

    /// Jede Seite hat nur ihre Befehle: das Chat-Fenster die Brücke, den Wechsel und die Ordnerwahl, die Einstellungen die Verwaltung der Liste
    /// und des lokalen Runners. Kein Recht doppelt (außer dem Lesen der Liste), kein Recht des Dialog-Plugins für irgendeine Seite.
    #[test]
    fn jede_seite_hat_nur_ihre_befehle() {
        let chat = rechte(include_str!("../../capabilities/agent-chat.json"));
        let haupt = rechte(include_str!("../../capabilities/agent-haupt.json"));
        let soll_chat = ["core:event:default", "allow-runner-anfrage", "allow-strom-oeffnen", "allow-strom-schliessen", "allow-ziel-info", "allow-einstellungen-oeffnen", "allow-ruhe-setzen", "allow-zustand-melden", "allow-bericht-speichern", "allow-runner-liste", "allow-runner-wechseln", "allow-ordner-waehlen", "allow-ordner-zuletzt", "allow-ordner-merken"];
        let soll_haupt = ["allow-agent-verbindung-pruefen", "allow-agent-alt-uebernehmen", "allow-agent-chat-oeffnen", "allow-runner-liste", "allow-runner-speichern", "allow-runner-entfernen", "allow-lokaler-runner-einstellen", "allow-lokaler-runner-status", "allow-lokaler-runner-starten", "allow-lokaler-runner-stoppen"];
        assert_eq!(chat, soll_chat.iter().map(|s| s.to_string()).collect());
        assert_eq!(haupt, soll_haupt.iter().map(|s| s.to_string()).collect());
        let gemeinsam: Vec<&String> = chat.intersection(&haupt).collect();
        assert_eq!(gemeinsam, ["allow-runner-liste"]);
        // Start und Stopp des lokalen Programms, Programmpfad und Entfernen darf das Chat-Fenster nie
        for verboten in ["allow-lokaler-runner-einstellen", "allow-lokaler-runner-starten", "allow-runner-speichern", "allow-runner-entfernen"] {
            assert!(!chat.contains(verboten), "{verboten}");
        }
        // der Systemdialog ist kein Recht einer Seite
        for datei in [include_str!("../../capabilities/agent-chat.json"), include_str!("../../capabilities/agent-haupt.json"), include_str!("../../capabilities/haupt.json"), include_str!("../../capabilities/inhalt.json")] {
            assert!(!datei.contains("dialog:") && !datei.contains("plugin:dialog"), "{datei}");
        }
    }

    /// Jeder Befehl des Profils hat eine eigene Berechtigungsdatei, und jeder Befehl in `build.rs` ist im Handler eingetragen.
    #[test]
    fn jeder_befehl_hat_eine_eigene_berechtigungsdatei() {
        let build = include_str!("../../build.rs");
        let lib = include_str!("../lib.rs");
        let wurzel = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("permissions/autogenerated");
        for name in ["runner_liste", "runner_speichern", "runner_entfernen", "runner_wechseln", "lokaler_runner_einstellen", "lokaler_runner_status", "lokaler_runner_starten", "lokaler_runner_stoppen", "ordner_waehlen", "ordner_zuletzt", "ordner_merken"] {
            assert!(build.contains(&format!("\"{name}\"")), "{name} fehlt in build.rs");
            assert!(lib.contains(&format!("runner_befehle::{name},")), "{name} fehlt im Handler");
            let datei = std::fs::read_to_string(wurzel.join(format!("{name}.toml"))).unwrap_or_default();
            assert!(datei.contains(&format!("identifier = \"allow-{}\"", name.replace('_', "-"))), "Berechtigungsdatei für {name}");
        }
    }

    /// Der Knopf „Einstellungen“ im Chat-Fenster hat einen eigenen Befehl mit eigener Berechtigungsdatei; er nimmt keine Argumente
    /// (die Seite kann weder Adresse noch Token mitgeben oder bekommen) und gehört nur dem Chat-Fenster, nicht den Einstellungen selbst.
    #[test]
    fn einstellungen_oeffnen_ist_ein_eigener_befehl_nur_fuer_das_chat_fenster() {
        let build = include_str!("../../build.rs");
        let lib = include_str!("../lib.rs");
        assert!(build.contains("\"einstellungen_oeffnen\""), "fehlt in build.rs");
        assert!(lib.contains("befehle::einstellungen_oeffnen,"), "fehlt im Handler");
        let datei = include_str!("../../permissions/autogenerated/einstellungen_oeffnen.toml");
        assert!(datei.contains("identifier = \"allow-einstellungen-oeffnen\""));
        assert!(datei.contains("commands.allow = [\"einstellungen_oeffnen\"]"));
        assert!(include_str!("../../capabilities/agent-chat.json").contains("allow-einstellungen-oeffnen"));
        assert!(!include_str!("../../capabilities/agent-haupt.json").contains("allow-einstellungen-oeffnen"));
        // der Befehl nimmt nur das Anwendungs-Handle: keine Adresse, kein Token, kein Pfad von der Seite
        let quelle = include_str!("befehle.rs");
        assert!(quelle.contains("pub fn einstellungen_oeffnen(app: AppHandle) -> Result<(), Meldung>"));
    }

    #[test]
    fn keine_capability_des_profils_agent_gibt_seiten_mitteilungsrechte() {
        for datei in [include_str!("../../capabilities/agent-chat.json"), include_str!("../../capabilities/agent-haupt.json")] {
            assert!(!datei.contains("notification") && !datei.contains("benachrichtigen"), "{datei}");
            assert!(!datei.contains("\"remote\""));
        }
    }
}
