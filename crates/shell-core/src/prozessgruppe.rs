//! Plattformteil des Begleiters: einen Kindprozess **samt allen Nachkommen** beenden.
//!
//! - Unix (macOS, Linux): eigene Prozessgruppe (`setpgid`), `killpg` mit SIGTERM (höflich) und SIGKILL (hart).
//! - Windows: ein Job-Objekt mit `KILL_ON_JOB_CLOSE`. Alle Nachkommen gehören zum Job; endet die Hülle (auch durch Absturz) und
//!   schließt Windows das Job-Handle, endet der ganze Baum. Es gibt keinen höflichen Weg (kein SIGTERM für Konsolenprogramme ohne
//!   eigenes Fenster): `sanft` meldet `false`, der Aufrufer beendet sofort hart. **Auf Windows nicht ausgeführt** (kein Windows-Rechner in D1);
//!   der Code wird mit `cargo check --target x86_64-pc-windows-gnu` in einem Linux-Container übersetzt, die Tests unter `cfg(windows)` laufen im CI (siehe README).

use std::process::{Child, Command};

/// Zusammenfassung der Prozessbaum-Verwaltung eines Kindprozesses.
pub struct Gruppe {
    #[cfg(windows)]
    job: Option<windows::Job>,
}

/// Vor dem Start: Befehl so einrichten, dass der Kindprozess eine eigene Gruppe bekommt.
pub fn vorbereiten(befehl: &mut Command) {
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(befehl, 0);
    #[cfg(windows)]
    {
        // kein Konsolenfenster für das Hilfsprogramm
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::os::windows::process::CommandExt::creation_flags(befehl, CREATE_NO_WINDOW);
    }
    #[cfg(not(any(unix, windows)))]
    let _ = befehl;
}

/// Nach dem Start: den Kindprozess der Gruppe zuordnen.
pub fn anbinden(kind: &Child) -> Gruppe {
    #[cfg(windows)]
    {
        Gruppe { job: windows::Job::neu_mit(kind) }
    }
    #[cfg(not(windows))]
    {
        let _ = kind;
        Gruppe {}
    }
}

impl Gruppe {
    /// Höfliche Bitte zum Beenden. `true`, wenn die Plattform eine kennt und sie gesendet wurde; sonst `false`, und der Aufrufer
    /// beendet hart, ohne die Frist abzuwarten.
    pub fn sanft(&self, kind: &Child) -> bool {
        #[cfg(unix)]
        {
            // SAFETY: killpg mit der Prozessgruppe, die wir selbst eingerichtet haben (Kind ist Gruppenführer).
            unsafe {
                libc::killpg(kind.id() as i32, libc::SIGTERM);
            }
            true
        }
        #[cfg(not(unix))]
        {
            let _ = kind;
            false
        }
    }

    /// Hartes Ende des ganzen Baums.
    pub fn hart(&self, kind: &mut Child) {
        #[cfg(unix)]
        {
            // SAFETY: wie oben.
            unsafe {
                libc::killpg(kind.id() as i32, libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        {
            if let Some(job) = &self.job {
                job.beenden();
            }
        }
        let _ = kind.kill();
        let _ = kind.wait();
    }
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::ptr::null;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// Job-Objekt; wird das Handle geschlossen (Drop oder Ende der Hülle), endet jeder Prozess darin.
    pub struct Job(HANDLE);

    // Das Handle gehört dem Job allein und wird nur vom besitzenden Thread benutzt.
    unsafe impl Send for Job {}

    impl Job {
        /// Legt ein Job-Objekt an und ordnet den Prozess zu. `None`, wenn Windows es verweigert (z. B. Elternjob ohne
        /// Ausbruchsrecht, wie in manchen CI-Läufern): dann endet nur der Hauptprozess, die Hülle läuft trotzdem.
        pub fn neu_mit(kind: &Child) -> Option<Job> {
            // SAFETY: reine Win32-Aufrufe mit gültigen Zeigern; Handles werden bei Fehlern wieder geschlossen.
            unsafe {
                let job = CreateJobObjectW(null(), null());
                if job.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let gesetzt = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if gesetzt == 0 || AssignProcessToJobObject(job, kind.as_raw_handle() as HANDLE) == 0 {
                    CloseHandle(job);
                    return None;
                }
                Some(Job(job))
            }
        }

        pub fn beenden(&self) {
            // SAFETY: gültiges Job-Handle.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: einmaliges Schließen des eigenen Handles; KILL_ON_JOB_CLOSE beendet den Rest des Baums.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::process::{Command, Stdio};

        fn schlaefer() -> Child {
            Command::new("ping").args(["-n", "60", "127.0.0.1"]).stdout(Stdio::null()).spawn().expect("ping startet")
        }

        #[test]
        fn terminate_beendet_den_prozess() {
            let mut k = schlaefer();
            let job = Job::neu_mit(&k).expect("Job-Objekt");
            assert!(k.try_wait().unwrap().is_none());
            job.beenden();
            assert!(k.wait().is_ok());
        }

        #[test]
        fn schliessen_des_jobs_beendet_den_prozess() {
            let mut k = schlaefer();
            let job = Job::neu_mit(&k).expect("Job-Objekt");
            drop(job);
            assert!(k.wait().is_ok());
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Stdio;

    #[test]
    fn gruppe_beendet_den_ganzen_baum() {
        let mut c = Command::new("sh");
        c.args(["-c", "sleep 30 & echo $! ; wait"]).stdout(Stdio::piped());
        vorbereiten(&mut c);
        let mut kind = c.spawn().unwrap();
        let gruppe = anbinden(&kind);
        let mut zeile = String::new();
        std::io::BufRead::read_line(&mut std::io::BufReader::new(kind.stdout.take().unwrap()), &mut zeile).unwrap();
        let enkel: i32 = zeile.trim().parse().unwrap();
        assert!(unsafe { libc::kill(enkel, 0) } == 0);
        assert!(gruppe.sanft(&kind), "Unix kennt den höflichen Weg");
        gruppe.hart(&mut kind);
        let ende = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while unsafe { libc::kill(enkel, 0) } == 0 && std::time::Instant::now() < ende {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(unsafe { libc::kill(enkel, 0) } != 0, "Enkel lebt noch");
    }
}
