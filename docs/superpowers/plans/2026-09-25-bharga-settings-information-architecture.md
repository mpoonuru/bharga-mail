# Bharga Settings Information Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single cluttered Settings page with a calm seven-destination settings workspace, a progressive account-connection flow, compact AI-provider editing, truthful account health, and a redacted diagnostics export.

**Architecture:** Keep `Settings` as the route owner and move each destination into a focused component under `components/settings/`. Use the existing account and AI store contracts, extending `AccountInfo` only with a last-successful-sync timestamp sourced from the existing `account_sync_state` table. Provider editing remains explicit per provider; privacy-preset persistence becomes immediate and reports failure locally. Diagnostics are assembled by a pure frontend redaction boundary and never include account IDs, email addresses, message content, provider labels, endpoints, or credentials.

**Tech Stack:** React 19, TypeScript, Zustand, Motion for React, Tailwind CSS v4 utility application, Vitest/jsdom, Tauri 2, Rust, rusqlite, Bun.

**Spec:** `docs/superpowers/specs/2026-09-23-bharga-enterprise-modernization-design.md`

## Global Constraints

- Use Bun for all frontend package and test commands.
- Add no runtime dependency and do not use `cn` or `cva`.
- Use dayjs for every frontend date/time operation.
- Preserve existing accounts, credentials, provider configuration, signatures, preferences, and mail.
- Do not change the SQLite schema; reuse `account_sync_state.last_sync_ts`.
- Do not expose credentials, account identifiers, email addresses, endpoints, recipient data, subjects, or message content through diagnostics.
- Start every new source or test file with a concise purpose comment.
- Keep browser preview functional and visibly labeled as preview.
- Use the shared motion policy; no entrance stagger, scale, lift, bounce, or decorative page transition.
- Desktop controls are at least 32 px where layout permits; narrow/touch controls are at least 44 px.
- All destructive account/provider actions use the shared Bharga `Modal`, never `window.confirm`.
- Leave the user-owned untracked `AGENTS.md` untouched.

## Review Focus

- A user changes sections with keyboard navigation at desktop and narrow widths; focus and the selected section remain synchronized without hidden content staying tabbable.
- A user with no accounts, one account, or many accounts always sees an unambiguous add-account action and never mistakes preview connectors for active desktop OAuth.
- A failed sync or failed account removal remains local to that account, exposes a next action, and never reports success early.
- A custom provider with an unsaved draft does not lose edits when another provider opens, and one provider's save/test state cannot disable another provider.
- Diagnostics generated from hostile or identifying account/provider values contain none of those values and remain valid JSON.

## Design Direction

**Color:** Reuse Bharga's semantic tokens: `--bg`, `--surface`, `--text`, `--text-2`, `--text-3`, `--border`, `--accent`, `--accent-soft`, `--good`, and `--danger`. Do not add a decorative gradient or a settings-only palette.

**Type:** Respect the user's configured Bharga font. Use a 22 px page title, 17 px destination title, 13–14 px control copy, and 12 px secondary status. Sentence case only; no tracked all-caps section eyebrows.

**Layout:** Treat Settings as a desktop preference inspector, not a dashboard of cards. Align all content left. Spend visual emphasis on the active destination and entity health; keep configuration rows flat and grouped.

```text
Desktop                              Narrow
┌─────────────┬───────────────────┐   ┌───────────────────────┐
│ Accounts    │ Accounts          │   │ Accounts Appearance → │
│ Appearance  │ ───────────────── │   ├───────────────────────┤
│ AI/privacy  │ Account health    │   │ Accounts              │
│ Signatures  │ [account row  ⋯]  │   │ [account row]         │
│ Security    │                   │   │ [Add account]         │
│ Diagnostics │ [Add account]     │   └───────────────────────┘
│ About       │                   │
└─────────────┴───────────────────┘
```

**Principles:** One primary action per destination; status before configuration; details on request; no duplicated save authority; failures stay beside the affected entity. The deliberate distinction is Bharga's mail-client vocabulary—account health, privacy boundary, sync state, and role routing—rather than generic SaaS metric cards.

