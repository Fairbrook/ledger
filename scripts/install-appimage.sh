#!/bin/sh
# Install (or remove) the ledger AppImage for the current user, without extra tools
# like AppImageLauncher: copies it to ~/.local/share/ledger and adds a launcher entry.
#
#   sh scripts/install-appimage.sh [path/to/ledger.AppImage]
#   sh scripts/install-appimage.sh --uninstall
set -eu

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APP_DIR="$DATA_HOME/ledger"
DESKTOP_FILE="$DATA_HOME/applications/ledger.desktop"
ICON_FILE="$DATA_HOME/icons/hicolor/512x512/apps/ledger.png"

refresh() {
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DATA_HOME/applications" >/dev/null 2>&1 || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q "$DATA_HOME/icons/hicolor" >/dev/null 2>&1 || true
}

if [ "${1:-}" = "--uninstall" ]; then
  rm -rf "$APP_DIR" "$DESKTOP_FILE" "$ICON_FILE"
  refresh
  echo "ledger removed (your data in ~/.config/ledger was kept)."
  exit 0
fi

SRC="${1:-}"
if [ -z "$SRC" ]; then
  SRC=$(ls -t dist/*.AppImage 2>/dev/null | head -n 1 || true)
fi
if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
  echo "No AppImage found. Build one first with: npm run dist:linux" >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$APP_DIR" "$(dirname "$DESKTOP_FILE")" "$(dirname "$ICON_FILE")"
cp "$SRC" "$APP_DIR/ledger.AppImage"
chmod +x "$APP_DIR/ledger.AppImage"
cp "$SCRIPT_DIR/../build/icon.png" "$ICON_FILE"

cat > "$DESKTOP_FILE" <<DESKTOP
[Desktop Entry]
Type=Application
Name=ledger
Comment=Experiment log for engineering tests
Exec="$APP_DIR/ledger.AppImage" %U
Icon=ledger
Terminal=false
Categories=Development;Science;
StartupWMClass=ledger
DESKTOP

refresh
echo "Installed ledger to $APP_DIR — it's now in your app launcher."
if ! command -v fusermount3 >/dev/null 2>&1 && ! command -v fusermount >/dev/null 2>&1; then
  echo "Note: no fusermount found, so the AppImage will extract itself on each start (slower)."
  echo "      Installing your distro's 'fuse3' package (not the deprecated libfuse2) avoids that."
fi
