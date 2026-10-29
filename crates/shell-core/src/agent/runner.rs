//! Liste der Runner (Profil Agent): entfernte Runner (Adresse und Token im Tresor) und der lokale Runner (ein Programm, das die Hülle
//! selbst als Kindprozess startet, siehe [`super::lokal`]). Alles hier ist rein und getestet.
//!
//! Die Liste steht in `einstellungen.json` unter `agent.runner`. Sie enthält nie ein Token, nur den Verweis `{tresor:NAME}`; ein lokaler
//! Runner hat gar keinen Eintrag im Tresor (sein Token entsteht bei jedem Start neu und lebt nur im Arbeitsspeicher).

use super::{AgentEinst, TOKEN_VERWEIS};
use crate::fehler::Fehler;
use serde::{Deserialize, Serialize};

/// Höchstens so viele zuletzt benutzte Ordner je Runner.
pub const ZULETZT_MAX: usize = 8;
/// Kennung des lokalen Runners in der Liste.
pub const LOKAL_ID: &str = "lokal";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Art {
    /// Läuft anderswo (eigener Rechner, LAN, Tunnel): Adresse und Token im Tresor.
    Entfernt,
    /// Programm auf diesem Rechner, von der Hülle gestartet und beaufsichtigt.
    Lokal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RunnerEintrag {
    /// Kurze Kennung (Kleinbuchstaben, Ziffern, `-`); bestimmt auch den Namen des Tresor-Eintrags.
    pub id: String,
    pub name: String,
    pub art: Art,
    /// Nur `entfernt`: Basis-Adresse.
    pub adresse: Option<String>,
    /// Nur `entfernt`: Verweis `{tresor:NAME}` oder leer (kein Token nötig).
    pub token: String,
}

impl Default for RunnerEintrag {
    fn default() -> Self {
        RunnerEintrag { id: String::new(), name: String::new(), art: Art::Entfernt, adresse: None, token: String::new() }
    }
}

/// Wie der lokale Runner gestartet wird. `args` ist eine Vorlage: `{port}` und `{ordner}` (erster erlaubter Ordner) werden eingesetzt.
/// Das Token gehört nie in die Argumente (sichtbar in der Prozessliste), es geht nur über die Umgebung.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LokalKonfig {
    /// Absoluter Pfad des Programms; leer = nicht eingerichtet.
    pub programm: String,
    pub args: Vec<String>,
}

impl RunnerEintrag {
    pub fn lokal() -> RunnerEintrag {
        RunnerEintrag { id: LOKAL_ID.into(), name: "Dieser Rechner".into(), art: Art::Lokal, adresse: None, token: String::new() }
    }
}

/// Ein Name für die Anzeige aus einer Adresse (Rechnername).
pub fn name_aus_adresse(adresse: &str) -> String {
    let h = super::adresse::host_aus(adresse);
    if h.is_empty() { "Runner".into() } else { h }
}

/// Eine Kennung aus einem Namen: Kleinbuchstaben, Ziffern, `-`; bei Kollision mit `-2`, `-3` …
pub fn neue_id(name: &str, vorhandene: &[RunnerEintrag]) -> String {
    let mut basis: String = name.to_lowercase().chars().map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() { c } else { '-' }).collect();
    basis = basis.split('-').filter(|t| !t.is_empty()).collect::<Vec<_>>().join("-");
    if basis.is_empty() || basis == LOKAL_ID {
        basis = "runner".into();
    }
    basis.truncate(24);
    let mut kandidat = basis.clone();
    let mut n = 1;
    while vorhandene.iter().any(|r| r.id == kandidat) {
        n += 1;
        kandidat = format!("{basis}-{n}");
    }
    kandidat
}

/// Name des Tresor-Eintrags für das Token eines entfernten Runners. Der übernommene erste Runner behält `runner-token`.
pub fn token_name(id: &str) -> String {
    format!("runner-{id}")
}

pub fn token_verweis(id: &str) -> String {
    format!("{{tresor:{}}}", token_name(id))
}

