//! Begleiter: der Server hinter dem Profil Studio.
//!
//! Plan S-A: die Hülle liefert das Python-Studio als Kindprozess mit. Später (S-B, S-C) übernimmt
//! ein Rust-Server. Die Hülle kennt deshalb nur die Schnittstelle [`Begleiter`] (starten bis gesund, laufen, beenden,
//! neustarten) und die Adresse mit `/api/state`; ob dahinter ein Kindprozess ([`Kindprozess`]) oder ein Server im selben
//! Prozess steht, merkt sie nicht. Ein Rust-Server ist dann eine zweite Implementierung des Merkmals, ohne Änderung an der Hülle.

use crate::fehler::Fehler;
use crate::prozessgruppe::{self, Gruppe};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Wie der Begleiter gestartet wird (Teil der Einstellungen).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BegleiterKonfig {
    pub programm: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    /// So lange darf der Start bis zur ersten gesunden Antwort dauern.
    pub frist_s: u64,
    /// Fester Port; leer = die Hülle sucht selbst einen freien (Vorgabe, vermeidet Zusammenstöße mit alten Diensten).
    pub port: Option<u16>,
}

impl Default for BegleiterKonfig {
    fn default() -> Self {
        BegleiterKonfig { programm: String::new(), args: Vec::new(), env: BTreeMap::new(), frist_s: 20, port: None }
    }
}

impl BegleiterKonfig {
    /// Setzt Port und Kennung ein: `{port}` und `{kennung}` in Argumenten und Umgebungswerten, dazu die Umgebung
    /// `FYOS_SHELL_PORT` und `FYOS_SHELL_KENNUNG`. Der Begleiter muss `/api/state` mit dem Kopf `X-FYOS-Kennung: <kennung>`
    /// beantworten; so erkennt die Hülle, dass **ihr** Begleiter antwortet und nicht ein fremder Server auf demselben Port.
    pub fn mit_start_werten(&self, port: u16, kennung: &str) -> BegleiterKonfig {
        let ersetze = |s: &str| s.replace("{port}", &port.to_string()).replace("{kennung}", kennung);
        let mut k = self.clone();
        k.args = self.args.iter().map(|a| ersetze(a)).collect();
        k.env = self.env.iter().map(|(n, w)| (n.clone(), ersetze(w))).collect();
        k.env.insert("FYOS_SHELL_PORT".into(), port.to_string());
        k.env.insert("FYOS_SHELL_KENNUNG".into(), kennung.to_string());
        k.port = Some(port);
        k
    }
}

/// Entfernt aus einem Umgebungswert alles, was in den AppImage-Ordner `appdir` zeigt (der AppImage-Starter setzt
/// `PYTHONHOME`, `LD_LIBRARY_PATH`, `XDG_DATA_DIRS` usw. auf gebündelte Ordner; ein Kindprozess, der nicht Teil des
/// Bündels ist, würde damit abstürzen: gemessen mit dem Python-Begleiter, `No module named 'encodings'`).
/// `None` = Wert ganz entfernen, `Some(neu)` = bereinigter Wert; unverändert, wenn nichts auf `appdir` zeigt.
pub fn ohne_appdir(wert: &str, appdir: &str) -> Option<String> {
    if appdir.is_empty() || !wert.contains(appdir) {
        return Some(wert.to_string());
    }
    let rest: Vec<&str> = wert.split(':').filter(|teil| !teil.contains(appdir)).collect();
    if rest.is_empty() {
        None
    } else {
        Some(rest.join(":"))
    }
}

/// Name des Kopfes, mit dem der Begleiter seine Kennung bestätigt.
pub const KENNUNG_KOPF: &str = "X-FYOS-Kennung";

