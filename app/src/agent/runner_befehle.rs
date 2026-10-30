//! Befehle für die Runner-Liste, den lokalen Runner und die Ordnerwahl (Profil `agent`).
//!
//! Aufteilung der Rechte (je Befehl eine Berechtigungsdatei, zugeteilt in `capabilities/agent-chat.json` und `agent-haupt.json`):
//! - Chat-Fenster: `runner_liste`, `runner_wechseln`, `ordner_waehlen`, `ordner_zuletzt`, `ordner_merken`
//! - Einstellungen (Hauptfenster): `runner_liste`, `runner_speichern`, `runner_entfernen`, `lokaler_runner_einstellen`,
//!   `lokaler_runner_status`, `lokaler_runner_starten`, `lokaler_runner_stoppen`
//!
//! Der Systemdialog für Ordner wird nur hier in Rust geöffnet; das Dialog-Plugin hat in keiner Capability Rechte für Seiten.
//! Token und Adressen kommen nie in eine Antwort: die Liste nennt nur „hat ein Token“.

use super::befehle::{m, nach_aenderung, token_brauchbar};
use super::lokal::{start_wurzeln, FEHLER};
use super::{vergiss_fehler, AgentZustand};
use crate::zustand::{sperre, Huelle};
use serde_json::{json, Value};
use shell_core::agent::runner::{adressen_pruefen, liste_json, neue_id, name_aus_adresse, ordner_name, ordner_pruefen, token_verweis, Art, LokalKonfig, RunnerEintrag, LOKAL_ID};
use shell_core::einstellungen;
use shell_core::{Fehler, Meldung};
use std::sync::Arc;
use tauri::{AppHandle, State};

type H<'a> = State<'a, Arc<Huelle>>;
type A<'a> = State<'a, Arc<AgentZustand>>;

fn liste(h: &Huelle, a: &AgentZustand) -> Value {
    let (mut e, weitere) = {
        let g = sperre(&h.einstellungen);
        (g.agent.clone(), g.weitere.clone())
    };
    e.runner_uebernehmen();
    let mut j = liste_json(&e, a.lokal.stand_text());
    // ein Runner der bisherigen Agent-App, der übernommen werden kann (Name und Adresse, ohne Token)
    j["alt"] = shell_core::agent::alt_ziel(&weitere).map(|z| json!({"name": z.name, "url": z.url})).unwrap_or(Value::Null);
    j
}

fn blockierend<T: Send + 'static>(f: impl FnOnce() -> Result<T, Fehler> + Send + 'static) -> impl std::future::Future<Output = Result<T, Meldung>> {
    async move {
        tauri::async_runtime::spawn_blocking(f)
            .await
            .map_err(|e| m(Fehler::RunnerFehler { status: 0, text: Some(e.to_string()) }))?
            .map_err(m)
    }
}

/// Die Runner der Liste (ohne Token), der aktive und der Stand des lokalen Runners.
#[tauri::command]
pub fn runner_liste(h: H<'_>, a: A<'_>) -> Value {
    liste(&h, &a)
}

