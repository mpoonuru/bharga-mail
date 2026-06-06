#!/usr/bin/env bash
#
# Bharga Mail — macOS installer.
#
# Downloads the latest release for your Mac and installs it to /Applications,
# removing the Gatekeeper "quarantine" flag so it opens without the
# "unidentified developer / damaged" prompt (the build is ad-hoc signed, not
# Apple-notarized — which keeps it free).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/mpoonuru/bharga-mail/main/scripts/install.sh | bash
#
set -euo pipefail

REPO="mpoonuru/bharga-mail"
APP="Bharga Mail"
DEST="/Applications"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer is for macOS. On Linux use the .AppImage/.deb; on Windows the .msi from the Releases page." >&2
  exit 1
fi

case "$(uname -m)" in
  arm64)  arch_pat="aarch64" ;;
  x86_64) arch_pat="x64\|x86_64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

echo "→ Looking up the latest $APP release for $(uname -m)…"
dmg_url=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -oE 'https://[^"]+\.dmg' | grep -iE "$arch_pat" | head -n1 || true)

if [ -z "${dmg_url:-}" ]; then
  echo "Couldn't find a .dmg for your Mac in the latest release." >&2
  echo "Browse the downloads at: https://github.com/$REPO/releases/latest" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
dmg="$tmp/bharga.dmg"

echo "→ Downloading…"
curl -fsSL "$dmg_url" -o "$dmg"

echo "→ Mounting…"
# NB: no -quiet here — we need hdiutil's stdout to find the /Volumes mount point.
mnt="$(hdiutil attach "$dmg" -nobrowse | grep -oE '/Volumes/.*' | tail -n1)"
[ -n "$mnt" ] || { echo "Failed to mount the disk image." >&2; exit 1; }

echo "→ Installing to $DEST…"
rm -rf "$DEST/$APP.app"
if ! cp -R "$mnt/$APP.app" "$DEST/" 2>/dev/null; then
  echo "  (need admin rights to write to $DEST)"
  sudo cp -R "$mnt/$APP.app" "$DEST/"
fi
hdiutil detach "$mnt" -quiet || true

echo "→ Removing the quarantine flag…"
xattr -dr com.apple.quarantine "$DEST/$APP.app" 2>/dev/null \
  || sudo xattr -dr com.apple.quarantine "$DEST/$APP.app" 2>/dev/null || true

echo "✓ Installed. Opening $APP…"
open -a "$APP" || true
