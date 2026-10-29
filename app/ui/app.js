// Oberfläche der Hülle (D0): zeigt Version, Seite, Studio-Zustand und die Update-Knöpfe.
// Alles Fachliche steht in Rust (shell-core). Fehler kommen als { code, ursache, abhilfe, details } und werden unverändert gezeigt.
"use strict";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);

let letzteMeldung = null;

function zeigeMeldung(m) {
  letzteMeldung = m || null;
  $("meldung").hidden = !m;
  if (!m) return;
  $("meldung-kopf").textContent = "Das hat nicht geklappt";
  $("meldung-ursache").textContent = m.ursache;
  $("meldung-abhilfe").textContent = "Abhilfe: " + m.abhilfe;
  $("meldung-code").textContent = m.code + (m.details ? " · " + m.details : "");
}

function zeigeErfolg(text) {
  $("erfolg").hidden = !text;
  $("erfolg").textContent = text || "";
}

async function aufruf(befehl, args) {
  zeigeMeldung(null);
  try {
    return await invoke(befehl, args);
  } catch (m) {
    zeigeMeldung(typeof m === "object" ? m : { code: "UNBEKANNT", ursache: String(m), abhilfe: "Anwendung neu starten." });
    return undefined;
  }
}

function begleiterText(b) {
  switch (b.zustand) {
    case "startet": return "Studio-Server startet …";
    case "laeuft": return "Studio-Server läuft.";
    case "fehler": return "Studio-Server: " + b.meldung.ursache;
    default: return "Kein Hilfsprogramm eingestellt (Studio muss unter der Adresse oben erreichbar sein).";
  }
}

// Studio-Zeile: Zustand des Servers, woher er kommt (Bündel = mit der App geliefert) und Plugins des Nutzers
function studioZeile(i) {
  let t = begleiterText(i.begleiter);
  if (i.begleiter_quelle === "Bündel" && i.buendel) t += ` Mitgeliefert: Studio ${i.buendel[1]}, Python ${i.buendel[0]}.`;
  if (i.studio_plugins && i.studio_plugins.length) t += ` ${i.studio_plugins.length} Plugin-Einträge des Nutzers gefunden (werden nicht verändert).`;
  return t;
}

let letzteInfo = null;

function groesse(b) {
  return b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.ceil(b / 1024)) + " KB";
}

// Übernahme aus dem bestehenden Studio: der Knopf erscheint nur, wenn es ein altes Datenverzeichnis gibt und das neue Studio noch leer ist.
// Danach bleibt das Ergebnis stehen (Anzahl, Größe, Übersprungenes, Hinweise), ohne dass der Knopf noch einmal angeboten wird.
function uebernahmeZeigen(u) {
  const zeigen = !!u && u.profil_passt && u.stand === "moeglich";
  if (!$("uebernahme-ergebnis").hidden) { $("uebernahme").hidden = false; $("uebernahme-los").hidden = true; return; }
  $("uebernahme").hidden = !zeigen;
  if (!zeigen) return;
  $("uebernahme-los").hidden = false;
  $("uebernahme-text").textContent = `Gefunden: ${u.ort}. Kopiert ${u.dateien} Dateien (${groesse(u.bytes)}) Chats und Einstellungen in die App; das alte Studio wird nicht verändert, nichts wird überschrieben.`;
}

function uebernahmeErgebnis(e) {
  const zeilen = [`Kopiert: ${e.kopiert} Dateien (${groesse(e.kopiert_bytes)}) aus ${e.ort}.`];
  if (e.uebersprungen.length) zeilen.push(`Übersprungen (schon vorhanden): ${e.uebersprungen.join(", ")}`);
  const aus = e.ausgelassen.map((a) => `${a.pfad} (${a.grund})`);
  if (aus.length) zeilen.push(`Nicht kopiert: ${aus.join("; ")}`);
  if (e.verlinkt.length) zeilen.push(`Verknüpfungen nicht verfolgt: ${e.verlinkt.join(", ")}`);
  for (const f of e.fehlgeschlagen) zeilen.push(`Fehlgeschlagen: ${f.pfad}: ${f.grund}`);
  for (const h of e.hinweise) zeilen.push(`Hinweis: ${h}`);
  for (const b of e.befunde) zeilen.push(`Befund: ${b}. Die Datei wurde unverändert übernommen und bleibt eine Studio-Datei; die Hülle speichert davon nichts.`);
  if (e.neustart) zeilen.push("Der Studio-Server wurde neu gestartet und liest jetzt die übernommenen Daten.");
  $("uebernahme-ergebnis").textContent = zeilen.join("\n");
  $("uebernahme-ergebnis").hidden = false;
}

