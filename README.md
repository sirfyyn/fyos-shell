# fyos-shell

One [Tauri 2](https://v2.tauri.app/) shell, three apps: **FLE Studio**, **FYOS Agent** and **FYOS OS** (macOS, Windows, Linux).
Each app is a *profile* of the same code (`app/profile/<name>.conf.json`): its own bundle id, name, deep-link scheme, update address
and update key. The shell gives every profile the same things: a single instance, a tray icon, deep links (`fle://` / `fyos://`),
a supervised helper process, a self-updater with signature check and a "go back" button, secrets in the operating system's keychain (never in a file),
an opt-in start at login, a "save report" button that writes a redacted error report to disk (nothing is uploaded), and error messages that always say
**what happened and what you can do about it**.

Status: first working slice ("D0/D1"). It is a shell and an update loop, not yet the finished apps. Licence: [Apache-2.0](LICENSE).

## What is in here

| Path | What |
|---|---|
| `crates/shell-core` | The core without any window code, fully unit-tested: error catalogue, settings that survive updates (and refuse plain-text secrets), version history (for "go back"), deep-link validation, helper-process supervision, process-tree handling (Unix process group, Windows job object), update decisions, error report with redaction, login-start entries |
| `crates/shell-tresor` | System keychain behind one interface (`keyring`: macOS Keychain, Windows Credential Manager, Linux Secret Service); settings refer to secrets as `{tresor:NAME}` |
| `app` | The Tauri application (window, tray, single instance, updater wiring, commands); `app/profile/*.conf.json` are the three profiles; `app/ui` is the small local page |
| `tools` | Build script, test servers, end-to-end update test, Linux container checks, pixel probe, checksums, this repo's own "is it safe to publish" scan (`oeffentlich_pruefen.py`) |
| `python-buendel.lock.json`, `tools/buendel_bauen.py` | The *studio* profile ships its own Python and FLE Studio (python-build-standalone 3.11, SHA-256 pinned per system; Studio pinned by commit and content hash; no dependencies). `python3 tools/bauen.py studio --mit-python` builds it into the package; user data and plugin packages stay outside (`<data>/studio-home`, `<data>/studio-plugins`) |
| `studio-patch` | A small proposed patch for FLE Studio ("updates come through the app" when `FLE_STUDIO_MANAGED_BY` is set); not applied upstream |
| `docker` | Linux build container and a MinGW container for a Windows compile check |
| `.github/workflows` | Build and `--selbsttest` on Ubuntu, macOS and Windows (unsigned); a manual release job with SHA-256 checksums |

## Build and test

Requirements: Rust (stable), Node 22, Python 3.9+. On Linux also `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libdbus-1-dev`.
The Tauri CLI is installed locally (`npm ci`), nothing is installed globally.

```sh
npm ci
cargo test --workspace                                  # Rust tests
python3 -m unittest discover -s tools -p "test_*.py"    # tests of the tools (Unix)
python3 tools/bauen.py studio --debug --ohne-paket      # build the studio profile (also: agent, os)
python3 tools/selbsttest_ci.py target/debug/fyos-shell  # start, helper process, window, command round trip
```

`fyos-shell --selbsttest | --info | --aktualisieren | --zurueck` run without a visible window and print one JSON line
(exit code 0 = good). They are what scripts and CI use; the buttons in the window call the same code.

### The update loop

`python3 tools/e2e_update.py` (macOS) builds version 0.0.1 and 0.0.2, signs them with a throw-away key, serves them from a local
test server and checks: update, settings/data/plugins untouched, "go back", tampered package, wrong key, manifest without signature,
missing manifest, server down, **no downgrade and no same-version install even with a valid signature**, a stranger's server on the helper's port.
On Linux the same loop runs as an AppImage under Xvfb (`docker/bauen-linux.sh schleife`, `pixel`).

## A local runner for the agent profile (contract, version 1)

The shell is public and ships **no** runner. In the *agent* profile you can point it at any program on your own machine
(*Settings → Local runner*: absolute path, plus an argument template with `{port}` and `{ordner}`, the folder). The shell starts that
program as a child in its own process group, waits up to 30 s for it to answer, restarts it after an unexpected exit
(after 1, 2, 4, 8, 15, then 30 s; the staircase starts over once it ran for 60 s) and stops it when the app quits.
A new port and a new token (256 bit) are made for every start; they live only in memory and in the program's environment.

A program fits if it does this:

1. **Read its environment.** `FYOS_RUNNER_PORT` (TCP port), `FYOS_RUNNER_TOKEN` (64 hex characters, never passed as an argument),
   `FYOS_RUNNER_HOST` (always `127.0.0.1`), `FYOS_RUNNER_DATEN` (a folder of its own for state, below the shell's data folder),
   `FYOS_RUNNER_ORDNER_ERLAUBT` (allowed root folders, absolute paths, separated by `:`, on Windows by `;`; may be empty).
2. **Listen only on `127.0.0.1:<FYOS_RUNNER_PORT>`** and answer `401` to every request without `Authorization: Bearer <FYOS_RUNNER_TOKEN>`.
3. **`GET /api/health` → `200 {"ok": true, …}`** as soon as it is ready.
4. **Speak the interface of a remote runner**, which is what the page uses: `/api/gespraeche`, `/api/gespraech/<id>` (with `/ansicht`, `/ereignisse`),
   `/api/strom` (server-sent events), `/api/konfiguration`, `/api/modelle`, `/api/freigaben`, `/api/laeufe`, and
   `GET /api/ordner?pfad=<absolute, optional>` → `{wurzeln, pfad, eintraege: [{name, ordner: true}], erlaubt}`
   (outside the roots `403 {"fehler":"ausserhalb"}`, missing `404`). `POST /api/gespraeche` takes `ordner` (absolute, inside a root);
   the folder then shows up as `agent.cwd` of that conversation.
5. **`POST /api/ordner/erlauben {"pfad": "<absolute>"}` → `200 {"wurzeln": [...]}`** adds a folder the person picked in the system dialog
   to the roots until the process ends. Only the shell calls this.
6. **End cleanly within 8 s of SIGTERM.** After that the whole process group is killed. What it prints to stdout and stderr lands in
   `lokaler-runner.log` in the data folder.

Not covered by the shell: if the shell itself is killed with SIGKILL, the program keeps running (macOS has no "parent is gone" signal).
A program that keeps state on disk should therefore make sure only one copy of itself works on a data folder.

The source of the contract is `crates/shell-core/src/agent/lokal.rs`. `tools/lokaler_runner_test.py` is a neutral stand-in that fulfils it
(no agent, no model, no tools) and shows how little is needed; `tools/e2e_agent.py` runs the shell against it.
A full program for this contract is the local runner of FYOS Agent: a small start program (`runner/lokal/starten.mjs` there) translates
this contract for [FLE Durable](https://github.com/sirfyyn/fle-durable), the agent runtime behind `flelink code` in
[FLE Link](https://github.com/sirfyyn/flelink). It brings the agent, the tools and the approvals, and takes its model from FLE Link or from
any other OpenAI-compatible server.

## First start without code signing

The installers are **not signed or notarized** (no Apple developer account, no Windows certificate). *Updates* are signed (see [SECURITY.md](SECURITY.md)).

- **macOS:** right-click the app → *Open* → *Open*. Or *System Settings → Privacy & Security → Open Anyway*. Or in a terminal:
  `xattr -d com.apple.quarantine /Applications/<App>.app`.
- **Windows:** SmartScreen shows "Windows protected your PC" → *More info* → *Run anyway*. Windows 11 *Smart App Control* may block unsigned apps.
- **Linux:** `chmod +x <App>.AppImage`, then run it (or "Allow executing as program" in your file manager).

Verify a download against the `SHA256SUMS` file of the release: `python3 tools/pruefsummen.py --pruefen SHA256SUMS`.

## Auf Deutsch (Kurzfassung)

Eine Tauri-2-Hülle für drei Apps (FLE Studio, FYOS Agent, FYOS OS) auf macOS, Windows und Linux. Jede App ist ein Profil derselben Codebasis
(`app/profile/`). Die Hülle bringt Einzelinstanz, Tray, Deeplinks, Aufsicht über ein Hilfsprogramm, Selbstaktualisierung mit Signaturprüfung und
**Rückweg**, und Fehlermeldungen, die immer Ursache **und** Abhilfe nennen. Bauen und Testen: siehe oben (`npm ci`, `cargo test --workspace`,
`python3 tools/bauen.py <profil> --debug --ohne-paket`, `python3 tools/selbsttest_ci.py <Programm>`).

**Erststart ohne Signierung:** Die Installationspakete sind nicht signiert oder notarisiert.
macOS: Rechtsklick → „Öffnen“, oder *Datenschutz & Sicherheit → Trotzdem öffnen*, oder `xattr -d com.apple.quarantine /Applications/<App>.app`.
Windows: SmartScreen → „Weitere Informationen“ → „Trotzdem ausführen“. Linux: `chmod +x <App>.AppImage`. **Updates** sind signiert (Minisign, ein Schlüssel je Profil),
dazu Rollback-Schutz: eine ältere oder gleiche Version wird nie installiert, auch nicht mit gültiger Signatur; nur der ausdrückliche „Zurück“-Weg auf die gemerkte Vorversion.

**Lokaler Runner (Profil Agent):** Die Hülle enthält keinen Runner. Unter *Einstellungen → Lokaler Runner* lässt sich ein eigenes Programm eintragen;
was es können muss (Umgebung, nur `127.0.0.1`, Token, `/api/health`, Schnittstelle, sauberes Ende), steht oben im Abschnitt
„A local runner for the agent profile“. Ein fertiges Programm dafür ist der lokale Runner von FYOS Agent; er läuft auf FLE Durable, der Laufzeit hinter `flelink code` in FLE Link.

## Licence

Apache-2.0, see [LICENSE](LICENSE). FLE Studio itself (the Python server the *studio* profile can supervise) is a separate project under the MIT licence.
