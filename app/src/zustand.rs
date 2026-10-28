//! Gemeinsamer Zustand der laufenden Hülle (Tauri-frei, deshalb ohne Fenster testbar).

use crate::studio_http;
use serde::Serialize;
use shell_core::begleiter::{freien_port, neue_kennung, Begleiter, Kindprozess};
use shell_core::einstellungen::{self, Einstellungen};
use shell_core::speicher::Pfade;
use shell_core::verlauf::{Ausgang, Verlauf};
use shell_core::{Fehler, Meldung, Profil};
use std::sync::Mutex;

/// Stand des Begleiters für die Oberfläche.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "zustand", rename_all = "snake_case")]
pub enum BegleiterStand {
    /// Dieses Profil oder diese Einstellung hat keinen Begleiter.
    Keiner,
    Startet,
    Laeuft,
    Fehler { meldung: Meldung },
}

pub struct Huelle {
    pub profil: Profil,
    pub version: String,
    pub pfade: Pfade,
    pub einstellungen: Mutex<Einstellungen>,
    pub verlauf: Mutex<Verlauf>,
    /// Ergebnis der Prüfung nach dem Start ("Update gelungen" oder Fehler), einmal gesetzt.
    pub start_ausgang: Mutex<Option<Ausgang>>,
    pub warnungen: Mutex<Vec<Meldung>>,
    pub updater_fehler: Mutex<Option<Fehler>>,
    pub begleiter: Mutex<Option<Box<dyn Begleiter>>>,
    pub begleiter_stand: Mutex<BegleiterStand>,
    /// Adresse (mit Schrägstrich am Ende) und Kennung des eigenen Begleiters
    pub begleiter_ziel: Mutex<Option<(String, String)>>,
    pub seite_bereit: Mutex<Option<(bool, String)>>,
}

impl Huelle {
    /// Lädt Einstellungen und Versionsverlauf aus dem Datenordner und prüft, ob ein Update wirksam wurde.
    pub fn laden(profil: Profil, version: &str, pfade: Pfade) -> Result<Huelle, Fehler> {
        pfade.anlegen()?;
        let mut warnungen = Vec::new();
        let (einst, fehler) = einstellungen::laden(&pfade);
        if let Some(f) = fehler {
            warnungen.push(f.meldung());
        }
        let mut verlauf = Verlauf::laden(&pfade);
        let ausgang = verlauf.beim_start(version);
        if let Err(f) = verlauf.speichern(&pfade) {
            warnungen.push(f.meldung());
        }
        Ok(Huelle {
            profil,
            version: version.to_string(),
            pfade,
            einstellungen: Mutex::new(einst),
            verlauf: Mutex::new(verlauf),
            start_ausgang: Mutex::new(ausgang),
            warnungen: Mutex::new(warnungen),
            updater_fehler: Mutex::new(None),
            begleiter: Mutex::new(None),
            begleiter_stand: Mutex::new(BegleiterStand::Keiner),
            begleiter_ziel: Mutex::new(None),
            seite_bereit: Mutex::new(None),
        })
    }

    /// Start-URL des Inhaltsfensters: Adresse des eigenen Begleiters, sonst Einstellung, sonst Vorgabe des Profils.
    pub fn start_url(&self) -> String {
        if let Some((basis, _)) = sperre(&self.begleiter_ziel).clone() {
            return basis;
        }
        sperre(&self.einstellungen).start_url.clone().unwrap_or_else(|| self.profil.standard_start_url().to_string())
    }

    pub fn gesundheits_url(&self) -> String {
        studio_http::zustand_url(&self.start_url())
    }

    /// Kennung des eigenen Begleiters (falls einer läuft oder lief).
    pub fn kennung(&self) -> Option<String> {
        sperre(&self.begleiter_ziel).as_ref().map(|(_, k)| k.clone())
    }

    /// Ein nicht gesunder Begleiter, an dessen Adresse aber ein anderer Server antwortet, ist ein Port-Zusammenstoß.
    fn fremden_server_erkennen(&self, f: Fehler) -> Fehler {
        match f {
            Fehler::BegleiterAntwortetNicht { .. } | Fehler::BegleiterBeendet { .. } => {
                let url = self.gesundheits_url();
                if studio_http::holen(&url, None).is_ok() {
                    Fehler::PortBelegt { url }
                } else {
                    f
                }
            }
            andere => andere,
        }
    }

