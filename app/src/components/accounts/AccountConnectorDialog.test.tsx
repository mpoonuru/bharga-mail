// Exercises the single account-onboarding dialog used by Sidebar and Settings.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountConnectorDialog } from "@/components/accounts/AccountConnectorDialog";
import { api } from "@/lib/bridge";
import { useApp } from "@/store";
import { renderTest } from "@/test/render";

const mounted: Array<() => void> = [];
const originalConnectGmail = useApp.getState().connectGmail;
const originalConnectMicrosoft = useApp.getState().connectMicrosoft;
const originalLoad = useApp.getState().load;
const originalSetAccount = useApp.getState().setAccount;

function renderDialog() {
  const rendered = renderTest(<AccountConnectorDialog />);
  mounted.push(rendered.unmount);
  return rendered;
}

function buttonContaining(text: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error("Button not found: " + text);
  return button;
}

afterEach(async () => {
  await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 180)));
  while (mounted.length) mounted.pop()?.();
  document.body.replaceChildren();
  useApp.setState({
    accountConnectorOpen: false,
    accountConnectorOpener: null,
    connectGmail: originalConnectGmail,
    connectMicrosoft: originalConnectMicrosoft,
    load: originalLoad,
    setAccount: originalSetAccount,
  });
  vi.restoreAllMocks();
});

describe("AccountConnectorDialog", () => {
  it("loads provider readiness once for each open", async () => {
    const capabilities = vi.spyOn(api, "listMailProviderCapabilities").mockResolvedValue([
      { provider: "gmail", available: false, configured: false, reason: "desktop_required" },
      { provider: "microsoft", available: false, configured: false, reason: "desktop_required" },
      { provider: "imap", available: false, configured: false, reason: "desktop_required" },
    ]);
    useApp.setState({ accountConnectorOpen: true });
    renderDialog();

    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    expect(capabilities).toHaveBeenCalledTimes(1);
  });

  it("fails closed when provider readiness cannot be loaded", async () => {
    vi.spyOn(api, "listMailProviderCapabilities").mockRejectedValue(new Error("old core"));
    useApp.setState({ accountConnectorOpen: true });
    renderDialog();

    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain("Update Bharga Mail");
    expect(buttonContaining("Continue with Google").disabled).toBe(true);
    expect(buttonContaining("Continue with Microsoft").disabled).toBe(true);
  });

  it("connects once, refreshes state, focuses the account, and closes", async () => {
    vi.spyOn(api, "listMailProviderCapabilities").mockResolvedValue([
      { provider: "gmail", available: true, configured: true, reason: "ready" },
      { provider: "microsoft", available: false, configured: false, reason: "build_not_configured" },
      { provider: "imap", available: true, configured: true, reason: "ready" },
    ]);
    const connectGmail = vi.fn().mockResolvedValue("gmail:person@example.test");
    const load = vi.fn().mockResolvedValue(undefined);
    const setAccount = vi.fn();
    useApp.setState({
      accountConnectorOpen: true,
      connectGmail,
      load,
      setAccount,
    });
    renderDialog();
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));

    const google = buttonContaining("Continue with Google");
    await act(async () => {
      google.click();
      google.click();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(connectGmail).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(setAccount).toHaveBeenCalledWith("gmail:person@example.test");
    expect(useApp.getState().accountConnectorOpen).toBe(false);
    expect(document.querySelector('[role="status"]')?.textContent)
      .toContain("Account connected");
  });

  it("shows safe structured provider failures", async () => {
    vi.spyOn(api, "listMailProviderCapabilities").mockResolvedValue([
      { provider: "gmail", available: true, configured: true, reason: "ready" },
      { provider: "microsoft", available: false, configured: false, reason: "build_not_configured" },
      { provider: "imap", available: true, configured: true, reason: "ready" },
    ]);
    useApp.setState({
      accountConnectorOpen: true,
      connectGmail: vi.fn().mockRejectedValue({
        code: "tenant_restricted",
        message: "Your organization blocked this sign-in.",
        retryable: false,
      }),
    });
    renderDialog();
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    await act(async () => buttonContaining("Continue with Google").click());

    expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain("Your organization blocked this sign-in.");
  });

  it("keeps and selects an account when only its first sync fails", async () => {
    vi.spyOn(api, "listMailProviderCapabilities").mockResolvedValue([
      { provider: "gmail", available: true, configured: true, reason: "ready" },
      { provider: "microsoft", available: false, configured: false, reason: "build_not_configured" },
      { provider: "imap", available: true, configured: true, reason: "ready" },
    ]);
    const load = vi.fn().mockResolvedValue(undefined);
    const setAccount = vi.fn();
    useApp.setState({
      accountConnectorOpen: true,
      connectGmail: vi.fn().mockRejectedValue({
        code: "initial_sync_failed",
        message: "The account was connected, but its first sync did not finish.",
        retryable: true,
        accountId: "gmail:person@example.test",
      }),
      load,
      setAccount,
    });
    renderDialog();
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    await act(async () => buttonContaining("Continue with Google").click());

    expect(load).toHaveBeenCalledTimes(1);
    expect(setAccount).toHaveBeenCalledWith("gmail:person@example.test");
    expect(useApp.getState().accountConnectorOpen).toBe(false);
    expect(document.querySelector('[role="status"]')?.textContent)
      .toContain("connected, but its first sync did not finish");
  });

  it("restores focus to a connected fallback when the opener disappears", async () => {
    vi.spyOn(api, "listMailProviderCapabilities").mockResolvedValue([]);
    const opener = document.createElement("button");
    const fallback = document.createElement("button");
    fallback.dataset.accountConnectorFallback = "true";
    document.body.append(opener, fallback);
    opener.focus();
    useApp.getState().openAccountConnector(opener);
    renderDialog();
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    opener.remove();

    const close = document.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]');
    if (!close) throw new Error("Close dialog button not found");
    act(() => close.click());
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(document.activeElement).toBe(fallback);
  });
});
