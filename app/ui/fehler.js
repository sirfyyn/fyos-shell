// Fehlerseite des Profils OS: zeigt, warum der Server nicht erreichbar ist, und versucht es von allein erneut (Rücknahme macht die Hülle in Rust).
// Läuft nur als lokale Seite der Hülle; die Befehle sind nur diesem Fenster und nur für lokale Seiten erlaubt (capabilities/inhalt.json).
"use strict";

const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
let letzte = null;

function zeige(s) {
  $("adresse").textContent = s.adresse || "";
  if (s.meldung) {
    letzte = s.meldung;
    $("titel").textContent = "Keine Verbindung";
    $("meldung").hidden = false;
    $("meldung-ursache").textContent = s.meldung.ursache;
    $("meldung-abhilfe").textContent = "Abhilfe: " + s.meldung.abhilfe;
    $("meldung-code").textContent = s.meldung.code + (s.meldung.details ? " · " + s.meldung.details : "");
  }
  if (s.verbunden) {
    $("status").textContent = "Verbunden, die Seite wird geladen …";
  } else if (s.prueft) {
    $("status").textContent = "Prüfe die Verbindung …";
  } else if (s.meldung) {
    $("status").textContent = `Versuch ${s.versuch} gescheitert. Nächster Versuch in ${s.naechster_in_s} s.`;
  }
}

async function tick() {
  try {
    zeige(await invoke("os_stand"));
  } catch (e) {
    $("status").textContent = "Die Anwendung antwortet nicht: " + e;
  }
}

$("wieder").addEventListener("click", async () => {
  $("status").textContent = "Prüfe die Verbindung …";
  await invoke("os_wiederholen").catch(() => {});
  tick();
});

$("bericht").addEventListener("click", async () => {
  try {
    const pfad = await invoke("bericht_speichern", { meldung: letzte });
    $("erfolg").hidden = false;
    $("erfolg").textContent = "Bericht gespeichert: " + pfad + " (ohne Passwörter; es wurde nichts hochgeladen).";
  } catch (m) {
    $("erfolg").hidden = false;
    $("erfolg").textContent = (m && m.ursache) ? m.ursache + " " + m.abhilfe : String(m);
  }
});

tick();
setInterval(tick, 1000);
