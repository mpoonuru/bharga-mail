import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_DISCLOSURE_MOTION,
  ACCOUNT_REORDER_MOTION,
  Sidebar,
  accountReorderLayout,
  activateAccountReorder,
} from "@/components/Sidebar";
import { useApp } from "@/store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("mail account disclosure motion", () => {
  it("routes account folders through the measured disclosure behavior", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    useApp.setState({
      accounts: [{ id: "a1", email: "one@example.test", provider: "imap", displayName: "One" }],
      accountOrder: [],
      selectedAccountId: null,
      selectedFolder: null,
      folders: [{ name: "INBOX", role: "inbox", unread: 0, total: 0 }],
      threads: [],
    });

    act(() => root.render(createElement(Sidebar)));
    const disclosure = container.querySelector<HTMLElement>('[aria-label="One folders"]');
    expect(disclosure?.getAttribute("aria-hidden")).toBe("true");
    expect(disclosure?.hasAttribute("inert")).toBe(true);

    const accountButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("One"));
    if (!accountButton) throw new Error("Account button not found");
    act(() => accountButton.click());

    expect(disclosure?.getAttribute("aria-hidden")).toBe("false");
    expect(disclosure?.hasAttribute("inert")).toBe(false);
    act(() => root.unmount());
  });

  it("uses the shared restrained disclosure timing", () => {
    expect(ACCOUNT_DISCLOSURE_MOTION).toEqual({
      durationMs: 160,
      caretDurationMs: 160,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    });
    expect(ACCOUNT_DISCLOSURE_MOTION).not.toHaveProperty("type");
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

  it("reorders accounts from the keyboard and announces the new position", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const setAccountOrder = vi.fn();
    useApp.setState({
      accounts: [
        { id: "a1", email: "one@example.test", provider: "imap", displayName: "One" },
        { id: "a2", email: "two@example.test", provider: "gmail", displayName: "Two" },
      ],
      accountOrder: [],
      setAccountOrder,
      selectedAccountId: null,
      threads: [],
    });

    act(() => root.render(createElement(Sidebar)));
    const editOrderButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Edit order");
    if (!(editOrderButton instanceof HTMLButtonElement)) throw new Error("Edit order button not found");
    act(() => editOrderButton.click());
    const handles = [...container.querySelectorAll<HTMLButtonElement>(".acct-drag")];

    expect(container.querySelector("#account-order-instructions")?.textContent).toContain("Arrow Up or Arrow Down");
    expect(handles[0]?.getAttribute("aria-keyshortcuts")).toBe("ArrowUp ArrowDown");
    act(() => handles[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));

    expect(setAccountOrder).toHaveBeenCalledWith(["a2", "a1"]);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("One moved to position 2 of 2");
    act(() => root.unmount());
  });

  it("uses an in-app confirmation dialog for folder deletion", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const deleteFolder = vi.fn().mockImplementation(async () => {
      useApp.setState({ folders: [] });
    });
    const nativeConfirm = vi.spyOn(window, "confirm");
    useApp.setState({
      accounts: [{ id: "a1", email: "one@example.test", provider: "imap", displayName: "One" }],
      accountOrder: [],
      selectedAccountId: "a1",
      selectedFolder: null,
      folders: [{ name: "Projects", unread: 0, total: 0 }],
      threads: [],
      deleteFolder,
    });

    act(() => root.render(createElement(Sidebar)));
    const menuButton = container.querySelector<HTMLButtonElement>('button[title="Folder options"]');
    if (!menuButton) throw new Error("Folder options button not found");
    act(() => menuButton.click());
    const deleteButton = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.includes("Delete"));
    if (!deleteButton) throw new Error("Delete folder button not found");
    act(() => deleteButton.click());

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Delete folder");
    expect(nativeConfirm).not.toHaveBeenCalled();
    const confirmDelete = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Delete folder");
    if (!confirmDelete) throw new Error("Delete folder confirmation not found");
    await act(async () => {
      confirmDelete.click();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(deleteFolder).toHaveBeenCalledWith("a1", "Projects");
    expect(document.activeElement).toBe(container.querySelector<HTMLButtonElement>('button[title="Account options"]'));

    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 180)));
    act(() => root.unmount());
    container.remove();
    nativeConfirm.mockRestore();
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
