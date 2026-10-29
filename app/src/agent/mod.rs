//! Profil `agent`: lokales Chat-Fenster, Brücke zum Runner, Beobachter für offene Freigaben, Tray.
//!
//! Der Runner läuft **nicht** in der Hülle (er liegt auf einem anderen Rechner oder im eigenen Netz); die Hülle kennt nur Adresse und Token
//! (im Tresor) und spricht dessen `/api/…`. Die reinen Regeln stehen in `shell_core::agent`; hier steht das Netz und das Fenster.
//! Übersicht: `docs/current/FYOS-AGENT-HUELLE.md` im Monorepo bzw. der Abschnitt „Profil Agent“ in der README.

pub mod befehle;
pub mod beobachter;
pub mod bruecke;
pub mod fenster;
pub mod http;
pub mod lokal;
pub mod runner_befehle;
pub mod tray;

use crate::zustand::{sperre, Huelle};
use shell_core::agent::adresse;
use shell_core::tresor;
use shell_core::Fehler;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Mutex};

/// Der Runner, mit dem die Brücke spricht: Adresse und Token stehen nur hier, nie in der Seite.
#[derive(Clone, Debug)]
pub struct Ziel {
    pub basis: String,
    pub token: String,
}

/// Laufender Zustand des Profils (Tauri-frei: Zähler, Ziel-Zwischenspeicher, offene Ströme).
#[derive(Default)]
pub struct AgentZustand {
    /// Aufgelöstes Ziel; wird nach jeder Änderung der Verbindungseinstellungen verworfen, damit der Tresor nicht bei jeder Anfrage gefragt wird.
    pub ziel: Mutex<Option<Ziel>>,
    /// Offene Ereignisströme je Kanal; das Flag beendet den Faden.
    pub strome: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub verbunden: AtomicBool,
    pub offene: AtomicUsize,
    pub laeufe: AtomicUsize,
    /// Was die Chat-Seite zuletzt gemeldet hat: Kopfzustand (`bereit`, `arbeitet`, …) und ob ein Zug läuft.
    pub kopf: Mutex<(String, bool)>,
    /// Der lokale Runner (Fremdprogramm als Kindprozess), falls eingerichtet und gestartet.
    pub lokal: lokal::Lokal,
}

impl AgentZustand {
    pub fn neu() -> Self {
        AgentZustand { kopf: Mutex::new(("bereit".to_string(), false)), ..Default::default() }
    }

    /// Ziel aus dem Zwischenspeicher oder frisch aus Einstellungen und Tresor.
    pub fn ziel(&self, h: &Huelle) -> Result<Ziel, Fehler> {
        if let Some(z) = sperre(&self.ziel).clone() {
            return Ok(z);
        }
        let z = ziel_aufloesen(h, self)?;
        *sperre(&self.ziel) = Some(z.clone());
        Ok(z)
    }

    /// Nach geänderten Einstellungen: Ziel verwerfen und Zähler zurücksetzen (der Beobachter holt den neuen Stand).
    pub fn ziel_vergessen(&self) {
        use std::sync::atomic::Ordering::SeqCst;
        *sperre(&self.ziel) = None;
        self.verbunden.store(false, SeqCst);
        self.offene.store(0, SeqCst);
        self.laeufe.store(0, SeqCst);
    }
}

/// Löst den aktiven Runner auf: bei einem entfernten Adresse und Token aus Einstellungen und Tresor, beim lokalen Adresse und Token des
/// laufenden Kindprozesses (nur im Arbeitsspeicher). Fehlende Adresse, fehlendes Token, nicht laufender lokaler Runner sind Katalogfehler.
/// Steht in den Einstellungen nur der bisherige einzelne Runner, gilt er als erster Eintrag der Liste.
pub fn ziel_aufloesen(h: &Huelle, a: &AgentZustand) -> Result<Ziel, Fehler> {
    let mut e = sperre(&h.einstellungen).agent.clone();
    e.runner_uebernehmen();
    let r = e.aktiver().ok_or(Fehler::RunnerNichtEingerichtet)?.clone();
    match r.art {
        shell_core::agent::runner::Art::Lokal => {
            let (basis, token) = a.lokal.ziel().ok_or_else(|| Fehler::LokalerRunnerStartetNicht { grund: "der lokale Runner läuft nicht".into() })?;
            Ok(Ziel { basis, token })
        }
        shell_core::agent::runner::Art::Entfernt => {
            let n = adresse::normalisiere(r.adresse.as_deref().unwrap_or(""))?;
            Ok(Ziel { basis: n.basis, token: token_aufloesen(h, &r.token)? })
        }
    }
}

