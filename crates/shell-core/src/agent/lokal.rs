//! Lokaler Runner: ein **optionales Fremdprogramm**, das die Hülle als Kindprozess startet. Die Hülle liefert keinen Runner mit (sie ist
//! öffentlich); sie kennt nur diesen Vertrag. Hier stehen die reinen Teile (Startwerte, Umgebung, Wartezeiten); Prozess und Netz stehen in
//! `app/src/agent/lokal.rs`, die Prozessverwaltung (Gruppe, SIGTERM, Zombie) in [`crate::begleiter::Kindprozess`].
//!
//! **Vertrag (Version 1)** – was das Programm erfüllen muss:
//! - Start mit den Argumenten aus der Vorlage der Einstellungen (`{port}`, `{ordner}` werden ersetzt) und dieser Umgebung:
//!   `FYOS_RUNNER_PORT` (TCP-Port), `FYOS_RUNNER_TOKEN` (64 Hexzeichen, nur in der Umgebung, nie in Argumenten),
//!   `FYOS_RUNNER_ORDNER_ERLAUBT` (erlaubte Wurzeln, absolute Pfade, getrennt durch `:` bzw. `;` unter Windows; kann leer sein),
//!   `FYOS_RUNNER_HOST` (immer `127.0.0.1`), `FYOS_RUNNER_DATEN` (Ordner für seinen eigenen Zustand).
//! - Bindet **nur** an `127.0.0.1:<FYOS_RUNNER_PORT>` und verlangt bei jeder Anfrage `Authorization: Bearer <FYOS_RUNNER_TOKEN>` (sonst 401).
//! - `GET /api/health` → `200 {"ok": true, …}` (Bereitschaft; die Hülle wartet bis zu 30 s darauf).
//! - Die Schnittstelle für entfernte Runner: `GET /api/ordner?pfad=<absolut, optional>`, `POST /api/gespraeche` mit `ordner`, `agent.cwd`;
//!   Ordner außerhalb der Wurzeln → 403 `{"fehler":"ausserhalb"}`.
//! - Zusätzlich nur lokal: `POST /api/ordner/erlauben` mit `{"pfad": "<absolut>"}` → `200 {"wurzeln": [...]}` nimmt einen vom Nutzer im
//!   Systemdialog gewählten Ordner zu den Wurzeln dieses Prozesses hinzu (gilt bis zum Ende des Prozesses; die Hülle meldet ihn nach einem
//!   Neustart über `FYOS_RUNNER_ORDNER_ERLAUBT` erneut). Nur die Hülle ruft diesen Weg; die Seite darf ihn nicht.
//! - Endet bei SIGTERM sauber binnen 8 s (danach SIGKILL der ganzen Prozessgruppe); schreibt Protokoll nach stdout/stderr (landet in `lokaler-runner.log`).

use crate::begleiter::{neue_kennung, BegleiterKonfig};
use crate::fehler::Fehler;
use std::collections::BTreeMap;
use std::path::Path;

use super::runner::LokalKonfig;

pub const ENV_PORT: &str = "FYOS_RUNNER_PORT";
pub const ENV_TOKEN: &str = "FYOS_RUNNER_TOKEN";
pub const ENV_ORDNER: &str = "FYOS_RUNNER_ORDNER_ERLAUBT";
pub const ENV_HOST: &str = "FYOS_RUNNER_HOST";
pub const ENV_DATEN: &str = "FYOS_RUNNER_DATEN";
/// So lange darf der Start bis zur ersten gesunden Antwort dauern.
pub const START_FRIST_S: u64 = 30;

/// Zufälliges Token für einen Start: 256 Bit als 64 Hexzeichen. Es lebt nur im Arbeitsspeicher der Hülle und in der Umgebung des Kindprozesses.
pub fn neues_token() -> String {
    format!("{}{}", neue_kennung(), neue_kennung())
}

/// Die Liste der Wurzeln für die Umgebung.
pub fn ordner_liste(ordner: &[String]) -> String {
    let trenner = if cfg!(windows) { ";" } else { ":" };
    ordner.join(trenner)
}

