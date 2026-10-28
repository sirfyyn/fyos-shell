//! „Bericht speichern“: ein Fehlerbericht als Textdatei zum Weitergeben (Support, Fehlersuche), **ohne Geheimnisse**.
//!
//! Er enthält Version, System, Profil, Zeit, das Ergebnis des letzten Updates, die Meldungen (Code, Ursache, Abhilfe, Einzelheiten), den Stand
//! des Begleiters, die Einstellungen (Werte geschwärzt) und die letzten Zeilen des Begleiter-Protokolls (geschwärzt). Er wird nur auf die
//! Platte geschrieben, **nie hochgeladen**; der Nutzer entscheidet, wem er die Datei zeigt. Alles läuft durch [`schwaerzen`].

use crate::einstellungen::Einstellungen;
use crate::fehler::{Fehler, Meldung};
use crate::speicher::atomar_schreiben;
use regex::Regex;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

const GESCHWAERZT: &str = "<geschwärzt>";
const LOG_ZEILEN: usize = 80;

struct Regeln {
    zugangsdaten_in_url: Regex,
    bearer: Regex,
    name_wert: Regex,
    bekannte_praefixe: Regex,
    langes_hex: Regex,
    heimordner: Regex,
}

fn regeln() -> &'static Regeln {
    static R: OnceLock<Regeln> = OnceLock::new();
    R.get_or_init(|| Regeln {
        // scheme://nutzer:passwort@host
        zugangsdaten_in_url: Regex::new(r"(?i)([a-z][a-z0-9+.-]*://[^\s/:@]+:)[^\s/@]+@").unwrap(),
        bearer: Regex::new(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}").unwrap(),
        // token=..., "password": "...", passwort: ..., api-key=..., secret = '...'
        name_wert: Regex::new(r#"(?i)((?:token|passwort|password|secret|geheim|api[_-]?key|private[_-]?key|credential|kennung)[A-Za-z0-9_-]*["']?\s*[:=]\s*)(["']?)([^\s"',;}]+)"#).unwrap(),
        bekannte_praefixe: Regex::new(r"\b(ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|glpat-[A-Za-z0-9_-]{10,}|hf_[A-Za-z0-9]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{12,})").unwrap(),
        langes_hex: Regex::new(r"\b[0-9a-fA-F]{32,}\b").unwrap(),
        heimordner: Regex::new(r"(/Users/|/home/|[A-Za-z]:\\Users\\)[^/\\\s]+").unwrap(),
    })
}

/// Entfernt Geheimnisse und persönliche Pfade aus einem Text: Zugangsdaten in Adressen, `Bearer`-Köpfe, Werte hinter Namen wie `token=`/`password:`,
/// bekannte Token-Formen (GitHub, GitLab, Hugging Face, Slack, AWS, `sk-…`), lange Hexketten (Kennungen, Schlüssel) und `/Users/<name>`.
pub fn schwaerzen(text: &str) -> String {
    let r = regeln();
    let t = r.zugangsdaten_in_url.replace_all(text, format!("${{1}}{GESCHWAERZT}@").as_str());
    let t = r.bearer.replace_all(&t, format!("${{1}} {GESCHWAERZT}").as_str());
    // Verweise auf den Tresor ({tresor:NAME}) sind keine Geheimnisse und bleiben lesbar
    let t = r.name_wert.replace_all(&t, |c: &regex::Captures| {
        if c[3].starts_with("{tresor:") {
            c[0].to_string()
        } else {
            format!("{}{}{GESCHWAERZT}", &c[1], &c[2])
        }
    });
    let t = r.bekannte_praefixe.replace_all(&t, GESCHWAERZT);
    let t = r.langes_hex.replace_all(&t, GESCHWAERZT);
    r.heimordner.replace_all(&t, "${1}~").into_owned()
}

/// Alles, was in den Bericht kommt (vom Aufrufer gesammelt).
pub struct Bericht {
    pub profil: String,
    pub produkt: String,
    pub version: String,
    pub vorherige: Option<String>,
    pub os: String,
    pub arch: String,
    pub datenordner: String,
    pub zeit_unix: u64,
    pub ausgang: Option<String>,
    pub meldungen: Vec<Meldung>,
    pub begleiter: String,
    pub einstellungen: Einstellungen,
    pub log: String,
}

