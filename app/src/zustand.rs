//! Gemeinsamer Zustand der laufenden Hülle (Tauri-frei, deshalb ohne Fenster testbar).

use crate::studio_http;
use serde::Serialize;
use shell_core::begleiter::{freien_port, neue_kennung, Begleiter, BegleiterKonfig, Kindprozess};
use shell_core::buendel::Buendel;
use shell_core::bericht::{self, Bericht};
use shell_core::einstellungen::{self, Einstellungen};
use shell_core::speicher::Pfade;
use shell_core::verlauf::{Ausgang, Verlauf};
use shell_core::tresor::{SpeicherTresor, Tresor};
use shell_core::{Fehler, Meldung, Profil};
use std::sync::{Arc, Mutex};

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
    /// Tresor für Geheimnisse (Systemtresor im Betrieb, Speicher-Tresor in Tests)
    pub tresor: Arc<dyn Tresor>,
    /// Python-Bündel mit dem Studio-Server (nur Profil Studio, nur wenn die App es mitbringt)
    pub buendel: Option<Buendel>,
    /// Woher der laufende Begleiter kommt: "Einstellungen" oder "Bündel" (leer: keiner)
    pub begleiter_quelle: Mutex<String>,
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
            tresor: Arc::new(SpeicherTresor::default()),
            buendel: None,
            begleiter_quelle: Mutex::new(String::new()),
        })
    }

    /// Welcher Begleiter gilt? Eine Einstellung des Nutzers (Feld „begleiter“ in der Einstellungsdatei) hat Vorrang; sonst, im Profil Studio,
    /// der Server aus dem mitgelieferten Bündel; sonst keiner. Das zweite Stück sagt der Anzeige, woher er kommt.
    pub fn begleiter_konfig(&self) -> Option<(BegleiterKonfig, &'static str)> {
        if !self.profil.hat_begleiter() {
            return None;
        }
        if let Some(k) = sperre(&self.einstellungen).begleiter.clone().filter(|k| !k.programm.trim().is_empty()) {
            return Some((k, "Einstellungen"));
        }
        self.buendel.as_ref().map(|b| (b.begleiter_konfig(&self.pfade.daten, cfg!(windows)), "Bündel"))
    }

    /// Setzt das Bündel (im Betrieb aus dem Ressourcenordner der App gelesen).
    pub fn mit_buendel(mut self, buendel: Option<Buendel>) -> Huelle {
        self.buendel = buendel;
        self
    }

    /// Setzt den Tresor (im Betrieb der Systemtresor).
    pub fn mit_tresor(mut self, tresor: Arc<dyn Tresor>) -> Huelle {
        self.tresor = tresor;
        self
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
        let Some((konfig, quelle)) = self.begleiter_konfig() else {
            *sperre(&self.begleiter_stand) = BegleiterStand::Keiner;
            return Ok(());
        };
        *sperre(&self.begleiter_quelle) = quelle.to_string();
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
            // Verweise {tresor:NAME} aus den Einstellungen erst jetzt einsetzen; ohne Verweis wird der Tresor nicht berührt
            let konfig = match konfig.mit_geheimnissen(&*self.tresor) {
                Ok(k) => k,
                Err(f) => {
                    *sperre(&self.begleiter_stand) = BegleiterStand::Fehler { meldung: f.meldung() };
                    return Err(f);
                }
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

    /// Sammelt alles für den Fehlerbericht: stehende Meldungen (Warnungen, Updater, Ergebnis des letzten Updates, Begleiter), dazu optional die
    /// Meldung, die der Nutzer gerade sieht. Geheimnisse schwärzt `Bericht::text`.
    pub fn bericht(&self, produkt: &str, zusatz: Option<Meldung>) -> Bericht {
        let mut meldungen: Vec<Meldung> = sperre(&self.warnungen).clone();
        if let Some(f) = sperre(&self.updater_fehler).as_ref() {
            meldungen.push(f.meldung());
        }
        if let Some(Ausgang::Misserfolg(f)) = &*sperre(&self.start_ausgang) {
            meldungen.push(f.meldung());
        }
        let begleiter = match &*sperre(&self.begleiter_stand) {
            BegleiterStand::Keiner => "kein Begleiter".to_string(),
            BegleiterStand::Startet => "startet".to_string(),
            BegleiterStand::Laeuft => "läuft".to_string(),
            BegleiterStand::Fehler { meldung } => {
                meldungen.push(meldung.clone());
                format!("Fehler ({})", meldung.code)
            }
        };
        meldungen.extend(zusatz);
        let mut gesehen: Vec<(String, String, Option<String>)> = Vec::new();
        let mut einmalig = Vec::new();
        for m in meldungen {
            let schluessel = (m.code.clone(), m.ursache.clone(), m.details.clone());
            if !gesehen.contains(&schluessel) {
                gesehen.push(schluessel);
                einmalig.push(m);
            }
        }
        let meldungen = einmalig;
        let log = std::fs::read(self.pfade.daten.join("begleiter.log"))
            .map(|b| String::from_utf8_lossy(&b[b.len().saturating_sub(64 * 1024)..]).into_owned())
            .unwrap_or_default();
        Bericht {
            profil: self.profil.name().to_string(),
            produkt: produkt.to_string(),
            version: self.version.clone(),
            vorherige: sperre(&self.verlauf).vorherige.clone().filter(|v| *v != self.version),
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            datenordner: self.pfade.daten.display().to_string(),
            zeit_unix: bericht::jetzt(),
            ausgang: sperre(&self.start_ausgang).as_ref().map(Ausgang::text),
            meldungen,
            begleiter,
            einstellungen: sperre(&self.einstellungen).clone(),
            log,
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
    fn geheimnis_aus_dem_tresor_erreicht_den_begleiter_aber_nie_die_einstellungsdatei() {
        let d = tempfile::tempdir().unwrap();
        let h = Huelle::laden(Profil::Studio, "0.0.1", Pfade::neu(d.path())).unwrap();
        h.tresor.schreiben("hf-token", "hf_geheim_123").unwrap();
        let ablage = d.path().join("gesehen.txt");
        {
            let mut e = sperre(&h.einstellungen);
            e.begleiter = Some(shell_core::begleiter::BegleiterKonfig {
                programm: "sh".into(),
                args: vec!["-c".into(), format!("printf %s \"$HF_TOKEN\" > '{}'; exec sleep 30", ablage.display())],
                env: std::collections::BTreeMap::from([("HF_TOKEN".to_string(), "{tresor:hf-token}".to_string())]),
                frist_s: 2,
                ..Default::default()
            });
            einstellungen::speichern(&h.pfade, &e).expect("Verweise dürfen gespeichert werden");
        }
        let _ = h.begleiter_starten(); // sleep antwortet nie; wichtig ist, was der Kindprozess sah
        assert_eq!(std::fs::read_to_string(&ablage).unwrap(), "hf_geheim_123");
        let datei = std::fs::read_to_string(h.pfade.einstellungen()).unwrap();
        assert!(datei.contains("{tresor:hf-token}") && !datei.contains("hf_geheim_123"), "{datei}");
        assert!(!std::fs::read_to_string(h.pfade.daten.join("begleiter.log")).unwrap_or_default().contains("hf_geheim_123"));
    }

    #[test]
    fn fehlendes_geheimnis_und_kein_tresor_stoppen_den_start_mit_katalogtext() {
        let d = tempfile::tempdir().unwrap();
        let mit_verweis = || {
            Some(shell_core::begleiter::BegleiterKonfig {
                programm: "sh".into(),
                args: vec!["-c".into(), "exec sleep 30".into()],
                env: std::collections::BTreeMap::from([("T".to_string(), "{tresor:fehlt}".to_string())]),
                frist_s: 1,
                ..Default::default()
            })
        };
        let h = Huelle::laden(Profil::Studio, "0.0.1", Pfade::neu(d.path())).unwrap();
        sperre(&h.einstellungen).begleiter = mit_verweis();
        assert_eq!(h.begleiter_starten().unwrap_err().code(), "TRESOR_EINTRAG_FEHLT");
        assert!(sperre(&h.begleiter).is_none(), "es darf kein Prozess gestartet worden sein");

        let kein = Huelle::laden(Profil::Studio, "0.0.1", Pfade::neu(d.path()))
            .unwrap()
            .mit_tresor(Arc::new(shell_core::tresor::KeinTresor("Dienst läuft nicht".into())));
        sperre(&kein.einstellungen).begleiter = mit_verweis();
        let f = kein.begleiter_starten().unwrap_err();
        assert_eq!(f.code(), "TRESOR_NICHT_VERFUEGBAR");
        assert!(!f.meldung().abhilfe.is_empty());
    }

    #[test]
    fn bericht_sammelt_stehende_meldungen_ohne_doppelte_und_ohne_geheimnisse() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("einstellungen.json"), "{kaputt").unwrap(); // -> Warnung EINSTELLUNGEN_KAPUTT
        std::fs::write(d.path().join("begleiter.log"), "start\nHF_TOKEN=hf_klartext_geheim_1\n").unwrap();
        let h = Huelle::laden(Profil::Studio, "0.0.2", Pfade::neu(d.path())).unwrap();
        sperre(&h.einstellungen).begleiter = Some(shell_core::begleiter::BegleiterKonfig { programm: "/gibt/es/nicht".into(), ..Default::default() });
        let _ = h.begleiter_starten(); // BEGLEITER_STARTET_NICHT
        let gesehen = Fehler::SignaturFalsch.meldung();
        let b = h.bericht("FLE Studio", Some(gesehen.clone()));
        let codes: Vec<&str> = b.meldungen.iter().map(|m| m.code.as_str()).collect();
        assert_eq!(codes, ["EINSTELLUNGEN_KAPUTT", "BEGLEITER_STARTET_NICHT", "UPDATE_SIGNATUR_FALSCH"]);
        let doppelt = h.bericht("FLE Studio", Some(h.bericht("x", None).meldungen[0].clone()));
        assert_eq!(doppelt.meldungen.len(), 2, "dieselbe Meldung nicht zweimal");
        let text = b.text();
        assert!(text.contains("Ursache:") && text.contains("Abhilfe:") && text.contains("0.0.2"));
        assert!(!text.contains("hf_klartext_geheim_1"));
        let datei = shell_core::bericht::speichern(&d.path().join("berichte"), &b).unwrap();
        assert!(datei.is_file());
    }

    fn fake_buendel(ordner: &std::path::Path) -> Buendel {
        std::fs::create_dir_all(ordner.join("studio")).unwrap();
        std::fs::create_dir_all(ordner.join("shim")).unwrap();
        std::fs::create_dir_all(ordner.join("python/bin")).unwrap();
        std::fs::write(ordner.join("shim/begleiter_shim.py"), "#").unwrap();
        std::fs::write(ordner.join("python/bin/python3.11"), "x").unwrap();
        std::fs::write(
            ordner.join("buendel.json"),
            r#"{"format":1,"system":"macos-aarch64","python":{"version":"3.11.18","interpreter":"python/bin/python3.11"},"studio":{"version":"0.4.1","ordner":"studio"},"shim":"shim/begleiter_shim.py"}"#,
        )
        .unwrap();
        Buendel::lesen(ordner).unwrap().unwrap()
    }

    #[test]
    fn begleiter_aus_dem_buendel_nur_im_profil_studio_und_einstellung_hat_vorrang() {
        let d = tempfile::tempdir().unwrap();
        let b = fake_buendel(&d.path().join("res"));
        let studio = Huelle::laden(Profil::Studio, "0.0.1", Pfade::neu(d.path().join("daten"))).unwrap().mit_buendel(Some(b.clone()));
        let (k, quelle) = studio.begleiter_konfig().unwrap();
        assert_eq!(quelle, "Bündel");
        assert!(k.programm.ends_with("python/bin/python3.11") && k.args.iter().any(|a| a == "fle_studio"));
        assert!(k.args.iter().any(|a| a.ends_with("studio-home")), "Daten des Studios im Datenordner, nicht im Paket");

        // eine Einstellung des Nutzers hat Vorrang vor dem Bündel
        sperre(&studio.einstellungen).begleiter = Some(shell_core::begleiter::BegleiterKonfig { programm: "/mein/studio".into(), ..Default::default() });
        let (k, quelle) = studio.begleiter_konfig().unwrap();
        assert_eq!((k.programm.as_str(), quelle), ("/mein/studio", "Einstellungen"));

        // andere Profile bekommen nie einen Begleiter, auch wenn ein Bündel da wäre
        let os = Huelle::laden(Profil::Os, "0.0.1", Pfade::neu(d.path().join("daten2"))).unwrap().mit_buendel(Some(b));
        assert!(os.begleiter_konfig().is_none());
        // Studio ohne Bündel und ohne Einstellung: keiner
        let leer = Huelle::laden(Profil::Studio, "0.0.1", Pfade::neu(d.path().join("daten3"))).unwrap();
        assert!(leer.begleiter_konfig().is_none());
        leer.begleiter_starten().unwrap();
        assert!(matches!(*sperre(&leer.begleiter_stand), BegleiterStand::Keiner));
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
