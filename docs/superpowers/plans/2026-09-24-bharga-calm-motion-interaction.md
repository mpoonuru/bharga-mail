# Bharga Calm Motion and Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fragmented decorative animation with one restrained motion policy, a predictable account disclosure, non-animated routine inbox navigation, a single thread crossfade, and touch-only swipe actions.

**Architecture:** A small shared motion module owns every duration and easing used by Motion for React, while matching CSS custom properties own CSS transitions. `MotionProvider` applies the operating-system reduced-motion preference at the application root. Feature components consume those contracts rather than defining springs, scales, stagger, or arbitrary durations locally.

**Tech Stack:** React 19, TypeScript 5.9, Motion for React 12, Tailwind CSS 4 CSS-first styles, Zustand, Vitest 4, Bun.

**Spec:** `docs/superpowers/specs/2026-09-23-bharga-enterprise-modernization-design.md`

## Global Constraints

- Use Bun for every JavaScript package, test, build, and script command; do not use npm, pnpm, or Yarn.
- Use named imports; do not introduce CommonJS namespace imports.
- Do not add `cn`, `cva`, another animation library, or a new runtime dependency.
- Motion durations are exactly: instant 90 ms, standard 140 ms, disclosure 160 ms, and structural at most 200 ms.
- The shared easing is exactly `cubic-bezier(0.2, 0.8, 0.2, 1)` / `[0.2, 0.8, 0.2, 1]`.
- Springs remain limited to direct touch manipulation; routine buttons, menus, cards, disclosures, panes, and page changes do not scale, lift, bounce, or stagger.
- Browser preview remains clearly labeled and the trust/correctness behavior already established on this branch must not regress.
- Preserve the user-owned untracked `AGENTS.md` and avoid unrelated formatting or generated-file changes.

## Review Focus

- OS reduced-motion enabled: CSS transitions become effectively instant and Motion removes transform/layout animation while allowing an instant opacity change; covered in Task 1.
- Mouse/trackpad desktop versus touch/coarse pointer: horizontal mail drag is disabled for the former and enabled only for the latter; covered in Task 3.
- Repeated account, folder, filter, and search changes: existing mail rows never replay entrance or stagger animation; covered in Task 3.
- Rapid conversation selection: the newest selected thread renders immediately with a 120 ms opacity crossfade and never waits for the old thread to exit; covered in Task 4.
- Account expansion while entering/leaving edit-order mode: disclosure semantics stay synchronized and drag layout projection is active only during a real reorder gesture; covered in Task 2.

---

### Task 1: Shared Motion Policy and Reduced-Motion Root

**Files:**
- Create: `app/src/lib/motion.ts`
- Create: `app/src/lib/motion.test.ts`
- Create: `app/src/components/ui/MotionProvider.tsx`
- Create: `app/src/components/ui/MotionProvider.test.tsx`
- Modify: `app/src/main.tsx`
- Modify: `app/src/styles.css`

**Interfaces:**
- Produces: `MOTION`, `MOTION_EASE`, `THREAD_CROSSFADE`, `OVERLAY_FADE`, `STRUCTURAL_TRANSITION`, and `REDUCED_MOTION_POLICY`.
- Produces: `MotionProvider({ children }: PropsWithChildren)` as the only root-level Motion configuration.
- Consumes: no product state and no browser-only globals during module import.

- [ ] **Step 1: Write the failing motion-token tests**

```ts
// app/src/lib/motion.test.ts
import { describe, expect, it } from "vitest";
import {
  MOTION,
  MOTION_EASE,
  OVERLAY_FADE,
  STRUCTURAL_TRANSITION,
  THREAD_CROSSFADE,
} from "@/lib/motion";

describe("motion policy", () => {
  it("uses the approved durations and easing", () => {
    expect(MOTION).toEqual({ instant: 0.09, standard: 0.14, disclosure: 0.16, structural: 0.2 });
    expect(MOTION_EASE).toEqual([0.2, 0.8, 0.2, 1]);
    expect(THREAD_CROSSFADE).toMatchObject({ duration: 0.12, ease: MOTION_EASE });
    expect(OVERLAY_FADE.duration).toBe(MOTION.standard);
    expect(STRUCTURAL_TRANSITION.duration).toBeLessThanOrEqual(0.2);
  });

  it("does not define springs for routine transitions", () => {
    for (const transition of [THREAD_CROSSFADE, OVERLAY_FADE, STRUCTURAL_TRANSITION]) {
      expect(transition).not.toHaveProperty("stiffness");
      expect(transition).not.toHaveProperty("damping");
      expect(transition).not.toHaveProperty("bounce");
    }
  });
});
```

