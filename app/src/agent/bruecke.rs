//! Brücke zwischen Chat-Seite und Runner (Befehle und Stromfäden). Regeln: `shell_core::agent::bruecke`.
//!
//! Die Seite ruft `runner_anfrage` (ein Weg unter `/api/`) und öffnet Ströme mit `strom_oeffnen`; Rust hält Adresse und Token und liest den
//! SSE-Strom. Nach Abbruch verbindet der Faden selbst neu (1, 2, 4, 8, 15 s) und meldet jedes Ereignis als Tauri-Ereignis `runner-strom`.

use super::{http, merke_fehler, vergiss_fehler, AgentZustand};
use crate::zustand::Huelle;
use serde_json::{json, Value};
use shell_core::agent::adresse::api_url;
use shell_core::agent::adressfolge::{Fehlschlag, VERBINDEN_MIT_RUECKFALL_MS};
use shell_core::agent::bruecke::{methode_erlaubt, pfad_erlaubt, pfad_reserviert, strom_pfad_ok, wartezeit_ms, SseLeser};
use shell_core::{Fehler, Meldung};
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

type H<'a> = State<'a, Arc<Huelle>>;
type A<'a> = State<'a, Arc<AgentZustand>>;

const ANFRAGE_FRIST: Duration = Duration::from_secs(45);
/// Der Runner schickt regelmäßig einen Herzschlag; 45 s ohne ein Byte heißt: tot.
const LESE_FRIST: Duration = Duration::from_secs(45);
const ZEILE_MAX: usize = 64 * 1024 * 1024;

/// Kurze Verbindungsfrist (2 s), solange danach noch eine zweite Adresse kommt; sonst gilt die übliche Frist.
pub(super) fn verbinden_frist(hat_weitere: bool) -> Option<Duration> {
    hat_weitere.then(|| Duration::from_millis(VERBINDEN_MIT_RUECKFALL_MS))
}

fn nicht_freigegeben(pfad: &str) -> Meldung {
    Fehler::LinkAbgelehnt { link: pfad.chars().take(80).collect(), grund: "dieser Weg ist für die Seite nicht freigegeben".into() }.meldung()
}

/// Eine Anfrage an den eingestellten Runner. Fehler kommen als Katalogmeldung (Code, Ursache, Abhilfe).
#[tauri::command]
pub async fn runner_anfrage(h: H<'_>, a: A<'_>, methode: String, pfad: String, koerper: Option<Value>) -> Result<Value, Meldung> {
    let m = methode_erlaubt(&methode).ok_or_else(|| nicht_freigegeben(&methode))?;
    if !pfad_erlaubt(&pfad) || pfad_reserviert(&pfad) {
        return Err(nicht_freigegeben(&pfad));
    }
    let (h, a): (Arc<Huelle>, Arc<AgentZustand>) = (h.inner().clone(), a.inner().clone());
    tauri::async_runtime::spawn_blocking(move || {
        let ziel = a.ziel(&h)?;
        let r = a.versuchen(&ziel, |basis, weitere| http::anfrage_folge(m, &api_url(basis, &pfad), &ziel.token, koerper.as_ref(), ANFRAGE_FRIST, verbinden_frist(weitere)));
        if let Err(f) = &r {
            merke_fehler(&h, f);
        }
        r
    })
    .await
    .map_err(|e| Fehler::RunnerFehler { status: 0, text: Some(e.to_string()) }.meldung())?
    .map_err(|f| f.meldung())
}

/// Einen Strom öffnen (ersetzt einen offenen Strom desselben Kanals).
#[tauri::command]
pub fn strom_oeffnen(app: AppHandle, h: H<'_>, a: A<'_>, kanal: String, pfad: String) -> Result<(), Meldung> {
    if !strom_pfad_ok(&kanal, &pfad) {
        return Err(nicht_freigegeben(&pfad));
    }
    let (h, a): (Arc<Huelle>, Arc<AgentZustand>) = (h.inner().clone(), a.inner().clone());
    a.ziel(&h).map_err(|f| f.meldung())?;
    let stop = Arc::new(AtomicBool::new(false));
    if let Some(alt) = crate::zustand::sperre(&a.strome).insert(kanal.clone(), stop.clone()) {
        alt.store(true, Ordering::SeqCst);
    }
    std::thread::Builder::new()
        .name(format!("runner-strom-{kanal}"))
        .spawn(move || schleife(app, h, a, kanal, pfad, stop))
        .map(|_| ())
        .map_err(|e| Fehler::RunnerFehler { status: 0, text: Some(e.to_string()) }.meldung())
}

#[tauri::command]
pub fn strom_schliessen(a: A<'_>, kanal: String) {
    if let Some(stop) = crate::zustand::sperre(&a.strome).remove(&kanal) {
        stop.store(true, Ordering::SeqCst);
    }
}

