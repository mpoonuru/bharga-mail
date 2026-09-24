import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_DISCLOSURE_MOTION,
  ACCOUNT_REORDER_MOTION,
  Sidebar,
  accountDisclosureState,
  accountReorderLayout,
  activateAccountReorder,
} from "@/components/Sidebar";
import { useApp } from "@/store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("mail account disclosure motion", () => {
  it("uses a restrained CSS-grid timing contract", () => {
    expect(ACCOUNT_DISCLOSURE_MOTION).toEqual({
      durationMs: 160,
      caretDurationMs: 160,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    });
    expect(ACCOUNT_DISCLOSURE_MOTION).not.toHaveProperty("type");
  });

  it("keeps hidden and inert semantics synchronized with expansion", () => {
    expect(accountDisclosureState(false)).toEqual({ ariaHidden: true, inert: true });
    expect(accountDisclosureState(true)).toEqual({ ariaHidden: false, inert: false });
  });

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

    act(() => root.render(createElement(Sidebar)));
    expect(container.querySelectorAll(".acct-drag")).toHaveLength(0);

    const editOrderButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Edit order");
    if (!(editOrderButton instanceof HTMLButtonElement)) throw new Error("Edit order button not found");
    act(() => editOrderButton.click());

    const instructions = container.querySelector<HTMLElement>("#account-order-instructions");
    const dragHandles = [...container.querySelectorAll<HTMLButtonElement>(".acct-drag")];
    expect(instructions?.textContent).toContain("Drag the handles");
    expect(dragHandles).toHaveLength(2);
    expect(dragHandles.every((handle) => handle.getAttribute("aria-describedby") === "account-order-instructions")).toBe(true);
    expect(editOrderButton.textContent).toContain("Done");

    act(() => editOrderButton.click());
    expect(container.querySelector("#account-order-instructions")).toBeNull();
    expect(container.querySelectorAll(".acct-drag")).toHaveLength(0);
    act(() => root.unmount());
  });
});

describe("mail account reorder motion", () => {
  it("disables layout projection except during an explicit tweened reorder", () => {
    expect(ACCOUNT_REORDER_MOTION.idleLayout).toBe(false);
    expect(ACCOUNT_REORDER_MOTION.activeLayout).toBe("position");
    expect(accountReorderLayout(false)).toBe(false);
    expect(accountReorderLayout(true)).toBe("position");
    expect(ACCOUNT_REORDER_MOTION.transition).toMatchObject({
      type: "tween",
      duration: 0.16,
    });
    expect(ACCOUNT_REORDER_MOTION.transition).not.toHaveProperty("stiffness");
  });

  it("commits active layout before the drag callback reads the rendered state", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const observedLayoutStates: string[] = [];

    function ReorderHarness() {
      const [reordering, setReordering] = useState(false);

      return createElement("button", {
        "data-layout": accountReorderLayout(reordering),
        onClick: () => activateAccountReorder(
          () => setReordering(true),
          () => observedLayoutStates.push(container.querySelector("button")?.dataset.layout ?? "missing"),
        ),
      });
    }

    act(() => root.render(createElement(ReorderHarness)));
    const dragHandle = container.querySelector("button");
    if (!dragHandle) throw new Error("Expected reorder harness drag handle");

    act(() => dragHandle.click());

    expect(observedLayoutStates).toEqual(["position"]);

    act(() => root.unmount());
  });
});
