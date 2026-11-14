// Verifies routine inbox rendering is stable instead of replaying row entrances.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { Stream } from "@/components/Stream";
import { account, threads } from "@/data/mock";
import { useApp } from "@/store";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];
const containers: HTMLDivElement[] = [];
const originalScrollTo = HTMLElement.prototype.scrollTo;

function renderStream(streamThreads = [threads[1]], selectedThreadId: string | null = null) {
  HTMLElement.prototype.scrollTo = () => undefined;
  const selectThread = vi.fn();
  const previewThread = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  useApp.setState({
    accounts: [account],
    threads: streamThreads,
    view: "inbox",
    selectedAccountId: null,
    selectedFolder: null,
    selectedThreadId,
    selectedMessageId: null,
    selectThread,
    previewThread,
    reachedEnd: true,
    folders: [],
    flaggedIds: [],
  });

  act(() => root.render(<Stream />));
  return { container, selectThread, previewThread };
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
  it("skips an incomplete thread without messages instead of crashing the list", () => {
    const incomplete = {
      ...threads[0],
      id: "incomplete",
      subject: "Incomplete thread",
      messages: [],
    };
    const { container } = renderStream([incomplete, threads[1]]);

    expect(container.querySelectorAll(".mail-open")).toHaveLength(1);
    expect(container.textContent).toContain(threads[1].subject);
    expect(container.textContent).not.toContain("Incomplete thread");
  });

  it("gives the mail search field an accessible name", () => {
    const { container } = renderStream();
    const search = container.querySelector<HTMLInputElement>(".search-box input");

    expect(search?.getAttribute("aria-label")).toBe("Search mail");
  });

  it("exposes conversation rows as buttons and activates them with Enter or Space", () => {
    const { container, selectThread } = renderStream();
    const row = container.querySelector<HTMLElement>(".mail-open");

    expect(row?.tagName).toBe("BUTTON");
    expect(row?.tabIndex).toBe(0);
    expect(row?.getAttribute("aria-label")).toContain(threads[1].subject);

    act(() =>
      row?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
    );
    expect(selectThread).toHaveBeenCalledTimes(1);

    selectThread.mockClear();
    act(() =>
      row?.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
      ),
    );
    expect(selectThread).toHaveBeenCalledTimes(1);
  });

  it("opens the row context menu with Shift+F10", () => {
    const { container } = renderStream();
    const row = container.querySelector<HTMLElement>(".mail-open");

    act(() =>
      row?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "F10",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );

    expect(container.querySelector(".ctx-menu")).not.toBeNull();
    const firstItem = container.querySelector<HTMLButtonElement>('.ctx-menu [role="menuitem"]');
    expect(document.activeElement).toBe(firstItem);

    act(() =>
      firstItem?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      ),
    );
    const menuItems = [
      ...container.querySelectorAll<HTMLButtonElement>('.ctx-menu [role="menuitem"]'),
    ];
    expect(document.activeElement).toBe(menuItems[1]);

    act(() =>
      menuItems[1]?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(container.querySelector(".ctx-menu")).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("keeps the disclosure control isolated and makes expanded messages keyboard complete", () => {
    const { container, selectThread } = renderStream();
    const toggle = container.querySelector<HTMLButtonElement>(".convo-toggle");
    const row = container.querySelector<HTMLElement>(".mail-open");

    expect(row?.contains(toggle ?? null)).toBe(false);
    expect(toggle?.getAttribute("aria-label")).toContain("expand");
    act(() =>
      toggle?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
    );
    expect(selectThread).not.toHaveBeenCalled();

    act(() => toggle?.click());
    expect(toggle?.getAttribute("aria-label")).toContain("collapse");

    const child = container.querySelector<HTMLElement>(".convo-kid");
    expect(child?.tagName).toBe("BUTTON");
    expect(child?.tabIndex).toBe(0);
    expect(child?.getAttribute("aria-label")).toContain("Marco Reyes");

    act(() =>
      child?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
    );
    expect(selectThread).toHaveBeenCalledTimes(1);

    selectThread.mockClear();
    act(() =>
      child?.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
      ),
    );
    expect(selectThread).toHaveBeenCalledTimes(1);
  });
});