/// Legt einen entfernten Runner an oder ändert ihn. Das Token (wenn angegeben) geht in den Tresor, in der Liste steht nur der Verweis.
#[tauri::command]
pub fn runner_speichern(app: AppHandle, h: H<'_>, a: A<'_>, id: Option<String>, name: Option<String>, adresse: String, adresse2: Option<String>, token: Option<String>) -> Result<Value, Meldung> {
    // beide Adressen mit denselben Regeln; die zweite ist optional (leer = keine)
    let (neu, neu2) = adressen_pruefen(&adresse, adresse2.as_deref()).map_err(m)?;
    let token = token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    if let Some(t) = &token {
        if !token_brauchbar(t) {
            return Err(m(Fehler::TokenUnbrauchbar));
        }
    }
    let wechsel;
    {
        let mut e = sperre(&h.einstellungen);
        e.agent.runner_uebernehmen();
        let vorher_aktiv = e.agent.aktiver().map(|r| r.id.clone());
        let alt = match id.as_deref() {
            Some(i) => Some(e.agent.runner_finden(i).cloned().ok_or_else(|| m(Fehler::RunnerUnbekannt { id: i.to_string() }))?),
            None => None,
        };
        if alt.as_ref().is_some_and(|r| r.art == Art::Lokal) {
            return Err(m(Fehler::RunnerUnbekannt { id: LOKAL_ID.into() }));
        }
        let anzeige = name.as_deref().map(str::trim).filter(|n| !n.is_empty()).map(|n| n.chars().take(60).collect::<String>());
        let anzeige = anzeige.or_else(|| alt.as_ref().map(|r| r.name.clone())).unwrap_or_else(|| name_aus_adresse(&neu.basis));
        let rid = alt.as_ref().map(|r| r.id.clone()).unwrap_or_else(|| neue_id(&anzeige, &e.agent.runner));
        let verweis = match (&token, alt.as_ref().map(|r| r.token.clone()).filter(|t| !t.trim().is_empty())) {
            (Some(t), vorhanden) => {
                let verweis = vorhanden.unwrap_or_else(|| token_verweis(&rid));
                let name = verweis.trim_start_matches("{tresor:").trim_end_matches('}').to_string();
                h.tresor.schreiben(&name, t).map_err(|f| m(f.into()))?;
                verweis
            }
            (None, Some(vorhanden)) => vorhanden,
            (None, None) => String::new(),
        };
        e.agent.runner_setzen(RunnerEintrag { id: rid.clone(), name: anzeige, art: Art::Entfernt, adresse: Some(neu.basis.clone()), adresse2: neu2.map(|n| n.basis), token: verweis });
        if alt.is_none() && vorher_aktiv.is_none() {
            let _ = e.agent.aktiv_setzen(&rid);
        }
        wechsel = e.agent.aktiver().map(|r| r.id.as_str() == rid) == Some(true);
        einstellungen::speichern(&h.pfade, &e).map_err(m)?;
    }
    vergiss_fehler(&h);
    if wechsel {
        nach_aenderung(&app, &a);
    }
    Ok(liste(&h, &a))
}

/// Entfernt einen Runner aus der Liste (und sein Token aus dem Tresor). Den lokalen Runner entfernt man, indem man sein Programm leert.
#[tauri::command]
pub fn runner_entfernen(app: AppHandle, h: H<'_>, a: A<'_>, id: String) -> Result<Value, Meldung> {
    if id == LOKAL_ID {
        return lokaler_runner_einstellen_intern(&app, &h, &a, LokalKonfig::default());
    }
    let (war_aktiv, weg) = {
        let mut e = sperre(&h.einstellungen);
        e.agent.runner_uebernehmen();
        let war_aktiv = e.agent.aktiver().map(|r| r.id == id).unwrap_or(false);
        let weg = e.agent.runner_entfernen(&id).map_err(m)?;
        einstellungen::speichern(&h.pfade, &e).map_err(m)?;
        (war_aktiv, weg)
    };
    if weg.token.starts_with("{tresor:runner-") {
        let name = weg.token.trim_start_matches("{tresor:").trim_end_matches('}');
        let _ = h.tresor.loeschen(name);
    }
    if war_aktiv {
        nach_aenderung(&app, &a);
    }
    Ok(liste(&h, &a))
}

/// Macht einen Runner zum aktiven. Der lokale Runner wird dabei gestartet (bis zu 30 s); scheitert der Start, bleibt der bisherige aktiv.
#[tauri::command]
pub async fn runner_wechseln(app: AppHandle, h: H<'_>, a: A<'_>, id: String) -> Result<Value, Meldung> {
    wechseln_intern(app, h.inner().clone(), a.inner().clone(), id).await
}

/// Der eine Weg zum Wechseln des Runners: der Befehl `runner_wechseln` (Chat, Einstellungen) und das Tray-Menü rufen beide diese Funktion.
pub(super) async fn wechseln_intern(app: AppHandle, h: Arc<Huelle>, a: Arc<AgentZustand>, id: String) -> Result<Value, Meldung> {
    let (h2, a2, id2) = (h.clone(), a.clone(), id.clone());
    blockierend(move || {
        let art = {
            let mut e = sperre(&h2.einstellungen);
            e.agent.runner_uebernehmen();
            e.agent.runner_finden(&id2).map(|r| r.art).ok_or_else(|| Fehler::RunnerUnbekannt { id: id2.clone() })?
        };
        if art == Art::Lokal && a2.lokal.stand_text() != super::lokal::LAEUFT {
            a2.lokal.starten(&h2, start_wurzeln(&h2))?;
        }
        let mut e = sperre(&h2.einstellungen);
        e.agent.aktiv_setzen(&id2)?;
        einstellungen::speichern(&h2.pfade, &e)
    })
    .await?;
    vergiss_fehler(&h);
    nach_aenderung(&app, &a);
    Ok(liste(&h, &a))
}

