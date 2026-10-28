//! Start bei der Anmeldung (Opt-in; Vorgabe aus). Je System ein Eintrag, der die App mit `--versteckt` startet (nur Tray, kein Fenster):
//!
//! - macOS: LaunchAgent `~/Library/LaunchAgents/<bundle-id>.autostart.plist` (`RunAtLoad`; launchd liest ihn bei der nächsten Anmeldung). Der Zusatz `.autostart`
//!   ist Pflicht: unter `<bundle-id>.plist` liegt bei Nutzern des Python-Studios schon dessen Dienst (gleiches Label); ein gleicher Name würde ihn überschreiben.
//! - Linux: `~/.config/autostart/<bundle-id>.autostart.desktop` (XDG; als AppImage zeigt `Exec` auf das AppImage, nicht auf den entpackten Ordner)
//! - Windows: Registry `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, Wert = Bundle-Id (kein Administrator nötig)
//!
//! Der Kern kennt nur die Texte der Einträge und die Schnittstelle [`Ablage`] (Datei oder Registry); damit sind Inhalt und Ablauf auf jedem
//! System und ohne Eingriff in die echte Anmeldeumgebung prüfbar. Die Windows-Registry-Fassung steht in `ablage_windows` (nur dort übersetzt).

use crate::fehler::Fehler;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Art {
    MacLaunchAgent,
    LinuxXdg,
    WindowsRun,
}

impl Art {
    pub fn dieses_system() -> Art {
        if cfg!(target_os = "macos") {
            Art::MacLaunchAgent
        } else if cfg!(target_os = "windows") {
            Art::WindowsRun
        } else {
            Art::LinuxXdg
        }
    }

    /// Dateiname bzw. Registrywert-Name des Eintrags.
    pub fn eintragsname(self, bundle_id: &str) -> String {
        match self {
            Art::MacLaunchAgent => format!("{bundle_id}.autostart.plist"),
            Art::LinuxXdg => format!("{bundle_id}.autostart.desktop"),
            Art::WindowsRun => bundle_id.to_string(),
        }
    }
}

/// Wohin der Eintrag geschrieben wird (Datei im Anmeldeordner oder Registrywert).
pub trait Ablage: Send + Sync {
    fn schreiben(&self, name: &str, inhalt: &str) -> io::Result<()>;
    fn loeschen(&self, name: &str) -> io::Result<()>;
    fn lesen(&self, name: &str) -> io::Result<Option<String>>;
    /// Für Fehlertexte: wo der Eintrag liegt.
    fn ort(&self, name: &str) -> String;
}

/// Ablage als Datei in einem Ordner (macOS, Linux; in Tests ein Wegwerf-Ordner).
pub struct DateiAblage {
    pub ordner: PathBuf,
}