impl AgentEinst {
    /// Übernimmt beim Start den bisherigen einzelnen Runner (`runner_adresse`, `runner_token`) als ersten Eintrag der Liste, wenn die Liste noch
    /// leer ist. Das Token bleibt im selben Tresor-Eintrag (`runner-token`): nichts muss neu eingegeben werden. Die alten Felder bleiben
    /// stehen (eine ältere Fassung der Hülle liest sie weiter). Liefert, ob etwas übernommen wurde.
    pub fn runner_uebernehmen(&mut self) -> bool {
        if !self.runner.is_empty() {
            return false;
        }
        let Some(adresse) = self.runner_adresse.clone().filter(|a| !a.trim().is_empty()) else { return false };
        let name = name_aus_adresse(&adresse);
        let id = neue_id(&name, &self.runner);
        let token = if self.runner_token.trim().is_empty() { String::new() } else { self.runner_token.clone() };
        self.runner.push(RunnerEintrag { id: id.clone(), name, art: Art::Entfernt, adresse: Some(adresse), token });
        self.aktiv_runner = Some(id);
        true
    }

    pub fn runner_finden(&self, id: &str) -> Option<&RunnerEintrag> {
        self.runner.iter().find(|r| r.id == id)
    }

    /// Der Runner, mit dem die Hülle gerade spricht: der gewählte, sonst der erste.
    pub fn aktiver(&self) -> Option<&RunnerEintrag> {
        self.aktiv_runner.as_deref().and_then(|id| self.runner_finden(id)).or_else(|| self.runner.first())
    }

    /// Ist ein Runner brauchbar eingetragen (entfernt mit Adresse, lokal immer)?
    pub fn eingerichtet(&self) -> bool {
        if self.runner.is_empty() {
            // noch nicht übernommen: der bisherige einzelne Runner zählt
            return self.runner_adresse.as_deref().is_some_and(|a| !a.trim().is_empty());
        }
        self.aktiver().is_some_and(|r| r.art == Art::Lokal || r.adresse.as_deref().is_some_and(|a| !a.trim().is_empty()))
    }

    /// Fügt einen Eintrag hinzu oder ersetzt den mit gleicher Kennung. Der lokale Runner kommt höchstens einmal vor.
    pub fn runner_setzen(&mut self, eintrag: RunnerEintrag) {
        match self.runner.iter_mut().find(|r| r.id == eintrag.id) {
            Some(r) => *r = eintrag,
            None => self.runner.push(eintrag),
        }
        if self.aktiv_runner.is_none() {
            self.aktiv_runner = self.runner.first().map(|r| r.id.clone());
        }
    }

    pub fn runner_entfernen(&mut self, id: &str) -> Result<RunnerEintrag, Fehler> {
        let i = self.runner.iter().position(|r| r.id == id).ok_or_else(|| Fehler::RunnerUnbekannt { id: id.to_string() })?;
        let weg = self.runner.remove(i);
        self.zuletzt.remove(id);
        if self.aktiv_runner.as_deref() == Some(id) {
            self.aktiv_runner = self.runner.first().map(|r| r.id.clone());
        }
        Ok(weg)
    }

    pub fn aktiv_setzen(&mut self, id: &str) -> Result<(), Fehler> {
        if self.runner_finden(id).is_none() {
            return Err(Fehler::RunnerUnbekannt { id: id.to_string() });
        }
        self.aktiv_runner = Some(id.to_string());
        Ok(())
    }

    /// Merkt einen Ordner als zuletzt benutzt (vorn, ohne Doppelte, höchstens [`ZULETZT_MAX`]).
    pub fn ordner_merken(&mut self, runner_id: &str, pfad: &str) -> Result<(), Fehler> {
        let pfad = ordner_pruefen(pfad)?;
        let liste = self.zuletzt.entry(runner_id.to_string()).or_default();
        liste.retain(|p| *p != pfad);
        liste.insert(0, pfad);
        liste.truncate(ZULETZT_MAX);
        Ok(())
    }

    pub fn ordner_zuletzt(&self, runner_id: &str) -> Vec<String> {
        self.zuletzt.get(runner_id).cloned().unwrap_or_default()
    }
}

