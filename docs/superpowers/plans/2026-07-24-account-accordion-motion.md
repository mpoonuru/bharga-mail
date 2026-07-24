# Account Disclosure Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sidebar account accordion's competing measured-height and layout animations with one restrained CSS-grid disclosure.

**Architecture:** Keep Motion's `Reorder.Item` only for account drag ordering. Keep every account's folder disclosure mounted, transition its grid row from `0fr` to `1fr`, and use `inert` plus `aria-hidden` while collapsed. Drive the CSS timing through exported TypeScript constants so the motion contract has one source of truth and a focused regression test.

**Tech Stack:** React 19, TypeScript 5.9, CSS Grid, Motion Reorder, Vitest, Bun, Tauri 2

## Global Constraints

- Expansion duration is exactly 180 ms.
- Chevron duration is exactly 160 ms.
- Easing is exactly `cubic-bezier(0.2, 0.8, 0.2, 1)`.
- Content offset is exactly two pixels.
- No spring, bounce, stagger, measured `height: auto`, or disclosure layout transform.
- Drag-to-reorder behavior and every folder callback remain unchanged.
- Collapsed folder controls are excluded from assistive technology and keyboard navigation.
- Reduced-motion preferences collapse the transition duration.
- Bun is the only package manager used for verification and builds.

---

### Task 1: Replace the competing disclosure animations

**Files:**
- Modify: `app/src/components/Sidebar.test.ts`
- Modify: `app/src/components/Sidebar.tsx`
- Modify: `app/src/styles.css`

**Interfaces:**
- Consumes: `selectedAccountId`, existing `Reorder.Item`, and the existing folder-tree markup.
- Produces: `ACCOUNT_DISCLOSURE_MOTION`, a read-only timing contract with `durationMs`, `caretDurationMs`, `easing`, and `offsetPx`.

- [ ] **Step 1: Write the failing motion-contract test**

Replace the existing spring/tween assertion in `app/src/components/Sidebar.test.ts` with:

```ts
import { describe, expect, it } from "vitest";

import { ACCOUNT_DISCLOSURE_MOTION } from "@/components/Sidebar";

describe("mail account disclosure motion", () => {
  it("uses a restrained CSS-grid timing contract", () => {
    expect(ACCOUNT_DISCLOSURE_MOTION).toEqual({
      durationMs: 180,
      caretDurationMs: 160,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      offsetPx: 2,
    });
    expect(ACCOUNT_DISCLOSURE_MOTION).not.toHaveProperty("type");
  });
});
```

- [ ] **Step 2: Run the focused test and verify the red state**

Run:

```bash
cd app
bun run test -- src/components/Sidebar.test.ts
```

Expected: FAIL because `ACCOUNT_DISCLOSURE_MOTION` is not exported.

- [ ] **Step 3: Add the disclosure contract and CSS variables**

In `app/src/components/Sidebar.tsx`, import the `CSSProperties` type and replace `ACCOUNT_ACCORDION_TRANSITION` with:

```ts
export const ACCOUNT_DISCLOSURE_MOTION = {
  durationMs: 180,
  caretDurationMs: 160,
  easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  offsetPx: 2,
} as const;

type DisclosureStyle = CSSProperties & Record<`--${string}`, string>;

const ACCOUNT_DISCLOSURE_STYLE: DisclosureStyle = {
  "--account-disclosure-duration": `${ACCOUNT_DISCLOSURE_MOTION.durationMs}ms`,
  "--account-caret-duration": `${ACCOUNT_DISCLOSURE_MOTION.caretDurationMs}ms`,
  "--account-disclosure-ease": ACCOUNT_DISCLOSURE_MOTION.easing,
  "--account-disclosure-offset": `${ACCOUNT_DISCLOSURE_MOTION.offsetPx}px`,
};
```

- [ ] **Step 4: Replace the Motion accordion with mounted grid disclosure markup**

Remove `AnimatePresence`, remove the account-row `transition` prop, replace the animated caret with a normal span, and wrap the existing folder tree as follows:

```tsx
<span className="acct-caret" aria-hidden="true">
  <Icon name="caretRight" size={11} weight="bold" />
</span>
```

