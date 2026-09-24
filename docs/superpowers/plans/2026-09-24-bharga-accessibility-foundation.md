# Bharga Accessibility Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish dependable dialog focus behavior, complete keyboard activation for mail rows, and consistent visible focus and target sizing before restructuring the reading pane and settings.

**Architecture:** Add small framework-free focus and keyboard helpers under `app/src/lib`, then consume them from the existing `Modal`, `Stream`, and `Sidebar` components. Preserve the current component tree and motion policy; accessibility behavior is expressed through native focus, ARIA state, and component tests rather than a new UI dependency.

**Tech Stack:** React 19, TypeScript 5.9, Motion for React, Vitest/jsdom, Tailwind CSS v4, Bun.

**Spec:** `docs/superpowers/specs/2026-09-23-bharga-enterprise-modernization-design.md`

## Global Constraints

- Use Bun for every JavaScript dependency, script, build, and test command.
- Use dayjs for all date/time behavior; do not introduce native `Date` objects.
- Use named imports; do not introduce CommonJS `import * as` syntax.
- Do not add `cn`, `cva`, or another class-composition dependency.
- Preserve the shared motion policy and the operating-system reduced-motion preference.
- Do not change message routing, credential storage, provider persistence, or account deletion behavior.
- Every interactive element changed by this plan must expose a visible `:focus-visible` treatment.
- Desktop targets changed by this plan must be at least 32 px; narrow/touch targets must be at least 44 px; no required target may be smaller than 24 by 24 px.

## Review Focus

- A modal opened from a focused control moves focus inside, traps both Tab directions, and restores the exact opener after every close path; Task 1 tests button, Escape, and backward-wrap paths.
- A modal without a title still has an accessible name supplied by its caller; Task 1 makes `title` or `ariaLabel` a required union and tests the label-only path.
- A mail row activates exactly once for Enter or Space without stealing keyboard events from its nested conversation disclosure; Task 2 tests row and nested-control paths separately.
- Shift+F10 opens the same row actions as a pointer context menu at a stable in-row anchor; Task 2 tests the keyboard context-menu path.
- Touch-sized controls do not cause horizontal overflow at 390 by 844 pixels; Task 3 verifies the real light/dark responsive surfaces and records the live acceptance result.

---

### Task 1: Focus-safe modal contract

**Files:**
- Create: `app/src/lib/focus.ts`
- Create: `app/src/lib/focus.test.ts`
- Create: `app/src/components/ui/Modal.accessibility.test.tsx`
- Modify: `app/src/components/ui/Modal.tsx`
- Modify: `app/src/styles.css`

**Interfaces:**
- Produces: `focusableElements(container: HTMLElement): HTMLElement[]`
- Produces: `containTabKey(event: KeyboardEvent, container: HTMLElement): void`
- Produces: `Modal` props as a discriminated union requiring either `title: string` or `ariaLabel: string`
- Preserves: `open`, `onClose`, `children`, and `maxWidth` behavior used by existing callers

- [ ] **Step 1: Write failing focus-helper tests**

```ts
import { describe, expect, it } from "vitest";
import { containTabKey, focusableElements } from "@/lib/focus";

describe("dialog focus helpers", () => {
  it("excludes hidden and disabled controls", () => {
    const host = document.createElement("div");
    host.innerHTML = '<button>First</button><button disabled>Disabled</button><a href="#">Last</a>';
    expect(focusableElements(host).map((node) => node.textContent)).toEqual(["First", "Last"]);
  });

  it("wraps Shift+Tab from the first control to the last", () => {
    const host = document.createElement("div");
    host.innerHTML = '<button>First</button><button>Last</button>';
    document.body.append(host);
    const [first, last] = focusableElements(host);
    first.focus();
    const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true });
    containTabKey(event, host);
    expect(document.activeElement).toBe(last);
    host.remove();
  });
});
```

- [ ] **Step 2: Run the helper tests and verify the missing-module failure**

Run: `bun run --cwd app test -- app/src/lib/focus.test.ts`

Expected: FAIL because `@/lib/focus` does not exist.

- [ ] **Step 3: Implement the minimal focus helpers**

```ts
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter((node) => !node.hidden && node.getAttribute("aria-hidden") !== "true");
}

export function containTabKey(event: KeyboardEvent, container: HTMLElement): void {
  if (event.key !== "Tab") return;
  const items = focusableElements(container);
  if (items.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
```

- [ ] **Step 4: Write failing modal behavior tests**

Add tests that render an opener plus `Modal`, then assert:

```ts
expect(panel.getAttribute("role")).toBe("dialog");
expect(panel.getAttribute("aria-modal")).toBe("true");
expect(document.activeElement).toBe(closeButton);
```

Use DOM attribute assertions available in Vitest rather than adding a matcher package. Cover forward Tab wrap, backward Tab wrap, Escape close, backdrop close, focus restoration, and `ariaLabel="Attachment preview"` without a visible title.

- [ ] **Step 5: Run the modal tests and verify the semantic/focus failures**

