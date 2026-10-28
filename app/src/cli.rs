//! Kommandozeile. Ohne Argument öffnet sich das Fenster. Die übrigen Modi laufen ohne Fenster, schreiben **eine**
//! JSON-Zeile auf stdout und beenden mit einem Ausgangscode (0 gut, 2 Fehler mit Katalogtext, 3 Selbsttest gescheitert).
//! Sie sind der Weg für Skripte, CI und Support: dieselbe Logik wie die Knöpfe im Fenster.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Modus {
    /// Fenster öffnen; `versteckt` startet nur im Tray (Anmeldestart).
    Fenster { versteckt: bool },
    /// Prüft Start, Begleiter, Fenster und Rust-Befehl; kein sichtbares Fenster.
    Selbsttest,
    /// Sucht ein Update und spielt es ein (ohne Neustart).
    Aktualisieren,
    /// Geht auf die gemerkte Vorversion zurück (ohne Neustart).
    Zurueck,
    /// Gibt Profil, Version und Vorversion aus.
    Info,
    /// Schreibt den Fehlerbericht auf den Schreibtisch und gibt den Pfad aus.
    Bericht,
    /// Schaltet den Start bei der Anmeldung ein (`true`) oder aus (`false`).
    Autostart(bool),
    /// Kopiert Chats und Einstellungen aus dem bestehenden Python-Studio (`trocken`: nur zeigen).
    UebernehmenStudio { trocken: bool },
}

pub const HILFE: &str = "Aufruf: fyos-shell [--versteckt | --selbsttest | --aktualisieren | --zurueck | --info | --bericht | --autostart-an | --autostart-aus | --uebernehmen-studio [--trocken]]\n\
  (ohne Argument)  Fenster öffnen\n\
  --versteckt      nur im Tray starten\n\
  --selbsttest     Start, Begleiter, Fenster und Befehl prüfen, Ausgang 0 = gut\n\
  --aktualisieren  Update suchen und einspielen (ohne Neustart)\n\
  --zurueck        auf die gemerkte Vorversion zurückgehen (ohne Neustart)\n\
  --info           Profil, Version, Vorversion, Datenordner
  --bericht        Fehlerbericht (ohne Geheimnisse) als Datei auf den Schreibtisch schreiben
  --autostart-an   App bei der Anmeldung starten (nur im Tray); --autostart-aus nimmt es zurück\n\
  --uebernehmen-studio  Chats und Einstellungen aus dem bestehenden Python-Studio kopieren (nur Studio-Profil, einmalig, überschreibt nichts)\n\
  --trocken        mit --uebernehmen-studio: nur zeigen, was kopiert würde\n\
  Umgebung: FYOS_SHELL_DATEN überschreibt den Datenordner (Tests).";

/// Wertet die Argumente aus (ohne Programmnamen). Argumente ohne `--` (Deeplinks, macOS-Zusätze) werden ignoriert.
pub fn auswerten(args: &[String]) -> Result<Modus, String> {
    let mut modus = Modus::Fenster { versteckt: false };
    let mut gesetzt = false;
    let trocken = args.iter().any(|a| a == "--trocken");
    for a in args.iter().filter(|a| a.starts_with("--")) {
        let neu = match a.as_str() {
            "--trocken" => continue,
            "--uebernehmen-studio" => Modus::UebernehmenStudio { trocken },
            "--versteckt" => Modus::Fenster { versteckt: true },
            "--selbsttest" => Modus::Selbsttest,
            "--aktualisieren" => Modus::Aktualisieren,
            "--zurueck" => Modus::Zurueck,
            "--info" => Modus::Info,
            "--bericht" => Modus::Bericht,
            "--autostart-an" => Modus::Autostart(true),
            "--autostart-aus" => Modus::Autostart(false),
            "--help" | "--hilfe" => return Err(HILFE.to_string()),
            andere => return Err(format!("Unbekannte Option {andere}.\n{HILFE}")),
        };
        if gesetzt {
            return Err(format!("Nur eine Option auf einmal.\n{HILFE}"));
        }
        modus = neu;
        gesetzt = true;
    }
    if trocken && !matches!(modus, Modus::UebernehmenStudio { .. }) {
        return Err(format!("--trocken gehört zu --uebernehmen-studio.\n{HILFE}"));
    }
    Ok(modus)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn ohne_argument_ist_fenster() {
        assert_eq!(auswerten(&[]).unwrap(), Modus::Fenster { versteckt: false });
    }

    #[test]
    fn die_modi() {
        assert_eq!(auswerten(&a(&["--versteckt"])).unwrap(), Modus::Fenster { versteckt: true });
        assert_eq!(auswerten(&a(&["--selbsttest"])).unwrap(), Modus::Selbsttest);
        assert_eq!(auswerten(&a(&["--aktualisieren"])).unwrap(), Modus::Aktualisieren);
        assert_eq!(auswerten(&a(&["--zurueck"])).unwrap(), Modus::Zurueck);
        assert_eq!(auswerten(&a(&["--info"])).unwrap(), Modus::Info);
        assert_eq!(auswerten(&a(&["--bericht"])).unwrap(), Modus::Bericht);
        assert_eq!(auswerten(&a(&["--autostart-an"])).unwrap(), Modus::Autostart(true));
        assert_eq!(auswerten(&a(&["--autostart-aus"])).unwrap(), Modus::Autostart(false));
        assert_eq!(auswerten(&a(&["--uebernehmen-studio"])).unwrap(), Modus::UebernehmenStudio { trocken: false });
        assert_eq!(auswerten(&a(&["--uebernehmen-studio", "--trocken"])).unwrap(), Modus::UebernehmenStudio { trocken: true });
        assert_eq!(auswerten(&a(&["--trocken", "--uebernehmen-studio"])).unwrap(), Modus::UebernehmenStudio { trocken: true });
        assert!(auswerten(&a(&["--trocken"])).unwrap_err().contains("gehört zu --uebernehmen-studio"));
        assert!(auswerten(&a(&["--info", "--trocken"])).unwrap_err().contains("gehört zu"));
    }

    #[test]
    fn deeplinks_und_fremde_argumente_stoeren_nicht() {
        assert_eq!(auswerten(&a(&["fle://oeffnen?ziel=seite:x", "-psn_0_1"])).unwrap(), Modus::Fenster { versteckt: false });
    }

    #[test]
    fn unbekannt_und_doppelt_nennen_die_hilfe() {
        assert!(auswerten(&a(&["--foo"])).unwrap_err().contains("Aufruf:"));
        assert!(auswerten(&a(&["--info", "--zurueck"])).unwrap_err().contains("Nur eine Option"));
    }
}
