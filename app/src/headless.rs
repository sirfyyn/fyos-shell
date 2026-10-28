//! Modi ohne sichtbares Fenster: `--selbsttest`, `--aktualisieren`, `--zurueck`, `--info`.
//! Ausgabe: eine JSON-Zeile auf stdout. Ausgangscode: 0 gut, 2 Fehler (Katalogtext in der JSON-Zeile), 3 Selbsttest gescheitert.

use crate::aktualisieren;
use crate::cli::Modus;
use crate::fenster;
use crate::studio_http;
use crate::zustand::{sperre, BegleiterStand, Huelle};
use serde_json::{json, Value};
use shell_core::verlauf::Art;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::AppHandle;

pub fn starten(app: AppHandle, h: Arc<Huelle>, modus: Modus) {
    std::thread::spawn(move || {
        let (ausgabe, code) = tauri::async_runtime::block_on(ausfuehren(&app, &h, modus));
        println!("{ausgabe}");
        h.begleiter_beenden();
        app.exit(code);
    });
}

async fn ausfuehren(app: &AppHandle, h: &Arc<Huelle>, modus: Modus) -> (Value, i32) {
    match modus {
        Modus::Info => (info(h), 0),
        Modus::Autostart(an) => match crate::befehle::autostart_schalten(app, h, an) {
            Ok(()) => (json!({"modus": "autostart", "ok": true, "autostart": an}), 0),
            Err(f) => (json!({"modus": "autostart", "ok": false, "fehler": f.meldung()}), 2),
        },
        Modus::Bericht => match crate::befehle::bericht_schreiben(app, h, None) {
            Ok(datei) => (json!({"modus": "bericht", "ok": true, "datei": datei.display().to_string()}), 0),
            Err(f) => (json!({"modus": "bericht", "ok": false, "fehler": f.meldung()}), 2),
        },
        Modus::Aktualisieren => update(app, h, Art::Update).await,
        Modus::Zurueck => update(app, h, Art::Rueckweg).await,
        Modus::Selbsttest => selbsttest(app, h).await,
        Modus::Fenster { .. } => unreachable!("Fenstermodus läuft nicht headless"),
    }
}

fn info(h: &Huelle) -> Value {
    json!({
        "modus": "info",
        "profil": h.profil.name(),
        "version": h.version,
        "vorherige": sperre(&h.verlauf).vorherige,
        "daten": h.pfade.daten.display().to_string(),
        "ausgang": sperre(&h.start_ausgang).as_ref().map(|a| a.text()),
    })
}

async fn update(app: &AppHandle, h: &Arc<Huelle>, art: Art) -> (Value, i32) {
    let modus = if art == Art::Update { "aktualisieren" } else { "zurueck" };
    match aktualisieren::einspielen(app, h, art).await {
        Ok(Some(version)) => (json!({"modus": modus, "ok": true, "ergebnis": "eingespielt", "version": version, "hinweis": "Neustart nötig"}), 0),
        Ok(None) => (json!({"modus": modus, "ok": true, "ergebnis": "nichts_zu_tun", "version": h.version}), 0),
        Err(f) => (json!({"modus": modus, "ok": false, "fehler": f.meldung()}), 2),
    }
}

async fn selbsttest(app: &AppHandle, h: &Arc<Huelle>) -> (Value, i32) {
    let mut schritte: Vec<Value> = Vec::new();
    let mut alles_gut = true;
    let mut schritt = |name: &str, ok: bool, text: String| {
        alles_gut &= ok;
        schritte.push(json!({"name": name, "ok": ok, "text": text}));
    };

    schritt("start", true, format!("{} {} ({}), Datenordner {}", h.profil.name(), h.version, std::env::consts::OS, h.pfade.daten.display()));

    // Begleiter (nur Studio mit eingestelltem Programm)
    let hh = h.clone();
    let start = tauri::async_runtime::spawn_blocking(move || hh.begleiter_starten()).await;
    match start {
        Ok(Ok(())) => match &*sperre(&h.begleiter_stand) {
            BegleiterStand::Laeuft => {
                let url = h.gesundheits_url();
                let kennung = h.kennung();
                match studio_http::holen(&url, kennung.as_deref()) {
                    Ok(z) => schritt("begleiter", true, format!("läuft ({}), /api/state meldet {} {}; Quelle: {}", url, z.app, z.version, sperre(&h.begleiter_quelle))),
                    Err(f) => schritt("begleiter", false, f.to_string()),
                }
            }
            _ => schritt("begleiter", true, "kein Begleiter in diesem Profil oder dieser Einstellung".into()),
        },
        Ok(Err(f)) => schritt("begleiter", false, f.to_string()),
        Err(e) => schritt("begleiter", false, e.to_string()),
    }

    // Fenster zeichnet und Rust-Befehl antwortet: die Seite ruft `seite_bereit`
    match fenster::haupt(app, false) {
        Err(e) => schritt("fenster", false, e.to_string()),
        Ok(()) => {
            let ende = Instant::now() + Duration::from_secs(25);
            let antwort = loop {
                if let Some(a) = sperre(&h.seite_bereit).clone() {
                    break Some(a);
                }
                if Instant::now() >= ende {
                    break None;
                }
                kurz_warten().await;
            };
            match antwort {
                Some((true, v)) if v == h.version => schritt("fenster", true, format!("Seite gezeichnet, Befehl antwortet, Version {v}")),
                Some((zeichnet, v)) => schritt("fenster", false, format!("Seite meldet zeichnet={zeichnet}, Version {v} (erwartet {})", h.version)),
                None => schritt("fenster", false, "Die Seite hat sich in 25 s nicht gemeldet (Web-Ansicht leer oder blockiert)".into()),
            }
        }
    }

    let code = if alles_gut { 0 } else { 3 };
    (json!({"modus": "selbsttest", "ok": alles_gut, "schritte": schritte}), code)
}

async fn kurz_warten() {
    tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(100))).await.ok();
}
