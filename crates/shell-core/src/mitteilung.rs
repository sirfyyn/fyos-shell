//! System-Mitteilungen aus der Seite des Profils OS (macOS Mitteilungszentrale, Windows, Linux): Prüfungen ohne Tauri, mit `cargo test` prüfbar.
//!
//! Sicherheitsmodell (Kapitel „Meldungen“ in `docs/current/FYOS-APPS-RUST.md`):
//! - Nur die Seite des Servers selbst darf (Host der Start-URL, `https`; im Test `http` auf dem eigenen Rechner). Nicht der Anmeldeserver,
//!   nicht Sandbox-Rahmen (Ursprung `null`), nicht fremde Hosts. Das prüft zuerst Tauri (ACL mit `remote.urls`), danach diese Funktionen.
//! - Titel höchstens 80, Text höchstens 240 Zeichen; Steuerzeichen werden zu Leerzeichen.
//! - Höchstens 6 Mitteilungen je Minute, der Rest wird gezählt und mit der nächsten zugelassenen als Zusammenfassung gemeldet.

use crate::fehler::Fehler;
use crate::navigation::{self, Entscheidung};
use std::collections::VecDeque;
use std::time::{Duration, Instant};
use url::Url;

pub const TITEL_MAX: usize = 80;
pub const TEXT_MAX: usize = 240;
pub const JE_MINUTE: usize = 6;

