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

/// Titel des Untermenüs zum Wechseln des Runners.
pub const RUNNER_WAHL_TITEL: &str = "Runner wechseln";
/// Eintrag im Untermenü, wenn die Liste leer ist (nicht anklickbar).
pub const RUNNER_WAHL_LEER: &str = "Keine Runner in den Einstellungen";
/// Vorsatz der Menü-Kennungen der Runner (`runner:<id>`); alles andere im Tray-Menü hat feste Kennungen ohne Doppelpunkt.
const WAHL_VORSATZ: &str = "runner:";
const NAME_MAX: usize = 40;

/// Erste Zeile des Tray-Menüs: der aktive Runner (nicht anklickbar) oder, dass keiner eingerichtet ist.
pub fn runner_zeile(name: Option<&str>) -> String {
    match name.map(anzeige_name).filter(|n| !n.is_empty()) {
        Some(n) => format!("Runner: {n}"),
        None => "Kein Runner".to_string(),
    }
}

/// Die Runner-Zeile für den Tooltip, bei zwei Adressen mit dem Rechnernamen der gerade genutzten (`Runner: Fern (fern)`); nur der Rechnername,
/// nie Pfad, Port oder Token.
pub fn runner_zeile_mit_adresse(zeile: &str, genutzte_adresse: Option<&str>) -> String {
    match genutzte_adresse.map(super::adresse::host_aus).map(|h| anzeige_name(&h)).filter(|h| !h.is_empty()) {
        Some(h) => format!("{zeile} ({h})"),
        None => zeile.to_string(),
    }
}

/// Name für Menü und Tooltip: Steuerzeichen und Zeilenumbrüche werden zu Leerzeichen, an den Rändern gekürzt, höchstens 40 Zeichen.
pub fn anzeige_name(roh: &str) -> String {
    let sauber: String = roh.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    if sauber.chars().count() <= NAME_MAX {
        return sauber;
    }
    let kurz: String = sauber.chars().take(NAME_MAX - 1).collect();
    format!("{}…", kurz.trim_end())
}

/// Ein Eintrag des Untermenüs „Runner wechseln“.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WahlEintrag {
    /// Kennung im Tray-Menü (`runner:<id>`)
    pub menue_id: String,
    pub text: String,
    /// Der aktive Runner bekommt den Haken.
    pub aktiv: bool,
}

/// Die Einträge des Untermenüs aus der Runner-Liste `(id, name)` und der Kennung des aktiven Runners. Ein leerer Name zeigt die Kennung.
pub fn runner_wahl(runner: &[(String, String)], aktiv: Option<&str>) -> Vec<WahlEintrag> {
    runner
        .iter()
        .map(|(id, name)| {
            let text = Some(anzeige_name(name)).filter(|n| !n.is_empty()).unwrap_or_else(|| anzeige_name(id));
            WahlEintrag { menue_id: format!("{WAHL_VORSATZ}{id}"), text, aktiv: aktiv == Some(id.as_str()) }
        })
        .collect()
}

/// Die Runner-Kennung hinter einer Menü-Kennung; `None` für alle anderen Einträge des Menüs.
pub fn runner_id_aus_menue(menue_id: &str) -> Option<&str> {
    menue_id.strip_prefix(WAHL_VORSATZ).filter(|i| !i.is_empty())
}

/// Tooltip: Runner, Zustand und Freigaben, je eine Zeile.
pub fn tooltip_text(runner: &str, status: &str, freigaben: &str) -> String {
    format!("{runner}\n{status}\n{freigaben}")
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

    #[test]
    fn tooltip_nennt_die_genutzte_adresse_nur_als_rechnername() {
        assert_eq!(runner_zeile_mit_adresse("Runner: Fern", Some("http://fern:18438")), "Runner: Fern (fern)");
        assert_eq!(runner_zeile_mit_adresse("Runner: Fern", Some("http://heim:18438/agent")), "Runner: Fern (heim)");
        assert_eq!(runner_zeile_mit_adresse("Runner: Fern", None), "Runner: Fern");
    }

    #[test]
    fn runner_zeile_nennt_den_namen_oder_keinen() {
        assert_eq!(runner_zeile(Some("Heimrechner")), "Runner: Heimrechner");
        assert_eq!(runner_zeile(None), "Kein Runner");
        assert_eq!(runner_zeile(Some("   ")), "Kein Runner");
        assert_eq!(runner_zeile(Some("a\nb\t c")), "Runner: a b c");
    }

    #[test]
    fn lange_namen_werden_gekuerzt() {
        let lang = "x".repeat(100);
        let k = anzeige_name(&lang);
        assert_eq!(k.chars().count(), 40);
        assert!(k.ends_with('…'));
        assert_eq!(anzeige_name("ä".repeat(40).as_str()).chars().count(), 40);
    }

    #[test]
    fn wahl_markiert_den_aktiven_und_ersetzt_leere_namen() {
        let liste = vec![("a".to_string(), "Eins".to_string()), ("b".to_string(), " ".to_string())];
        let w = runner_wahl(&liste, Some("b"));
        assert_eq!(w.len(), 2);
        assert_eq!((w[0].menue_id.as_str(), w[0].text.as_str(), w[0].aktiv), ("runner:a", "Eins", false));
        assert_eq!((w[1].menue_id.as_str(), w[1].text.as_str(), w[1].aktiv), ("runner:b", "b", true));
        assert!(runner_wahl(&liste, None).iter().all(|e| !e.aktiv));
        assert!(runner_wahl(&[], Some("a")).is_empty());
    }

    #[test]
    fn menue_kennung_fuehrt_zur_runner_id() {
        assert_eq!(runner_id_aus_menue("runner:lokal"), Some("lokal"));
        assert_eq!(runner_id_aus_menue("runner:"), None);
        for fest in ["status", "freigaben", "ruhe", "oeffnen", "einstellungen", "update", "beenden", "runner_kopf"] {
            assert_eq!(runner_id_aus_menue(fest), None, "{fest}");
        }
    }

    #[test]
    fn tooltip_hat_drei_zeilen() {
        assert_eq!(tooltip_text("Runner: X", "FYOS Agent: bereit", "Keine offenen Freigaben"), "Runner: X\nFYOS Agent: bereit\nKeine offenen Freigaben");
    }
}
