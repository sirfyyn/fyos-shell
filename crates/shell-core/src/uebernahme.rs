//! Einmalige Übernahme von Chats und Einstellungen aus einem bestehenden Python-Studio in `<Datenordner>/studio-home` der Hülle.
//!
//! Regeln: Es wird **kopiert**, nie verschoben, nie etwas überschrieben (eine vorhandene Zieldatei bleibt, die Quelle wird als „übersprungen“ gemeldet),
//! das alte Verzeichnis wird nur gelesen. Ausgelassen werden Protokolle, der Update-Zustand des alten Studios sowie `models` und `engines` (groß und
//! anderswo wiederherstellbar; Hinweis statt Kopie). Symbolische Links werden nicht verfolgt. Dateirechte bleiben erhalten (`hosts.json` ist `0600`).
//! Die Studio-eigenen Dateien (`settings.json`, `hosts.json`) kommen unverändert hinüber, nie in die `einstellungen.json` der Hülle.
//!
//! Wo das alte Studio liegt, steht in seinem Quelltext (`fle_studio/paths.py`, `data_dir()`, v0.4.1): `FLE_STUDIO_HOME` (überschreibt),
//! macOS `~/Library/Application Support/FLE Studio`, Windows `%LOCALAPPDATA%\FLE Studio`, sonst `$XDG_DATA_HOME/fle-studio` (Vorgabe `~/.local/share/fle-studio`).

use crate::fehler::Fehler;
use crate::speicher::atomar_schreiben;
use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum System {
    Mac,
    Windows,
    Linux,
}

impl System {
    pub fn dieses() -> System {
        if cfg!(target_os = "macos") {
            System::Mac
        } else if cfg!(target_os = "windows") {
            System::Windows
        } else {
            System::Linux
        }
    }
}

/// Datenordner des bestehenden Studios, wie `paths.data_dir()` im Studio ihn bestimmt.
pub fn altes_verzeichnis(system: System, heim: &Path, home_override: Option<&Path>, localappdata: Option<&Path>, xdg_data_home: Option<&Path>) -> PathBuf {
    if let Some(p) = home_override.filter(|p| !p.as_os_str().is_empty()) {
        return p.to_path_buf();
    }
    match system {
        System::Mac => heim.join("Library").join("Application Support").join("FLE Studio"),
        System::Windows => localappdata.filter(|p| !p.as_os_str().is_empty()).map(Path::to_path_buf).unwrap_or_else(|| heim.join("AppData").join("Local")).join("FLE Studio"),
        System::Linux => xdg_data_home.filter(|p| !p.as_os_str().is_empty()).map(Path::to_path_buf).unwrap_or_else(|| heim.join(".local").join("share")).join("fle-studio"),
    }
}

/// Oberste Einträge, die nie kopiert werden, mit dem Grund.
const AUSGELASSEN: [(&str, &str); 5] = [
    ("logs", "Protokolle des alten Studios"),
    ("update-check.json", "Update-Zustand des alten Studios"),
    ("update.log", "Update-Protokoll des alten Studios"),
    ("models", "Modelle sind groß und bleiben, wo sie sind"),
    ("engines", "Engines werden vom neuen Studio bei Bedarf neu installiert"),
];

