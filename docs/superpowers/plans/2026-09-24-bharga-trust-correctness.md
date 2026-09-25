# Bharga Trust and Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove mock identity from production mail flows, reduce macOS credential access to one master-key operation per process, and make every capability, privacy, and version claim truthful.

**Architecture:** Introduce a pure account-identity module consumed by the store and composer, then change the Rust secret path to encrypted-database-first with one process-cached Keychain master key and idempotent legacy-entry migration. Runtime capability and version information flow through the existing bridge so UI copy is derived rather than hardcoded.

**Tech Stack:** React 19, TypeScript, Zustand, Vitest, Tauri 2, Rust 1.77+, rusqlite, keyring, AES-256-GCM, Bun.

**Spec:** `docs/superpowers/specs/2026-09-23-bharga-enterprise-modernization-design.md`

## Global Constraints

- Use Bun exclusively for frontend package and verification commands.
- Use dayjs for date and time operations; do not introduce native `Date` usage.
- Use named imports; do not introduce `import * as`.
- Do not introduce `cn` or `cva`.
- Credentials, tokens, message content, and identifiers must never be logged.
- Existing accounts, provider configuration, signatures, preferences, and mail must remain readable.
- Security-sensitive operations fail closed and may not report success before read-back verification.
- Browser preview remains explorable but must be visibly identified as preview data.
- Do not add organization-specific defaults, addresses, endpoints, or attribution.

## Review Focus

- A reply in a thread belonging to a non-selected account must still send from the thread account; Task 1 pins this with `resolveSendAccountId` tests.
- Reply-all with duplicate recipients or case variants must exclude the user's address and return each other recipient once; Task 1 pins this with `replyRecipients` tests.
- A legacy Keychain credential with a failed encrypted-store write must remain in Keychain; Task 2 pins this with migration failure tests.
- A development browser preview must never present example calendar events as synchronized provider data; Task 3 pins this with capability-label component tests.
- A release whose package and Tauri versions diverge must fail verification instead of displaying either value silently; Task 4 pins this with the release-integrity script test.

---

### Task 1: Real account identity and fail-closed send routing

**Files:**
- Create: `app/src/lib/accountIdentity.ts`
- Create: `app/src/lib/accountIdentity.test.ts`
- Modify: `app/src/store.ts:1-10,722-740`
- Modify: `app/src/store.test.ts:95-115`
- Modify: `app/src/components/Stage.tsx:1-8,405-490`

**Interfaces:**
- Consumes: `Account`, `Thread`, and `Message` from `app/src/types.ts`.
- Produces: `resolveSendAccountId(input: SendAccountResolution): string`, `replyRecipients(input: ReplyRecipientInput): { to: string; cc: string }`, and `accountAddress(accounts: Account[], accountId: string): string`.

- [ ] **Step 1: Write failing identity tests**

```ts
import { describe, expect, it } from "vitest";
import { accountAddress, replyRecipients, resolveSendAccountId } from "@/lib/accountIdentity";

const accounts = [
  { id: "personal", email: "alex@example.com", provider: "imap" as const, displayName: "Alex" },
  { id: "work", email: "alex@company.test", provider: "microsoft" as const, displayName: "Alex Work" },
];

describe("account identity", () => {
  it("prefers the thread account over the selected account for replies", () => {
    expect(resolveSendAccountId({ accounts, explicitId: undefined, threadAccountId: "work", selectedId: "personal" })).toBe("work");
  });

  it("fails closed when no connected account can be resolved", () => {
    expect(() => resolveSendAccountId({ accounts: [], explicitId: undefined, threadAccountId: undefined, selectedId: undefined }))
      .toThrow("Choose a connected account before sending.");
  });

  it("does not accept an unknown explicit account", () => {
    expect(() => resolveSendAccountId({ accounts, explicitId: "missing", threadAccountId: undefined, selectedId: undefined }))
      .toThrow("The selected sending account is no longer connected.");
  });

  it("finds the real address for the thread account", () => {
    expect(accountAddress(accounts, "work")).toBe("alex@company.test");
  });

  it("excludes self and deduplicates reply-all recipients case-insensitively", () => {
    expect(replyRecipients({
      self: "alex@company.test",
      sender: "person@example.net",
      to: ["Alex@Company.test", "team@example.net", "TEAM@example.net"],
      cc: ["audit@example.net", "person@example.net"],
    })).toEqual({ to: "person@example.net, team@example.net", cc: "audit@example.net" });
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd app && bun run test -- src/lib/accountIdentity.test.ts`

