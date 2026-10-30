//! Zwei Adressen je Runner: Reihenfolge, Rückfall und Fehlertext. Rein (kein Netz); das Netz steht in `app/src/agent`.
//!
//! Regeln:
//! - Reihenfolge: die zuletzt funktionierende Adresse zuerst (nur im Arbeitsspeicher gemerkt), sonst die Reihenfolge der Einstellungen.
//! - Gewechselt wird **nur bei einem Verbindungsfehler** (`RUNNER_NICHT_ERREICHBAR`: kein TCP, Zeitüberschreitung, DNS, TLS). Jede HTTP-Antwort,
//!   auch 401 oder 500, zeigt, dass dort ein Runner antwortet: der Fehler gilt, es wird nicht die andere Adresse versucht (sonst ginge das
//!   Token an einen zweiten Ort, nur weil das erste Token falsch ist).
//! - Sind alle Adressen unerreichbar, nennt der Fehler beide Adressen (ohne Token; Adressen enthalten nie Zugangsdaten, `normalisiere`).

use crate::fehler::Fehler;

/// Kurze Frist für das Verbinden, wenn es eine zweite Adresse gibt (sonst bleibt es bei den üblichen Fristen).
pub const VERBINDEN_MIT_RUECKFALL_MS: u64 = 2000;

/// Die Adressen in der Reihenfolge, in der sie versucht werden: `gut` (zuletzt funktionierend) zuerst, wenn es unter den Adressen vorkommt.
pub fn reihenfolge(basen: &[String], gut: Option<&str>) -> Vec<String> {
    let mut v: Vec<String> = basen.to_vec();
    if let Some(g) = gut {
        if let Some(i) = v.iter().position(|b| b == g) {
            let b = v.remove(i);
            v.insert(0, b);
        }
    }
    v
}

/// Nur ein Verbindungsfehler lässt die andere Adresse versuchen; HTTP-Antworten (auch Fehlerstatus) nie.
pub fn ist_verbindungsfehler(f: &Fehler) -> bool {
    matches!(f, Fehler::RunnerNichtErreichbar { .. })
}

/// Der Fehler, wenn keine der Adressen antwortet: bei einer Adresse der unveränderte Fehler, bei zwei „weder A noch B antwortet“.
pub fn alle_tot(basen: &[String], letzter: Fehler) -> Fehler {
    match (basen.len(), &letzter) {
        (n, Fehler::RunnerNichtErreichbar { grund, .. }) if n >= 2 => Fehler::RunnerNichtErreichbar {
            url: String::new(),
            grund: format!("weder {} noch {} antwortet (zuletzt: {})", basen[0], basen[1..].join(" noch "), grund),
        },
        _ => letzter,
    }
}

/// Ergebnis eines Durchlaufs: das Ergebnis und die Adresse, die geantwortet hat (auch bei einem HTTP-Fehler: dort läuft ein Runner).
#[derive(Debug)]
pub struct Durchlauf<T> {
    pub ergebnis: Result<T, Fehler>,
    pub antwortete: Option<String>,
}

/// Wie ein Versuch scheiterte: `Verbindung` (die Anfrage ist nie angekommen, die andere Adresse darf es versuchen) oder `Antwort`
/// (dort läuft ein Runner, oder die Anfrage war schon unterwegs: der Fehler gilt, es wird nichts doppelt gesendet).
#[derive(Debug)]
pub enum Fehlschlag {
    Verbindung(Fehler),
    Antwort(Fehler),
}

impl Fehlschlag {
    pub fn fehler(self) -> Fehler {
        match self {
            Fehlschlag::Verbindung(f) | Fehlschlag::Antwort(f) => f,
        }
    }
}

/// Aus einem Katalogfehler: Verbindungsfehler lassen die andere Adresse versuchen, alles andere nicht (richtig für lesende Anfragen).
impl From<Fehler> for Fehlschlag {
    fn from(f: Fehler) -> Self {
        if ist_verbindungsfehler(&f) { Fehlschlag::Verbindung(f) } else { Fehlschlag::Antwort(f) }
    }
}

