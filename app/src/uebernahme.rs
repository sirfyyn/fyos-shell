//! Übernahme aus dem bestehenden Python-Studio (Knopf im Studio-Profil und `--uebernehmen-studio [--trocken]`).
//! Die Regeln und der Kern stehen in `shell_core::uebernahme`; hier liegt nur, was die Anwendung kennt: Heimordner, Umgebung, Profil, Neustart des Begleiters.
//!
//! Wo das alte Studio liegt: `FYOS_SHELL_ALTES_STUDIO` (Tests, Support) vor `FLE_STUDIO_HOME` (wie das alte Studio es liest) vor dem Standardort des Systems.

use crate::zustand::{sperre, Huelle};
use serde::Serialize;
use serde_json::{json, Value};
use shell_core::profil::Profil;
use shell_core::uebernahme::{self, Angebot, Plan, System};
use shell_core::{Fehler, Meldung};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Wie viele Dateinamen die Anzeige höchstens aufzählt.
const ZEILEN: usize = 12;

fn env_pfad(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|p| !p.is_empty()).map(PathBuf::from)
}

/// Das Datenverzeichnis des bestehenden Studios auf diesem System.
pub fn altes_verzeichnis(app: &AppHandle) -> PathBuf {
    let heim = app.path().home_dir().unwrap_or_else(|_| PathBuf::from("."));
    let ueberschrieben = env_pfad("FYOS_SHELL_ALTES_STUDIO").or_else(|| env_pfad("FLE_STUDIO_HOME"));
    uebernahme::altes_verzeichnis(System::dieses(), &heim, ueberschrieben.as_deref(), env_pfad("LOCALAPPDATA").as_deref(), env_pfad("XDG_DATA_HOME").as_deref())
}

fn ziel(h: &Huelle) -> PathBuf {
    h.pfade.daten.join("studio-home")
}

#[derive(Serialize)]
pub struct Anzeige {
    /// Nur im Studio-Profil sinnvoll
    pub profil_passt: bool,
    pub ort: String,
    /// "nichts" | "schon_uebernommen" | "daten_vorhanden" | "moeglich"
    pub stand: &'static str,
    pub dateien: usize,
    pub bytes: u64,
}

/// Was der Knopf wissen muss. Liest nur.
pub fn anzeige(app: &AppHandle, h: &Huelle) -> Anzeige {
    let alt = altes_verzeichnis(app);
    let passt = h.profil == Profil::Studio && alt != ziel(h);
    let stand = if !passt {
        Angebot::Nichts
    } else {
        uebernahme::angebot(&alt, &h.pfade.daten)
    };
    let (dateien, bytes) = match (&stand, passt) {
        (Angebot::Moeglich, true) => uebernahme::planen(&alt, &ziel(h)).map(|p| (p.kopieren.len(), p.bytes())).unwrap_or((0, 0)),
        _ => (0, 0),
    };
    Anzeige {
        profil_passt: passt,
        ort: alt.display().to_string(),
        stand: match stand {
            Angebot::Nichts => "nichts",
            Angebot::SchonUebernommen => "schon_uebernommen",
            Angebot::DatenVorhanden => "daten_vorhanden",
            Angebot::Moeglich => "moeglich",
        },
        dateien,
        bytes,
    }
}

fn zeit_text() -> String {
    let s = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("{} (Unix-Sekunden)", s)
}

fn liste(p: &[PathBuf]) -> Vec<String> {
    p.iter().take(ZEILEN).map(|x| x.display().to_string()).collect()
}

fn plan_json(plan: &Plan) -> Value {
    json!({
        "ort": plan.quelle.display().to_string(),
        "ziel": plan.ziel.display().to_string(),
        "kopieren": plan.kopieren.len(),
        "bytes": plan.bytes(),
        "dateien": plan.kopieren.iter().take(ZEILEN).map(|d| d.rel.display().to_string()).collect::<Vec<_>>(),
        "vorhanden": liste(&plan.vorhanden),
        "ausgelassen": plan.ausgelassen.iter().map(|(p, g)| json!({"pfad": p.display().to_string(), "grund": g})).collect::<Vec<_>>(),
        "verlinkt": liste(&plan.verlinkt),
        "unlesbar": plan.unlesbar.iter().map(|(p, g)| json!({"pfad": p.display().to_string(), "grund": g})).collect::<Vec<_>>(),
        "hinweise": plan.hinweise,
        "befunde": plan.befunde,
    })
}

/// Zeigt (`trocken`) oder macht die Übernahme. Das Ergebnis ist ein JSON-Wert für Fenster und Kommandozeile.
/// Nach einer echten Übernahme muss der Studio-Server neu starten, damit er die Dateien liest: der Aufrufer macht das.
pub fn ausfuehren(app: &AppHandle, h: &Huelle, trocken: bool) -> Result<Value, Fehler> {
    if h.profil != Profil::Studio {
        return Err(Fehler::UebernahmeQuelleFehlt { ort: "nur im Studio-Profil (de.sirfyyn.fle-studio)".to_string() });
    }
    let alt = altes_verzeichnis(app);
    let plan = uebernahme::planen(&alt, &ziel(h))?;
    let mut ausgabe = plan_json(&plan);
    ausgabe["trocken"] = json!(trocken);
    // Eigene Daten schützt der Kern ohnehin vor dem Überschreiben; eine Übernahme in ein gefülltes Ziel wird nur gemeldet, nicht verhindert.
    ausgabe["ziel_hat_daten"] = json!(uebernahme::ziel_hat_daten(&ziel(h)));
    if trocken {
        return Ok(ausgabe);
    }
    let e = uebernahme::ausfuehren(&plan, &h.pfade.daten, &zeit_text())?;
    ausgabe["kopiert"] = json!(e.kopiert);
    ausgabe["kopiert_bytes"] = json!(e.bytes);
    ausgabe["uebersprungen"] = json!(liste(&e.uebersprungen));
    ausgabe["fehlgeschlagen"] = json!(e.fehlgeschlagen.iter().map(|(p, g)| json!({"pfad": p.display().to_string(), "grund": g})).collect::<Vec<_>>());
    if let Some((p, g)) = e.fehlgeschlagen.first() {
        let m: Meldung = Fehler::UebernahmeTeilweise { anzahl: e.fehlgeschlagen.len(), beispiel: format!("{}: {g}", p.display()) }.meldung();
        ausgabe["meldung"] = json!(m);
    }
    ausgabe["neustart_noetig"] = json!(sperre(&h.begleiter).is_some());
    Ok(ausgabe)
}
