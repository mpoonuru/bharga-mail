// Verifies routine inbox rendering is stable instead of replaying row entrances.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Stream } from "@/components/Stream";
import { account, threads } from "@/data/mock";
import { useApp } from "@/store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];
const containers: HTMLDivElement[] = [];
const originalScrollTo = HTMLElement.prototype.scrollTo;

function renderStream() {
  HTMLElement.prototype.scrollTo = () => undefined;
  const selectThread = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  useApp.setState({
    accounts: [account],
    threads: [threads[1]],
    view: "inbox",
    selectedAccountId: null,
    selectedFolder: null,
    selectedThreadId: null,
    selectedMessageId: null,
    selectThread,
    reachedEnd: true,
    folders: [],
    flaggedIds: [],
  });

  act(() => root.render(<Stream />));
  return { container, selectThread };
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const container of containers.splice(0)) container.remove();
  HTMLElement.prototype.scrollTo = originalScrollTo;
});

describe("Stream row motion", () => {
  it("renders existing mail without inline entrance opacity or translation", () => {
    HTMLElement.prototype.scrollTo = () => undefined;
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    useApp.setState({
      accounts: [account],
      threads: [threads[0]],
      view: "inbox",
      selectedAccountId: null,
      selectedFolder: null,
      selectedThreadId: null,
    });

    act(() => root.render(<Stream />));

    const row = container.querySelector<HTMLElement>(".mail");
    expect(row).not.toBeNull();
    expect(row?.style.opacity).toBe("");
    expect(row?.style.transform).toBe("");
  });
});

describe("Stream row keyboard behavior", () => {
  it("exposes conversation rows as buttons and activates them with Enter or Space", () => {
    const { container, selectThread } = renderStream();
    const row = container.querySelector<HTMLElement>(".mail-open");

    expect(row?.tagName).toBe("BUTTON");
    expect(row?.tabIndex).toBe(0);
    expect(row?.getAttribute("aria-label")).toContain(threads[1].subject);

    act(() => row?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(selectThread).toHaveBeenCalledTimes(1);

    selectThread.mockClear();
    act(() => row?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })));
    expect(selectThread).toHaveBeenCalledTimes(1);
  });

  it("opens the row context menu with Shift+F10", () => {
    const { container } = renderStream();
    const row = container.querySelector<HTMLElement>(".mail-open");

    act(() => row?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "F10",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })));

    expect(container.querySelector(".ctx-menu")).not.toBeNull();
    const firstItem = container.querySelector<HTMLButtonElement>('.ctx-menu [role="menuitem"]');
    expect(document.activeElement).toBe(firstItem);

    act(() => firstItem?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    const menuItems = [...container.querySelectorAll<HTMLButtonElement>('.ctx-menu [role="menuitem"]')];
    expect(document.activeElement).toBe(menuItems[1]);

    act(() => menuItems[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(container.querySelector(".ctx-menu")).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("keeps the disclosure control isolated and makes expanded messages keyboard complete", () => {
    const { container, selectThread } = renderStream();
    const toggle = container.querySelector<HTMLButtonElement>(".convo-toggle");
    const row = container.querySelector<HTMLElement>(".mail-open");

    expect(row?.contains(toggle ?? null)).toBe(false);
    expect(toggle?.getAttribute("aria-label")).toContain("expand");
    act(() => toggle?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(selectThread).not.toHaveBeenCalled();

    act(() => toggle?.click());
    expect(toggle?.getAttribute("aria-label")).toContain("collapse");

    const child = container.querySelector<HTMLElement>(".convo-kid");
    expect(child?.tagName).toBe("BUTTON");
    expect(child?.tabIndex).toBe(0);
    expect(child?.getAttribute("aria-label")).toContain("Marco Reyes");

    act(() => child?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(selectThread).toHaveBeenCalledTimes(1);

    selectThread.mockClear();
    act(() => child?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })));
    expect(selectThread).toHaveBeenCalledTimes(1);
  });
});
