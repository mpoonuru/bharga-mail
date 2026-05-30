# Aether Mail

AI-native, **model-agnostic**, local-first mail client. Tauri 2 (Rust core) + React 19 (TypeScript).
Design language: **Calm Command** — calm and content-first at rest, total power one keystroke away.

> Your mail. Your model. Your machine.

## Stack

- **Shell / runtime:** Tauri 2 (desktop: Windows · macOS · Linux; mobile target: iPadOS/iOS, Android)
- **Core:** Rust (sync engine, local store, search, the plug-and-play AI engine)
- **UI:** React 19 + TypeScript, Vite 8, Zustand 5, TanStack Query 5
- **Styling:** Tailwind CSS v4, fully (CSS-first: `@tailwindcss/vite` + `@import "tailwindcss"`, no config file/PostCSS). Design tokens bridged via `@theme inline` (theme-aware utilities); all component classes defined in `@layer components` with `@apply` in `src/styles.css`; only keyframes, the token-var definitions, pseudo-elements, density vars, and the scrollbar remain raw CSS
- **Icons:** Phosphor (`@phosphor-icons/react` v2.1+, `*Icon`-suffixed exports)
- **Motion:** Motion for React (`motion` v12, the current Framer Motion) for UI/layout animation + GSAP 3 for timeline flourishes
- **Package manager / runtime:** Bun recommended (`bun install`, `bun run …`); npm works too
- **Local store:** SQLite + FTS5; sqlite-vec / LanceDB for embeddings (Phase 1)

## Project structure

```
app/
├─ index.html
├─ package.json            # React 19, Vite 6, Tauri CLI 2
├─ tsconfig.json
├─ vite.config.ts          # port 1420 for Tauri
├─ src/                    # React UI ("Calm Command")
│  ├─ main.tsx · App.tsx
│  ├─ store.ts             # Zustand app state (theme, density, focus, nav, data)
│  ├─ types.ts             # domain + AI engine types (mirror of Rust)
│  ├─ styles.css           # design tokens + component styles
│  ├─ data/mock.ts         # seed data so the UI runs with no backend
│  ├─ lib/
│  │  ├─ bridge.ts         # Tauri IPC bridge (falls back to mock in browser)
│  │  └─ useHotkeys.ts     # ⌘K / F / C global keys
│  └─ components/
│     ├─ Sidebar · Stream · Stage · Compose
│     ├─ CalendarView · TasksView · Settings
│     └─ CommandBar · ModelPicker
└─ src-tauri/              # Rust core
   ├─ Cargo.toml · tauri.conf.json · build.rs
   └─ src/
      ├─ main.rs · lib.rs  # Tauri commands (IPC surface)
      ├─ ai/               # PLUG-AND-PLAY AI ENGINE
      │  ├─ mod.rs         # AiProvider trait, ModelConfig, roles, capabilities
      │  ├─ adapters.rs    # OpenAI-compatible · Anthropic · Local adapters
      │  └─ router.rs      # per-task model routing (+ tests)
      ├─ store/mod.rs      # local-first store (SQLite in Phase 1)
      └─ sync/mod.rs       # sync engine (Gmail/Graph/JMAP/IMAP)
```

## Run

### UI only (fastest — no Rust needed)
The bridge falls back to seed data when not running inside Tauri, so the whole UI is explorable in a browser.

```bash
cd app
bun install          # or: npm install
bun run dev          # http://localhost:1420  (or: npm run dev)
```

### Tests
```bash
bun run test          # frontend unit tests (Vitest) — store + bridge
# Rust core tests:
cd src-tauri && cargo test
```

### Full desktop app (Tauri)
Requires the Rust toolchain and platform webview deps — see https://v2.tauri.app/start/prerequisites/
`tauri.conf.json` runs `bun run dev/build` as its hooks; change to `npm run …` if you prefer npm.

```bash
cd app
bun install
bun run tauri:dev    # launches the native window
bun run tauri:build  # produces signed installers per platform
```

## Try it

- **⌘K** — command bar: navigate, run actions, or *ask your inbox* (type a question)
- **F** — focus mode (the Stream recedes, the Stage takes over)
- **C** — compose
- Bottom-left **engine chip** — quick model switcher (plug-and-play AI)
- **Settings → AI engine** — assign models to roles, set the privacy preset, add providers

## Connect a Gmail account (live sync)

Uses OAuth 2.0 with PKCE via a loopback redirect (Google's desktop-app pattern — no client secret shipped).

1. In Google Cloud Console, create an **OAuth client ID** of type *Desktop app* and enable the Gmail API.
2. Run the desktop app with the client id in the environment:
   ```bash
   AETHER_GMAIL_CLIENT_ID=xxxx.apps.googleusercontent.com npm run tauri:dev
   ```
3. Settings → **Connect Gmail** → sign in. Messages sync into the local SQLite store and appear in the inbox.

Tokens are stored in the OS keychain (never on disk in plaintext, never on our servers).

## Connect a Microsoft 365 account

Same PKCE flow, Microsoft Graph endpoints.

1. In Azure Portal → App registrations, create an app of type **Mobile & desktop**, add the redirect URI `http://localhost`, and grant delegated scopes `User.Read`, `Mail.Read`, `Mail.Send`, `offline_access`.
2. Run with the client id:
   ```bash
   AETHER_MS_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx bun run tauri:dev
   ```
3. Settings → **Microsoft 365** → sign in. Mail syncs via Graph; sending uses `sendMail`.

## Attachments

The composer collects files (base64) and the Rust send path delivers them:
Gmail via multipart/mixed MIME, Microsoft 365 via Graph `fileAttachment`, and
plain SMTP via `lettre` MultiPart. (Inbound attachment download arrives with
IMAP fetch.)

## Connect a plain IMAP/SMTP account

Settings → **IMAP / SMTP** → enter email, SMTP host/port, username, password, and
IMAP host/port. Password is stored in the OS keychain. **Save & sync** fetches the
inbox over IMAP (rustls TLS) and outgoing mail sends via SMTP — both without
system OpenSSL.

## Use live AI

Settings → AI engine. Either point the **local** model at Ollama (`http://localhost:11434`, model `llama3`) for free/offline, or paste an **API key** for a cloud/OpenAI-compatible provider. Assign models to roles, **Save engine** — then drafts and ⌘K "ask" run for real.

## What's wired vs. what's next

**Wired now:** full UI + navigation, theme/density, command palette; the plug-and-play **AI engine** (provider trait + OpenAI-compatible/Anthropic/local adapters with real `reqwest` calls, per-role router, prompts); **SQLite store** (schema, migrations, FTS5 search, upserts, task persistence, first-run seed); **Gmail OAuth (PKCE) + initial sync** with MIME body parsing and keychain token storage; the full Tauri command surface. Rust has unit tests for the router, store round-trip, HTML stripping, and Gmail message parsing.

**Incremental sync:** Gmail uses the History API (`startHistoryId`, falls back to full sync when the cursor expires); Microsoft 365 uses Graph delta queries (deltaLink/nextLink cursor). Both persist their cursor in the `accounts` table.

**Phase 1+ (next):** JMAP provider, push notifications, inbound attachment download, iPad target, code signing & store submission. See `../ARCHITECTURE.md` for the full roadmap.

> Note: the Rust core compiles against Tauri 2 + the listed crates but was authored in an environment without a Rust toolchain — run `cargo check` in `src-tauri/` on first build to confirm.