**Self-critique:** The first instinct was another stack of rounded cards, which would reproduce the current clutter and the generic SaaS-card pattern. This plan replaces those cards with a stable inspector rail and flat grouped rows; only modals and expanded provider editors receive bounded surfaces.

---

### Task 1: Persist and expose last successful account sync

**Files:**
- Modify: `app/src-tauri/src/store/mod.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src/types.ts`
- Modify: `app/src/data/mock.ts`
- Test: `app/src-tauri/src/store/mod.rs`
- Test: `app/src/data/mock.test.ts`

**Interfaces:**
- Produces: `AccountInfo.last_sync_at: Option<i64>` serialized as `lastSyncAt` Unix seconds.
- Produces: `Store::record_sync_success(account_id: &str, folder: &str, timestamp: i64) -> rusqlite::Result<()>`.
- Consumes: existing `account_sync_state(account_id, folder, last_sync_ts)` table and `sync_now` success result.

- [ ] **Step 1: Write the failing Rust account-health tests**

Add store tests that create an account, verify `last_sync_at` starts as `None`, record two folder successes, and verify `accounts()` returns the maximum timestamp:

```rust
#[test]
fn account_info_reports_latest_successful_sync() {
    let store = Store::in_memory().unwrap();
    store.upsert_account("imap:test@example.test", "test@example.test", "imap", "Test").unwrap();
    assert_eq!(store.accounts()[0].last_sync_at, None);

    store.record_sync_success("imap:test@example.test", "INBOX", 1_700_000_000).unwrap();
    store.record_sync_success("imap:test@example.test", "Archive", 1_700_000_100).unwrap();

    assert_eq!(store.accounts()[0].last_sync_at, Some(1_700_000_100));
}
```

- [ ] **Step 2: Run the focused Rust test and verify RED**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml account_info_reports_latest_successful_sync`

Expected: FAIL because `last_sync_at` and `record_sync_success` do not exist.

- [ ] **Step 3: Implement the store contract without a migration**

Extend `AccountInfo` and its query:

```rust
#[serde(rename = "lastSyncAt", default, skip_serializing_if = "Option::is_none")]
pub last_sync_at: Option<i64>,
```

```sql
SELECT a.id, a.email, a.provider, COALESCE(a.display_name,''),
       (SELECT COUNT(*) FROM threads t
        WHERE t.account_id = a.id AND t.unread = 1 AND t.deleted = 0),
       (SELECT NULLIF(MAX(s.last_sync_ts), 0)
        FROM account_sync_state s WHERE s.account_id = a.id)
FROM accounts a ORDER BY a.email
```

Add the write method using the existing table:

```rust
pub fn record_sync_success(
    &self,
    account_id: &str,
    folder: &str,
    timestamp: i64,
) -> rusqlite::Result<()> {
    let conn = self.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO account_sync_state (account_id, folder, last_sync_ts)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(account_id, folder)
         DO UPDATE SET last_sync_ts=excluded.last_sync_ts",
        params![account_id, folder, timestamp],
    )?;
    Ok(())
}
```

- [ ] **Step 4: Record only authoritative sync success**

Restructure `sync_now` so the provider operation completes first. After `result` is `Ok`, call `record_sync_success(&account_id, "INBOX", chrono::Utc::now().timestamp())`; if the timestamp write fails, return that error rather than claiming the sync is complete.

```rust
let result = if account_id.starts_with("ms:") {
    sync::microsoft::incremental(&state.store, &account_id).await.map(|_| 0)
} else if account_id.starts_with("imap:") {
    sync::imap::fetch_folder_async(
        state.store.clone(), account_id.clone(), "INBOX".into(), 75,
        group.unwrap_or(true), false,
    ).await
} else {
    sync::gmail::incremental(&state.store, &account_id).await.map(|_| 0)
}.map_err(|error| error.to_string())?;