fn melde(app: &AppHandle, kanal: &str, pfad: &str, art: &str, daten: Value, fehler: Option<&Meldung>, wartezeit: Option<u64>) {
    let _ = app.emit(
        "runner-strom",
        json!({
            "kanal": kanal, "pfad": pfad, "art": art, "daten": daten,
            "fehler": fehler.map(|m| format!("{} ({})", m.ursache, m.code)),
            "meldung": fehler, "wartezeitMs": wartezeit,
        }),
    );
}

fn schlafe(stop: &AtomicBool, ms: u64) {
    let mut rest = ms;
    while rest > 0 && !stop.load(Ordering::SeqCst) {
        let schritt = rest.min(100);
        std::thread::sleep(Duration::from_millis(schritt));
        rest -= schritt;
    }
}

fn schleife(app: AppHandle, h: Arc<Huelle>, a: Arc<AgentZustand>, kanal: String, pfad: String, stop: Arc<AtomicBool>) {
    let mut versuch: u32 = 0;
    while !stop.load(Ordering::SeqCst) {
        // dieselbe Auflösung wie bei den Anfragen: gemerkte Adresse zuerst, bei Verbindungsfehler die andere
        let ergebnis = a.ziel(&h).and_then(|ziel| {
            a.versuchen(&ziel, |basis, weitere| {
                let verbinden = verbinden_frist(weitere).unwrap_or(Duration::from_secs(6));
                http::strom_verbinden_mit(&api_url(basis, &pfad), &ziel.token, LESE_FRIST, verbinden).map(|l| (basis.to_string(), l)).map_err(Fehlschlag::from)
            })
        });
        let grund: Fehler = match ergebnis {
            Ok((basis, leser)) => {
                vergiss_fehler(&h);
                melde(&app, &kanal, &pfad, "verbunden", Value::Null, None, None);
                // Wechselt eine Anfrage die Adresse, während dieser Strom noch steht, endet er, und die Schleife öffnet ihn auf der neuen Adresse
                // neu; die Chat-Seite lädt dabei nicht neu (sie sieht nur „getrennt“ und „verbunden“).
                let (empfangen, ende) = lies(&app, &kanal, &pfad, leser, &stop, &|| a.strom_veraltet(&basis));
                if empfangen {
                    versuch = 0;
                }
                ende
            }
            Err(f) => {
                // Ein abgelehntes Token wird nicht durch Wiederholen besser, aber der Nutzer kann es in den Einstellungen ändern: Ziel neu lesen
                if matches!(f, Fehler::TokenAbgelehnt { .. } | Fehler::TokenFehlt) {
                    a.ziel_vergessen();
                }
                f
            }
        };
        if stop.load(Ordering::SeqCst) {
            break;
        }
        merke_fehler(&h, &grund);
        let warte = wartezeit_ms(versuch);
        versuch = versuch.saturating_add(1);
        melde(&app, &kanal, &pfad, "getrennt", Value::Null, Some(&grund.meldung()), Some(warte));
        schlafe(&stop, warte);
    }
}

/// Liest bis zum Ende oder Fehler. Rückgabe: ob mindestens ein Ereignis ankam, und der Grund des Endes.
fn lies(app: &AppHandle, kanal: &str, pfad: &str, leser: Box<dyn std::io::Read + Send + Sync>, stop: &AtomicBool, veraltet: &dyn Fn() -> bool) -> (bool, Fehler) {
    let mut r = BufReader::new(leser);
    let mut sse = SseLeser::default();
    let mut puffer: Vec<u8> = Vec::with_capacity(4096);
    let mut empfangen = false;
    let ende = |t: &str| Fehler::RunnerNichtErreichbar { url: String::new(), grund: t.to_string() };
    loop {
        if stop.load(Ordering::SeqCst) {
            return (empfangen, ende("geschlossen"));
        }
        if veraltet() {
            return (empfangen, ende("die Adresse des Runners hat gewechselt"));
        }
        puffer.clear();
        match r.read_until(b'\n', &mut puffer) {
            Ok(0) => return (empfangen, ende("der Runner hat die Verbindung beendet")),
            Ok(_) => {}
            Err(e) => return (empfangen, ende(&format!("Verbindung abgebrochen: {e}"))),
        }
        if puffer.len() > ZEILE_MAX {
            return (empfangen, ende("Zeile zu groß"));
        }
        let zeile = String::from_utf8_lossy(&puffer);
        if let Some(ev) = sse.zeile(&zeile) {
            if let Ok(daten) = serde_json::from_str::<Value>(&ev.daten) {
                empfangen = true;
                melde(app, kanal, pfad, &ev.art, daten, None, None);
            }
        }
    }
}
