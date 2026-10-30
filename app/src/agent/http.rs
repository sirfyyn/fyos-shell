//! Kleiner blockierender HTTP-Client für den Runner (Gesundheit, Freigaben, Gespräche, Ströme). Native Clients haben kein CORS.
//!
//! **Weiterleitungen werden nie verfolgt** (`redirects(0)`): ein Runner (oder etwas auf dem Weg dorthin) darf Anfrage und Token nicht zu einem
//! anderen Host lenken. Das Ziel ist immer genau die eingestellte Adresse.

use serde_json::{json, Value};
use shell_core::agent::bruecke::{fehler_aus_status, fehler_aus_status_fuer, fehler_aus_transport};
use shell_core::agent::adressfolge::Fehlschlag;
use shell_core::Fehler;
use std::io::Read;
use std::time::Duration;

const KENNUNG: &str = "fyos-agent-desktop/0.1";

fn agent(frist: Duration, verbinden: Option<Duration>) -> ureq::Agent {
    let mut b = ureq::AgentBuilder::new().timeout(frist).redirects(0).user_agent(KENNUNG);
    if let Some(v) = verbinden {
        b = b.timeout_connect(v);
    }
    b.build()
}

fn meldung_aus(text: &str) -> Option<String> {
    serde_json::from_str::<Value>(text).ok().and_then(|v| v.get("fehler").and_then(Value::as_str).map(str::to_string))
}

fn weiterleitung(url: &str, status: u16) -> Fehler {
    Fehler::RunnerAntwortUnlesbar { grund: format!("{url} leitet weiter (Status {status}); Weiterleitungen werden aus Sicherheitsgründen nicht verfolgt, die Adresse muss direkt auf den Runner zeigen") }
}

/// Eine Anfrage an den Runner. Antwort: JSON (leerer Körper wird `{}`). `koerper` geht als JSON; bei POST ohne Körper `{}`.
pub fn anfrage(methode: &str, url: &str, token: &str, koerper: Option<&Value>, frist: Duration) -> Result<Value, Fehler> {
    anfrage_folge(methode, url, token, koerper, frist, None).map_err(Fehlschlag::fehler)
}

/// Wie [`anfrage`], aber mit der Einstufung des Scheiterns für den Rückfall auf die zweite Adresse und optional kurzer Verbindungsfrist.
/// `Verbindung` nur, wenn die Anfrage sicher nie angekommen ist (kein TCP: abgelehnt, Zeitüberschreitung beim Verbinden, DNS) oder wenn sie
/// lesend ist (GET); eine Schreibanfrage, die nach dem Verbinden abbricht, wird nie auf einer zweiten Adresse wiederholt.
pub fn anfrage_folge(methode: &str, url: &str, token: &str, koerper: Option<&Value>, frist: Duration, verbinden: Option<Duration>) -> Result<Value, Fehlschlag> {
    let lesend = methode == "GET";
    let mut req = agent(frist, verbinden).request(methode, url).set("Accept", "application/json").set("X-FYOS-Agent", "1");
    if !token.is_empty() {
        req = req.set("Authorization", &format!("Bearer {token}"));
    }
    let json_senden = |req: ureq::Request, k: &Value| req.set("Content-Type", "application/json").send_string(&k.to_string());
    let antwort = match (koerper, methode) {
        (Some(k), _) => json_senden(req, k),
        (None, "GET") | (None, "DELETE") => req.call(),
        (None, _) => json_senden(req, &json!({})),
    };
    let ergebnis: Result<Value, Fehler> = match antwort {
        Ok(a) => {
            if (300..400).contains(&a.status()) {
                Err(weiterleitung(url, a.status()))
            } else {
                a.into_string().map_err(|e| Fehler::RunnerAntwortUnlesbar { grund: format!("Antwort nicht lesbar: {e}") }).and_then(|text| {
                    if text.trim().is_empty() {
                        Ok(json!({}))
                    } else {
                        serde_json::from_str::<Value>(&text).map_err(|e| Fehler::RunnerAntwortUnlesbar { grund: format!("kein JSON: {e}") })
                    }
                })
            }
        }
        Err(ureq::Error::Status(code, a)) => {
            if (300..400).contains(&code) {
                Err(weiterleitung(url, code))
            } else {
                let text = a.into_string().unwrap_or_default();
                let pfad = url.find("/api/").map(|i| &url[i..]).unwrap_or("");
                Err(fehler_aus_status_fuer(pfad, code, meldung_aus(&text).as_deref()))
            }
        }
        Err(ureq::Error::Transport(t)) => {
            let f = fehler_aus_transport(url, &t.to_string());
            // Kein TCP (abgelehnt, Zeitüberschreitung beim Verbinden, DNS): die Anfrage ist nie angekommen. Alles danach nur bei lesenden Anfragen.
            let nie_angekommen = matches!(t.kind(), ureq::ErrorKind::ConnectionFailed | ureq::ErrorKind::Dns);
            return Err(if nie_angekommen || lesend { Fehlschlag::Verbindung(f) } else { Fehlschlag::Antwort(f) });
        }
    };
    ergebnis.map_err(Fehlschlag::from)
}