const MARKE: &str = "uebernahme.json";
const GEHEIMNIS_SCHLUESSEL: [&str; 3] = ["hf_token", "access_key", "attach_key"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Datei {
    pub rel: PathBuf,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub quelle: PathBuf,
    pub ziel: PathBuf,
    /// wird kopiert
    pub kopieren: Vec<Datei>,
    /// im Ziel schon da, bleibt unangetastet
    pub vorhanden: Vec<PathBuf>,
    /// bewusst nicht kopiert (Pfad, Grund)
    pub ausgelassen: Vec<(PathBuf, String)>,
    /// Links, nicht verfolgt
    pub verlinkt: Vec<PathBuf>,
    /// nicht lesbar beim Planen (Pfad, Grund)
    pub unlesbar: Vec<(PathBuf, String)>,
    /// Hinweise für den Nutzer (z. B. Modelle bleiben im alten Ordner)
    pub hinweise: Vec<String>,
    /// Klartext-Geheimnisse in Studio-eigenen Dateien (Datei, Namen; nie Werte)
    pub befunde: Vec<String>,
}

impl Plan {
    pub fn bytes(&self) -> u64 {
        self.kopieren.iter().map(|d| d.bytes).sum()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Angebot {
    /// Kein altes Verzeichnis oder nichts Übernehmbares darin
    Nichts,
    /// Es gibt eine Marke `uebernahme.json`: schon einmal übernommen
    SchonUebernommen,
    /// Das neue Studio hat schon eigene Daten (Chats, Einstellungen, …)
    DatenVorhanden,
    Moeglich,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ergebnis {
    pub kopiert: usize,
    pub bytes: u64,
    pub uebersprungen: Vec<PathBuf>,
    pub fehlgeschlagen: Vec<(PathBuf, String)>,
}

fn ausgelassen_oben(name: &str) -> Option<&'static str> {
    AUSGELASSEN.iter().find(|(n, _)| *n == name).map(|(_, g)| *g)
}

fn zwischendatei(name: &str) -> bool {
    name.starts_with('.') || name.ends_with(".tmp") || name.ends_with(".neu")
}

/// Läuft rekursiv durch `dir` (relativ `rel`) und füllt den Plan. Links werden nicht verfolgt, unlesbare Ordner gemeldet.
fn gehen(plan: &mut Plan, dir: &Path, rel: &Path) {
    let eintraege = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            plan.unlesbar.push((rel.to_path_buf(), e.to_string()));
            return;
        }
    };
    let mut namen: Vec<_> = eintraege.flatten().collect();
    namen.sort_by_key(|e| e.file_name());
    for e in namen {
        let name = e.file_name().to_string_lossy().into_owned();
        let r = rel.join(&name);
        if rel.as_os_str().is_empty() {
            if let Some(grund) = ausgelassen_oben(&name) {
                plan.ausgelassen.push((r, grund.to_string()));
                continue;
            }
        }
        if zwischendatei(&name) {
            plan.ausgelassen.push((r, "Zwischendatei".to_string()));
            continue;
        }
        let typ = match e.file_type() {
            Ok(t) => t,
            Err(err) => {
                plan.unlesbar.push((r, err.to_string()));
                continue;
            }
        };
        if typ.is_symlink() {
            plan.verlinkt.push(r);
        } else if typ.is_dir() {
            gehen(plan, &e.path(), &r);
        } else if typ.is_file() {
            if plan.ziel.join(&r).exists() {
                plan.vorhanden.push(r);
            } else {
                let bytes = e.metadata().map(|m| m.len()).unwrap_or(0);
                plan.kopieren.push(Datei { rel: r, bytes });
            }
        }
    }
}

fn inhalt_hat(pfad: &Path) -> bool {
    fs::read_dir(pfad).map(|mut d| d.next().is_some()).unwrap_or(false)
}

/// Namen von Geheimnissen mit Klartextwert in `settings.json` und Anzahl Tokens in `hosts.json` des alten Studios (nie die Werte).
fn befunde_suchen(quelle: &Path) -> Vec<String> {
    let mut b = Vec::new();
    if let Ok(text) = fs::read_to_string(quelle.join("settings.json")) {
        if let Ok(Value::Object(o)) = serde_json::from_str::<Value>(&text) {
            let gesetzt: Vec<&str> = GEHEIMNIS_SCHLUESSEL.iter().copied().filter(|k| o.get(*k).and_then(Value::as_str).is_some_and(|s| !s.is_empty())).collect();
            if !gesetzt.is_empty() {
                b.push(format!("settings.json enthält im Klartext: {}", gesetzt.join(", ")));
            }
        }
    }
    if let Ok(text) = fs::read_to_string(quelle.join("hosts.json")) {
        if let Ok(Value::Array(hosts)) = serde_json::from_str::<Value>(&text) {
            let n = hosts.iter().filter(|h| h.get("token").and_then(Value::as_str).is_some_and(|s| !s.is_empty())).count();
            if n > 0 {
                b.push(format!("hosts.json enthält {n} Client-Token im Klartext"));
            }
        }
    }
    b
}

/// Plant die Übernahme (liest nur).
pub fn planen(quelle: &Path, ziel: &Path) -> Result<Plan, Fehler> {
    if !quelle.is_dir() {
        return Err(Fehler::UebernahmeQuelleFehlt { ort: quelle.display().to_string() });
    }
    if let Err(e) = fs::read_dir(quelle) {
        return Err(Fehler::UebernahmeFehlgeschlagen { ort: quelle.display().to_string(), grund: e.to_string() });
    }
    let mut plan = Plan {
        quelle: quelle.to_path_buf(),
        ziel: ziel.to_path_buf(),
        kopieren: vec![],
        vorhanden: vec![],
        ausgelassen: vec![],
        verlinkt: vec![],
        unlesbar: vec![],
        hinweise: vec![],
        befunde: befunde_suchen(quelle),
    };
    gehen(&mut plan, quelle, Path::new(""));
    if inhalt_hat(&quelle.join("models")) {
        plan.hinweise.push(format!(
            "Die Modelle liegen weiter unter {}. Im Studio unter Einstellungen den Modellordner dorthin setzen (oder die Dateien selbst verschieben).",
            quelle.join("models").display()
        ));
    }
    if inhalt_hat(&quelle.join("engines")) {
        plan.hinweise.push("Die Engines des alten Studios werden nicht übernommen; das neue Studio installiert sie bei Bedarf selbst.".to_string());
    }
    Ok(plan)
}

/// Hat das Ziel schon Daten des Studios (irgendeine Datei außer den ausgelassenen)?
pub fn ziel_hat_daten(ziel: &Path) -> bool {
    fn hat(dir: &Path, oben: bool) -> bool {
        let Ok(d) = fs::read_dir(dir) else { return false };
        for e in d.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if oben && ausgelassen_oben(&name).is_some() {
                continue;
            }
            match e.file_type() {
                Ok(t) if t.is_dir() => {
                    if hat(&e.path(), false) {
                        return true;
                    }
                }
                Ok(t) if t.is_file() => return true,
                _ => {}
            }
        }
        false
    }
    hat(ziel, true)
}

