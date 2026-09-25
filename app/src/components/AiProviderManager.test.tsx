import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { AiProviderManager } from "@/components/AiProviderManager";
import { aiProfile } from "@/data/mock";
import { useApp } from "@/store";
import { renderTest, setInputValue } from "@/test/render";

afterEach(() => {
  document.body.replaceChildren();
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
});
