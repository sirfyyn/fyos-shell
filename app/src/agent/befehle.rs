//! Befehle des Profils `agent`. Das Chat-Fenster (`chat`) darf die Brücke, Ruhe, Zustand und den Fehlerbericht; das Hauptfenster
//! (Einstellungen) die Verbindung. Das Token geht in den Tresor hinein, nie wieder heraus.

use super::{fenster, http, token_aufloesen, vergiss_fehler, AgentZustand};
use crate::zustand::{sperre, Huelle};
use serde_json::{json, Value};
use shell_core::agent::anzeige::kopf_art;
use shell_core::agent::{adresse, alt_ziel, TOKEN_NAME, TOKEN_VERWEIS};
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

fn m(f: Fehler) -> Meldung {
    f.meldung()
}

/// Was die Einstellungsseite zeigt. Berührt den Tresor nicht (kein Systemdialog beim Öffnen der Einstellungen).
fn verbindung_json(h: &Huelle) -> Value {
    let e = sperre(&h.einstellungen);
    let a = e.agent.runner_adresse.as_deref().and_then(|r| adresse::normalisiere(r).ok());
    let alt = alt_ziel(&e.weitere);
    json!({
        "adresse": e.agent.runner_adresse,
        "unsicher": a.as_ref().map(|a| a.unsicher).unwrap_or(false),
        "ruhe": e.agent.ruhe,
        "token_verweis": !e.agent.runner_token.trim().is_empty(),
        "alt": alt.map(|z| json!({"name": z.name, "url": z.url})),
    })
}

#[tauri::command]
pub fn agent_verbindung(h: H<'_>) -> Value {
    verbindung_json(&h)
}

fn stroeme_beenden(a: &AgentZustand) {
    for (_, stop) in sperre(&a.strome).drain() {
        stop.store(true, Ordering::SeqCst);
    }
}

fn nach_aenderung(app: &AppHandle, a: &AgentZustand) {
    a.ziel_vergessen();
    stroeme_beenden(a);
    let _ = app.emit_to(fenster::CHAT, "ziel-gewechselt", ());
    super::tray::aktualisieren(app);
}

/// Adresse (und, wenn angegeben, das Token) speichern. Das Token geht in den Tresor, die Einstellungen halten nur den Verweis.
#[tauri::command]
pub fn agent_verbindung_speichern(app: AppHandle, h: H<'_>, a: A<'_>, adresse: String, token: Option<String>) -> Result<Value, Meldung> {
    let neu = adresse::normalisiere(&adresse).map_err(m)?;
    let token = token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    if let Some(t) = &token {
        if !token_brauchbar(t) {
            return Err(m(Fehler::TokenUnbrauchbar));
        }
        h.tresor.schreiben(TOKEN_NAME, t).map_err(|f| m(f.into()))?;
    }
    {
        let mut e = sperre(&h.einstellungen);
        e.agent.runner_adresse = Some(neu.basis.clone());
        if e.agent.runner_token != TOKEN_VERWEIS {
            e.agent.runner_token = TOKEN_VERWEIS.to_string();
        }
        einstellungen::speichern(&h.pfade, &e).map_err(m)?;
    }
    vergiss_fehler(&h);
    nach_aenderung(&app, &a);
    Ok(verbindung_json(&h))
}

/// Prüft die Verbindung (`GET /api/health`) mit den angegebenen oder den gespeicherten Werten. Ändert nichts.
#[tauri::command]
pub async fn agent_verbindung_pruefen(h: H<'_>, adresse: Option<String>, token: Option<String>) -> Result<Value, Meldung> {
    let h: Arc<Huelle> = h.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, Fehler> {
        let roh = match adresse.filter(|a| !a.trim().is_empty()) {
            Some(a) => a,
            None => sperre(&h.einstellungen).agent.runner_adresse.clone().unwrap_or_default(),
        };
        let a = adresse::normalisiere(&roh)?;
        let tok = match token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
            Some(t) => t,
            None => {
                let verweis = sperre(&h.einstellungen).agent.runner_token.clone();
                token_aufloesen(&h, &verweis)?
            }
        };
        let v = http::gesundheit(&a.basis, &tok)?;
        Ok(json!({
            "ok": true,
            "adresse": a.basis,
            "unsicher": a.unsicher,
            "agent": v.get("agent").and_then(Value::as_str).unwrap_or(""),
            "geraet": v.pointer("/geraet/name").and_then(Value::as_str).unwrap_or(""),
        }))
    })
    .await
    .map_err(|e| m(Fehler::RunnerFehler { status: 0, text: Some(e.to_string()) }))?
    .map_err(m)
}

/// Übernimmt Adresse und Token des zuletzt benutzten Runners der bisherigen Agent-App: gleicher Datenordner, gleicher Schlüsselbund-Dienst
/// (`runner:<kennung>`). Es wird nur kopiert; der alte Eintrag bleibt.
#[tauri::command]
pub fn agent_alt_uebernehmen(app: AppHandle, h: H<'_>, a: A<'_>) -> Result<Value, Meldung> {
    let alt = alt_ziel(&sperre(&h.einstellungen).weitere).ok_or_else(|| m(Fehler::RunnerNichtEingerichtet))?;
    let neu = adresse::normalisiere(&alt.url).map_err(m)?;
    let token = h.tresor.lesen(&alt.konto).map_err(|f| m(f.into()))?.filter(|t| !t.trim().is_empty());
    if let Some(t) = &token {
        h.tresor.schreiben(TOKEN_NAME, t).map_err(|f| m(f.into()))?;
    }
    {
        let mut e = sperre(&h.einstellungen);
        e.agent.runner_adresse = Some(neu.basis.clone());
        e.agent.runner_token = TOKEN_VERWEIS.to_string();
        einstellungen::speichern(&h.pfade, &e).map_err(m)?;
    }
    nach_aenderung(&app, &a);
    let mut j = verbindung_json(&h);
    j["token_uebernommen"] = json!(token.is_some());
    j["name"] = json!(alt.name);
    if token.is_none() {
        return Ok(j); // Adresse übernommen, Token fehlt: die Seite weist darauf hin
    }
    Ok(j)
}

/// Das Chat-Fenster öffnen oder nach vorn holen (Knopf in den Einstellungen).
#[tauri::command]
pub fn agent_chat_oeffnen(app: AppHandle) -> Result<(), Meldung> {
    fenster::chat_oeffnen(&app).map_err(|e| m(Fehler::RunnerFehler { status: 0, text: Some(e.to_string()) }))
}

/// Der Runner, den das Chat-Fenster zeigt (ohne Token): nur Rechnername der Adresse und Ruhe.
#[tauri::command]
pub fn ziel_info(h: H<'_>) -> Result<Value, Meldung> {
    let e = sperre(&h.einstellungen);
    let roh = e.agent.runner_adresse.clone().ok_or_else(|| m(Fehler::RunnerNichtEingerichtet))?;
    let a = adresse::normalisiere(&roh).map_err(m)?;
    // `e2e`: nur Debug-Bauten und nur mit FYOS_SHELL_AGENT_E2E=1 (Prüfskript der Seite, siehe tools/e2e_agent.py)
    let e2e = cfg!(debug_assertions) && std::env::var("FYOS_SHELL_AGENT_E2E").as_deref() == Ok("1");
    Ok(json!({"host": a.host, "lokal": adresse::ist_loopback(&a.host), "ruhe": e.agent.ruhe, "e2e": e2e}))
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
