import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountForm } from "@/components/AccountForm";
import { api } from "@/lib/bridge";
import { useApp } from "@/store";
import { renderTest, setInputValue } from "@/test/render";

const originalLoad = useApp.getState().load;

afterEach(() => {
  document.body.replaceChildren();
  useApp.setState({ load: originalLoad });
  vi.restoreAllMocks();
});

describe("AccountForm", () => {
  it("progressively discloses server settings without losing account details", () => {
    const { host } = renderTest(<AccountForm onClose={vi.fn()} onStatus={vi.fn()} />);
    expect(host.querySelector('[aria-label="IMAP host"]')).toBeNull();

    const email = host.querySelector<HTMLInputElement>('[aria-label="Email address"]');
    if (!email) throw new Error("Email input not found");
    setInputValue(email, "me@example.test");
    const continueButton = [...host.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Continue");
    if (!continueButton) throw new Error("Continue button not found");
    act(() => continueButton.click());

    expect(host.querySelector('[aria-label="IMAP host"]')).not.toBeNull();
    const back = [...host.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Back"));
    if (!back) throw new Error("Back button not found");
    act(() => back.click());
    expect(host.querySelector<HTMLInputElement>('[aria-label="Email address"]')?.value).toBe("me@example.test");
  });

  it("requires a valid identity before continuing", () => {
    const { host } = renderTest(<AccountForm onClose={vi.fn()} onStatus={vi.fn()} />);
    const continueButton = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Continue");
    expect(continueButton?.disabled).toBe(true);
  });

  it("allows an existing account to retain its saved password", () => {
    const { host } = renderTest(
      <AccountForm
        editing
        initial={{
          email: "me@example.test",
          displayName: "Me",
          imapHost: "mail.example.test",
          smtpHost: "mail.example.test",
        }}
        onClose={vi.fn()}
        onStatus={vi.fn()}
      />,
    );
    const continueButton = [...host.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Continue");
    if (!continueButton) throw new Error("Continue button not found");
    act(() => continueButton.click());
    const save = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Save & sync"));
    expect(save?.disabled).toBe(false);
  });

  it("keeps the explicit server payload when saving", async () => {
    const saveImapAccount = vi.spyOn(api, "saveImapAccount").mockResolvedValue("imap:me@example.test");
    vi.spyOn(api, "syncNow").mockResolvedValue(0);
    vi.spyOn(api, "listFolders").mockResolvedValue([]);
    useApp.setState({ load: vi.fn().mockResolvedValue(undefined) });
    const { host } = renderTest(<AccountForm onClose={vi.fn()} onStatus={vi.fn()} />);

    const setNamedInput = (label: string, value: string) => {
      const input = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
      if (!input) throw new Error(`${label} input not found`);
      setInputValue(input, value);
    };
    setNamedInput("Email address", "me@example.test");
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Continue")?.click());
    setNamedInput("IMAP host", "imap.example.test");
    setNamedInput("IMAP password", "local-test-password");
    setNamedInput("SMTP host", "smtp.example.test");
    const save = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Save & sync"));
    if (!save) throw new Error("Save button not found");
    await act(async () => save.click());

    expect(saveImapAccount).toHaveBeenCalledWith(expect.objectContaining({
      email: "me@example.test",
      imapHost: "imap.example.test",
      smtpHost: "smtp.example.test",
      imapPassword: "local-test-password",
    }));
  });
});
