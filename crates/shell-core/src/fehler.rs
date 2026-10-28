//! Fehlerkatalog: jeder Fehler der Hülle hat einen festen Code, eine Ursache und eine Abhilfe.
//!
//! Leitregel: Eine Fehlermeldung nennt, was los ist **und** was der Nutzer tun kann.
//! Der Code ist stabil (Protokoll, Support, Tests); die Texte sind für Menschen.

use serde::Serialize;
use std::fmt;
use std::io;
use std::path::Path;

/// Die Meldung, wie sie die Oberfläche und das Protokoll bekommen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Meldung {
    pub code: &'static str,
    pub ursache: String,
    pub abhilfe: String,
    /// Technische Einzelheit (OS-Fehler, URL) für das Protokoll; nie das Einzige, was der Nutzer sieht.
    pub details: Option<String>,
}

/// Alle bekannten Fehler der Hülle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fehler {
    /// Der Update-Server antwortet, aber das Manifest (`latest.json`) gibt es dort nicht.
    ManifestFehlt { url: String },
    /// Manifest oder Paket sind nicht lesbar oder nicht vollständig.
    ManifestUnlesbar { url: String, grund: String },
    /// Die Signatur des Pakets passt nicht zum eingebauten öffentlichen Schlüssel.
    SignaturFalsch,
    /// Auf dem Datenträger ist kein Platz mehr.
    PlatteVoll { pfad: String },
    /// Der Update-Server (oder eine andere Gegenstelle) ist nicht erreichbar.
    ServerNichtErreichbar { url: String, grund: String },
    /// In dieser Fassung ist kein Update-Schlüssel eingebaut.
    UpdaterNichtEingerichtet { grund: String },
    /// „Zurück“ ohne gemerkte Vorversion.
    KeineVorversion,
    /// Das Update wurde eingespielt, aber die erwartete Version läuft nicht.
    UpdateNichtWirksam { erwartet: String, laeuft: String },
    /// Die Hülle konnte das Update nicht einspielen (Rechte, gesperrte Datei).
    UpdateEinspielenFehlgeschlagen { grund: String },
    /// Studio (oder Test-Server) antwortet nicht auf `/api/state`.
    StudioNichtErreichbar { url: String, grund: String },
    /// Die Antwort von `/api/state` hat nicht die erwartete Form.
    StudioAntwortUnlesbar { grund: String },
    /// Der Begleiterprozess lässt sich nicht starten (Programm fehlt, keine Rechte).
    BegleiterStartetNicht { befehl: String, grund: String },
    /// Der Begleiter läuft, besteht aber die Gesundheitsprüfung nicht rechtzeitig.
    BegleiterAntwortetNicht { url: String, sekunden: u64 },
    /// Unter der Adresse des Begleiters antwortet ein anderes Programm (alter Dienst, fremder Server).
    PortBelegt { url: String },
    /// Der Begleiter ist beendet worden, ohne dass die Hülle es wollte.
    BegleiterBeendet { grund: String },
    /// Die Einstellungsdatei ist beschädigt; sie wurde zur Seite gelegt.
    EinstellungenKaputt { pfad: String, grund: String },
    /// Eine Datei im Datenordner lässt sich nicht lesen oder schreiben.
    DatenordnerNichtBeschreibbar { pfad: String, grund: String },
    /// Ein Deeplink hat die Prüfung nicht bestanden.
    LinkAbgelehnt { link: String, grund: String },
    /// Das Programm kennt seine Profilkennung nicht.
    ProfilUnbekannt { kennung: String },
}

fn kurz(s: &str) -> String {
    let s = s.trim();
    if s.chars().count() > 200 {
        let abgeschnitten: String = s.chars().take(200).collect();
        format!("{abgeschnitten}…")
    } else {
        s.to_string()
    }
}

