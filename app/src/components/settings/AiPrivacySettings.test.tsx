import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AiPrivacySettings } from "@/components/settings/AiPrivacySettings";
import { aiProfile } from "@/data/mock";
import { api } from "@/lib/bridge";
import { useApp } from "@/store";
import { renderTest } from "@/test/render";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("AiPrivacySettings", () => {
  it("persists privacy immediately and restores the previous choice on failure", async () => {
    const profile = structuredClone(aiProfile);
    vi.spyOn(api, "setAiProfile").mockRejectedValue(new Error("Storage unavailable"));
    useApp.setState({ ai: profile });
    const { host, unmount } = renderTest(<AiPrivacySettings />);
    const local = host.querySelector<HTMLButtonElement>('[role="radio"][aria-label="Local"]');
    if (!local) throw new Error("Local privacy option not found");

    await act(async () => local.click());

    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Storage unavailable");
    expect(host.querySelector('[role="radio"][aria-label="Hybrid"]')?.getAttribute("aria-checked")).toBe("true");
    expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes(["Save", "engine"].join(" ")))).toBe(false);
    unmount();
  });
});
