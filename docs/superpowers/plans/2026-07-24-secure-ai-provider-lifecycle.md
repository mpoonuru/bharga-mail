# Secure AI Provider Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver complete, secure, user-controlled AI provider configuration, testing, routing, persistence, and deletion.

**Architecture:** Rust owns provider mutations and credentials; serialized profiles contain metadata only. React edits sanitized drafts and invokes explicit lifecycle commands, while routing refuses silent cross-provider cloud fallback.

**Tech Stack:** Rust, Tauri 2, SQLite, OS keychain, React 19, TypeScript, Zustand, Vitest

## Global Constraints

- API keys are write-only inputs and never returned or serialized.
- Provider deletion cleans keychain and encrypted fallback before success.
- Existing mail accounts and mail credentials remain untouched.
- Use Yarn for frontend commands and `dayjs` for date/time.
- Do not add CommonJS imports, `cn`, or `cva`.
- All desktop command errors must be surfaced to the UI.

---

### Task 1: Sanitized provider contracts

**Files:**
- Modify: `app/src-tauri/src/ai/mod.rs`
- Modify: `app/src/types.ts`
- Test: `app/src-tauri/src/ai/mod.rs`

**Interfaces:**
- Produces: sanitized `ModelConfig`, write-only `SaveProviderInput`, and derived `ProviderStatus`

- [ ] **Step 1: Write failing serialization and compatibility tests**

Add Rust tests proving JSON serialization cannot contain an API key and legacy
profiles without new status fields deserialize successfully.

- [ ] **Step 2: Run tests and verify failure**

Run `cargo test --manifest-path app/src-tauri/Cargo.toml ai::tests`.
Expected: failure because the new input/status contracts do not exist.

- [ ] **Step 3: Implement sanitized contracts**

Remove API keys from serializable model state. Add serde defaults for new
metadata, define explicit write-only command inputs, and align TypeScript types
without an `apiKey` property on returned `AiModel`.

- [ ] **Step 4: Run tests and verify success**

Run the focused Cargo tests. Expected: zero failures.

### Task 2: Fallible AI credential operations

**Files:**
- Modify: `app/src-tauri/src/sync/tokens.rs`
- Test: `app/src-tauri/src/sync/tokens.rs`

**Interfaces:**
- Produces: `save_ai_key(provider_id, value) -> Result<(), CredentialError>`,
  `ai_key(provider_id) -> Option<String>`, and
  `delete_ai_key(provider_id) -> Result<(), CredentialError>`

- [ ] **Step 1: Write failing credential lifecycle tests**

Add isolated tests for namespaced AI credential keys and encrypted fallback
deletion without logging credential values.

- [ ] **Step 2: Run tests and verify failure**

Run `cargo test --manifest-path app/src-tauri/Cargo.toml ai_credential`.
Expected: failure because the operations do not exist.

- [ ] **Step 3: Implement the credential API**

Generalize internal keychain/fallback deletion to return errors for AI
operations while preserving current best-effort mail token behavior for
compatibility.

- [ ] **Step 4: Run tests and verify success**

Run the focused credential tests. Expected: zero failures.

### Task 3: Atomic provider commands and persistence