state.store
    .record_sync_success(&account_id, "INBOX", chrono::Utc::now().timestamp())
    .map_err(|error| error.to_string())?;
Ok(result)
```

- [ ] **Step 5: Extend the frontend type and neutral preview data**

Add to `Account`:

```ts
/** Unix seconds for the most recent completed provider sync. */
lastSyncAt?: number;
```

Use a fixed neutral timestamp in mock data and add an open-source test assertion that mock account domains remain reserved.

- [ ] **Step 6: Verify and commit**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml account_info_reports_latest_successful_sync && bun run --cwd app test -- src/data/mock.test.ts`

Expected: PASS.

Commit:

```bash
git add app/src-tauri/src/store/mod.rs app/src-tauri/src/lib.rs app/src/types.ts app/src/data/mock.ts app/src/data/mock.test.ts
git commit -m "feat: expose account sync health"
```

---

### Task 2: Build the seven-destination settings shell

**Files:**
- Create: `app/src/components/settings/SettingsShell.tsx`
- Create: `app/src/components/settings/SettingsShell.test.tsx`
- Create: `app/src/test/render.tsx`
- Modify: `app/src/components/Settings.tsx`
- Modify: `app/src/styles.css`

**Interfaces:**
- Produces: `SettingsSection = "accounts" | "appearance" | "ai-privacy" | "signatures" | "security-data" | "diagnostics" | "about"`.
- Produces: `<SettingsShell active onChange>{children}</SettingsShell>` with a native navigation landmark and one visible panel.
- Consumes: the seven stable destinations defined by the enterprise-modernization spec.

- [ ] **Step 1: Write failing navigation tests**

Create a dependency-free React test helper using the project's existing `createRoot`/`act` pattern, then render the shell and assert the seven names, initial Accounts selection, click selection, ArrowDown/ArrowUp/Home/End movement, narrow-scrollable navigation class, and one visible panel:

```tsx
// app/src/test/render.tsx
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export function renderTest(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return {
    host,
    unmount: () => act(() => { root.unmount(); host.remove(); }),
  };
}

export function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("exposes seven keyboard-complete settings destinations", () => {
  const onChange = vi.fn();
  const { host } = renderTest(
    <SettingsShell active="accounts" onChange={onChange}><p>Accounts panel</p></SettingsShell>,
  );
  const buttons = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  expect(buttons.map((button) => button.textContent)).toEqual([
    "Accounts", "Appearance", "AI and privacy", "Signatures",
    "Security and data", "Diagnostics", "About",
  ]);
  act(() => buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  expect(onChange).toHaveBeenCalledWith("appearance");
});
```

- [ ] **Step 2: Run the shell test and verify RED**

Run: `bun run --cwd app test -- src/components/settings/SettingsShell.test.tsx`

Expected: FAIL because `SettingsShell` does not exist.

- [ ] **Step 3: Implement semantic section navigation**

Use a data array as the single label/icon/order source. Render `role="tablist" aria-label="Settings sections"`, native buttons with `role="tab"`, `aria-selected`, roving `tabIndex`, and `aria-controls="settings-panel"`. Arrow keys change section and focus the selected tab. Render one `role="tabpanel"` so inactive destinations are absent from the tab order.

```ts
export const SETTINGS_SECTIONS = [
  ["accounts", "Accounts", "inbox"],
  ["appearance", "Appearance", "sun"],
  ["ai-privacy", "AI and privacy", "ai"],
  ["signatures", "Signatures", "compose"],
  ["security-data", "Security and data", "shieldWarning"],
  ["diagnostics", "Diagnostics", "tasks"],
  ["about", "About", "settings"],
] as const;
```

- [ ] **Step 4: Convert `Settings` into an orchestrator**

Keep only route-level state (`activeSection`, account dialogs, app version) in `Settings`. The initial section is `accounts`. Render the page title once, then `SettingsShell`; dispatch the selected destination to focused components created by later tasks. During this task, move existing JSX into private section functions in `Settings.tsx` so behavior remains intact while only one section is visible.