Run: `bun run --cwd app test -- app/src/components/ui/Modal.accessibility.test.tsx`

Expected: FAIL because the panel has no dialog semantics, focus containment, initial focus, or restoration.

- [ ] **Step 6: Implement the modal contract**

Use `useId`, a panel ref, and an opener ref. On open, capture `document.activeElement`, focus the first focusable control after the portal commits, handle Tab through `containTabKey`, and restore the opener during cleanup only when it is still connected. Keep the existing capture-phase Escape listener and opacity-only transition.

```tsx
<motion.div
  ref={panelRef}
  className="modal-panel glass-card"
  role="dialog"
  aria-modal="true"
  aria-labelledby={title ? titleId : undefined}
  aria-label={title ? undefined : ariaLabel}
  tabIndex={-1}
>
```

Give the close button `type="button"` and `aria-label="Close dialog"`. Add `.modal-panel:focus-visible` and descendant focus-visible styles without changing backdrop behavior.

- [ ] **Step 7: Run focused and full frontend suites**

Run: `bun run --cwd app test -- app/src/lib/focus.test.ts app/src/components/ui/Modal.accessibility.test.tsx app/src/components/ui/motionContracts.test.tsx`

Expected: all focused tests PASS.

Run: `bun run --cwd app test`

Expected: all frontend tests PASS.

- [ ] **Step 8: Commit the focus-safe modal**

```bash
git add app/src/lib/focus.ts app/src/lib/focus.test.ts app/src/components/ui/Modal.tsx app/src/components/ui/Modal.accessibility.test.tsx app/src/styles.css
git commit -m "fix: make modal focus behavior accessible"
```

### Task 2: Complete keyboard behavior for mail rows

**Files:**
- Create: `app/src/lib/keyboard.ts`
- Create: `app/src/lib/keyboard.test.ts`
- Modify: `app/src/components/Stream.tsx`
- Modify: `app/src/components/Stream.test.tsx`
- Modify: `app/src/styles.css`

**Interfaces:**
- Produces: `isPrimaryActivationKey(key: string): boolean`
- Produces: `isKeyboardContextMenu(event: Pick<KeyboardEvent, "key" | "shiftKey">): boolean`
- Consumes: existing `selectThread`, context-menu, coarse-pointer drag, and conversation disclosure handlers
- Preserves: pointer click, right-click, touch swipe, selected state, and nested disclosure behavior

- [ ] **Step 1: Write failing keyboard-policy tests**

```ts
expect(isPrimaryActivationKey("Enter")).toBe(true);
expect(isPrimaryActivationKey(" ")).toBe(true);
expect(isPrimaryActivationKey("ArrowDown")).toBe(false);
expect(isKeyboardContextMenu({ key: "F10", shiftKey: true })).toBe(true);
expect(isKeyboardContextMenu({ key: "ContextMenu", shiftKey: false })).toBe(true);
```

- [ ] **Step 2: Run the policy tests and verify the missing-module failure**

Run: `bun run --cwd app test -- app/src/lib/keyboard.test.ts`

Expected: FAIL because `@/lib/keyboard` does not exist.

- [ ] **Step 3: Implement the keyboard policy**

```ts
export function isPrimaryActivationKey(key: string): boolean {
  return key === "Enter" || key === " ";
}

export function isKeyboardContextMenu(event: Pick<KeyboardEvent, "key" | "shiftKey">): boolean {
  return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
}
```

- [ ] **Step 4: Write failing rendered-row tests**

Extend `Stream.test.tsx` with integration tests that assert `.mail` and `.convo-kid` expose `role="button"` and `tabindex="0"`; Enter and Space call the row's open behavior once; Shift+F10 opens `.ctx-menu`; and Enter on `.convo-toggle` changes `aria-label` without opening the thread.

- [ ] **Step 5: Run the rendered-row tests and verify the keyboard failures**

Run: `bun run --cwd app test -- app/src/components/Stream.test.tsx`

Expected: FAIL because the main row is not focusable and the child row does not handle keyboard activation.

- [ ] **Step 6: Implement row semantics without invalid nested buttons**

Keep the outer row as the documented composite `role="button"` because it contains the real conversation-disclosure button. Add `tabIndex={0}`, `aria-label` built from sender, subject, preview, time, unread state, and trust verdict, plus an `onKeyDown` handler that:

```ts
if (event.target !== event.currentTarget) return;
if (isPrimaryActivationKey(event.key)) {
  event.preventDefault();
  onOpen();
} else if (isKeyboardContextMenu(event.nativeEvent)) {
  event.preventDefault();
  const rect = event.currentTarget.getBoundingClientRect();
  onContext(rect.left + 24, rect.top + 24);
}
```

Apply the same activation and keyboard context-menu contract to `ChildRow`. Add `aria-current={selected ? "true" : undefined}` and keep nested controls independently operable.

- [ ] **Step 7: Run focused and full frontend suites**

Run: `bun run --cwd app test -- app/src/lib/keyboard.test.ts app/src/components/Stream.test.tsx`

Expected: all focused tests PASS.