/// Was die Oberfläche anbietet. `daten` ist der Datenordner der Hülle (dort liegt die Marke).
pub fn angebot(quelle: &Path, daten: &Path) -> Angebot {
    if daten.join(MARKE).is_file() {
        return Angebot::SchonUebernommen;
    }
    let ziel = daten.join("studio-home");
    match planen(quelle, &ziel) {
        Ok(p) if !p.kopieren.is_empty() || !p.vorhanden.is_empty() => {
            if ziel_hat_daten(&ziel) {
                Angebot::DatenVorhanden
            } else {
                Angebot::Moeglich
            }
        }
        _ => Angebot::Nichts,
    }
}

fn kopieren_eine(quelle: &Path, ziel: &Path) -> io::Result<u64> {
    if let Some(eltern) = ziel.parent() {
        fs::create_dir_all(eltern)?;
    }
    let name = ziel.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let vorlaeufig = ziel.with_file_name(format!(".{name}.neu"));
    let _ = fs::remove_file(&vorlaeufig);
    let bytes = fs::copy(quelle, &vorlaeufig)?; // übernimmt die Dateirechte (hosts.json bleibt 0600)
    // hard_link scheitert, wenn das Ziel inzwischen existiert: so wird nie etwas überschrieben
    let ergebnis = fs::hard_link(&vorlaeufig, ziel);
    let _ = fs::remove_file(&vorlaeufig);
    ergebnis.map(|()| bytes)
}