impl Fehler {
    /// Stabiler Code, z. B. `UPDATE_SIGNATUR_FALSCH`.
    pub fn code(&self) -> &'static str {
        match self {
            Fehler::ManifestFehlt { .. } => "UPDATE_MANIFEST_FEHLT",
            Fehler::ManifestUnlesbar { .. } => "UPDATE_MANIFEST_UNLESBAR",
            Fehler::SignaturFalsch => "UPDATE_SIGNATUR_FALSCH",
            Fehler::PlatteVoll { .. } => "PLATTE_VOLL",
            Fehler::ServerNichtErreichbar { .. } => "SERVER_NICHT_ERREICHBAR",
            Fehler::UpdaterNichtEingerichtet { .. } => "UPDATE_NICHT_EINGERICHTET",
            Fehler::KeineVorversion => "RUECKWEG_KEINE_VORVERSION",
            Fehler::UpdateNichtWirksam { .. } => "UPDATE_NICHT_WIRKSAM",
            Fehler::UpdateEinspielenFehlgeschlagen { .. } => "UPDATE_EINSPIELEN_FEHLGESCHLAGEN",
            Fehler::StudioNichtErreichbar { .. } => "STUDIO_NICHT_ERREICHBAR",
            Fehler::StudioAntwortUnlesbar { .. } => "STUDIO_ANTWORT_UNLESBAR",
            Fehler::BegleiterStartetNicht { .. } => "BEGLEITER_STARTET_NICHT",
            Fehler::BegleiterAntwortetNicht { .. } => "BEGLEITER_ANTWORTET_NICHT",
            Fehler::PortBelegt { .. } => "PORT_BELEGT",
            Fehler::BegleiterBeendet { .. } => "BEGLEITER_BEENDET",
            Fehler::EinstellungenKaputt { .. } => "EINSTELLUNGEN_KAPUTT",
            Fehler::DatenordnerNichtBeschreibbar { .. } => "DATENORDNER_NICHT_BESCHREIBBAR",
            Fehler::LinkAbgelehnt { .. } => "LINK_ABGELEHNT",
            Fehler::ProfilUnbekannt { .. } => "PROFIL_UNBEKANNT",
        }
    }

    /// Der Katalogeintrag mit Ursache und Abhilfe in ganzen Sätzen.
    pub fn meldung(&self) -> Meldung {
        let (ursache, abhilfe, details): (String, String, Option<String>) = match self {
            Fehler::ManifestFehlt { url } => (
                "Der Update-Server ist erreichbar, hat aber keine Update-Beschreibung (latest.json) für dieses Gerät.".into(),
                "Es gibt für dieses System noch kein Update. Die installierte Version bleibt unverändert. Später erneut prüfen; wenn das öfter vorkommt, an den Betreiber des Servers melden.".into(),
                Some(url.clone()),
            ),
            Fehler::ManifestUnlesbar { url, grund } => (
                "Die Update-Beschreibung des Servers ist unlesbar oder unvollständig.".into(),
                "Die installierte Version bleibt unverändert. Später erneut versuchen; besteht der Fehler, das Update-Paket vom Betreiber neu veröffentlichen lassen.".into(),
                Some(format!("{url}: {}", kurz(grund))),
            ),
            Fehler::SignaturFalsch => (
                "Die Signatur des Update-Pakets passt nicht zu dem Schlüssel, der in dieser Anwendung eingebaut ist. Das Paket wurde deshalb nicht installiert.".into(),
                "Es wurde nichts verändert, die installierte Version läuft weiter. Das Paket stammt nicht vom Hersteller oder wurde unterwegs verändert: bitte nicht erzwingen, sondern die Anwendung neu von der Herstellerseite laden.".into(),
                None,
            ),
            Fehler::PlatteVoll { pfad } => (
                "Auf dem Datenträger ist nicht genug freier Platz, um das Update herunterzuladen und einzuspielen.".into(),
                "Platz schaffen (Papierkorb leeren, Downloads aufräumen; für ein Update genügen meist 500 MB) und dann erneut aktualisieren. Die installierte Version und alle Einstellungen sind unverändert.".into(),
                Some(pfad.clone()),
            ),
            Fehler::ServerNichtErreichbar { url, grund } => (
                "Der Update-Server antwortet nicht (kein Netz, Server aus oder Adresse falsch).".into(),
                "Netzverbindung prüfen und später erneut versuchen. Die installierte Version läuft unverändert weiter.".into(),
                Some(format!("{url}: {}", kurz(grund))),
            ),
            Fehler::UpdaterNichtEingerichtet { grund } => (
                "In dieser Fassung der Anwendung ist kein Update-Schlüssel eingebaut, deshalb kann sie sich nicht selbst aktualisieren.".into(),
                "Die neueste Fassung von Hand von der Herstellerseite laden und installieren; Einstellungen bleiben dabei erhalten.".into(),
                Some(kurz(grund)),
            ),
            Fehler::KeineVorversion => (
                "Es ist keine frühere Version gemerkt: diese Fassung ist die erste, die auf diesem Gerät gelaufen ist.".into(),
                "Eine ältere Fassung von der Herstellerseite laden und darüber installieren; Einstellungen bleiben erhalten.".into(),
                None,
            ),
            Fehler::UpdateNichtWirksam { erwartet, laeuft } => (
                format!("Das Update auf Version {erwartet} wurde gestartet, es läuft aber noch Version {laeuft}."),
                "Die Anwendung ganz beenden (auch im Tray) und neu starten. Hilft das nicht, die Anwendung von der Herstellerseite neu installieren; die Einstellungen bleiben erhalten.".into(),
                None,
            ),
            Fehler::UpdateEinspielenFehlgeschlagen { grund } => (
                "Das Update wurde geladen und geprüft, ließ sich aber nicht an Ort und Stelle einspielen (fehlende Schreibrechte oder die Datei ist in Benutzung).".into(),
                "Die Anwendung beenden, an einen Ort mit Schreibrecht legen (z. B. den Ordner „Programme“ des Benutzers) und erneut aktualisieren. Die bisherige Version läuft unverändert.".into(),
                Some(kurz(grund)),
            ),
            Fehler::StudioNichtErreichbar { url, grund } => (
                "FLE Studio antwortet nicht unter der eingestellten Adresse.".into(),
                "Prüfen, ob Studio läuft (in der Hülle: „Studio neu starten“) und ob die Adresse in den Einstellungen stimmt.".into(),
                Some(format!("{url}: {}", kurz(grund))),
            ),
            Fehler::StudioAntwortUnlesbar { grund } => (
                "Studio antwortet, aber die Antwort auf /api/state hat nicht die erwartete Form.".into(),
                "Vermutlich läuft dort ein anderes Programm oder eine nicht passende Studio-Version. Adresse in den Einstellungen prüfen oder Studio aktualisieren.".into(),
                Some(kurz(grund)),
            ),
            Fehler::BegleiterStartetNicht { befehl, grund } => (
                "Das Hilfsprogramm, das Studio ausführt, lässt sich nicht starten.".into(),
                "Anwendung neu installieren (das Hilfsprogramm gehört zum Paket). Wurde der Befehl in den Einstellungen geändert, dort auf den Standard zurücksetzen.".into(),
                Some(format!("{befehl}: {}", kurz(grund))),
            ),
            Fehler::BegleiterAntwortetNicht { url, sekunden } => (
                format!("Das Hilfsprogramm läuft, hat aber in {sekunden} Sekunden nicht auf die Gesundheitsprüfung geantwortet."),
                "Kurz warten und „Studio neu starten“ wählen. Ist der Port schon belegt (z. B. von einem alten Studio-Dienst), diesen Dienst beenden oder in den Einstellungen einen anderen Port wählen.".into(),
                Some(url.clone()),
            ),
            Fehler::PortBelegt { url } => (
                "Unter dieser Adresse antwortet ein anderes Programm (zum Beispiel ein alter Studio-Dienst), nicht das Studio dieser Anwendung. Die Anwendung nutzt es deshalb nicht.".into(),
                "Den alten Dienst beenden (er belegt den Port) oder in den Einstellungen den Port des Hilfsprogramms entfernen, dann wählt die Anwendung selbst einen freien.".into(),
                Some(url.clone()),
            ),
            Fehler::BegleiterBeendet { grund } => (
                "Das Hilfsprogramm von Studio hat sich unerwartet beendet.".into(),
                "„Studio neu starten“ wählen. Tritt es wiederholt auf, „Bericht speichern“ wählen und den Bericht dem Betreiber schicken.".into(),
                Some(kurz(grund)),
            ),
            Fehler::EinstellungenKaputt { pfad, grund } => (
                "Die Einstellungsdatei ist beschädigt. Sie wurde als Kopie zur Seite gelegt, und die Anwendung läuft mit Standardwerten.".into(),
                "Einstellungen neu vornehmen; die beschädigte Datei liegt als Kopie mit der Endung .kaputt neben der Originaldatei und kann dem Betreiber gezeigt werden.".into(),
                Some(format!("{pfad}: {}", kurz(grund))),
            ),
            Fehler::DatenordnerNichtBeschreibbar { pfad, grund } => (
                "Die Anwendung kann in ihrem Datenordner nicht schreiben, ihre Einstellungen gehen deshalb nicht verloren, werden aber nicht gespeichert.".into(),
                "Rechte des Datenordners prüfen oder Platz schaffen; den Ordner nicht löschen, er enthält die Einstellungen.".into(),
                Some(format!("{pfad}: {}", kurz(grund))),
            ),
            Fehler::LinkAbgelehnt { link, grund } => (
                format!("Der Link wurde nicht geöffnet: {grund}."),
                "Den Link nur aus einer vertrauenswürdigen Quelle verwenden; die Anwendung öffnet nur bekannte Ziele.".into(),
                Some(kurz(link)),
            ),
            Fehler::ProfilUnbekannt { kennung } => (
                "Diese Fassung kennt ihr Profil (Studio, Agent oder OS) nicht.".into(),
                "Die Anwendung mit einer Profildatei aus profile/ bauen oder die offizielle Fassung installieren.".into(),
                Some(kennung.clone()),
            ),
        };
        Meldung { code: self.code(), ursache, abhilfe, details }
    }

    /// Ein E/A-Fehler beim Schreiben unter `pfad`: „Platte voll“ wird erkannt, alles andere ist ein Datenordner-Fehler.
    pub fn aus_io(fehler: &io::Error, pfad: &Path) -> Fehler {
        if ist_platte_voll(fehler) {
            Fehler::PlatteVoll { pfad: pfad.display().to_string() }
        } else {
            Fehler::DatenordnerNichtBeschreibbar { pfad: pfad.display().to_string(), grund: fehler.to_string() }
        }
    }
}

