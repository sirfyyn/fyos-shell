//! Fehlerkatalog: jeder Fehler der Hülle hat einen festen Code, eine Ursache und eine Abhilfe.
//!
//! Leitregel: Eine Fehlermeldung nennt, was los ist **und** was der Nutzer tun kann.
//! Der Code ist stabil (Protokoll, Support, Tests); die Texte sind für Menschen.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::io;
use std::path::Path;

/// Die Meldung, wie sie die Oberfläche und das Protokoll bekommen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Meldung {
    pub code: String,
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
    /// Auf diesem System ist kein Tresor (Schlüsselbund, Anmeldeinformationen, Secret Service) erreichbar.
    TresorNichtVerfuegbar { grund: String },
    /// Der Tresor ist da, verweigert aber Lesen oder Schreiben (gesperrt, Zugriff abgelehnt).
    TresorZugriff { grund: String },
    /// Ein Geheimnis, auf das die Einstellungen verweisen (`{tresor:NAME}`), liegt nicht im Tresor.
    TresorEintragFehlt { name: String },
    /// Jemand wollte ein Geheimnis in `einstellungen.json` schreiben.
    GeheimnisInEinstellungen { schluessel: String },
    /// Der Name eines Tresor-Eintrags ist unzulässig.
    TresorNameUnzulaessig { name: String },
    /// Der Eintrag für den Start bei der Anmeldung lässt sich nicht schreiben oder lesen.
    AutostartFehlgeschlagen { ort: String, grund: String },
    /// Das mitgelieferte Python-Paket (Studio-Server) fehlt oder ist unvollständig.
    BuendelUnvollstaendig { grund: String },
    /// Das alte Studio-Datenverzeichnis, aus dem übernommen werden soll, gibt es nicht.
    UebernahmeQuelleFehlt { ort: String },
    /// Beim Übernehmen ist etwas Grundsätzliches schiefgegangen (Quelle nicht lesbar, Platte voll).
    UebernahmeFehlgeschlagen { ort: String, grund: String },
    /// Die Übernahme wurde schon einmal gemacht.
    UebernahmeSchonErfolgt { wann: String },
    /// Einzelne Dateien ließen sich nicht übernehmen.
    UebernahmeTeilweise { anzahl: usize, beispiel: String },
    /// Der Name des Servers lässt sich nicht auflösen (kein Netz, falsche Adresse, DNS gestört).
    DnsFehler { host: String },
    /// Das Zertifikat des Servers wird nicht anerkannt (abgelaufen, falscher Name, unbekannte Stelle, falsche Uhrzeit am Gerät).
    ZertifikatFehler { host: String, grund: String },
    /// Der Anmeldeserver (Anmeldeserver) antwortet mit einem Serverfehler.
    AnmeldeserverFehler { status: u16, url: String },
    /// Der Server antwortet mit einem Fehlerstatus (5xx oder 404).
    ServerFehler { status: u16, url: String },
    /// Das System lässt Mitteilungen dieser Anwendung nicht zu (Berechtigung verweigert oder nicht erteilt).
    MitteilungenNichtErlaubt { grund: String },
    /// Eine Mitteilung der Seite hat die Prüfung nicht bestanden (Absender, Länge, leerer Titel).
    MitteilungAbgelehnt { grund: String },
    /// Das System konnte die Mitteilung nicht anzeigen (Mitteilungsdienst nicht erreichbar).
    MitteilungFehlgeschlagen { grund: String },
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
            Fehler::TresorNichtVerfuegbar { .. } => "TRESOR_NICHT_VERFUEGBAR",
            Fehler::TresorZugriff { .. } => "TRESOR_ZUGRIFF",
            Fehler::TresorEintragFehlt { .. } => "TRESOR_EINTRAG_FEHLT",
            Fehler::GeheimnisInEinstellungen { .. } => "GEHEIMNIS_IN_EINSTELLUNGEN",
            Fehler::TresorNameUnzulaessig { .. } => "TRESOR_NAME_UNZULAESSIG",
            Fehler::AutostartFehlgeschlagen { .. } => "AUTOSTART_FEHLGESCHLAGEN",
            Fehler::BuendelUnvollstaendig { .. } => "BUENDEL_UNVOLLSTAENDIG",
            Fehler::DnsFehler { .. } => "DNS_FEHLER",
            Fehler::ZertifikatFehler { .. } => "ZERTIFIKAT_FEHLER",
            Fehler::AnmeldeserverFehler { .. } => "ANMELDESERVER_FEHLER",
            Fehler::ServerFehler { .. } => "SERVER_FEHLER",
            Fehler::UebernahmeQuelleFehlt { .. } => "UEBERNAHME_QUELLE_FEHLT",
            Fehler::UebernahmeFehlgeschlagen { .. } => "UEBERNAHME_FEHLGESCHLAGEN",
            Fehler::UebernahmeSchonErfolgt { .. } => "UEBERNAHME_SCHON_ERFOLGT",
            Fehler::UebernahmeTeilweise { .. } => "UEBERNAHME_TEILWEISE",
            Fehler::MitteilungenNichtErlaubt { .. } => "MITTEILUNGEN_NICHT_ERLAUBT",
            Fehler::MitteilungAbgelehnt { .. } => "MITTEILUNG_ABGELEHNT",
            Fehler::MitteilungFehlgeschlagen { .. } => "MITTEILUNG_FEHLGESCHLAGEN",
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
                // Die Ursache steht am Ende der Ausgabe (Python-Ablaufverfolgung): hier das Ende behalten, nicht den Anfang
                Some({
                    let n = grund.chars().count();
                    if n > 1500 { format!("…{}", grund.chars().skip(n - 1500).collect::<String>()) } else { grund.clone() }
                }),
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
            Fehler::TresorNichtVerfuegbar { grund } => (
                "Auf diesem Gerät ist kein Tresor für Geheimnisse (Passwörter, Zugangsschlüssel) erreichbar. Die Anwendung speichert Geheimnisse nie in einer Datei.".into(),
                "macOS: den Schlüsselbund entsperren (Programm „Schlüsselbundverwaltung“). Windows: der Dienst „Anmeldeinformationsverwaltung“ muss laufen. Linux: einen Secret-Service-Dienst starten und anmelden (GNOME: „Passwörter und Schlüssel“, KDE: KWallet mit Secret-Service-Brücke), danach die Anwendung neu starten.".into(),
                Some(kurz(grund)),
            ),
            Fehler::TresorZugriff { grund } => (
                "Der Tresor verweigert den Zugriff (gesperrt oder abgelehnt).".into(),
                "Den Schlüsselbund bzw. Tresor entsperren und die Rückfrage des Systems mit „Erlauben“ beantworten; bei „Immer erlauben“ fragt das System nicht erneut.".into(),
                Some(kurz(grund)),
            ),
            Fehler::TresorEintragFehlt { name } => (
                format!("Das Geheimnis „{name}“, auf das die Einstellungen verweisen, liegt nicht im Tresor."),
                "Das Geheimnis in der Anwendung eintragen (Einstellungen → Geheimnisse) oder den Verweis {tresor:…} aus den Einstellungen entfernen.".into(),
                None,
            ),
            Fehler::GeheimnisInEinstellungen { schluessel } => (
                format!("Der Wert „{schluessel}“ sieht nach einem Geheimnis aus und wird nicht in der Einstellungsdatei gespeichert."),
                "Das Geheimnis im Tresor ablegen und in den Einstellungen nur den Verweis {tresor:NAME} eintragen.".into(),
                None,
            ),
            Fehler::TresorNameUnzulaessig { name } => (
                "Der Name des Tresor-Eintrags ist nicht zulässig (erlaubt: Kleinbuchstaben, Ziffern, Punkt, Strich, Unterstrich; höchstens 64 Zeichen).".into(),
                "Einen kürzeren Namen aus erlaubten Zeichen wählen, z. B. „hf-token“.".into(),
                Some(kurz(name)),
            ),
            Fehler::AutostartFehlgeschlagen { ort, grund } => (
                "Der Start bei der Anmeldung konnte nicht ein- oder ausgeschaltet werden.".into(),
                "Prüfen, ob der Ordner bzw. Registrypfad beschreibbar ist (Benutzerrechte, Platz, Sicherheitssoftware). Die Anwendung läuft ganz normal weiter; der Start per Hand bleibt möglich.".into(),
                Some(kurz(&format!("{ort}: {grund}"))),
            ),
            Fehler::BuendelUnvollstaendig { grund } => (
                "Das mitgelieferte Python-Paket mit dem Studio-Server ist unvollständig oder beschädigt, deshalb startet der Studio-Server nicht.".into(),
                "Die Anwendung neu installieren (das Paket gehört zur Anwendung; Einstellungen und Daten bleiben erhalten). Wer das Studio selbst bereitstellt, trägt in den Einstellungen unter „begleiter“ ein eigenes Programm ein.".into(),
                Some(kurz(grund)),
            ),
            Fehler::UebernahmeQuelleFehlt { ort } => (
                "Das Datenverzeichnis des bestehenden Studios wurde nicht gefunden, deshalb gibt es nichts zu übernehmen.".into(),
                "Prüfen, ob das alte Studio auf diesem Gerät je gestartet wurde. Liegen seine Daten woanders, das Programm mit gesetztem FLE_STUDIO_HOME starten (so wie das alte Studio es auch liest). Es wurde nichts verändert.".into(),
                Some(ort.clone()),
            ),
            Fehler::UebernahmeFehlgeschlagen { ort, grund } => (
                "Die Übernahme aus dem bestehenden Studio ist abgebrochen (Quelle nicht lesbar oder Datenträger voll).".into(),
                "Das alte Verzeichnis wurde nicht verändert; schon kopierte Dateien sind unschädlich. Rechte auf dem alten Ordner prüfen, Platz schaffen und die Übernahme erneut starten.".into(),
                Some(format!("{ort}: {}", kurz(grund))),
            ),
            Fehler::UebernahmeSchonErfolgt { wann } => (
                format!("Die Übernahme wurde schon einmal gemacht (am {wann}) und wird nicht wiederholt, damit nichts doppelt oder zurückgesetzt wird."),
                "Nichts zu tun. Soll sie trotzdem noch einmal laufen, die Datei uebernahme.json im Datenordner der Anwendung löschen; vorhandene Dateien werden auch dann nie überschrieben.".into(),
                None,
            ),
            Fehler::UebernahmeTeilweise { anzahl, beispiel } => (
                format!("{anzahl} Datei(en) ließen sich nicht übernehmen; alle anderen sind kopiert."),
                "Die Rechte der genannten Dateien im alten Verzeichnis prüfen (Lesen für den eigenen Benutzer) und die Übernahme erneut starten: Bereits kopiertes wird übersprungen, nie überschrieben.".into(),
                Some(kurz(beispiel)),
            ),
            Fehler::DnsFehler { host } => (
                format!("Der Name „{host}“ lässt sich nicht auflösen: Das Gerät findet den Server nicht."),
                "Prüfen, ob das Gerät mit dem Netz verbunden ist (Webseite im Browser öffnen), ein VPN oder eine DNS-Einstellung die Adresse blockiert und der Servername stimmt. Die Anwendung versucht es automatisch erneut, sobald das Netz wieder da ist.".into(),
                Some(host.clone()),
            ),
            Fehler::ZertifikatFehler { host, grund } => (
                format!("Dem Zertifikat von „{host}“ wird nicht vertraut. Aus Sicherheitsgründen lädt die Anwendung die Seite deshalb nicht."),
                "Datum und Uhrzeit des Geräts prüfen (ein falsches Datum macht Zertifikate ungültig). In einem Firmen- oder Schulnetz fängt manchmal ein Filter die Verbindung ab: dann ein anderes Netz probieren. Besteht der Fehler weiter, dem Betreiber des Servers melden; ein Zertifikat lässt sich hier nicht übergehen.".into(),
                Some(format!("{host}: {}", kurz(grund))),
            ),
            Fehler::AnmeldeserverFehler { status, url } => (
                format!("Der Anmeldeserver antwortet mit einem Fehler (Status {status}). Ohne ihn ist keine Anmeldung möglich."),
                "Meist ist der Dienst kurz überlastet oder wird gewartet. Die Anwendung versucht es automatisch erneut; bleibt es, den Betreiber informieren. Bereits angemeldete Sitzungen sind nicht betroffen, sobald der Server wieder antwortet.".into(),
                Some(url.clone()),
            ),
            Fehler::ServerFehler { status, url } => (
                format!("Der Server antwortet mit einem Fehler (Status {status})."),
                "Meist ein Neustart oder eine Wartung auf Seiten des Servers. Die Anwendung versucht es automatisch erneut; bleibt es, den Betreiber informieren.".into(),
                Some(url.clone()),
            ),
            Fehler::MitteilungenNichtErlaubt { grund } => (
                "Das System zeigt keine Mitteilungen dieser Anwendung an: Die Berechtigung fehlt oder wurde verweigert. Im Fenster der Anwendung erscheinen Meldungen weiterhin.".into(),
                "macOS: Systemeinstellungen > Mitteilungen > FYOS OS > Mitteilungen erlauben. Windows: Einstellungen > System > Benachrichtigungen > FYOS OS. Linux: den Mitteilungsdienst der Oberfläche prüfen und „Nicht stören“ ausschalten. Danach in FYOS OS unter Einstellungen > Meldungen > Systemmitteilungen erneut einschalten.".into(),
                Some(kurz(grund)),
            ),
            Fehler::MitteilungAbgelehnt { grund } => (
                format!("Die Hülle hat die Mitteilung nicht angezeigt: {grund}."),
                "Das ist ein Fehler der Seite, nicht des Geräts: Titel (höchstens 80 Zeichen) und Text (höchstens 240 Zeichen) müssen vorhanden und die Seite muss der Server des Profils sein. Den Fehler dem Betreiber melden.".into(),
                None,
            ),
            Fehler::MitteilungFehlgeschlagen { grund } => (
                "Das System hat die Mitteilung nicht angenommen; im Fenster der Anwendung erscheint sie trotzdem.".into(),
                "Prüfen, ob der Mitteilungsdienst des Systems läuft (Linux: ein Dienst wie dunst oder der Desktop-Mitteilungsdienst) und ob „Nicht stören“ aktiv ist. Die Anwendung versucht es bei der nächsten Meldung erneut.".into(),
                Some(kurz(grund)),
            ),
        };
        Meldung { code: self.code().to_string(), ursache, abhilfe, details }
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
            Fehler::TresorNichtVerfuegbar { grund: s("g") },
            Fehler::TresorZugriff { grund: s("g") },
            Fehler::TresorEintragFehlt { name: s("n") },
            Fehler::GeheimnisInEinstellungen { schluessel: s("s") },
            Fehler::TresorNameUnzulaessig { name: s("n") },
            Fehler::AutostartFehlgeschlagen { ort: s("o"), grund: s("g") },
            Fehler::BuendelUnvollstaendig { grund: s("g") },
            Fehler::DnsFehler { host: s("h") },
            Fehler::ZertifikatFehler { host: s("h"), grund: s("g") },
            Fehler::AnmeldeserverFehler { status: 502, url: s("u") },
            Fehler::ServerFehler { status: 503, url: s("u") },
            Fehler::UebernahmeQuelleFehlt { ort: s("o") },
            Fehler::UebernahmeFehlgeschlagen { ort: s("o"), grund: s("g") },
            Fehler::UebernahmeSchonErfolgt { wann: s("w") },
            Fehler::UebernahmeTeilweise { anzahl: 1, beispiel: s("b") },
            Fehler::MitteilungenNichtErlaubt { grund: s("g") },
            Fehler::MitteilungAbgelehnt { grund: s("g") },
            Fehler::MitteilungFehlgeschlagen { grund: s("g") },
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
