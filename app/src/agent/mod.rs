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
use shell_core::agent::adressfolge::{self, Fehlschlag};
use shell_core::tresor;
use shell_core::Fehler;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Mutex};

/// Der Runner, mit dem die Brücke spricht: Adresse und Token stehen nur hier, nie in der Seite.
#[derive(Clone, Debug)]
pub struct Ziel {
    /// Erste Adresse (Reihenfolge der Einstellungen).
    pub basis: String,
    /// Rückfalladresse (zweite), falls eingetragen.
    pub rueckfall: Option<String>,
    pub token: String,
}

impl Ziel {
    /// Beide Adressen in der Reihenfolge der Einstellungen.
    pub fn basen(&self) -> Vec<String> {
        std::iter::once(self.basis.clone()).chain(self.rueckfall.clone()).collect()
    }

    #[cfg(test)]
    pub fn hat_rueckfall(&self) -> bool {
        self.rueckfall.is_some()
    }
}

/// Laufender Zustand des Profils (Tauri-frei: Zähler, Ziel-Zwischenspeicher, offene Ströme).
#[derive(Default)]
pub struct AgentZustand {
    /// Aufgelöstes Ziel; wird nach jeder Änderung der Verbindungseinstellungen verworfen, damit der Tresor nicht bei jeder Anfrage gefragt wird.
    pub ziel: Mutex<Option<Ziel>>,
    /// Die Adresse, die zuletzt geantwortet hat (nur im Arbeitsspeicher, nie in den Einstellungen): sie wird bei der nächsten Anfrage zuerst
    /// versucht. Wird mit dem Ziel verworfen, damit nach geänderten Einstellungen deren Reihenfolge gilt.
    pub gut: Mutex<Option<String>>,
    /// Offene Ereignisströme je Kanal; das Flag beendet den Faden.
    pub strome: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub verbunden: AtomicBool,
    pub offene: AtomicUsize,
    pub laeufe: AtomicUsize,
    /// Was die Chat-Seite zuletzt gemeldet hat: Kopfzustand (`bereit`, `arbeitet`, …) und ob ein Zug läuft.
    pub kopf: Mutex<(String, bool)>,
    /// Das Chat-Fenster wurde durch die Freigaben-Zeile im Tray geöffnet und soll sein Freigaben-Panel zeigen: die frisch geladene Seite holt das
    /// Flag mit `ziel_info` ab (ein schon offenes Fenster bekommt stattdessen das Ereignis `freigaben-zeigen`).
    pub freigaben_zeigen: AtomicBool,
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
        *sperre(&self.gut) = None;
        self.verbunden.store(false, SeqCst);
        self.offene.store(0, SeqCst);
        self.laeufe.store(0, SeqCst);
    }
}

impl AgentZustand {
    /// Führt `versuch(basis, hat_weitere)` auf den Adressen des Ziels aus: zuerst die zuletzt funktionierende, bei einem Verbindungsfehler die
    /// andere (Regeln und Fehlertext: `shell_core::agent::adressfolge`). Die Adresse, die geantwortet hat, wird gemerkt.
    pub fn versuchen<T>(&self, ziel: &Ziel, versuch: impl FnMut(&str, bool) -> Result<T, Fehlschlag>) -> Result<T, Fehler> {
        let gut = sperre(&self.gut).clone();
        let d = adressfolge::durchlaufen(&ziel.basen(), gut.as_deref(), versuch);
        if let Some(b) = d.antwortete {
            *sperre(&self.gut) = Some(b);
        }
        d.ergebnis
    }

    /// Die Adresse, die zuletzt geantwortet hat (sonst `None`).
    pub fn genutzt(&self) -> Option<String> {
        sperre(&self.gut).clone()
    }

