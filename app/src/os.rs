//! Profil OS: reines Fenster zum Server (`https://fyos.sirfyyn.de/os`). Kein lokaler Hub, kein Offline-Betrieb.
//!
//! Ablauf: Vor dem Laden prüft die Hülle mit einem kleinen HTTP-Aufruf, ob der Server samt Anmeldung antwortet. Gelingt es, lädt das Inhaltsfenster die Seite;
//! sonst zeigt es die eigene Fehlerseite (`ui/fehler.html`: Ursache, Abhilfe, Wiederholen mit Rücknahme 5/10/20/40/60 s, Knopf „Bericht speichern“)
//! und versucht es von allein erneut. Fällt der Server erst später aus, zeigt das Fenster die Fehlerseite des Systems; das erkennt die Hülle nicht
//! (kein Dauer-Abfragen im Leerlauf, damit die Anwendung ressourcenschonend bleibt).

use crate::fenster;
use crate::zustand::{sperre, Huelle};
use serde::Serialize;
use shell_core::{navigation, netz, Fehler, Meldung};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Was die Fehlerseite anzeigt.
#[derive(Serialize, Clone, Default)]
pub struct Anzeige {
    pub verbunden: bool,
    pub prueft: bool,
    pub meldung: Option<Meldung>,
    pub versuch: u32,
    pub naechster_in_s: u64,
    pub adresse: String,
}

#[derive(Default)]
pub struct Fluss {
    pub anzeige: Mutex<Anzeige>,
    /// Ein Arbeitsfaden läuft
    laeuft: AtomicBool,
    /// Sofort wiederholen (Knopf)
    sofort: AtomicBool,
    /// Zählt Aufrufe von `oeffnen`; ein älterer Faden beendet sich, wenn eine neuere Nummer gilt
    nummer: AtomicU64,
}

/// Prüft, ob der Server samt Weiterleitungen (z. B. zu Anmeldeserver) antwortet. Gut: Status unter 400 sowie 401/403 (Anmeldung nötig).
pub fn probe(url: &str, anmelde_hosts: &[String], frist: Duration) -> Result<(), Fehler> {
    let agent = ureq::AgentBuilder::new().timeout(frist).redirects(6).build();
    match agent.get(url).call() {
        Ok(r) => netz::aus_status(r.status(), r.get_url(), anmelde_hosts).map_or(Ok(()), Err),
        Err(ureq::Error::Status(code, r)) => netz::aus_status(code, r.get_url(), anmelde_hosts).map_or(Ok(()), Err),
        Err(ureq::Error::Transport(t)) => Err(netz::aus_verbindungsfehler(url, &format!("{:?}", t.kind()), &t.to_string())),
    }
}

/// Hosts, auf denen ein 5xx als Fehler des Anmeldeservers gilt: alle erlaubten außer dem Host der Start-URL.
fn anmelde_hosts(h: &Huelle, start_url: &str) -> Vec<String> {
    let start_host = url::Url::parse(start_url).ok().and_then(|u| u.host_str().map(str::to_ascii_lowercase));
    erlaubte_hosts(h).into_iter().filter(|x| Some(x) != start_host.as_ref() && !x.starts_with("*.")).collect()
}

/// Die Liste für die Navigationssperre: Standards des Profils, Host der Start-URL und Einträge aus den Einstellungen.
pub fn erlaubte_hosts(h: &Huelle) -> Vec<String> {
    let eigene = sperre(&h.einstellungen).erlaubte_hosts.clone();
    navigation::erlaubte_hosts(h.profil, &h.start_url(), &eigene)
}