/// Ein Arbeitsordner: nicht leer, höchstens 1024 Zeichen, keine Steuerzeichen, absolut (Unix `/…`, Windows `C:\…` oder `\\…`).
pub fn ordner_pruefen(pfad: &str) -> Result<String, Fehler> {
    let p = pfad.trim();
    let unbrauchbar = |g: &str| Fehler::OrdnerUnbrauchbar { grund: g.to_string() };
    if p.is_empty() {
        return Err(unbrauchbar("leer"));
    }
    if p.chars().count() > 1024 {
        return Err(unbrauchbar("zu lang"));
    }
    if p.chars().any(char::is_control) {
        return Err(unbrauchbar("Steuerzeichen im Pfad"));
    }
    let b = p.as_bytes();
    let windows = (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')) || p.starts_with("\\\\");
    if !(p.starts_with('/') || windows) {
        return Err(unbrauchbar("kein absoluter Pfad"));
    }
    if p.split(['/', '\\']).any(|t| t == "..") {
        return Err(unbrauchbar("enthält .."));
    }
    Ok(p.to_string())
}

/// Der letzte Ordnername eines Pfads (für Anzeigen).
pub fn ordner_name(pfad: &str) -> String {
    let t = pfad.trim_end_matches(['/', '\\']);
    t.rsplit(['/', '\\']).next().filter(|s| !s.is_empty()).unwrap_or(t).to_string()
}

/// Das Ergebnis für die Seite: Liste ohne Geheimnisse (nicht einmal der Verweis), mit Markierung des aktiven.
pub fn liste_json(e: &AgentEinst, lokal_status: &str) -> serde_json::Value {
    let aktiv = e.aktiver().map(|r| r.id.clone());
    let eintraege: Vec<serde_json::Value> = e
        .runner
        .iter()
        .map(|r| {
            serde_json::json!({
                "id": r.id, "name": r.name, "art": r.art,
                "adresse": r.adresse,
                "hat_token": !r.token.trim().is_empty(),
                "aktiv": aktiv.as_deref() == Some(r.id.as_str()),
                "status": if r.art == Art::Lokal { lokal_status } else { "" },
            })
        })
        .collect();
    serde_json::json!({ "runner": eintraege, "aktiv": aktiv, "lokal": { "programm_gesetzt": !e.lokal.programm.trim().is_empty() } })
}

/// Hilfsfunktion für Tests und Migration: der Standard-Verweis des ersten Runners.
pub fn ist_standard_verweis(v: &str) -> bool {
    v == TOKEN_VERWEIS
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alt(adresse: &str) -> AgentEinst {
        AgentEinst { runner_adresse: Some(adresse.into()), ..Default::default() }
    }

    #[test]
    fn bisheriger_einzelner_runner_wird_uebernommen_mit_demselben_token() {
        let mut e = alt("http://rechner:18438");
        assert!(e.runner_uebernehmen());
        assert_eq!(e.runner.len(), 1);
        let r = &e.runner[0];
        assert_eq!((r.id.as_str(), r.name.as_str(), r.art), ("rechner", "rechner", Art::Entfernt));
        assert_eq!(r.adresse.as_deref(), Some("http://rechner:18438"));
        assert_eq!(r.token, "{tresor:runner-token}", "kein erneutes Einrichten: derselbe Tresor-Eintrag");
        assert_eq!(e.aktiv_runner.as_deref(), Some("rechner"));
        assert!(!e.runner_uebernehmen(), "nur einmal");
        assert_eq!(e.runner_adresse.as_deref(), Some("http://rechner:18438"), "alte Felder bleiben für ältere Fassungen");
    }

    #[test]
    fn ohne_alten_runner_bleibt_die_liste_leer() {
        let mut e = AgentEinst::default();
        assert!(!e.runner_uebernehmen());
        assert!(!e.eingerichtet());
        let mut leer = alt("   ");
        assert!(!leer.runner_uebernehmen());
    }

    #[test]
    fn alter_runner_ohne_token_verweis_bekommt_keinen() {
        let mut e = AgentEinst { runner_adresse: Some("localhost:1".into()), runner_token: String::new(), ..Default::default() };
        e.runner_uebernehmen();
        assert_eq!(e.runner[0].token, "");
    }

    #[test]
    fn kennungen_sind_eindeutig_und_nie_lokal() {
        let mut liste = vec![];
        for _ in 0..3 {
            let id = neue_id("Mein Runner!", &liste);
            liste.push(RunnerEintrag { id, ..Default::default() });
        }
        let ids: Vec<&str> = liste.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["mein-runner", "mein-runner-2", "mein-runner-3"]);
        assert_eq!(neue_id("lokal", &[]), "runner");
        assert_eq!(neue_id("äöü", &[]), "runner");
        assert!(crate::tresor::name_pruefen(&token_name(&neue_id("X y", &[]))).is_ok());
    }

    #[test]
    fn aktiv_wechseln_entfernen_und_unbekannt() {
        let mut e = AgentEinst::default();
        e.runner_setzen(RunnerEintrag { id: "a".into(), name: "A".into(), adresse: Some("http://a:1".into()), ..Default::default() });
        e.runner_setzen(RunnerEintrag::lokal());
        assert_eq!(e.aktiver().unwrap().id, "a");
        e.aktiv_setzen("lokal").unwrap();
        assert_eq!(e.aktiver().unwrap().art, Art::Lokal);
        assert!(e.eingerichtet());
        assert_eq!(e.aktiv_setzen("nix").unwrap_err().code(), "RUNNER_UNBEKANNT");
        e.ordner_merken("lokal", "/probe/x").unwrap();
        e.runner_entfernen("lokal").unwrap();
        assert_eq!(e.aktiver().unwrap().id, "a", "nach dem Entfernen des aktiven gilt der erste");
        assert!(e.ordner_zuletzt("lokal").is_empty(), "die gemerkten Ordner gehen mit");
        assert_eq!(e.runner_entfernen("lokal").unwrap_err().code(), "RUNNER_UNBEKANNT");
    }

    #[test]
    fn zuletzt_benutzte_ordner_vorn_ohne_doppelte_begrenzt() {
        let mut e = AgentEinst::default();
        for i in 0..12 {
            e.ordner_merken("r", &format!("/probe/{i}")).unwrap();
        }
        e.ordner_merken("r", "/probe/5").unwrap();
        let z = e.ordner_zuletzt("r");
        assert_eq!(z.len(), ZULETZT_MAX);
        assert_eq!(z[0], "/probe/5");
        assert_eq!(z.iter().filter(|p| *p == "/probe/5").count(), 1);
        assert!(e.ordner_zuletzt("anderer").is_empty());
    }

    #[test]
    fn ordner_werden_geprueft() {
        for gut in ["/probe/a", "/", "C:\\Probe\\a", "C:/Probe", "\\\\server\\freigabe", "  /probe/mit leerzeichen  "] {
            assert!(ordner_pruefen(gut).is_ok(), "{gut}");
        }
        for schlecht in ["", "  ", "relativ/pfad", "~/x", "/a/../b", "/a\nb", "..\\x"] {
            assert_eq!(ordner_pruefen(schlecht).unwrap_err().code(), "ORDNER_UNBRAUCHBAR", "{schlecht:?}");
        }
        assert_eq!(ordner_pruefen(&format!("/{}", "a".repeat(1100))).unwrap_err().code(), "ORDNER_UNBRAUCHBAR");
        assert_eq!(ordner_name("/probe/alpha/"), "alpha");
        assert_eq!(ordner_name("C:\\Probe\\beta"), "beta");
    }

    #[test]
    fn die_liste_fuer_die_seite_enthaelt_kein_token_und_keinen_verweis() {
        let mut e = alt("http://rechner:18438");
        e.runner_uebernehmen();
        e.runner_setzen(RunnerEintrag::lokal());
        let j = liste_json(&e, "laeuft").to_string();
        assert!(!j.contains("tresor") && !j.contains("runner-token"), "{j}");
        assert!(j.contains("\"hat_token\":true") && j.contains("\"status\":\"laeuft\""), "{j}");
    }

    #[test]
    fn die_liste_wird_ohne_geheimnisse_gespeichert_und_wieder_gelesen() {
        let d = tempfile::tempdir().unwrap();
        let p = crate::speicher::Pfade::neu(d.path());
        let mut ein = crate::einstellungen::Einstellungen::default();
        ein.agent = alt("https://runner.example.org");
        ein.agent.runner_uebernehmen();
        ein.agent.runner_setzen(RunnerEintrag::lokal());
        ein.agent.lokal = LokalKonfig { programm: "/probe/runner".into(), args: vec!["--port".into(), "{port}".into()] };
        ein.agent.ordner_merken("lokal", "/probe/a").unwrap();
        crate::einstellungen::speichern(&p, &ein).expect("Verweise, Programm und Ordner sind keine Geheimnisse");
        assert_eq!(crate::einstellungen::laden(&p).0.agent, ein.agent);
    }
}
