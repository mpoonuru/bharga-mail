#!/usr/bin/env bash
# One-command macOS build for Aether Mail.
# Run on a Mac:  bash scripts/build-macos.sh
set -euo pipefail

cd "$(dirname "$0")/.."   # -> app/

echo "▸ Checking prerequisites…"
command -v cargo >/dev/null 2>&1 || { echo "✗ Rust not found. Install: https://rustup.rs"; exit 1; }
xcode-select -p >/dev/null 2>&1 || { echo "✗ Xcode Command Line Tools missing. Run: xcode-select --install"; exit 1; }

# Package manager: prefer bun, fall back to npm.
if command -v bun >/dev/null 2>&1; then PM=bun; RUN="bun run"; X="bunx";
elif command -v npm >/dev/null 2>&1; then PM=npm; RUN="npm run"; X="npx";
else echo "✗ Need bun or npm. Install bun: https://bun.sh"; exit 1; fi
echo "  using $PM"

echo "▸ Installing JS deps…"
$PM install

# Regenerate icons only if they're missing (this step is slow and rarely changes).
if [ ! -f src-tauri/icons/icon.icns ]; then
  echo "▸ Generating app icons from icon-source.png…"
  $X @tauri-apps/cli icon src-tauri/icons/icon-source.png
else
  echo "▸ Icons already present — skipping generation."
fi

# `--dev` = fast hot-reloading run for daily use; default = full release .app + .dmg.
if [ "${1:-}" = "--dev" ]; then
  echo "▸ Launching dev build (hot reload; Ctrl-C to quit)…"
  exec $RUN tauri dev
fi

echo "▸ Building the macOS app (this compiles Rust — first run takes a few minutes)…"
$RUN tauri build

echo
echo "✓ Done. Your app bundle is here:"
echo "   app/src-tauri/target/release/bundle/macos/Aether Mail.app"
echo "   app/src-tauri/target/release/bundle/dmg/    (installer .dmg)"
echo
echo "Open it with:  open 'src-tauri/target/release/bundle/macos/Aether Mail.app'"
echo "(First open: if macOS blocks it, right-click the app → Open → Open.)"
