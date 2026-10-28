//! Erreichbarkeit des Servers (Profil OS): aus dem Ergebnis eines Probe-Aufrufs wird ein Katalogfehler, und eine Rücknahme-Folge bestimmt,
//! wann die Anwendung es erneut versucht. Reine Funktionen; der Aufruf selbst (HTTP) liegt in der Anwendung.

use crate::fehler::Fehler;
use std::time::Duration;
use url::Url;

fn host_text(url: &str) -> String {
    Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_else(|| url.to_string())
}

/// Fehler einer Verbindung, die gar keine Antwort gebracht hat. `art` ist der Name der Fehlerart des HTTP-Clients (z. B. `Dns`,
/// `ConnectionFailed`, `Io`), `text` seine Meldung.
pub fn aus_verbindungsfehler(url: &str, art: &str, text: &str) -> Fehler {
    let t = text.to_ascii_lowercase();
    let host = host_text(url);
    let zertifikat = ["certificate", "unknownissuer", "notvalidforname", "certexpired", "certnotvalidyet", "invalid peer", "badsignature", "tls handshake", "unsupportedcertversion"];
    if zertifikat.iter().any(|z| t.contains(z)) {
        return Fehler::ZertifikatFehler { host, grund: text.to_string() };
    }
    if art == "Dns" || t.contains("dns") || t.contains("failed to lookup") || t.contains("nodename nor servname") || t.contains("name or service not known") || t.contains("no such host") {
        return Fehler::DnsFehler { host };
    }
    Fehler::ServerNichtErreichbar { url: url.to_string(), grund: text.to_string() }
}

/// Fehler aus einer Antwort. `endgueltige_url` ist die Adresse nach allen Weiterleitungen: liegt sie auf einem Anmeldeserver (`anmelde_hosts`),
/// ist es dessen Fehler. 401 und 403 sind kein Fehler der Verbindung (die Seite verlangt eine Anmeldung), alles unter 400 ist gut.
pub fn aus_status(status: u16, endgueltige_url: &str, anmelde_hosts: &[String]) -> Option<Fehler> {
    if status < 400 || status == 401 || status == 403 {
        return None;
    }
    let host = host_text(endgueltige_url).to_ascii_lowercase();
    if anmelde_hosts.iter().any(|h| h.eq_ignore_ascii_case(&host)) {
        return Some(Fehler::AnmeldeserverFehler { status, url: endgueltige_url.to_string() });
    }
    Some(Fehler::ServerFehler { status, url: endgueltige_url.to_string() })
}

/// Wartezeit vor dem n-ten Wiederholen (n ab 0): 5, 10, 20, 40 s, danach alle 60 s. Kein Dauerfeuer bei langem Ausfall.
pub fn wartezeit(versuch: u32) -> Duration {
    Duration::from_secs(match versuch {
        0 => 5,
        1 => 10,
        2 => 20,
        3 => 40,
        _ => 60,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbindungsfehler_werden_eingeordnet() {
        let u = "https://fyos.sirfyyn.de/os";
        assert_eq!(aus_verbindungsfehler(u, "Dns", "failed to lookup address information: nodename nor servname provided").code(), "DNS_FEHLER");
        assert_eq!(aus_verbindungsfehler(u, "ConnectionFailed", "Connection Failed: tls connection init failed: invalid peer certificate: UnknownIssuer").code(), "ZERTIFIKAT_FEHLER");
        assert_eq!(aus_verbindungsfehler(u, "Io", "invalid peer certificate: Expired").code(), "ZERTIFIKAT_FEHLER");
        assert_eq!(aus_verbindungsfehler(u, "Io", "invalid peer certificate: NotValidForName").code(), "ZERTIFIKAT_FEHLER");
        assert_eq!(aus_verbindungsfehler(u, "ConnectionFailed", "Connection refused (os error 61)").code(), "SERVER_NICHT_ERREICHBAR");
        assert_eq!(aus_verbindungsfehler(u, "Io", "timed out reading response").code(), "SERVER_NICHT_ERREICHBAR");
        let Fehler::DnsFehler { host } = aus_verbindungsfehler(u, "Dns", "x") else { panic!() };
        assert_eq!(host, "fyos.sirfyyn.de");
    }

    #[test]
    fn statuscodes() {
        let auth = vec!["auth.sirfyyn.de".to_string()];
        assert!(aus_status(200, "https://fyos.sirfyyn.de/os", &auth).is_none());
        assert!(aus_status(302, "https://fyos.sirfyyn.de/os", &auth).is_none());
        assert!(aus_status(401, "https://fyos.sirfyyn.de/os", &auth).is_none(), "Anmeldung nötig ist kein Ausfall");
        assert!(aus_status(403, "https://fyos.sirfyyn.de/os", &auth).is_none());
        assert_eq!(aus_status(502, "https://fyos.sirfyyn.de/os", &auth).unwrap().code(), "SERVER_FEHLER");
        assert_eq!(aus_status(404, "https://fyos.sirfyyn.de/os", &auth).unwrap().code(), "SERVER_FEHLER");
        assert_eq!(aus_status(500, "https://AUTH.sirfyyn.de/if/flow/x/", &auth).unwrap().code(), "ANMELDESERVER_FEHLER");
    }

    #[test]
    fn rueckoff_waechst_und_endet_bei_einer_minute() {
        let s: Vec<u64> = (0..7).map(|n| wartezeit(n).as_secs()).collect();
        assert_eq!(s, [5, 10, 20, 40, 60, 60, 60]);
    }
}
