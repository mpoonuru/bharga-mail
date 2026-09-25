// Verifies that desktop IPC failures never fall back to preview data or success.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("@tauri-apps/api/core");
  vi.resetModules();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("bridge desktop failures", () => {
  it("sends bounded range inputs to the calendar command", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    const invoke = vi.fn().mockResolvedValue([]);
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { api } = await import("@/lib/bridge");

    await api.calendar.listEvents({
      start: "2026-09-01T00:00:00Z",
      end: "2026-10-01T00:00:00Z",
    });

    expect(invoke).toHaveBeenCalledWith("list_calendar_events", {
      input: {
        start: "2026-09-01T00:00:00Z",
        end: "2026-10-01T00:00:00Z",
      },
    });
  });

  it("propagates account and send IPC failures", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    const invoke = vi.fn().mockRejectedValue(new Error("desktop IPC unavailable"));
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));

    const { api, runtimeMode } = await import("@/lib/bridge");

    expect(runtimeMode()).toBe("desktop");
    await expect(api.listAccounts()).rejects.toThrow("desktop IPC unavailable");
    await expect(api.queueSend({
      accountId: "account-1",
      to: "recipient@example.test",
      subject: "Subject",
      body: "Body",
      delaySeconds: 10,
    })).rejects.toThrow("desktop IPC unavailable");
  });

  it("delegates validated web links to the native opener command", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { api } = await import("@/lib/bridge");

    await api.openExternalUrl("https://example.test/path");

    expect(invoke).toHaveBeenCalledWith("open_external_url", { url: "https://example.test/path" });
  });
});