```tsx
<div
  className={`folder-disclosure${isFocused ? " expanded" : ""}`}
  style={ACCOUNT_DISCLOSURE_STYLE}
  aria-hidden={!isFocused}
  inert={!isFocused}
>
  <div className="folder-disclosure-clip">
    <div className="folder-tree">
      {/* Existing folder-tree contents stay unchanged. */}
    </div>
  </div>
</div>
```

- [ ] **Step 5: Implement the CSS-grid motion**

Replace `.folder-tree-motion` in `app/src/styles.css` with:

```css
.acct-caret {
  @apply inline-flex shrink-0 items-center justify-center text-text-3 opacity-50;
  transform: rotate(0deg);
  transform-origin: center;
  transition:
    transform var(--account-caret-duration, 160ms) var(--account-disclosure-ease, cubic-bezier(0.2, 0.8, 0.2, 1)),
    opacity 120ms ease-out;
  will-change: transform;
}
.acct-main[aria-expanded="true"] .acct-caret { transform: rotate(90deg); }
.folder-disclosure {
  display: grid;
  grid-template-rows: 0fr;
  min-width: 0;
  opacity: 0;
  transform: translateY(calc(-1 * var(--account-disclosure-offset, 2px)));
  transition:
    grid-template-rows var(--account-disclosure-duration, 180ms) var(--account-disclosure-ease, cubic-bezier(0.2, 0.8, 0.2, 1)),
    opacity 120ms ease-out,
    transform var(--account-disclosure-duration, 180ms) var(--account-disclosure-ease, cubic-bezier(0.2, 0.8, 0.2, 1));
}
.folder-disclosure.expanded {
  grid-template-rows: 1fr;
  opacity: 1;
  transform: translateY(0);
}
.folder-disclosure-clip {
  min-height: 0;
  overflow: hidden;
}
.folder-disclosure.expanded .folder-disclosure-clip {
  animation: account-disclosure-overflow var(--account-disclosure-duration, 180ms) step-end forwards;
}
@keyframes account-disclosure-overflow {
  to { overflow: visible; }
}
```

Extend the existing reduced-motion media query so `.folder-disclosure`,
`.acct-caret`, and `.folder-disclosure-clip` use a 1 ms duration and delay.

- [ ] **Step 6: Run the focused test and TypeScript build**

Run:

```bash
cd app
bun run test -- src/components/Sidebar.test.ts
bun run build
```

Expected: the focused test passes and Vite completes without TypeScript errors.

- [ ] **Step 7: Commit the implementation**

```bash
git add app/src/components/Sidebar.test.ts app/src/components/Sidebar.tsx app/src/styles.css
git commit -m "fix: refine account disclosure motion"
```

---

### Task 2: Verify the native interaction and publish the fix

**Files:**
- Modify only if generated previews are intentionally refreshed: `app/dist-single/index.html`, `Bharga Mail — UI preview.html`

**Interfaces:**
- Consumes: the disclosure implementation from Task 1.
- Produces: a verified unsigned macOS app bundle and a pushed `main` branch.

- [ ] **Step 1: Run all automated verification**

Run:

```bash
cd app
bun run test
bun run build
bun run check:open-source
cd src-tauri
cargo test
```

Expected: 56 or more frontend tests pass, 39 or more Rust tests pass, and both build and hygiene commands exit successfully.

- [ ] **Step 2: Build the unsigned native app with Bun**

Run from `app`:

```bash
bun run tauri build --bundles app --no-sign --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

Expected bundle:

```text
app/src-tauri/target/release/bundle/macos/Bharga Mail.app
```

- [ ] **Step 3: Exercise the original interaction**

Open the new bundle, expand the first, middle, and final account, collapse each,
and switch directly between two expanded accounts. Confirm:

- sibling rows move once in normal flow;
- there is no bounce, overshoot, height snap, or second settling motion;
- the chevron finishes with the disclosure;
- folder controls are absent from keyboard navigation while collapsed;
- dragging an account still reorders it.

- [ ] **Step 4: Inspect the final source state**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and no generated build metadata staged. Preserve the user-owned untracked `AGENTS.md`.

- [ ] **Step 5: Commit any intentional preview refresh and push**

If preview files changed intentionally:

```bash
git add "Bharga Mail — UI preview.html" app/dist-single/index.html
git commit -m "chore: refresh UI preview"
```

Then:

```bash
git push origin main
```

Expected: `main` is synchronized with `origin/main`.