- [ ] **Step 5: Implement the responsive visual system**

Desktop uses a quiet 208 px navigation rail and a content column capped at 880 px. Medium/narrow widths switch the rail to a horizontal, scrollable tab strip. Use the existing surface, text, border, and accent tokens; remove glass-card stacking from the settings workspace. No page entrance animation.

```css
.settings-layout { display:grid; grid-template-columns:208px minmax(0,880px); gap:28px; align-items:start; }
.settings-nav { position:sticky; top:18px; display:grid; gap:3px; }
.settings-nav button { min-height:36px; display:flex; align-items:center; gap:9px; border:0; border-radius:9px; padding:7px 10px; color:var(--text-2); background:transparent; text-align:left; }
.settings-nav button[aria-selected="true"] { color:var(--text); background:var(--accent-soft); }
.settings-panel { min-width:0; }
```

- [ ] **Step 6: Verify and commit**

Run: `bun run --cwd app test -- src/components/settings/SettingsShell.test.tsx && bun run --cwd app build`

Expected: PASS with no TypeScript errors.

Commit:

```bash
git add app/src/components/settings/SettingsShell.tsx app/src/components/settings/SettingsShell.test.tsx app/src/test/render.tsx app/src/components/Settings.tsx app/src/styles.css
git commit -m "refactor: organize settings by destination"
```

---

### Task 3: Redesign account management and connection

**Files:**
- Create: `app/src/components/settings/AccountSettings.tsx`
- Create: `app/src/components/settings/AccountSettings.test.tsx`
- Create: `app/src/components/settings/AccountRemovalDialog.tsx`
- Modify: `app/src/components/AccountForm.tsx`
- Create: `app/src/components/AccountForm.test.tsx`
- Modify: `app/src/components/Sidebar.tsx`
- Modify: `app/src/components/Settings.tsx`
- Modify: `app/src/styles.css`

**Interfaces:**
- Produces: `<AccountSettings />` as the Accounts destination owner.
- Produces: `<AccountRemovalDialog account onClose onRemoved />`, reused by Settings and Sidebar.
- Produces: two-step `AccountForm` with `details` then `servers`; its existing save/test payload remains unchanged.
- Consumes: `Account.lastSyncAt`, existing OAuth/IMAP bridge calls, and authoritative `removeAccount` store action.

- [ ] **Step 1: Write failing account-center tests**

Cover zero/many accounts, provider labels, dayjs-formatted last sync, per-account failure, add-account chooser, preview connector labeling, and removal confirmation:

```tsx
it("shows account health and opens one add-account chooser", async () => {
  useApp.setState({ accounts: [{
    id: "imap:work@example.test", email: "work@example.test", provider: "imap",
    displayName: "Work", unread: 4, lastSyncAt: 1_700_000_000,
  }] });
  const { host } = renderTest(<AccountSettings runtime="preview" />);
  expect(host.textContent).toContain("Work");
  expect(host.textContent).toContain("Last synced");
  const add = [...host.querySelectorAll("button")].find((button) => button.textContent === "Add account")!;
  act(() => add.click());
  expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-labelledby")).toBeTruthy();
  expect(document.body.textContent?.match(/Desktop app required/g)).toHaveLength(2);
});
```

```tsx
it("does not report account removal before the store succeeds", async () => {
  const account = {
    id: "imap:work@example.test", email: "work@example.test", provider: "imap" as const,
    displayName: "Work", unread: 0,
  };
  const removeAccount = vi.fn().mockRejectedValue(new Error("Credential cleanup failed"));
  useApp.setState({ removeAccount });
  renderTest(<AccountRemovalDialog account={account} onClose={vi.fn()} onRemoved={vi.fn()} />);
  const remove = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Remove account"))!;
  await act(async () => remove.click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Credential cleanup failed");
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
});
```

- [ ] **Step 2: Run account-center tests and verify RED**

Run: `bun run --cwd app test -- src/components/settings/AccountSettings.test.tsx`

Expected: FAIL because the account settings components do not exist.