/// Steuerzeichen (auch Zeilenumbrüche, Tabs, Bidi-Steuerzeichen) werden zu Leerzeichen, mehrere Leerzeichen zu einem.
fn saeubern(s: &str) -> String {
    let ersetzt: String = s
        .chars()
        .map(|c| if c.is_control() || matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}') { ' ' } else { c })
        .collect();
    ersetzt.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Prüft und bereinigt Titel und Text. Leerer Titel oder Überlänge sind Fehler (die Seite kürzt selbst).
pub fn bereinigen(titel: &str, text: &str) -> Result<(String, String), Fehler> {
    let (t, x) = (saeubern(titel), saeubern(text));
    if t.is_empty() {
        return Err(Fehler::MitteilungAbgelehnt { grund: "der Titel ist leer".into() });
    }
    if t.chars().count() > TITEL_MAX {
        return Err(Fehler::MitteilungAbgelehnt { grund: format!("der Titel hat mehr als {TITEL_MAX} Zeichen") });
    }
    if x.chars().count() > TEXT_MAX {
        return Err(Fehler::MitteilungAbgelehnt { grund: format!("der Text hat mehr als {TEXT_MAX} Zeichen") });
    }
    Ok((t, x))
}

fn host_von(u: &Url) -> Option<String> {
    Some(u.host_str()?.trim_matches(|c| c == '[' || c == ']').trim_end_matches('.').to_ascii_lowercase())
}

/// Darf der Absender eine Mitteilung auslösen? `ursprung`: Kopfzeile `Origin` der Anfrage (bei Sandbox-Rahmen `null`), `seite`: Adresse des
/// Fensters, `start_url`: Server des Profils, `erlaubt`: Liste der Navigationssperre.
pub fn absender_pruefen(ursprung: Option<&str>, seite: &Url, start_url: &str, erlaubt: &[String]) -> Result<(), Fehler> {
    let nein = |grund: &str| Err(Fehler::MitteilungAbgelehnt { grund: grund.to_string() });
    let Some(ursprung) = ursprung else { return nein("die Anfrage nennt keinen Ursprung") };
    let Ok(ursprung) = Url::parse(ursprung) else { return nein("der Ursprung der Anfrage ist ungültig (zum Beispiel ein Sandbox-Rahmen)") };
    let Some(server) = Url::parse(start_url).ok().and_then(|u| host_von(&u)) else { return nein("die Start-Adresse des Profils ist ungültig") };
    for (name, u) in [("Ursprung", &ursprung), ("Seite", seite)] {
        if !matches!(u.scheme(), "http" | "https") || navigation::pruefe(u, erlaubt) != Entscheidung::Erlauben {
            return nein(&format!("{name} ist keine erlaubte Seite des Servers"));
        }
        if host_von(u).as_deref() != Some(server.as_str()) {
            return nein(&format!("{name} ist nicht der Server des Profils (zum Beispiel der Anmeldeserver)"));
        }
    }
    Ok(())
}

/// Begrenzer: höchstens `JE_MINUTE` Mitteilungen in 60 Sekunden.
#[derive(Debug, Default)]
pub struct Takt {
    zeiten: VecDeque<Instant>,
    verworfen: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Zulassung {
    /// Anzeigen; `nachgeholt` Mitteilungen wurden seit der letzten wegen der Grenze nicht gezeigt.
    Zeigen { nachgeholt: u32 },
    /// Nicht anzeigen (Grenze erreicht), die Zahl der Verworfenen wächst.
    Verwerfen,
}

impl Takt {
    pub fn pruefen(&mut self, jetzt: Instant) -> Zulassung {
        while self.zeiten.front().is_some_and(|t| jetzt.saturating_duration_since(*t) >= Duration::from_secs(60)) {
            self.zeiten.pop_front();
        }
        if self.zeiten.len() >= JE_MINUTE {
            self.verworfen = self.verworfen.saturating_add(1);
            return Zulassung::Verwerfen;
        }
        self.zeiten.push_back(jetzt);
        Zulassung::Zeigen { nachgeholt: std::mem::take(&mut self.verworfen) }
    }
}

/// Text mit Zusammenfassung, wenn Mitteilungen unterdrückt wurden (bleibt innerhalb von `TEXT_MAX`).
pub fn mit_zusammenfassung(text: &str, nachgeholt: u32) -> String {
    if nachgeholt == 0 {
        return text.to_string();
    }
    let zusatz = format!("+{nachgeholt} weitere Meldungen in FYOS OS");
    let platz = TEXT_MAX.saturating_sub(zusatz.chars().count() + 3);
    let kopf: String = text.chars().take(platz).collect();
    if kopf.is_empty() { zusatz } else { format!("{kopf} · {zusatz}") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profil::Profil;

    fn erlaubt() -> Vec<String> {
        navigation::erlaubte_hosts(Profil::Os, "https://os.example.org/os", &["login.example.org".into()])
    }
    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }
    const START: &str = "https://os.example.org/os";

    #[test]
    fn titel_und_text_werden_geprueft_und_gesaeubert() {
        let (t, x) = bereinigen("  Neue\nMail\u{0007} ", "von\tEva\r\n\u{202e}Betreff").unwrap();
        assert_eq!(t, "Neue Mail");
        assert_eq!(x, "von Eva Betreff");
        assert!(bereinigen("", "x").is_err());
        assert!(bereinigen("\n\t ", "x").is_err());
        assert!(bereinigen(&"a".repeat(81), "").is_err());
        assert!(bereinigen(&"a".repeat(80), &"b".repeat(240)).is_ok());
        assert!(bereinigen("t", &"b".repeat(241)).is_err());
        // Zeichen, nicht Bytes
        assert!(bereinigen(&"ä".repeat(80), &"ö".repeat(240)).is_ok());
        assert_eq!(bereinigen("t", "").unwrap().1, "");
    }

    #[test]
    fn nur_der_server_selbst_darf() {
        let seite = u("https://os.example.org/os/mail");
        assert!(absender_pruefen(Some("https://os.example.org"), &seite, START, &erlaubt()).is_ok());
        // Sandbox-Rahmen mit Ursprung null, kein Ursprung, Anmeldeserver, Fremdes
        for (o, s) in [
            (Some("null"), "https://os.example.org/os"),
            (None, "https://os.example.org/os"),
            (Some("https://login.example.org"), "https://login.example.org/if/flow/"),
            (Some("https://os.example.org"), "https://login.example.org/if/flow/"),
            (Some("https://login.example.org"), "https://os.example.org/os"),
            (Some("https://example.com"), "https://os.example.org/os"),
            (Some("https://os.example.org.evil.com"), "https://os.example.org.evil.com/"),
            (Some("http://os.example.org"), "http://os.example.org/os"),
            (Some("tauri://localhost"), "tauri://localhost/fehler.html"),
            (Some("about:srcdoc"), "about:srcdoc"),
            (Some("https://os.example.org"), "about:srcdoc"),
        ] {
            assert!(absender_pruefen(o, &u(s), START, &erlaubt()).is_err(), "{o:?} {s}");
        }
    }

    #[test]
    fn testserver_auf_dem_eigenen_rechner_geht_nur_mit_passender_start_adresse() {
        let start = "http://127.0.0.1:18661/os";
        let erl = navigation::erlaubte_hosts(Profil::Os, start, &["localhost".into()]);
        assert!(absender_pruefen(Some("http://127.0.0.1:18661"), &u("http://127.0.0.1:18661/os"), start, &erl).is_ok());
        // der „Anmeldeserver“ des Testservers (localhost) ist nicht der Server
        assert!(absender_pruefen(Some("http://localhost:18661"), &u("http://localhost:18661/auth/login"), start, &erl).is_err());
    }

    #[test]
    fn takt_begrenzt_und_holt_die_zahl_nach() {
        let t0 = Instant::now();
        let mut t = Takt::default();
        for i in 0..JE_MINUTE {
            assert_eq!(t.pruefen(t0 + Duration::from_secs(i as u64)), Zulassung::Zeigen { nachgeholt: 0 });
        }
        assert_eq!(t.pruefen(t0 + Duration::from_secs(10)), Zulassung::Verwerfen);
        assert_eq!(t.pruefen(t0 + Duration::from_secs(20)), Zulassung::Verwerfen);
        // nach 60 s ab der ersten wieder frei, mit Zählung der verworfenen
        assert_eq!(t.pruefen(t0 + Duration::from_secs(61)), Zulassung::Zeigen { nachgeholt: 2 });
        assert_eq!(t.pruefen(t0 + Duration::from_secs(62)), Zulassung::Zeigen { nachgeholt: 0 });
    }

    #[test]
    fn zusammenfassung_bleibt_im_rahmen() {
        assert_eq!(mit_zusammenfassung("Hallo", 0), "Hallo");
        let z = mit_zusammenfassung("Hallo", 3);
        assert!(z.starts_with("Hallo") && z.contains("+3 weitere"));
        assert!(mit_zusammenfassung(&"x".repeat(240), 99).chars().count() <= TEXT_MAX);
        assert_eq!(mit_zusammenfassung("", 2), "+2 weitere Meldungen in FYOS OS");
    }
}