fn args_pruefen(args: &[String]) -> Result<(), Fehler> {
    let schlecht = args.len() > 32 || args.iter().any(|a| a.chars().count() > 512 || a.chars().any(char::is_control) || a.contains("{tresor:"));
    if schlecht {
        return Err(Fehler::LokalerRunnerStartetNicht { grund: "die Argumente sind unzulässig (höchstens 32, je 512 Zeichen, keine Steuerzeichen, keine Tresor-Verweise: das Token geht nur über die Umgebung)".into() });
    }
    Ok(())
}

pub(super) fn lokaler_runner_einstellen_intern(app: &AppHandle, h: &Huelle, a: &AgentZustand, neu: LokalKonfig) -> Result<Value, Meldung> {
    let programm = neu.programm.trim().to_string();
    if !programm.is_empty() && !std::path::Path::new(&programm).is_absolute() {
        return Err(m(Fehler::LokalerRunnerStartetNicht { grund: "der Pfad des Programms muss absolut sein".into() }));
    }
    args_pruefen(&neu.args).map_err(m)?;
    let war_aktiv_lokal;
    {
        let mut e = sperre(&h.einstellungen);
        e.agent.runner_uebernehmen();
        war_aktiv_lokal = e.agent.aktiver().map(|r| r.art == Art::Lokal).unwrap_or(false);
        e.agent.lokal = LokalKonfig { programm: programm.clone(), args: neu.args };
        if programm.is_empty() {
            let _ = e.agent.runner_entfernen(LOKAL_ID);
        } else if e.agent.runner_finden(LOKAL_ID).is_none() {
            e.agent.runner_setzen(RunnerEintrag::lokal());
        }
        einstellungen::speichern(&h.pfade, &e).map_err(m)?;
    }
    if programm.is_empty() {
        a.lokal.stoppen();
        if war_aktiv_lokal {
            nach_aenderung(app, a);
        }
    }
    Ok(liste(h, a))
}

/// Trägt das Programm des lokalen Runners ein (absoluter Pfad, Argumente-Vorlage mit `{port}` und `{ordner}`) und legt den Eintrag „Dieser Rechner“ an.
/// Ein leerer Pfad entfernt den lokalen Runner.
#[tauri::command]
pub fn lokaler_runner_einstellen(app: AppHandle, h: H<'_>, a: A<'_>, programm: String, args: Vec<String>) -> Result<Value, Meldung> {
    lokaler_runner_einstellen_intern(&app, &h, &a, LokalKonfig { programm, args })
}

fn status_json(h: &Huelle, a: &AgentZustand) -> Value {
    let (stand, meldung) = a.lokal.stand();
    let k = sperre(&h.einstellungen).agent.lokal.clone();
    json!({
        "stand": if stand.is_empty() { "aus" } else { stand },
        "meldung": meldung,
        "programm": k.programm,
        "args": k.args,
        "fehler": stand == FEHLER,
    })
}

#[tauri::command]
pub fn lokaler_runner_status(h: H<'_>, a: A<'_>) -> Value {
    status_json(&h, &a)
}

/// Startet den lokalen Runner (ohne den aktiven Runner zu wechseln).
#[tauri::command]
pub async fn lokaler_runner_starten(h: H<'_>, a: A<'_>) -> Result<Value, Meldung> {
    let (h, a): (Arc<Huelle>, Arc<AgentZustand>) = (h.inner().clone(), a.inner().clone());
    let (h2, a2) = (h.clone(), a.clone());
    blockierend(move || a2.lokal.starten(&h2, start_wurzeln(&h2))).await?;
    Ok(status_json(&h, &a))
}

#[tauri::command]
pub async fn lokaler_runner_stoppen(app: AppHandle, h: H<'_>, a: A<'_>) -> Result<Value, Meldung> {
    let (h, a): (Arc<Huelle>, Arc<AgentZustand>) = (h.inner().clone(), a.inner().clone());
    let a2 = a.clone();
    blockierend(move || {
        a2.lokal.stoppen();
        Ok(())
    })
    .await?;
    if sperre(&h.einstellungen).agent.aktiver().is_some_and(|r| r.art == Art::Lokal) {
        nach_aenderung(&app, &a);
    }
    Ok(status_json(&h, &a))
}