**Files:**
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src-tauri/src/store/mod.rs`
- Test: `app/src-tauri/src/lib.rs`
- Test: `app/src-tauri/src/store/mod.rs`

**Interfaces:**
- Produces: `save_ai_provider`, `remove_ai_provider`, `test_ai_provider`, and
  fallible `persist_ai_profile`

- [ ] **Step 1: Write failing lifecycle tests**

Cover create/update with sanitized persistence, removal with role cleanup,
missing-provider errors, empty provider lists, and simulated persistence
failure. Assert no credential value enters settings JSON.

- [ ] **Step 2: Run tests and verify failure**

Run `cargo test --manifest-path app/src-tauri/Cargo.toml ai_provider`.
Expected: failure because lifecycle commands/helpers do not exist.

- [ ] **Step 3: Implement lifecycle helpers and Tauri commands**

Validate stable IDs, labels, model IDs, and HTTP(S) endpoints; store optional
credentials separately; persist metadata with propagated SQLite errors; remove
credentials and metadata in the documented safe ordering; register commands in
the Tauri handler.

- [ ] **Step 4: Run tests and verify success**

Run the focused lifecycle tests. Expected: zero failures.

### Task 4: Strict routing

**Files:**
- Modify: `app/src-tauri/src/ai/router.rs`
- Modify: AI call sites in `app/src-tauri/src/lib.rs`
- Test: `app/src-tauri/src/ai/router.rs`

**Interfaces:**
- Produces: explicit-assignment routing with no unrelated cloud fallback

- [ ] **Step 1: Write failing routing tests**

Add tests proving an unavailable assigned cloud provider returns no model,
removing a provider leaves its roles unassigned, and Local privacy never selects
a cloud provider.

- [ ] **Step 2: Verify tests fail**

Run `cargo test --manifest-path app/src-tauri/Cargo.toml ai::router`.
Expected: the current fallback behavior fails the new assertion.

- [ ] **Step 3: Implement strict routing**

Resolve only ready providers explicitly assigned to the requested role. Return
clear configuration errors at call sites when no valid assignment exists.

- [ ] **Step 4: Verify tests pass**

Run the focused router tests. Expected: zero failures.

### Task 5: Honest frontend bridge and state

**Files:**
- Modify: `app/src/lib/bridge.ts`
- Modify: `app/src/store.ts`
- Modify: `app/src/types.ts`
- Test: `app/src/lib/bridge.test.ts`
- Test: `app/src/store.test.ts`

**Interfaces:**
- Produces: typed `saveAiProvider`, `removeAiProvider`, and `testAiProvider`
  APIs with propagated desktop errors

- [ ] **Step 1: Write failing frontend tests**

Add tests proving desktop IPC errors reject, removal updates state from the
returned profile, and a draft API key is not retained after successful save.

- [ ] **Step 2: Verify tests fail**

Run `yarn --cwd app test src/lib/bridge.test.ts src/store.test.ts`.
Expected: failures from swallowed errors and missing lifecycle actions.

- [ ] **Step 3: Implement bridge and store lifecycle**

Branch explicitly on browser-preview mode rather than catching all failures.
Keep write-only keys in component-local drafts, replace timestamp IDs with
`crypto.randomUUID()`, and update Zustand only from sanitized command results.

- [ ] **Step 4: Verify tests pass**

Run the focused Vitest command. Expected: zero failures.

### Task 6: Modern provider management UI

**Files:**
- Create: `app/src/components/AiProviderManager.tsx`
- Create: `app/src/components/AiProviderCard.tsx`
- Modify: `app/src/components/Settings.tsx`
- Modify: `app/src/styles.css`
- Test: `app/src/components/AiProviderManager.test.tsx` if DOM test utilities support it

**Interfaces:**
- Consumes: lifecycle actions from Task 5
- Produces: accessible add, edit, test, save, and remove workflows

- [ ] **Step 1: Write failing UI behavior tests**

Test that OpenAI-compatible providers show endpoint and optional key fields,
Remove opens a role-impact confirmation, and command failures render inline.

- [ ] **Step 2: Verify tests fail**

Run `yarn --cwd app test src/components/AiProviderManager.test.tsx`.
Expected: failure because the manager does not exist.

- [ ] **Step 3: Implement the focused components**

Use the existing UI primitives and Calm Command tokens. Add a compact provider
catalog, management cards, visible focus states, responsive wrapping, status
copy, Test connection, Save changes, and destructive confirmation. Keep the API
key controlled in component-local state and clear it after success.

- [ ] **Step 4: Verify focused tests pass**

Run the focused component test. Expected: zero failures.

### Task 7: Full regression and security verification

**Files:**
- Modify only files required by failures discovered during verification

**Interfaces:**
- Produces: release-ready verified provider lifecycle

- [ ] **Step 1: Run frontend tests**

Run `yarn --cwd app test`. Expected: zero failures.

- [ ] **Step 2: Run TypeScript production build**

Run `yarn --cwd app build`. Expected: exit zero with no TypeScript errors.

- [ ] **Step 3: Run Rust tests**

Run `cargo test --manifest-path app/src-tauri/Cargo.toml`. Expected: zero
failures.

- [ ] **Step 4: Inspect the final diff for secret leakage**

Run a redacted diff scan that reports only filenames and line numbers for
credential-shaped fields. Confirm no plaintext credential fixtures or
organization-specific identifiers were introduced.

- [ ] **Step 5: Run open-source hygiene scan**

Run `yarn --cwd app check:open-source`. Expected: zero findings.