/// ENOSPC (Unix 28), ERROR_DISK_FULL (Windows 112), ERROR_HANDLE_DISK_FULL (Windows 39) oder `StorageFull`.
pub fn ist_platte_voll(fehler: &io::Error) -> bool {
    fehler.kind() == io::ErrorKind::StorageFull || matches!(fehler.raw_os_error(), Some(28) | Some(112) | Some(39))
}

impl fmt::Display for Fehler {
    /// Eine Zeile für Kommandozeile und Protokoll: „Ursache Abhilfe (Code)“.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let m = self.meldung();
        write!(f, "{} Abhilfe: {} [{}]", m.ursache, m.abhilfe, m.code)
    }
}

impl std::error::Error for Fehler {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn alle() -> Vec<Fehler> {
        let s = |x: &str| x.to_string();
        vec![
            Fehler::ManifestFehlt { url: s("http://x/latest.json") },
            Fehler::ManifestUnlesbar { url: s("u"), grund: s("g") },
            Fehler::SignaturFalsch,
            Fehler::PlatteVoll { pfad: s("/tmp") },
            Fehler::ServerNichtErreichbar { url: s("u"), grund: s("g") },
            Fehler::UpdaterNichtEingerichtet { grund: s("g") },
            Fehler::KeineVorversion,
            Fehler::UpdateNichtWirksam { erwartet: s("0.0.2"), laeuft: s("0.0.1") },
            Fehler::UpdateEinspielenFehlgeschlagen { grund: s("g") },
            Fehler::StudioNichtErreichbar { url: s("u"), grund: s("g") },
            Fehler::StudioAntwortUnlesbar { grund: s("g") },
            Fehler::BegleiterStartetNicht { befehl: s("b"), grund: s("g") },
            Fehler::BegleiterAntwortetNicht { url: s("u"), sekunden: 20 },
            Fehler::PortBelegt { url: s("u") },
            Fehler::BegleiterBeendet { grund: s("g") },
            Fehler::EinstellungenKaputt { pfad: s("p"), grund: s("g") },
            Fehler::DatenordnerNichtBeschreibbar { pfad: s("p"), grund: s("g") },
            Fehler::LinkAbgelehnt { link: s("l"), grund: s("g") },
            Fehler::ProfilUnbekannt { kennung: s("k") },
        ]
    }