describe("Stream conversation selection", () => {
  it("changes Select all into Unselect all and clears the selection", () => {
    const { container } = renderStream([threads[0], threads[1]]);
    act(() => container.querySelector<HTMLButtonElement>(".mail-select")?.click());

    act(() =>
      container.querySelector<HTMLButtonElement>('button[title="Select all (⌘A)"]')?.click(),
    );
    expect(container.querySelectorAll(".mail.multi-sel")).toHaveLength(2);
    const deselect = container.querySelector<HTMLButtonElement>('button[title="Unselect all"]');
    expect(deselect?.textContent).toBe("Unselect all");
    expect(deselect?.disabled).toBe(false);

    act(() => deselect?.click());
    expect(container.querySelectorAll(".mail.multi-sel")).toHaveLength(0);
    expect(container.querySelector(".selection-bar")).toBeNull();
  });

  it("previews the top conversation when the reader is empty, without marking it read", () => {
    const { container, selectThread, previewThread } = renderStream([threads[0], threads[1]]);
    expect(previewThread).toHaveBeenCalledTimes(1);
    const top = container.querySelector<HTMLElement>(".mail");
    expect(top?.textContent).toContain(
      threads.find((t) => t.id === previewThread.mock.calls[0][0])?.subject,
    );
    expect(selectThread).not.toHaveBeenCalled();
  });

  it("previews the top conversation when the open id matches no loaded conversation", () => {
    const { previewThread } = renderStream([threads[0], threads[1]], "t1-placeholder");
    expect(previewThread).toHaveBeenCalledTimes(1);
  });

  it("leaves an open conversation alone", () => {
    const previewThread = vi.fn();
    act(() => useApp.setState({ previewThread }));
    const { container } = renderStream([threads[0], threads[1]], threads[1].id);
    act(() => container.querySelector<HTMLButtonElement>(".mail-select")?.click());
    act(() =>
      container.querySelector<HTMLButtonElement>('button[title="Clear selection"]')?.click(),
    );
    expect(container.querySelector(".selection-bar")).toBeNull();
    expect(previewThread).not.toHaveBeenCalled();
  });

  it("keeps unread mail from non-inbox folders out of the Priority fallback", () => {
    const inbox = {
      ...threads[0],
      id: "in",
      subject: "Inbox mail",
      unread: true,
      view: ["inbox" as const],
    };
    const trashed = {
      ...threads[1],
      id: "del",
      subject: "Trashed mail",
      unread: true,
      view: [],
      folder: "Deleted Items",
    };
    const { container } = renderStream([inbox, trashed]);
    act(() => useApp.setState({ view: "priority" }));

    expect(container.textContent).toContain("Inbox mail");
    expect(container.textContent).not.toContain("Trashed mail");
  });

  it("keeps the selection bar usable while a bulk read is still syncing", () => {
    // A server write that never finishes (slow or throttled provider).
    const setThreadsRead = vi.fn(() => new Promise<{ updated: number; failed: number }>(() => {}));
    const originalSetThreadsRead = useApp.getState().setThreadsRead;
    act(() => useApp.setState({ setThreadsRead }));
    onTestFinished(() => useApp.setState({ setThreadsRead: originalSetThreadsRead }));
    const { container } = renderStream([threads[0], threads[1]]);
    act(() => container.querySelector<HTMLButtonElement>(".mail-select")?.click());
    act(() =>
      container.querySelector<HTMLButtonElement>('button[title="Select all (⌘A)"]')?.click(),
    );

    act(() =>
      container.querySelector<HTMLButtonElement>('button[title="Mark selected as read"]')?.click(),
    );
    expect(setThreadsRead).toHaveBeenCalledTimes(1);

    const unselect = container.querySelector<HTMLButtonElement>('button[title="Unselect all"]');
    expect(unselect?.disabled).toBe(false);
    act(() => unselect?.click());
    expect(container.querySelector(".selection-bar")).toBeNull();
  });

  it("keeps the opened conversation highlighted when a concrete message is displayed", () => {
    const thread = threads[0];
    const { container } = renderStream([thread]);

    act(() =>
      useApp.setState({
        selectedThreadId: thread.id,
        selectedMessageId: thread.messages[0].id,
      }),
    );

    const row = container.querySelector<HTMLElement>(`.mail[data-thread-id="${thread.id}"]`);
    expect(row?.classList.contains("sel")).toBe(true);
    expect(row?.querySelector(".mail-open")?.getAttribute("aria-current")).toBe("true");
  });

  it("keeps bulk actions outside the native window drag surface", () => {
    const { container } = renderStream([threads[0], threads[1]]);
    const selector = container.querySelector<HTMLButtonElement>(".mail-select");

    act(() => selector?.click());

    const markRead = container.querySelector<HTMLButtonElement>(
      '.selection-actions button[title="Mark selected as read"]',
    );
    expect(markRead).not.toBeNull();
    expect(markRead?.closest("[data-tauri-drag-region]")).toBeNull();
  });

  it("renders context actions as non-submitting buttons", () => {
    const { container } = renderStream([threads[0], threads[1]]);
    const row = container.querySelector<HTMLElement>(".mail");

    act(() =>
      row?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: 24,
          clientY: 24,
        }),
      ),
    );

    const markRead = [
      ...container.querySelectorAll<HTMLButtonElement>('.ctx-menu [role="menuitem"]'),
    ].find((button) => button.textContent?.trim() === "Mark as read");
    expect(markRead).not.toBeNull();
    expect(markRead?.type).toBe("button");
  });

  it("selects a contiguous visible range with Shift+click without opening the range endpoint", () => {
    const { container, selectThread } = renderStream([
      threads[0],
      threads[1],
      threads[2],
      threads[3],
    ]);
    const rows = [...container.querySelectorAll<HTMLButtonElement>(".mail-open")];

    act(() => rows[0].click());
    expect(selectThread).toHaveBeenCalledTimes(1);

    act(() =>
      rows[2].dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          shiftKey: true,
        }),
      ),
    );

    expect(selectThread).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll(".mail.multi-sel")).toHaveLength(3);
    expect(container.querySelector(".selection-bar")?.textContent).toContain("3 selected");
  });

  it("toggles non-contiguous conversations with the platform modifier", () => {
    const { container, selectThread } = renderStream([threads[0], threads[1], threads[2]]);
    const rows = [...container.querySelectorAll<HTMLButtonElement>(".mail-open")];

    act(() =>
      rows[0].dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          metaKey: true,
        }),
      ),
    );
    act(() =>
      rows[2].dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
        }),
      ),
    );

    expect(selectThread).not.toHaveBeenCalled();
    expect(container.querySelectorAll(".mail.multi-sel")).toHaveLength(2);
    expect(container.querySelector(".selection-bar")?.textContent).toContain("2 selected");
  });

  it("preserves a multi-selection on right-click and applies an explicit read state", async () => {
    const { container } = renderStream([threads[0], threads[1], threads[2]]);
    const selectors = [...container.querySelectorAll<HTMLButtonElement>(".mail-select")];
    const mailRows = [...container.querySelectorAll<HTMLElement>(".mail")];

    act(() => selectors[0].click());
    act(() => selectors[1].click());
    act(() =>
      mailRows[1].dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: 24,
          clientY: 24,
        }),
      ),
    );

    expect(container.querySelector(".ctx-summary")?.textContent).toContain(
      "2 conversations selected",
    );
    const actions = [
      ...container.querySelectorAll<HTMLButtonElement>('.ctx-menu [role="menuitem"]'),
    ].map((button) => button.textContent?.trim());
    expect(actions).toContain("Mark as read");
    expect(actions).toContain("Mark as unread");

    const markRead = [
      ...container.querySelectorAll<HTMLButtonElement>('.ctx-menu [role="menuitem"]'),
    ].find((button) => button.textContent?.trim() === "Mark as read");
    await act(async () => markRead?.click());

    const selectedIds = [...container.querySelectorAll<HTMLElement>(".mail.multi-sel")].map(
      (row) => row.dataset.threadId,
    );
    expect(selectedIds).toHaveLength(2);
    expect(
      useApp
        .getState()
        .threads.filter((thread) => selectedIds.includes(thread.id))
        .every((thread) => !thread.unread),
    ).toBe(true);
  });
});
