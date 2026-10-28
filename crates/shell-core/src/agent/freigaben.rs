//! Offene Freigaben eines Runners (`GET /api/freigaben`) und der Abgleich „was ist neu“.
//! Eine Freigabe gilt als gemeldet, sobald ihr Schlüssel `<id>@<erstellt>` im Gemeldet-Satz steht. Die Zeit gehört zum Schlüssel,
//! weil ein neu gestarteter Runner dieselben Nummern wieder vergeben kann.

use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Offene {
    pub id: String,
    pub schluessel: String,
    pub aktion: String,
    pub risiko: String,
    pub kontext: String,
}

fn als_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

/// Alle Freigaben mit `status: "offen"` aus der Antwort `{freigaben:[…]}`.
pub fn offene(antwort: &Value) -> Vec<Offene> {
    antwort
        .get("freigaben")
        .and_then(Value::as_array)
        .map(|liste| {
            liste
                .iter()
                .filter(|f| f.get("status").and_then(Value::as_str) == Some("offen"))
                .filter_map(|f| {
                    let id = als_text(f.get("id")?);
                    if id.is_empty() {
                        return None;
                    }
                    let erstellt = f.get("erstellt").map(als_text).unwrap_or_default();
                    Some(Offene {
                        schluessel: format!("{id}@{erstellt}"),
                        id,
                        aktion: f.get("aktion").map(als_text).unwrap_or_default(),
                        risiko: f.get("risiko").map(als_text).unwrap_or_default(),
                        kontext: f.get("kontext").map(als_text).unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Zahl der Läufe mit `status: "laeuft"` aus der Antwort `{laeufe:[…]}` von `GET /api/laeufe`.
pub fn laufende(antwort: &Value) -> usize {
    antwort
        .get("laeufe")
        .and_then(Value::as_array)
        .map(|l| l.iter().filter(|x| x.get("status").and_then(Value::as_str) == Some("laeuft")).count())
        .unwrap_or(0)
}

/// Die noch nicht gemeldeten unter `offene`; sie werden dabei in `gemeldet` eingetragen.
pub fn neue(offene: &[Offene], gemeldet: &mut BTreeSet<String>) -> Vec<Offene> {
    offene.iter().filter(|o| gemeldet.insert(o.schluessel.clone())).cloned().collect()
}

/// Den Gemeldet-Satz klein halten (der Schlüssel mit der kleinsten Ordnung fliegt zuerst).
pub fn beschneiden(gemeldet: &mut BTreeSet<String>, hoechstens: usize) {
    while gemeldet.len() > hoechstens {
        match gemeldet.iter().next().cloned() {
            Some(erster) => {
                gemeldet.remove(&erster);
            }
            None => break,
        }
    }
}

/// Titel und Text einer Benachrichtigung. Datenschutz: nie der Befehl oder die Aktion, nur dass eine Freigabe wartet
/// (Mitteilungen erscheinen im Sperrbildschirm und in der Mitteilungszentrale).
pub fn meldung(neu: &[Offene]) -> (String, String) {
    const TEXT: &str = "Der Agent wartet auf deine Entscheidung.";
    match neu {
        [] => (String::new(), String::new()),
        [eine] => (if eine.risiko == "high" { "Freigabe nötig (hohes Risiko)" } else { "Freigabe nötig" }.to_string(), TEXT.to_string()),
        mehrere => (format!("{} neue Freigaben", mehrere.len()), TEXT.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn probe() -> Value {
        json!({"freigaben":[
            {"id":1,"status":"offen","erstellt":1000,"aktion":"Branch alt-1 löschen","risiko":"high","kontext":"git"},
            {"id":2,"status":"erteilt","erstellt":1001,"aktion":"x"},
            {"id":"3","status":"offen","erstellt":"2026-10-25T10:00:00Z","aktion":"Pod löschen","risiko":"medium"},
            {"id":4,"status":"abgelehnt","erstellt":1003}
        ]})
    }

    #[test]
    fn nur_offene_werden_gelesen_ids_als_zahl_oder_text() {
        let o = offene(&probe());
        assert_eq!(o.len(), 2);
        assert_eq!((o[0].id.as_str(), o[0].schluessel.as_str()), ("1", "1@1000"));
        assert_eq!((o[1].id.as_str(), o[1].schluessel.as_str()), ("3", "3@2026-10-25T10:00:00Z"));
    }

    #[test]
    fn leere_oder_kaputte_antworten_ergeben_nichts() {
        assert!(offene(&json!({})).is_empty());
        assert!(offene(&json!({"freigaben":"x"})).is_empty());
        assert!(offene(&json!({"freigaben":[{"status":"offen"}]})).is_empty());
    }

    #[test]
    fn neue_werden_nur_einmal_gemeldet() {
        let mut gemeldet = BTreeSet::new();
        let o = offene(&probe());
        assert_eq!(neue(&o, &mut gemeldet).len(), 2);
        assert!(neue(&o, &mut gemeldet).is_empty());
        let mut mehr = o.clone();
        mehr.push(Offene { id: "9".into(), schluessel: "9@5".into(), aktion: "neu".into(), risiko: "low".into(), kontext: String::new() });
        let n = neue(&mehr, &mut gemeldet);
        assert_eq!(n.len(), 1);
        assert_eq!(n[0].id, "9");
    }

    #[test]
    fn gleiche_nummer_mit_neuer_zeit_ist_neu() {
        let mut gemeldet = BTreeSet::new();
        neue(&offene(&json!({"freigaben":[{"id":1,"status":"offen","erstellt":1}]})), &mut gemeldet);
        let n = neue(&offene(&json!({"freigaben":[{"id":1,"status":"offen","erstellt":2}]})), &mut gemeldet);
        assert_eq!(n.len(), 1);
    }

    #[test]
    fn laufende_laeufe_werden_gezaehlt() {
        let v = json!({"laeufe":[{"status":"laeuft"},{"status":"abgeschlossen"},{"status":"laeuft"},{"id":3}]});
        assert_eq!(laufende(&v), 2);
        assert_eq!(laufende(&json!({})), 0);
        assert_eq!(laufende(&json!({"laeufe":"x"})), 0);
    }

    #[test]
    fn beschneiden_haelt_die_grenze() {
        let mut g: BTreeSet<String> = (0..10).map(|i| format!("{i:02}@x")).collect();
        beschneiden(&mut g, 4);
        assert_eq!(g.len(), 4);
        assert!(g.contains("09@x"));
    }

    #[test]
    fn meldungstexte() {
        let o = offene(&probe());
        assert_eq!(meldung(&o[..1]), ("Freigabe nötig (hohes Risiko)".to_string(), "Der Agent wartet auf deine Entscheidung.".to_string()));
        assert_eq!(meldung(&o), ("2 neue Freigaben".to_string(), "Der Agent wartet auf deine Entscheidung.".to_string()));
        // keine Befehlstexte in der Mitteilung
        let (t1, t2) = meldung(&o);
        assert!(!t1.contains("löschen") && !t2.contains("löschen"));
        assert_eq!(meldung(&[]), (String::new(), String::new()));
    }
}