    /// Startet den Begleiter (nur Profil Studio mit eingestelltem Programm) und wartet, bis er gesund ist.
    /// Der Stand steht danach in `begleiter_stand`; hier wird nichts angezeigt.
    pub fn begleiter_starten(&self) -> Result<(), Fehler> {
        let Some(konfig) = self.profil.hat_begleiter().then(|| sperre(&self.einstellungen).begleiter.clone()).flatten() else {
            *sperre(&self.begleiter_stand) = BegleiterStand::Keiner;
            return Ok(());
        };
        if konfig.programm.trim().is_empty() {
            *sperre(&self.begleiter_stand) = BegleiterStand::Keiner;
            return Ok(());
        }
        *sperre(&self.begleiter_stand) = BegleiterStand::Startet;
        let mut kasten = sperre(&self.begleiter);
        if kasten.is_none() {
            // Port: fest eingestellt oder ein freier; Kennung: neu bei jedem Aufbau. Beides geht an den Begleiter.
            let port = match konfig.port {
                Some(p) => p,
                None => match freien_port() {
                    Ok(p) => p,
                    Err(e) => {
                        let f = Fehler::BegleiterStartetNicht { befehl: konfig.programm.clone(), grund: format!("kein freier Port: {e}") };
                        *sperre(&self.begleiter_stand) = BegleiterStand::Fehler { meldung: f.meldung() };
                        return Err(f);
                    }
                },
            };
            let kennung = neue_kennung();
            let basis = format!("http://127.0.0.1:{port}/");
            *sperre(&self.begleiter_ziel) = Some((basis.clone(), kennung.clone()));
            let url = studio_http::zustand_url(&basis);
            let pruef = url.clone();
            let erwartet = kennung.clone();
            let log = self.pfade.daten.join("begleiter.log");
            *kasten = Some(Box::new(Kindprozess::neu(
                konfig.mit_start_werten(port, &kennung),
                url,
                Box::new(move || studio_http::holen(&pruef, Some(&erwartet)).is_ok()),
                Some(log),
            )));
        }
        let ergebnis = kasten.as_mut().map(|b| b.starten()).unwrap_or(Ok(())).map_err(|f| self.fremden_server_erkennen(f));
        *sperre(&self.begleiter_stand) = match &ergebnis {
            Ok(()) => BegleiterStand::Laeuft,
            Err(f) => BegleiterStand::Fehler { meldung: f.meldung() },
        };
        ergebnis
    }

    pub fn begleiter_neustarten(&self) -> Result<(), Fehler> {
        {
            // alten Begleiter beenden und verwerfen: der neue bekommt einen neuen Port und eine neue Kennung
            let mut kasten = sperre(&self.begleiter);
            if let Some(b) = kasten.as_mut() {
                b.beenden();
            }
            *kasten = None;
        }
        self.begleiter_starten()
    }

    pub fn begleiter_beenden(&self) {
        if let Some(b) = sperre(&self.begleiter).as_mut() {
            b.beenden();
        }
        let mut stand = sperre(&self.begleiter_stand);
        if !matches!(*stand, BegleiterStand::Keiner) {
            *stand = BegleiterStand::Keiner;
        }
    }

    /// Wächter-Schritt: ist ein als laufend gemeldeter Begleiter von allein beendet worden, wird das gemeldet.
    pub fn begleiter_pruefen(&self) {
        let Ok(mut kasten) = self.begleiter.try_lock() else { return };
        let Some(b) = kasten.as_mut() else { return };
        let mut stand = sperre(&self.begleiter_stand);
        if matches!(*stand, BegleiterStand::Laeuft) && !b.laeuft() {
            *stand = BegleiterStand::Fehler {
                meldung: Fehler::BegleiterBeendet { grund: "der Prozess lief nicht mehr".into() }.meldung(),
            };
        }
    }
}

