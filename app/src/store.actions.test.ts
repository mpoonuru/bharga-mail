import { afterEach, describe, expect, it, vi } from "vitest";
import { threads } from "@/data/mock";
import { useApp } from "@/store";

afterEach(() => {
  vi.useRealTimers();
  useApp.setState({
    actionNotice: null,
    selectedThreadId: null,
    selectedMessageId: null,
    suppressAutoPreview: false,
  });
});

describe("thread actions", () => {
  it("immediately closes an archived conversation and confirms the action", () => {
    const thread = threads[0];
    useApp.setState({
      threads: [thread],
      selectedThreadId: thread.id,
      selectedMessageId: thread.messages[0].id,
      actionNotice: null,
    });

    useApp.getState().archiveThread(thread.id);

    expect(useApp.getState().selectedThreadId).toBeNull();
    expect(useApp.getState().selectedMessageId).toBeNull();
    expect(useApp.getState().threads[0].view).toEqual([]);
    expect(useApp.getState().actionNotice).toBe("Archived");
  });

  it("immediately closes a snoozed conversation and confirms the action", () => {
    const thread = threads[0];
    useApp.setState({
      threads: [thread],
      selectedThreadId: thread.id,
      selectedMessageId: thread.messages[0].id,
      actionNotice: null,
    });

    useApp.getState().snoozeThread(thread.id);

    expect(useApp.getState().selectedThreadId).toBeNull();
    expect(useApp.getState().selectedMessageId).toBeNull();
    expect(useApp.getState().threads[0].view).toContain("snoozed");
    expect(useApp.getState().actionNotice).toBe("Snoozed");
  });

  it("keeps the reader closed until a conversation is explicitly opened", () => {
    const thread = threads[0];
    useApp.setState({ threads: [thread], selectedThreadId: thread.id, suppressAutoPreview: false });

    useApp.getState().archiveThread(thread.id);
    expect(useApp.getState().suppressAutoPreview).toBe(true);

    useApp.getState().previewThread(thread.id, thread.messages[0].id);
    expect(useApp.getState().suppressAutoPreview).toBe(false);
  });

  it.each(["archiveThread", "snoozeThread"] as const)(
    "%s on another conversation leaves the open one alone",
    (action) => {
      const [open, other] = threads;
      useApp.setState({
        threads: [open, other],
        selectedThreadId: open.id,
        selectedMessageId: open.messages[0].id,
        suppressAutoPreview: false,
      });

      useApp.getState()[action](other.id);

      expect(useApp.getState().selectedThreadId).toBe(open.id);
      expect(useApp.getState().selectedMessageId).toBe(open.messages[0].id);
      expect(useApp.getState().suppressAutoPreview).toBe(false);
    },
  );

  it("dismisses the confirmation automatically", () => {
    vi.useFakeTimers();
    useApp.setState({ threads: [threads[0]], selectedThreadId: threads[0].id, actionNotice: null });

    useApp.getState().archiveThread(threads[0].id);
    vi.advanceTimersByTime(2500);

    expect(useApp.getState().actionNotice).toBeNull();
  });
});
