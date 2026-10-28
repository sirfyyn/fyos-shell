//! Texte für Tray und Tooltip: Zustand des Runners, Zahl offener Freigaben, Ruhe. Reine Funktionen.

/// Der Zustand für Menü und Tooltip. Reihenfolge wie im Fenster: nicht eingerichtet, getrennt, wartet auf dich, pausiert, arbeitet, bereit.
pub fn zustand_text(eingerichtet: bool, verbunden: bool, offene: usize, kopf_art: &str, arbeitet: bool) -> &'static str {
    if !eingerichtet {
        return "kein Runner eingerichtet";
    }
    if !verbunden {
        return "getrennt";
    }
    if offene > 0 {
        return "wartet auf dich";
    }
    if kopf_art == "pausiert" {
        return "pausiert";
    }
    if arbeitet || kopf_art == "arbeitet" {
        return "arbeitet";
    }
    "bereit"
}

pub fn status_text(produkt: &str, zustand: &str, ruhe: bool) -> String {
    let ruhe = if ruhe { " · Ruhe" } else { "" };
    format!("{produkt}: {zustand}{ruhe}")
}

pub fn text_freigaben(n: usize) -> String {
    match n {
        0 => "Keine offenen Freigaben".to_string(),
        1 => "1 offene Freigabe".to_string(),
        n => format!("{n} offene Freigaben"),
    }
}

/// Neben dem Symbol (macOS): Zahl der offenen Freigaben; ohne offene nichts.
pub fn titel_text(offene: usize) -> Option<String> {
    (offene > 0).then(|| offene.to_string())
}

/// Der Kopfzustand, den die Seite melden darf; alles andere gilt als `bereit`.
pub fn kopf_art(roh: &str) -> &'static str {
    match roh {
        "arbeitet" => "arbeitet",
        "wartet" => "wartet",
        "pausiert" => "pausiert",
        "getrennt" => "getrennt",
        _ => "bereit",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn freigaben_text() {
        assert_eq!(text_freigaben(0), "Keine offenen Freigaben");
        assert_eq!(text_freigaben(1), "1 offene Freigabe");
        assert_eq!(text_freigaben(3), "3 offene Freigaben");
    }

    #[test]
    fn zustaende_in_der_reihenfolge_des_fensters() {
        assert_eq!(zustand_text(false, true, 3, "arbeitet", true), "kein Runner eingerichtet");
        assert_eq!(zustand_text(true, false, 2, "arbeitet", true), "getrennt");
        assert_eq!(zustand_text(true, true, 2, "pausiert", true), "wartet auf dich");
        assert_eq!(zustand_text(true, true, 0, "pausiert", true), "pausiert");
        assert_eq!(zustand_text(true, true, 0, "bereit", true), "arbeitet");
        assert_eq!(zustand_text(true, true, 0, "arbeitet", false), "arbeitet");
        assert_eq!(zustand_text(true, true, 0, "bereit", false), "bereit");
    }

    #[test]
    fn statuszeile_und_titel() {
        assert_eq!(status_text("FYOS Agent", "arbeitet", false), "FYOS Agent: arbeitet");
        assert_eq!(status_text("FYOS Agent", "bereit", true), "FYOS Agent: bereit · Ruhe");
        assert_eq!(titel_text(0), None);
        assert_eq!(titel_text(4).as_deref(), Some("4"));
    }

    #[test]
    fn unbekannter_kopfzustand_ist_bereit() {
        assert_eq!(kopf_art("arbeitet"), "arbeitet");
        assert_eq!(kopf_art("unfug"), "bereit");
    }
}
