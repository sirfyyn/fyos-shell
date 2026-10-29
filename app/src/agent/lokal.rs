//! Lokaler Runner: startet das in den Einstellungen eingetragene Fremdprogramm als Kindprozess und beaufsichtigt es.
//! Vertrag und Startwerte: `shell_core::agent::lokal`; Prozessgruppe, höfliches und hartes Ende: `shell_core::begleiter::Kindprozess`.
//!
//! Port und Token entstehen bei jedem Start neu (Loopback, 256 Bit Zufall). Das Token lebt nur hier im Arbeitsspeicher und in der Umgebung
//! des Kindprozesses; weder Einstellungen noch Tresor noch Seite sehen es. Unerwartetes Ende: Neustart mit wachsender Verzögerung
//! (1, 2, 4, 8, 15, 30 s; nach 60 s Laufzeit beginnt die Treppe neu). App-Ende und SIGTERM der Hülle beenden das Programm samt Nachkommen.

use super::http;
use crate::zustand::Huelle;
use serde_json::json;
use shell_core::agent::adresse::api_url;
use shell_core::agent::lokal as vertrag;
use shell_core::agent::runner::{ordner_pruefen, LOKAL_ID};
use shell_core::begleiter::{freien_port, Begleiter, Kindprozess};
use shell_core::{Fehler, Meldung};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub const AUS: &str = "aus";
pub const STARTET: &str = "startet";
pub const LAEUFT: &str = "laeuft";
pub const NEUSTART: &str = "neustart";
pub const FEHLER: &str = "fehler";

fn sp<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

