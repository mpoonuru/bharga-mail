# AI Mail Client — Architecture & Technical Plan

**Project:** AI-native mail client for Windows, macOS, and iPad (+ Linux/iOS/Android optional)
**Stack:** Tauri 2 (Rust core) + React (TypeScript) front end
**Status:** Planning blueprint — v0.1
**Date:** May 2026

---

## 1. Vision

An AI-native email client where the AI is not a bolted-on sidebar but the organizing principle of the app. The inbox triages itself, every thread arrives pre-summarized with a draft reply that sounds like you, search is a conversation, and email, calendar, and tasks live in one surface. Think of the bar set by Superhuman (speed) and Shortwave (AI-native, server-side intelligence) — then go further by unifying mail + calendar + tasks and shipping truly cross-platform on a modern, lightweight runtime.

Design pillars:

1. **AI-first, not AI-added.** Triage, summarize, draft, and search are core flows, not features in a menu.
2. **Local-first & fast.** Sub-50ms interactions. The UI never blocks on the network; everything reads from a local store that syncs in the background.
3. **One surface for mail, calendar, and tasks.** Email turns into commitments; commitments turn into calendar events and tasks without leaving the app.
4. **Privacy-tunable.** The user controls where their data and AI processing live (cloud / hybrid / local).
5. **Truly cross-platform.** Windows, macOS, and iPad from one codebase, with Linux/Android as low-cost extras.

---

## 1A. The Unique Approach — Why This Isn't Just Another Inbox

The risk is real: Superhuman, Shortwave, Notion Mail, and the rest have converged on the same shape — a pretty three-pane inbox, a "summarize" button, a pre-drafted reply, a chat sidebar. They also share the same business model and the same lock-in: **their cloud, their model, their subscription, your data on their servers.** Copying that shape means competing on polish against companies with a head start.

Our wedge is to invert every one of those assumptions. The positioning in one line:

> **Your mail. Your model. Your machine.** — The open, AI-agnostic, local-first mail client.

Five differentiators, each a direct contrast with the incumbents:

1. **Plug-and-play AI (the headline).** Every competitor hardwires you to *their* model and bills you per seat for it. We treat the AI like a browser treats search engines — a swappable engine. Bring any model: a cloud API (Claude, GPT, Gemini), any **OpenAI-compatible endpoint** (OpenRouter, Groq, Together, vLLM, your company's gateway), or a **fully local model** (Ollama, LM Studio, llama.cpp) running free and offline. Pay your own provider, or pay nothing. Assign different models to different jobs. This is detailed in §5.

2. **Local-first & private by default.** Your mail lives encrypted on your device and works fully offline. No server sees your inbox unless *you* point a cloud model at it. For a German/EU audience especially, "private by default, your data never touches our servers" is not a feature — it's the reason to switch. The incumbents physically can't say this; their AI runs on their servers.

3. **MCP-native agentic actions.** Most clients only *generate text*. We make the AI *act*: natively speak the Model Context Protocol so your chosen model can use tools and connected apps — create the calendar event, file the task in Linear/Asana, look something up, send the reply — with your approval. The inbox becomes an agent surface, not a suggestion box.

4. **Automations that think.** Instead of brittle "if subject contains X" filters, write rules in plain language ("when a customer escalates, summarize the thread, draft a calm reply, and flag it urgent") that your local model executes on every message. Filters for the LLM era.

5. **Open & extensible (anti-lock-in).** A plugin API and an open core build trust and let the community extend the client — new providers, new automations, new panels. Lock-in is the incumbents' moat; openness is ours.

**Why these five hang together:** they're one coherent bet — *de-couple the client from any single vendor's cloud and model* — rather than five unrelated features. That's a position the vertically-integrated incumbents cannot copy without dismantling their own business model. It also maps directly onto your context: a privacy-conscious EU market and your explicit ask for configurable, plug-and-play AI.

---

## 2. Technology Stack

### 2.1 Why Tauri 2 + React

Tauri 2 reached stable in 2024 and now offers **first-class iOS and Android support from the same codebase as desktop** (macOS, Windows, Linux), with Swift/Kotlin bindings for native mobile code, a new permissions system, a multi-webview API, and much-improved IPC. That makes it the right backbone for a "Windows + macOS + iPad" target: one Rust core, one React UI, native shells per platform.

Compared to Electron, Tauri ships **dramatically smaller binaries** (single-digit MB vs. 100MB+), uses the OS-native webview instead of bundling Chromium (lower RAM, better battery), and gives you a real **Rust core** for the performance-critical parts (sync engine, local DB, crypto, full-text indexing) — exactly the work an email client lives or dies on.

| Layer | Choice | Why |
|---|---|---|
| App shell / runtime | **Tauri 2** | Cross-platform desktop + iPad/iOS/Android, tiny binaries, native webview, Rust core |
| Core engine | **Rust** | Sync, indexing, crypto, DB access — fast, safe, shared across all platforms |
| UI framework | **React 18 + TypeScript** | Largest ecosystem, fast iteration, easy hiring |
| Styling | **Tailwind CSS + Radix UI / shadcn** | Utility-first speed + accessible unstyled primitives |
| State / data | **TanStack Query + Zustand** | Async cache + lightweight local state |
| Local database | **SQLite (via Rust `sqlx`/`rusqlite`)** | Battle-tested, embeddable, FTS5 full-text search built in |
| Vector store | **sqlite-vec / LanceDB** | On-device embeddings for semantic search & RAG |
| Editor | **TipTap (ProseMirror)** | Rich-text compose, extensible, controllable by AI |
| Build/release | **Tauri Action (GitHub) + code signing** | Per-platform installers, auto-update |

> **iPad note:** Tauri's mobile target covers iOS/iPadOS. The iPad app shares the React UI and Rust core; you build a responsive/adaptive layout (see §7) rather than a separate codebase. Expect platform-specific work for push notifications, background sync limits, and App Store review — budget for it, but the core logic is shared.

### 2.2 Alternative if iPad/iOS is the #1 priority

If mobile (iPad/iOS) becomes the dominant surface rather than a companion, **Flutter** is the more proven mobile-first cross-platform path today. The trade-off is a less mature *desktop* story and a smaller talent pool than React. Given your stated priority (Windows + macOS first, iPad alongside), **Tauri 2 + React is the recommended choice** and the rest of this document assumes it.

---

## 3. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      UI (React + TS)                          │
│  Inbox · Reading pane · Compose · Calendar · Tasks · Ask      │
│         TanStack Query  ·  Zustand  ·  Tailwind/Radix         │
└───────────────▲───────────────────────────▲──────────────────┘
                │ Tauri IPC (typed commands)  │ events/push
┌───────────────┴───────────────────────────┴──────────────────┐
│                    RUST CORE (shared)                          │
│                                                                │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Sync Engine│  │ Local Store  │  │ Search & Index        │  │
│  │ JMAP/Gmail │  │ SQLite +     │  │ FTS5 + vector (RAG)   │  │
│  │ /Graph/IMAP│  │ encrypted    │  │                       │  │
│  └─────┬──────┘  └──────┬───────┘  └──────────┬────────────┘  │
│        │                │                      │               │
│  ┌─────┴──────────────────────────────────────┴────────────┐ │
│  │              AI Orchestrator                              │ │
│  │  triage · summarize · draft · extract tasks/events · ask  │ │
│  └───────────────────────────┬──────────────────────────────┘ │
└──────────────────────────────┼─────────────────────────────────┘
                               │
        ┌──────────────────────┼───────────────────────┐
        ▼                      ▼                        ▼
  Mail providers         AI providers            Calendar/Tasks
  Gmail API · MS Graph   Claude/GPT (cloud)       Google · MS365
  JMAP (Fastmail)        local model (Ollama)     CalDAV
  IMAP/SMTP fallback     hybrid router
```

**Principle:** the UI only ever talks to the local store through typed Tauri commands. The sync engine reconciles the local store with remote providers in the background. The AI orchestrator reads from the local store (so it has full context) and writes results (summaries, drafts, labels) back into it.

---

## 4. The Sync Engine (the make-or-break component)

Email clients succeed or fail on sync correctness and speed. Plan to support providers in this order of preference:

1. **Gmail API** — for Google accounts (the majority of consumer/SMB users). History API for incremental sync, push via Pub/Sub watch.
2. **Microsoft Graph** — for Outlook/Microsoft 365. Delta queries + webhooks for change notifications.
3. **JMAP** — the modern JSON-over-HTTP protocol (Fastmail, Stalwart, Apache James, Cyrus; Thunderbird is rolling it out). JMAP has **built-in change tracking (sync only what changed) and WebSocket push**, so no polling — better latency and battery than IMAP. Prefer it wherever available.
4. **IMAP/SMTP** — universal fallback for everything else. Use `IDLE` for push, `CONDSTORE`/`QRESYNC` for efficient resync.

### 4.1 Design

- **Per-account sync state machine** in Rust, each account isolated, with exponential backoff and a circuit breaker per provider.
- **Incremental sync** using each provider's change token (Gmail historyId, Graph deltaLink, JMAP state string). Full backfill on first connect, then deltas.
- **Local store is the source of truth for the UI.** Optimistic writes (archive, send, label) apply locally instantly, then reconcile with the server; on conflict, server wins with a visible undo.
- **Outbox pattern** for sending: a queued send survives app restarts and offline periods; "Undo Send" is just a delayed flush.
- **Background sync** respects mobile constraints (iOS background execution limits) — on iPad, lean on push notifications to wake sync rather than polling.

### 4.2 Local store schema (sketch)

`accounts`, `mailboxes/labels`, `threads`, `messages`, `message_bodies` (separate, lazy-loaded), `attachments` (lazy + cached), `contacts`, `events`, `tasks`, `ai_artifacts` (summaries/drafts/embeddings keyed to message/thread), `sync_state`. Bodies and attachments are stored separately so list views stay fast.

---

## 5. AI Architecture — The Plug-and-Play Model Engine

This is the differentiator, so it's designed as a first-class subsystem, not a wrapper around one API. The core idea: **the AI is a configurable engine, like a browser's search engine.** Users bring their own model(s); the app stays model-agnostic forever.

### 5.0 The Bring-Your-Own-AI engine

**Provider abstraction.** Everything in the app talks to a single Rust trait — roughly `chat()`, `stream()`, `embed()`, `tools()` — never to a specific vendor SDK. Each provider is an adapter behind that trait, so features never know (or care) which model is running.

**Supported provider classes (one adapter each, covers nearly everything):**

| Class | Examples it covers | Notes |
|---|---|---|
| **OpenAI-compatible endpoint** | OpenAI, OpenRouter, Groq, Together, Fireworks, vLLM, LM Studio server, most self-hosted gateways | The single highest-leverage adapter — a base URL + key unlocks dozens of providers and most enterprise gateways. |
| **Anthropic** | Claude | Native tool-use + long context. |
| **Google** | Gemini | Vision + long context. |
| **Local runtimes** | Ollama, llama.cpp, LM Studio | Free, offline, private. Auto-discover models the user has pulled. |
| **Enterprise / custom** | Azure OpenAI, AWS Bedrock, a company's internal LLM | Custom base URL, auth header/scheme, and model list. |

**Bring your own key (BYOK).** Users paste their own API keys (stored in the OS keychain, never our servers) or point at a local/self-hosted endpoint. They pay their provider directly, or pay nothing when running local. We can also offer an *optional* managed-key tier for people who don't want to deal with keys — but it's a convenience, never a requirement.

**Capability detection & graceful degradation.** On adding a model, the engine probes/looks up its capabilities — context window, tool-calling, vision, embedding support, streaming — and stores a capability profile. Features check capabilities and degrade gracefully (e.g. if a local model can't do tool-calling, the agent falls back to structured prompting; if it has no embedding endpoint, search uses a separate local embedding model).

**Per-task model routing (the power-user feature).** Users assign models to *roles*, so the right engine handles each job:

| Role | Typical assignment | Why |
|---|---|---|
| Triage / labeling | small fast local model | runs on every email; cheap, private |
| Embeddings (search/RAG) | local embedding model | high volume, privacy-sensitive |
| Summaries | mid-tier (local or cheap cloud) | balance cost/quality |
| Draft & rewrite | best available (Claude/GPT) | users notice quality most here |
| Agent / tool-use | a tool-calling-capable model | needs function calling |

Ship sensible defaults (one local + one cloud) so it works out of the box, but every role is reassignable. Power users tune it; everyone else never sees it.

**Shareable "model profiles."** A complete configuration (which providers, which model per role, privacy preset) is an exportable profile — so a team or an enterprise can distribute a vetted setup, and the community can share recipes ("best fully-local profile," "cheapest cloud profile").

**Cost & usage metering.** Per-provider token and spend tracking surfaced in the UI, with optional budget caps, so BYOK users always know what each role is costing them.

### 5.1 Where the AI runs — default recommendation: **Hybrid**

The engine above means *the user decides* where AI runs, per role. The shipped default is hybrid because it's the best out-of-box experience; here's the breakdown by task that informs the default routing:

| Task | Best location | Reasoning |
|---|---|---|
| Triage / auto-labeling / priority | **Local model** (small) | Runs on every incoming email; high volume, latency- and cost-sensitive, privacy-relevant. A small on-device model is plenty. |
| Thread summarization | **Hybrid** | Local for short threads; cloud for long/complex ones where quality matters. |
| Draft replies / smart compose | **Cloud** (Claude/GPT) | Quality and tone matching matter most here; users notice. |
| Natural-language search / "Ask my inbox" | **Hybrid (RAG)** | Embeddings + retrieval local; final synthesis cloud or local depending on privacy setting. |
| Task/event extraction | **Local** | Structured extraction is well within a small model's reach; runs often. |

Give the user a single **privacy dial** with three presets:

- **Cloud** — best quality, easiest, content sent to provider API (clearly disclosed).
- **Local/on-device** — max privacy, fully offline, lower quality on weak hardware, no per-token cost.
- **Hybrid (default)** — light/high-volume tasks on-device, heavy generation in the cloud; the dial lets privacy-sensitive users push everything local.

### 5.2 Components

- **AI Orchestrator (Rust)** — routes each task to the right model per the privacy setting, handles batching, caching, retries, and cost budgeting. Caches results in `ai_artifacts` so summaries/drafts aren't recomputed.
- **RAG pipeline** — on email arrival, chunk + embed the message, store the vector in sqlite-vec/LanceDB. "Ask my inbox" retrieves relevant messages by semantic + keyword (hybrid) search, then feeds them to the model with citations back to source emails. (This mirrors Shortwave's server-side embedding approach, but you can keep it on-device for privacy.)
- **Style learning** — build a lightweight, on-device profile of the user's writing (tone, sign-off, length, formality per recipient) from sent mail, and condition drafts on it so replies "sound like you." Per-recipient tone adaptation (formal vs. casual) is a high-value differentiator.
- **Model providers** — pluggable: Claude / OpenAI / Gemini for cloud; Ollama or a bundled small model (e.g. a quantized Llama/Phi-class model) for local. Abstract behind one trait so you can swap models without touching features.

### 5.3 v1 AI feature set (all four you selected)

1. **Smart compose & replies** — pre-drafted reply on every actionable email, inline rewrite ("make it shorter / friendlier / more formal"), autocomplete.
2. **Summarize & triage** — thread summaries at the top, auto-labels, a self-organizing priority inbox, and a daily digest.
3. **Search & ask** — natural-language search and a chat assistant grounded in your mailbox (RAG) with citations.
4. **Scheduling & follow-ups** — detect meeting intent, propose times against your calendar, draft invites, and nudge you on threads awaiting a reply.

---

## 6. Beyond Email — Calendar, Tasks & "Futuristic" Features

You're right that a modern client is a productivity surface, not just a mailbox. Plan these as first-class:

- **Unified calendar** — Google Calendar + Microsoft 365 + CalDAV. Two-way sync. AI drafts events from email ("let's meet Thursday" → proposed event), finds mutual free time, and writes natural-language scheduling replies.
- **Tasks** — extract action items from emails into tasks; convert any email into a task with one keystroke; due dates, reminders, and a "needs reply / waiting on" view. Optional sync to Todoist/Things/Microsoft To Do.
- **Send later / Snooze / Remind me** — table stakes for a modern client.
- **Command palette + full keyboard control** — everything reachable in <2 keystrokes (the Superhuman bar).
- **Split inboxes / bundles** — auto-group newsletters, receipts, notifications for batch processing (the Shortwave bar).
- **Read-state & follow-up tracking**, link previews, attachment gallery, and unsubscribe assistant.

**Futuristic / differentiating bets (post-v1):** an autonomous "inbox agent" that drafts, schedules, and files with your approval; meeting-prep briefs assembled from prior threads; auto-generated weekly review; voice compose on iPad; and a multi-account unified inbox with cross-account AI.

---

## 7. Design — A Signature Design Language: "Calm Command"

Generic "minimal + dark mode" is table stakes and reads as a clone. To be the best-designed mail client, the UI needs a *point of view*. Ours is **Calm Command**: an interface that feels calm and content-first at rest, but where immense power is one keystroke away. Mature, quiet, confident — not loud or gimmicky. The two influences are the serenity of a great reading app and the velocity of a great command tool (Linear, Raycast, Superhuman) — fused.

### 7.1 The five signature ideas

1. **Command-first, not chrome-first.** A center-screen command bar (⌘K) is the primary way to navigate and act — go to any thread, run any automation, ask the AI, anything. Persistent toolbars and buttons shrink to near-zero; the content gets the screen. This is the single most distinctive, "matured power-user" gesture.

2. **The Stream and the Stage.** Rather than three rigid fixed panes, the layout is a focused **Stage** (the thread you're reading/writing) flanked by a quiet **Stream** (the list) that recedes when you focus and expands when you scan. It fluidly becomes two-pane and one-pane on iPad. The app feels like it's *paying attention to what you're doing*.

3. **AI lives in the flow, never in a sidebar.** Summaries render *inline* as a soft caption above a thread. Draft replies appear as **editable ghost text** directly in the composer. The agent's proposed actions ("Create event Thu 3pm — Confirm?") surface as inline **action chips** in context. There is no chat bubble in a corner — the intelligence is woven into the surface you're already looking at. This is the clearest visual break from every competitor.

4. **Signature material & light.** A restrained, premium material system: deep, true-black-adjacent dark theme and a warm paper-white light theme; soft layered depth and subtle translucency for floating surfaces (command bar, action chips); one expressive accent the user can personalize. Depth and light do the work that borders and boxes do in lesser UIs.

5. **Physics-based motion as feedback.** Sub-150ms, spring-based transitions that communicate state (a sent mail "flies" to its destination, the Stream recedes as the Stage takes focus). Motion is always informative, never decorative, and fully respects reduced-motion.

### 7.2 Craft details that signal maturity

- **Typography as the hierarchy.** One excellent variable sans (Inter / Geist class) with a tight, deliberate type scale; email body readability is sacred (optimal measure, line-height, and rhythm). Most of the "design" is just impeccable type and spacing.
- **Density as a first-class control:** comfortable / cozy / compact, instantly switchable.
- **Pixel-perfect empty states, loading skeletons, and micro-interactions** — the details that separate "awesome" from "fine."
- **Platform-native polish:** macOS traffic-light insets and vibrancy, Windows Mica/Fluent acrylic, iPad touch targets and pointer interactions — same design language, native on each.
- **Personalization without chaos:** accent color and a small set of curated themes, so it feels like *yours* but never messy.

### 7.3 Design system & process

A **token-based design system** (color, spacing, radius, type, motion, elevation as tokens) is the single source of truth, shared between Figma and code. Build on Radix/shadcn accessible primitives, themed entirely through tokens, so Windows, macOS, and iPad stay visually consistent while honoring native affordances. Ship a living component library and a Figma kit in lockstep with code via design tokens.

### 7.4 Accessibility

WCAG 2.1 AA from day one: keyboard-navigable everything, visible focus, sufficient contrast, screen-reader labels, and respect for reduced-motion and OS text-size settings (important on iPad).

---

## 8. Security & Privacy

- **Local encryption at rest:** encrypt the SQLite store; keys in the OS keychain (macOS Keychain, Windows Credential Manager, iOS Keychain).
- **OAuth, never passwords:** OAuth 2.0 / OIDC for Gmail, Microsoft, and modern providers; tokens in the OS secure store; refresh handled in Rust.
- **Least-privilege scopes** and clear consent screens.
- **AI data disclosure:** explicit, legible disclosure of what content (if any) leaves the device, tied to the privacy dial. Default to not training on user data.
- **Tauri's permission system** to lock down what the webview/plugins can access.
- **Compliance posture:** plan for GDPR (you're at a German domain — data residency and DPA matter), with a path to SOC 2 if you sell to businesses. Offer an EU data region for any cloud AI processing.

---

## 9. Build, Release & Ops

- **Monorepo** — `core/` (Rust), `ui/` (React), `crates/` for shared Rust libs, `apps/` per-platform config.
- **CI/CD:** GitHub Actions + `tauri-action` to build signed installers per platform. Code signing + notarization for macOS, signing for Windows, App Store pipeline for iPad/iOS.
- **Auto-update:** Tauri updater for desktop; App Store for iPad.
- **Crash/telemetry:** privacy-respecting, opt-in (Sentry or self-hosted), with PII scrubbing.
- **Backend (thin):** you'll likely need a small cloud service for OAuth token exchange brokering, push notification fan-out, the cloud-AI proxy (to keep API keys server-side and meter usage), and licensing/billing. Keep it minimal — the heavy lifting stays on-device.

---

## 10. Recommended Roadmap

**Phase 0 — Foundations (4–6 wks)**
Tauri 2 scaffold, Rust core skeleton, SQLite store, one provider end-to-end (Gmail API): connect, sync, read, send. Bare three-pane UI.

**Phase 1 — Solid email client (6–10 wks)**
Threading, search (FTS5), archive/label/snooze, outbox + undo send, attachments, dark mode, keyboard shortcuts + command palette. Add Microsoft Graph. This must be a *great* email client before it's an AI one.

**Phase 2 — AI layer (6–8 wks)**
AI orchestrator + hybrid routing, thread summaries, smart compose/replies with style learning, auto-triage/priority inbox, RAG-based "Ask my inbox."

**Phase 3 — Productivity surface (6–8 wks)**
Calendar integration (Google + M365 + CalDAV), task extraction, scheduling assistant, follow-up tracking, daily digest.

**Phase 4 — iPad + polish (6–10 wks)**
Tauri mobile target for iPadOS, adaptive layout, push notifications, background-sync tuning, App Store submission. JMAP + IMAP fallback for broader provider coverage.

**Phase 5 — Differentiators**
Inbox agent, meeting prep, unified multi-account AI, voice compose.

Start narrow: **one provider, desktop-first, email-excellent**, then layer AI, then productivity, then iPad. Resist building all platforms and all features in parallel.

---

## 11. Key Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Sync correctness/edge cases | Invest early; per-provider integration tests against real accounts; conflict = server-wins + undo. |
| iPad background sync limits | Push-driven wake; manage expectations vs. desktop. |
| AI cost at scale | Local for high-volume tasks; cache aggressively; meter cloud usage server-side. |
| Provider API limits/changes | Abstraction layer per provider; respect rate limits; JMAP/IMAP fallback. |
| Privacy/trust | Clear data disclosure, EU region, opt-in telemetry, default no-training. |
| Scope creep | Phased roadmap; "great email client" gate before AI/productivity. |

---

## Sources

- [Tauri 2.0 (official)](https://v2.tauri.app/) · [Tauri 2.0 Stable Release](https://v2.tauri.app/blog/tauri-20/) · [Tauri iOS Support 2026](https://viadreams.cc/en/blog/tauri-guide/)
- [Shortwave vs. Superhuman (Zapier, 2026)](https://zapier.com/blog/shortwave-vs-superhuman/) · [How Shortwave uses AI](https://thelettertwo.com/2024/04/04/how-shortwave-is-using-ai-to-take-on-superhuman-and-gmail/)
- [JMAP (official)](https://jmap.io/) · [JMAP — Wikipedia](https://en.wikipedia.org/wiki/JSON_Meta_Application_Protocol) · [IMAP vs JMAP (PDG Mail, 2025)](https://pdg-mail.com/blog/25/05/10/imap-vs-jmap-comparison)
