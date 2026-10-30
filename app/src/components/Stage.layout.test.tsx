import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailBody, Stage } from "@/components/Stage";
import { renderTest } from "@/test/render";
import { account, threads } from "@/data/mock";
import { useApp } from "@/store";

const mounted: ReturnType<typeof renderTest>[] = [];
afterEach(() => {
  for (const item of mounted.splice(0)) item.unmount();
  vi.unstubAllGlobals();
});

function measuredMessage(contentHeight: number) {
  const rendered = renderTest(<EmailBody html="<p>Layout test</p>" />);
  mounted.push(rendered);
  const frame = rendered.host.querySelector<HTMLIFrameElement>("iframe")!;
  frame.style.border = "1px solid";
  frame.style.boxSizing = "border-box";
  const doc = frame.contentDocument!;
  doc.body.innerHTML = "<p>Layout test</p>";
  let height = contentHeight;
  for (const name of ["scrollHeight", "offsetHeight"] as const) {
    Object.defineProperty(doc.body, name, { configurable: true, get: () => height });
    // A document's viewport is at least as tall as the iframe. Including this
    // in the content measurement creates a grow-on-every-measure feedback loop.
    Object.defineProperty(doc.documentElement, name, {
      configurable: true,
      get: () => Math.max(height, parseFloat(frame.style.height) || 150),
    });
  }
  const measure = () => act(() => frame.dispatchEvent(new Event("load")));
  return { frame, measure, setHeight: (next: number) => { height = next; } };
}

describe("reader layout", () => {
  it("keeps repeated message measurements stable and shrinks for shorter content", () => {
    const { frame, measure, setHeight } = measuredMessage(400);
    measure();
    const first = frame.style.height;
    measure();
    expect(frame.style.height).toBe(first);
    setHeight(80);
    measure();
    expect(parseFloat(frame.style.height)).toBeLessThanOrEqual(82);
  });

  it("fits a complete long message without an 8000px nested scroll viewport", () => {
    const { frame, measure } = measuredMessage(14090);
    measure();
    expect(parseFloat(frame.style.height)).toBeGreaterThanOrEqual(14090);
    expect(parseFloat(frame.style.height)).toBeLessThanOrEqual(14092);
  });

  it("resizes for late content changes and releases observers on unmount", async () => {
    const observers: TestResizeObserver[] = [];
    class TestResizeObserver implements ResizeObserver {
      readonly targets = new Set<Element>();
      disconnect = vi.fn();
      constructor(private callback: ResizeObserverCallback) { observers.push(this); }
      observe(target: Element) { this.targets.add(target); }
      unobserve(target: Element) { this.targets.delete(target); }
      notify() { this.callback([], this); }
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const { frame, measure, setHeight } = measuredMessage(80);
    measure();
    const bodyObserver = observers.find((observer) => observer.targets.has(frame.contentDocument!.body));
    expect(bodyObserver).toBeDefined();
    setHeight(740);
    await act(async () => {
      bodyObserver!.notify();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(parseFloat(frame.style.height)).toBe(742);
    mounted.pop()!.unmount();
    expect(observers.every((observer) => observer.disconnect.mock.calls.length > 0)).toBe(true);
  });

  it("keeps the toolbar and subject outside the conversation scroll region", () => {
    useApp.setState({ accounts: [account], threads: [threads[0]], selectedThreadId: threads[0].id, selectedMessageId: null });
    const rendered = renderTest(<Stage />);
    mounted.push(rendered);
    const content = rendered.host.querySelector(".reader-scroll");
    expect(content).not.toBeNull();
    expect(content?.contains(rendered.host.querySelector(".msg"))).toBe(true);
    expect(content?.contains(rendered.host.querySelector(".stage-bar"))).toBe(false);
    expect(content?.contains(rendered.host.querySelector("h1.subject"))).toBe(false);
  });
});
