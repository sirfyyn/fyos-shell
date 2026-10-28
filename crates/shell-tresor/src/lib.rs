//! Systemtresor: Geheimnisse im Schlüsselbund des Betriebssystems statt in Dateien.
//!
//! - macOS: Schlüsselbund (Keychain), Dienst = Bundle-Id der App (`de.sirfyyn.fle-studio` usw.), Konto = Name des Eintrags
//! - Windows: Anmeldeinformationsverwaltung (Credential Manager)
//! - Linux: Secret Service über D-Bus (GNOME Keyring, KWallet mit Brücke); fehlt der Dienst, meldet der Tresor
//!   `TRESOR_NICHT_VERFUEGBAR` mit Abhilfe, und die Anwendung läuft ohne Geheimnisse weiter (kein stilles Ausweichen auf eine Datei)
//!
//! Die Einträge heißen wie die Bundle-Id der App und sind je Profil getrennt. Jeder Zugriff geht über [`shell_core::tresor::Tresor`].
//! Eine echte Probe gegen den Systemtresor gibt es nur ausdrücklich (`FYOS_TRESOR_ECHT=1 cargo test -p shell-tresor -- --ignored`), nie von allein.

use keyring::{Entry, Error as KeyringFehler};
use shell_core::tresor::{Tresor, TresorFehler};

type Erzeuger = Box<dyn Fn(&str) -> Result<Entry, KeyringFehler> + Send + Sync>;

pub struct SystemTresor {
    erzeuger: Erzeuger,
}

impl SystemTresor {
    /// `dienst` ist die Bundle-Id des Profils.
    pub fn neu(dienst: &str) -> SystemTresor {
        let dienst = dienst.to_string();
        SystemTresor { erzeuger: Box::new(move |name| Entry::new(&dienst, name)) }
    }

    /// Für Tests: eigener Erzeuger der Einträge.
    pub fn mit_erzeuger(erzeuger: Erzeuger) -> SystemTresor {
        SystemTresor { erzeuger }
    }

    fn eintrag(&self, name: &str) -> Result<Entry, TresorFehler> {
        (self.erzeuger)(name).map_err(uebersetzen)
    }
}

/// Fehler des Schlüsselbunds in die zwei Arten der Hülle: „nicht da“ (Dienst fehlt) und „Zugriff verweigert“.
pub fn uebersetzen(f: KeyringFehler) -> TresorFehler {
    match f {
        KeyringFehler::PlatformFailure(e) => TresorFehler::NichtVerfuegbar(e.to_string()),
        KeyringFehler::NoStorageAccess(e) => TresorFehler::Zugriff(e.to_string()),
        andere => TresorFehler::Zugriff(andere.to_string()),
    }
}

impl Tresor for SystemTresor {
    fn lesen(&self, name: &str) -> Result<Option<String>, TresorFehler> {
        match self.eintrag(name)?.get_password() {
            Ok(w) => Ok(Some(w)),
            Err(KeyringFehler::NoEntry) => Ok(None),
            Err(e) => Err(uebersetzen(e)),
        }
    }

    fn schreiben(&self, name: &str, wert: &str) -> Result<(), TresorFehler> {
        self.eintrag(name)?.set_password(wert).map_err(uebersetzen)
    }

