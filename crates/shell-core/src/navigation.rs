//! Navigationssperre des Inhaltsfensters: nur die Hosts des Profils (plus die gewählte Start-URL und eigene Einträge in den Einstellungen)
//! dürfen im Fenster geladen werden; alles andere geht in den Standardbrowser oder wird abgelehnt.
//!
//! Hintergrund: Das Inhaltsfenster zeigt fremden Code (die Seite des Servers). Ein Link, ein Redirect oder `window.open` darf es nicht auf eine
//! beliebige Seite bringen, auf der dann das Anmelde-Cookie des Profils und der Zugriff auf `window.__TAURI__` liegen würden.
//! Reine Funktionen, keine Plattformaufrufe; das Öffnen im Browser baut nur den Befehl (`browser_befehl`), der Aufrufer startet ihn.

use crate::profil::Profil;
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entscheidung {
    /// Im Inhaltsfenster laden.
    Erlauben,
    /// Nicht im Fenster, sondern im Standardbrowser des Systems öffnen.
    Browser,
    /// Gar nicht öffnen (`javascript:`, `file:`, unbekannte Schemata).
    Ablehnen,
}

/// Hosts, die ein Profil ohne weitere Einstellung laden darf. OS: der Server und Anmeldeserver (Anmeldung). Studio und Agent: nur der eigene Rechner.
pub fn standard_hosts(profil: Profil) -> Vec<String> {
    match profil {
        Profil::Os => vec!["fyos.sirfyyn.de".into(), "auth.sirfyyn.de".into()],
        Profil::Studio | Profil::Agent => vec!["127.0.0.1".into(), "localhost".into(), "::1".into()],
    }
}

fn host_von(url: &Url) -> Option<String> {
    let h = url.host_str()?.trim_matches(|c| c == '[' || c == ']').trim_end_matches('.').to_ascii_lowercase();
    (!h.is_empty()).then_some(h)
}

/// Die Liste, gegen die geprüft wird: Standard des Profils + Host der gewählten Start-URL + Einträge aus den Einstellungen
/// (`erlaubte_hosts`; `*.beispiel.de` erlaubt alle Unterdomänen, aber nicht `beispiel.de` selbst).
pub fn erlaubte_hosts(profil: Profil, start_url: &str, eigene: &[String]) -> Vec<String> {
    let mut hosts = standard_hosts(profil);
    if let Some(h) = Url::parse(start_url).ok().and_then(|u| host_von(&u)) {
        hosts.push(h);
    }
    hosts.extend(eigene.iter().map(|h| h.trim().trim_end_matches('.').to_ascii_lowercase()).filter(|h| !h.is_empty()));
    hosts.sort();
    hosts.dedup();
    hosts
}

fn passt(host: &str, eintrag: &str) -> bool {
    match eintrag.strip_prefix("*.") {
        Some(rest) => host.len() > rest.len() + 1 && host.ends_with(rest) && host.as_bytes()[host.len() - rest.len() - 1] == b'.',
        None => host == eintrag,
    }
}

