//! Das Python-Bündel des Studio-Profils: Interpreter, Studio und Shim liegen als Ressourcen im Programmpaket (gebaut von `tools/buendel_bauen.py`).
//! Dieses Modul liest nur die Beschreibung `buendel.json` und leitet daraus den Begleiter ab. Es führt nichts aus.
//!
//! - Alles im Bündel gehört dem Paket und wird mit einem Update ausgetauscht. **Daten, Einstellungen und Plugins des Nutzers liegen außerhalb**
//!   (`<Datenordner>/studio-home` für das Studio, `<Datenordner>/studio-plugins` für Plugin-Pakete des Nutzers).
//! - Der Interpreter-Pfad steht relativ in `buendel.json` (`python/bin/python3.11`, Windows `python/python.exe`); die Hülle hängt ihn an den
//!   Ressourcenordner der App. Die Pfadlogik ist plattformneutral und mit beiden Schreibweisen getestet.

use crate::begleiter::BegleiterKonfig;
use crate::fehler::Fehler;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
struct Beschreibung {
    format: u32,
    system: String,
    python: PythonInfo,
    studio: StudioInfo,
    shim: String,
}

#[derive(Debug, Deserialize)]
struct PythonInfo {
    version: String,
    interpreter: String,
}

#[derive(Debug, Deserialize)]
struct StudioInfo {
    version: String,
    ordner: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Buendel {
    pub system: String,
    pub python_version: String,
    pub studio_version: String,
    pub interpreter: PathBuf,
    pub studio_ordner: PathBuf,
    pub shim: PathBuf,
}

/// Liste für `PYTHONPATH` mit dem Trenner des Zielsystems (`windows` wählt `;` statt `:`).
pub fn pfadliste(teile: &[&Path], windows: bool) -> String {
    teile.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>().join(if windows { ";" } else { ":" })
}

/// Ordner für Plugin-Pakete des Nutzers (entpackte Pakete mit `.dist-info`). Er wird in `PYTHONPATH` aufgenommen, wenn er existiert;
/// die Hülle legt ihn nie an und schreibt nie hinein.
pub fn nutzer_plugins(daten: &Path) -> PathBuf {
    daten.join("studio-plugins")
}

/// Namen der Einträge in `<Datenordner>/studio-plugins` (sortiert), nur zur Anzeige „n Plugins des Nutzers gefunden“.
pub fn nutzer_plugins_gefunden(daten: &Path) -> Vec<String> {
    let mut namen: Vec<String> = std::fs::read_dir(nutzer_plugins(daten))
        .map(|d| d.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| !n.starts_with('.') && n != "__pycache__").collect())
        .unwrap_or_default();
    namen.sort();
    namen
}