```tsx
// app/src/components/ui/MotionProvider.test.tsx
import { describe, expect, it } from "vitest";
import { REDUCED_MOTION_POLICY } from "@/components/ui/MotionProvider";

describe("MotionProvider", () => {
  it("delegates reduced motion to the operating-system preference", () => {
    expect(REDUCED_MOTION_POLICY).toBe("user");
  });
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cd app && bun run test -- src/lib/motion.test.ts src/components/ui/MotionProvider.test.tsx
```

Expected: FAIL because the new modules do not exist.

- [ ] **Step 3: Implement the shared policy and root provider**

```ts
// app/src/lib/motion.ts
// Shared motion contract for every routine Bharga interaction.
export const MOTION = {
  instant: 0.09,
  standard: 0.14,
  disclosure: 0.16,
  structural: 0.2,
} as const;

export const MOTION_EASE = [0.2, 0.8, 0.2, 1] as const;
export const THREAD_CROSSFADE = { duration: 0.12, ease: MOTION_EASE } as const;
export const OVERLAY_FADE = { duration: MOTION.standard, ease: MOTION_EASE } as const;
export const STRUCTURAL_TRANSITION = { duration: MOTION.structural, ease: MOTION_EASE } as const;
```

```tsx
// app/src/components/ui/MotionProvider.tsx
// Applies the user's operating-system motion preference to Motion for React.
import type { PropsWithChildren } from "react";
import { MotionConfig } from "motion/react";

export const REDUCED_MOTION_POLICY = "user" as const;

export function MotionProvider({ children }: PropsWithChildren) {
  return <MotionConfig reducedMotion={REDUCED_MOTION_POLICY}>{children}</MotionConfig>;
}
```

Wrap `<App />` inside `<MotionProvider>` in `app/src/main.tsx`. Add these exact root variables in `app/src/styles.css` and replace hardcoded routine transition durations as touched by later tasks:

```css
--motion-instant: 90ms;
--motion-standard: 140ms;
--motion-disclosure: 160ms;
--motion-structural: 200ms;
--ease: cubic-bezier(0.2, 0.8, 0.2, 1);
```

Keep the existing reduced-motion media query, but make its override explicit and uniform:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-delay: 0ms !important;
    animation-duration: 1ms !important;
    transition-delay: 0ms !important;
    transition-duration: 1ms !important;
    scroll-behavior: auto !important;
  }
}
```

- [ ] **Step 4: Run focused tests and the production type/build check**

Run:

```bash
cd app && bun run test -- src/lib/motion.test.ts src/components/ui/MotionProvider.test.tsx && bun run build
```

Expected: both test files pass and Vite completes without TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/motion.ts app/src/lib/motion.test.ts app/src/components/ui/MotionProvider.tsx app/src/components/ui/MotionProvider.test.tsx app/src/main.tsx app/src/styles.css
git commit -m "refactor: centralize interface motion policy"
```

---

### Task 2: Predictable Account Disclosure and Explicit Reordering

**Files:**
- Modify: `app/src/components/Sidebar.tsx`
- Modify: `app/src/components/Sidebar.test.ts`
- Modify: `app/src/styles.css`

**Interfaces:**
- Consumes: `MOTION.disclosure` and `MOTION_EASE` from Task 1.
- Produces: `accountDisclosureState(expanded: boolean)` returning synchronized `aria-hidden` and `inert` values.
- Produces: account ordering state in `Sidebar`; drag handles and Motion layout projection exist only while edit-order mode is active.

- [ ] **Step 1: Extend the sidebar tests for disclosure semantics and edit-order behavior**

Add these assertions to `app/src/components/Sidebar.test.ts`:

```ts
import { accountDisclosureState } from "@/components/Sidebar";

it("keeps disclosure accessibility state synchronized", () => {
  expect(accountDisclosureState(false)).toEqual({ ariaHidden: true, inert: true });
  expect(accountDisclosureState(true)).toEqual({ ariaHidden: false, inert: false });
});

it("uses the shared 160 ms disclosure policy", () => {
  expect(ACCOUNT_DISCLOSURE_MOTION.durationMs).toBe(160);
  expect(ACCOUNT_DISCLOSURE_MOTION.caretDurationMs).toBe(160);
  expect(ACCOUNT_DISCLOSURE_MOTION.easing).toBe("cubic-bezier(0.2, 0.8, 0.2, 1)");
});
```

Add this DOM test (and the corresponding named imports for `Sidebar`, `useApp`, `act`, and `createRoot`):

```ts
it("shows reorder controls only in explicit edit-order mode", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  useApp.setState({
    accounts: [
      { id: "a1", email: "one@example.test", provider: "imap", displayName: "One" },
      { id: "a2", email: "two@example.test", provider: "gmail", displayName: "Two" },
    ],
    accountOrder: [],
    selectedAccountId: null,
    threads: [],
  });

  act(() => root.render(<Sidebar />));
expect(container.querySelectorAll(".acct-drag")).toHaveLength(0);
  const editOrderButton = [...container.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === "Edit order");
  if (!(editOrderButton instanceof HTMLButtonElement)) throw new Error("Edit order button not found");
act(() => editOrderButton.click());
expect(container.querySelectorAll(".acct-drag")).toHaveLength(2);
expect(editOrderButton.textContent).toContain("Done");

  act(() => root.unmount());
});
```

- [ ] **Step 2: Run the sidebar test and verify RED**

Run:

```bash
cd app && bun run test -- src/components/Sidebar.test.ts
```

Expected: FAIL because disclosure remains 180 ms, the helper does not exist, and drag handles are always rendered.

- [ ] **Step 3: Simplify the stable account row**

In `Sidebar.tsx`:

- Change account disclosure duration to 160 ms and source the Motion easing/duration from `@/lib/motion`.
- Add `accountDisclosureState(expanded)` and spread its values onto `.folder-disclosure`.
- Remove the standalone `.acct-refresh` button; keep **Refresh folders** only inside the account overflow menu.
- Add an Accounts-section action toggling `orderEditing`, labeled **Edit order** at rest and **Done** while active.
- Render `.acct-drag` only when `orderEditing` is true.
- Set `Reorder.Item` drag controls and layout projection active only in edit-order mode and during an actual drag gesture.
- Keep the stable row to account status dot, name, unread count, caret, and overflow action.
- Keep folder children mounted for the CSS-grid disclosure; `aria-hidden` and `inert` change in the same render as `expanded`.

Use this helper contract:

```ts
export function accountDisclosureState(expanded: boolean) {
  return { ariaHidden: !expanded, inert: !expanded } as const;
}
```

Update `.folder-disclosure` to use `var(--motion-disclosure)` and remove the translate offset, leaving one grid-row/opacity disclosure plus one caret rotation. Remove `.acct-refresh` CSS and ensure overflow actions become visible on both hover and `:focus-within`.

- [ ] **Step 4: Run sidebar and full frontend tests**

Run:

```bash
cd app && bun run test -- src/components/Sidebar.test.ts && bun run test
```

Expected: sidebar tests pass and the full frontend suite remains green.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/Sidebar.tsx app/src/components/Sidebar.test.ts app/src/styles.css
git commit -m "refactor: simplify account disclosure controls"
```

---

### Task 3: Stable Inbox Rows and Touch-Only Swipe

**Files:**
- Create: `app/src/lib/pointer.ts`
- Create: `app/src/lib/pointer.test.ts`
- Create: `app/src/components/Stream.test.tsx`
- Modify: `app/src/components/Stream.tsx`
- Modify: `app/src/styles.css`

**Interfaces:**
- Produces: `useCoarsePointer(): boolean` and `mailDragAxis(coarse: boolean): "x" | false`.
- Consumes: no Motion entrance policy because routine row rendering must be static.
- Preserves: the existing swipe threshold of 90 px when the pointer is coarse.

- [ ] **Step 1: Write failing pointer-policy tests**

```ts
// app/src/lib/pointer.test.ts
import { describe, expect, it } from "vitest";
import { mailDragAxis } from "@/lib/pointer";