- [ ] **Step 3: Implement calm account cards and one add action**

Each account card shows status dot, display name, address, provider, unread count, and last successful sync. At rest, actions are `Sync` and one overflow menu containing Edit (IMAP only) and Remove. `Add account` opens one modal with three choices: Gmail, Microsoft 365, and Other IMAP/SMTP. In preview mode OAuth choices remain visible but disabled and labeled `Desktop app required`; IMAP opens the local form.

Represent transient state per account:

```ts
type AccountOperation = {
  accountId: string;
  state: "syncing" | "success" | "error";
  message: string;
} | null;
```

Do not replace one account's card with a page-wide status. On successful sync, reload accounts before showing `Up to date`.

- [ ] **Step 4: Replace both browser-native removal confirmations**

Use `AccountRemovalDialog` from Account Settings and Sidebar. The dialog states that local mail and saved credentials are removed while server mail remains. Keep it open with an alert on failure; close only after `removeAccount` resolves and the store read-back no longer contains the account.

- [ ] **Step 5: Write failing two-step form tests**

Assert the first step contains only identity/password, invalid identity cannot advance, server fields appear after Continue, Back preserves values, editing permits a blank password, and Save & sync retains the existing bridge payload.

```tsx
it("progressively discloses server settings without losing account details", () => {
  const { host } = renderTest(<AccountForm onClose={vi.fn()} onStatus={vi.fn()} />);
  expect(host.querySelector('[aria-label="IMAP host"]')).toBeNull();
  setInputValue(host.querySelector('[aria-label="Email address"]')!, "me@example.test");
  act(() => [...host.querySelectorAll("button")].find((button) => button.textContent === "Continue")!.click());
  expect(host.querySelector('[aria-label="IMAP host"]')).not.toBeNull();
  act(() => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Back"))!.click());
  expect((host.querySelector('[aria-label="Email address"]') as HTMLInputElement).value).toBe("me@example.test");
});
```

- [ ] **Step 6: Run form tests and verify RED**

Run: `bun run --cwd app test -- src/components/AccountForm.test.tsx`

Expected: FAIL because the current form exposes server fields immediately and has no Continue/Back flow.

- [ ] **Step 7: Implement the two-step account form**

Step `details` shows email, display name, and a short privacy note. Step `servers` shows IMAP and SMTP hosts, ports, security, usernames and passwords, the same-credentials control, Test connection, Back, Cancel, and Save & sync. Never infer a server hostname: sending credentials to a guessed endpoint would violate the fail-closed trust model. Preserve edit-mode blank-password semantics. Use explicit `<label htmlFor>` relationships for every field and keep Save & sync disabled until both server hosts and required credentials are present.

- [ ] **Step 8: Verify and commit**

Run: `bun run --cwd app test -- src/components/settings/AccountSettings.test.tsx src/components/AccountForm.test.tsx src/components/Sidebar.test.ts && bun run --cwd app build`

Expected: PASS.

Commit:

```bash
git add app/src/components/settings/AccountSettings.tsx app/src/components/settings/AccountSettings.test.tsx app/src/components/settings/AccountRemovalDialog.tsx app/src/components/AccountForm.tsx app/src/components/AccountForm.test.tsx app/src/components/Sidebar.tsx app/src/components/Settings.tsx app/src/styles.css
git commit -m "refactor: simplify account settings flow"
```

---

### Task 4: Make AI and privacy progressive and unambiguous

**Files:**
- Create: `app/src/components/settings/AiPrivacySettings.tsx`
- Create: `app/src/components/settings/AiPrivacySettings.test.tsx`
- Modify: `app/src/components/AiProviderManager.tsx`
- Create: `app/src/components/AiProviderManager.test.tsx`
- Modify: `app/src/store.ts`
- Modify: `app/src/components/Settings.tsx`
- Modify: `app/src/styles.css`

