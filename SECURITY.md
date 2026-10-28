# Security

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** (repository → *Security* → *Report a vulnerability*). Do not open a public issue for a vulnerability.
We aim to answer within a few days.

## What protects updates

- **Every update is signed (Minisign, via the Tauri updater).** The public key is built into the app; a package whose signature does not match is never installed.
  The public keys are in `app/profile/<profile>.pub`.
- **One key per profile** (`studio`, `agent`, `os`). A package signed with another profile's key is rejected, and a leak of one key does not endanger the other apps.
- **`requireSignedVersion` is on:** the signature carries the version it was made for. A manifest that announces a different version than was signed is rejected.
- **No downgrade through the update server.** The normal update path only installs a version that is strictly newer than the installed one; an older or equal version
  with a valid signature is ignored (tested end to end). The only way down is the explicit "go back" action, and it accepts exactly the version remembered as the previous one.
- **https only** for the update address in release builds (the updater refuses plain http there). The local test server used by the tests needs a debug build.
- **Helper process:** the app starts its helper on a free local port with a random 128-bit identifier and only treats it as healthy if it echoes that identifier
  (header `X-FYOS-Kennung`). A stranger's server on the same port is reported as `PORT_BELEGT` and not used.
- **Secrets stay out of files.** Tokens and passwords live in the operating system's keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service). The settings file only holds
  references such as `{tresor:hf-token}`, which are resolved when the helper process starts; the settings code refuses to save a plain-text value under names like `token` or `password`.
  Without a keychain service the app says so (with a remedy per system) and does **not** fall back to a file. The "save report" function redacts tokens, bearer headers, passwords in URLs, long hex keys and user folders, and never uploads anything.
- **Windows helper process:** the helper runs in a job object that ends it when the app ends, even when the app crashes (not yet exercised on a Windows machine).

## Key management (no private details)

- Private update keys are generated with `tools/schluessel_erzeugen.sh` and stored **only in the maintainers' operating-system keychain** (plus an encrypted backup).
  They are never committed, never printed, and never placed in a plain file in the repository. CI builds receive only the key of the profile they build, as a repository secret.
- If a key is lost, installed apps of that profile can no longer be updated and users must reinstall. If a key is leaked, the intended procedure (not yet rehearsed)
  is to ship one more build signed with the old key that carries a new public key, and to say so in the release notes.

## Known limits

- Installers are **not code-signed or notarized**. macOS Gatekeeper and Windows SmartScreen will warn on first start (see the README). Verify downloads with the `SHA256SUMS` of the release.
- The self-test proves that the window loads and JavaScript runs; it is not a security test.
- The content window shows remote pages (e.g. a web desktop) and has **no access** to the app's commands (only the local main window has capabilities).