/// Öffnet das Fenster zum Server: kommt es schon, nach vorn; sonst Verbindung prüfen und laden (im Hintergrund).
pub fn oeffnen(app: &AppHandle, h: &Arc<Huelle>) {
    if let Some(f) = app.get_webview_window(fenster::INHALT) {
        let _ = f.show();
        let _ = f.set_focus();
        // Zeigt es gerade die Fehlerseite, sofort neu versuchen; eine geladene Seite bleibt unberührt (kein Neuladen, keine verlorene Eingabe)
        if f.url().map(|u| u.path().ends_with("fehler.html")).unwrap_or(false) {
            starten(app, h, true);
        }
        return;
    }
    starten(app, h, false);
}

/// Startet den Arbeitsfaden, falls keiner läuft. `sofort`: nicht erst die Wartezeit abwarten.
pub fn starten(app: &AppHandle, h: &Arc<Huelle>, sofort: bool) {
    let Some(fluss) = app.try_state::<Fluss>() else { return };
    if sofort {
        fluss.sofort.store(true, Ordering::SeqCst);
    }
    if fluss.laeuft.swap(true, Ordering::SeqCst) {
        return; // läuft schon; es hat das Zeichen `sofort` gesehen
    }
    let (app, h) = (app.clone(), h.clone());
    std::thread::spawn(move || {
        verbinden(&app, &h);
        if let Some(f) = app.try_state::<Fluss>() {
            f.laeuft.store(false, Ordering::SeqCst);
        }
    });
}

fn verbinden(app: &AppHandle, h: &Arc<Huelle>) {
    let Some(fluss) = app.try_state::<Fluss>() else { return };
    fluss.nummer.fetch_add(1, Ordering::SeqCst);
    let mut versuch: u32 = 0;
    loop {
        let url = h.start_url();
        let hosts = anmelde_hosts(h, &url);
        fluss.sofort.store(false, Ordering::SeqCst);
        {
            let mut a = sperre(&fluss.anzeige);
            a.prueft = true;
            a.adresse = url.clone();
        }
        match probe(&url, &hosts, Duration::from_secs(10)) {
            Ok(()) => {
                {
                    let mut a = sperre(&fluss.anzeige);
                    *a = Anzeige { verbunden: true, adresse: url.clone(), ..Anzeige::default() };
                }
                if let Err(f) = fenster::inhalt(app, &url) {
                    sperre(&h.warnungen).push(f.meldung());
                }
                return;
            }
            Err(f) => {
                let warte = netz::wartezeit(versuch);
                {
                    let mut a = sperre(&fluss.anzeige);
                    *a = Anzeige { verbunden: false, prueft: false, meldung: Some(f.meldung()), versuch: versuch + 1, naechster_in_s: warte.as_secs(), adresse: url.clone() };
                }
                if let Err(e) = fenster::fehlerseite(app) {
                    eprintln!("Fehlerseite nicht zu öffnen: {e}");
                }
                // Warten in Sekundenschritten: Knopf „Jetzt“ oder das Schließen des Fensters beendet die Wartezeit
                let mut rest = warte.as_secs();
                while rest > 0 {
                    std::thread::sleep(Duration::from_secs(1));
                    if fluss.sofort.load(Ordering::SeqCst) {
                        break;
                    }
                    if app.get_webview_window(fenster::INHALT).is_none() {
                        sperre(&fluss.anzeige).prueft = false;
                        return; // Fenster zu: nicht im Hintergrund weiter versuchen; „Öffnen“ startet neu
                    }
                    rest -= 1;
                    sperre(&fluss.anzeige).naechster_in_s = rest;
                }
                versuch += 1;
            }
        }
    }
}

/// Zustand für die Fehlerseite (nur lokale Seiten der Hülle dürfen fragen, siehe `capabilities/inhalt.json`).
#[tauri::command]
pub fn os_stand(app: AppHandle) -> Anzeige {
    app.try_state::<Fluss>().map(|f| sperre(&f.anzeige).clone()).unwrap_or_default()
}