**Interfaces:**
- Produces: `savePrivacy(privacy: AiProfile["privacy"]) -> Promise<void>` in the app store.
- Produces: `addModel() -> string | null` so the new provider can open without guessing from render timing.
- Produces: compact provider cards with one expanded editor at a time.
- Consumes: existing `saveAiProvider`, `testAiProvider`, `removeAiProvider`, and `setAiProfile` bridge boundaries.

- [ ] **Step 1: Write failing privacy-persistence tests**

Test that selecting a preset calls `setAiProfile` with the new value, rolls back on failure, and exposes a local alert instead of a page-wide global Save engine action.

```tsx
it("persists privacy immediately and restores the previous choice on failure", async () => {
  const profile = structuredClone(mockAiProfile);
  vi.spyOn(api, "setAiProfile").mockRejectedValue(new Error("Storage unavailable"));
  useApp.setState({ ai: profile });
  const { host } = renderTest(<AiPrivacySettings />);
  const local = host.querySelector<HTMLButtonElement>('[role="radio"][aria-label="Local"]')!;
  await act(async () => local.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Storage unavailable");
  expect(host.querySelector('[role="radio"][aria-label="Hybrid"]')?.getAttribute("aria-checked")).toBe("true");
});
```

- [ ] **Step 2: Run privacy tests and verify RED**

Run: `bun run --cwd app test -- src/components/settings/AiPrivacySettings.test.tsx`

Expected: FAIL because immediate persistence and rollback do not exist.

- [ ] **Step 3: Implement `savePrivacy` and the AI/privacy destination**

Store behavior:

```ts
savePrivacy: async (privacy) => {
  const previous = get().ai;
  if (!previous) return;
  const next = { ...previous, privacy };
  set({ ai: next });
  try {
    await api.setAiProfile(next);
  } catch (error) {
    set({ ai: previous });
    throw error;
  }
},
```

Change `addModel` to return the generated provider ID after the synchronous Zustand update:

```ts
addModel: () => {
  const ai = get().ai;
  if (!ai) return null;
  const id = crypto.randomUUID();
  const model: AiModel = {
    id, label: `Custom provider ${ai.models.length + 1}`,
    kind: "openai-compatible", roles: [], ready: false,
  };
  set({ ai: { ...ai, models: [...ai.models, model] } });
  return id;
},
```

Render Privacy mode first, provider management second, and semantic index third. Remove `Save engine`; each provider keeps only Test connection and Save changes.

- [ ] **Step 4: Write failing provider-disclosure tests**

Assert provider cards show name/kind/status/role summary at rest, only one editor is expanded, opening a second card preserves the first draft, and Escape/caret controls keep `aria-expanded` and hidden content synchronized.

```tsx
it("keeps providers compact and expands one editor without losing drafts", () => {
  const { host } = renderTest(<AiProviderManager />);
  const first = host.querySelector<HTMLButtonElement>('[aria-label^="Edit Claude"]')!;
  const second = host.querySelector<HTMLButtonElement>('[aria-label^="Edit Llama"]')!;
  expect(first.getAttribute("aria-expanded")).toBe("false");
  act(() => first.click());
  setInputValue(host.querySelector('[aria-label="Provider name"]')!, "Work Claude");
  act(() => second.click());
  act(() => first.click());
  expect((host.querySelector('[aria-label="Provider name"]') as HTMLInputElement).value).toBe("Work Claude");
});
```

- [ ] **Step 5: Run provider tests and verify RED**

Run: `bun run --cwd app test -- src/components/AiProviderManager.test.tsx`

Expected: FAIL because every provider editor is currently expanded.

- [ ] **Step 6: Implement single-disclosure provider cards**

Keep per-provider drafts in the existing keyed map and add `expandedId`. The summary button is native, owns `aria-expanded`, and references an editor region. The editor uses the 160 ms disclosure token with opacity and height only; reduced motion removes height interpolation. `Add provider` creates and opens the new provider. Test/save/remove busy states remain scoped by provider ID.

- [ ] **Step 7: Verify and commit**