$("uebernahme-los").addEventListener("click", async () => {
  $("uebernahme-los").disabled = true;
  $("uebernahme-text").textContent = "Kopiere …";
  const e = await aufruf("studio_uebernehmen", { trocken: false });
  $("uebernahme-los").disabled = false;
  if (!e) { $("uebernahme-text").textContent = "Übernahme nicht abgeschlossen."; return; } // die Meldung steht oben
  uebernahmeErgebnis(e);
  $("uebernahme-text").textContent = "Übernahme abgeschlossen.";
  $("uebernahme-los").hidden = true;
  await laden();
  if (e.meldung) zeigeMeldung(e.meldung);
});

// Profil Agent: Runner-Liste, entfernte Runner (Token nur in den Tresor) und lokaler Runner: ui/agent-einstellungen.js
const leise = (befehl, args) => invoke(befehl, args).catch(() => undefined);
async function agentLaden() {
  await window.FyosAgentEinstellungen.laden(aufruf, letzteInfo);
}
window.FyosAgentEinstellungen.start(aufruf, () => letzteInfo, leise);

async function laden() {
  const i = await aufruf("info");
  if (!i) return;
  letzteInfo = i;
  document.title = i.name;
  $("name").textContent = i.name;
  $("kopf").textContent = `Version ${i.version} · ${i.os} ${i.arch} · Profil ${i.profil}`;
  $("start-url").textContent = i.start_url;
  $("url-eingabe").value = i.start_url;
  $("studio").hidden = i.profil !== "studio";
  // Profil Agent: Runner-Verbindung statt einer Seite im Inhaltsfenster
  $("agent").hidden = i.profil !== "agent";
  $("seite").hidden = i.profil === "agent";
  if (i.profil === "agent") await agentLaden();
  $("studio-text").textContent = studioZeile(i);
  uebernahmeZeigen(i.uebernahme);
  $("autostart").checked = !!i.autostart;
  $("zurueck").hidden = !i.vorherige;
  $("zurueck").textContent = i.vorherige ? `Zurück zu Version ${i.vorherige}` : "";
  $("fuss").textContent = `Daten: ${i.daten}`;
  if (i.ausgang) {
    if (i.ausgang.ok) zeigeErfolg(i.ausgang.text);
    else zeigeMeldung(i.ausgang.meldung);
  } else if (i.updater) {
    zeigeMeldung(i.updater);
  } else if (i.warnungen.length) {
    zeigeMeldung(i.warnungen[0]);
  }
  // Der Selbsttest wartet auf dieses Zeichen: die Seite hat gezeichnet und der Rust-Befehl hat geantwortet.
  invoke("seite_bereit", { zeichnet: document.body.innerText.length > 0, version: i.version });
}

$("oeffnen").addEventListener("click", () => aufruf("inhalt_oeffnen"));

// Fehlerbericht: Datei auf den Schreibtisch, mit der gerade sichtbaren Meldung; die Meldung bleibt danach stehen
async function berichtSpeichern() {
  const gesehen = letzteMeldung;
  const pfad = await invoke("bericht_speichern", { meldung: gesehen }).catch((m) => { zeigeMeldung(m); return null; });
  if (pfad) {
    zeigeMeldung(gesehen);
    zeigeErfolg("Bericht gespeichert: " + pfad + " (ohne Passwörter; es wurde nichts hochgeladen).");
  }
}
$("bericht").addEventListener("click", berichtSpeichern);
$("bericht-fuss").addEventListener("click", berichtSpeichern);

