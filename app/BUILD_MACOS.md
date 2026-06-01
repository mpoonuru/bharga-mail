# Build & run Bharga Mail on macOS

This produces a native macOS `.app` (and a `.dmg` installer) you can run and test.

> Note: the app **must be compiled on the Mac itself** — a macOS app can't be
> cross-built from Linux. The steps below do that in one command.

## 1. Install prerequisites (one time)

```bash
# Xcode command line tools (compiler + macOS SDK)
xcode-select --install

# Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# Bun (fast JS runtime/package manager). Or use npm if you prefer.
curl -fsSL https://bun.sh/install | bash
```

## 2. Build

From the repo, in the `app/` folder:

```bash
bash scripts/build-macos.sh
```

That installs JS deps, generates the app icons from `src-tauri/icons/icon-source.png`,
and compiles the release app. First compile takes a few minutes (Rust + SQLite).

Result:

```
app/src-tauri/target/release/bundle/macos/Bharga Mail.app   ← double-click to run
app/src-tauri/target/release/bundle/dmg/Bharga Mail_0.1.0_*.dmg ← installer
```

Open it:

```bash
open "src-tauri/target/release/bundle/macos/Bharga Mail.app"
```

## 3. Run in dev mode (hot reload, faster iteration)

```bash
bun install
bun run tauri:dev
```

## 4. First run — what works immediately

- The full **Calm Command** UI: Priority/Inbox/Bundles, reading pane, compose,
  Calendar, Tasks, Settings; ⌘K command bar; theme/density; adaptive layout.
- Seed data is shown until you connect a real account.

## 5. Turn on the live features

- **AI** — Settings → AI engine. Easiest fully-local path: install
  [Ollama](https://ollama.com), `ollama pull llama3`, set the local model's
  endpoint to `http://localhost:11434`, assign it the Draft/Triage/Embeddings
  roles, **Save engine**. Or paste a cloud API key (Claude / any
  OpenAI-compatible). Then drafts, summaries and ⌘K "ask" run for real.
- **Gmail** — see README "Connect a Gmail account" (needs `BHARGA_GMAIL_CLIENT_ID`).
- **Microsoft 365** — see README "Connect a Microsoft 365 account" (`BHARGA_MS_CLIENT_ID`).
- **Semantic search** — Settings → "Build index" after assigning an Embeddings model.

## Gatekeeper note

The app isn't code-signed/notarized yet, so the first open may need:
**System Settings → Privacy & Security → "Open Anyway"**, or
`xattr -dr com.apple.quarantine "Bharga Mail.app"`.
For distribution, add an Apple Developer ID and notarization (see ARCHITECTURE.md §9).
