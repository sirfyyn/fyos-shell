//! Studio-Zustand aus der Antwort von `GET /api/state` (Vertrag: `docs/current/studio-api-vertrag.json`, Eintrag
//! `/api/state`: `{app, version, engine, models[], ...}`). Die Hülle liest nur, was sie anzeigt, und toleriert alles Weitere.

use crate::fehler::Fehler;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StudioZustand {
    pub app: String,
    pub version: String,
    /// Kurztext zum Zustand der Engine ("läuft", "gestoppt" oder der Text des Servers).
    pub engine: String,
    pub modelle: usize,
}

fn engine_text(engine: &Value) -> String {
    match engine {
        Value::String(s) => s.clone(),
        Value::Object(o) => {
            for schluessel in ["state", "status"] {
                if let Some(Value::String(s)) = o.get(schluessel) {
                    return s.clone();
                }
            }
            match o.get("running") {
                Some(Value::Bool(true)) => "läuft".into(),
                Some(Value::Bool(false)) => "gestoppt".into(),
                _ => "unbekannt".into(),
            }
        }
        _ => "unbekannt".into(),
    }
}

pub fn lesen(antwort: &str) -> Result<StudioZustand, Fehler> {
    let unlesbar = |g: &str| Fehler::StudioAntwortUnlesbar { grund: g.to_string() };
    let json: Value = serde_json::from_str(antwort).map_err(|e| unlesbar(&format!("kein JSON ({e})")))?;
    let version = json.get("version").and_then(Value::as_str).ok_or_else(|| unlesbar("Feld „version“ fehlt"))?;
    Ok(StudioZustand {
        app: json.get("app").and_then(Value::as_str).unwrap_or("FLE Studio").to_string(),
        version: version.to_string(),
        engine: json.get("engine").map(engine_text).unwrap_or_else(|| "unbekannt".into()),
        modelle: json.get("models").and_then(Value::as_array).map_or(0, Vec::len),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn liest_die_anzeigefelder() {
        let z = lesen(r#"{"app":"FLE Studio","version":"0.4.0","engine":{"running":true},"models":[{},{},{}],"x":1}"#).unwrap();
        assert_eq!(z, StudioZustand { app: "FLE Studio".into(), version: "0.4.0".into(), engine: "läuft".into(), modelle: 3 });
    }

    #[test]
    fn engine_text_aus_verschiedenen_formen() {
        assert_eq!(lesen(r#"{"version":"1","engine":{"state":"lädt"}}"#).unwrap().engine, "lädt");
        assert_eq!(lesen(r#"{"version":"1","engine":"idle"}"#).unwrap().engine, "idle");
        assert_eq!(lesen(r#"{"version":"1"}"#).unwrap().engine, "unbekannt");
    }

    #[test]
    fn fremde_antwort_ist_ein_katalogfehler() {
        assert_eq!(lesen("<html>").unwrap_err().code(), "STUDIO_ANTWORT_UNLESBAR");
        assert_eq!(lesen(r#"{"app":"x"}"#).unwrap_err().code(), "STUDIO_ANTWORT_UNLESBAR");
    }
}