/// Einen Ereignisstrom (SSE) öffnen. Verbinden darf 6 s dauern; danach muss mindestens alle `lese_frist` etwas kommen
/// (der Runner schickt regelmäßig einen Herzschlag), sonst gilt die Verbindung als tot.
/// Die Verbindungsfrist ist wählbar (üblich 6 s, mit zweiter Adresse kurz, siehe `adressfolge::VERBINDEN_MIT_RUECKFALL_MS`).
pub fn strom_verbinden_mit(url: &str, token: &str, lese_frist: Duration, verbinden: Duration) -> Result<Box<dyn Read + Send + Sync + 'static>, Fehler> {
    let a = ureq::AgentBuilder::new().timeout_connect(verbinden).timeout_read(lese_frist).redirects(0).user_agent(KENNUNG).build();
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

/// Wegwerf-Gegenstellen für Tests (auch für `agent::tests`): ein Server mit fester Antwort und ein geschlossener Port.
#[cfg(test)]
pub(crate) mod attrappe {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// Ein Wegwerf-Server: antwortet jedem Aufruf mit `antwort` und merkt sich die Kopfzeilen der Anfrage.
    pub fn server(antwort: &'static str) -> (String, Arc<Mutex<Vec<String>>>) {
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

    pub const GESUND: &str = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}";
    pub const NEIN_401: &str = "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 25\r\nConnection: close\r\n\r\n{\"fehler\":\"Nicht erlaubt\"}";

    /// Ein Port, auf dem niemand lauscht (gerade noch gebunden, dann geschlossen): Verbindung wird sofort abgelehnt.
    pub fn tote_basis() -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let basis = format!("http://127.0.0.1:{}", l.local_addr().unwrap().port());
        drop(l);
        basis
    }
}

#[cfg(test)]
mod tests {
    use super::attrappe::server;
    use super::*;
    use std::net::TcpListener;

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
        assert_eq!(strom_verbinden_mit(&format!("{basis}/api/strom"), "t", Duration::from_secs(2), Duration::from_secs(6)).err().unwrap().code(), "RUNNER_ANTWORT_UNLESBAR");
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
    fn einstufung_fuer_den_rueckfall_verbindung_antwort_und_schreibanfragen() {
        let t = Duration::from_secs(1);
        let tot = super::attrappe::tote_basis();
        for methode in ["GET", "POST"] {
            let f = anfrage_folge(methode, &format!("{tot}/api/x"), "t", None, t, Some(Duration::from_secs(2))).unwrap_err();
            assert!(matches!(f, Fehlschlag::Verbindung(_)), "{methode}: kein TCP ist immer ein Verbindungsfehler");
        }
        let (basis, _) = server(super::attrappe::NEIN_401);
        let f = anfrage_folge("GET", &format!("{basis}/api/x"), "t", None, t, None).unwrap_err();
        assert!(matches!(f, Fehlschlag::Antwort(Fehler::TokenAbgelehnt { .. })), "{f:?}");
        // stumm: nimmt an, antwortet nie
        let stumm = TcpListener::bind("127.0.0.1:0").unwrap();
        let basis = format!("http://127.0.0.1:{}", stumm.local_addr().unwrap().port());
        std::thread::spawn(move || {
            let mut halten = vec![];
            for s in stumm.incoming().flatten() {
                halten.push(s);
            }
        });
        let f = anfrage_folge("GET", &format!("{basis}/api/x"), "t", None, t, None).unwrap_err();
        assert!(matches!(f, Fehlschlag::Verbindung(_)), "lesend darf die andere Adresse es versuchen: {f:?}");
        let f = anfrage_folge("POST", &format!("{basis}/api/x"), "t", Some(&json!({"a": 1})), t, None).unwrap_err();
        assert!(matches!(f, Fehlschlag::Antwort(Fehler::RunnerNichtErreichbar { .. })), "eine unterwegs gescheiterte Schreibanfrage wird nicht doppelt gesendet: {f:?}");
    }

    #[test]
    fn gesundheit_verlangt_ok_true() {
        let (basis, _) = server("HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\n{\"ok\":false}");
        assert_eq!(gesundheit(&basis, "").unwrap_err().code(), "RUNNER_ANTWORT_UNLESBAR");
    }
}
