// Verifies that untrusted email links are intercepted, reviewable, and never
// navigate Bharga's embedded message frame.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailBody } from "@/components/Stage";
import { api } from "@/lib/bridge";
import { useHotkeys } from "@/lib/useHotkeys";
import { useApp } from "@/store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const hosts: HTMLDivElement[] = [];

function HotkeyHarness() {
  useHotkeys();
  return null;
}

function renderBody(anchorHtml: string) {
  const host = document.createElement("div");
  document.body.append(host);
  hosts.push(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<><HotkeyHarness /><EmailBody html={anchorHtml} sender="sender@example.test" /></>));
  const frame = host.querySelector<HTMLIFrameElement>("iframe")!;
  const frameDocument = frame.contentDocument!;
  frameDocument.body.innerHTML = anchorHtml;
  act(() => frame.dispatchEvent(new Event("load")));
  return { host, frameDocument, anchor: frameDocument.querySelector<HTMLAnchorElement>("a")! };
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const host of hosts.splice(0)) host.remove();
  document.querySelectorAll(".modal-overlay, .link-menu, .link-menu-backdrop").forEach((node) => node.remove());
  document.body.style.overflow = "";
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
  useApp.getState().setCompose(false);
});

describe("message links", () => {
  it("opens a safe web link through the external opener", () => {
    const openExternalUrl = vi.spyOn(api, "openExternalUrl").mockResolvedValue(undefined);
    const { anchor } = renderBody('<a href="https://example.test/path">Open example</a>');

    act(() => anchor.click());

    expect(openExternalUrl).toHaveBeenCalledWith("https://example.test/path");
  });

  it("shows the real destination and explicit actions for a risky link", () => {
    const openExternalUrl = vi.spyOn(api, "openExternalUrl").mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { anchor } = renderBody('<a href="https://evil.test/login" data-risk="dangerous" data-real="evil.test">paypal.com</a>');

    act(() => anchor.click());

    expect(document.querySelector(".modal-head")?.textContent).toContain("Dangerous link");
    expect(document.querySelector(".lc-url")?.textContent).toBe("https://evil.test/login");
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".lc-actions button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Copy link", "Stay safe", "Open anyway"]);
    act(() => buttons[0].click());
    expect(writeText).toHaveBeenCalledWith("https://evil.test/login");
    expect(openExternalUrl).not.toHaveBeenCalled();
    act(() => buttons[2].click());
    expect(openExternalUrl).toHaveBeenCalledWith("https://evil.test/login");
  });

  it("blocks non-web schemes and offers no open action", () => {
    const openExternalUrl = vi.spyOn(api, "openExternalUrl").mockResolvedValue(undefined);
    const { anchor } = renderBody('<a href="javascript:alert(1)">Run</a>');

    act(() => anchor.click());

    expect(document.querySelector(".modal-head")?.textContent).toContain("Link blocked");
    expect([...document.querySelectorAll(".lc-actions button")].some((button) => button.textContent === "Open anyway")).toBe(false);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("offers Open and Copy from the link context menu", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { anchor } = renderBody('<a href="https://example.test/path">Open example</a>');

    act(() => {
      anchor.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 12, clientY: 18 }));
      anchor.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2, clientX: 12, clientY: 18 }));
    });

    const items = [...document.querySelectorAll<HTMLButtonElement>('.link-menu [role="menuitem"]')];
    expect(items.map((button) => button.textContent)).toEqual(["Open link", "Copy link"]);
    expect(document.querySelector(".modal-overlay")).toBeNull();
    await act(async () => items[1].click());
    expect(writeText).toHaveBeenCalledWith("https://example.test/path");
    expect(document.querySelector(".link-copy-toast")?.textContent).toBe("Link copied.");
  });

  it("opens the link action menu from Shift+F10", () => {
    const { anchor } = renderBody('<a href="https://example.test/path">Open example</a>');

    act(() => {
      anchor.focus();
      anchor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "F10", shiftKey: true }));
    });

    expect(document.querySelector('.link-menu [role="menuitem"]')?.textContent).toBe("Open link");
  });

  it("isolates global shortcuts and closes on Tab with focus restored", () => {
    vi.useFakeTimers();
    try {
      const { anchor, frameDocument } = renderBody('<a href="https://example.test/path">Open example</a>');
      act(() => anchor.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })));
      const firstItem = document.querySelector<HTMLButtonElement>('.link-menu [role="menuitem"]')!;

      act(() => firstItem.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "c" })));
      expect(useApp.getState().composeOpen).toBe(false);
      expect(document.querySelector(".link-menu")).not.toBeNull();

      act(() => {
        firstItem.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" }));
        vi.runAllTimers();
      });
      expect(document.querySelector(".link-menu")).toBeNull();
      expect(frameDocument.activeElement).toBe(anchor);
    } finally {
      vi.useRealTimers();
    }
  });
});