Expected: FAIL because `@/lib/accountIdentity` does not exist.

- [ ] **Step 3: Implement the pure identity module**

```ts
import type { Account } from "@/types";

export interface SendAccountResolution {
  accounts: Account[];
  explicitId?: string;
  threadAccountId?: string;
  selectedId?: string | null;
}

export interface ReplyRecipientInput {
  self: string;
  sender: string;
  to: string[];
  cc: string[];
}

export function accountAddress(accounts: Account[], accountId: string): string {
  const account = accounts.find((candidate) => candidate.id === accountId);
  if (!account) throw new Error("The message account is no longer connected.");
  return account.email.trim().toLowerCase();
}

export function resolveSendAccountId(input: SendAccountResolution): string {
  const candidate = input.explicitId ?? input.threadAccountId ?? input.selectedId ?? (input.accounts.length === 1 ? input.accounts[0].id : undefined);
  if (!candidate) throw new Error("Choose a connected account before sending.");
  if (!input.accounts.some((account) => account.id === candidate)) {
    throw new Error("The selected sending account is no longer connected.");
  }
  return candidate;
}

export function replyRecipients(input: ReplyRecipientInput): { to: string; cc: string } {
  const self = input.self.trim().toLowerCase();
  const seen = new Set<string>();
  const unique = (values: string[]) => values.filter((value) => {
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === self || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
  const to = unique([input.sender, ...input.to]);
  const cc = unique(input.cc);
  return { to: to.join(", "), cc: cc.join(", ") };
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `cd app && bun run test -- src/lib/accountIdentity.test.ts`

Expected: PASS with five tests.

- [ ] **Step 5: Add store routing regression tests**

Import `afterEach` and `vi` from Vitest plus `api` from the bridge, restore
mocks after every test, and add these cases:

```ts
afterEach(() => vi.restoreAllMocks());

it("routes a reply through its thread account", async () => {
  const accounts = [
    { id: "personal", email: "alex@example.com", provider: "imap" as const, displayName: "Personal" },
    { id: "work", email: "alex@company.test", provider: "microsoft" as const, displayName: "Work" },
  ];
  const thread = { ...useApp.getState().threads[0], accountId: "work" };
  useApp.setState({ accounts, threads: [thread], selectedAccountId: "personal" });
  const send = vi.spyOn(api, "queueSend").mockResolvedValue("outbox-1");

  await useApp.getState().queueSend({ threadId: thread.id, to: "person@example.net", subject: "Re: test", body: "Hello" });

  expect(send).toHaveBeenCalledWith(expect.objectContaining({ accountId: "work" }));
});

it("refuses to send without a connected account", async () => {
  useApp.setState({ accounts: [], threads: [], selectedAccountId: null, undo: null });
  const send = vi.spyOn(api, "queueSend").mockResolvedValue("outbox-1");

  await expect(useApp.getState().queueSend({ to: "person@example.net", subject: "test", body: "Hello" }))
    .rejects.toThrow("Choose a connected account before sending.");
  expect(send).not.toHaveBeenCalled();
  expect(useApp.getState().undo).toBeNull();
});
```

- [ ] **Step 6: Run the store tests and verify RED**

Run: `cd app && bun run test -- src/store.test.ts`

Expected: FAIL because the store still uses the mock-derived `activeAccountId` fallback.

- [ ] **Step 7: Replace mock routing and composer identity**

Remove the `account` import and `activeAccountId` constant from `store.ts`. Call `resolveSendAccountId` using the explicit id, thread account id, selected account id, and current accounts. In `Stage.tsx`, select `accounts` from the store, derive `self` with `accountAddress(accounts, thread.accountId)`, and use `replyRecipients` for reply-all. Surface resolution failures through the composer's existing send error state and do not enqueue.

- [ ] **Step 8: Run focused and complete frontend tests**

Run: `cd app && bun run test -- src/lib/accountIdentity.test.ts src/store.test.ts`

Expected: PASS.

Run: `cd app && bun run test`

Expected: all frontend tests PASS.

- [ ] **Step 9: Commit**

```bash
git add app/src/lib/accountIdentity.ts app/src/lib/accountIdentity.test.ts app/src/store.ts app/src/store.test.ts app/src/components/Stage.tsx
git commit -m "fix: resolve real sending account identity"
```

### Task 2: One-unlock encrypted credential vault with legacy migration

**Files:**
- Modify: `app/src-tauri/src/sync/tokens.rs:1-190`
- Modify: `app/src-tauri/src/lib.rs:539-610`
- Test: `app/src-tauri/src/sync/tokens.rs` inline `#[cfg(test)]` module

