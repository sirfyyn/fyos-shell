//! Befehle des Profils `agent`. Das Chat-Fenster (`chat`) darf die Brücke, Ruhe, Zustand und den Fehlerbericht; das Hauptfenster
//! (Einstellungen) die Verbindungsprüfung und die Übernahme aus der bisherigen App. Die Runner-Liste, der lokale Runner und die
//! Ordnerwahl haben eigene Befehle in `runner_befehle.rs`. Das Token geht in den Tresor hinein, nie wieder heraus.

use super::{fenster, http, token_aufloesen, AgentZustand};
use crate::zustand::{sperre, Huelle};
use serde_json::{json, Value};
use shell_core::agent::anzeige::kopf_art;
use shell_core::agent::runner::{neue_id, token_name, token_verweis, Art, RunnerEintrag};
use shell_core::agent::adressfolge::{alle_tot, ist_verbindungsfehler};
use shell_core::agent::runner::adressen_pruefen;
use shell_core::agent::{adresse, alt_ziel};
use shell_core::einstellungen;
use shell_core::{Fehler, Meldung};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

type H<'a> = State<'a, Arc<Huelle>>;
type A<'a> = State<'a, Arc<AgentZustand>>;

/// Ein Token ist brauchbar ab 16 Zeichen ohne Leerraum (der Runner erwartet mindestens 32; kürzere sind fast immer Tippfehler).
pub fn token_brauchbar(t: &str) -> bool {
    let t = t.trim();
    t.len() >= 16 && !t.chars().any(char::is_whitespace)
}

pub(super) fn m(f: Fehler) -> Meldung {
    f.meldung()
}

pub(super) fn stroeme_beenden(a: &AgentZustand) {
    for (_, stop) in sperre(&a.strome).drain() {
        stop.store(true, Ordering::SeqCst);
    }
}

/// Nach geändertem Ziel (anderer Runner, neue Adresse, neues Token): Zwischenspeicher und Ströme verwerfen, Chat-Seite neu laden lassen.
pub(crate) fn nach_aenderung(app: &AppHandle, a: &AgentZustand) {
    a.ziel_vergessen();
    stroeme_beenden(a);
    let _ = app.emit_to(fenster::CHAT, "ziel-gewechselt", ());
    super::tray::aktualisieren(app);
}

/// Prüft die Verbindung (`GET /api/health`) mit den angegebenen oder den gespeicherten Werten eines entfernten Runners. Ändert nichts.
/// `id`: ein Runner der Liste (Adresse und Token daraus, soweit nicht angegeben).
#[tauri::command]
pub async fn agent_verbindung_pruefen(h: H<'_>, id: Option<String>, adresse: Option<String>, adresse2: Option<String>, token: Option<String>) -> Result<Value, Meldung> {
    let h: Arc<Huelle> = h.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, Fehler> {
        let eintrag = {
            let mut e = sperre(&h.einstellungen).agent.clone();
            e.runner_uebernehmen();
            id.as_deref().and_then(|i| e.runner_finden(i)).cloned()
        };
        let roh = match adresse.filter(|a| !a.trim().is_empty()) {
            Some(a) => a,
            None => eintrag.as_ref().and_then(|r| r.adresse.clone()).unwrap_or_default(),
        };
        // Rückfalladresse: die angegebene (auch leer = keine), sonst die gespeicherte des Runners
        let roh2 = match adresse2 {
            Some(a) => Some(a),
            None => eintrag.as_ref().and_then(|r| r.adresse2.clone()),
        };
        let (a, a2) = adressen_pruefen(&roh, roh2.as_deref())?;
        let tok = match token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
            Some(t) => t,
            None => token_aufloesen(&h, eintrag.as_ref().map(|r| r.token.as_str()).unwrap_or(""))?,
        };
        let r1 = http::gesundheit(&a.basis, &tok);
        let r2 = a2.as_ref().map(|n| http::gesundheit(&n.basis, &tok));
        let ok2 = r2.as_ref().map(|r| r.is_ok());
        // mit zwei Adressen genügt eine, die antwortet; eine HTTP-Antwort (auch 401) zählt vor einem Verbindungsfehler der anderen
        let (v, gewaehlt, unsicher) = match (r1, r2) {
            (Ok(v), _) => (v, a.basis.clone(), a.unsicher),
            (Err(f), None) => return Err(f),
            (Err(f), Some(Ok(v))) if ist_verbindungsfehler(&f) => (v, a2.as_ref().map(|n| n.basis.clone()).unwrap_or_default(), a2.as_ref().is_some_and(|n| n.unsicher)),
            (Err(f), Some(Ok(_))) => return Err(f),
            (Err(f1), Some(Err(f2))) => {
                return Err(match (ist_verbindungsfehler(&f1), ist_verbindungsfehler(&f2)) {
                    (true, true) => alle_tot(&[a.basis.clone(), a2.as_ref().map(|n| n.basis.clone()).unwrap_or_default()], f1),
                    (true, false) => f2,
                    _ => f1,
                })
            }
        };
        let zweite = a2.as_ref().map(|n| json!({"adresse": n.basis, "ok": ok2 == Some(true), "unsicher": n.unsicher}));
        Ok(json!({
            "ok": true,
            "adresse": gewaehlt,
            "unsicher": unsicher,
            "zweite": zweite,
            "agent": v.get("agent").and_then(Value::as_str).unwrap_or(""),
            "geraet": v.pointer("/geraet/name").and_then(Value::as_str).unwrap_or(""),
        }))
    })
    .await
    .map_err(|e| m(Fehler::RunnerFehler { status: 0, text: Some(e.to_string()) }))?
    .map_err(m)
}