describe("mail row pointer policy", () => {
  it("disables horizontal drag for precise desktop pointers", () => {
    expect(mailDragAxis(false)).toBe(false);
  });

  it("enables horizontal drag for coarse touch pointers", () => {
    expect(mailDragAxis(true)).toBe("x");
  });
});
```

Add this source contract in `app/src/components/Stream.test.tsx`; it pins the absence of routine entrance/stagger code while pointer behavior is exercised separately:

```ts
// Guards routine list navigation from regaining decorative row entrances.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./Stream.tsx", import.meta.url), "utf8");

describe("Stream motion contract", () => {
  it("does not animate or stagger mail-row entry", () => {
    expect(source).not.toContain("Math.min(index * 0.035");
    expect(source).not.toContain("initial={quiet");
    expect(source).not.toContain("y: 8");
  });
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cd app && bun run test -- src/lib/pointer.test.ts src/components/Stream.test.tsx
```

Expected: FAIL because the pointer module and static-row component test do not exist.

- [ ] **Step 3: Implement coarse-pointer detection and remove routine row entrances**

```ts
// app/src/lib/pointer.ts
// Keeps gesture-only interactions off mouse and trackpad layouts.
import { useEffect, useState } from "react";

const COARSE_POINTER = "(pointer: coarse)";

export function mailDragAxis(coarse: boolean): "x" | false {
  return coarse ? "x" : false;
}

export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() =>
    typeof window !== "undefined" && window.matchMedia(COARSE_POINTER).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(COARSE_POINTER);
    const update = () => setCoarse(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return coarse;
}
```

In `Stream.tsx`:

- Remove `index` and `quiet` from `MailRow`.
- Remove row `initial`, `animate`, and staggered `transition` props.
- Keep `motion.div` only because touch drag needs Motion; pass `drag={mailDragAxis(coarsePointer)}`.
- Set `dragElastic={coarsePointer ? 0.35 : 0}` and ignore `onDragStart`/`onDragEnd` when `coarsePointer` is false.
- Keep existing rows visually fixed when account, folder, filter, sort, and search change.
- Use CSS color/background transitions capped at `var(--motion-standard)` for hover and selection.

- [ ] **Step 4: Run pointer, Stream, and full frontend tests**

Run:

```bash
cd app && bun run test -- src/lib/pointer.test.ts src/components/Stream.test.tsx && bun run test
```

Expected: focused and full suites pass; no row entrance/stagger contract remains.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/pointer.ts app/src/lib/pointer.test.ts app/src/components/Stream.tsx app/src/components/Stream.test.tsx app/src/styles.css
git commit -m "refactor: keep inbox navigation motionless"
```

---

### Task 4: One Thread Crossfade Without Child Animation

**Files:**
- Modify: `app/src/components/Stage.tsx`
- Create: `app/src/components/Stage.motion.test.tsx`
- Modify: `app/src/components/Compose.tsx`

**Interfaces:**
- Consumes: `THREAD_CROSSFADE` from Task 1.
- Produces: one keyed Stage container with opacity-only entry/exit and synchronous presence replacement.
- Preserves: message order, selected-message prioritization, attachment behavior, composer state, and trust indicators.

- [ ] **Step 1: Write the failing Stage motion test**

Use this source-level contract plus the shared token assertion in `app/src/components/Stage.motion.test.tsx`:

```ts
// Prevents the reading pane from regaining staggered child motion.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THREAD_CROSSFADE } from "@/lib/motion";

const source = readFileSync(new URL("./Stage.tsx", import.meta.url), "utf8");

describe("Stage motion contract", () => {
  it("uses one synchronous opacity crossfade", () => {
    expect(THREAD_CROSSFADE.duration).toBe(0.12);
    expect(source).toContain("<AnimatePresence initial={false}>");
    expect(source).toContain('initial={{ opacity: 0 }}');
    expect(source).toContain("transition={THREAD_CROSSFADE}");
    expect(source).not.toContain('mode="wait"');
    expect(source).not.toContain('className="ai-summary" initial=');
    expect(source).not.toContain('className={`msg${i > 0 ? " reply" : ""}`} key={m.id} style={i > 0 ? { marginLeft: Math.min(i, 5) * 30 } : undefined} initial=');
    expect(source).not.toContain("i * 0.06");
  });
});
```

- [ ] **Step 2: Run the Stage test and verify RED**

Run:

```bash
cd app && bun run test -- src/components/Stage.motion.test.tsx
```

Expected: FAIL because Stage uses `mode="wait"`, translation, 220 ms duration, a summary spring, and staggered message motion.

- [ ] **Step 3: Implement the single crossfade**

In `Stage.tsx`:

- Change `AnimatePresence mode="wait"` to synchronous presence with `initial={false}`.
- Animate only the keyed `.stage-inner` opacity using `THREAD_CROSSFADE`.
- Replace the AI summary `motion.div` with a plain `div`.
- Replace every message `motion.div` with a plain `div`; remove delays and translation.
- Do not change message ordering, content, reply composer logic, or attachment handling.

In `Compose.tsx`, replace the 220 ms translate entrance with the same opacity-only crossfade contract so opening a new draft does not slide the entire reading pane.

- [ ] **Step 4: Run Stage, Compose, and full frontend tests**

Run:

```bash
cd app && bun run test -- src/components/Stage.motion.test.tsx src/components/Compose.test.tsx && bun run test
```

Expected: all tests pass and rapid selection cannot be serialized behind an exit animation.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/Stage.tsx app/src/components/Stage.motion.test.tsx app/src/components/Compose.tsx
git commit -m "refactor: reduce reading pane motion to crossfade"
```

---

### Task 5: Remove Decorative Motion From Controls and Overlays

**Files:**
- Modify: `app/src/App.tsx`
- Modify: `app/src/components/CommandBar.tsx`
- Modify: `app/src/components/ModelPicker.tsx`
- Modify: `app/src/components/Sidebar.tsx`
- Modify: `app/src/components/ui/Button.tsx`
- Modify: `app/src/components/ui/IconButton.tsx`
- Modify: `app/src/components/ui/Modal.tsx`
- Modify: `app/src/components/ui/Checkbox.tsx`
- Create: `app/src/components/ui/motionContracts.test.tsx`
- Modify: `app/src/styles.css`

**Interfaces:**
- Consumes: `OVERLAY_FADE`, `STRUCTURAL_TRANSITION`, `MOTION`, and `MOTION_EASE` from Task 1.
- Produces: routine controls with CSS-only color/opacity feedback and overlays with opacity or short tweened structural movement only.
- Preserves: narrow-layout drawer behavior, modal dismissal, command-bar behavior, model selection, checkbox state, and disabled/loading states.

- [ ] **Step 1: Write failing control/overlay motion-contract tests**

Create this exact source contract in `app/src/components/ui/motionContracts.test.tsx`:

```ts
// Keeps routine controls and overlays free of decorative transform motion.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

describe("routine control motion contracts", () => {
  it("contains no hover lift, tap scale, or overlay spring", () => {
    const controls = [read("./Button.tsx"), read("./IconButton.tsx")].join("\n");
    const overlays = [
      read("../CommandBar.tsx"),
      read("../ModelPicker.tsx"),
      read("./Modal.tsx"),
    ].join("\n");
    expect(controls).not.toContain("whileHover");
    expect(controls).not.toContain("whileTap");
    expect(overlays).not.toContain('type: "spring"');
    expect(overlays).not.toContain("scale:");
    expect(overlays.match(/initial=\{\{ opacity: 0 \}\}/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cd app && bun run test -- src/components/ui/motionContracts.test.tsx
```

Expected: FAIL against the existing lift, scale, and spring props.

- [ ] **Step 3: Replace decorative motion with the shared policy**

- `Button` and `IconButton`: render native buttons without Motion hover/tap transforms; retain CSS color, border, and opacity feedback.
- `Sidebar`: remove lift/scale props from Compose and AI-engine buttons.
- `CommandBar`, `ModelPicker`, and `Modal`: use opacity-only entry/exit with `OVERLAY_FADE`; remove spring, scale, and translation.
- `Checkbox`: replace spring scale/path animation with an instant/standard opacity and path-length tween using `MOTION.instant` or `MOTION.standard`.
- `App`: change the desktop grid transition from 400 ms to `var(--motion-structural)`; use a 200 ms tween for programmatic narrow drawer open/close. Do not animate while the splitter is being directly dragged.
- `styles.css`: replace touched `.12s`, `.14s`, and `.15s` routine values with the corresponding variables and keep focus/disabled feedback intact.

- [ ] **Step 4: Run focused tests, full frontend tests, and build**

Run:

```bash
cd app && bun run test -- src/components/ui/motionContracts.test.tsx && bun run test && bun run build
```

Expected: all tests pass and Vite builds without TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add app/src/App.tsx app/src/components/CommandBar.tsx app/src/components/ModelPicker.tsx app/src/components/Sidebar.tsx app/src/components/ui/Button.tsx app/src/components/ui/IconButton.tsx app/src/components/ui/Modal.tsx app/src/components/ui/Checkbox.tsx app/src/components/ui/motionContracts.test.tsx app/src/styles.css
git commit -m "refactor: remove decorative interface motion"
```

---

### Task 6: Visual, Keyboard, Reduced-Motion, and Release Verification

**Files:**
- Modify only if a verification failure requires a scoped fix: files from Tasks 1–5 and their owning tests.

**Interfaces:**
- Consumes: the completed motion policy, disclosure behavior, pointer policy, Stage crossfade, and overlay contracts.
- Produces: fresh verification evidence and a clean branch suitable for the information-architecture/accessibility workstream.

- [ ] **Step 1: Run every automated gate**

Run:

```bash
cd app && bun run test
cd app && bun run build
cd app && bun run check:version
cd app && bun run check:open-source
cd app/src-tauri && cargo test
cd app/src-tauri && cargo check
git diff --check
```

Expected: all commands exit 0; generated `app/tsconfig.tsbuildinfo` changes are restored if they are the only mechanical build artifact.

- [ ] **Step 2: Review light and dark desktop layouts**

Run the preview with:

```bash
cd app && bun run dev -- --host 127.0.0.1
```

Open the isolated in-app browser at `http://127.0.0.1:5173`. At 1440×900 in both themes, capture and inspect Inbox, an open conversation, account folders open/closed, account edit-order mode, Command Bar, Model Picker, and a Modal. Confirm there is no row cascade, card bounce, layout clipping, double animation, or persistent drag handle outside edit-order mode.

- [ ] **Step 3: Review narrow/touch behavior**

At 390×844, verify the drawer opens/closes within 200 ms, mail rows permit swipe actions under coarse-pointer emulation, controls remain tappable, and no horizontal page overflow appears. At desktop pointer settings, verify horizontal mail dragging cannot start.

- [ ] **Step 4: Perform keyboard-only and reduced-motion walkthroughs**

Using only Tab, Shift+Tab, Enter, Space, Escape, and existing shortcuts:

- expand and collapse an account;
- enter and exit edit-order mode without exposing drag handles at rest;
- switch folders and threads;
- open and close Command Bar, Model Picker, and a Modal;
- compose and close a message.

Enable the OS/browser reduced-motion preference and repeat account disclosure, thread selection, drawer, Command Bar, Model Picker, and Modal interactions. Confirm no translation, scale, layout interpolation, stagger, or spring remains; opacity changes are effectively instant.

- [ ] **Step 5: Audit the final diff and commit only scoped verification fixes**

Run:

```bash
git status --short
git diff --check
git diff --stat 8b13e5b..HEAD
```

Expected: only planned product files are committed, `AGENTS.md` remains untracked and untouched, and no organization-specific defaults or assistant attribution appear.

If verification required a scoped correction, commit it with:

```bash
git add app/src/App.tsx app/src/main.tsx app/src/styles.css app/src/lib/motion.ts app/src/lib/motion.test.ts app/src/lib/pointer.ts app/src/lib/pointer.test.ts app/src/components/Sidebar.tsx app/src/components/Sidebar.test.ts app/src/components/Stream.tsx app/src/components/Stream.test.tsx app/src/components/Stage.tsx app/src/components/Stage.motion.test.tsx app/src/components/Compose.tsx app/src/components/CommandBar.tsx app/src/components/ModelPicker.tsx app/src/components/ui/Button.tsx app/src/components/ui/IconButton.tsx app/src/components/ui/Modal.tsx app/src/components/ui/Checkbox.tsx app/src/components/ui/MotionProvider.tsx app/src/components/ui/MotionProvider.test.tsx app/src/components/ui/motionContracts.test.tsx
git commit -m "fix: resolve calm motion verification gaps"
```

Do not create an empty verification commit.