impl Ablage for DateiAblage {
    fn schreiben(&self, name: &str, inhalt: &str) -> io::Result<()> {
        fs::create_dir_all(&self.ordner)?;
        let ziel = self.ordner.join(name);
        let vorlaeufig = self.ordner.join(format!(".{name}.neu"));
        fs::write(&vorlaeufig, inhalt)?;
        fs::rename(&vorlaeufig, ziel)
    }
    fn loeschen(&self, name: &str) -> io::Result<()> {
        match fs::remove_file(self.ordner.join(name)) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            anderes => anderes,
        }
    }
    fn lesen(&self, name: &str) -> io::Result<Option<String>> {
        match fs::read_to_string(self.ordner.join(name)) {
            Ok(t) => Ok(Some(t)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }
    fn ort(&self, name: &str) -> String {
        self.ordner.join(name).display().to_string()
    }
}

/// Standardordner dieses Systems unter dem Heimatordner (`FYOS_SHELL_AUTOSTART_ORDNER` überschreibt ihn: Tests, Support).
pub fn standard_ordner(art: Art, heim: &Path, xdg_config: Option<&Path>) -> PathBuf {
    match art {
        Art::MacLaunchAgent => heim.join("Library").join("LaunchAgents"),
        Art::LinuxXdg => xdg_config.map(Path::to_path_buf).unwrap_or_else(|| heim.join(".config")).join("autostart"),
        Art::WindowsRun => heim.join("AppData").join("Roaming").join("Microsoft").join("Windows").join("Start Menu").join("Programs").join("Startup"),
    }
}

fn xml_maskieren(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Inhalt des LaunchAgents.
pub fn plist_text(bundle_id: &str, programm: &str, args: &[&str]) -> String {
    let mut felder = format!("    <string>{}</string>\n", xml_maskieren(programm));
    for a in args {
        felder.push_str(&format!("    <string>{}</string>\n", xml_maskieren(a)));
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\">\n<dict>\n  <key>Label</key>\n  <string>{}</string>\n  <key>ProgramArguments</key>\n  <array>\n{}  </array>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>ProcessType</key>\n  <string>Interactive</string>\n</dict>\n</plist>\n",
        xml_maskieren(bundle_id),
        felder
    )
}

/// Ein Argument für die `Exec`-Zeile einer .desktop-Datei: Leerzeichen und Sonderzeichen in Anführungszeichen, `%` verdoppelt.
fn desktop_argument(a: &str) -> String {
    let a = a.replace('%', "%%");
    if a.chars().any(|c| c.is_whitespace() || "\"'\\><~|&;$*?#()`".contains(c)) {
        format!("\"{}\"", a.replace('\\', "\\\\").replace('"', "\\\"").replace('`', "\\`").replace('$', "\\$"))
    } else {
        a
    }
}

/// Inhalt der .desktop-Datei.
pub fn desktop_text(anzeigename: &str, programm: &str, args: &[&str]) -> String {
    let mut exec = desktop_argument(programm);
    for a in args {
        exec.push(' ');
        exec.push_str(&desktop_argument(a));
    }
    format!("[Desktop Entry]\nType=Application\nName={anzeigename}\nExec={exec}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n")
}

/// Wert des Registryeintrags (die Kommandozeile, Programm in Anführungszeichen).
pub fn run_wert(programm: &str, args: &[&str]) -> String {
    let mut s = format!("\"{programm}\"");
    for a in args {
        s.push(' ');
        s.push_str(a);
    }
    s
}

/// Windows: Werte unter `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. Auf Windows nicht ausgeführt (kein Windows-Rechner);
/// übersetzt wird es mit `cargo check --target x86_64-pc-windows-gnu`, die Logik darüber ist mit der Attrappe geprüft.
#[cfg(windows)]
pub mod registry {
    use super::Ablage;
    use std::io;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_SZ,
    };

    const ERFOLG: u32 = 0;
    const NICHT_GEFUNDEN: u32 = 2;
    const PFAD: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";

    pub struct RunSchluessel;

    fn weit(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn fehler(code: u32) -> io::Error {
        io::Error::from_raw_os_error(code as i32)
    }

    fn oeffnen(zugriff: u32) -> io::Result<HKEY> {
        let mut schluessel: HKEY = null_mut();
        // SAFETY: gültige, nullterminierte Zeichenkette und gültiger Zeiger auf das Ergebnis.
        let r = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, weit(PFAD).as_ptr(), 0, zugriff, &mut schluessel) };
        if r == ERFOLG { Ok(schluessel) } else { Err(fehler(r)) }
    }

    impl Ablage for RunSchluessel {
        fn schreiben(&self, name: &str, inhalt: &str) -> io::Result<()> {
            let k = oeffnen(KEY_WRITE)?;
            let wert = weit(inhalt);
            // SAFETY: Zeiger und Länge (in Bytes, einschließlich der abschließenden Null) stammen aus demselben Vektor.
            let r = unsafe { RegSetValueExW(k, weit(name).as_ptr(), 0, REG_SZ, wert.as_ptr() as *const u8, (wert.len() * 2) as u32) };
            unsafe { RegCloseKey(k) };
            if r == ERFOLG { Ok(()) } else { Err(fehler(r)) }
        }

        fn loeschen(&self, name: &str) -> io::Result<()> {
            let k = oeffnen(KEY_WRITE)?;
            // SAFETY: gültiges Handle und nullterminierter Name.
            let r = unsafe { RegDeleteValueW(k, weit(name).as_ptr()) };
            unsafe { RegCloseKey(k) };
            if r == ERFOLG || r == NICHT_GEFUNDEN { Ok(()) } else { Err(fehler(r)) }
        }

        fn lesen(&self, name: &str) -> io::Result<Option<String>> {
            let k = oeffnen(KEY_READ)?;
            let mut groesse: u32 = 0;
            // SAFETY: erst die Größe erfragen (Zielzeiger null), dann mit passendem Puffer lesen.
            let r = unsafe { RegQueryValueExW(k, weit(name).as_ptr(), null(), null_mut(), null_mut(), &mut groesse) };
            if r == NICHT_GEFUNDEN {
                unsafe { RegCloseKey(k) };
                return Ok(None);
            }
            if r != ERFOLG {
                unsafe { RegCloseKey(k) };
                return Err(fehler(r));
            }
            let mut puffer = vec![0u16; (groesse as usize + 1) / 2 + 1];
            let mut laenge = (puffer.len() * 2) as u32;
            let r = unsafe { RegQueryValueExW(k, weit(name).as_ptr(), null(), null_mut(), puffer.as_mut_ptr() as *mut u8, &mut laenge) };
            unsafe { RegCloseKey(k) };
            if r != ERFOLG {
                return Err(fehler(r));
            }
            let zeichen = (laenge as usize / 2).min(puffer.len());
            let text = String::from_utf16_lossy(&puffer[..zeichen]);
            Ok(Some(text.trim_end_matches('\0').to_string()))
        }

        fn ort(&self, name: &str) -> String {
            format!("HKEY_CURRENT_USER\\{PFAD}\\{name}")
        }
    }
}

