//! Regeln der Brücke zwischen Chat-Seite und Runner. Die Seite bekommt weder Adresse noch Token: sie ruft `runner_anfrage` (ein Weg unter `/api/`
//! am eingestellten Runner) und öffnet Ereignisströme (`strom_oeffnen`); Rust liest den SSE-Strom, verbindet nach Abbruch selbst neu
//! (1, 2, 4, 8, 15 s) und reicht jedes Ereignis als Tauri-Ereignis `runner-strom` an die Seite. Nach jedem Neuverbinden schickt der Runner
//! zuerst einen Snapshot: so kommt der Verlauf zurück. Hier stehen nur die reinen Regeln; die Netzarbeit steht in `app/src/agent/bruecke.rs`.

use crate::fehler::Fehler;

/// Nur Wege unter `/api/`, ohne `..`, Schema, Rückwärtsstrich, Leerraum und Steuerzeichen. So kann die Seite die Brücke nie zu einem anderen Ziel lenken.
pub fn pfad_erlaubt(pfad: &str) -> bool {
    pfad.starts_with("/api/")
        && pfad.len() < 2048
        && !pfad.contains("..")
        && !pfad.contains("://")
        && !pfad.contains('\\')
        && !pfad.chars().any(|c| c.is_whitespace() || c.is_control())
}

pub fn methode_erlaubt(methode: &str) -> Option<&'static str> {
    match methode.to_ascii_uppercase().as_str() {
        "GET" => Some("GET"),
        "POST" => Some("POST"),
        "PATCH" => Some("PATCH"),
        "PUT" => Some("PUT"),
        "DELETE" => Some("DELETE"),
        _ => None,
    }
}

/// Welche Ströme darf die Seite öffnen? Kanal `strom`: `/api/strom`; Kanal `gespraech`: `/api/gespraech/<id>/ereignisse`.
pub fn strom_pfad_ok(kanal: &str, pfad: &str) -> bool {
    match kanal {
        "strom" => pfad == "/api/strom",
        "gespraech" => pfad
            .strip_prefix("/api/gespraech/")
            .and_then(|r| r.strip_suffix("/ereignisse"))
            .map(|id| !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '%'))
            .unwrap_or(false),
        _ => false,
    }
}

/// Wartezeit vor dem nächsten Verbindungsversuch: 1, 2, 4, 8, dann 15 s.
pub fn wartezeit_ms(versuch: u32) -> u64 {
    (1000u64 << versuch.min(4)).min(15_000)
}

/// Katalogfehler zu einem Fehlerstatus des Runners. 401/403: das Token passt nicht; sonst `RUNNER_FEHLER` mit dem Text aus dem Feld `fehler` der Antwort.
pub fn fehler_aus_status(code: u16, meldung: Option<&str>) -> Fehler {
    match code {
        401 | 403 => Fehler::TokenAbgelehnt { status: code },
        _ => Fehler::RunnerFehler { status: code, text: meldung.map(str::trim).filter(|m| !m.is_empty()).map(str::to_string) },
    }
}

/// Katalogfehler zu einem Netzfehler (Verbindung abgelehnt, Zeitüberschreitung, DNS, TLS).
pub fn fehler_aus_transport(url: &str, grund: &str) -> Fehler {
    Fehler::RunnerNichtErreichbar { url: url.to_string(), grund: grund.to_string() }
}

#[derive(Debug, PartialEq, Eq)]
pub struct SseEreignis {
    pub art: String,
    pub daten: String,
}

/// Zeilenweiser Leser für `text/event-stream`: `event:`, `data:` (mehrere Zeilen werden mit `\n` verbunden),
/// Kommentare (`: wach`) fallen weg, eine Leerzeile schließt das Ereignis ab.
#[derive(Default)]
pub struct SseLeser {
    art: String,
    daten: Vec<String>,
}

