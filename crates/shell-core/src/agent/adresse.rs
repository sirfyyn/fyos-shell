//! Runner-Adresse: aus Eingaben wie `rechner:18438` oder `runner.example.org/agent` wird eine Basis-URL.
//!
//! Regel für das Token: es geht bei jeder Anfrage im Kopf `Authorization` mit. Deshalb ist `http` nur zum eigenen Rechner und im Heimnetz erlaubt
//! (Loopback, private Adressbereiche, `.local`, Namen ohne Punkt); jede öffentliche Adresse braucht `https` (`RUNNER_ADRESSE_UNSICHER`).

use crate::fehler::Fehler;
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Adresse {
    /// Ohne Schrägstrich am Ende, ohne Query, Fragment und Zugangsdaten; ein Pfad (`/agent`) bleibt.
    pub basis: String,
    pub host: String,
    /// `http` außerhalb von Loopback: das Token läuft unverschlüsselt durchs (Heim-)Netz. Erlaubt, aber die Oberfläche warnt.
    pub unsicher: bool,
}

/// Der Rechnername in einer Eingabe mit oder ohne Schema.
pub fn host_aus(roh: &str) -> String {
    let mut t = roh.trim();
    if let Some(i) = t.find("://") {
        t = &t[i + 3..];
    }
    let t = t.split(['/', '?', '#']).next().unwrap_or("");
    let t = match t.rfind('@') {
        Some(i) => &t[i + 1..],
        None => t,
    };
    if let Some(rest) = t.strip_prefix('[') {
        return match rest.find(']') {
            Some(i) => rest[..i].to_lowercase(),
            None => rest.to_lowercase(),
        };
    }
    let ohne_port = match t.rfind(':') {
        Some(i) if t[i + 1..].chars().all(|c| c.is_ascii_digit()) => &t[..i],
        _ => t,
    };
    ohne_port.to_lowercase()
}

pub fn ist_loopback(host: &str) -> bool {
    host == "localhost" || host == "::1" || host.starts_with("127.") || host.ends_with(".localhost")
}

fn privates_v4(host: &str) -> bool {
    let teile: Vec<&str> = host.split('.').collect();
    if teile.len() != 4 {
        return false;
    }
    let z: Vec<u8> = teile.iter().filter_map(|t| t.parse().ok()).collect();
    if z.len() != 4 {
        return false;
    }
    z[0] == 10 || (z[0] == 192 && z[1] == 168) || (z[0] == 172 && (16..=31).contains(&z[1])) || (z[0] == 169 && z[1] == 254)
}

/// Rechner im eigenen Netz: Loopback, privates IPv4, `.local`, ein Name ohne Punkt (oder die Endung `.lan`).
pub fn ist_heimnetz(host: &str) -> bool {
    ist_loopback(host) || privates_v4(host) || host.ends_with(".local") || host.ends_with(".lan") || (!host.contains('.') && !host.contains(':'))
}

pub fn normalisiere(roh: &str) -> Result<Adresse, Fehler> {
    let unbrauchbar = |grund: &str| Fehler::RunnerAdresseUnbrauchbar { eingabe: roh.trim().chars().take(120).collect(), grund: grund.to_string() };
    let t = roh.trim();
    if t.is_empty() {
        return Err(Fehler::RunnerNichtEingerichtet);
    }
    if t.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(unbrauchbar("Leerzeichen oder Steuerzeichen in der Adresse"));
    }
    let mit = if t.contains("://") {
        t.to_string()
    } else {
        let schema = if ist_heimnetz(&host_aus(t)) { "http" } else { "https" };
        format!("{schema}://{t}")
    };
    let mut u = Url::parse(&mit).map_err(|_| unbrauchbar("die Adresse ist nicht lesbar"))?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err(unbrauchbar("nur http oder https"));
    }
    let host = match u.host_str() {
        Some(h) if !h.is_empty() => h.trim_matches(|c| c == '[' || c == ']').to_lowercase(),
        _ => return Err(unbrauchbar("der Rechnername fehlt")),
    };
    u.set_query(None);
    u.set_fragment(None);
    let _ = u.set_username("");
    let _ = u.set_password(None);
    let basis = u.as_str().trim_end_matches('/').to_string();
    if u.scheme() == "http" && !ist_heimnetz(&host) {
        return Err(Fehler::RunnerAdresseUnsicher { host });
    }
    let unsicher = u.scheme() == "http" && !ist_loopback(&host);
    Ok(Adresse { basis, host, unsicher })
}