pub struct Autostart {
    pub art: Art,
    pub bundle_id: String,
    pub anzeigename: String,
    /// Das Programm, das zur Anmeldung gestartet wird (AppImage: der Pfad des AppImage).
    pub programm: String,
    pub ablage: Box<dyn Ablage>,
}

const ARGUMENTE: [&str; 1] = ["--versteckt"];

impl Autostart {
    fn inhalt(&self) -> String {
        match self.art {
            Art::MacLaunchAgent => plist_text(&format!("{}.autostart", self.bundle_id), &self.programm, &ARGUMENTE),
            Art::LinuxXdg => desktop_text(&self.anzeigename, &self.programm, &ARGUMENTE),
            Art::WindowsRun => run_wert(&self.programm, &ARGUMENTE),
        }
    }

    fn name(&self) -> String {
        self.art.eintragsname(&self.bundle_id)
    }

    fn fehler(&self, e: io::Error) -> Fehler {
        Fehler::AutostartFehlgeschlagen { ort: self.ablage.ort(&self.name()), grund: e.to_string() }
    }

    /// Schaltet den Start bei der Anmeldung an oder aus. Aus löscht den Eintrag (ein nicht vorhandener ist kein Fehler).
    pub fn setzen(&self, an: bool) -> Result<(), Fehler> {
        if an {
            self.ablage.schreiben(&self.name(), &self.inhalt()).map_err(|e| self.fehler(e))
        } else {
            self.ablage.loeschen(&self.name()).map_err(|e| self.fehler(e))
        }
    }

    /// Steht ein Eintrag für **dieses** Programm in der Ablage?
    pub fn ist_an(&self) -> Result<bool, Fehler> {
        Ok(self.ablage.lesen(&self.name()).map_err(|e| self.fehler(e))?.is_some_and(|t| t == self.inhalt()))
    }

