// Profil Agent, Einstellungen: Liste der Runner, Formular für entfernte Runner, lokaler Runner.
// Das Token geht nur in den Tresor hinein; der Wert kommt nie zurück. Die Liste nennt nur „hat ein Token“.
"use strict";

(function () {
  const $ = (id) => document.getElementById(id);
  let bearbeiteId = null; // null = neuer Runner
  let liste = null;

  const STAND = { aus: "gestoppt", startet: "startet …", laeuft: "läuft", neustart: "startet neu …", fehler: "Fehler" };

  function leere(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function knopf(text, beiKlick) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.addEventListener("click", beiKlick);
    return b;
  }

  function formularLeeren() {
    bearbeiteId = null;
    $("r-name").value = "";
    $("a-adresse").value = "";
    $("a-token").value = "";
    $("r-form-titel").textContent = "Runner hinzufügen";
    $("a-neu").hidden = true;
  }

  function bearbeiten(r) {
    bearbeiteId = r.id;
    $("r-name").value = r.name || "";
    $("a-adresse").value = r.adresse || "";
    $("a-token").value = "";
    $("r-form-titel").textContent = `Runner „${r.name}“ ändern`;
    $("a-neu").hidden = false;
    $("a-hinweis").textContent = r.hat_token ? "Ein Token liegt im Tresor. Leer lassen, um es zu behalten." : "Zu diesem Runner ist kein Token gespeichert.";
  }

  function zeichneListe(v) {
    liste = v;
    const ul = $("r-liste");
    leere(ul);
    for (const r of v.runner || []) {
      const li = document.createElement("li");
      li.dataset.id = r.id;
      const t = document.createElement("span");
      t.className = "r-name";
      const art = r.art === "lokal" ? `lokal, ${STAND[r.status] || r.status}` : r.adresse || "ohne Adresse";
      t.textContent = `${r.name} (${art})${r.aktiv ? " · aktiv" : ""}`;
      li.appendChild(t);
      if (r.art === "entfernt") {
        li.appendChild(knopf("Ändern", () => bearbeiten(r)));
        li.appendChild(knopf("Prüfen", () => pruefen(r.id)));
      }
      if (r.art === "entfernt") li.appendChild(knopf("Entfernen", () => entfernen(r)));
      ul.appendChild(li);
    }
    if (!(v.runner || []).length) {
      const li = document.createElement("li");
      li.className = "leise";
      li.textContent = "Noch kein Runner eingetragen.";
      ul.appendChild(li);
    }
  }

  async function laden(aufruf, info) {
    const v = await aufruf("runner_liste");
    if (!v) return;
    zeichneListe(v);
    const st = await aufruf("lokaler_runner_status");
    if (st) {
      if (document.activeElement !== $("l-programm")) $("l-programm").value = st.programm || "";
      if (document.activeElement !== $("l-args")) $("l-args").value = (st.args || []).join(" ");
      const m = st.meldung ? ` ${st.meldung.ursache}` : "";
      $("l-text").textContent = st.programm ? `Lokaler Runner: ${STAND[st.stand] || st.stand}.${m}` : "Kein lokaler Runner eingetragen.";
    }
    const alt = v.alt;
    $("a-alt").hidden = !(alt && !(v.runner || []).length);
    if (alt) $("a-alt").textContent = `Aus der bisherigen Agent-App übernehmen (${alt.name})`;
  }

  let aufrufFn = null;

  async function pruefen(id) {
    $("a-text").textContent = "Prüfe …";
    const r = await aufrufFn("agent_verbindung_pruefen", { id: id || bearbeiteId, adresse: id ? null : $("a-adresse").value || null, token: id ? null : $("a-token").value || null });
    $("a-text").textContent = r ? `Verbindung steht${r.agent ? " (" + r.agent + ")" : ""}${r.geraet ? " auf " + r.geraet : ""}.` : "Keine Verbindung (siehe oben).";
  }

  async function entfernen(r) {
    const v = await aufrufFn("runner_entfernen", { id: r.id });
    if (!v) return;
    if (bearbeiteId === r.id) formularLeeren();
    zeichneListe(v);
    $("a-text").textContent = `„${r.name}“ ist entfernt.`;
  }

  window.FyosAgentEinstellungen = {
    /** Verdrahtet die Knöpfe; `aufruf` ist die Funktion von app.js (zeigt Fehler als Meldung), `info()` liefert die letzte Info. */
    start(aufruf, info, leise) {
      aufrufFn = aufruf;
      $("a-speichern").addEventListener("click", async () => {
        const v = await aufruf("runner_speichern", { id: bearbeiteId, name: $("r-name").value || null, adresse: $("a-adresse").value, token: $("a-token").value || null });
        if (!v) return;
        $("a-token").value = "";
        $("a-text").textContent = "Gespeichert. Das Token liegt im Tresor.";
        formularLeeren();
        zeichneListe(v);
      });
      $("a-pruefen").addEventListener("click", () => pruefen(null));
      $("a-neu").addEventListener("click", () => {
        formularLeeren();
        $("a-hinweis").textContent = "";
      });
      $("a-chat").addEventListener("click", () => aufruf("agent_chat_oeffnen"));
      $("a-alt").addEventListener("click", async () => {
        const r = await aufruf("agent_alt_uebernehmen");
        if (!r) return;
        $("a-text").textContent = r.token_uebernommen ? `Übernommen: ${r.name}. Adresse und Token der bisherigen App sind jetzt eingetragen (die alten Einträge bleiben).` : `Adresse von ${r.name} übernommen, aber in der bisherigen App war kein Token gespeichert: bitte das Token eintragen.`;
        await laden(aufruf, info());
      });
      $("l-speichern").addEventListener("click", async () => {
        const args = $("l-args").value.split(/\s+/).filter(Boolean);
        const v = await aufruf("lokaler_runner_einstellen", { programm: $("l-programm").value.trim(), args });
        if (!v) return;
        $("l-text").textContent = $("l-programm").value.trim() ? "Gespeichert. Zum Benutzen im Chat-Fenster „Dieser Rechner“ wählen oder hier starten." : "Der lokale Runner ist entfernt.";
        await laden(aufruf, info());
      });
      $("l-starten").addEventListener("click", async () => {
        $("l-text").textContent = "Starte …";
        const st = await aufruf("lokaler_runner_starten");
        if (!st) $("l-text").textContent = "Start fehlgeschlagen (siehe oben).";
        await laden(aufruf, info());
      });
      $("l-stoppen").addEventListener("click", async () => {
        await aufruf("lokaler_runner_stoppen");
        await laden(aufruf, info());
      });
      setInterval(() => {
        if (!$("agent").hidden && document.visibilityState === "visible") laden(leise, info());
      }, 4000);
    },
    laden,
    zeichneListe,
  };
})();