fn ist_lokal(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

/// Entscheidet über eine Navigation. Eigene Seiten der Hülle (`tauri://`, `http(s)://tauri.localhost` unter Windows, `about:blank`) gehen immer.
/// `https` nur zu erlaubten Hosts; `http` nur zu erlaubten Hosts auf dem eigenen Rechner (Studio, Agent, Tests), sonst Browser.
pub fn pruefe(url: &Url, erlaubt: &[String]) -> Entscheidung {
    match url.scheme() {
        "tauri" | "asset" | "ipc" => return Entscheidung::Erlauben,
        "about" => return if url.as_str() == "about:blank" { Entscheidung::Erlauben } else { Entscheidung::Ablehnen },
        "mailto" => return Entscheidung::Browser,
        "http" | "https" => {}
        _ => return Entscheidung::Ablehnen,
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Entscheidung::Browser; // Zugangsdaten in der Adresse sind nie ein Ziel für das Fenster
    }
    let Some(host) = host_von(url) else { return Entscheidung::Ablehnen };
    if host == "tauri.localhost" {
        return Entscheidung::Erlauben; // eigene Seiten unter Windows und Android
    }
    let gelistet = erlaubt.iter().any(|e| passt(&host, e));
    match (url.scheme(), gelistet) {
        ("https", true) => Entscheidung::Erlauben,
        ("http", true) if ist_lokal(&host) => Entscheidung::Erlauben,
        _ => Entscheidung::Browser,
    }
}

/// Programm und Argumente, um `url` im Standardbrowser zu öffnen. Nur `http`, `https`, `mailto`; sonst `None`.
/// Windows: `rundll32 url.dll,FileProtocolHandler` statt `cmd /c start` (keine Shell, keine Sonderzeichen-Auslegung).
pub fn browser_befehl(system: &str, url: &Url) -> Option<(String, Vec<String>)> {
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        return None;
    }
    let adresse = url.as_str().to_string();
    Some(match system {
        "macos" => ("open".into(), vec![adresse]),
        "windows" => ("rundll32".into(), vec!["url.dll,FileProtocolHandler".into(), adresse]),
        _ => ("xdg-open".into(), vec![adresse]),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }
    fn os() -> Vec<String> {
        erlaubte_hosts(Profil::Os, "https://fyos.sirfyyn.de/os", &[])
    }

    #[test]
    fn os_erlaubt_server_und_authentik() {
        for ok in ["https://fyos.sirfyyn.de/os", "https://fyos.sirfyyn.de/", "https://auth.sirfyyn.de/if/flow/default-authentication-flow/?next=%2Fos", "https://FYOS.sirfyyn.de./x"] {
            assert_eq!(pruefe(&u(ok), &os()), Entscheidung::Erlauben, "{ok}");
        }
    }

    #[test]
    fn fremdes_geht_in_den_browser() {
        for fremd in ["https://example.com/", "https://sirfyyn.de/", "https://evil.sirfyyn.de.example.com/", "https://fyos.sirfyyn.de.evil.com/", "https://xfyos.sirfyyn.de/", "http://fyos.sirfyyn.de/os"] {
            assert_eq!(pruefe(&u(fremd), &os()), Entscheidung::Browser, "{fremd}");
        }
    }

    #[test]
    fn zugangsdaten_in_der_adresse_taeuschen_nicht() {
        // Der Host ist hier evil.com, nicht fyos.sirfyyn.de
        assert_eq!(pruefe(&u("https://fyos.sirfyyn.de@evil.com/"), &os()), Entscheidung::Browser);
        assert_eq!(pruefe(&u("https://nutzer:pw@fyos.sirfyyn.de/"), &os()), Entscheidung::Browser);
    }

    #[test]
    fn gefaehrliche_schemata_werden_abgelehnt() {
        for s in ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<b>x</b>", "ftp://fyos.sirfyyn.de/", "blob:https://fyos.sirfyyn.de/abc", "about:srcdoc"] {
            assert_eq!(pruefe(&u(s), &os()), Entscheidung::Ablehnen, "{s}");
        }
        assert_eq!(pruefe(&u("mailto:x@example.com"), &os()), Entscheidung::Browser);
    }

    #[test]
    fn eigene_seiten_der_huelle_gehen_immer() {
        for s in ["tauri://localhost/fehler.html", "http://tauri.localhost/fehler.html", "https://tauri.localhost/x", "about:blank"] {
            assert_eq!(pruefe(&u(s), &os()), Entscheidung::Erlauben, "{s}");
        }
    }

    #[test]
    fn studio_und_agent_nur_eigener_rechner_und_nur_ueber_http_oder_https() {
        let s = erlaubte_hosts(Profil::Studio, "http://127.0.0.1:18642/", &[]);
        assert_eq!(pruefe(&u("http://127.0.0.1:18642/api/state"), &s), Entscheidung::Erlauben);
        assert_eq!(pruefe(&u("http://localhost:8642/"), &s), Entscheidung::Erlauben);
        assert_eq!(pruefe(&u("http://[::1]:8642/"), &s), Entscheidung::Erlauben);
        assert_eq!(pruefe(&u("https://example.com/"), &s), Entscheidung::Browser);
        assert_eq!(pruefe(&u("http://198.51.100.5:8642/"), &s), Entscheidung::Browser);
    }

    #[test]
    fn die_gewaehlte_start_url_und_eigene_eintraege_gelten_mit() {
        let h = erlaubte_hosts(Profil::Os, "https://test.fyos.example/os", &["*.intern.example".into(), " Auth2.Example. ".into()]);
        assert_eq!(pruefe(&u("https://test.fyos.example/x"), &h), Entscheidung::Erlauben);
        assert_eq!(pruefe(&u("https://a.intern.example/"), &h), Entscheidung::Erlauben);
        assert_eq!(pruefe(&u("https://intern.example/"), &h), Entscheidung::Browser, "*. erlaubt nur Unterdomänen");
        assert_eq!(pruefe(&u("https://xintern.example/"), &h), Entscheidung::Browser);
        assert_eq!(pruefe(&u("https://auth2.example/"), &h), Entscheidung::Erlauben);
        // http zu einem Fremdhost bleibt auch bei Eintrag verboten (kein Klartext im Fenster)
        let k = erlaubte_hosts(Profil::Os, "https://fyos.sirfyyn.de/os", &["klartext.example".into()]);
        assert_eq!(pruefe(&u("http://klartext.example/"), &k), Entscheidung::Browser);
    }

    #[test]
    fn liste_ist_sortiert_und_ohne_doppelte() {
        let h = erlaubte_hosts(Profil::Os, "https://fyos.sirfyyn.de/os", &["fyos.sirfyyn.de".into()]);
        assert_eq!(h, ["auth.sirfyyn.de", "fyos.sirfyyn.de"]);
    }

    #[test]
    fn browser_befehl_je_system_und_nur_fuer_web_adressen() {
        let (p, a) = browser_befehl("macos", &u("https://example.com/a b")).unwrap();
        assert_eq!((p.as_str(), a), ("open", vec!["https://example.com/a%20b".to_string()]));
        let (p, a) = browser_befehl("windows", &u("https://example.com/?a=1&b=2")).unwrap();
        assert_eq!(p, "rundll32");
        assert_eq!(a[0], "url.dll,FileProtocolHandler");
        assert_eq!(browser_befehl("linux", &u("mailto:x@example.com")).unwrap().0, "xdg-open");
        assert!(browser_befehl("macos", &u("file:///etc/passwd")).is_none());
        assert!(browser_befehl("macos", &u("javascript:alert(1)")).is_none());
    }
}
