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
import { Icon, type IconName } from "@/components/icons";
import { useApp } from "@/store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const accountAt = (index: number) => ({
  id: `a${index}`,
  email: `person${index}@example.test`,
  provider: "imap" as const,
  displayName: `Person ${index}`,
});

function enterAccountOrderMode(container: HTMLElement): HTMLButtonElement {
  const actions = container.querySelector<HTMLButtonElement>('[aria-label="Account actions"]');
  if (!actions) throw new Error("Account actions button not found");
  act(() => actions.click());
  const editOrder = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent?.includes("Edit order"));
  if (!editOrder) throw new Error("Edit order menu item not found");
  act(() => editOrder.click());
  const done = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Done");
  if (!done) throw new Error("Done button not found");
  return done;
}

describe("account creation entry points", () => {
  it.each([
    [0, false],
    [1, false],
    [2, true],
  ])("shows Add account for %i accounts and order management only when useful", (count, hasOrderAction) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    useApp.setState({
      accounts: Array.from({ length: count }, (_, index) => accountAt(index)),
      accountOrder: [],
      selectedAccountId: null,
      threads: [],
    });

    act(() => root.render(createElement(Sidebar)));

    expect(container.querySelector('[aria-label="Add account"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Account actions"]') !== null).toBe(hasOrderAction);
    act(() => root.unmount());
  });

  it("renders a compact empty state until the first account is connected", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    useApp.setState({ accounts: [], accountOrder: [], selectedAccountId: null, threads: [] });

    act(() => root.render(createElement(Sidebar)));

    expect(container.textContent).toContain("No accounts connected");
    expect(container.textContent).toContain("Add an account to receive mail.");
    act(() => root.unmount());
  });

  it("offers Add account from the compact rail", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    useApp.setState({ accounts: [], accountOrder: [], selectedAccountId: null, threads: [] });

    act(() => root.render(createElement(Sidebar, { rail: true })));

    expect(container.querySelector('[aria-label="Add account"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("exits edit-order mode before opening account creation", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    useApp.setState({
      accounts: [accountAt(0), accountAt(1)],
      accountOrder: [],
      selectedAccountId: null,
      threads: [],
      accountConnectorOpen: false,
    });
    act(() => root.render(createElement(Sidebar)));

    enterAccountOrderMode(container);
    expect(container.querySelector("#account-order-instructions")).not.toBeNull();

    const add = container.querySelector<HTMLButtonElement>('[aria-label="Add account"]');
    if (!add) throw new Error("Add account button not found");
    act(() => add.click());

    expect(container.querySelector("#account-order-instructions")).toBeNull();
    expect(useApp.getState().accountConnectorOpen).toBe(true);
    act(() => root.unmount());
    useApp.setState({ accountConnectorOpen: false, accountConnectorOpener: null });
  });

  it("opens order management from the keyboard and restores focus on Escape", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    useApp.setState({
      accounts: [accountAt(0), accountAt(1)],
      accountOrder: [],
      selectedAccountId: null,
      threads: [],
    });
    act(() => root.render(createElement(Sidebar)));

    const actions = container.querySelector<HTMLButtonElement>('[aria-label="Account actions"]');
    if (!actions) throw new Error("Account actions button not found");
    actions.focus();
    await act(async () => {
      actions.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    const menuItem = container.querySelector<HTMLButtonElement>('[role="menuitem"]');
    expect(document.activeElement).toBe(menuItem);

    await act(async () => {
      menuItem?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(document.activeElement).toBe(actions);
    act(() => root.unmount());
    container.remove();
  });
});

describe("mail account disclosure motion", () => {
  it("renders distinct semantic icons for system and custom mailboxes", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    useApp.setState({
      accounts: [{ id: "a1", email: "one@example.test", provider: "imap", displayName: "One" }],
      accountOrder: [],
      selectedAccountId: "a1",
      selectedFolder: null,
      folders: [
        { name: "INBOX", role: "inbox", unread: 0, total: 0 },
        { name: "Drafts", role: "drafts", unread: 0, total: 0 },
        { name: "Sent Messages", role: "sent", unread: 0, total: 0 },
        { name: "Deleted Messages", role: "trash", unread: 0, total: 0 },
        { name: "Junk", role: "junk", unread: 0, total: 0 },
        { name: "Archive", role: "archive", unread: 0, total: 0 },
        { name: "Projects", unread: 0, total: 0 },
        { name: "Spam", unread: 0, total: 0 },
        { name: "Deleted Items", unread: 0, total: 0 },
        { name: "Sent Items", unread: 0, total: 0 },
      ],
      threads: [],
    });

    const expectedIconMarkup = (name: IconName): string => {
      const iconContainer = document.createElement("div");
      const iconRoot = createRoot(iconContainer);
      act(() => iconRoot.render(createElement(Icon, { name, size: 15, weight: "duotone" })));
      const markup = iconContainer.querySelector("svg")?.innerHTML ?? "";
      act(() => iconRoot.unmount());
      return markup;
    };
    const renderedIconMarkup = (label: string): string => {
      const button = [...container.querySelectorAll<HTMLButtonElement>(".folder-item")]
        .find((candidate) => candidate.querySelector(".acct-email")?.textContent === label);
      if (!button) throw new Error(`${label} folder button not found`);
      return button.querySelector("svg")?.innerHTML ?? "";
    };

    act(() => root.render(createElement(Sidebar)));

    expect(renderedIconMarkup("Inbox")).toBe(expectedIconMarkup("inbox"));
    expect(renderedIconMarkup("Drafts")).toBe(expectedIconMarkup("compose"));
    expect(renderedIconMarkup("Sent Messages")).toBe(expectedIconMarkup("send"));
    expect(renderedIconMarkup("Deleted Messages")).toBe(expectedIconMarkup("trash"));
    expect(renderedIconMarkup("Junk")).toBe(expectedIconMarkup("shieldWarning"));
    expect(renderedIconMarkup("Archive")).toBe(expectedIconMarkup("archive"));
    expect(renderedIconMarkup("Projects")).toBe(expectedIconMarkup("folder"));
    expect(renderedIconMarkup("Spam")).toBe(expectedIconMarkup("shieldWarning"));
    expect(renderedIconMarkup("Deleted Items")).toBe(expectedIconMarkup("trash"));
    expect(renderedIconMarkup("Sent Items")).toBe(expectedIconMarkup("send"));

    act(() => root.unmount());
  });

  it("collapses folders without rebuilding the selected mailbox", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    useApp.setState({
      accounts: [{ id: "a1", email: "one@example.test", provider: "imap", displayName: "One" }],
      accountOrder: [],
      selectedAccountId: "a1",
      selectedFolder: null,
      folders: [{ name: "INBOX", role: "inbox", unread: 0, total: 0 }],
      threads: [],
    });

    act(() => root.render(createElement(Sidebar)));
    const disclosure = container.querySelector<HTMLElement>('[aria-label="One folders"]');
    expect(disclosure?.getAttribute("aria-hidden")).toBe("false");
    expect(disclosure?.hasAttribute("inert")).toBe(false);

    const accountButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("One"));
    if (!accountButton) throw new Error("Account button not found");
    act(() => accountButton.click());

    expect(disclosure?.getAttribute("aria-hidden")).toBe("true");
    expect(disclosure?.hasAttribute("inert")).toBe(true);
    expect(useApp.getState().selectedAccountId).toBe("a1");
    expect(useApp.getState().folders).toHaveLength(1);
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

    const doneButton = enterAccountOrderMode(container);

    const instructions = container.querySelector<HTMLElement>("#account-order-instructions");
    const dragHandles = [...container.querySelectorAll<HTMLButtonElement>(".acct-drag")];
    expect(instructions?.textContent).toContain("Drag the handles");
    expect(dragHandles).toHaveLength(2);
    expect(dragHandles.every((handle) => handle.getAttribute("aria-describedby") === "account-order-instructions")).toBe(true);
    expect(doneButton.textContent).toContain("Done");

    act(() => doneButton.click());
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
    enterAccountOrderMode(container);
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