/// `basis` + Weg (`/api/health`).
pub fn api_url(basis: &str, weg: &str) -> String {
    format!("{}{}", basis.trim_end_matches('/'), weg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn privat(a: u8, b: u8, c: u8, d: u8) -> String {
        format!("{a}.{b}.{c}.{d}")
    }

    #[test]
    fn schema_wird_nach_netz_geraten() {
        let a = normalisiere("127.0.0.1:18461").unwrap();
        assert_eq!(a.basis, "http://127.0.0.1:18461");
        assert!(!a.unsicher);
        assert_eq!(normalisiere("runner.example.org").unwrap().basis, "https://runner.example.org");
        let lan = privat(192, 168, 1, 20);
        assert_eq!(normalisiere(&format!("{lan}:18438")).unwrap().basis, format!("http://{lan}:18438"));
        assert_eq!(normalisiere("rechner:18438").unwrap().basis, "http://rechner:18438");
        assert_eq!(normalisiere("localhost:1234").unwrap().basis, "http://localhost:1234");
    }

    #[test]
    fn pfad_bleibt_zugangsdaten_query_fragment_fallen_weg() {
        let a = normalisiere("https://u:p@runner.example.org/agent/?token=geheimwert#x").unwrap();
        assert_eq!(a.basis, "https://runner.example.org/agent");
        assert_eq!(a.host, "runner.example.org");
        assert!(!a.basis.contains("geheimwert") && !a.basis.contains("u:p"));
    }

    #[test]
    fn http_nur_im_eigenen_netz_sonst_katalogfehler() {
        assert_eq!(normalisiere("http://runner.example.org").unwrap_err().code(), "RUNNER_ADRESSE_UNSICHER");
        assert_eq!(normalisiere("http://203.0.113.9:80").unwrap_err().code(), "RUNNER_ADRESSE_UNSICHER");
        assert!(normalisiere("http://172.32.0.1").is_err(), "172.32 ist nicht privat");
        assert!(normalisiere(&format!("http://{}", privat(172, 20, 1, 1))).is_ok());
        assert!(normalisiere("http://rechner.local:1").is_ok());
        assert!(normalisiere("https://runner.example.org").is_ok());
    }

    #[test]
    fn unsicher_heisst_http_ausserhalb_von_loopback() {
        assert!(normalisiere(&format!("http://{}:1", privat(192, 168, 0, 7))).unwrap().unsicher);
        assert!(!normalisiere("http://localhost:1").unwrap().unsicher);
        assert!(!normalisiere("http://[::1]:1").unwrap().unsicher);
        assert!(!normalisiere("https://runner.example.org").unwrap().unsicher);
    }

    #[test]
    fn fehler_haben_katalogcodes() {
        assert_eq!(normalisiere("").unwrap_err().code(), "RUNNER_NICHT_EINGERICHTET");
        assert_eq!(normalisiere("   ").unwrap_err().code(), "RUNNER_NICHT_EINGERICHTET");
        for schlecht in ["ftp://x.example.org", "http://", "a b", "file:///etc/passwd", "javascript:alert(1)"] {
            assert_eq!(normalisiere(schlecht).unwrap_err().code(), "RUNNER_ADRESSE_UNBRAUCHBAR", "{schlecht}");
        }
    }

    #[test]
    fn host_und_netzarten() {
        assert_eq!(host_aus("https://User@Rechner.Example.org:8443/agent?x=1"), "rechner.example.org");
        assert_eq!(host_aus("[::1]:8080"), "::1");
        assert!(ist_heimnetz(&privat(172, 20, 1, 1)));
        assert!(!ist_heimnetz(&privat(172, 32, 0, 1)));
        assert!(!ist_heimnetz("runner.example.org"));
        assert!(ist_heimnetz("rechner.local"));
    }

    #[test]
    fn urls_zusammensetzen() {
        assert_eq!(api_url("http://127.0.0.1:1/", "/api/health"), "http://127.0.0.1:1/api/health");
        assert_eq!(api_url("https://x.example.org/agent", "/api/freigaben"), "https://x.example.org/agent/api/freigaben");
    }
}
