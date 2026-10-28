//! HTTP zu Studio: `GET <start-url>api/state`. Sowohl die Gesundheitsprüfung des Begleiters als auch der Knopf
//! „Studio prüfen“ gehen über dieselbe Funktion, damit „gesund“ und „angezeigt“ nie auseinanderlaufen.

use shell_core::begleiter::KENNUNG_KOPF;
use shell_core::studio::{self, StudioZustand};
use shell_core::Fehler;
use std::time::Duration;

/// Aus der Start-URL die Adresse von `/api/state` (an Ursprung angehängt, Pfade der Start-URL bleiben unberücksichtigt).
pub fn zustand_url(start_url: &str) -> String {
    match url::Url::parse(start_url) {
        Ok(mut u) => {
            u.set_path("/api/state");
            u.set_query(None);
            u.set_fragment(None);
            u.to_string()
        }
        Err(_) => format!("{}/api/state", start_url.trim_end_matches('/')),
    }
}

/// Holt `/api/state`. Mit `kennung` muss die Antwort den Kopf `X-FYOS-Kennung` mit genau diesem Wert tragen,
/// sonst antwortet nicht der Begleiter dieser Hülle, sondern ein fremder Server (`PORT_BELEGT`).
pub fn holen(url: &str, kennung: Option<&str>) -> Result<StudioZustand, Fehler> {
    let antwort = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(3))
        .build()
        .get(url)
        .call()
        .map_err(|e| Fehler::StudioNichtErreichbar { url: url.to_string(), grund: e.to_string() })?;
    if let Some(erwartet) = kennung {
        if antwort.header(KENNUNG_KOPF) != Some(erwartet) {
            return Err(Fehler::PortBelegt { url: url.to_string() });
        }
    }
    let text = antwort
        .into_string()
        .map_err(|e| Fehler::StudioNichtErreichbar { url: url.to_string(), grund: e.to_string() })?;
    studio::lesen(&text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn einmal_antworten(koerper: &'static str) -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let mut puffer = [0u8; 1024];
                let _ = s.read(&mut puffer);
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", koerper.len(), koerper);
            }
        });
        format!("http://127.0.0.1:{port}/api/state")
    }

    #[test]
    fn url_wird_auf_api_state_gesetzt() {
        assert_eq!(zustand_url("http://127.0.0.1:8642/"), "http://127.0.0.1:8642/api/state");
        assert_eq!(zustand_url("http://h:1/studio/x?a=1"), "http://h:1/api/state");
    }

    #[test]
    fn liest_eine_antwort() {
        let url = einmal_antworten(r#"{"app":"A","version":"9","engine":"idle","models":[1]}"#);
        let z = holen(&url, None).unwrap();
        assert_eq!((z.version.as_str(), z.modelle), ("9", 1));
    }

    #[test]
    fn nicht_erreichbar_ist_ein_katalogfehler() {
        // Port, auf dem sicher niemand lauscht: erst binden, dann freigeben
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let f = holen(&format!("http://127.0.0.1:{port}/api/state"), None).unwrap_err();
        assert_eq!(f.code(), "STUDIO_NICHT_ERREICHBAR");
    }

    fn einmal_mit_kennung(kennung: Option<&'static str>) -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let mut puffer = [0u8; 1024];
                let _ = s.read(&mut puffer);
                let kopf = kennung.map(|k| format!("{KENNUNG_KOPF}: {k}\r\n")).unwrap_or_default();
                let k = r#"{"version":"1"}"#;
                let _ = write!(s, "HTTP/1.1 200 OK\r\n{kopf}Content-Length: {}\r\nConnection: close\r\n\r\n{k}", k.len());
            }
        });
        format!("http://127.0.0.1:{port}/api/state")
    }

    #[test]
    fn richtige_kennung_ist_gesund() {
        let url = einmal_mit_kennung(Some("geheim123"));
        assert!(holen(&url, Some("geheim123")).is_ok());
    }

    #[test]
    fn fremder_server_ohne_kennung_ist_nicht_gesund() {
        let url = einmal_mit_kennung(None);
        assert_eq!(holen(&url, Some("geheim123")).unwrap_err().code(), "PORT_BELEGT");
    }

    #[test]
    fn falsche_kennung_ist_nicht_gesund() {
        let url = einmal_mit_kennung(Some("andere"));
        assert_eq!(holen(&url, Some("geheim123")).unwrap_err().code(), "PORT_BELEGT");
    }

    #[test]
    fn fremde_antwort_ist_unlesbar() {
        let url = einmal_antworten("hallo");
        assert_eq!(holen(&url, None).unwrap_err().code(), "STUDIO_ANTWORT_UNLESBAR");
    }
}
