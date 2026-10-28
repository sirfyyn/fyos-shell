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
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(BEFEHLE)),
    )
    .expect("tauri-build");
}
