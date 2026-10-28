//! Dateien im Datenordner: atomar schreiben (erst Nachbardatei, dann umbenennen), damit ein Absturz oder eine volle
//! Platte nie eine halbe Datei hinterlässt. Der Datenordner liegt **außerhalb** des Programmpakets; ein Update fasst ihn nicht an.

use crate::fehler::Fehler;
use serde::{de::DeserializeOwned, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Alle Dateien der Hülle unter einem Datenordner.
#[derive(Debug, Clone)]
pub struct Pfade {
    pub daten: PathBuf,
}

impl Pfade {
    pub fn neu(daten: impl Into<PathBuf>) -> Pfade {
        Pfade { daten: daten.into() }
    }

    pub fn einstellungen(&self) -> PathBuf {
        self.daten.join("einstellungen.json")
    }

    pub fn verlauf(&self) -> PathBuf {
        self.daten.join("versionen.json")
    }

    /// Legt den Datenordner an, falls er fehlt.
    pub fn anlegen(&self) -> Result<(), Fehler> {
        fs::create_dir_all(&self.daten).map_err(|e| Fehler::aus_io(&e, &self.daten))
    }
}

/// Schreibt `inhalt` atomar nach `ziel` (gleicher Ordner, damit das Umbenennen atomar bleibt).
pub fn atomar_schreiben(ziel: &Path, inhalt: &[u8]) -> Result<(), Fehler> {
    let io = |e: std::io::Error| Fehler::aus_io(&e, ziel);
    let ordner = ziel.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(ordner).map_err(io)?;
    let name = ziel.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let vorlaeufig = ordner.join(format!(".{name}.neu"));
    let ergebnis = (|| {
        let mut datei = fs::File::create(&vorlaeufig)?;
        datei.write_all(inhalt)?;
        datei.sync_all()?;
        fs::rename(&vorlaeufig, ziel)
    })();
    if let Err(e) = ergebnis {
        let _ = fs::remove_file(&vorlaeufig);
        return Err(io(e));
    }
    Ok(())
}

pub fn json_schreiben<T: Serialize>(ziel: &Path, wert: &T) -> Result<(), Fehler> {
    let mut text = serde_json::to_vec_pretty(wert).map_err(|e| Fehler::DatenordnerNichtBeschreibbar {
        pfad: ziel.display().to_string(),
        grund: e.to_string(),
    })?;
    text.push(b'\n');
    atomar_schreiben(ziel, &text)
}

/// Ergebnis des Lesens einer JSON-Datei.
#[derive(Debug)]
pub enum Gelesen<T> {
    Fehlt,
    Ok(T),
    /// Datei ist da, aber nicht lesbar; sie wurde als `<name>.kaputt` zur Seite gelegt.
    Kaputt(Fehler),
}

pub fn json_lesen<T: DeserializeOwned>(quelle: &Path) -> Gelesen<T> {
    let text = match fs::read_to_string(quelle) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Gelesen::Fehlt,
        Err(e) => {
            return Gelesen::Kaputt(Fehler::DatenordnerNichtBeschreibbar {
                pfad: quelle.display().to_string(),
                grund: e.to_string(),
            })
        }
    };
    match serde_json::from_str::<T>(&text) {
        Ok(w) => Gelesen::Ok(w),
        Err(e) => {
            let mut kopie = quelle.as_os_str().to_owned();
            kopie.push(".kaputt");
            let _ = fs::rename(quelle, PathBuf::from(kopie));
            Gelesen::Kaputt(Fehler::EinstellungenKaputt { pfad: quelle.display().to_string(), grund: e.to_string() })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn schreiben_und_lesen() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("unter/a.json");
        json_schreiben(&p, &json!({"a": 1})).unwrap();
        match json_lesen::<Value>(&p) {
            Gelesen::Ok(v) => assert_eq!(v["a"], 1),
            _ => panic!("gelesen"),
        }
        // keine Reste
        let reste: Vec<_> = fs::read_dir(d.path().join("unter")).unwrap().collect();
        assert_eq!(reste.len(), 1);
    }

    #[test]
    fn fehlende_datei() {
        let d = tempfile::tempdir().unwrap();
        assert!(matches!(json_lesen::<Value>(&d.path().join("x.json")), Gelesen::Fehlt));
    }

    #[test]
    fn kaputte_datei_wird_zur_seite_gelegt() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("e.json");
        fs::write(&p, "{ kaputt").unwrap();
        match json_lesen::<Value>(&p) {
            Gelesen::Kaputt(f) => assert_eq!(f.code(), "EINSTELLUNGEN_KAPUTT"),
            _ => panic!("kaputt erwartet"),
        }
        assert!(!p.exists());
        assert!(d.path().join("e.json.kaputt").exists());
    }

    #[test]
    fn pfade_liegen_im_datenordner() {
        let p = Pfade::neu("/x/daten");
        assert_eq!(p.einstellungen(), PathBuf::from("/x/daten/einstellungen.json"));
        assert_eq!(p.verlauf(), PathBuf::from("/x/daten/versionen.json"));
    }
}