type StandWert = (&'static str, Option<Meldung>);

struct Lauf {
    stop: Arc<AtomicBool>,
    fertig: Arc<AtomicBool>,
    basis: String,
    token: String,
    wurzeln: Arc<Mutex<Vec<String>>>,
}

/// Zustand des lokalen Runners (in `AgentZustand`).
#[derive(Default)]
pub struct Lokal {
    lauf: Mutex<Option<Lauf>>,
    stand: Arc<Mutex<StandWert>>,
    /// Start und Stopp nacheinander, nie gleichzeitig
    reihe: Mutex<()>,
}

impl Lokal {
    /// Basis-Adresse und Token des laufenden (oder gerade neu startenden) Programms.
    pub fn ziel(&self) -> Option<(String, String)> {
        sp(&self.lauf).as_ref().map(|l| (l.basis.clone(), l.token.clone()))
    }

    pub fn stand(&self) -> StandWert {
        let s = sp(&self.stand);
        (s.0, s.1.clone())
    }

    pub fn stand_text(&self) -> &'static str {
        match sp(&self.stand).0 {
            "" => AUS,
            s => s,
        }
    }

    fn setze(stand: &Mutex<StandWert>, art: &'static str, meldung: Option<Meldung>) {
        *sp(stand) = (art, meldung);
    }

    /// Startet das Programm (blockiert bis `/api/health` antwortet, höchstens 30 s) mit diesen erlaubten Wurzeln. Läuft schon eines, wird es zuerst beendet.
    pub fn starten(&self, h: &Huelle, wurzeln: Vec<String>) -> Result<(), Fehler> {
        let _r = sp(&self.reihe);
        self.stoppen_intern();
        Self::setze(&self.stand, STARTET, None);
        let ergebnis = self.starten_intern(h, wurzeln);
        if let Err(f) = &ergebnis {
            Self::setze(&self.stand, FEHLER, Some(f.meldung()));
        }
        ergebnis
    }

    fn starten_intern(&self, h: &Huelle, wurzeln: Vec<String>) -> Result<(), Fehler> {
        let konfig_einst = sp(&h.einstellungen).agent.lokal.clone();
        let daten = h.pfade.daten.join("lokaler-runner");
        std::fs::create_dir_all(&daten).map_err(|e| Fehler::aus_io(&e, &daten))?;
        let port = freien_port().map_err(|e| Fehler::LokalerRunnerStartetNicht { grund: format!("kein freier Port: {e}") })?;
        let token = vertrag::neues_token();
        let konfig = vertrag::start_konfig(&konfig_einst, port, &token, &wurzeln, &daten)?;
        let basis = format!("http://127.0.0.1:{port}");
        let (pb, pt) = (basis.clone(), token.clone());
        let mut kind = Kindprozess::neu(
            konfig,
            api_url(&basis, "/api/health"),
            Box::new(move || http::gesundheit(&pb, &pt).is_ok()),
            Some(h.pfade.daten.join("lokaler-runner.log")),
        );
        kind.starten().map_err(|f| {
            let m = f.meldung();
            Fehler::LokalerRunnerStartetNicht { grund: m.details.unwrap_or(m.ursache) }
        })?;
        let stop = Arc::new(AtomicBool::new(false));
        let fertig = Arc::new(AtomicBool::new(false));
        let wurzeln = Arc::new(Mutex::new(wurzeln));
        *sp(&self.lauf) = Some(Lauf { stop: stop.clone(), fertig: fertig.clone(), basis: basis.clone(), token: token.clone(), wurzeln: wurzeln.clone() });
        Self::setze(&self.stand, LAEUFT, None);
        let stand = self.stand.clone();
        std::thread::Builder::new()
            .name("lokaler-runner".into())
            .spawn(move || {
                ueberwachen(kind, &stand, &stop, &wurzeln, &basis, &token);
                fertig.store(true, Ordering::SeqCst);
            })
            .map_err(|e| Fehler::LokalerRunnerStartetNicht { grund: e.to_string() })?;
        Ok(())
    }

    /// Beendet das Programm (höflich, nach 8 s hart) und wartet höchstens 15 s, bis der Aufpasser fertig ist.
    pub fn stoppen(&self) {
        let _r = sp(&self.reihe);
        self.stoppen_intern();
    }

    fn stoppen_intern(&self) {
        let alt = sp(&self.lauf).take();
        if let Some(l) = alt {
            l.stop.store(true, Ordering::SeqCst);
            let ende = Instant::now() + Duration::from_secs(15);
            while !l.fertig.load(Ordering::SeqCst) && Instant::now() < ende {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        Self::setze(&self.stand, AUS, None);
    }

    /// Meldet dem laufenden Programm einen im Systemdialog gewählten Ordner (`POST /api/ordner/erlauben`) und merkt ihn für Neustarts.
    pub fn wurzel_erlauben(&self, pfad: &str) -> Result<(), Fehler> {
        let pfad = ordner_pruefen(pfad)?;
        let (basis, token, wurzeln) = {
            let l = sp(&self.lauf);
            let l = l.as_ref().ok_or_else(|| Fehler::LokalerRunnerStartetNicht { grund: "der lokale Runner läuft nicht".into() })?;
            (l.basis.clone(), l.token.clone(), l.wurzeln.clone())
        };
        http::anfrage("POST", &api_url(&basis, "/api/ordner/erlauben"), &token, Some(&json!({ "pfad": pfad })), Duration::from_secs(8))?;
        let mut w = sp(&wurzeln);
        if !w.contains(&pfad) {
            w.push(pfad);
        }
        Ok(())
    }
}

fn schlafe(stop: &AtomicBool, ms: u64) {
    let ende = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < ende && !stop.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn ueberwachen(mut kind: Kindprozess, stand: &Mutex<StandWert>, stop: &AtomicBool, wurzeln: &Mutex<Vec<String>>, basis: &str, token: &str) {
    let mut versuch: u32 = 0;
    let mut seit = Instant::now();
    while !stop.load(Ordering::SeqCst) {
        schlafe(stop, 400);
        if stop.load(Ordering::SeqCst) {
            break;
        }
        if kind.laeuft() {
            if versuch > 0 && seit.elapsed() >= Duration::from_secs(vertrag::STABIL_NACH_S) {
                versuch = 0;
            }
            continue;
        }
        // unerwartetes Ende: mit Verzögerung neu starten
        let letzte = sp(stand).1.clone();
        Lokal::setze(stand, NEUSTART, letzte);
        schlafe(stop, vertrag::neustart_wartezeit_ms(versuch));
        versuch = versuch.saturating_add(1);
        if stop.load(Ordering::SeqCst) {
            break;
        }
        match kind.starten() {
            Ok(()) => {
                seit = Instant::now();
                Lokal::setze(stand, LAEUFT, None);
                for w in sp(wurzeln).clone() {
                    let _ = http::anfrage("POST", &api_url(basis, "/api/ordner/erlauben"), token, Some(&json!({ "pfad": w })), Duration::from_secs(8));
                }
            }
            Err(f) => {
                let m = f.meldung();
                let grund = Fehler::LokalerRunnerStartetNicht { grund: m.details.unwrap_or(m.ursache) };
                Lokal::setze(stand, NEUSTART, Some(grund.meldung()));
            }
        }
    }
    kind.beenden();
}

/// Die Wurzeln für einen Start: die zuletzt benutzten Ordner des lokalen Runners, soweit es sie noch gibt.
pub fn start_wurzeln(h: &Huelle) -> Vec<String> {
    sp(&h.einstellungen).agent.ordner_zuletzt(LOKAL_ID).into_iter().filter(|p| std::path::Path::new(p).is_dir()).collect()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use shell_core::agent::runner::LokalKonfig;
    use shell_core::speicher::Pfade;
    use shell_core::Profil;
    use std::os::unix::fs::PermissionsExt;

    /// Ein Test-Programm nach dem Vertrag, geschrieben als Python-Skript in den Wegwerf-Ordner.
    fn programm(d: &std::path::Path, koerper: &str) -> String {
        let p = d.join("runner.py");
        std::fs::write(&p, koerper).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p.display().to_string()
    }

    const SKRIPT: &str = r#"#!/usr/bin/env python3
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
TOKEN = os.environ["FYOS_RUNNER_TOKEN"]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.headers.get("Authorization") != "Bearer " + TOKEN:
            self.send_response(401); self.end_headers(); return
        b = json.dumps({"ok": True, "agent": "probe", "pid": os.getpid()}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
HTTPServer(("127.0.0.1", int(os.environ["FYOS_RUNNER_PORT"])), H).serve_forever()
"#;

    fn huelle(d: &std::path::Path, prog: String) -> Huelle {
        let h = Huelle::laden(Profil::Agent, "0.0.1", Pfade::neu(d.join("daten"))).unwrap();
        crate::zustand::sperre(&h.einstellungen).agent.lokal = LokalKonfig { programm: prog, args: vec![] };
        h
    }

    fn lebt(pid: i32) -> bool {
        unsafe { libc_kill(pid) }
    }
    unsafe fn libc_kill(pid: i32) -> bool {
        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        kill(pid, 0) == 0
    }

    #[test]
    fn startet_wartet_auf_gesundheit_zeigt_ziel_und_stoppen_raeumt_auf() {
        let d = tempfile::tempdir().unwrap();
        let h = huelle(d.path(), programm(d.path(), SKRIPT));
        let l = Lokal::default();
        assert_eq!(l.stand_text(), AUS);
        l.starten(&h, vec![]).unwrap();
        assert_eq!(l.stand_text(), LAEUFT);
        let (basis, token) = l.ziel().unwrap();
        assert!(basis.starts_with("http://127.0.0.1:") && token.len() == 64);
        let v = http::gesundheit(&basis, &token).unwrap();
        let pid = v["pid"].as_i64().unwrap() as i32;
        assert!(http::gesundheit(&basis, "falsch").is_err(), "ohne das richtige Token antwortet das Programm nicht");
        assert!(lebt(pid));
        // das Token steht nicht in den Einstellungen und nicht im Protokoll
        let einst = serde_json::to_string(&*crate::zustand::sperre(&h.einstellungen)).unwrap();
        assert!(!einst.contains(&token));
        l.stoppen();
        assert_eq!(l.stand_text(), AUS);
        assert!(l.ziel().is_none());
        let ende = Instant::now() + Duration::from_secs(5);
        while lebt(pid) && Instant::now() < ende {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!lebt(pid), "kein Zombie, kein Waise");
    }

    #[test]
    fn unerwartetes_ende_fuehrt_zum_neustart_mit_neuem_prozess_und_gleichem_ziel() {
        let d = tempfile::tempdir().unwrap();
        let h = huelle(d.path(), programm(d.path(), SKRIPT));
        let l = Lokal::default();
        l.starten(&h, vec![]).unwrap();
        let (basis, token) = l.ziel().unwrap();
        let pid = http::gesundheit(&basis, &token).unwrap()["pid"].as_i64().unwrap() as i32;
        unsafe {
            extern "C" {
                fn kill(pid: i32, sig: i32) -> i32;
            }
            kill(pid, 9);
        }
        let ende = Instant::now() + Duration::from_secs(20);
        let mut neu = 0;
        while Instant::now() < ende {
            if let Ok(v) = http::gesundheit(&basis, &token) {
                neu = v["pid"].as_i64().unwrap() as i32;
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        assert!(neu != 0 && neu != pid, "der Aufpasser hat neu gestartet");
        assert_eq!(l.ziel().unwrap().1, token);
        l.stoppen();
        assert!(!lebt(neu));
    }

    #[test]
    fn ohne_programm_oder_mit_totem_programm_gibt_katalogfehler_und_stand_fehler() {
        let d = tempfile::tempdir().unwrap();
        let h = Huelle::laden(Profil::Agent, "0.0.1", Pfade::neu(d.path().join("daten"))).unwrap();
        let l = Lokal::default();
        assert_eq!(l.starten(&h, vec![]).unwrap_err().code(), "LOKALER_RUNNER_NICHT_EINGERICHTET");
        assert_eq!(l.stand_text(), FEHLER);
        let h2 = huelle(d.path(), programm(d.path(), "#!/bin/sh\necho kaputt\nexit 3\n"));
        let f = l.starten(&h2, vec![]).unwrap_err();
        assert_eq!(f.code(), "LOKALER_RUNNER_STARTET_NICHT");
        assert!(l.ziel().is_none());
        assert!(l.wurzel_erlauben("/probe/x").is_err(), "ohne laufendes Programm kein Ordner");
    }

    #[test]
    fn start_wurzeln_nimmt_nur_vorhandene_zuletzt_benutzte_ordner() {
        let d = tempfile::tempdir().unwrap();
        let h = huelle(d.path(), "/x".into());
        let da = d.path().join("da");
        std::fs::create_dir(&da).unwrap();
        {
            let mut e = crate::zustand::sperre(&h.einstellungen);
            e.agent.ordner_merken(LOKAL_ID, &da.display().to_string()).unwrap();
            e.agent.ordner_merken(LOKAL_ID, "/gibt/es/nicht/mehr").unwrap();
        }
        assert_eq!(start_wurzeln(&h), vec![da.display().to_string()]);
    }
}
