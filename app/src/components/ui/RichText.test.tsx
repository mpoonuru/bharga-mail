// Responsive toolbar coverage: control dividers must never wrap as standalone lines.
import { act, createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RichText, type RichTextHandle } from "@/components/ui/RichText";
import { renderTest } from "@/test/render";

beforeEach(() => {
  // jsdom has no layout engine; ProseMirror measures the selection when it
  // restores editor focus. Keep its real formatting commands under test.
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("RichText", () => {
  it("exposes the editable message body with an accessible name", async () => {
    const rendered = renderTest(<RichText />);

    await vi.waitFor(() =>
      expect(rendered.host.querySelector('.ProseMirror[contenteditable="true"]')).not.toBeNull(),
    );

    const editor = rendered.host.querySelector('.ProseMirror[contenteditable="true"]');
    expect(editor?.getAttribute("aria-label")).toBe("Message body");
    expect(editor?.getAttribute("aria-multiline")).toBe("true");
  });

  it("keeps toolbar dividers attached to non-wrapping control groups", async () => {
    const rendered = renderTest(<RichText />);

    await vi.waitFor(() => expect(rendered.host.querySelector(".rt-toolbar")).not.toBeNull());

    const toolbar = rendered.host.querySelector(".rt-toolbar");
    expect(toolbar?.querySelectorAll(":scope > .rt-sep")).toHaveLength(0);
    expect(toolbar?.querySelectorAll(":scope > .rt-tool-group").length).toBeGreaterThan(1);
  });

  it("changes text style through the custom listbox and returns focus to the editor", async () => {
    const ref = createRef<RichTextHandle>();
    const rendered = renderTest(<RichText ref={ref} initialHtml="<p>Draft text</p>" />);
    await vi.waitFor(() => expect(rendered.host.querySelector(".ProseMirror")).not.toBeNull());

    const trigger = rendered.host.querySelector<HTMLButtonElement>(
      'button[aria-label="Text style"]',
    );
    expect(trigger).not.toBeNull();
    expect(rendered.host.querySelector("select")).toBeNull();
    act(() => trigger!.click());
    const option = [...rendered.host.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (node) => node.textContent === "Heading 2",
    );
    expect(option).toBeDefined();
    act(() => option!.click());

    await vi.waitFor(() => {
      expect(ref.current?.getHtml()).toContain("<h2>Draft text</h2>");
      expect(document.activeElement?.classList.contains("ProseMirror")).toBe(true);
      expect(rendered.host.querySelector('[role="listbox"]')).toBeNull();
      expect(rendered.host.querySelector('button[aria-label="Text style"]')?.textContent).toBe(
        "Heading 2",
      );
    });
    rendered.unmount();
  });

  it("closes the style listbox with Escape without changing the draft", async () => {
    const ref = createRef<RichTextHandle>();
    const rendered = renderTest(<RichText ref={ref} initialHtml="<p>Keep this draft</p>" />);
    await vi.waitFor(() => expect(rendered.host.querySelector(".ProseMirror")).not.toBeNull());
    const trigger = rendered.host.querySelector<HTMLButtonElement>(
      'button[aria-label="Text style"]',
    );
    expect(trigger).not.toBeNull();
    act(() =>
      trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    );
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(document.activeElement?.getAttribute("role")).toBe("option");
    act(() =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    expect(rendered.host.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(ref.current?.getHtml()).toBe("<p>Keep this draft</p>");
    rendered.unmount();
  });
});