/// Führt den Plan aus und schreibt die Marke `uebernahme.json` im Datenordner (ein zweiter Lauf wird verweigert).
pub fn ausfuehren(plan: &Plan, daten: &Path, jetzt_text: &str) -> Result<Ergebnis, Fehler> {
    if let Ok(alt) = fs::read_to_string(daten.join(MARKE)) {
        let wann = serde_json::from_str::<Value>(&alt).ok().and_then(|v| v.get("zeit").and_then(Value::as_str).map(str::to_string)).unwrap_or_default();
        return Err(Fehler::UebernahmeSchonErfolgt { wann });
    }
    let mut e = Ergebnis { kopiert: 0, bytes: 0, uebersprungen: plan.vorhanden.clone(), fehlgeschlagen: vec![] };
    for d in &plan.kopieren {
        match kopieren_eine(&plan.quelle.join(&d.rel), &plan.ziel.join(&d.rel)) {
            Ok(b) => {
                e.kopiert += 1;
                e.bytes += b;
            }
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => e.uebersprungen.push(d.rel.clone()),
            Err(err) if crate::fehler::ist_platte_voll(&err) => {
                return Err(Fehler::UebernahmeFehlgeschlagen { ort: plan.ziel.display().to_string(), grund: err.to_string() });
            }
            Err(err) => e.fehlgeschlagen.push((d.rel.clone(), err.to_string())),
        }
    }
    e.fehlgeschlagen.extend(plan.unlesbar.iter().cloned());
    let marke = serde_json::json!({
        "zeit": jetzt_text,
        "quelle": plan.quelle.display().to_string(),
        "kopiert": e.kopiert,
        "bytes": e.bytes,
        "uebersprungen": e.uebersprungen.len(),
        "fehlgeschlagen": e.fehlgeschlagen.len(),
    });
    // Die Marke gibt es nur, wenn etwas übernommen wurde: war alles fehlgeschlagen, bleibt ein neuer Versuch möglich.
    if e.kopiert > 0 || e.fehlgeschlagen.is_empty() {
        atomar_schreiben(&daten.join(MARKE), format!("{}\n", serde_json::to_string_pretty(&marke).unwrap_or_default()).as_bytes())?;
    }
    Ok(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schreibe(w: &Path, rel: &str, inhalt: &str) {
        let p = w.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, inhalt).unwrap();
    }

    fn altes_studio(w: &Path) {
        schreibe(w, "settings.json", r#"{"theme":"dark","hf_token":"","access_key":"","attach_key":""}"#);
        schreibe(w, "hosts.json", r#"[{"id":"host-a","token":"geheim-token-123"}]"#);
        schreibe(w, "plugins.json", r#"{"v":1}"#);
        schreibe(w, "chats/c1.json", r#"{"t":"hallo"}"#);
        schreibe(w, "chats/files/a.txt", "anhang");
        schreibe(w, "plugins/beispiel/settings.json", "{}");
        schreibe(w, "logs/studio.log", "log");
        schreibe(w, "update-check.json", "{}");
        schreibe(w, "update.log", "u");
    }

    fn baum(w: &Path) -> Vec<(String, Vec<u8>)> {
        fn lauf(d: &Path, w: &Path, aus: &mut Vec<(String, Vec<u8>)>) {
            let mut e: Vec<_> = fs::read_dir(d).unwrap().flatten().collect();
            e.sort_by_key(|x| x.file_name());
            for x in e {
                if x.file_type().unwrap().is_dir() {
                    lauf(&x.path(), w, aus);
                } else {
                    aus.push((x.path().strip_prefix(w).unwrap().display().to_string(), fs::read(x.path()).unwrap()));
                }
            }
        }
        let mut aus = vec![];
        lauf(w, w, &mut aus);
        aus
    }

    #[test]
    fn pfade_je_system_wie_im_studio() {
        let heim = Path::new("/h");
        assert_eq!(altes_verzeichnis(System::Mac, heim, None, None, None), PathBuf::from("/h/Library/Application Support/FLE Studio"));
        assert_eq!(altes_verzeichnis(System::Linux, heim, None, None, None), PathBuf::from("/h/.local/share/fle-studio"));
        assert_eq!(altes_verzeichnis(System::Linux, heim, None, None, Some(Path::new("/x"))), PathBuf::from("/x/fle-studio"));
        assert_eq!(altes_verzeichnis(System::Windows, Path::new("C:\\Users\\a"), None, Some(Path::new("D:\\Lokal")), None), PathBuf::from("D:\\Lokal").join("FLE Studio"));
        assert_eq!(
            altes_verzeichnis(System::Windows, Path::new("C:\\Users\\a"), None, None, None),
            PathBuf::from("C:\\Users\\a").join("AppData").join("Local").join("FLE Studio")
        );
        // FLE_STUDIO_HOME schlägt alles, leer zählt nicht
        assert_eq!(altes_verzeichnis(System::Mac, heim, Some(Path::new("/mein/home")), None, None), PathBuf::from("/mein/home"));
        assert_eq!(altes_verzeichnis(System::Mac, heim, Some(Path::new("")), None, None), PathBuf::from("/h/Library/Application Support/FLE Studio"));
    }

    #[test]
    fn leeres_oder_fehlendes_verzeichnis_bietet_nichts_an() {
        let d = tempfile::tempdir().unwrap();
        let daten = d.path().join("daten");
        assert_eq!(angebot(&d.path().join("gibt-es-nicht"), &daten), Angebot::Nichts);
        let leer = d.path().join("leer");
        fs::create_dir_all(leer.join("logs")).unwrap();
        schreibe(&leer, "logs/x.log", "nur Protokoll");
        assert_eq!(angebot(&leer, &daten), Angebot::Nichts, "nur Ausgelassenes ist nichts Übernehmbares");
        assert_eq!(planen(&d.path().join("gibt-es-nicht"), &daten).unwrap_err().code(), "UEBERNAHME_QUELLE_FEHLT");
    }

    #[test]
    fn gefuelltes_studio_wird_kopiert_ohne_ausgelassenes_und_ohne_das_alte_zu_aendern() {
        let d = tempfile::tempdir().unwrap();
        let alt = d.path().join("alt");
        altes_studio(&alt);
        let daten = d.path().join("daten");
        let ziel = daten.join("studio-home");
        let vorher = baum(&alt);
        assert_eq!(angebot(&alt, &daten), Angebot::Moeglich);
        let plan = planen(&alt, &ziel).unwrap();
        let rel: Vec<String> = plan.kopieren.iter().map(|x| x.rel.display().to_string().replace('\\', "/")).collect();
        assert_eq!(rel, ["chats/c1.json", "chats/files/a.txt", "hosts.json", "plugins/beispiel/settings.json", "plugins.json", "settings.json"]);
        let aus: Vec<String> = plan.ausgelassen.iter().map(|(p, _)| p.display().to_string()).collect();
        assert_eq!(aus, ["logs", "update-check.json", "update.log"]);
        assert!(!ziel.exists(), "Planen schreibt nichts");

        let e = ausfuehren(&plan, &daten, "2026-10-28 10:00:00 UTC").unwrap();
        assert_eq!((e.kopiert, e.fehlgeschlagen.len(), e.uebersprungen.len()), (6, 0, 0));
        assert_eq!(fs::read_to_string(ziel.join("chats/c1.json")).unwrap(), r#"{"t":"hallo"}"#);
        assert!(!ziel.join("logs").exists() && !ziel.join("update.log").exists());
        assert_eq!(baum(&alt), vorher, "das alte Verzeichnis ist unverändert");
        assert!(fs::read_dir(&ziel).unwrap().flatten().all(|x| !x.file_name().to_string_lossy().ends_with(".neu")), "keine Reste");
    }

    #[cfg(unix)]
    #[test]
    fn dateirechte_bleiben_erhalten() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let alt = d.path().join("alt");
        altes_studio(&alt);
        fs::set_permissions(alt.join("hosts.json"), fs::Permissions::from_mode(0o600)).unwrap();
        let daten = d.path().join("daten");
        let plan = planen(&alt, &daten.join("studio-home")).unwrap();
        ausfuehren(&plan, &daten, "t").unwrap();
        let modus = fs::metadata(daten.join("studio-home/hosts.json")).unwrap().permissions().mode() & 0o777;
        assert_eq!(modus, 0o600, "Datei mit Client-Token bleibt nur für den Nutzer lesbar");
    }

    #[test]
    fn zweite_uebernahme_wird_verweigert_und_das_angebot_verschwindet() {
        let d = tempfile::tempdir().unwrap();
        let alt = d.path().join("alt");
        altes_studio(&alt);
        let daten = d.path().join("daten");
        let plan = planen(&alt, &daten.join("studio-home")).unwrap();
        ausfuehren(&plan, &daten, "2026-10-28 10:00:00 UTC").unwrap();
        assert_eq!(angebot(&alt, &daten), Angebot::SchonUebernommen);
        let f = ausfuehren(&plan, &daten, "später").unwrap_err();
        assert_eq!(f.code(), "UEBERNAHME_SCHON_ERFOLGT");
        assert!(f.meldung().ursache.contains("2026-10-28 10:00:00 UTC"));
    }

    #[test]
    fn teilkollision_ueberschreibt_nie() {
        let d = tempfile::tempdir().unwrap();
        let alt = d.path().join("alt");
        altes_studio(&alt);
        let daten = d.path().join("daten");
        let ziel = daten.join("studio-home");
        schreibe(&ziel, "settings.json", "MEINE NEUEN EINSTELLUNGEN");
        assert_eq!(angebot(&alt, &daten), Angebot::DatenVorhanden, "im Fenster nicht angeboten");
        let plan = planen(&alt, &ziel).unwrap();
        assert_eq!(plan.vorhanden, [PathBuf::from("settings.json")]);
        let e = ausfuehren(&plan, &daten, "t").unwrap();
        assert_eq!(fs::read_to_string(ziel.join("settings.json")).unwrap(), "MEINE NEUEN EINSTELLUNGEN");
        assert_eq!((e.kopiert, e.uebersprungen.len()), (5, 1));
        // Konkurrierende Datei, die erst NACH dem Planen entsteht: hard_link scheitert, nichts wird überschrieben
        let alt2 = d.path().join("alt2");
        schreibe(&alt2, "chats/x.json", "alt");
        let daten2 = d.path().join("daten2");
        let plan2 = planen(&alt2, &daten2.join("studio-home")).unwrap();
        schreibe(&daten2.join("studio-home"), "chats/x.json", "NEU DAZWISCHEN");
        let e2 = ausfuehren(&plan2, &daten2, "t").unwrap();
        assert_eq!(fs::read_to_string(daten2.join("studio-home/chats/x.json")).unwrap(), "NEU DAZWISCHEN");
        assert_eq!((e2.kopiert, e2.uebersprungen.len()), (0, 1));
    }

    #[cfg(unix)]
    #[test]
    fn nicht_lesbare_datei_wird_gemeldet_und_der_rest_kopiert() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let alt = d.path().join("alt");
        altes_studio(&alt);
        fs::set_permissions(alt.join("plugins.json"), fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read(alt.join("plugins.json")).is_ok() {
            return; // als Administrator lesbar: Fall nicht herstellbar
        }
        let daten = d.path().join("daten");
        let plan = planen(&alt, &daten.join("studio-home")).unwrap();
        let e = ausfuehren(&plan, &daten, "t").unwrap();
        assert_eq!(e.kopiert, 5);
        assert_eq!(e.fehlgeschlagen.len(), 1);
        assert_eq!(e.fehlgeschlagen[0].0, PathBuf::from("plugins.json"));
        assert!(!daten.join("studio-home/plugins.json").exists());
        fs::set_permissions(alt.join("plugins.json"), fs::Permissions::from_mode(0o644)).unwrap();
        // der Katalogtext für die Anzeige
        let f = Fehler::UebernahmeTeilweise { anzahl: 1, beispiel: "plugins.json: Permission denied".into() };
        assert!(f.meldung().abhilfe.contains("Rechte"));
    }

    #[cfg(unix)]
    #[test]
    fn verknuepfungen_werden_nicht_verfolgt() {
        let d = tempfile::tempdir().unwrap();
        let alt = d.path().join("alt");
        altes_studio(&alt);
        let geheim = d.path().join("ausserhalb.txt");
        fs::write(&geheim, "nicht kopieren").unwrap();
        std::os::unix::fs::symlink(&geheim, alt.join("chats/link.json")).unwrap();
        std::os::unix::fs::symlink(d.path(), alt.join("ordner-link")).unwrap();
        let daten = d.path().join("daten");
        let plan = planen(&alt, &daten.join("studio-home")).unwrap();
        assert_eq!(plan.verlinkt.len(), 2);
        ausfuehren(&plan, &daten, "t").unwrap();
        assert!(!daten.join("studio-home/chats/link.json").exists() && !daten.join("studio-home/ordner-link").exists());
    }

    #[test]
    fn modelle_und_engines_bleiben_mit_hinweis() {
        let d = tempfile::tempdir().unwrap();
        let alt = d.path().join("alt");
        altes_studio(&alt);
        schreibe(&alt, "models/gross.gguf", "xxxx");
        schreibe(&alt, "engines/llama/bin", "x");
        let plan = planen(&alt, &d.path().join("daten/studio-home")).unwrap();
        assert!(plan.kopieren.iter().all(|x| !x.rel.starts_with("models") && !x.rel.starts_with("engines")));
        assert_eq!(plan.hinweise.len(), 2);
        assert!(plan.hinweise[0].contains("Modellordner") && plan.hinweise[0].contains("models"));
    }

    #[test]
    fn befunde_nennen_namen_und_anzahl_nie_werte() {
        let d = tempfile::tempdir().unwrap();
        let alt = d.path().join("alt");
        altes_studio(&alt);
        schreibe(&alt, "settings.json", r#"{"hf_token":"hf_ganz_geheim","access_key":"","attach_key":"k"}"#);
        let plan = planen(&alt, &d.path().join("daten/studio-home")).unwrap();
        assert_eq!(plan.befunde, ["settings.json enthält im Klartext: hf_token, attach_key", "hosts.json enthält 1 Client-Token im Klartext"]);
        assert!(!plan.befunde.join(" ").contains("ganz_geheim") && !plan.befunde.join(" ").contains("geheim-token"));
    }

    #[test]
    fn ziel_hat_daten_ignoriert_leere_ordner_und_ausgelassenes() {
        let d = tempfile::tempdir().unwrap();
        let z = d.path().join("studio-home");
        assert!(!ziel_hat_daten(&z));
        for ordner in ["bench", "chats/files", "plugins/updater", "engines", "logs"] {
            fs::create_dir_all(z.join(ordner)).unwrap();
        }
        schreibe(&z, "logs/studio.log", "x");
        schreibe(&z, "update-check.json", "{}");
        assert!(!ziel_hat_daten(&z), "frisch gestartetes Studio: nur leere Ordner und Protokolle");
        schreibe(&z, "chats/c.json", "{}");
        assert!(ziel_hat_daten(&z));
    }
}
