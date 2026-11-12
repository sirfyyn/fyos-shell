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

/// Höchste Länge eines Ordners im Link `fyos://neu?ordner=…` (Profil Agent).
pub const ORDNER_MAX: usize = 1024;

/// Profil Agent: `fyos://neu?ordner=<absoluter Pfad>` öffnet „Neue Sitzung“ mit diesem Ordner (Start aus dem Terminal, `fyos-agent`).
/// `Ok(None)`: kein solcher Link (dann gilt `pruefe`). Der Ordner muss absolut sein, ohne Steuerzeichen und höchstens `ORDNER_MAX` lang;
/// ob er freigegeben ist, prüft der Runner. Angelegt wird nichts: die Seite zeigt nur das Formular, der Mensch bestätigt.
pub fn agent_neu_ordner(link: &str, profil: Profil) -> Result<Option<String>, Fehler> {
    if profil != Profil::Agent {
        return Ok(None);
    }
    let Ok(url) = Url::parse(link) else { return Ok(None) };
    if url.scheme() != profil.schema() || url.host_str() != Some("neu") {
        return Ok(None);
    }
    let mut ordner = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "ordner" if ordner.is_none() => ordner = Some(v.into_owned()),
            _ => return Err(abgelehnt(link, &format!("unbekannter oder doppelter Parameter „{k}“"))),
        }
    }
    let o = ordner.ok_or_else(|| abgelehnt(link, "es fehlt der Ordner"))?;
    let absolut = o.starts_with('/') || (o.len() > 2 && o.as_bytes()[1] == b':' && (o.as_bytes()[2] == b'\\' || o.as_bytes()[2] == b'/'));
    if !absolut || o.len() > ORDNER_MAX || o.chars().any(|c| c.is_control()) {
        return Err(abgelehnt(link, "der Ordner muss ein absoluter Pfad ohne Steuerzeichen sein"));
    }
    Ok(Some(o))
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
    #[test]
    fn agent_neu_ordner_nur_im_profil_agent_und_nur_absolut() {
        use super::agent_neu_ordner as neu;
        assert_eq!(neu("fyos://neu?ordner=%2Fsrv%2Fprojekt", Profil::Agent).unwrap(), Some("/srv/projekt".to_string()));
        assert_eq!(neu("fyos://neu?ordner=C%3A%5Cprojekt", Profil::Agent).unwrap(), Some("C:\\projekt".to_string()));
        assert_eq!(neu("fyos://oeffnen?ziel=app:x", Profil::Agent).unwrap(), None, "andere Befehle gehen an pruefe");
        assert_eq!(neu("fyos://neu?ordner=%2Fx", Profil::Os).unwrap(), None, "nur im Profil Agent");
        assert!(neu("fyos://neu?ordner=relativ", Profil::Agent).is_err());
        assert!(neu("fyos://neu", Profil::Agent).is_err());
        assert!(neu("fyos://neu?ordner=%2Fx&ordner=%2Fy", Profil::Agent).is_err());
        assert!(neu("fyos://neu?ordner=%2Fx%0Ay", Profil::Agent).is_err(), "keine Steuerzeichen");
        assert!(neu("fyos://neu?ordner=%2Fx&ziel=app:y", Profil::Agent).is_err());
        let lang = format!("fyos://neu?ordner=%2F{}", "a".repeat(super::ORDNER_MAX));
        assert!(neu(&lang, Profil::Agent).is_err());
    }

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