impl SseLeser {
    pub fn zeile(&mut self, zeile: &str) -> Option<SseEreignis> {
        let z = zeile.trim_end_matches(['\r', '\n']);
        if z.is_empty() {
            if self.daten.is_empty() && self.art.is_empty() {
                return None;
            }
            let art = if self.art.is_empty() { "message".to_string() } else { std::mem::take(&mut self.art) };
            let daten = std::mem::take(&mut self.daten).join("\n");
            return Some(SseEreignis { art, daten });
        }
        if z.starts_with(':') {
            return None;
        }
        let (feld, wert) = match z.split_once(':') {
            Some((f, w)) => (f, w.strip_prefix(' ').unwrap_or(w)),
            None => (z, ""),
        };
        match feld {
            "event" => self.art = wert.to_string(),
            "data" => self.daten.push(wert.to_string()),
            _ => {}
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wege_unter_api() {
        assert!(pfad_erlaubt("/api/gespraeche"));
        assert!(pfad_erlaubt("/api/gespraech/14/nachricht"));
        assert!(pfad_erlaubt("/api/werkzeuge?q=cluster"));
        for schlecht in ["/", "/index.html", "/api/../etc", "/api/x://evil", "/api/a b", "/api/a\nb", "//evil.example.org/api/x", "https://evil.example.org/api/x", "/api/a\\b"] {
            assert!(!pfad_erlaubt(schlecht), "{schlecht:?}");
        }
        assert!(!pfad_erlaubt(&format!("/api/{}", "a".repeat(2100))));
    }

    #[test]
    fn methoden() {
        assert_eq!(methode_erlaubt("post"), Some("POST"));
        assert_eq!(methode_erlaubt("GET"), Some("GET"));
        assert_eq!(methode_erlaubt("TRACE"), None);
        assert_eq!(methode_erlaubt("CONNECT"), None);
    }

    #[test]
    fn nur_diese_stroeme() {
        assert!(strom_pfad_ok("strom", "/api/strom"));
        assert!(strom_pfad_ok("gespraech", "/api/gespraech/14/ereignisse"));
        for schlecht in ["/api/gespraech//ereignisse", "/api/gespraech/1/2/ereignisse", "/api/gespraech/14/nachricht"] {
            assert!(!strom_pfad_ok("gespraech", schlecht), "{schlecht}");
        }
        assert!(!strom_pfad_ok("strom", "/api/dokumente"));
        assert!(!strom_pfad_ok("dokumente", "/api/dokumente"));
    }

    #[test]
    fn wartetreppe() {
        let w: Vec<u64> = (0..7).map(wartezeit_ms).collect();
        assert_eq!(w, vec![1000, 2000, 4000, 8000, 15_000, 15_000, 15_000]);
    }

    #[test]
    fn status_wird_zum_katalogfehler() {
        assert_eq!(fehler_aus_status(401, Some("Nicht erlaubt")).code(), "TOKEN_ABGELEHNT");
        assert_eq!(fehler_aus_status(403, None).code(), "TOKEN_ABGELEHNT");
        let f = fehler_aus_status(404, Some("Gespräch nicht gefunden"));
        assert_eq!(f.code(), "RUNNER_FEHLER");
        assert!(f.meldung().details.unwrap().contains("Gespräch nicht gefunden"));
        assert_eq!(fehler_aus_status(500, Some("  ")).meldung().details.unwrap(), "HTTP 500");
        assert_eq!(fehler_aus_transport("http://127.0.0.1:1", "refused").code(), "RUNNER_NICHT_ERREICHBAR");
    }

    #[test]
    fn sse_ereignisse_kommentare_und_mehrzeilige_daten() {
        let mut p = SseLeser::default();
        let eingabe = "event: snapshot\ndata: {\"a\":1}\n\n: wach\n\nevent: ereignisse\ndata: [1,\ndata: 2]\n\ndata: ohne-art\n\n";
        let mut aus = vec![];
        for z in eingabe.split_inclusive('\n') {
            if let Some(e) = p.zeile(z) {
                aus.push(e);
            }
        }
        assert_eq!(aus.len(), 3);
        assert_eq!(aus[0], SseEreignis { art: "snapshot".into(), daten: "{\"a\":1}".into() });
        assert_eq!(aus[1], SseEreignis { art: "ereignisse".into(), daten: "[1,\n2]".into() });
        assert_eq!(aus[2], SseEreignis { art: "message".into(), daten: "ohne-art".into() });
    }

    #[test]
    fn sse_crlf_und_leerzeilen_ohne_ereignis() {
        let mut p = SseLeser::default();
        assert_eq!(p.zeile("\r\n"), None);
        assert_eq!(p.zeile("event: zeile\r\n"), None);
        assert_eq!(p.zeile("data: {\"x\":1}\r\n"), None);
        assert_eq!(p.zeile("\r\n"), Some(SseEreignis { art: "zeile".into(), daten: "{\"x\":1}".into() }));
    }
}