/// Der aktive Runner (Kennung, Art); für Ordnerwahl und zuletzt benutzte Ordner.
fn aktiv(h: &Huelle) -> Result<RunnerEintrag, Meldung> {
    let mut e = sperre(&h.einstellungen).agent.clone();
    e.runner_uebernehmen();
    e.aktiver().cloned().ok_or_else(|| m(Fehler::RunnerNichtEingerichtet))
}

/// Systemdialog „Ordner wählen“ für den lokalen Runner (nur Ordner). Der gewählte Pfad wird dem laufenden lokalen Runner als erlaubte Wurzel
/// gemeldet und unter den zuletzt benutzten Ordnern gemerkt. `null`, wenn der Nutzer abbricht.
/// Prüfbau (nur Debug mit FYOS_SHELL_AGENT_E2E=1): `FYOS_SHELL_E2E_ORDNER` ersetzt den Dialog.
#[tauri::command]
pub async fn ordner_waehlen(app: AppHandle, h: H<'_>, a: A<'_>) -> Result<Value, Meldung> {
    let r = aktiv(&h)?;
    if r.art != Art::Lokal {
        return Err(m(Fehler::OrdnerUnbrauchbar { grund: "der Systemdialog gilt nur für den lokalen Runner; bei entfernten Runnern wählt man aus der Ordnerliste des Runners".into() }));
    }
    let start = sperre(&h.einstellungen).agent.ordner_zuletzt(LOKAL_ID).first().cloned();
    let (h, a): (Arc<Huelle>, Arc<AgentZustand>) = (h.inner().clone(), a.inner().clone());
    let gewaehlt: Option<String> = {
        let app2 = app.clone();
        blockierend(move || {
            #[cfg(debug_assertions)]
            if std::env::var("FYOS_SHELL_AGENT_E2E").as_deref() == Ok("1") {
                if let Some(p) = std::env::var_os("FYOS_SHELL_E2E_ORDNER").filter(|p| !p.is_empty()) {
                    return Ok(Some(p.to_string_lossy().into_owned()));
                }
            }
            use tauri_plugin_dialog::DialogExt;
            let mut dialog = app2.dialog().file().set_title("Arbeitsordner wählen");
            if let Some(s) = start.filter(|s| std::path::Path::new(s).is_dir()) {
                dialog = dialog.set_directory(s);
            }
            match dialog.blocking_pick_folder() {
                None => Ok(None),
                Some(p) => {
                    let pfad = p.into_path().map_err(|e| Fehler::OrdnerUnbrauchbar { grund: e.to_string() })?;
                    Ok(Some(pfad.display().to_string()))
                }
            }
        })
        .await?
    };
    let Some(pfad) = gewaehlt else { return Ok(Value::Null) };
    let pfad = ordner_pruefen(&pfad).map_err(m)?;
    if !std::path::Path::new(&pfad).is_dir() {
        return Err(m(Fehler::OrdnerNichtGefunden));
    }
    let (h2, a2, p2) = (h.clone(), a.clone(), pfad.clone());
    blockierend(move || {
        // läuft der lokale Runner nicht (mehr), startet ihn die Wahl nicht heimlich: der Nutzer sieht den Fehler
        a2.lokal.wurzel_erlauben(&p2)?;
        let mut e = sperre(&h2.einstellungen);
        e.agent.ordner_merken(LOKAL_ID, &p2)?;
        einstellungen::speichern(&h2.pfade, &e)
    })
    .await?;
    Ok(json!({"pfad": pfad, "name": ordner_name(&pfad)}))
}

/// Zuletzt benutzte Ordner des aktiven Runners (neueste zuerst).
#[tauri::command]
pub fn ordner_zuletzt(h: H<'_>) -> Result<Value, Meldung> {
    let r = aktiv(&h)?;
    let liste = sperre(&h.einstellungen).agent.ordner_zuletzt(&r.id);
    Ok(json!({"runner": r.id, "ordner": liste.iter().map(|p| json!({"pfad": p, "name": ordner_name(p)})).collect::<Vec<_>>()}))
}

/// Merkt einen Ordner (nach erfolgreich angelegter Sitzung) für den aktiven Runner.
#[tauri::command]
pub fn ordner_merken(h: H<'_>, pfad: String) -> Result<Value, Meldung> {
    let r = aktiv(&h)?;
    {
        let mut e = sperre(&h.einstellungen);
        e.agent.ordner_merken(&r.id, &pfad).map_err(m)?;
        einstellungen::speichern(&h.pfade, &e).map_err(m)?;
    }
    ordner_zuletzt(h)
}
