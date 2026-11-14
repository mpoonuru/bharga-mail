// Verifies that untrusted email links never open from Bharga: activating one
// only shows its real destination, with Copy as the single way out.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailBody } from "@/components/Stage";
import { api } from "@/lib/bridge";
import { useHotkeys } from "@/lib/useHotkeys";
import { useApp } from "@/store";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const hosts: HTMLDivElement[] = [];

function HotkeyHarness() {
  useHotkeys();
  return null;
}

function renderBody(anchorHtml: string, boxes: Partial<DOMRect>[] = []) {
  const host = document.createElement("div");
  document.body.append(host);
  hosts.push(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      <>
        <HotkeyHarness />
        <EmailBody html={anchorHtml} sender="sender@example.test" />
      </>,
    ),
  );
  const frame = host.querySelector<HTMLIFrameElement>("iframe")!;
  const frameDocument = frame.contentDocument!;
  // The reader makes every link inert before it reaches the frame.
  frameDocument.body.innerHTML = anchorHtml.replaceAll("<a href=", "<a data-href=");
  const anchor = frameDocument.querySelector<HTMLAnchorElement>("a")!;
  // jsdom lays nothing out, so give the link the boxes a browser would report.
  anchor.getClientRects = () => boxes as unknown as DOMRectList;
  act(() => frame.dispatchEvent(new Event("load")));
  return { host, frameDocument, anchor };
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const host of hosts.splice(0)) host.remove();
  document.querySelectorAll(".modal-overlay").forEach((node) => node.remove());
  document.body.style.overflow = "";
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
  useApp.getState().setCompose(false);
});

const actionLabels = () =>
  [...document.querySelectorAll<HTMLButtonElement>(".lc-actions button")].map(
    (button) => button.textContent,
  );

describe("message links", () => {
  it("never opens a safe web link; it shows the destination with Copy only", () => {
    const openExternalUrl = vi.spyOn(api, "openExternalUrl").mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { anchor } = renderBody('<a href="https://example.test/path">Open example</a>');

    act(() => anchor.click());

    expect(document.querySelector(".modal-head")?.textContent).toContain("Link destination");
    expect(document.querySelector(".lc-url")?.textContent).toBe("https://example.test/path");
    expect(actionLabels()).toEqual(["Copy link", "Close"]);
    act(() => document.querySelector<HTMLButtonElement>(".lc-actions button")?.click());
    expect(writeText).toHaveBeenCalledWith("https://example.test/path");
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("shows the real destination of a risky link and offers no way to open it", () => {
    const openExternalUrl = vi.spyOn(api, "openExternalUrl").mockResolvedValue(undefined);
    const { anchor } = renderBody(
      '<a href="https://evil.test/login" data-risk="dangerous" data-real="evil.test">paypal.com</a>',
    );

    act(() => anchor.click());

    expect(document.querySelector(".modal-head")?.textContent).toContain("Dangerous link");
    expect(document.querySelector(".lc-url")?.textContent).toBe("https://evil.test/login");
    expect(actionLabels()).toEqual(["Copy link", "Stay safe"]);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("blocks non-web schemes", () => {
    const openExternalUrl = vi.spyOn(api, "openExternalUrl").mockResolvedValue(undefined);
    const { anchor } = renderBody('<a href="javascript:alert(1)">Run</a>');

    act(() => anchor.click());

    expect(document.querySelector(".modal-head")?.textContent).toContain("Link blocked");
    expect(actionLabels()).toEqual(["Copy link", "Stay safe"]);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("covers each box of a link with a button of its own that shows the destination", () => {
    // WebKit runs no listeners inside the script-less frame, so the buttons are
    // the only way in there: this test never dispatches anything on the anchor.
    const openExternalUrl = vi.spyOn(api, "openExternalUrl").mockResolvedValue(undefined);
    const { host } = renderBody('<a href="https://example.test/path">Open the example</a>', [
      { left: 10, top: 20, width: 120, height: 16 },
      { left: 0, top: 36, width: 40, height: 16 },
      { left: 0, top: 52, width: 0, height: 16 },
    ]);

    const shields = [...host.querySelectorAll<HTMLButtonElement>(".link-shield")];
    expect(shields).toHaveLength(2);
    expect(shields[0].style.left).toBe("10px");
    expect(shields[0].style.top).toBe("20px");
    expect(shields[0].style.width).toBe("120px");
    expect(shields[0].getAttribute("aria-label")).toBe("Link: Open the example. Show destination");
    expect(shields.map((shield) => shield.tabIndex)).toEqual([0, -1]);

    act(() => shields[1].click());
    expect(document.querySelector(".lc-url")?.textContent).toBe("https://example.test/path");
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("shows the destination instead of a browser menu on right-click", () => {
    const { host } = renderBody('<a href="https://example.test/path">Open example</a>', [
      { left: 0, top: 0, width: 80, height: 16 },
    ]);
    const shield = host.querySelector<HTMLButtonElement>(".link-shield")!;
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });

    act(() => {
      shield.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector(".lc-url")?.textContent).toBe("https://example.test/path");
  });

  it("shows the destination from Shift+F10 inside the frame", () => {
    const { anchor } = renderBody('<a href="https://example.test/path">Open example</a>');

    act(() => {
      anchor.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "F10",
          shiftKey: true,
        }),
      );
    });

    expect(document.querySelector(".lc-url")?.textContent).toBe("https://example.test/path");
  });

  it("returns focus to the link button when the dialog closes", () => {
    vi.useFakeTimers();
    try {
      const { host } = renderBody('<a href="https://example.test/path">Open example</a>', [
        { left: 0, top: 0, width: 80, height: 16 },
      ]);
      const shield = host.querySelector<HTMLButtonElement>(".link-shield")!;
      act(() => shield.click());

      act(() => {
        [...document.querySelectorAll<HTMLButtonElement>(".lc-actions button")][1].click();
        vi.runAllTimers();
      });

      expect(document.activeElement).toBe(shield);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the reader when a message hides links from them", () => {
    const { host } = renderBody(
      '<p>Hello</p><div style="display:none"><a href="https://t.test/x">secret</a></div>',
    );

    const banner = host.querySelector(".phish-banner");
    expect(banner?.textContent).toContain("This message contains hidden content");
    expect(banner?.textContent).toContain("1 hidden link");
  });

  it("shows no hidden-content notice for an ordinary message", () => {
    const { host } = renderBody('<p>Hello <a href="https://example.test/">there</a></p>');

    expect(host.querySelector(".phish-banner")).toBeNull();
  });
});
