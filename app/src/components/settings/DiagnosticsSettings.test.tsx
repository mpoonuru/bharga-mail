// Behavioral coverage for explicit, redacted diagnostics copy and download actions.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DiagnosticsSettings } from "@/components/settings/DiagnosticsSettings";
import { aiProfile } from "@/data/mock";
import { useApp } from "@/store";
import { renderTest } from "@/test/render";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

function setClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
  if (createObjectUrlDescriptor) Object.defineProperty(URL, "createObjectURL", createObjectUrlDescriptor);
  else Reflect.deleteProperty(URL, "createObjectURL");
  if (revokeObjectUrlDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeObjectUrlDescriptor);
  else Reflect.deleteProperty(URL, "revokeObjectURL");
});

describe("DiagnosticsSettings", () => {
  it("copies and downloads only the redacted snapshot", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn().mockReturnValue("blob:diagnostics") });
    const revoke = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
    let filename = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function capture(this: HTMLAnchorElement) {
      filename = this.download;
    });
    useApp.setState({
      accounts: [{ id: "private", email: "person@company.test", provider: "imap", displayName: "Private", lastSyncAt: 1_700_000_000 }],
      ai: structuredClone(aiProfile),
    });
    const { host, unmount } = renderTest(<DiagnosticsSettings version="0.1.3" runtime="preview" />);

    const copy = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Copy redacted diagnostics"));
    if (!copy) throw new Error("Copy button not found");
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0][0]).not.toContain("person@company.test");
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Copied");

    const download = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Download JSON"));
    if (!download) throw new Error("Download button not found");
    act(() => download.click());
    expect(filename).toBe("bharga-diagnostics.json");
    expect(revoke).toHaveBeenCalledWith("blob:diagnostics");
    expect(host.textContent).toContain("Preview runtime");
    unmount();
  });

  it("reports clipboard failure without claiming success", async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error("Clipboard denied")));
    const { host, unmount } = renderTest(<DiagnosticsSettings version="0.1.3" runtime="desktop" />);
    const copy = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Copy redacted diagnostics"));
    if (!copy) throw new Error("Copy button not found");
    await act(async () => copy.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Clipboard denied");
    expect(host.textContent).not.toContain("Diagnostics copied");
    unmount();
  });
});