/// Token aus dem Verweis `{tresor:NAME}`; ein leerer Verweis heißt „kein Token“ (Runner auf dem eigenen Rechner ohne Schutz).
pub fn token_aufloesen(h: &Huelle, verweis: &str) -> Result<String, Fehler> {
    if verweis.trim().is_empty() {
        return Ok(String::new());
    }
    match tresor::aufloesen(verweis.trim(), &*h.tresor) {
        Err(Fehler::TresorEintragFehlt { .. }) => Err(Fehler::TokenFehlt),
        andere => andere,
    }
}

/// Für den Fehlerbericht: den letzten Runner-Fehler unter den stehenden Meldungen merken (je Code einmal), eine Verbindung löscht sie wieder.
pub fn merke_fehler(h: &Huelle, f: &Fehler) {
    let m = f.meldung();
    let mut w = sperre(&h.warnungen);
    w.retain(|x| !x.code.starts_with("RUNNER_") && !x.code.starts_with("TOKEN_"));
    w.push(m);
}

pub fn vergiss_fehler(h: &Huelle) {
    sperre(&h.warnungen).retain(|x| !x.code.starts_with("RUNNER_") && !x.code.starts_with("TOKEN_"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use shell_core::speicher::Pfade;
    use shell_core::tresor::{KeinTresor, SpeicherTresor, Tresor};
    use shell_core::Profil;

    fn huelle(tresor: Arc<dyn Tresor>) -> (tempfile::TempDir, Huelle) {
        let d = tempfile::tempdir().unwrap();
        let h = Huelle::laden(Profil::Agent, "0.0.1", Pfade::neu(d.path())).unwrap().mit_tresor(tresor);
        (d, h)
    }

    fn z(h: &Huelle) -> Result<Ziel, Fehler> {
        ziel_aufloesen(h, &AgentZustand::neu())
    }

    #[test]
    fn ohne_adresse_ist_der_runner_nicht_eingerichtet() {
        let (_d, h) = huelle(Arc::new(SpeicherTresor::default()));
        assert_eq!(z(&h).unwrap_err().code(), "RUNNER_NICHT_EINGERICHTET");
    }

    #[test]
    fn mehrere_runner_der_aktive_gilt_und_jeder_hat_sein_eigenes_token() {
        use shell_core::agent::runner::{token_verweis, RunnerEintrag};
        let t = Arc::new(SpeicherTresor::default());
        let (_d, h) = huelle(t.clone());
        t.schreiben("runner-token", "erstes-token-0123456789").unwrap();
        t.schreiben("runner-zweiter", "zweites-token-0123456789").unwrap();
        {
            let mut e = sperre(&h.einstellungen);
            e.agent.runner_adresse = Some("http://127.0.0.1:1".into());
            e.agent.runner_uebernehmen();
            e.agent.runner_setzen(RunnerEintrag { id: "zweiter".into(), name: "Zweiter".into(), adresse: Some("http://127.0.0.1:2".into()), token: token_verweis("zweiter"), ..Default::default() });
        }
        let ziel = |h: &Huelle| z(h).map(|z| (z.basis, z.token)).unwrap();
        assert_eq!(ziel(&h), ("http://127.0.0.1:1".to_string(), "erstes-token-0123456789".to_string()), "der übernommene erste Runner behält sein Token");
        sperre(&h.einstellungen).agent.aktiv_setzen("zweiter").unwrap();
        assert_eq!(ziel(&h), ("http://127.0.0.1:2".to_string(), "zweites-token-0123456789".to_string()));
    }

    #[test]
    fn lokaler_runner_ohne_laufendes_programm_ist_ein_katalogfehler() {
        use shell_core::agent::runner::RunnerEintrag;
        let (_d, h) = huelle(Arc::new(SpeicherTresor::default()));
        {
            let mut e = sperre(&h.einstellungen);
            e.agent.runner_setzen(RunnerEintrag::lokal());
        }
        assert_eq!(z(&h).unwrap_err().code(), "LOKALER_RUNNER_STARTET_NICHT");
    }

    #[test]
    fn token_kommt_aus_dem_tresor_und_fehlt_mit_katalogtext() {
        let t = Arc::new(SpeicherTresor::default());
        let (_d, h) = huelle(t.clone());
        sperre(&h.einstellungen).agent.runner_adresse = Some("http://127.0.0.1:18438".into());
        assert_eq!(ziel_aufloesen(&h, &AgentZustand::neu()).unwrap_err().code(), "TOKEN_FEHLT");
        t.schreiben("runner-token", "test-token-0123456789").unwrap();
        let z = ziel_aufloesen(&h, &AgentZustand::neu()).unwrap();
        assert_eq!((z.basis.as_str(), z.token.as_str()), ("http://127.0.0.1:18438", "test-token-0123456789"));
    }

    #[test]
    fn leerer_verweis_heisst_kein_token() {
        let (_d, h) = huelle(Arc::new(KeinTresor("nicht benutzt".into())));
        {
            let mut e = sperre(&h.einstellungen);
            e.agent.runner_adresse = Some("localhost:18438".into());
            e.agent.runner_token = String::new();
        }
        let z = ziel_aufloesen(&h, &AgentZustand::neu()).unwrap(); // der Tresor wird gar nicht berührt
        assert_eq!((z.basis.as_str(), z.token.as_str()), ("http://localhost:18438", ""));
    }

    #[test]
    fn tresor_ausfall_bleibt_ein_tresorfehler() {
        let (_d, h) = huelle(Arc::new(KeinTresor("Dienst läuft nicht".into())));
        sperre(&h.einstellungen).agent.runner_adresse = Some("http://127.0.0.1:1".into());
        assert_eq!(ziel_aufloesen(&h, &AgentZustand::neu()).unwrap_err().code(), "TRESOR_NICHT_VERFUEGBAR");
    }

    #[test]
    fn ziel_wird_zwischengespeichert_bis_es_vergessen_wird() {
        let t = Arc::new(SpeicherTresor::default());
        let (_d, h) = huelle(t.clone());
        sperre(&h.einstellungen).agent.runner_adresse = Some("http://127.0.0.1:1".into());
        t.schreiben("runner-token", "eins-eins-eins-eins").unwrap();
        let az = AgentZustand::neu();
        assert_eq!(az.ziel(&h).unwrap().token, "eins-eins-eins-eins");
        t.schreiben("runner-token", "zwei-zwei-zwei-zwei").unwrap();
        assert_eq!(az.ziel(&h).unwrap().token, "eins-eins-eins-eins", "kein Tresor-Zugriff pro Anfrage");
        az.ziel_vergessen();
        assert_eq!(az.ziel(&h).unwrap().token, "zwei-zwei-zwei-zwei");
    }

    #[test]
    fn runner_fehler_landen_im_bericht_und_verschwinden_bei_verbindung() {
        let (_d, h) = huelle(Arc::new(SpeicherTresor::default()));
        merke_fehler(&h, &Fehler::TokenAbgelehnt { status: 401 });
        merke_fehler(&h, &Fehler::RunnerNichtErreichbar { url: "u".into(), grund: "g".into() });
        let codes: Vec<String> = sperre(&h.warnungen).iter().map(|m| m.code.clone()).collect();
        assert_eq!(codes, ["RUNNER_NICHT_ERREICHBAR"], "nur der letzte Runner-Fehler bleibt");
        assert_eq!(h.bericht("FYOS Agent", None).meldungen.len(), 1);
        vergiss_fehler(&h);
        assert!(sperre(&h.warnungen).is_empty());
    }
}