**Interfaces:**
- Consumes: `Store::get_secret`, `Store::set_secret`, and `Store::delete_secret`.
- Produces: `save_secret(account_id: &str, kind: &str, value: &str) -> Result<(), String>`, `secret(account_id: &str, kind: &str) -> Option<String>`, and equivalent result-bearing OAuth/provider functions without returning secret values over IPC.

- [ ] **Step 1: Add failing policy tests for encrypted-first reads and safe migration**

Extract a private pure control-flow helper with injected closures:

```rust
fn resolve_secret<FReadLegacy, FPersist, FDeleteLegacy>(
    encrypted: Option<String>,
    read_legacy: FReadLegacy,
    persist: FPersist,
    delete_legacy: FDeleteLegacy,
) -> Option<String>
where
    FReadLegacy: FnOnce() -> Option<String>,
    FPersist: FnOnce(&str) -> bool,
    FDeleteLegacy: FnOnce(),
```

Add tests proving:

```rust
#[test]
fn encrypted_value_skips_legacy_keychain_read() {
    use std::cell::Cell;
    let legacy_reads = Cell::new(0);
    let value = resolve_secret(
        Some("encrypted-value".into()),
        || { legacy_reads.set(legacy_reads.get() + 1); Some("legacy".into()) },
        |_| false,
        || {},
    );
    assert_eq!(value.as_deref(), Some("encrypted-value"));
    assert_eq!(legacy_reads.get(), 0);
}

#[test]
fn legacy_value_is_deleted_only_after_verified_persist() {
    use std::cell::Cell;
    let deletes = Cell::new(0);
    let value = resolve_secret(
        None,
        || Some("legacy".into()),
        |candidate| candidate == "legacy",
        || deletes.set(deletes.get() + 1),
    );
    assert_eq!(value.as_deref(), Some("legacy"));
    assert_eq!(deletes.get(), 1);
}

#[test]
fn failed_persist_keeps_legacy_value() {
    use std::cell::Cell;
    let deletes = Cell::new(0);
    let value = resolve_secret(
        None,
        || Some("legacy".into()),
        |_| false,
        || deletes.set(deletes.get() + 1),
    );
    assert_eq!(value.as_deref(), Some("legacy"));
    assert_eq!(deletes.get(), 0);
}
```

- [ ] **Step 2: Run the focused Rust tests and verify RED**

Run: `cd app/src-tauri && cargo test sync::tokens::tests -- --nocapture`

Expected: FAIL because `resolve_secret` and its policy do not exist.

- [ ] **Step 3: Implement process-cached master-key access**

Add `static MASTER_KEY: OnceLock<Option<[u8; 32]>> = OnceLock::new();`. Split current key loading into `load_or_create_master_key() -> Option<[u8; 32]>` and make `master_key()` return a copied value from `MASTER_KEY.get_or_init` without querying Keychain again during the process lifetime. Never log keyring error contents.

Use an `Option` inside the lock so an unavailable Keychain is also cached and
does not repeatedly prompt:

```rust
static MASTER_KEY: OnceLock<Option<[u8; 32]>> = OnceLock::new();

fn master_key() -> Option<[u8; 32]> {
    *MASTER_KEY.get_or_init(load_or_create_master_key)
}
```

- [ ] **Step 4: Make encrypted storage authoritative**

Change writes to encrypt and persist to the database first, verify the ciphertext can be decrypted to the original value, then remove any legacy per-secret Keychain entry. Change reads to:

1. read and decrypt the database value;
2. return immediately when valid;
3. otherwise read the legacy per-secret Keychain entry once;
4. persist and verify the encrypted database copy;
5. delete the legacy entry only after verification;
6. return the legacy value for the current operation even if migration persistence fails.

Keep the master key as the only newly written Keychain item. Change secret-writing APIs to return `Result<(), String>` and propagate errors through IMAP account and provider save commands.

The pure migration helper must be:

```rust
fn resolve_secret<FReadLegacy, FPersist, FDeleteLegacy>(
    encrypted: Option<String>,
    read_legacy: FReadLegacy,
    persist: FPersist,
    delete_legacy: FDeleteLegacy,
) -> Option<String>
where
    FReadLegacy: FnOnce() -> Option<String>,
    FPersist: FnOnce(&str) -> bool,
    FDeleteLegacy: FnOnce(),
{
    if encrypted.is_some() {
        return encrypted;
    }
    let legacy = read_legacy()?;
    if persist(&legacy) {
        delete_legacy();
    }
    Some(legacy)
}
```

- [ ] **Step 5: Run credential tests and verify GREEN**

Run: `cd app/src-tauri && cargo test sync::tokens::tests -- --nocapture`

Expected: PASS with the three policy tests plus existing token tests.

- [ ] **Step 6: Run all Rust tests and compile checks**

Run: `cd app/src-tauri && cargo test`

Expected: all Rust tests PASS.

Run: `cd app/src-tauri && cargo check`

Expected: exit 0 with no compilation errors.

- [ ] **Step 7: Commit**

```bash
git add app/src-tauri/src/sync/tokens.rs app/src-tauri/src/lib.rs
git commit -m "fix: unlock encrypted credential vault once"
```

### Task 3: Truthful calendar preview and runtime version

**Files:**
- Modify: `app/vite.config.ts:1-30`
- Modify: `app/src/vite-env.d.ts`
- Modify: `app/src/lib/bridge.ts:1-190`
- Modify: `app/src/lib/bridge.test.ts`
- Modify: `app/src/components/CalendarView.tsx`
- Create: `app/src/components/CalendarView.test.tsx`
- Modify: `app/src/components/Settings.tsx:12-16,221-229`
- Create: `app/src/components/settings/AboutSettings.tsx`
- Create: `app/src/components/settings/AboutSettings.test.tsx`

**Interfaces:**
- Consumes: Tauri `getVersion()`, `api.listEvents()`, and the Vite compile-time `__APP_VERSION__` fallback.
- Produces: `api.getAppVersion(): Promise<string>`, `runtimeMode(): "desktop" | "preview"`, and `AboutSettings({ version, runtime })` capability-labelled UI.

- [ ] **Step 1: Add failing bridge version tests**

```ts
it("reports the package version in browser preview", async () => {
  expect(await api.getAppVersion()).toBe("0.1.3");
});

it("identifies the browser runtime as preview", () => {
  expect(runtimeMode()).toBe("preview");
});
```

- [ ] **Step 2: Add failing calendar capability test**

Render with React's existing DOM test utilities and assert the capability copy:

```ts
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { CalendarView } from "@/components/CalendarView";

let host: HTMLDivElement | null = null;
afterEach(() => { host?.remove(); host = null; });

describe("CalendarView", () => {
  it("labels example events as preview data", async () => {
    host = document.createElement("div");
    document.body.append(host);
    await act(async () => createRoot(host!).render(<CalendarView />));
    expect(host.textContent).toContain("Calendar preview");
    expect(host.textContent).toContain("Example events");
    expect(host.textContent).not.toContain("Unified — Google, Microsoft 365 & CalDAV");
  });
});
```

- [ ] **Step 3: Run the tests and verify RED**