/// Übernimmt Adresse und Token des zuletzt benutzten Runners der bisherigen Agent-App: gleicher Datenordner, gleicher Schlüsselbund-Dienst
/// (`runner:<kennung>`). Es wird nur kopiert; der alte Eintrag bleibt. Der Runner wird als neuer Eintrag der Liste angelegt und aktiv.
#[tauri::command]
pub fn agent_alt_uebernehmen(app: AppHandle, h: H<'_>, a: A<'_>) -> Result<Value, Meldung> {
    let alt = alt_ziel(&sperre(&h.einstellungen).weitere).ok_or_else(|| m(Fehler::RunnerNichtEingerichtet))?;
    let neu = adresse::normalisiere(&alt.url).map_err(m)?;
    let token = h.tresor.lesen(&alt.konto).map_err(|f| m(f.into()))?.filter(|t| !t.trim().is_empty());
    {
        let mut e = sperre(&h.einstellungen);
        e.agent.runner_uebernehmen();
        let id = neue_id(&alt.name, &e.agent.runner);
        if let Some(t) = &token {
            h.tresor.schreiben(&token_name(&id), t).map_err(|f| m(f.into()))?;
        }
        let verweis = if token.is_some() { token_verweis(&id) } else { String::new() };
        e.agent.runner_setzen(RunnerEintrag { id: id.clone(), name: alt.name.clone(), art: Art::Entfernt, adresse: Some(neu.basis.clone()), adresse2: None, token: verweis });
        let _ = e.agent.aktiv_setzen(&id);
        einstellungen::speichern(&h.pfade, &e).map_err(m)?;
    }
    nach_aenderung(&app, &a);
    Ok(json!({"token_uebernommen": token.is_some(), "name": alt.name, "adresse": neu.basis}))
}

/// Das Chat-Fenster öffnen oder nach vorn holen (Knopf in den Einstellungen).
#[tauri::command]
pub fn agent_chat_oeffnen(app: AppHandle) -> Result<(), Meldung> {
    fenster::chat_oeffnen(&app).map_err(|e| m(Fehler::RunnerFehler { status: 0, text: Some(e.to_string()) }))
}

/// Das Einstellungsfenster öffnen oder nach vorn holen (Knopf „Einstellungen“ und Cmd+, im Chat-Fenster). Dasselbe wie der Tray-Eintrag; die
/// Seite bekommt weder Adresse noch Token, nur den Auftrag zum Öffnen.
#[tauri::command]
pub fn einstellungen_oeffnen(app: AppHandle) -> Result<(), Meldung> {
    fenster::einstellungen_zeigen(&app).map_err(|e| m(Fehler::RunnerFehler { status: 0, text: Some(e.to_string()) }))
}

/// Der Runner, den das Chat-Fenster zeigt (ohne Token): Kennung, Name, Art, Rechnername der Adresse und Ruhe.
#[tauri::command]
pub fn ziel_info(h: H<'_>, a: A<'_>) -> Result<Value, Meldung> {
    let mut e = sperre(&h.einstellungen).agent.clone();
    e.runner_uebernehmen();
    let r = e.aktiver().cloned().ok_or_else(|| m(Fehler::RunnerNichtEingerichtet))?;
    let host = match r.art {
        Art::Lokal => "127.0.0.1".to_string(),
        Art::Entfernt => adresse::normalisiere(r.adresse.as_deref().unwrap_or("")).map_err(m)?.host,
    };
    // `e2e`: nur Debug-Bauten und nur mit FYOS_SHELL_AGENT_E2E=1 (Prüfskript der Seite, siehe tools/e2e_agent.py)
    let e2e = cfg!(debug_assertions) && std::env::var("FYOS_SHELL_AGENT_E2E").as_deref() == Ok("1");
    // welches Prüfskript die Seite lädt (nur Kleinbuchstaben, Ziffern und Bindestrich, Vorgabe „e2e“)
    let skript: String = std::env::var("FYOS_SHELL_AGENT_E2E_SKRIPT").unwrap_or_default().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '-').take(24).collect();
    Ok(json!({
        "host": host, "lokal": adresse::ist_loopback(&host), "ruhe": e.ruhe,
        "runner": {"id": r.id, "name": r.name, "art": r.art},
        "e2e": e2e,
        // einmalig: das Fenster wurde über die Freigaben-Zeile im Tray geöffnet
        "freigaben_zeigen": a.freigaben_zeigen.swap(false, Ordering::SeqCst),
        "e2e_skript": if e2e && !skript.is_empty() { skript } else { "e2e".to_string() },
    }))
}

/// Ruhe an/aus: keine Benachrichtigungen. Gilt für Chat-Fenster und Tray.
#[tauri::command]
pub fn ruhe_setzen(app: AppHandle, h: H<'_>, an: bool) -> Result<bool, Meldung> {
    ruhe_setzen_intern(&app, &h, an)
}

/// Auch für den Tray-Eintrag „Ruhe“.
pub fn ruhe_setzen_intern(app: &AppHandle, h: &Huelle, an: bool) -> Result<bool, Meldung> {
    {
        let mut e = sperre(&h.einstellungen);
        e.agent.ruhe = an;
        einstellungen::speichern(&h.pfade, &e).map_err(m)?;
    }
    super::tray::aktualisieren(app);
    let _ = app.emit_to(fenster::CHAT, "ruhe-geaendert", an);
    Ok(an)
}

/// Das Chat-Fenster meldet seinen Kopfzustand und ob ein Zug läuft; der Tray zeigt es.
#[tauri::command]
pub fn zustand_melden(app: AppHandle, a: A<'_>, art: String, arbeitet: bool) {
    *sperre(&a.kopf) = (kopf_art(&art).to_string(), arbeitet);
    super::tray::aktualisieren(&app);
}