Run: `bun run --cwd app test`

Expected: all frontend tests PASS.

- [ ] **Step 8: Commit keyboard-complete mail rows**

```bash
git add app/src/lib/keyboard.ts app/src/lib/keyboard.test.ts app/src/components/Stream.tsx app/src/components/Stream.test.tsx app/src/styles.css
git commit -m "fix: make mail rows keyboard complete"
```

### Task 3: Visible focus and dependable target sizing

**Files:**
- Modify: `app/src/styles.css`
- Modify: `app/src/components/Sidebar.tsx`
- Modify: `app/src/components/Sidebar.test.ts`
- Modify: `app/src/components/ui/motionContracts.test.tsx`

**Interfaces:**
- Consumes: existing `.iconbtn`, `.af-btn`, `.nav-item`, `.mail`, `.convo-kid`, `.acct-drag`, `.order-toggle`, menu-item, chip, and form-control classes
- Preserves: the 90/140/160/200 ms motion tokens and reduced-motion behavior
- Produces: a shared `:focus-visible` ring using `--accent` and `--accent-soft`

- [ ] **Step 1: Write failing component regressions**

Extend the existing tests to assert that edit-order mode renders visible instructions, each drag handle references those instructions through `aria-describedby`, leaving edit mode removes the handles and instructions, and native icon buttons retain an empty inline `transform` after focus and click.

- [ ] **Step 2: Run the focused tests and verify the current edit-handle regression**

Run: `bun run --cwd app test -- app/src/components/Sidebar.test.ts app/src/components/ui/motionContracts.test.tsx`

Expected: the new discoverability expectation FAILS because edit mode has no visible instructions and the handles have no description relationship.

- [ ] **Step 3: Implement the focus and target system**

In `styles.css`:

- add one `:focus-visible` ring rule for buttons, links, inputs, selects, textareas, `[role="button"]`, and `[tabindex]:not([tabindex="-1"])`;
- keep destructive controls' danger color while retaining the same ring geometry;
- remove the remaining `.iconbtn:hover { transform: translateY(-1px) }` lift;
- show `.acct-drag` at readable opacity whenever edit-order mode renders it, not only on hover;
- render visible `account-order-instructions` copy while edit-order mode is active and connect every drag handle with `aria-describedby`;
- make desktop changed controls at least 32 px tall and required icon-only controls at least 24 by 24 px;
- under the existing narrow breakpoint, make changed controls at least 44 px tall without increasing compact read-only indicators;
- add `.mail:focus-visible` and `.convo-kid:focus-visible` selected-edge treatments that do not combine gradient, elevation, and border emphasis.

Do not use `transition: all`; enumerate color, border-color, background-color, and opacity properties.

- [ ] **Step 4: Run focused and full frontend suites**

Run: `bun run --cwd app test -- app/src/components/Sidebar.test.ts app/src/components/ui/motionContracts.test.tsx app/src/components/Stream.test.tsx`

Expected: all focused tests PASS.

Run: `bun run --cwd app test`

Expected: all frontend tests PASS.

- [ ] **Step 5: Verify real responsive behavior**

Run the app with `bun run --cwd app dev --host 127.0.0.1`, then verify at 1440 by 900 and 390 by 844 in light and dark themes:

- keyboard focus remains visible on sidebar, stream rows, nested row controls, toolbar controls, modal controls, and form fields;
- edit-order handles are visible without hover;
- no changed target is clipped or overlapped;
- the 390 px layout has no horizontal page overflow;
- reduced motion does not introduce transform feedback.

Expected: all acceptance checks PASS with screenshots captured in the task workspace, not committed to the repository.

- [ ] **Step 6: Commit the target and focus system**

```bash
git add app/src/styles.css app/src/components/Sidebar.tsx app/src/components/Sidebar.test.ts app/src/components/ui/motionContracts.test.tsx
git commit -m "refactor: standardize accessible interaction targets"
```

### Task 4: Accessibility-foundation release gate

**Files:**
- Modify only if a gate exposes a regression in a file changed by Tasks 1-3

**Interfaces:**
- Consumes: all Task 1-3 contracts
- Produces: a verified foundation for the later reading-hierarchy and settings-navigation plans

- [ ] **Step 1: Run frontend verification**

Run: `bun run --cwd app test && bun run --cwd app build && bun run --cwd app check:version && bun run --cwd app check:open-source`

Expected: every command exits 0 with no TypeScript errors and no organization-specific defaults.

- [ ] **Step 2: Run Rust regression verification**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml && cargo check --manifest-path app/src-tauri/Cargo.toml`

Expected: all Rust tests pass and `cargo check` exits 0.

- [ ] **Step 3: Audit the final diff**

Run: `git diff --check && git status --short --branch`

Expected: no whitespace errors, no generated build artifacts, and only the user-owned untracked `AGENTS.md` outside committed work.

- [ ] **Step 4: Commit any gate-driven correction**

If Step 1-3 required a correction, add only the affected files and commit with a narrow `fix:` message. If no correction was required, do not create an empty commit.
