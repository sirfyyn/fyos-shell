//! Update-Logik ohne Netz und ohne Tauri: Versionsvergleich, Adressen der Manifeste, Entscheidung "aktualisieren?".
//! Das Herunterladen, Prüfen der Signatur und Einspielen übernimmt das Tauri-Updater-Plugin in der Anwendung.
//!
//! Zwei Manifeste:
//! - `<basis>/latest.json`: die neueste Version (normaler Weg).
//! - `<basis>/v<version>/latest.json`: genau diese Version (Rückweg). Wer eine Version veröffentlicht, legt beides ab.

use crate::fehler::Fehler;
use semver::Version;

/// Was der Vergleich zwischen laufender Version und Angebot des Servers ergibt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entscheidung {
    Aktuell,
    Verfuegbar(Version),
    /// Der Server nennt eine **ältere** Version (Rückfall-Kanal). Wird nie von allein eingespielt, nur auf Befehl.
    Rueckfall(Version),
}

pub fn version_lesen(text: &str) -> Result<Version, Fehler> {
    Version::parse(text.trim().trim_start_matches('v')).map_err(|e| Fehler::ManifestUnlesbar {
        url: String::new(),
        grund: format!("Version „{text}“ ist keine gültige Versionsnummer ({e})"),
    })
}

pub fn entscheide(laufend: &str, angebot: &str) -> Result<Entscheidung, Fehler> {
    let l = version_lesen(laufend)?;
    let a = version_lesen(angebot)?;
    Ok(match a.cmp(&l) {
        std::cmp::Ordering::Equal => Entscheidung::Aktuell,
        std::cmp::Ordering::Greater => Entscheidung::Verfuegbar(a),
        std::cmp::Ordering::Less => Entscheidung::Rueckfall(a),
    })
}

/// Entscheidet für den Rückweg, welches Angebot der Updater annehmen darf: genau die gemerkte Vorversion,
/// und nur, wenn sie nicht ohnehin läuft. (Der Updater lehnt sonst jede ältere Version ab.)
pub fn ist_rueckweg_ziel(laufend: &Version, angebot: &Version, ziel: &Version) -> bool {
    angebot == ziel && angebot != laufend
}

/// Adresse des Manifests. `version = None`: neueste, sonst genau diese.
pub fn manifest_url(basis: &str, version: Option<&Version>) -> String {
    let basis = basis.trim_end_matches('/');
    match version {
        None => format!("{basis}/latest.json"),
        Some(v) => format!("{basis}/v{v}/latest.json"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn neuere_ist_verfuegbar() {
        assert_eq!(entscheide("0.0.1", "0.0.2").unwrap(), Entscheidung::Verfuegbar(v("0.0.2")));
    }

    #[test]
    fn gleiche_ist_aktuell() {
        assert_eq!(entscheide("0.0.2", "0.0.2").unwrap(), Entscheidung::Aktuell);
    }

    #[test]
    fn aeltere_ist_rueckfall_nie_automatisch() {
        assert_eq!(entscheide("0.0.2", "0.0.1").unwrap(), Entscheidung::Rueckfall(v("0.0.1")));
    }

    #[test]
    fn versionsvergleich_ist_numerisch_nicht_textlich() {
        assert_eq!(entscheide("0.0.9", "0.0.10").unwrap(), Entscheidung::Verfuegbar(v("0.0.10")));
        assert_eq!(entscheide("1.2.0-rc.1", "1.2.0").unwrap(), Entscheidung::Verfuegbar(v("1.2.0")));
    }

    #[test]
    fn v_vorsatz_und_leerraum_werden_toleriert() {
        assert_eq!(entscheide(" v0.1.0 ", "0.1.0").unwrap(), Entscheidung::Aktuell);
    }

    #[test]
    fn unlesbare_version_ist_ein_katalogfehler() {
        assert_eq!(entscheide("0.0.1", "neu").unwrap_err().code(), "UPDATE_MANIFEST_UNLESBAR");
    }

    #[test]
    fn rueckweg_nimmt_genau_die_vorversion() {
        let laufend = v("0.0.2");
        let ziel = v("0.0.1");
        assert!(ist_rueckweg_ziel(&laufend, &v("0.0.1"), &ziel));
        assert!(!ist_rueckweg_ziel(&laufend, &v("0.0.0"), &ziel), "andere ältere Version");
        assert!(!ist_rueckweg_ziel(&laufend, &v("0.0.3"), &ziel), "neuere Version");
        assert!(!ist_rueckweg_ziel(&v("0.0.1"), &v("0.0.1"), &ziel), "läuft schon");
    }

    #[test]
    fn manifest_adressen() {
        assert_eq!(manifest_url("http://h:1/studio/", None), "http://h:1/studio/latest.json");
        assert_eq!(manifest_url("http://h:1/studio", Some(&v("0.0.1"))), "http://h:1/studio/v0.0.1/latest.json");
    }
}