/// Ein freier Port auf der Loopback-Schnittstelle (kurz gebunden und wieder freigegeben).
pub fn freien_port() -> std::io::Result<u16> {
    Ok(std::net::TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

/// 128 Bit Zufall als 32 Hexzeichen.
pub fn neue_kennung() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("Zufallsquelle des Systems");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Die Schnittstelle, die die Hülle benutzt.
pub trait Begleiter: Send {
    /// Startet den Begleiter und kehrt zurück, sobald er gesund ist (oder mit Fehler und Ursache nach der Frist).
    fn starten(&mut self) -> Result<(), Fehler>;
    /// Läuft er noch? Ein unerwartetes Ende wird hier erkannt.
    fn laeuft(&mut self) -> bool;
    /// Beendet ihn sauber (erst höflich, nach einer Frist hart) und räumt auf.
    fn beenden(&mut self);
    fn neustarten(&mut self) -> Result<(), Fehler> {
        self.beenden();
        self.starten()
    }
}

/// Gesundheitsprüfung, vom Aufrufer geliefert (die Hülle prüft `/api/state`); der Kern braucht dafür kein HTTP.
pub type Gesundheit = Box<dyn Fn() -> bool + Send>;

const HOEFLICH_S: u64 = 8;
const TAKT: Duration = Duration::from_millis(100);

/// Begleiter als Kindprozess in eigener Prozessgruppe (Unix), damit auch dessen Kinder mit enden.
pub struct Kindprozess {
    konfig: BegleiterKonfig,
    gesundheits_url: String,
    gesund: Gesundheit,
    logdatei: Option<PathBuf>,
    kind: Option<Child>,
    gruppe: Option<Gruppe>,
}

impl Kindprozess {
    pub fn neu(konfig: BegleiterKonfig, gesundheits_url: String, gesund: Gesundheit, logdatei: Option<PathBuf>) -> Self {
        Kindprozess { konfig, gesundheits_url, gesund, logdatei, kind: None, gruppe: None }
    }

    fn befehl(&self) -> Result<Command, Fehler> {
        let mut c = Command::new(&self.konfig.programm);
        c.args(&self.konfig.args).stdin(Stdio::null());
        // Als AppImage gestartet? Dann die Umgebung von Verweisen ins Bündel befreien, bevor die eigenen Werte gelten.
        if let Ok(appdir) = std::env::var("APPDIR") {
            let umgebung = std::env::vars_os().filter_map(|(n, w)| Some((n.into_string().ok()?, w.into_string().ok()?)));
            for (name, wert) in umgebung {
                match ohne_appdir(&wert, &appdir) {
                    Some(neu) if neu == wert => {}
                    Some(neu) => {
                        c.env(&name, neu);
                    }
                    None => {
                        c.env_remove(&name);
                    }
                }
            }
        }
        c.envs(&self.konfig.env);
        let (aus, fehler) = match &self.logdatei {
            Some(p) => {
                let datei = OpenOptions::new().create(true).append(true).open(p).map_err(|e| Fehler::aus_io(&e, p))?;
                let zweite = datei.try_clone().map_err(|e| Fehler::aus_io(&e, p))?;
                (Stdio::from(datei), Stdio::from(zweite))
            }
            None => (Stdio::null(), Stdio::null()),
        };
        c.stdout(aus).stderr(fehler);
        prozessgruppe::vorbereiten(&mut c);
        Ok(c)
    }

    fn hart_beenden(&mut self) {
        if let Some(mut k) = self.kind.take() {
            match self.gruppe.take() {
                Some(g) => g.hart(&mut k),
                None => {
                    let _ = k.kill();
                    let _ = k.wait();
                }
            }
        }
    }
}

impl Begleiter for Kindprozess {
    fn starten(&mut self) -> Result<(), Fehler> {
        if self.laeuft() && (self.gesund)() {
            return Ok(());
        }
        self.hart_beenden();
        let mut befehl = self.befehl()?;
        let kind = befehl.spawn().map_err(|e| Fehler::BegleiterStartetNicht {
            befehl: self.konfig.programm.clone(),
            grund: e.to_string(),
        })?;
        self.gruppe = Some(prozessgruppe::anbinden(&kind));
        self.kind = Some(kind);
        let ende = Instant::now() + Duration::from_secs(self.konfig.frist_s);
        loop {
            if let Some(k) = self.kind.as_mut() {
                if let Ok(Some(status)) = k.try_wait() {
                    self.kind = None;
                    return Err(Fehler::BegleiterBeendet { grund: format!("beendet beim Start mit {status}") });
                }
            }
            if (self.gesund)() {
                return Ok(());
            }
            if Instant::now() >= ende {
                self.hart_beenden();
                return Err(Fehler::BegleiterAntwortetNicht {
                    url: self.gesundheits_url.clone(),
                    sekunden: self.konfig.frist_s,
                });
            }
            std::thread::sleep(TAKT);
        }
    }

    fn laeuft(&mut self) -> bool {
        match self.kind.as_mut() {
            Some(k) => match k.try_wait() {
                Ok(None) => true,
                _ => {
                    self.kind = None;
                    false
                }
            },
            None => false,
        }
    }

    fn beenden(&mut self) {
        let Some(k) = self.kind.as_mut() else { return };
        // Gibt es auf dieser Plattform keinen höflichen Weg (Windows), wird sofort hart beendet.
        if !self.gruppe.as_ref().is_some_and(|g| g.sanft(k)) {
            self.hart_beenden();
            return;
        }
        let ende = Instant::now() + Duration::from_secs(HOEFLICH_S);
        while Instant::now() < ende {
            if matches!(k.try_wait(), Ok(Some(_))) {
                self.kind = None;
                return;
            }
            std::thread::sleep(TAKT);
        }
        self.hart_beenden();
    }
}

impl Drop for Kindprozess {
    fn drop(&mut self) {
        self.beenden();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::path::Path;

    fn sh(skript: &str, frist_s: u64) -> BegleiterKonfig {
        BegleiterKonfig {
            programm: "sh".into(),
            args: vec!["-c".into(), skript.into()],
            env: BTreeMap::new(),
            frist_s,
            port: None,
        }
    }

    #[test]
    fn start_werte_ersetzen_platzhalter_und_setzen_die_umgebung() {
        let k = BegleiterKonfig {
            programm: "p".into(),
            args: vec!["--port".into(), "{port}".into(), "--k={kennung}".into()],
            env: BTreeMap::from([("X".to_string(), "a{port}".to_string())]),
            ..Default::default()
        };
        let s = k.mit_start_werten(4711, "abc");
        assert_eq!(s.args, vec!["--port", "4711", "--k=abc"]);
        assert_eq!(s.env["X"], "a4711");
        assert_eq!(s.env["FYOS_SHELL_PORT"], "4711");
        assert_eq!(s.env["FYOS_SHELL_KENNUNG"], "abc");
        assert_eq!(s.port, Some(4711));
    }

    #[test]
    fn appimage_verweise_werden_aus_der_umgebung_entfernt() {
        let ad = "/tmp/appimage_extracted_abc";
        assert_eq!(ohne_appdir("/tmp/appimage_extracted_abc/usr/lib/python3.11", ad), None);
        assert_eq!(
            ohne_appdir("/tmp/appimage_extracted_abc/usr/lib:/usr/lib:/opt/x", ad).as_deref(),
            Some("/usr/lib:/opt/x")
        );
        assert_eq!(ohne_appdir("/usr/lib", ad).as_deref(), Some("/usr/lib"));
        assert_eq!(ohne_appdir("egal", "").as_deref(), Some("egal"));
    }

    #[test]
    fn kennungen_sind_lang_und_verschieden() {
        let (a, b) = (neue_kennung(), neue_kennung());
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn freier_port_ist_wirklich_frei() {
        // Ein freier Port kann zwischen Wahl und Belegung von einem parallel laufenden Test vergeben werden;
        // darum mehrere Versuche. Der Test prüft, dass `freien_port` nicht dauerhaft belegte Ports liefert.
        let ok = (0..10).any(|_| {
            let p = freien_port().unwrap();
            std::net::TcpListener::bind(("127.0.0.1", p)).is_ok()
        });
        assert!(ok, "kein einziger der 10 gelieferten Ports war frei");
    }

    fn mit_marke(marke: &Path, skript: &str, frist_s: u64) -> Kindprozess {
        let m = marke.to_path_buf();
        Kindprozess::neu(sh(skript, frist_s), "test://gesund".into(), Box::new(move || m.exists()), None)
    }

    fn lebt(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[test]
    fn startet_bis_gesund_und_beendet_sauber() {
        let d = tempfile::tempdir().unwrap();
        let marke = d.path().join("bereit");
        let mut b = mit_marke(&marke, &format!("touch '{}'; exec sleep 30", marke.display()), 5);
        b.starten().unwrap();
        assert!(b.laeuft());
        b.beenden();
        assert!(!b.laeuft());
    }

    #[test]
    fn neustart_liefert_einen_neuen_prozess() {
        let d = tempfile::tempdir().unwrap();
        let marke = d.path().join("bereit");
        let mut b = mit_marke(&marke, &format!("touch '{}'; exec sleep 30", marke.display()), 5);
        b.starten().unwrap();
        let alt = b.kind.as_ref().unwrap().id();
        std::fs::remove_file(&marke).unwrap();
        b.neustarten().unwrap();
        assert_ne!(alt, b.kind.as_ref().unwrap().id());
        b.beenden();
    }

    #[test]
    fn programm_fehlt_nennt_ursache_und_abhilfe() {
        let mut k = sh("", 1);
        k.programm = "/gibt/es/nicht".into();
        let mut b = Kindprozess::neu(k, "u".into(), Box::new(|| true), None);
        let f = b.starten().unwrap_err();
        assert_eq!(f.code(), "BEGLEITER_STARTET_NICHT");
        assert!(f.meldung().details.unwrap().contains("/gibt/es/nicht"));
    }

    #[test]
    fn sofortiges_ende_wird_als_beendet_gemeldet() {
        let mut b = Kindprozess::neu(sh("exit 3", 5), "u".into(), Box::new(|| false), None);
        let f = b.starten().unwrap_err();
        assert_eq!(f.code(), "BEGLEITER_BEENDET");
        assert!(!b.laeuft());
    }

    #[test]
    fn keine_gesundheit_nach_der_frist_beendet_den_prozess() {
        let mut b = Kindprozess::neu(sh("exec sleep 30", 1), "http://x/api/state".into(), Box::new(|| false), None);
        let f = b.starten().unwrap_err();
        assert_eq!(f.code(), "BEGLEITER_ANTWORTET_NICHT");
        assert!(!b.laeuft());
    }

    #[test]
    fn kindeskinder_enden_mit() {
        let d = tempfile::tempdir().unwrap();
        let marke = d.path().join("bereit");
        let pid = d.path().join("enkel.pid");
        let skript = format!("sleep 30 & echo $! > '{}'; touch '{}'; wait", pid.display(), marke.display());
        let mut b = mit_marke(&marke, &skript, 5);
        b.starten().unwrap();
        let enkel: i32 = std::fs::read_to_string(&pid).unwrap().trim().parse().unwrap();
        assert!(lebt(enkel));
        b.beenden();
        let ende = Instant::now() + Duration::from_secs(3);
        while lebt(enkel) && Instant::now() < ende {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!lebt(enkel), "Enkelprozess läuft noch");
    }

    #[test]
    fn unerwartetes_ende_wird_erkannt() {
        let d = tempfile::tempdir().unwrap();
        let marke = d.path().join("bereit");
        let mut b = mit_marke(&marke, &format!("touch '{}'; sleep 1; exit 0", marke.display()), 5);
        b.starten().unwrap();
        let ende = Instant::now() + Duration::from_secs(5);
        while b.laeuft() && Instant::now() < ende {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(!b.laeuft());
    }

    #[test]
    fn schnittstelle_ist_austauschbar() {
        // Ein Server im selben Prozess (spätere Rust-Fassung) muss nur das Merkmal erfüllen.
        struct Eingebaut(bool);
        impl Begleiter for Eingebaut {
            fn starten(&mut self) -> Result<(), Fehler> {
                self.0 = true;
                Ok(())
            }
            fn laeuft(&mut self) -> bool {
                self.0
            }
            fn beenden(&mut self) {
                self.0 = false;
            }
        }
        let mut b: Box<dyn Begleiter> = Box::new(Eingebaut(false));
        b.neustarten().unwrap();
        assert!(b.laeuft());
        b.beenden();
        assert!(!b.laeuft());
    }
}