    /// Hat der Strom auf `basis` eine andere Adresse als die inzwischen bevorzugte (eine Anfrage hat gewechselt)? Dann wird der Strom neu geöffnet.
    pub fn strom_veraltet(&self, basis: &str) -> bool {
        sperre(&self.gut).as_deref().is_some_and(|g| g != basis)
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
            Ok(Ziel { basis, rueckfall: None, token })
        }
        shell_core::agent::runner::Art::Entfernt => {
            let (n1, n2) = shell_core::agent::runner::adressen_pruefen(r.adresse.as_deref().unwrap_or(""), r.adresse2.as_deref())?;
            Ok(Ziel { basis: n1.basis, rueckfall: n2.map(|n| n.basis), token: token_aufloesen(h, &r.token)? })
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

    fn mit_zwei_adressen(erste: &str, zweite: Option<&str>) -> (tempfile::TempDir, Huelle) {
        use shell_core::agent::runner::RunnerEintrag;
        let (d, h) = huelle(Arc::new(KeinTresor("nicht benutzt".into())));
        sperre(&h.einstellungen).agent.runner_setzen(RunnerEintrag { id: "fern".into(), name: "Fern".into(), adresse: Some(erste.into()), adresse2: zweite.map(Into::into), ..Default::default() });
        (d, h)
    }

    #[test]
    fn zwei_adressen_werden_geprueft_aufgeloest_und_ohne_zweite_aendert_sich_nichts() {
        let (_d, h) = mit_zwei_adressen("heim:18438", Some("fern:18438"));
        let ziel = z(&h).unwrap();
        assert_eq!(ziel.basen(), ["http://heim:18438", "http://fern:18438"]);
        assert!(ziel.hat_rueckfall());
        let (_d, h) = mit_zwei_adressen("heim:18438", None);
        let ziel = z(&h).unwrap();
        assert_eq!((ziel.basen(), ziel.hat_rueckfall()), (vec!["http://heim:18438".to_string()], false));
        // Adresse aus dem Tunnelnetz als Rückfall ist erlaubt, eine öffentliche ohne https nicht (Katalogfehler, bevor etwas verbunden wird)
        let (_d, h) = mit_zwei_adressen("heim:18438", Some("http://100.64.0.6:18438"));
        assert!(z(&h).is_ok());
        let (_d, h) = mit_zwei_adressen("heim:18438", Some("http://runner.example.org"));
        assert_eq!(z(&h).unwrap_err().code(), "RUNNER_ADRESSE_UNSICHER");
        // eine kaputte zweite Adresse verhindert nicht das Lesen alter Einstellungen ohne zweite
        let (_d, h) = mit_zwei_adressen("fern:1", Some(""));
        assert!(!z(&h).unwrap().hat_rueckfall());
    }

    fn anfragen(az: &AgentZustand, ziel: &Ziel) -> Result<serde_json::Value, Fehler> {
        az.versuchen(ziel, |basis, weitere| http::anfrage_folge("GET", &format!("{basis}/api/health"), "", None, std::time::Duration::from_secs(3), bruecke::verbinden_frist(weitere)))
    }

    #[test]
    fn rueckfall_nur_bei_verbindungsfehler_merken_und_zurueckwechseln() {
        use http::attrappe::{server, tote_basis, GESUND, NEIN_401};
        let tot = tote_basis();
        let (lebt, _) = server(GESUND);
        let az = AgentZustand::neu();
        let ziel = Ziel { basis: tot.clone(), rueckfall: Some(lebt.clone()), token: String::new() };
        // erste tot, zweite lebt: Verbindung kommt, die zweite wird gemerkt
        assert_eq!(anfragen(&az, &ziel).unwrap()["ok"], true);
        assert_eq!(az.genutzt().as_deref(), Some(lebt.as_str()));
        // beide lebendig: es bleibt bei der zuletzt funktionierenden (die erste wird gar nicht erst angefragt)
        let (erste_lebt, gesehen_erste) = server(GESUND);
        let ziel2 = Ziel { basis: erste_lebt.clone(), rueckfall: Some(lebt.clone()), token: String::new() };
        assert!(anfragen(&az, &ziel2).is_ok());
        assert_eq!(az.genutzt().as_deref(), Some(lebt.as_str()));
        assert!(gesehen_erste.lock().unwrap().is_empty(), "die erste Adresse wurde nicht angefragt");
        // die gemerkte fällt aus (tot), die erste lebt: zurück zur ersten
        let ziel3 = Ziel { basis: erste_lebt.clone(), rueckfall: Some(tote_basis()), token: String::new() };
        *sperre(&az.gut) = ziel3.rueckfall.clone();
        assert!(anfragen(&az, &ziel3).is_ok());
        assert_eq!(az.genutzt().as_deref(), Some(erste_lebt.as_str()));
        assert!(!gesehen_erste.lock().unwrap().is_empty());
        // beide tot: ein Fehler, der beide Adressen nennt
        let (a1, a2) = (tote_basis(), tote_basis());
        let ziel4 = Ziel { basis: a1.clone(), rueckfall: Some(a2.clone()), token: String::new() };
        let f = anfragen(&AgentZustand::neu(), &ziel4).unwrap_err();
        assert_eq!(f.code(), "RUNNER_NICHT_ERREICHBAR");
        let det = f.meldung().details.unwrap();
        assert!(det.contains(&a1) && det.contains(&a2), "{det}");
        // 401 der ersten wechselt nicht: die zweite sieht keine Anfrage und kein Token
        let (abgelehnt, _) = server(NEIN_401);
        let (zweite, gesehen_zweite) = server(GESUND);
        let ziel5 = Ziel { basis: abgelehnt.clone(), rueckfall: Some(zweite), token: String::new() };
        let az5 = AgentZustand::neu();
        assert_eq!(anfragen(&az5, &ziel5).unwrap_err().code(), "TOKEN_ABGELEHNT");
        assert!(gesehen_zweite.lock().unwrap().is_empty());
        assert_eq!(az5.genutzt().as_deref(), Some(abgelehnt.as_str()), "dort läuft ein Runner");
    }

    #[test]
    fn gemerkte_adresse_gilt_nur_bis_zur_naechsten_einstellungsaenderung() {
        let az = AgentZustand::neu();
        *sperre(&az.gut) = Some("http://fern:18438".into());
        assert!(az.strom_veraltet("http://heim:18438"), "ein Strom auf der anderen Adresse wird neu geöffnet");
        assert!(!az.strom_veraltet("http://fern:18438"));
        az.ziel_vergessen();
        assert_eq!(az.genutzt(), None, "nach geänderten Einstellungen zählt wieder deren Reihenfolge");
        assert!(!az.strom_veraltet("http://irgendeine:1"));
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