Run: `cd app && bun run test -- src/lib/bridge.test.ts src/components/CalendarView.test.tsx`

Expected: FAIL because the runtime/version APIs and truthful labels do not exist.

- [ ] **Step 4: Inject and expose the package version**

In `vite.config.ts`, use the named `readFileSync` import from `node:fs`, parse `package.json`, and add `__APP_VERSION__: JSON.stringify(packageJson.version)` to `define`. Declare `__APP_VERSION__` in `vite-env.d.ts`. Add `runtimeMode` and `api.getAppVersion`; desktop uses `getVersion` from `@tauri-apps/api/app`, preview returns `__APP_VERSION__`.

While touching the bridge, replace the namespace mock import with named imports
and replace the preview outbox identifier's native `Date.now()` call with
`dayjs().valueOf()` so the edited path obeys repository import and time rules.

- [ ] **Step 5: Replace direct calendar mock usage**

Load events through `api.listEvents()`. In preview mode render a persistent `Preview` badge, the heading `Calendar preview`, and explanatory copy: `Example events show the planned calendar experience. No calendar provider is connected.` In desktop mode with no real provider support, render the same capability status rather than claiming synchronization.

- [ ] **Step 6: Derive About version from the bridge**

Create a focused presentation component and test its rendered behavior:

```tsx
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AboutSettings } from "@/components/settings/AboutSettings";

let host: HTMLDivElement | null = null;
afterEach(() => { host?.remove(); host = null; });

describe("AboutSettings", () => {
  it("renders the runtime version, creator credit, and contributor credit", async () => {
    host = document.createElement("div");
    document.body.append(host);
    await act(async () => createRoot(host!).render(<AboutSettings version="0.1.3" runtime="preview" />));
    expect(host.textContent).toContain("Version 0.1.3");
    expect(host.textContent).toContain("Created by");
    expect(host.textContent).toContain("Arjun P");
    expect(host.textContent).toContain("Maintained with");
    expect(host.textContent).toContain("Bharga Mail contributors");
    expect(host.textContent).toContain("Preview runtime");
  });
});
```

Run the test before creating the component and verify that it fails because the
module is missing. Then create `AboutSettings`, load `api.getAppVersion()` in
Settings, and pass the resolved version plus `runtimeMode()`. The preview label
is rendered only when runtime is `preview`.

- [ ] **Step 7: Run focused and complete frontend tests**

Run: `cd app && bun run test -- src/lib/bridge.test.ts src/components/CalendarView.test.tsx src/components/settings/AboutSettings.test.tsx`

Expected: PASS.

Run: `cd app && bun run test`

Expected: all frontend tests PASS.

- [ ] **Step 8: Commit**

```bash
git add app/vite.config.ts app/src/vite-env.d.ts app/src/lib/bridge.ts app/src/lib/bridge.test.ts app/src/components/CalendarView.tsx app/src/components/CalendarView.test.tsx app/src/components/Settings.tsx app/src/components/settings/AboutSettings.tsx app/src/components/settings/AboutSettings.test.tsx
git commit -m "fix: report runtime capabilities truthfully"
```

### Task 4: Privacy, release, and version integrity

**Files:**
- Create: `scripts/check-version-integrity.mjs`
- Create: `scripts/check-version-integrity.test.mjs`
- Modify: `app/package.json:8-18`
- Modify: `README.md:25-55`
- Modify: `ARCHITECTURE.md:30-40,250-275`
- Modify: `app/src-tauri/ARCHITECTURE.md:80-122`

**Interfaces:**
- Consumes: versions from `app/package.json`, `app/src-tauri/tauri.conf.json`, and `app/src-tauri/Cargo.toml`.
- Produces: `bun run check:version` and public documentation that distinguishes credential encryption, local plaintext message storage, and signed/notarized release status.

- [ ] **Step 1: Write the failing version-integrity test**

Use Bun's test runner and temporary directories:

```js
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVersions } from "./check-version-integrity.mjs";

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixtures(packageVersion, tauriVersion, cargoVersion) {
  const dir = mkdtempSync(join(tmpdir(), "bharga-version-"));
  dirs.push(dir);
  const packageJson = join(dir, "package.json");
  const tauriJson = join(dir, "tauri.json");
  const cargoToml = join(dir, "Cargo.toml");
  writeFileSync(packageJson, JSON.stringify({ version: packageVersion }));
  writeFileSync(tauriJson, JSON.stringify({ version: tauriVersion }));
  writeFileSync(cargoToml, `[package]\nname = "fixture"\nversion = "${cargoVersion}"\n`);
  return { packageJson, tauriJson, cargoToml };
}

describe("checkVersions", () => {
  it("rejects divergent package versions", () => {
    expect(() => checkVersions(fixtures("0.1.3", "0.1.2", "0.1.3"))).toThrow("Version mismatch");
  });

  it("returns the shared version", () => {
    expect(checkVersions(fixtures("0.1.3", "0.1.3", "0.1.3"))).toBe("0.1.3");
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `cd app && bun test ../scripts/check-version-integrity.test.mjs`

Expected: FAIL because the integrity script does not exist.

- [ ] **Step 3: Implement the integrity script**

Use named imports from `node:fs` and `node:path`. Parse JSON directly and extract the Cargo package version with a bounded regular expression scoped to `[package]`. Export `checkVersions`; when invoked directly, print only `Version {version} is consistent.` and exit non-zero on mismatch. Do not print environment variables or file contents.

- [ ] **Step 4: Add the Bun script and verify GREEN**

Add `"check:version": "bun ../scripts/check-version-integrity.mjs"` to `app/package.json`.

Run: `cd app && bun test ../scripts/check-version-integrity.test.mjs && bun run check:version`

Expected: test PASS and `Version 0.1.3 is consistent.`

- [ ] **Step 5: Correct privacy and signing claims**

Document these exact boundaries:

- credentials and provider keys are encrypted with AES-256-GCM under an OS-Keychain master key;
- message bodies and contacts remain local but are not yet encrypted at rest;
- SQLCipher is a release-gate project with migration and recovery requirements;
- current public builds are ad-hoc signed and not Apple-notarized;
- enterprise-ready distribution requires macOS Developer ID notarization and Windows signing.

Remove any statement that says the full local mailbox is encrypted today.

- [ ] **Step 6: Run integrity and open-source checks**

Run: `cd app && bun run check:version && bun run check:open-source`

Expected: both commands exit 0 and no organization-specific findings are printed.

- [ ] **Step 7: Commit**

```bash
git add scripts/check-version-integrity.mjs scripts/check-version-integrity.test.mjs app/package.json README.md ARCHITECTURE.md app/src-tauri/ARCHITECTURE.md
git commit -m "docs: align privacy and release claims"
```

### Task 5: Phase verification and implementation handoff

**Files:**
- Modify only files required to fix failures found by the commands below.

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: a verified trust-and-correctness phase suitable as the base for the motion workstream.

- [ ] **Step 1: Run the complete frontend test suite**

Run: `cd app && bun run test`

Expected: all tests PASS with zero failures.

- [ ] **Step 2: Build the frontend**

Run: `cd app && bun run build`

Expected: TypeScript and Vite build exit 0.

- [ ] **Step 3: Run complete Rust verification**

Run: `cd app/src-tauri && cargo test && cargo check`

Expected: all tests PASS and check exits 0.

- [ ] **Step 4: Run repository integrity checks**

Run: `cd app && bun run check:version && bun run check:open-source`

Expected: both checks exit 0.

- [ ] **Step 5: Audit the diff for secrets and organization defaults**

Run: `git diff --check && git diff --name-only $(git merge-base main HEAD)..HEAD`

Expected: no whitespace errors; only planned source, test, script, and documentation files are listed. `AGENTS.md` remains untracked and absent from the diff.

- [ ] **Step 6: Commit verification-only corrections if any**

If verification changes source, stage each corrected path explicitly after
reviewing `git diff --name-only`, then commit with
`git commit -m "fix: close trust phase verification gaps"`. Skip the commit
when verification required no source corrections; never use `git add .`.