    /// Steht ein Eintrag da (egal für welches Programm)? Für die Anzeige „ein anderer Eintrag blockiert“.
    pub fn eintrag_vorhanden(&self) -> Result<bool, Fehler> {
        Ok(self.ablage.lesen(&self.name()).map_err(|e| self.fehler(e))?.is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Attrappe: merkt sich Einträge im Speicher, kann Fehler vorspielen (z. B. kein Schreibrecht).
    #[derive(Default)]
    struct Attrappe {
        inhalt: Mutex<std::collections::HashMap<String, String>>,
        verweigern: bool,
    }

    impl Ablage for Attrappe {
        fn schreiben(&self, name: &str, inhalt: &str) -> io::Result<()> {
            if self.verweigern {
                return Err(io::Error::from(io::ErrorKind::PermissionDenied));
            }
            self.inhalt.lock().unwrap().insert(name.into(), inhalt.into());
            Ok(())
        }
        fn loeschen(&self, name: &str) -> io::Result<()> {
            self.inhalt.lock().unwrap().remove(name);
            Ok(())
        }
        fn lesen(&self, name: &str) -> io::Result<Option<String>> {
            Ok(self.inhalt.lock().unwrap().get(name).cloned())
        }
        fn ort(&self, name: &str) -> String {
            format!("attrappe:{name}")
        }
    }

    fn mit(art: Art, ablage: Box<dyn Ablage>) -> Autostart {
        Autostart { art, bundle_id: "de.sirfyyn.fle-studio".into(), anzeigename: "FLE Studio".into(), programm: "/Apps/FLE Studio.app/Contents/MacOS/fyos-shell".into(), ablage }
    }

    #[test]
    fn eintragsnamen() {
        assert_eq!(Art::MacLaunchAgent.eintragsname("a.b"), "a.b.autostart.plist");
        assert_eq!(Art::LinuxXdg.eintragsname("a.b"), "a.b.autostart.desktop");
        assert_eq!(Art::WindowsRun.eintragsname("a.b"), "a.b");
    }

    #[test]
    fn standardordner_je_system() {
        let heim = Path::new("/home/x");
        assert_eq!(standard_ordner(Art::MacLaunchAgent, heim, None), PathBuf::from("/home/x/Library/LaunchAgents"));
        assert_eq!(standard_ordner(Art::LinuxXdg, heim, None), PathBuf::from("/home/x/.config/autostart"));
        assert_eq!(standard_ordner(Art::LinuxXdg, heim, Some(Path::new("/cfg"))), PathBuf::from("/cfg/autostart"));
    }

    #[test]
    fn plist_ist_wohlgeformt_und_maskiert() {
        let t = plist_text("de.x.a", "/Apps/A & B/<x>\"", &["--versteckt"]);
        assert!(t.contains("<key>RunAtLoad</key>\n  <true/>"));
        assert!(t.contains("<string>/Apps/A &amp; B/&lt;x&gt;&quot;</string>"));
        assert!(t.contains("<string>--versteckt</string>"));
        assert!(t.contains("<string>de.x.a</string>"));
    }

    #[test]
    fn desktop_exec_mit_leerzeichen_und_prozent() {
        let t = desktop_text("FLE Studio", "/Programme/Mein Ordner/app 100%.AppImage", &["--versteckt"]);
        assert!(t.contains("Exec=\"/Programme/Mein Ordner/app 100%%.AppImage\" --versteckt\n"), "{t}");
        assert!(t.starts_with("[Desktop Entry]\nType=Application\nName=FLE Studio\n"));
        assert_eq!(desktop_text("A", "/bin/app", &[]).lines().find(|l| l.starts_with("Exec=")), Some("Exec=/bin/app"));
    }

    #[test]
    fn registrywert() {
        assert_eq!(run_wert("C:\\Programme\\FLE Studio\\fyos-shell.exe", &["--versteckt"]), "\"C:\\Programme\\FLE Studio\\fyos-shell.exe\" --versteckt");
    }

    #[test]
    fn an_aus_und_zustand_fuer_jede_art() {
        for art in [Art::MacLaunchAgent, Art::LinuxXdg, Art::WindowsRun] {
            let a = mit(art, Box::new(Attrappe::default()));
            assert!(!a.ist_an().unwrap(), "{art:?} vorher aus");
            a.setzen(true).unwrap();
            assert!(a.ist_an().unwrap(), "{art:?} an");
            a.setzen(true).unwrap(); // erneut an ist in Ordnung
            a.setzen(false).unwrap();
            assert!(!a.ist_an().unwrap() && !a.eintrag_vorhanden().unwrap(), "{art:?} aus");
            a.setzen(false).unwrap(); // erneut aus ist kein Fehler
        }
    }

    #[test]
    fn verschobenes_programm_zaehlt_nicht_als_an() {
        let ablage = Attrappe::default();
        ablage.schreiben("de.sirfyyn.fle-studio.autostart.plist", "alter Inhalt mit anderem Pfad").unwrap();
        let a = mit(Art::MacLaunchAgent, Box::new(ablage));
        assert!(a.eintrag_vorhanden().unwrap());
        assert!(!a.ist_an().unwrap(), "Eintrag zeigt auf ein anderes Programm: erneuern");
        a.setzen(true).unwrap();
        assert!(a.ist_an().unwrap());
    }

    #[test]
    fn verweigerter_zugriff_hat_katalogtext() {
        let a = mit(Art::LinuxXdg, Box::new(Attrappe { verweigern: true, ..Default::default() }));
        let f = a.setzen(true).unwrap_err();
        assert_eq!(f.code(), "AUTOSTART_FEHLGESCHLAGEN");
        let m = f.meldung();
        assert!(m.details.unwrap().contains("attrappe:de.sirfyyn.fle-studio.autostart.desktop") && !m.abhilfe.is_empty());
    }

    #[test]
    fn datei_ablage_im_wegwerf_ordner() {
        let d = tempfile::tempdir().unwrap();
        let ordner = d.path().join("LaunchAgents");
        let a = mit(Art::MacLaunchAgent, Box::new(DateiAblage { ordner: ordner.clone() }));
        a.setzen(true).unwrap();
        let datei = ordner.join("de.sirfyyn.fle-studio.autostart.plist");
        assert!(fs::read_to_string(&datei).unwrap().contains("--versteckt"));
        assert!(a.ist_an().unwrap());
        a.setzen(false).unwrap();
        assert!(!datei.exists());
        assert_eq!(fs::read_dir(&ordner).unwrap().count(), 0, "keine Reste");
    }
}
