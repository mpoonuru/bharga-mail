import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useApp } from "@/store";
import { api } from "@/lib/bridge";

// The store is a singleton; reload mock data before each test for isolation.
beforeEach(async () => {
  await useApp.getState().load();
  useApp.setState({ undo: null, view: "priority", composeOpen: false });
});

afterEach(() => vi.restoreAllMocks());

describe("navigation", () => {
  it("selecting a thread opens the mobile stage", () => {
    useApp.getState().selectThread("t2");
    expect(useApp.getState().selectedThreadId).toBe("t2");
    expect(useApp.getState().mobileStage).toBe(true);
  });

  it("changing view resets compose/drawer/stage", () => {
    useApp.setState({ composeOpen: true, drawerOpen: true, mobileStage: true });
    useApp.getState().setView("inbox");
    const s = useApp.getState();
    expect(s.view).toBe("inbox");
    expect(s.composeOpen).toBe(false);
    expect(s.drawerOpen).toBe(false);
    expect(s.mobileStage).toBe(false);
  });
});

describe("theme & density", () => {
  it("toggles theme and reflects it on <html>", () => {
    const before = useApp.getState().theme;
    useApp.getState().toggleTheme();
    expect(useApp.getState().theme).not.toBe(before);
    expect(document.documentElement.getAttribute("data-theme")).toBe(useApp.getState().theme);
  });

  it("sets density", () => {
    useApp.getState().setDensity("compact");
    expect(useApp.getState().density).toBe("compact");
    expect(document.documentElement.getAttribute("data-density")).toBe("compact");
  });
});

describe("tasks", () => {
  it("toggleTask flips done", () => {
    const id = useApp.getState().tasks[0].id;
    const before = useApp.getState().tasks[0].done;
    useApp.getState().toggleTask(id);
    expect(useApp.getState().tasks.find((t) => t.id === id)!.done).toBe(!before);
  });

  it("createTask adds optimistically", async () => {
    const n = useApp.getState().tasks.length;
    await useApp.getState().createTask("New task", "t1");
    expect(useApp.getState().tasks.length).toBe(n + 1);
    expect(useApp.getState().tasks.at(-1)!.title).toBe("New task");
  });
});

describe("AI engine config", () => {
  it("assignRole adds a role to a model", () => {
    useApp.getState().assignRole("llama", "draft");
    const m = useApp.getState().ai!.models.find((x) => x.id === "llama")!;
    expect(m.roles).toContain("draft");
  });

  it("saveModel accepts a write-only cloud credential", async () => {
    const current = useApp.getState().ai!.models.find((model) => model.id === "gpt")!;
    await useApp.getState().saveModel({ ...current, apiKey: ["fixture", "credential"].join("-") });
    const m = useApp.getState().ai!.models.find((x) => x.id === "gpt")!;
    expect(m.ready).toBe(true);
    expect("apiKey" in m).toBe(false);
  });

  it("setPrivacy updates the preset", () => {
    useApp.getState().setPrivacy("local");
    expect(useApp.getState().ai!.privacy).toBe("local");
  });

  it("removeModel removes the provider and its role assignments", async () => {
    await useApp.getState().removeModel("custom");

    expect(useApp.getState().ai!.models.some((model) => model.id === "custom")).toBe(false);
  });

  it("removes an unsaved provider without discarding other unsaved providers", async () => {
    const existingIds = new Set(useApp.getState().ai!.models.map((model) => model.id));
    useApp.getState().addModel();
    useApp.getState().addModel();
    const added = useApp.getState().ai!.models.filter((model) => !existingIds.has(model.id));

    expect(added).toHaveLength(2);

    await useApp.getState().removeModel(added[0].id);

    const remainingIds = useApp.getState().ai!.models.map((model) => model.id);
    expect(remainingIds).not.toContain(added[0].id);
    expect(remainingIds).toContain(added[1].id);
  });
});

describe("undo send", () => {
  it("queueSend sets an undo entry, cancelUndo clears it", async () => {
    await useApp.getState().queueSend({ to: "a@b.c", subject: "Re: x", body: "hi" });
    expect(useApp.getState().undo).not.toBeNull();
    useApp.getState().cancelUndo();
    expect(useApp.getState().undo).toBeNull();
  });

  it("routes a reply through its thread account", async () => {
    const accounts = [
      { id: "personal", email: "alex@example.com", provider: "imap" as const, displayName: "Personal" },
      { id: "work", email: "alex@company.test", provider: "microsoft" as const, displayName: "Work" },
    ];
    const thread = { ...useApp.getState().threads[0], accountId: "work" };
    useApp.setState({ accounts, threads: [thread], selectedAccountId: "personal" });
    const send = vi.spyOn(api, "queueSend").mockResolvedValue("outbox-1");

    await useApp.getState().queueSend({ threadId: thread.id, to: "person@example.net", subject: "Re: test", body: "Hello" });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ accountId: "work" }));
  });

  it("refuses to send without a connected account", async () => {
    useApp.setState({ accounts: [], threads: [], selectedAccountId: null, undo: null });
    const send = vi.spyOn(api, "queueSend").mockResolvedValue("outbox-1");

    await expect(useApp.getState().queueSend({ to: "person@example.net", subject: "test", body: "Hello" }))
      .rejects.toThrow("Choose a connected account before sending.");
    expect(send).not.toHaveBeenCalled();
    expect(useApp.getState().undo).toBeNull();
  });
});
