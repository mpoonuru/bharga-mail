// Behavioral coverage for immediate privacy persistence and field-scoped rollback.
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
    vi.spyOn(api, "setAiPrivacy").mockRejectedValue(new Error("Storage unavailable"));
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

  it("retains provider updates when privacy persistence fails later", async () => {
    let rejectPersistence: (reason: Error) => void = () => undefined;
    vi.spyOn(api, "setAiPrivacy").mockImplementation(() => new Promise<void>((_resolve, reject) => {
      rejectPersistence = reject;
    }));
    useApp.setState({ ai: structuredClone(aiProfile) });

    const saving = useApp.getState().savePrivacy("local");
    useApp.getState().updateModel(aiProfile.models[0].id, { label: "Updated while saving" });
    rejectPersistence(new Error("Storage unavailable"));
    await expect(saving).rejects.toThrow("Storage unavailable");

    expect(useApp.getState().ai?.privacy).toBe(aiProfile.privacy);
    expect(useApp.getState().ai?.models[0].label).toBe("Updated while saving");
  });

  it("retains provider updates when privacy persistence succeeds later", async () => {
    let resolvePersistence: () => void = () => undefined;
    vi.spyOn(api, "setAiPrivacy").mockImplementation(() => new Promise<void>((resolve) => {
      resolvePersistence = resolve;
    }));
    useApp.setState({ ai: structuredClone(aiProfile) });

    const saving = useApp.getState().savePrivacy("local");
    useApp.getState().updateModel(aiProfile.models[0].id, { label: "Updated while saving" });
    resolvePersistence();
    await saving;

    expect(useApp.getState().ai?.privacy).toBe("local");
    expect(useApp.getState().ai?.models[0].label).toBe("Updated while saving");
  });
});
