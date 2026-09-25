// Behavioral coverage for compact provider editing and provider-scoped async state.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AiProviderManager } from "@/components/AiProviderManager";
import { aiProfile } from "@/data/mock";
import { useApp } from "@/store";
import { renderTest, setInputValue } from "@/test/render";

const originalSaveModel = useApp.getState().saveModel;
const originalRemoveModel = useApp.getState().removeModel;

afterEach(() => {
  document.body.replaceChildren();
  useApp.setState({ saveModel: originalSaveModel, removeModel: originalRemoveModel });
  vi.restoreAllMocks();
});

describe("AiProviderManager", () => {
  it("keeps providers compact and expands one editor without losing drafts", () => {
    useApp.setState({ ai: structuredClone(aiProfile) });
    const { host, unmount } = renderTest(<AiProviderManager />);
    const first = host.querySelector<HTMLButtonElement>('[aria-label^="Edit Claude"]');
    const second = host.querySelector<HTMLButtonElement>('[aria-label^="Edit Llama"]');
    if (!first || !second) throw new Error("Provider disclosure controls not found");
    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelectorAll('.provider-editor[aria-hidden="false"]')).toHaveLength(0);

    act(() => first.click());
    const providerName = host.querySelector<HTMLInputElement>('[aria-label="Provider name"]');
    if (!providerName) throw new Error("Provider name input not found");
    setInputValue(providerName, "Work Claude");
    act(() => second.click());
    expect(host.querySelectorAll('.provider-editor[aria-hidden="false"]')).toHaveLength(1);
    act(() => first.click());
    expect(host.querySelector<HTMLInputElement>('[aria-label="Provider name"]')?.value).toBe("Work Claude");
    unmount();
  });

  it("closes an expanded provider with Escape", () => {
    useApp.setState({ ai: structuredClone(aiProfile) });
    const { host, unmount } = renderTest(<AiProviderManager />);
    const first = host.querySelector<HTMLButtonElement>('[aria-label^="Edit Claude"]');
    if (!first) throw new Error("Provider disclosure control not found");
    act(() => first.click());
    const editor = host.querySelector<HTMLElement>('.provider-editor[aria-hidden="false"]');
    if (!editor) throw new Error("Provider editor not found");
    act(() => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelectorAll('.provider-editor[aria-hidden="false"]')).toHaveLength(0);
    unmount();
  });

  it("keeps concurrent provider saves busy and messaged independently", async () => {
    const resolvers = new Map<string, () => void>();
    const saveModel = vi.fn().mockImplementation((input: { id: string }) => new Promise<void>((resolve) => {
      resolvers.set(input.id, resolve);
    }));
    useApp.setState({ ai: structuredClone(aiProfile), saveModel });
    const { host, unmount } = renderTest(<AiProviderManager />);
    const saveButtons = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .filter((button) => button.textContent?.includes("Save changes"));

    act(() => {
      saveButtons[0]?.click();
      saveButtons[1]?.click();
    });
    expect(saveButtons[0]?.disabled).toBe(true);
    expect(saveButtons[1]?.disabled).toBe(true);

    await act(async () => resolvers.get(aiProfile.models[0].id)?.());
    expect(saveButtons[1]?.disabled).toBe(true);
    await act(async () => resolvers.get(aiProfile.models[1].id)?.());

    expect(host.querySelectorAll(".provider-message.success")).toHaveLength(2);
    unmount();
  });

  it("moves focus to Add provider after successful removal", async () => {
    const removeModel = vi.fn().mockImplementation(async (id: string) => {
      useApp.setState((state) => ({
        ai: state.ai ? { ...state.ai, models: state.ai.models.filter((model) => model.id !== id) } : null,
      }));
    });
    useApp.setState({ ai: structuredClone(aiProfile), removeModel });
    const { host, unmount } = renderTest(<AiProviderManager />);
    const remove = host.querySelector<HTMLButtonElement>(`[aria-label="Remove ${aiProfile.models[0].label}"]`);
    if (!remove) throw new Error("Provider removal control not found");
    act(() => remove.click());
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Remove provider");
    if (!confirm) throw new Error("Provider confirmation control not found");
    await act(async () => {
      confirm.click();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(removeModel).toHaveBeenCalledWith(aiProfile.models[0].id);
    expect(document.activeElement).toBe(host.querySelector<HTMLButtonElement>(".provider-manager-head .af-btn"));
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 180)));
    unmount();
  });
});
