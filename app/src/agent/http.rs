//! Kleiner blockierender HTTP-Client für den Runner (Gesundheit, Freigaben, Gespräche, Ströme). Native Clients haben kein CORS.
//!
//! **Weiterleitungen werden nie verfolgt** (`redirects(0)`): ein Runner (oder etwas auf dem Weg dorthin) darf Anfrage und Token nicht zu einem
//! anderen Host lenken. Das Ziel ist immer genau die eingestellte Adresse.

use serde_json::{json, Value};
use shell_core::agent::bruecke::{fehler_aus_status, fehler_aus_transport};
use shell_core::Fehler;
use std::io::Read;
use std::time::Duration;

const KENNUNG: &str = "fyos-agent-desktop/0.1";

fn agent(frist: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(frist).redirects(0).user_agent(KENNUNG).build()
}

fn meldung_aus(text: &str) -> Option<String> {
    serde_json::from_str::<Value>(text).ok().and_then(|v| v.get("fehler").and_then(Value::as_str).map(str::to_string))
}

fn weiterleitung(url: &str, status: u16) -> Fehler {
    Fehler::RunnerAntwortUnlesbar { grund: format!("{url} leitet weiter (Status {status}); Weiterleitungen werden aus Sicherheitsgründen nicht verfolgt, die Adresse muss direkt auf den Runner zeigen") }
}

/// Eine Anfrage an den Runner. Antwort: JSON (leerer Körper wird `{}`). `koerper` geht als JSON; bei POST ohne Körper `{}`.
pub fn anfrage(methode: &str, url: &str, token: &str, koerper: Option<&Value>, frist: Duration) -> Result<Value, Fehler> {
    let mut req = agent(frist).request(methode, url).set("Accept", "application/json").set("X-FYOS-Agent", "1");
    if !token.is_empty() {
        req = req.set("Authorization", &format!("Bearer {token}"));
    }
    let json_senden = |req: ureq::Request, k: &Value| req.set("Content-Type", "application/json").send_string(&k.to_string());
    let antwort = match (koerper, methode) {
        (Some(k), _) => json_senden(req, k),
        (None, "GET") | (None, "DELETE") => req.call(),
        (None, _) => json_senden(req, &json!({})),
    };
    match antwort {
        Ok(a) => {
            if (300..400).contains(&a.status()) {
                return Err(weiterleitung(url, a.status()));
            }
            let text = a.into_string().map_err(|e| Fehler::RunnerAntwortUnlesbar { grund: format!("Antwort nicht lesbar: {e}") })?;
            if text.trim().is_empty() {
                return Ok(json!({}));
            }
            serde_json::from_str::<Value>(&text).map_err(|e| Fehler::RunnerAntwortUnlesbar { grund: format!("kein JSON: {e}") })
        }
        Err(ureq::Error::Status(code, a)) => {
            if (300..400).contains(&code) {
                return Err(weiterleitung(url, code));
            }
            let text = a.into_string().unwrap_or_default();
            Err(fehler_aus_status(code, meldung_aus(&text).as_deref()))
        }
        Err(ureq::Error::Transport(t)) => Err(fehler_aus_transport(url, &t.to_string())),
    }
}

/// Einen Ereignisstrom (SSE) öffnen. Verbinden darf 6 s dauern; danach muss mindestens alle `lese_frist` etwas kommen
/// (der Runner schickt regelmäßig einen Herzschlag), sonst gilt die Verbindung als tot.
pub fn strom_verbinden(url: &str, token: &str, lese_frist: Duration) -> Result<Box<dyn Read + Send + Sync + 'static>, Fehler> {
    let a = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(6)).timeout_read(lese_frist).redirects(0).user_agent(KENNUNG).build();
    let mut req = a.get(url).set("Accept", "text/event-stream").set("X-FYOS-Agent", "1");
    if !token.is_empty() {
        req = req.set("Authorization", &format!("Bearer {token}"));
    }
    match req.call() {
        Ok(r) if (300..400).contains(&r.status()) => Err(weiterleitung(url, r.status())),
        Ok(r) => Ok(r.into_reader()),
        Err(ureq::Error::Status(code, a)) => {
            let text = a.into_string().unwrap_or_default();
            Err(fehler_aus_status(code, meldung_aus(&text).as_deref()))
        }
        Err(ureq::Error::Transport(t)) => Err(fehler_aus_transport(url, &t.to_string())),
    }
}