fn zivil(tage: i64) -> (i64, u32, u32) {
    // Tage seit 1970-01-01 → (Jahr, Monat, Tag), Algorithmus von Howard Hinnant (days_from_civil, umgekehrt)
    let z = tage + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `2026-10-28 14:03:09 UTC` aus Unix-Sekunden.
pub fn zeit_text(unix: u64) -> String {
    let (j, m, t) = zivil((unix / 86_400) as i64);
    let s = unix % 86_400;
    format!("{j:04}-{m:02}-{t:02} {:02}:{:02}:{:02} UTC", s / 3600, (s % 3600) / 60, s % 60)
}

pub fn jetzt() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Dateiname: `fyos-bericht-<profil>-<version>-<JJJJMMTT-HHMMSS>.txt`
pub fn dateiname(profil: &str, version: &str, unix: u64) -> String {
    let (j, m, t) = zivil((unix / 86_400) as i64);
    let s = unix % 86_400;
    let sauber = |x: &str| x.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' }).collect::<String>();
    format!("fyos-bericht-{}-{}-{j:04}{m:02}{t:02}-{:02}{:02}{:02}.txt", sauber(profil), sauber(version), s / 3600, (s % 3600) / 60, s % 60)
}

/// Die Einstellungen für den Bericht: Werte geschwärzt, Umgebungswerte des Begleiters nur als Name (Verweise `{tresor:…}` bleiben sichtbar).
fn einstellungen_text(e: &Einstellungen) -> String {
    let mut e = e.clone();
    if let Some(b) = e.begleiter.as_mut() {
        for w in b.env.values_mut() {
            if !crate::tresor::hat_verweis(w) {
                *w = "<gesetzt>".into();
            }
        }
    }
    let json = serde_json::to_string_pretty(&e).unwrap_or_else(|_| "(nicht darstellbar)".into());
    schwaerzen(&json)
}

fn letzte_zeilen(text: &str, n: usize) -> String {
    let zeilen: Vec<&str> = text.lines().collect();
    zeilen[zeilen.len().saturating_sub(n)..].join("\n")
}

impl Bericht {
    pub fn text(&self) -> String {
        let mut t = String::new();
        t.push_str(&format!("Fehlerbericht {}\n", self.produkt));
        t.push_str("==============================\n");
        t.push_str("Diese Datei enthält keine Passwörter oder Zugangsschlüssel (sie werden geschwärzt) und wurde nirgends hochgeladen.\n");
        t.push_str("Lies sie vor dem Weitergeben durch.\n\n");
        t.push_str(&format!("Zeit:      {}\n", zeit_text(self.zeit_unix)));
        t.push_str(&format!("Profil:    {}\n", self.profil));
        t.push_str(&format!("Version:   {}", self.version));
        match &self.vorherige {
            Some(v) => t.push_str(&format!(" (Vorversion {v})\n")),
            None => t.push('\n'),
        }
        t.push_str(&format!("System:    {} {}\n", self.os, self.arch));
        t.push_str(&format!("Daten:     {}\n", schwaerzen(&self.datenordner)));
        if let Some(a) = &self.ausgang {
            t.push_str(&format!("Letztes Update: {}\n", schwaerzen(a)));
        }
        t.push_str(&format!("Begleiter: {}\n\n", schwaerzen(&self.begleiter)));
        t.push_str("Meldungen\n---------\n");
        if self.meldungen.is_empty() {
            t.push_str("(keine)\n");
        }
        for m in &self.meldungen {
            t.push_str(&format!("[{}]\n  Ursache: {}\n  Abhilfe: {}\n", m.code, schwaerzen(&m.ursache), schwaerzen(&m.abhilfe)));
            if let Some(d) = &m.details {
                t.push_str(&format!("  Einzelheiten: {}\n", schwaerzen(d)));
            }
        }
        t.push_str("\nEinstellungen (Werte geschwärzt)\n--------------------------------\n");
        t.push_str(&einstellungen_text(&self.einstellungen));
        t.push_str(&format!("\n\nBegleiter-Protokoll (letzte {LOG_ZEILEN} Zeilen, geschwärzt)\n-----------------------------------------------------\n"));
        let log = letzte_zeilen(&self.log, LOG_ZEILEN);
        if log.trim().is_empty() {
            t.push_str("(leer)");
        } else {
            t.push_str(&schwaerzen(&log));
        }
        t.push('\n');
        t
    }
}

/// Schreibt den Bericht in `ordner` (wird bei Bedarf angelegt) und gibt den Pfad zurück.
pub fn speichern(ordner: &Path, b: &Bericht) -> Result<PathBuf, Fehler> {
    let ziel = ordner.join(dateiname(&b.profil, &b.version, b.zeit_unix));
    atomar_schreiben(&ziel, b.text().as_bytes())?;
    Ok(ziel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::begleiter::BegleiterKonfig;

    fn probe() -> Bericht {
        let mut e = Einstellungen::default();
        e.update_basis = Some("https://nutzer:topgeheim@updates.example/studio/".into());
        let mut k = BegleiterKonfig::default();
        k.programm = "/Users/anna/studio/bin/fle-studio".into();
        k.env.insert("HF_TOKEN".into(), "{tresor:hf-token}".into());
        k.env.insert("ANDERES".into(), "klartext-wert".into());
        e.begleiter = Some(k);
        Bericht {
            profil: "studio".into(),
            produkt: "FLE Studio".into(),
            version: "0.0.2".into(),
            vorherige: Some("0.0.1".into()),
            os: "macos".into(),
            arch: "aarch64".into(),
            datenordner: "/Users/anna/Library/Application Support/de.sirfyyn.fle-studio".into(),
            zeit_unix: 1_793_190_189,
            ausgang: Some("Aktualisiert von Version 0.0.1 auf 0.0.2.".into()),
            meldungen: vec![Fehler::SignaturFalsch.meldung(), Fehler::ManifestFehlt { url: "http://127.0.0.1:1/latest.json".into() }.meldung()],
            begleiter: "läuft".into(),
            einstellungen: e,
            log: "start\nAuthorization: Bearer abcdefghijklmnop1234\nHF_TOKEN=hf_AbCdEfGhIjKlMn123\nfertig".into(),
        }
    }

    #[test]
    fn zeit_und_dateiname() {
        assert_eq!(zeit_text(0), "1970-01-01 00:00:00 UTC");
        assert_eq!(zeit_text(951_782_400 + 86_399), "2000-02-29 23:59:59 UTC", "Schaltjahr");
        assert_eq!(zeit_text(1_793_190_189), "2026-10-28 12:23:09 UTC");
        assert_eq!(dateiname("studio", "0.0.2", 1_793_190_189), "fyos-bericht-studio-0.0.2-20261028-122309.txt");
        assert_eq!(dateiname("a/b", "1 2", 0), "fyos-bericht-a_b-1_2-19700101-000000.txt");
    }

    #[test]
    fn schwaerzen_entfernt_geheimnisse() {
        let faelle = [
            ("https://nutzer:topgeheim@host/x", "topgeheim"),
            ("Authorization: Bearer abcdefghijklmnop1234", "abcdefghijklmnop1234"),
            ("token=abc12345678", "abc12345678"),
            ("{\"password\": \"hunter2hunter2\"}", "hunter2hunter2"),
            ("passwort: sehrgeheim", "sehrgeheim"),
            ("ghp_abcdefghijklmnopqrstuv", "ghp_abcdefghijklmnopqrstuv"),
            ("hf_AbCdEfGhIjKlMn123", "hf_AbCdEfGhIjKlMn123"),
            ("kennung 0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef"),
            ("AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP"),
        ];
        for (roh, geheim) in faelle {
            let s = schwaerzen(roh);
            assert!(!s.contains(geheim), "{roh} -> {s}");
            assert!(s.contains("<geschwärzt>"), "{roh} -> {s}");
        }
        assert_eq!(schwaerzen("/Users/maxm/fyos und /home/anna/x und C:\\Users\\Bob\\y"), "/Users/~/fyos und /home/~/x und C:\\Users\\~\\y");
        assert_eq!(schwaerzen("harmloser Text mit 12345 und http://127.0.0.1:8642/"), "harmloser Text mit 12345 und http://127.0.0.1:8642/");
    }

    #[test]
    fn bericht_enthaelt_was_gebraucht_wird_und_keine_geheimnisse() {
        let t = probe().text();
        for noetig in ["FLE Studio", "0.0.2", "Vorversion 0.0.1", "macos aarch64", "UPDATE_SIGNATUR_FALSCH", "Ursache:", "Abhilfe:", "UPDATE_MANIFEST_FEHLT",
                       "Aktualisiert von Version 0.0.1", "2026-10-28 12:23:09 UTC", "{tresor:hf-token}"] {
            assert!(t.contains(noetig), "fehlt: {noetig}\n{t}");
        }
        for geheim in ["topgeheim", "klartext-wert", "hf_AbCdEfGhIjKlMn123", "abcdefghijklmnop1234", "/Users/anna"] {
            assert!(!t.contains(geheim), "Geheimnis im Bericht: {geheim}\n{t}");
        }
    }

    #[test]
    fn log_wird_auf_die_letzten_zeilen_gekuerzt() {
        let mut b = probe();
        b.log = (1..=500).map(|i| format!("zeile {i}")).collect::<Vec<_>>().join("\n");
        let t = b.text();
        assert!(t.contains("zeile 500") && t.contains("zeile 421") && !t.contains("zeile 420"));
    }

    #[test]
    fn speichern_legt_ordner_und_datei_an() {
        let d = tempfile::tempdir().unwrap();
        let pfad = speichern(&d.path().join("berichte"), &probe()).unwrap();
        assert!(pfad.ends_with("fyos-bericht-studio-0.0.2-20261028-122309.txt"));
        assert!(std::fs::read_to_string(&pfad).unwrap().starts_with("Fehlerbericht FLE Studio"));
    }
}
