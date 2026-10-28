#!/usr/bin/env bash
# Linux-Bau der Hülle im Container `fyos-shell-bau`. Gedacht für einen Linux-Rechner mit Docker; schreibt nur unter $ARBEIT (Quelltext, Cargo-Ziel, npm).
#
#   bash bauen-linux.sh bild                 Abbild bauen (einmalig; liegt im Docker-Speicher, unter 8 GB)
#   bash bauen-linux.sh bauen [profil]       AppImage bauen (Debug) mit Testschlüsseln, siehe tools/linux_pruefen.py
#   bash bauen-linux.sh pruefen              Selbsttest unter Xvfb, mit und ohne WEBKIT_DISABLE_DMABUF_RENDERER=1
#   bash bauen-linux.sh schleife             Update-Schleife als AppImage (baut 0.0.1 und 0.0.2, Test-Server im Container)
#   bash bauen-linux.sh tresor               Tresor ohne Secret-Service-Dienst: Fehler mit Abhilfe
#   bash bauen-linux.sh pixel                Pixelprobe: Fenster unter Xvfb öffnen, xwd-Abzug prüfen
#
# Begrenzungen (Umgebung): FYOS_BAU_CPUSET (z. B. 28-31; leer = alle Kerne), FYOS_BAU_SPEICHER in GB (Vorgabe 20), FYOS_BAU_JOBS (Vorgabe 4),
# ARBEIT (Vorgabe ~/fyos-shell-bau). Der Bau läuft mit nice 19, ohne GPU (kein --gpus, CUDA_VISIBLE_DEVICES leer).
# Vorher den Quelltext nach $ARBEIT bringen:  rsync -a --exclude target --exclude node_modules ./ $ARBEIT/   (aus dem Wurzelordner der Hülle)
set -euo pipefail

ARBEIT="${ARBEIT:-$HOME/fyos-shell-bau}"
CPUSET="${FYOS_BAU_CPUSET:-}"
SPEICHER="${FYOS_BAU_SPEICHER:-20}"   # GB; bei knappem RAM kleiner wählen (z. B. 10)
JOBS="${FYOS_BAU_JOBS:-4}"
HIER="$(cd "$(dirname "$0")" && pwd)"

begrenzt() {
  if command -v systemd-run >/dev/null 2>&1; then
    systemd-run --user --scope -q -p MemoryMax=${SPEICHER}G -p MemorySwapMax=0 nice -n 19 "$@"
  else
    nice -n 19 "$@"
  fi
}

im_container() {
  mkdir -p "$ARBEIT/home" "$ARBEIT/cargo-home"
  begrenzt docker run --rm ${CPUSET:+--cpuset-cpus $CPUSET} --memory ${SPEICHER}g --memory-swap ${SPEICHER}g \
    --user "$(id -u):$(id -g)" \
    -e HOME=/work/home -e CARGO_HOME=/work/cargo-home -e CARGO_TARGET_DIR=/work/target-linux \
    -e CARGO_BUILD_JOBS=${JOBS} -e RUSTUP_TOOLCHAIN=stable -e CUDA_VISIBLE_DEVICES= \
    -e APPIMAGE_EXTRACT_AND_RUN=1 -e NO_STRIP=true \
    -v "$ARBEIT:/work" -w /work fyos-shell-bau "$@"
}

case "${1:-}" in
  bild)
    begrenzt docker build ${CPUSET:+--cpuset-cpus $CPUSET} --memory ${SPEICHER}g -t fyos-shell-bau -f "$HIER/Dockerfile.linux" "$HIER"
    ;;
  bauen)
    im_container bash -c "test -x node_modules/.bin/tauri || npm install --no-audit --no-fund; python3 tools/linux_pruefen.py bauen ${2:-studio}"
    ;;
  pruefen)
    im_container python3 tools/linux_pruefen.py pruefen
    ;;
  schleife)
    im_container bash -c "test -x node_modules/.bin/tauri || npm install --no-audit --no-fund; python3 tools/linux_pruefen.py schleife"
    ;;
  tresor)
    im_container python3 tools/linux_pruefen.py tresor
    ;;
  pixel)
    im_container python3 tools/linux_pruefen.py pixel
    ;;
  windows-bild)
    begrenzt docker build ${CPUSET:+--cpuset-cpus $CPUSET} --memory ${SPEICHER}g -t fyos-shell-bau-windows -f "$HIER/Dockerfile.windows-check" "$HIER"
    ;;
  windows-check)
    # Übersetzungsprobe für Windows: Kern mit Tests, dann die ganze Anwendung. Das Std-Paket des Ziels landet in $ARBEIT/rustup-home.
    mkdir -p "$ARBEIT/home" "$ARBEIT/cargo-home" "$ARBEIT/rustup-home"
    begrenzt docker run --rm ${CPUSET:+--cpuset-cpus $CPUSET} --memory ${SPEICHER}g --memory-swap ${SPEICHER}g \
      --user "$(id -u):$(id -g)" \
      -e HOME=/work/home -e CARGO_HOME=/work/cargo-home -e RUSTUP_HOME=/work/rustup-home -e CARGO_TARGET_DIR=/work/target-windows \
      -e CARGO_BUILD_JOBS=${JOBS} -e CUDA_VISIBLE_DEVICES= \
      -v "$ARBEIT:/work" -w /work fyos-shell-bau-windows \
      bash -c "export PATH=/usr/local/cargo/bin:\$PATH; rustup toolchain install stable --profile minimal -t x86_64-pc-windows-gnu && cargo check --target x86_64-pc-windows-gnu -p shell-core --tests && cargo check --target x86_64-pc-windows-gnu -p fyos-shell"
    ;;
  *)
    sed -n "2,12p" "$0"
    exit 64
    ;;
esac
