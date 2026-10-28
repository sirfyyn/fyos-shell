//! Deeplinks `fyos://oeffnen?ziel=app:haus__favoriten&eingabe=<base64url>` und `fle://oeffnen?ziel=...`.
//!
//! Die Hülle öffnet **nie beliebige URLs**: Schema und Befehl müssen zum Profil passen, `ziel` folgt einem festen Muster,
//! `eingabe` ist begrenzt (Grenze aus dem Vertrag: 4000 Zeichen Base64url). Heraus kommt ein Pfad *relativ zur Start-URL*
//! des Profils, nie ein fremder Host.

use crate::fehler::Fehler;
use crate::profil::Profil;
use url::Url;

pub const EINGABE_MAX: usize = 4000;

fn abgelehnt(link: &str, grund: &str) -> Fehler {
    Fehler::LinkAbgelehnt { link: link.to_string(), grund: grund.to_string() }
}

fn ziel_ok(z: &str) -> bool {
    let Some((art, rest)) = z.split_once(':') else { return false };
    matches!(art, "app" | "seite" | "nativ")
        && !rest.is_empty()
        && z.len() <= 120
        && rest.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
}

fn eingabe_ok(e: &str) -> bool {
    e.len() <= EINGABE_MAX && e.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '='))
}

/// Prüft einen Link und liefert den Pfad samt Abfrage (`/os?offen=…&eingabe=…`), der an die Start-URL angehängt wird.
pub fn pruefe(link: &str, profil: Profil) -> Result<String, Fehler> {
    let url = Url::parse(link).map_err(|_| abgelehnt(link, "kein gültiger Link"))?;
    if url.scheme() != profil.schema() {
        return Err(abgelehnt(link, &format!("Schema „{}“ gehört nicht zu diesem Programm", url.scheme())));
    }
    if url.host_str() != Some("oeffnen") {
        return Err(abgelehnt(link, "unbekannter Befehl (erlaubt ist nur „oeffnen“)"));
    }
    let mut ziel = None;
    let mut eingabe = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "ziel" if ziel.is_none() => ziel = Some(v.into_owned()),
            "eingabe" if eingabe.is_none() => eingabe = Some(v.into_owned()),
            _ => return Err(abgelehnt(link, &format!("unbekannter oder doppelter Parameter „{k}“"))),
        }
    }
    let ziel = ziel.ok_or_else(|| abgelehnt(link, "es fehlt das Ziel"))?;
    if !ziel_ok(&ziel) {
        return Err(abgelehnt(link, "das Ziel hat nicht die erlaubte Form (app:, seite: oder nativ: und ein Name)"));
    }
    if let Some(e) = &eingabe {
        if !eingabe_ok(e) {
            return Err(abgelehnt(link, "die Eingabe ist zu lang oder enthält unerlaubte Zeichen"));
        }
    }
    let basis = match profil {
        Profil::Studio => "/",
        Profil::Agent | Profil::Os => "/os",
    };
    let mut pfad = Url::parse("http://platzhalter/").expect("fester Platzhalter");
    pfad.set_path(basis);
    {
        let mut q = pfad.query_pairs_mut();
        q.append_pair("offen", &ziel);
        if let Some(e) = &eingabe {
            q.append_pair("eingabe", e);
        }
    }
    Ok(format!("{}?{}", pfad.path(), pfad.query().unwrap_or("")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gueltiger_os_link() {
        let p = pruefe("fyos://oeffnen?ziel=app:haus__favoriten&eingabe=eyJhIjoxfQ", Profil::Os).unwrap();
        assert_eq!(p, "/os?offen=app%3Ahaus__favoriten&eingabe=eyJhIjoxfQ");
    }

    #[test]
    fn gueltiger_studio_link_ohne_eingabe() {
        let p = pruefe("fle://oeffnen?ziel=seite:modelle", Profil::Studio).unwrap();
        assert_eq!(p, "/?offen=seite%3Amodelle");
    }

    #[test]
    fn falsches_schema_fuer_das_profil() {
        assert_eq!(pruefe("fle://oeffnen?ziel=seite:x", Profil::Os).unwrap_err().code(), "LINK_ABGELEHNT");
        assert!(pruefe("https://evil.example/", Profil::Os).is_err());
    }

    #[test]
    fn unbekannter_befehl_und_parameter() {
        assert!(pruefe("fyos://loeschen?ziel=app:x", Profil::Os).is_err());
        assert!(pruefe("fyos://oeffnen?ziel=app:x&url=http://evil", Profil::Os).is_err());
        assert!(pruefe("fyos://oeffnen?ziel=app:x&ziel=app:y", Profil::Os).is_err());
        assert!(pruefe("fyos://oeffnen", Profil::Os).is_err());
    }

    #[test]
    fn ziel_muster() {
        for schlecht in ["app:", "datei:x", "app:../x", "app:a b", "app:a/b", "javascript:alert(1)", "x"] {
            assert!(pruefe(&format!("fyos://oeffnen?ziel={schlecht}"), Profil::Os).is_err(), "{schlecht}");
        }
    }

    #[test]
    fn eingabe_grenze() {
        let ok = "a".repeat(EINGABE_MAX);
        assert!(pruefe(&format!("fyos://oeffnen?ziel=app:x&eingabe={ok}"), Profil::Os).is_ok());
        let zu_lang = "a".repeat(EINGABE_MAX + 1);
        assert!(pruefe(&format!("fyos://oeffnen?ziel=app:x&eingabe={zu_lang}"), Profil::Os).is_err());
        assert!(pruefe("fyos://oeffnen?ziel=app:x&eingabe=%3Cscript%3E", Profil::Os).is_err());
    }
}
