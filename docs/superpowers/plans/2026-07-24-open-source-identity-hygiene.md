# Open-source Identity Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove organization-specific identities from shipped Bharga Mail defaults while preserving neutral demo and preview functionality.

**Architecture:** Production Tauri behavior remains empty-by-default. Explicit Rust demo mode and browser-only mocks use reserved example domains, and a tracked-source scan prevents organization identifiers from returning.

**Tech Stack:** TypeScript, Vitest, Rust, Cargo tests, Vite single-file preview

## Global Constraints

- Never rewrite existing user databases, connected accounts, or keychain entries.
- Use Yarn for frontend commands.
- Use `dayjs` for all TypeScript date/time behavior.
- Do not add CommonJS imports, `cn`, or `cva`.
- Do not include organization, assistant, vendor, or automation attribution.

---

### Task 1: Neutral demo identities

**Files:**
- Modify: `app/src/data/mock.ts`
- Modify: `app/src-tauri/src/store/seed.rs`
- Modify: `mockup.html`
- Test: `app/src/data/mock.test.ts`
- Test: `app/src-tauri/src/store/seed.rs`

**Interfaces:**
- Consumes: existing `mock.account`, `mock.threads`, and `seed(Store)` APIs
- Produces: equivalent demo fixtures containing reserved-domain identities only

- [ ] **Step 1: Write failing fixture tests**

Add a Vitest assertion that JSON-stringified mock exports contain no blocked
organization identifier and that every fictional mailbox owned by the demo user
ends in `@example.com`. Add a Rust unit test that seeds an in-memory store and
asserts its accounts contain reserved-domain addresses only.

- [ ] **Step 2: Verify the tests fail**

Run `yarn --cwd app test src/data/mock.test.ts` and
`cargo test --manifest-path app/src-tauri/Cargo.toml seed`.
Expected: both fail on the current organization-specific addresses.

- [ ] **Step 3: Neutralize source fixtures**

Replace the demo account with `alex.morgan@example.com`, colleagues with
fictional reserved-domain addresses, and organization-specific copy with neutral
product-team copy. Preserve fixture IDs, thread counts, views, labels, tasks,
dates, and UI behavior.

- [ ] **Step 4: Verify focused tests pass**

Run the same two focused commands. Expected: zero failures.

### Task 2: Release-input hygiene guard

**Files:**
- Create: `scripts/check-open-source-hygiene.mjs`
- Modify: `app/package.json`
- Create: `scripts/check-open-source-hygiene.test.mjs`

**Interfaces:**
- Produces: `yarn --cwd app check:open-source` with nonzero exit on a blocked identifier

- [ ] **Step 1: Write a failing scanner test**

Create a Node test that writes a temporary fixture containing a blocked
identifier, invokes the scanner's exported `scanText`, and asserts one finding
with file and line but without printing surrounding content.

- [ ] **Step 2: Verify the scanner test fails**

Run `node --test scripts/check-open-source-hygiene.test.mjs`.
Expected: failure because the scanner module does not exist.

- [ ] **Step 3: Implement the scanner**

Implement named ESM exports. Scan tracked source inputs obtained from
`git ls-files`, exclude dependency/build/binary/lock paths and the scanner's
blocked-term declaration, redact matched content, and report only file and line.
Add `check:open-source` to `app/package.json`.

- [ ] **Step 4: Verify scanner tests and repository scan**

Run `node --test scripts/check-open-source-hygiene.test.mjs` and
`yarn --cwd app check:open-source`.
Expected: tests pass and the scan identifies only remaining tracked preview
artifacts before Task 3.

### Task 3: Rebuild neutral previews

**Files:**
- Modify: `Bharga Mail — UI preview.html`
- Modify: `app/dist-single/index.html`

**Interfaces:**
- Consumes: neutral frontend mock source
- Produces: tracked previews with no organization-specific defaults

- [ ] **Step 1: Build the single-file preview**

Run the existing Yarn/Vite single-file build command after inspecting the
configured script or invoke `yarn --cwd app vite build --config vite.singlefile.config.ts`.
Expected: regenerated `app/dist-single/index.html`.

- [ ] **Step 2: Refresh the root preview artifact**

Copy the generated single-file preview to `Bharga Mail — UI preview.html` using
the repository's existing preview workflow, preserving the root artifact's
purpose.

- [ ] **Step 3: Run the hygiene scan**

Run `yarn --cwd app check:open-source`.
Expected: zero blocked organization identifiers across tracked release inputs.

- [ ] **Step 4: Run regression verification**

Run `yarn --cwd app test`, `yarn --cwd app build`, and
`cargo test --manifest-path app/src-tauri/Cargo.toml`.
Expected: all commands exit zero.