/// Mutex ohne Vergiftungs-Drama: ein abgestürzter Thread soll die Oberfläche nicht dauerhaft sperren.
pub fn sperre<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use shell_core::verlauf::Art;

    #[test]
    fn update_und_neustart_behalten_einstellungen_und_merken_die_vorversion() {
        let d = tempfile::tempdir().unwrap();
        let pfade = || Pfade::neu(d.path());

        // Version 0.0.1: Einstellung setzen
        let h1 = Huelle::laden(Profil::Studio, "0.0.1", pfade()).unwrap();
        assert!(sperre(&h1.start_ausgang).is_none());
        {
            let mut e = sperre(&h1.einstellungen);
            e.start_url = Some("http://127.0.0.1:9/".into());
            einstellungen::speichern(&h1.pfade, &e).unwrap();
        }
        {
            let mut v = sperre(&h1.verlauf);
            v.vor_update(Art::Update, "0.0.1", "0.0.2");
            v.speichern(&h1.pfade).unwrap();
        }

        // Neustart als Version 0.0.2
        let h2 = Huelle::laden(Profil::Studio, "0.0.2", pfade()).unwrap();
        assert!(matches!(&*sperre(&h2.start_ausgang), Some(Ausgang::Erfolg { .. })));
        assert_eq!(h2.start_url(), "http://127.0.0.1:9/");
        assert_eq!(sperre(&h2.verlauf).vorherige.as_deref(), Some("0.0.1"));

        // und noch ein Start: das Ergebnis erscheint nur einmal
        let h3 = Huelle::laden(Profil::Studio, "0.0.2", pfade()).unwrap();
        assert!(sperre(&h3.start_ausgang).is_none());
    }

    #[test]
    fn kaputte_einstellungen_werden_als_warnung_gemeldet() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("einstellungen.json"), "{x").unwrap();
        let h = Huelle::laden(Profil::Os, "0.0.1", Pfade::neu(d.path())).unwrap();
        assert_eq!(sperre(&h.warnungen)[0].code, "EINSTELLUNGEN_KAPUTT");
        assert_eq!(h.start_url(), "https://fyos.sirfyyn.de/os");
    }

    #[test]
    fn ohne_begleiter_einstellung_ist_der_stand_keiner() {
        let d = tempfile::tempdir().unwrap();
        let h = Huelle::laden(Profil::Studio, "0.0.1", Pfade::neu(d.path())).unwrap();
        h.begleiter_starten().unwrap();
        assert!(matches!(*sperre(&h.begleiter_stand), BegleiterStand::Keiner));
    }

    /// Ein "alter Dienst": antwortet auf jede Anfrage mit gültigem /api/state, aber ohne Kennung.
    fn fremder_dienst() -> u16 {
        use std::io::{Read, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                let mut s = s;
                let mut p = [0u8; 1024];
                let _ = s.read(&mut p);
                let k = r#"{"version":"alt","models":[]}"#;
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{k}", k.len());
            }
        });
        port
    }

    #[test]
    fn fremder_server_auf_dem_port_wird_nicht_als_gesund_gemeldet() {
        let port = fremder_dienst();
        let d = tempfile::tempdir().unwrap();
        let h = Huelle::laden(Profil::Studio, "0.0.1", Pfade::neu(d.path())).unwrap();
        sperre(&h.einstellungen).begleiter = Some(shell_core::begleiter::BegleiterKonfig {
            programm: "sh".into(),
            args: vec!["-c".into(), "exec sleep 30".into()],
            frist_s: 2,
            port: Some(port),
            ..Default::default()
        });
        let f = h.begleiter_starten().unwrap_err();
        assert_eq!(f.code(), "PORT_BELEGT", "{f}");
        assert!(matches!(*sperre(&h.begleiter_stand), BegleiterStand::Fehler { .. }));
    }

    #[test]
    fn ohne_festen_port_wird_ein_freier_gewaehlt_und_die_adresse_zeigt_darauf() {
        let d = tempfile::tempdir().unwrap();
        let h = Huelle::laden(Profil::Studio, "0.0.1", Pfade::neu(d.path())).unwrap();
        sperre(&h.einstellungen).begleiter = Some(shell_core::begleiter::BegleiterKonfig {
            programm: "sh".into(),
            args: vec!["-c".into(), "exec sleep 30".into()],
            frist_s: 1,
            ..Default::default()
        });
        let _ = h.begleiter_starten(); // sleep antwortet nie: Fehler ist erwartet, die Wahl von Port und Kennung zählt
        let url = h.start_url();
        assert!(url.starts_with("http://127.0.0.1:") && url != "http://127.0.0.1:8642/", "{url}");
        assert_eq!(h.kennung().unwrap().len(), 32);
    }

    #[test]
    fn begleiter_der_nicht_startet_gibt_katalogtext() {
        let d = tempfile::tempdir().unwrap();
        let h = Huelle::laden(Profil::Studio, "0.0.1", Pfade::neu(d.path())).unwrap();
        sperre(&h.einstellungen).begleiter = Some(shell_core::begleiter::BegleiterKonfig {
            programm: "/gibt/es/nicht".into(),
            ..Default::default()
        });
        let f = h.begleiter_starten().unwrap_err();
        assert_eq!(f.code(), "BEGLEITER_STARTET_NICHT");
        let stand = sperre(&h.begleiter_stand).clone();
        match stand {
            BegleiterStand::Fehler { meldung } => assert!(!meldung.abhilfe.is_empty()),
            s => panic!("{s:?}"),
        }
    }
}
