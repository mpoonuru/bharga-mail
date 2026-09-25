// Protects native-safe disclosure height, resize, and accessibility behavior.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MeasuredDisclosure } from "@/components/ui/MeasuredDisclosure";

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let resizeCallback: ResizeObserverCallback | null = null;
let originalResizeObserver: typeof ResizeObserver | undefined;

beforeEach(() => {
  originalResizeObserver = globalThis.ResizeObserver;
  resizeCallback = null;
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback;
    }

    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver;
  else Reflect.deleteProperty(globalThis, "ResizeObserver");
});

describe("MeasuredDisclosure", () => {
  it("expands to measured content height and follows live content resizing", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await act(async () => root?.render(
      <MeasuredDisclosure
        open={false}
        ariaLabel="Account folders"
        className="test-disclosure"
        contentClassName="test-disclosure-content"
        durationMs={160}
        easing="cubic-bezier(0.2, 0.8, 0.2, 1)"
      >
        <button type="button">Inbox</button>
      </MeasuredDisclosure>,
    ));

    const disclosure = host.querySelector<HTMLElement>('[aria-label="Account folders"]');
    const content = host.querySelector<HTMLElement>(".test-disclosure-content");
    if (!disclosure || !content || !resizeCallback) throw new Error("Measured disclosure did not initialize");

    let contentHeight = 96;
    Object.defineProperty(content, "scrollHeight", { configurable: true, get: () => contentHeight });
    await act(async () => resizeCallback?.([], {} as ResizeObserver));

    expect(disclosure.style.height).toBe("0px");
    expect(disclosure.getAttribute("aria-hidden")).toBe("true");
    expect(disclosure.hasAttribute("inert")).toBe(true);

    await act(async () => root?.render(
      <MeasuredDisclosure
        open
        ariaLabel="Account folders"
        className="test-disclosure"
        contentClassName="test-disclosure-content"
        durationMs={160}
        easing="cubic-bezier(0.2, 0.8, 0.2, 1)"
      >
        <button type="button">Inbox</button>
      </MeasuredDisclosure>,
    ));

    expect(disclosure.style.height).toBe("96px");
    expect(disclosure.getAttribute("aria-hidden")).toBe("false");
    expect(disclosure.hasAttribute("inert")).toBe(false);

    contentHeight = 144;
    await act(async () => resizeCallback?.([], {} as ResizeObserver));
    expect(disclosure.style.height).toBe("144px");

    const transitionEnd = new Event("transitionend", { bubbles: true });
    Object.defineProperty(transitionEnd, "propertyName", { value: "height" });
    await act(async () => disclosure.dispatchEvent(transitionEnd));
    expect(disclosure.classList.contains("settled")).toBe(true);

    await act(async () => root?.render(
      <MeasuredDisclosure
        open={false}
        ariaLabel="Account folders"
        className="test-disclosure"
        contentClassName="test-disclosure-content"
        durationMs={160}
        easing="cubic-bezier(0.2, 0.8, 0.2, 1)"
      >
        <button type="button">Inbox</button>
      </MeasuredDisclosure>,
    ));

    expect(disclosure.style.height).toBe("0px");
    expect(disclosure.classList.contains("settled")).toBe(false);
  });
});