/// Knopf „Jetzt erneut versuchen“.
#[tauri::command]
pub fn os_wiederholen(app: AppHandle, h: tauri::State<'_, Arc<Huelle>>) {
    starten(&app, h.inner(), true);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Kleiner Server: beantwortet nacheinander eine Anfrage je Eintrag mit dem gegebenen Rohtext.
    fn dienen(antworten: Vec<String>) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for a in antworten {
                let Ok((mut s, _)) = l.accept() else { return };
                let mut puffer = [0u8; 2048];
                let _ = s.read(&mut puffer);
                let _ = s.write_all(a.as_bytes());
            }
        });
        port
    }
    fn antwort(status: &str, kopf: &str, rumpf: &str) -> String {
        format!("HTTP/1.1 {status}\r\n{kopf}Content-Length: {}\r\nConnection: close\r\n\r\n{rumpf}", rumpf.len())
    }
    fn hosts(l: &[&str]) -> Vec<String> {
        l.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn gute_antwort_und_anmeldung_noetig_sind_kein_fehler() {
        let p = dienen(vec![antwort("200 OK", "", "ok")]);
        assert!(probe(&format!("http://127.0.0.1:{p}/os"), &[], Duration::from_secs(5)).is_ok());
        let p = dienen(vec![antwort("401 Unauthorized", "", "login")]);
        assert!(probe(&format!("http://127.0.0.1:{p}/os"), &[], Duration::from_secs(5)).is_ok());
    }

    #[test]
    fn weiterleitung_zum_anmeldeserver_wird_verfolgt() {
        // Der „Server“ leitet auf den „Anmeldeserver“ weiter (zweiter Port), der die Anmeldeseite liefert
        let auth = dienen(vec![antwort("200 OK", "", "Anmeldung")]);
        let server = dienen(vec![antwort("302 Found", &format!("Location: http://localhost:{auth}/flow\r\n"), "")]);
        assert!(probe(&format!("http://127.0.0.1:{server}/os"), &hosts(&["localhost"]), Duration::from_secs(5)).is_ok());
    }

    #[test]
    fn fehler_des_anmeldeservers_und_des_servers_werden_unterschieden() {
        let auth = dienen(vec![antwort("502 Bad Gateway", "", "")]);
        let server = dienen(vec![antwort("302 Found", &format!("Location: http://localhost:{auth}/flow\r\n"), "")]);
        let f = probe(&format!("http://127.0.0.1:{server}/os"), &hosts(&["localhost"]), Duration::from_secs(5)).unwrap_err();
        assert_eq!(f.code(), "ANMELDESERVER_FEHLER");
        let p = dienen(vec![antwort("503 Service Unavailable", "", "")]);
        assert_eq!(probe(&format!("http://127.0.0.1:{p}/os"), &hosts(&["localhost"]), Duration::from_secs(5)).unwrap_err().code(), "SERVER_FEHLER");
    }

    #[test]
    fn nicht_erreichbar_und_unaufloesbar_haben_eigene_katalogtexte() {
        // Port, auf dem niemand lauscht
        let frei = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let f = probe(&format!("http://127.0.0.1:{frei}/os"), &[], Duration::from_secs(5)).unwrap_err();
        assert_eq!(f.code(), "SERVER_NICHT_ERREICHBAR");
        assert!(f.meldung().abhilfe.len() > 20);
        // .invalid ist laut RFC 2606 nie auflösbar
        let f = probe("http://fyos-gibt-es-nicht.invalid/os", &[], Duration::from_secs(8)).unwrap_err();
        assert!(matches!(f.code(), "DNS_FEHLER" | "SERVER_NICHT_ERREICHBAR"), "{}", f.code());
    }

    #[test]
    fn zeitueberschreitung_ist_ein_katalogfehler() {
        // Server nimmt an und schweigt
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let p = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let _s = l.accept();
            std::thread::sleep(Duration::from_secs(5));
        });
        let f = probe(&format!("http://127.0.0.1:{p}/os"), &[], Duration::from_millis(600)).unwrap_err();
        assert_eq!(f.code(), "SERVER_NICHT_ERREICHBAR");
    }
}
