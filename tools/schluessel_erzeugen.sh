#!/usr/bin/env bash
# Erzeugt für jedes Profil (studio, agent, os) ein eigenes Update-Schlüsselpaar.
#
#   tools/schluessel_erzeugen.sh [--trocken] [profil ...]
#
# - Der private Schlüssel und sein Passwort werden NUR im macOS-Schlüsselbund abgelegt
#   (Einträge fyos-shell-update-<profil>, Konten "schluessel" und "passwort"). Sie liegen nie im Repository und nach dem Lauf auch nicht mehr auf der Platte.
# - Der öffentliche Schlüssel wird nach app/profile/<profil>.pub geschrieben; er ist öffentlich und gehört ins Repository.
#   tools/bauen.py trägt ihn beim Bau in die Konfiguration des Profils ein.
# - Ein vorhandener Eintrag wird NIE überschrieben (ein neuer Schlüssel würde alle installierten Apps vom Update ausschließen).
# - --trocken erzeugt zur Probe Schlüssel in einem temporären Ordner, zeigt die öffentlichen Teile und löscht alles wieder;
#   der Schlüsselbund und das Repository bleiben unberührt.
#
# Danach: eine verschlüsselte Sicherung der Einträge anlegen (Schlüsselbund-Programm: Exportieren, oder `security find-generic-password -s
# fyos-shell-update-<profil> -a schluessel -w` in einen Passwortmanager). Geht ein Schlüssel verloren, können installierte Apps dieses Profils nie wieder aktualisiert werden.
set -euo pipefail

HIER="$(cd "$(dirname "$0")/.." && pwd)"
TAURI="$HIER/node_modules/.bin/tauri"
TROCKEN=0
PROFILE=()

for arg in "$@"; do
  case "$arg" in
    --trocken) TROCKEN=1 ;;
    studio|agent|os) PROFILE+=("$arg") ;;
    *) echo "Unbekanntes Argument: $arg (erlaubt: --trocken studio agent os)" >&2; exit 64 ;;
  esac
done
[ ${#PROFILE[@]} -gt 0 ] || PROFILE=(studio agent os)

[ -x "$TAURI" ] || { echo "Die lokale Tauri-CLI fehlt. Abhilfe: im Ordner apps/fyos-shell einmal 'npm install' ausführen." >&2; exit 1; }
if [ "$TROCKEN" -eq 0 ]; then
  command -v security >/dev/null || { echo "Das Programm 'security' (macOS-Schlüsselbund) fehlt. Dieses Skript läuft nur auf dem Mac." >&2; exit 1; }
fi

TMP="$(mktemp -d)"
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT

for profil in "${PROFILE[@]}"; do
  dienst="fyos-shell-update-$profil"
  pub="$HIER/app/profile/$profil.pub"
  if [ "$TROCKEN" -eq 0 ] && security find-generic-password -s "$dienst" -a schluessel >/dev/null 2>&1; then
    echo "[$profil] Eintrag $dienst existiert schon: nichts geändert."
    continue
  fi
  passwort="$(openssl rand -base64 24)"
  # Hinweis: `signer generate` liest das Passwort nur aus -p (die Umgebung wird ignoriert, gemessen), und `security` nimmt Werte
  # nur als Argument (-w). Beides steht daher für die Dauer des Aufrufs in der Prozessliste desselben Benutzers.
  "$TAURI" signer generate --ci -p "$passwort" -w "$TMP/$profil.key" >/dev/null
  if [ "$TROCKEN" -eq 1 ]; then
    echo "[$profil] (Trockenlauf) öffentlicher Schlüssel:"
    cat "$TMP/$profil.key.pub"
    echo
    continue
  fi
  security add-generic-password -s "$dienst" -a schluessel -w "$(cat "$TMP/$profil.key")" -T "" -U >/dev/null
  security add-generic-password -s "$dienst" -a passwort -w "$passwort" -T "" -U >/dev/null
  cp "$TMP/$profil.key.pub" "$pub"
  echo "[$profil] Schlüsselbund-Eintrag $dienst angelegt; öffentlicher Schlüssel: $pub"
done
echo "Fertig. Öffentliche Schlüssel einchecken (git add apps/fyos-shell/app/profile/*.pub), Sicherung der privaten Schlüssel nicht vergessen."