// Start bei der Anmeldung (Opt-in)
$("autostart").addEventListener("change", async () => {
  const gewollt = $("autostart").checked;
  const ok = await aufruf("autostart_setzen", { an: gewollt });
  if (ok === undefined) $("autostart").checked = !gewollt; // gescheitert: Anzeige zurück, die Meldung steht oben
});

// Geheimnisse: nur ablegen, löschen, prüfen; der Wert kommt nie zurück
function geheimnisName() { return $("g-name").value.trim(); }
$("g-speichern").addEventListener("click", async () => {
  const ok = await aufruf("geheimnis_setzen", { name: geheimnisName(), wert: $("g-wert").value });
  if (ok !== undefined) { $("g-wert").value = ""; $("g-text").textContent = `„${geheimnisName()}“ liegt im Tresor.`; }
});
$("g-loeschen").addEventListener("click", async () => {
  const ok = await aufruf("geheimnis_loeschen", { name: geheimnisName() });
  if (ok !== undefined) $("g-text").textContent = `„${geheimnisName()}“ ist gelöscht.`;
});
$("g-pruefen").addEventListener("click", async () => {
  const ok = await aufruf("tresor_pruefen");
  if (ok !== undefined) {
    const name = geheimnisName();
    $("g-text").textContent = name ? ((await aufruf("geheimnis_vorhanden", { name })) ? `Tresor bereit; „${name}“ ist vorhanden.` : `Tresor bereit; „${name}“ ist nicht vorhanden.`) : "Tresor bereit.";
  }
});

$("url-speichern").addEventListener("click", async () => {
  await aufruf("einstellung_setzen", { schluessel: "start_url", wert: $("url-eingabe").value });
  await laden();
});

$("studio-pruefen").addEventListener("click", async () => {
  const z = await aufruf("studio_pruefen");
  if (z) $("studio-text").textContent = `${z.app} ${z.version}: Engine ${z.engine}, ${z.modelle} Modelle`;
});

$("studio-neustart").addEventListener("click", async () => {
  $("studio-text").textContent = "Studio-Server startet neu …";
  await aufruf("studio_neustart");
  await laden();
});

let angebot = null;

async function suchen() {
  $("update-text").textContent = "Suche …";
  $("update-einspielen").hidden = true;
  const r = await aufruf("update_pruefen");
  if (!r) { $("update-text").textContent = "Die Suche ist fehlgeschlagen (siehe oben)."; return; }
  if (r.stand === "aktuell") {
    $("update-text").textContent = "Diese Version ist aktuell.";
  } else {
    angebot = r;
    $("update-text").textContent = `Version ${r.version} ist verfügbar.` + (r.notizen ? " " + r.notizen : "");
    $("update-einspielen").hidden = false;
  }
}

async function einspielen(befehl, text) {
  $("update-text").textContent = text;
  for (const id of ["update-pruefen", "update-einspielen", "zurueck"]) $(id).disabled = true;
  const r = await aufruf(befehl);
  for (const id of ["update-pruefen", "update-einspielen", "zurueck"]) $(id).disabled = false;
  if (r) $("update-text").textContent = `Version ${r.version} ist eingespielt. Die Anwendung startet neu …`;
  else $("update-text").textContent = "Die Installation ist fehlgeschlagen; die bisherige Version läuft unverändert weiter.";
}

$("update-pruefen").addEventListener("click", suchen);
$("update-einspielen").addEventListener("click", () => einspielen("update_einspielen", "Lade und prüfe Version " + (angebot ? angebot.version : "") + " …"));
$("zurueck").addEventListener("click", () => einspielen("update_zurueck", "Gehe zurück zur Vorversion …"));

listen("meldung", (e) => zeigeMeldung(e.payload));
listen("tray-update", suchen);

// Zustand des Begleiters regelmäßig nachziehen (Start, unerwartetes Ende)
setInterval(async () => {
  if (!letzteInfo || letzteInfo.profil !== "studio") return;
  try {
    const i = await invoke("info");
    $("studio-text").textContent = studioZeile(i);
  } catch (_) { /* nächste Runde */ }
}, 3000);

laden();