    #[test]
    fn jeder_fehler_nennt_ursache_und_abhilfe() {
        for f in alle() {
            let m = f.meldung();
            assert!(m.ursache.len() > 20, "{}: Ursache zu knapp", m.code);
            assert!(m.abhilfe.len() > 20, "{}: Abhilfe zu knapp", m.code);
            assert_eq!(m.code, f.code());
        }
    }

    #[test]
    fn codes_sind_eindeutig_und_grossbuchstaben() {
        let codes: Vec<&str> = alle().iter().map(|f| f.code()).collect();
        let menge: HashSet<&&str> = codes.iter().collect();
        assert_eq!(menge.len(), codes.len());
        for c in codes {
            assert!(c.chars().all(|ch| ch.is_ascii_uppercase() || ch == '_'), "{c}");
        }
    }

    #[test]
    fn display_enthaelt_abhilfe_und_code() {
        let t = Fehler::SignaturFalsch.to_string();
        assert!(t.contains("Abhilfe:"));
        assert!(t.contains("UPDATE_SIGNATUR_FALSCH"));
    }

    #[test]
    fn platte_voll_wird_erkannt() {
        let voll = io::Error::from_raw_os_error(28);
        assert!(ist_platte_voll(&voll));
        assert_eq!(Fehler::aus_io(&voll, Path::new("/x")).code(), "PLATTE_VOLL");
        let anders = io::Error::new(io::ErrorKind::PermissionDenied, "nein");
        assert_eq!(Fehler::aus_io(&anders, Path::new("/x")).code(), "DATENORDNER_NICHT_BESCHREIBBAR");
    }

    #[test]
    fn lange_details_werden_gekuerzt() {
        let lang = "a".repeat(500);
        let m = Fehler::StudioAntwortUnlesbar { grund: lang }.meldung();
        assert!(m.details.unwrap().chars().count() <= 201);
    }
}