/// Versucht die Adressen der Reihe nach. `versuch(basis, hat_weitere)` führt die Anfrage aus; `hat_weitere` sagt, ob danach noch eine Adresse
/// kommt (dann darf das Verbinden kurz sein). Bei einem Verbindungsfehler geht es weiter, bei jedem anderen Ausgang endet der Durchlauf.
pub fn durchlaufen<T>(basen: &[String], gut: Option<&str>, mut versuch: impl FnMut(&str, bool) -> Result<T, Fehlschlag>) -> Durchlauf<T> {
    let folge = reihenfolge(basen, gut);
    let mut letzter: Option<Fehler> = None;
    for (i, b) in folge.iter().enumerate() {
        let hat_weitere = i + 1 < folge.len();
        match versuch(b, hat_weitere) {
            Ok(v) => return Durchlauf { ergebnis: Ok(v), antwortete: Some(b.clone()) },
            Err(Fehlschlag::Verbindung(f)) => letzter = Some(f),
            Err(Fehlschlag::Antwort(f)) => return Durchlauf { ergebnis: Err(f), antwortete: Some(b.clone()) },
        }
    }
    let f = letzter.unwrap_or(Fehler::RunnerNichtEingerichtet);
    Durchlauf { ergebnis: Err(alle_tot(&folge, f)), antwortete: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(l: &[&str]) -> Vec<String> {
        l.iter().map(|s| s.to_string()).collect()
    }

    fn tot(url: &str) -> Fehler {
        Fehler::RunnerNichtErreichbar { url: url.into(), grund: "Verbindung abgelehnt".into() }
    }

    #[test]
    fn reihenfolge_gemerkte_zuerst_sonst_wie_eingetragen() {
        let l = b(&["http://lan:1", "http://fern:1"]);
        assert_eq!(reihenfolge(&l, None), l);
        assert_eq!(reihenfolge(&l, Some("http://fern:1")), b(&["http://fern:1", "http://lan:1"]));
        assert_eq!(reihenfolge(&l, Some("http://lan:1")), l);
        assert_eq!(reihenfolge(&l, Some("http://unbekannt:1")), l, "eine fremde gemerkte Adresse (Einstellung geändert) zählt nicht");
        assert_eq!(reihenfolge(&b(&["http://a:1"]), Some("http://a:1")), b(&["http://a:1"]));
    }

    #[test]
    fn wechsel_nur_bei_verbindungsfehler() {
        let l = b(&["http://lan:1", "http://fern:1"]);
        let mut gesehen = vec![];
        let d = durchlaufen(&l, None, |basis, weitere| {
            gesehen.push((basis.to_string(), weitere));
            if basis == "http://lan:1" { Err(tot(basis).into()) } else { Ok(7) }
        });
        assert_eq!(d.ergebnis.unwrap(), 7);
        assert_eq!(d.antwortete.as_deref(), Some("http://fern:1"));
        assert_eq!(gesehen, [("http://lan:1".to_string(), true), ("http://fern:1".to_string(), false)], "nur die erste darf kurz verbinden");
    }

    #[test]
    fn http_antwort_auch_401_wechselt_nicht() {
        let l = b(&["http://lan:1", "http://fern:1"]);
        let mut n = 0;
        let d: Durchlauf<()> = durchlaufen(&l, None, |_, _| {
            n += 1;
            Err(Fehler::TokenAbgelehnt { status: 401 }.into())
        });
        assert_eq!(d.ergebnis.unwrap_err().code(), "TOKEN_ABGELEHNT");
        assert_eq!(n, 1, "die zweite Adresse bekommt das Token nicht");
        assert_eq!(d.antwortete.as_deref(), Some("http://lan:1"), "dort läuft ein Runner");
        for f in [Fehler::RunnerFehler { status: 500, text: None }, Fehler::RunnerAntwortUnlesbar { grund: "x".into() }] {
            let code = f.code();
            let mut n = 0;
            let mut f = Some(f);
            let d: Durchlauf<()> = durchlaufen(&l, None, |_, _| {
                n += 1;
                Err(f.take().unwrap().into())
            });
            assert_eq!((d.ergebnis.unwrap_err().code(), n), (code, 1));
        }
    }

    #[test]
    fn beide_tot_nennt_beide_adressen() {
        let l = b(&["http://lan:1", "http://fern:1"]);
        let d: Durchlauf<()> = durchlaufen(&l, None, |basis, _| Err(tot(basis).into()));
        let f = d.ergebnis.unwrap_err();
        assert_eq!(f.code(), "RUNNER_NICHT_ERREICHBAR");
        let det = f.meldung().details.unwrap();
        assert!(det.contains("weder http://lan:1 noch http://fern:1 antwortet"), "{det}");
        assert!(d.antwortete.is_none());
        // eine Adresse: der Fehler bleibt wie bisher (mit der URL)
        let d: Durchlauf<()> = durchlaufen(&b(&["http://lan:1"]), None, |basis, w| {
            assert!(!w);
            Err(tot(basis).into())
        });
        assert!(d.ergebnis.unwrap_err().meldung().details.unwrap().starts_with("http://lan:1: "));
    }

    #[test]
    fn gemerkte_adresse_zuerst_und_zurueckwechseln() {
        let l = b(&["http://lan:1", "http://fern:1"]);
        // unterwegs: lan tot, fern lebt -> fern gemerkt
        let d = durchlaufen(&l, None, |basis, _| if basis.contains("lan") { Err(tot(basis).into()) } else { Ok(()) });
        let gut = d.antwortete;
        assert_eq!(gut.as_deref(), Some("http://fern:1"));
        // danach beide lebendig: es bleibt bei fern (kein Versuch auf lan)
        let mut versucht = vec![];
        let d = durchlaufen(&l, gut.as_deref(), |basis, _| {
            versucht.push(basis.to_string());
            Ok(())
        });
        assert_eq!(versucht, ["http://fern:1"]);
        // fern fällt aus, lan lebt: zurück zu lan
        let d2 = durchlaufen(&l, d.antwortete.as_deref(), |basis, _| if basis.contains("fern") { Err(tot(basis).into()) } else { Ok(()) });
        assert_eq!(d2.antwortete.as_deref(), Some("http://lan:1"));
    }

    #[test]
    fn nach_dem_verbinden_gescheiterte_schreibanfrage_wechselt_nicht() {
        let l = b(&["http://lan:1", "http://fern:1"]);
        let mut n = 0;
        let d: Durchlauf<()> = durchlaufen(&l, None, |basis, _| {
            n += 1;
            Err(Fehlschlag::Antwort(tot(basis)))
        });
        assert_eq!(n, 1, "die Anfrage war schon unterwegs: nicht doppelt senden");
        assert_eq!(d.ergebnis.unwrap_err().code(), "RUNNER_NICHT_ERREICHBAR");
    }
}