Run: `bun run --cwd app test -- src/components/settings/AiPrivacySettings.test.tsx src/components/AiProviderManager.test.tsx src/store.test.ts && bun run --cwd app build`

Expected: PASS.

Commit:

```bash
git add app/src/components/settings/AiPrivacySettings.tsx app/src/components/settings/AiPrivacySettings.test.tsx app/src/components/AiProviderManager.tsx app/src/components/AiProviderManager.test.tsx app/src/store.ts app/src/components/Settings.tsx app/src/styles.css
git commit -m "refactor: simplify AI privacy settings"
```

---

### Task 5: Add focused appearance, signatures, security, diagnostics, and about destinations

**Files:**
- Create: `app/src/components/settings/AppearanceSettings.tsx`
- Create: `app/src/components/settings/SignatureSettings.tsx`
- Create: `app/src/components/settings/SecurityDataSettings.tsx`
- Create: `app/src/components/settings/DiagnosticsSettings.tsx`
- Create: `app/src/components/settings/DiagnosticsSettings.test.tsx`
- Create: `app/src/lib/diagnostics.ts`
- Create: `app/src/lib/diagnostics.test.ts`
- Modify: `app/src/components/settings/AboutSettings.tsx`
- Modify: `app/src/components/Settings.tsx`
- Modify: `app/src/styles.css`

**Interfaces:**
- Produces: `buildRedactedDiagnostics(input: DiagnosticsInput): DiagnosticsSnapshot`.
- Produces: `serializeDiagnostics(snapshot: DiagnosticsSnapshot): string`.
- Consumes: runtime/version, preference values, account provider/status counts, AI provider kind/readiness/role names, and thread/task counts.

- [ ] **Step 1: Write failing diagnostics redaction tests**

Use hostile identifying input and assert exact output keys plus absence of every sensitive value:

```ts
it("exports useful diagnostics without identifiers or content", () => {
  const snapshot = buildRedactedDiagnostics({
    version: "0.1.3",
    runtime: "desktop",
    accounts: [{ id: "secret-id", email: "person@company.test", provider: "imap", displayName: "Finance", unread: 7 }],
    models: [{ id: "private-provider", label: "Company endpoint", kind: "custom", ready: true, endpoint: "https://private.test", roles: ["draft"] }],
    preferences: { theme: "dark", density: "cozy", font: "inter", locale: "en" },
    threadCount: 18,
    taskCount: 3,
  });
  const json = serializeDiagnostics(snapshot);
  expect(JSON.parse(json).accounts).toEqual({ total: 1, byProvider: { imap: 1 } });
  for (const secret of ["secret-id", "person@company.test", "Finance", "private-provider", "Company endpoint", "private.test"]) {
    expect(json).not.toContain(secret);
  }
});
```

- [ ] **Step 2: Run diagnostics tests and verify RED**

Run: `bun run --cwd app test -- src/lib/diagnostics.test.ts`

Expected: FAIL because the redaction boundary does not exist.

- [ ] **Step 3: Implement the pure diagnostics boundary**

The snapshot contains only:

```ts
interface DiagnosticsSnapshot {
  schemaVersion: 1;
  app: { version: string; runtime: "desktop" | "preview" };
  accounts: { total: number; byProvider: Record<string, number>; synced: number };
  ai: { providers: number; ready: number; roleCoverage: Record<AiRole, number> };
  preferences: { theme: string; density: string; font: string; locale: string };
  localData: { threads: number; tasks: number };
}
```

Do not include a timestamp, because it adds no diagnostic value and creates a date/time handling branch. `serializeDiagnostics` uses stable two-space JSON formatting.

- [ ] **Step 4: Build the five focused destinations**

- Appearance owns theme, density, font, locale, conversation grouping, and smart highlights.
- Signatures owns the existing `SignatureManager` and introductory copy.
- Security and data states: credentials are AES-256-GCM encrypted under one OS-keychain master key; message content is stored locally and is not claimed as fully encrypted; remote images are blocked by default; telemetry is not enabled.
- Diagnostics shows a human-readable summary plus `Copy redacted diagnostics` and `Download JSON`. Copy reports success/failure through `role="status"`/`role="alert"`. Download creates a Blob only after a direct user click and revokes its object URL.
- About retains runtime-derived version and Preview runtime marker.