impl Buendel {
    /// Liest `<ressourcen>/buendel.json`. `Ok(None)`: es gibt kein Bündel (Entwicklungsbau). `Err`: es ist da, aber unvollständig.
    pub fn lesen(ressourcen: &Path) -> Result<Option<Buendel>, Fehler> {
        let datei = ressourcen.join("buendel.json");
        let text = match std::fs::read_to_string(&datei) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(Fehler::BuendelUnvollstaendig { grund: format!("{}: {e}", datei.display()) }),
        };
        let b: Beschreibung = serde_json::from_str(&text).map_err(|e| Fehler::BuendelUnvollstaendig { grund: format!("buendel.json ist unlesbar ({e})") })?;
        if b.format != 1 {
            return Err(Fehler::BuendelUnvollstaendig { grund: format!("unbekanntes Format {} der Beschreibung", b.format) });
        }
        let buendel = Buendel {
            system: b.system,
            python_version: b.python.version,
            studio_version: b.studio.version,
            interpreter: ressourcen.join(&b.python.interpreter),
            studio_ordner: ressourcen.join(&b.studio.ordner),
            shim: ressourcen.join(&b.shim),
        };
        for (was, pfad) in [("Interpreter", &buendel.interpreter), ("Studio", &buendel.studio_ordner), ("Shim", &buendel.shim)] {
            if !pfad.exists() {
                return Err(Fehler::BuendelUnvollstaendig { grund: format!("{was} fehlt: {}", pfad.display()) });
            }
        }
        Ok(Some(buendel))
    }

    /// Der Begleiter des Bündels: der Shim, davor der Hülle gegenüber verantwortlich für Port und Kennung, startet das Studio aus dem Bündel.
    /// Port und Kennung setzt die Hülle (`{port}`, `{kennung}`); den Port des Studios wählt der Shim (`{upstream}`).
    pub fn begleiter_konfig(&self, daten: &Path, windows: bool) -> BegleiterKonfig {
        let python = self.interpreter.to_string_lossy().into_owned();
        let home = daten.join("studio-home");
        let plugins = nutzer_plugins(daten);
        let mut pfade: Vec<&Path> = vec![&self.studio_ordner];
        if plugins.is_dir() {
            pfade.push(&plugins);
        }
        let env = BTreeMap::from([
            ("PYTHONPATH".to_string(), pfadliste(&pfade, windows)),
            // Das Paket ist nur lesbar zu denken: keine .pyc ins Paket, keine Benutzer-Pakete von außen, feste Kodierung
            ("PYTHONDONTWRITEBYTECODE".to_string(), "1".to_string()),
            ("PYTHONNOUSERSITE".to_string(), "1".to_string()),
            ("PYTHONUTF8".to_string(), "1".to_string()),
            // Sagt dem Studio: Updates kommen über die App (siehe studio-patch/)
            ("FLE_STUDIO_MANAGED_BY".to_string(), "fyos-shell".to_string()),
        ]);
        BegleiterKonfig {
            programm: python.clone(),
            args: [
                self.shim.to_string_lossy().as_ref(),
                "--port",
                "{port}",
                "--kennung",
                "{kennung}",
                "--",
                &python,
                "-m",
                "fle_studio",
                "--port",
                "{upstream}",
                "--no-browser",
                "--home",
                home.to_string_lossy().as_ref(),
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
            env,
            frist_s: 60,
            port: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn bauen(ressourcen: &Path, interpreter: &str) {
        fs::create_dir_all(ressourcen.join("studio")).unwrap();
        fs::create_dir_all(ressourcen.join("shim")).unwrap();
        fs::write(ressourcen.join("shim/begleiter_shim.py"), "#").unwrap();
        let ip = ressourcen.join(interpreter);
        fs::create_dir_all(ip.parent().unwrap()).unwrap();
        fs::write(&ip, "x").unwrap();
        fs::write(
            ressourcen.join("buendel.json"),
            format!(
                r#"{{"format":1,"system":"macos-aarch64","python":{{"version":"3.11.18","release":"x","interpreter":"{interpreter}"}},
                "studio":{{"version":"0.4.1","commit":"c","pakete":["fle_studio"],"ordner":"studio"}},"shim":"shim/begleiter_shim.py"}}"#
            ),
        )
        .unwrap();
    }

    #[test]
    fn ohne_beschreibung_gibt_es_kein_buendel() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(Buendel::lesen(d.path()).unwrap(), None);
    }

    #[test]
    fn lesen_und_pfade_relativ_zum_ressourcenordner() {
        let d = tempfile::tempdir().unwrap();
        bauen(d.path(), "python/bin/python3.11");
        let b = Buendel::lesen(d.path()).unwrap().unwrap();
        assert_eq!((b.python_version.as_str(), b.studio_version.as_str()), ("3.11.18", "0.4.1"));
        assert_eq!(b.interpreter, d.path().join("python/bin/python3.11"));
        assert_eq!(b.studio_ordner, d.path().join("studio"));
    }

    #[test]
    fn windows_interpreter_aus_der_beschreibung() {
        let d = tempfile::tempdir().unwrap();
        bauen(d.path(), "python/python.exe");
        let b = Buendel::lesen(d.path()).unwrap().unwrap();
        assert!(b.interpreter.ends_with("python.exe"));
        let k = b.begleiter_konfig(Path::new("C:/Daten"), true);
        assert_eq!(k.programm, b.interpreter.to_string_lossy());
    }

    #[test]
    fn unvollstaendiges_oder_kaputtes_buendel_hat_katalogtext() {
        let d = tempfile::tempdir().unwrap();
        bauen(d.path(), "python/bin/python3.11");
        fs::remove_file(d.path().join("python/bin/python3.11")).unwrap();
        let f = Buendel::lesen(d.path()).unwrap_err();
        assert_eq!(f.code(), "BUENDEL_UNVOLLSTAENDIG");
        assert!(f.meldung().details.unwrap().contains("Interpreter fehlt"));
        fs::write(d.path().join("buendel.json"), "{kaputt").unwrap();
        assert_eq!(Buendel::lesen(d.path()).unwrap_err().code(), "BUENDEL_UNVOLLSTAENDIG");
        fs::write(d.path().join("buendel.json"), r#"{"format":2,"system":"x","python":{"version":"1","interpreter":"a"},"studio":{"version":"1","ordner":"s"},"shim":"s"}"#).unwrap();
        assert!(Buendel::lesen(d.path()).unwrap_err().meldung().details.unwrap().contains("Format 2"));
    }

    #[test]
    fn begleiter_konfig_startet_den_shim_mit_port_kennung_und_dem_studio_aus_dem_buendel() {
        let d = tempfile::tempdir().unwrap();
        let res = d.path().join("res");
        bauen(&res, "python/bin/python3.11");
        let b = Buendel::lesen(&res).unwrap().unwrap();
        let daten = d.path().join("daten");
        let k = b.begleiter_konfig(&daten, false);
        let py = res.join("python/bin/python3.11").to_string_lossy().into_owned();
        assert_eq!(k.programm, py);
        let a = &k.args;
        assert_eq!(a[0], res.join("shim/begleiter_shim.py").to_string_lossy());
        assert_eq!(&a[1..6], ["--port", "{port}", "--kennung", "{kennung}", "--"]);
        assert_eq!(&a[6..9], [py.as_str(), "-m", "fle_studio"]);
        assert!(a.windows(2).any(|w| w == ["--port", "{upstream}"]));
        assert!(a.contains(&"--no-browser".to_string()));
        let i = a.iter().position(|x| x == "--home").unwrap();
        assert_eq!(a[i + 1], daten.join("studio-home").to_string_lossy(), "Daten des Studios liegen außerhalb des Pakets");
        assert!(!k.args.iter().any(|x| x.contains("{tresor")));
        assert_eq!(k.env["FLE_STUDIO_MANAGED_BY"], "fyos-shell");
        assert_eq!(k.env["PYTHONDONTWRITEBYTECODE"], "1");
        assert_eq!(k.env["PYTHONPATH"], res.join("studio").to_string_lossy(), "ohne Plugin-Ordner nur das Studio");
    }

    #[test]
    fn plugin_ordner_des_nutzers_kommt_in_den_suchpfad_wird_aber_nie_angelegt() {
        let d = tempfile::tempdir().unwrap();
        let res = d.path().join("res");
        bauen(&res, "python/bin/python3.11");
        let b = Buendel::lesen(&res).unwrap().unwrap();
        let daten = d.path().join("daten");
        fs::create_dir_all(&daten).unwrap();
        let k = b.begleiter_konfig(&daten, false);
        assert!(!nutzer_plugins(&daten).exists(), "die Hülle legt den Plugin-Ordner nie an");
        assert!(!k.env["PYTHONPATH"].contains("studio-plugins"));
        fs::create_dir_all(nutzer_plugins(&daten).join("mein_plugin-1.0.dist-info")).unwrap();
        fs::create_dir_all(nutzer_plugins(&daten).join("mein_plugin")).unwrap();
        fs::write(nutzer_plugins(&daten).join(".versteckt"), "").unwrap();
        let k = b.begleiter_konfig(&daten, false);
        assert_eq!(k.env["PYTHONPATH"], format!("{}:{}", res.join("studio").display(), nutzer_plugins(&daten).display()));
        assert_eq!(nutzer_plugins_gefunden(&daten), ["mein_plugin", "mein_plugin-1.0.dist-info"]);
        assert!(nutzer_plugins_gefunden(&d.path().join("gibt-es-nicht")).is_empty());
    }

    #[test]
    fn pfadliste_mit_dem_trenner_des_zielsystems() {
        let (a, b) = (Path::new("C:\\App\\studio"), Path::new("C:\\Daten\\studio-plugins"));
        assert_eq!(pfadliste(&[a, b], true), "C:\\App\\studio;C:\\Daten\\studio-plugins");
        assert_eq!(pfadliste(&[Path::new("/a"), Path::new("/b")], false), "/a:/b");
    }
}