/// Startwerte aus der Einstellung: Vorlage der Argumente mit Port und erstem Ordner, dazu die Umgebung des Vertrags.
/// Fehler: kein Programm eingestellt, oder der Pfad ist nicht absolut / keine Datei.
pub fn start_konfig(k: &LokalKonfig, port: u16, token: &str, ordner: &[String], daten: &Path) -> Result<BegleiterKonfig, Fehler> {
    let programm = k.programm.trim();
    if programm.is_empty() {
        return Err(Fehler::LokalerRunnerNichtEingerichtet);
    }
    let start_nicht = |g: &str| Fehler::LokalerRunnerStartetNicht { grund: g.to_string() };
    let p = Path::new(programm);
    if !p.is_absolute() {
        return Err(start_nicht("der Pfad des Programms ist nicht absolut"));
    }
    if !p.is_file() {
        return Err(start_nicht(&format!("{programm} ist keine Datei")));
    }
    let erster = ordner.first().map(String::as_str).unwrap_or("");
    let ersetze = |s: &str| s.replace("{port}", &port.to_string()).replace("{ordner}", erster);
    let env: BTreeMap<String, String> = BTreeMap::from([
        (ENV_PORT.to_string(), port.to_string()),
        (ENV_TOKEN.to_string(), token.to_string()),
        (ENV_ORDNER.to_string(), ordner_liste(ordner)),
        (ENV_HOST.to_string(), "127.0.0.1".to_string()),
        (ENV_DATEN.to_string(), daten.display().to_string()),
    ]);
    Ok(BegleiterKonfig {
        programm: programm.to_string(),
        args: k.args.iter().map(|a| ersetze(a)).collect(),
        env,
        frist_s: START_FRIST_S,
        port: Some(port),
    })
}

/// Wartezeit vor dem n-ten Neustart nach unerwartetem Ende: 1, 2, 4, 8, 15, dann 30 s.
pub fn neustart_wartezeit_ms(versuch: u32) -> u64 {
    match versuch {
        0 => 1000,
        1 => 2000,
        2 => 4000,
        3 => 8000,
        4 => 15_000,
        _ => 30_000,
    }
}

/// Lief der Prozess so lange, gilt der Start als stabil und die Wartetreppe beginnt wieder bei 1 s.
pub const STABIL_NACH_S: u64 = 60;

#[cfg(test)]
mod tests {
    use super::*;

    fn datei() -> (tempfile::TempDir, String) {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("runner");
        std::fs::write(&p, "#!/bin/sh\n").unwrap();
        let s = p.display().to_string();
        (d, s)
    }

    #[test]
    fn startwerte_setzen_port_ordner_und_umgebung_nach_vertrag() {
        let (d, prog) = datei();
        let k = LokalKonfig { programm: prog.clone(), args: vec!["--port".into(), "{port}".into(), "--start={ordner}".into()] };
        let c = start_konfig(&k, 4711, "t".repeat(64).as_str(), &["/probe/a".into(), "/probe/b".into()], d.path()).unwrap();
        assert_eq!(c.programm, prog);
        assert_eq!(c.args, ["--port", "4711", "--start=/probe/a"]);
        assert_eq!(c.env[ENV_PORT], "4711");
        assert_eq!(c.env[ENV_HOST], "127.0.0.1");
        assert_eq!(c.env[ENV_TOKEN].len(), 64);
        let trenner = if cfg!(windows) { ';' } else { ':' };
        assert_eq!(c.env[ENV_ORDNER], format!("/probe/a{trenner}/probe/b"));
        assert_eq!(c.env[ENV_DATEN], d.path().display().to_string());
        assert!(c.args.iter().all(|a| !a.contains(&"t".repeat(64))), "das Token steht nie in den Argumenten");
    }

    #[test]
    fn ohne_ordner_ist_die_liste_leer_und_die_vorlage_bekommt_nichts() {
        let (d, prog) = datei();
        let k = LokalKonfig { programm: prog, args: vec!["--start={ordner}".into()] };
        let c = start_konfig(&k, 1, "x", &[], d.path()).unwrap();
        assert_eq!(c.env[ENV_ORDNER], "");
        assert_eq!(c.args, ["--start="]);
    }

    #[test]
    fn programm_muss_eingestellt_absolut_und_eine_datei_sein() {
        let d = tempfile::tempdir().unwrap();
        let ohne = LokalKonfig::default();
        assert_eq!(start_konfig(&ohne, 1, "x", &[], d.path()).unwrap_err().code(), "LOKALER_RUNNER_NICHT_EINGERICHTET");
        for schlecht in ["runner", "./runner", "/gibt/es/nicht", &d.path().display().to_string()] {
            let k = LokalKonfig { programm: schlecht.into(), args: vec![] };
            assert_eq!(start_konfig(&k, 1, "x", &[], d.path()).unwrap_err().code(), "LOKALER_RUNNER_STARTET_NICHT", "{schlecht}");
        }
    }

    #[test]
    fn tokens_sind_lang_zufaellig_und_hex() {
        let (a, b) = (neues_token(), neues_token());
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn wartetreppe_wird_laenger_und_endet_bei_30_s() {
        let w: Vec<u64> = (0..8).map(neustart_wartezeit_ms).collect();
        assert_eq!(w, [1000, 2000, 4000, 8000, 15_000, 30_000, 30_000, 30_000]);
    }
}
