// Behavioral coverage for account status, parallel actions, and destructive-dialog safety.
import { act } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountRemovalDialog } from "@/components/settings/AccountRemovalDialog";
import { AccountSettings } from "@/components/settings/AccountSettings";
import { api } from "@/lib/bridge";
import { useApp } from "@/store";
import { renderTest } from "@/test/render";
import type { Account } from "@/types";

const originalRemoveAccount = useApp.getState().removeAccount;
const originalLoad = useApp.getState().load;
const mounted: Array<() => void> = [];

function renderSubject(node: ReactNode) {
  const rendered = renderTest(node);
  mounted.push(rendered.unmount);
  return rendered;
}

afterEach(async () => {
  await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 180)));
  while (mounted.length) mounted.pop()?.();
  document.body.replaceChildren();
  useApp.setState({ accounts: [], removeAccount: originalRemoveAccount, load: originalLoad });
  vi.restoreAllMocks();
});

describe("AccountSettings", () => {
  it("shows account health and opens one add-account chooser", () => {
    useApp.setState({
      accounts: [{
        id: "imap:work@example.test",
        email: "work@example.test",
        provider: "imap",
        displayName: "Work",
        unread: 4,
        lastSyncAt: 1_700_000_000,
      }],
    });
    const { host } = renderSubject(<AccountSettings runtime="preview" />);

    expect(host.textContent).toContain("Work");
    expect(host.textContent).toContain("IMAP");
    expect(host.textContent).toContain("4 unread");
    expect(host.textContent).toContain("Last synced");

    const add = [...host.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Add account");
    if (!add) throw new Error("Add account button not found");
    act(() => add.click());

    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.body.textContent?.match(/Desktop app required/g)).toHaveLength(2);
  });

  it("shows a focused empty state", () => {
    useApp.setState({ accounts: [] });
    const { host } = renderSubject(<AccountSettings runtime="desktop" />);
    expect(host.textContent).toContain("No accounts yet");
    expect(host.textContent).toContain("Add account");
  });

  it("shows persisted authentication failures instead of a healthy state", () => {
    useApp.setState({
      accounts: [{
        id: "imap:work@example.test",
        email: "work@example.test",
        provider: "imap",
        displayName: "Work",
        unread: 0,
        lastSyncAt: 1_700_000_000,
        syncError: "Authentication required",
      }],
    });
    const { host } = renderSubject(<AccountSettings runtime="desktop" />);
    expect(host.textContent).toContain("Authentication required");
    expect(host.querySelector(".account-health-dot.error")).not.toBeNull();
  });

  it("lets different accounts sync concurrently without unlocking either early", async () => {
    const resolvers = new Map<string, () => void>();
    vi.spyOn(api, "syncNow").mockImplementation((id) => new Promise<number>((resolve) => {
      resolvers.set(id, () => resolve(0));
    }));
    useApp.setState({
      accounts: [
        { id: "imap:a@example.test", email: "a@example.test", provider: "imap", displayName: "", unread: 0 },
        { id: "imap:b@example.test", email: "b@example.test", provider: "imap", displayName: "", unread: 0 },
      ],
      load: vi.fn().mockResolvedValue(undefined),
    });
    const { host } = renderSubject(<AccountSettings runtime="desktop" />);
    const syncButtons = [...host.querySelectorAll<HTMLButtonElement>(".account-card .af-btn")]
      .filter((button) => button.textContent?.includes("Sync"));

    act(() => {
      syncButtons[0]?.click();
      syncButtons[1]?.click();
    });

    expect(syncButtons[0]?.disabled).toBe(true);
    expect(syncButtons[1]?.disabled).toBe(true);
    await act(async () => resolvers.get("imap:a@example.test")?.());
    expect(syncButtons[1]?.disabled).toBe(true);
    await act(async () => resolvers.get("imap:b@example.test")?.());
  });

  it("does not show stale manual success after a background sync failure", async () => {
    const account: Account = {
      id: "imap:work@example.test",
      email: "work@example.test",
      provider: "imap",
      displayName: "Work",
      unread: 0,
    };
    vi.spyOn(api, "syncNow").mockResolvedValue(0);
    useApp.setState({ accounts: [account], load: vi.fn().mockResolvedValue(undefined) });
    const { host } = renderSubject(<AccountSettings runtime="desktop" />);
    const sync = [...host.querySelectorAll<HTMLButtonElement>(".account-card .af-btn")]
      .find((button) => button.textContent?.includes("Sync"));
    await act(async () => sync?.click());
    expect(host.textContent).toContain("Up to date");

    act(() => useApp.setState({ accounts: [{ ...account, syncError: "Authentication required" }] }));
    expect(host.textContent).toContain("Authentication required");
    expect(host.textContent).not.toContain("Up to date");
  });

  it("does not show a stale manual error after background sync recovers", async () => {
    const account: Account = {
      id: "imap:work@example.test",
      email: "work@example.test",
      provider: "imap",
      displayName: "Work",
      unread: 0,
      syncError: "Network unavailable",
    };
    vi.spyOn(api, "syncNow").mockRejectedValue(new Error("Network unavailable"));
    useApp.setState({ accounts: [account], load: vi.fn().mockResolvedValue(undefined) });
    const { host } = renderSubject(<AccountSettings runtime="desktop" />);
    const sync = [...host.querySelectorAll<HTMLButtonElement>(".account-card .af-btn")]
      .find((button) => button.textContent?.includes("Sync"));
    await act(async () => sync?.click());
    expect(host.querySelector(".account-operation.error")?.textContent).toContain("Network unavailable");

    act(() => useApp.setState({
      accounts: [{ ...account, lastSyncAt: 1_700_000_100, syncError: undefined }],
    }));
    expect(host.textContent).toContain("Last synced");
    expect(host.querySelector(".account-operation.error")).toBeNull();
    expect(host.querySelector(".account-health-dot.error")).toBeNull();
  });

  it("supports keyboard navigation and focus restoration in account menus", async () => {
    useApp.setState({
      accounts: [{
        id: "imap:work@example.test",
        email: "work@example.test",
        provider: "imap",
        displayName: "Work",
        unread: 0,
      }],
    });
    const { host } = renderSubject(<AccountSettings runtime="desktop" />);
    const more = host.querySelector<HTMLButtonElement>('[aria-label="More actions for Work"]');
    if (!more) throw new Error("Account action button not found");
    act(() => more.click());
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(document.activeElement).toBe(items[0]);

    act(() => items[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(items[1]);
    act(() => items[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.activeElement).toBe(more);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("returns focus after asynchronously opening and closing account editing", async () => {
    vi.spyOn(api, "getImapAccount").mockResolvedValue({
      email: "work@example.test",
      imapHost: "mail.example.test",
      smtpHost: "mail.example.test",
      sameCredentials: true,
    });
    useApp.setState({
      accounts: [{
        id: "imap:work@example.test",
        email: "work@example.test",
        provider: "imap",
        displayName: "Work",
        unread: 0,
      }],
    });
    const { host } = renderSubject(<AccountSettings runtime="desktop" />);
    const more = host.querySelector<HTMLButtonElement>('[aria-label="More actions for Work"]');
    if (!more) throw new Error("Account action button not found");
    act(() => more.click());
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.includes("Edit server settings"))?.click());
    const cancel = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Cancel");
    act(() => cancel?.click());
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(document.activeElement).toBe(more);
  });

  it("restores focus to the account action after cancelling removal", async () => {
    const account: Account = {
      id: "imap:work@example.test",
      email: "work@example.test",
      provider: "imap",
      displayName: "Work",
      unread: 0,
    };
    useApp.setState({ accounts: [account] });
    const { host } = renderSubject(<AccountSettings runtime="desktop" />);
    const more = host.querySelector<HTMLButtonElement>('[aria-label="More actions for Work"]');
    if (!more) throw new Error("Account action button not found");
    act(() => more.click());
    const removeMenuItem = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.includes("Remove account"));
    act(() => removeMenuItem?.click());
    const cancel = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Cancel");
    act(() => cancel?.click());
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(document.activeElement).toBe(more);
  });

  it("moves focus to Add account after successful removal", async () => {
    const account: Account = {
      id: "imap:work@example.test",
      email: "work@example.test",
      provider: "imap",
      displayName: "Work",
      unread: 0,
    };
    const removeAccount = vi.fn().mockImplementation(async () => {
      useApp.setState({ accounts: [] });
    });
    useApp.setState({ accounts: [account], removeAccount });
    const { host } = renderSubject(<AccountSettings runtime="desktop" />);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="More actions for Work"]')?.click());
    act(() => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.includes("Remove account"))?.click());
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Remove account"));
    await act(async () => confirm?.click());
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    const add = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Add account");
    expect(document.activeElement).toBe(add);
  });
});

describe("AccountRemovalDialog", () => {
  it("does not report account removal before the store succeeds", async () => {
    const account: Account = {
      id: "imap:work@example.test",
      email: "work@example.test",
      provider: "imap",
      displayName: "Work",
      unread: 0,
    };
    const removeAccount = vi.fn().mockRejectedValue(new Error("Credential cleanup failed"));
    useApp.setState({ accounts: [account], removeAccount });
    const onRemoved = vi.fn();
    renderSubject(
      <AccountRemovalDialog account={account} onClose={vi.fn()} onRemoved={onRemoved} />,
    );

    const remove = [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Remove account"));
    if (!remove) throw new Error("Remove account button not found");
    await act(async () => remove.click());

    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Credential cleanup failed");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(onRemoved).not.toHaveBeenCalled();
  });
});
