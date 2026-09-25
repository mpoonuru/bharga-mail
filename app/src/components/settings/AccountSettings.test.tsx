import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountRemovalDialog } from "@/components/settings/AccountRemovalDialog";
import { AccountSettings } from "@/components/settings/AccountSettings";
import { useApp } from "@/store";
import { renderTest } from "@/test/render";
import type { Account } from "@/types";

const originalRemoveAccount = useApp.getState().removeAccount;

afterEach(() => {
  document.body.replaceChildren();
  useApp.setState({ accounts: [], removeAccount: originalRemoveAccount });
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
    const { host } = renderTest(<AccountSettings runtime="preview" />);

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
    const { host } = renderTest(<AccountSettings runtime="desktop" />);
    expect(host.textContent).toContain("No accounts yet");
    expect(host.textContent).toContain("Add account");
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
    renderTest(
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