    fn loeschen(&self, name: &str) -> Result<(), TresorFehler> {
        match self.eintrag(name)?.delete_credential() {
            Ok(()) | Err(KeyringFehler::NoEntry) => Ok(()),
            Err(e) => Err(uebersetzen(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use keyring::credential::{Credential, CredentialApi};
    use std::any::Any;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct Zustand {
        wert: Option<Vec<u8>>,
        fehler: Option<fn() -> KeyringFehler>,
    }

    /// Ein Eintrag im Speicher, der sich zwischen Zugriffen merkt (anders als das Mock-Paket von keyring) und Fehler vorspielen kann.
    struct Attrappe(Arc<Mutex<Zustand>>);

    impl CredentialApi for Attrappe {
        fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
            let mut z = self.0.lock().unwrap();
            if let Some(f) = z.fehler {
                return Err(f());
            }
            z.wert = Some(secret.to_vec());
            Ok(())
        }
        fn get_secret(&self) -> keyring::Result<Vec<u8>> {
            let z = self.0.lock().unwrap();
            if let Some(f) = z.fehler {
                return Err(f());
            }
            z.wert.clone().ok_or(KeyringFehler::NoEntry)
        }
        fn delete_credential(&self) -> keyring::Result<()> {
            let mut z = self.0.lock().unwrap();
            if let Some(f) = z.fehler {
                return Err(f());
            }
            z.wert.take().map(|_| ()).ok_or(KeyringFehler::NoEntry)
        }
        fn as_any(&self) -> &dyn Any {
            self
        }
    }

    fn tresor_mit(zustand: Arc<Mutex<Zustand>>) -> SystemTresor {
        SystemTresor::mit_erzeuger(Box::new(move |_| {
            let b: Box<Credential> = Box::new(Attrappe(zustand.clone()));
            Ok(Entry::new_with_credential(b))
        }))
    }

    fn fehler_dienst() -> KeyringFehler {
        KeyringFehler::PlatformFailure("org.freedesktop.secrets wurde von keinem Dienst bereitgestellt".into())
    }

    fn fehler_gesperrt() -> KeyringFehler {
        KeyringFehler::NoStorageAccess("Schlüsselbund ist gesperrt".into())
    }

    #[test]
    fn schreiben_lesen_loeschen_und_fehlend() {
        let t = tresor_mit(Arc::default());
        assert_eq!(t.lesen("x").unwrap(), None);
        t.schreiben("x", "geheim-ö").unwrap();
        assert_eq!(t.lesen("x").unwrap().as_deref(), Some("geheim-ö"));
        t.loeschen("x").unwrap();
        assert_eq!(t.lesen("x").unwrap(), None);
        t.loeschen("x").unwrap(); // zweites Löschen ist kein Fehler
    }

    #[test]
    fn dienst_fehlt_ist_nicht_verfuegbar_mit_katalogtext() {
        let z: Arc<Mutex<Zustand>> = Arc::default();
        z.lock().unwrap().fehler = Some(fehler_dienst);
        let t = tresor_mit(z);
        let f: shell_core::Fehler = t.lesen("x").unwrap_err().into();
        assert_eq!(f.code(), "TRESOR_NICHT_VERFUEGBAR");
        let m = f.meldung();
        assert!(m.details.unwrap().contains("secrets"));
        assert!(m.abhilfe.contains("Linux") && m.abhilfe.contains("Schlüsselbund"));
        assert!(matches!(t.schreiben("x", "y"), Err(TresorFehler::NichtVerfuegbar(_))));
    }

    #[test]
    fn gesperrt_ist_zugriff_verweigert() {
        let z: Arc<Mutex<Zustand>> = Arc::default();
        z.lock().unwrap().fehler = Some(fehler_gesperrt);
        let t = tresor_mit(z);
        let f: shell_core::Fehler = t.schreiben("x", "y").unwrap_err().into();
        assert_eq!(f.code(), "TRESOR_ZUGRIFF");
    }

    #[test]
    fn verweis_in_der_konfiguration_wird_ueber_den_tresor_aufgeloest() {
        let t = tresor_mit(Arc::default());
        t.schreiben("hf-token", "hf_abc").unwrap();
        assert_eq!(shell_core::tresor::aufloesen("--t={tresor:hf-token}", &t).unwrap(), "--t=hf_abc");
    }

    /// Echte Probe gegen den Systemtresor; nur auf ausdrücklichen Wunsch (schreibt und löscht einen Eintrag „fyos-shell-probe“).
    /// Nie auf dem Entwicklungs-Mac ausführen, wenn der Schlüsselbund tabu ist; im CI auf Windows (Anmeldeinformationsverwaltung) vorgesehen.
    #[test]
    #[ignore]
    fn echter_systemtresor_roundtrip() {
        if std::env::var("FYOS_TRESOR_ECHT").as_deref() != Ok("1") {
            eprintln!("übersprungen: FYOS_TRESOR_ECHT=1 setzen");
            return;
        }
        let t = SystemTresor::neu("de.sirfyyn.fyos-shell-test");
        t.schreiben("fyos-shell-probe", "wert-1").unwrap();
        assert_eq!(t.lesen("fyos-shell-probe").unwrap().as_deref(), Some("wert-1"));
        t.schreiben("fyos-shell-probe", "wert-2").unwrap();
        assert_eq!(t.lesen("fyos-shell-probe").unwrap().as_deref(), Some("wert-2"));
        t.loeschen("fyos-shell-probe").unwrap();
        assert_eq!(t.lesen("fyos-shell-probe").unwrap(), None);
    }
}