/// `GET <basis>/api/health`: `Ok` nur mit `ok: true`.
pub fn gesundheit(basis: &str, token: &str) -> Result<Value, Fehler> {
    let url = shell_core::agent::adresse::api_url(basis, "/api/health");
    let v = anfrage("GET", &url, token, None, Duration::from_secs(6))?;
    if v.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(v)
    } else {
        Err(Fehler::RunnerAntwortUnlesbar { grund: "der Runner meldet ok:false oder antwortet ohne ok".into() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// Ein Wegwerf-Server: antwortet jedem Aufruf mit `antwort` und merkt sich die Kopfzeilen der Anfrage.
    fn server(antwort: &'static str) -> (String, Arc<Mutex<Vec<String>>>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let basis = format!("http://127.0.0.1:{}", l.local_addr().unwrap().port());
        let gesehen: Arc<Mutex<Vec<String>>> = Arc::default();
        let g = gesehen.clone();
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                let mut r = BufReader::new(s.try_clone().unwrap());
                let mut s = s;
                loop {
                    let mut z = String::new();
                    if r.read_line(&mut z).unwrap_or(0) == 0 || z.trim().is_empty() {
                        break;
                    }
                    g.lock().unwrap().push(z.trim().to_string());
                }
                let _ = s.write_all(antwort.as_bytes());
            }
        });
        (basis, gesehen)
    }

    #[test]
    fn token_geht_als_bearer_und_nur_wenn_gesetzt() {
        let (basis, gesehen) = server("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}");
        let v = anfrage("GET", &format!("{basis}/api/health"), "geheim-test-token", None, Duration::from_secs(3)).unwrap();
        assert_eq!(v["ok"], true);
        let k = gesehen.lock().unwrap().join("\n").to_lowercase();
        assert!(k.contains("authorization: bearer geheim-test-token") && k.contains("x-fyos-agent: 1"), "{k}");
        gesehen.lock().unwrap().clear();
        anfrage("GET", &format!("{basis}/api/health"), "", None, Duration::from_secs(3)).unwrap();
        assert!(!gesehen.lock().unwrap().join("\n").to_lowercase().contains("authorization"));
    }

    #[test]
    fn weiterleitungen_werden_nie_verfolgt() {
        let (basis, gesehen) = server("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/fremd\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        let f = anfrage("GET", &format!("{basis}/api/health"), "token-token-token", None, Duration::from_secs(3)).unwrap_err();
        assert_eq!(f.code(), "RUNNER_ANTWORT_UNLESBAR");
        assert!(f.meldung().details.unwrap().contains("Weiterleitung"));
        assert_eq!(gesehen.lock().unwrap().iter().filter(|z| z.starts_with("GET ")).count(), 1, "nur eine Anfrage, kein zweiter Weg");
        assert_eq!(strom_verbinden(&format!("{basis}/api/strom"), "t", Duration::from_secs(2)).err().unwrap().code(), "RUNNER_ANTWORT_UNLESBAR");
    }

    #[test]
    fn status_und_netzfehler_werden_zu_katalogfehlern() {
        let (basis, _) = server("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 25\r\nConnection: close\r\n\r\n{\"fehler\":\"Nicht erlaubt\"}");
        assert_eq!(anfrage("GET", &format!("{basis}/api/x"), "t", None, Duration::from_secs(3)).unwrap_err().code(), "TOKEN_ABGELEHNT");
        let (basis, _) = server("HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: 27\r\nConnection: close\r\n\r\n{\"fehler\":\"Gespraech fehlt\"}");
        let f = anfrage("GET", &format!("{basis}/api/x"), "t", None, Duration::from_secs(3)).unwrap_err();
        assert_eq!(f.code(), "RUNNER_FEHLER");
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let tot = format!("http://127.0.0.1:{}", l.local_addr().unwrap().port());
        drop(l);
        assert_eq!(anfrage("GET", &format!("{tot}/api/health"), "t", None, Duration::from_secs(2)).unwrap_err().code(), "RUNNER_NICHT_ERREICHBAR");
        let (basis, _) = server("HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\nkein json");
        assert_eq!(anfrage("GET", &format!("{basis}/api/x"), "t", None, Duration::from_secs(3)).unwrap_err().code(), "RUNNER_ANTWORT_UNLESBAR");
    }

    #[test]
    fn gesundheit_verlangt_ok_true() {
        let (basis, _) = server("HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\n{\"ok\":false}");
        assert_eq!(gesundheit(&basis, "").unwrap_err().code(), "RUNNER_ANTWORT_UNLESBAR");
    }
}