- [ ] **Step 5: Write and run diagnostics component tests**

Test copy success, clipboard failure, JSON download filename `bharga-diagnostics.json`, and the preview marker. Mock only Clipboard and object-URL browser boundaries.

Run: `bun run --cwd app test -- src/components/settings/DiagnosticsSettings.test.tsx src/components/settings/AboutSettings.test.tsx`

Expected: PASS after implementation.

- [ ] **Step 6: Remove obsolete settings presentation**

Delete the old section-label paragraphs, global stacked cards, inline layout styles, and dead Save engine state from `Settings.tsx`. Keep generic `.card` styles for Calendar/Tasks only; settings components use `.settings-group`, `.settings-row`, and `.settings-callout` with restrained borders and no repeated shadows.

- [ ] **Step 7: Verify and commit**

Run: `bun run --cwd app test -- src/lib/diagnostics.test.ts src/components/settings/DiagnosticsSettings.test.tsx src/components/settings/AboutSettings.test.tsx && bun run --cwd app build`

Expected: PASS.

Commit:

```bash
git add app/src/components/settings app/src/lib/diagnostics.ts app/src/lib/diagnostics.test.ts app/src/components/Settings.tsx app/src/styles.css
git commit -m "feat: complete focused settings destinations"
```

---

### Task 6: Full acceptance, visual review, and branch review

**Files:**
- Modify only if a failing acceptance check requires a product fix.
- Record execution evidence in this plan's ignored SDD ledger.

**Interfaces:**
- Consumes: all settings destinations and contracts from Tasks 1–5.
- Produces: a verified, review-ready settings modernization range.

- [ ] **Step 1: Run the complete automated gate**

Run:

```bash
bun run --cwd app test
bun run --cwd app build
bun run --cwd app check:version
bun run --cwd app check:open-source
cargo test --manifest-path app/src-tauri/Cargo.toml
cargo check --manifest-path app/src-tauri/Cargo.toml
git diff --check
```

Expected: every command exits 0 with no test failure or TypeScript/Rust error.

- [ ] **Step 2: Perform the desktop visual and keyboard walkthrough**

In the isolated in-app browser at 1440×900, verify light and dark themes:

- all seven destinations are visible without scrolling the entire settings document;
- Accounts is first and Add account is the single connection entry;
- account overflow, removal modal, sync feedback, and two-step IMAP flow are readable;
- provider summaries are compact and only one editor expands;
- Copy diagnostics shows confirmation;
- every section is reachable with keyboard only and focus is always visible.

- [ ] **Step 3: Perform the narrow and reduced-motion walkthrough**

At 390×844, verify the destination strip scrolls horizontally, no panel creates page-level horizontal overflow, every required target measures at least 44×44 px, dialogs fit the viewport, and provider/account content wraps without truncating actions. Emulate reduced motion and verify no layout translation, scale, stagger, or disclosure bounce remains.

- [ ] **Step 4: Audit the final diff**

Confirm:

```bash
git status --short
git diff --check
rg -n "window\.confirm|Save engine|itmanagement@pjtelesoft\.de" app/src app/src-tauri/src
```

Expected: only the user-owned untracked `AGENTS.md` remains; no browser-native confirmation, obsolete Save engine copy, or private organization default exists.

- [ ] **Step 5: Request one whole-range independent review**

Review the complete implementation range against this plan and the enterprise-modernization spec. Grade security, lifecycle truthfulness, keyboard/focus behavior, redaction, responsive layout, and regression coverage. Fix every Critical or Important finding with a new RED→GREEN cycle, rerun the complete gate, and request re-review.

- [ ] **Step 6: Push after the review is clean**

Push `feature/enterprise-modernization` to its existing upstream only after the reviewer reports no Critical or Important findings and the final automated gate is fresh and green.
