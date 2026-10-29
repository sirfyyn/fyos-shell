// Die Befehle stehen im App-Manifest; nur das Hauptfenster (lokale Seite ui/index.html, capabilities/haupt.json)
// darf sie aufrufen. Das Inhaltsfenster (fremde oder lokale Test-Seite) bekommt keine Capability und damit keinen Zugriff.
const BEFEHLE: &[&str] = &[
    "info",
    "update_pruefen",
    "update_einspielen",
    "update_zurueck",
    "studio_pruefen",
    "studio_neustart",
    "inhalt_oeffnen",
    "einstellung_setzen",
    "seite_bereit",
    "bericht_speichern",
    "autostart_setzen",
    "tresor_pruefen",
    "geheimnis_setzen",
    "geheimnis_loeschen",
    "geheimnis_vorhanden",
    "studio_uebernehmen",
    "os_stand",
    "os_wiederholen",
    // Profil agent (Chat-Fenster `chat` und Einstellungen): capabilities/agent-chat.json und agent-haupt.json
    "runner_anfrage",
    "strom_oeffnen",
    "strom_schliessen",
    "agent_verbindung_pruefen",
    "runner_liste",
    "runner_speichern",
    "runner_entfernen",
    "runner_wechseln",
    "lokaler_runner_einstellen",
    "lokaler_runner_status",
    "lokaler_runner_starten",
    "lokaler_runner_stoppen",
    "ordner_waehlen",
    "ordner_zuletzt",
    "ordner_merken",
    "agent_alt_uebernehmen",
    "agent_chat_oeffnen",
    "ziel_info",
    "ruhe_setzen",
    "zustand_melden",
    "os_benachrichtigen",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(BEFEHLE)),
    )
    .expect("tauri-build");
}
