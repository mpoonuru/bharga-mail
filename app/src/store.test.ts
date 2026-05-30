import { describe, it, expect, beforeEach } from "vitest";
import { useApp } from "@/store";

// The store is a singleton; reload mock data before each test for isolation.
beforeEach(async () => {
  await useApp.getState().load();
  useApp.setState({ undo: null, view: "priority", composeOpen: false });
});

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

  it("updateModel flips readiness when a cloud key is set", () => {
    useApp.getState().updateModel("gpt", { apiKey: "sk-test" });
    const m = useApp.getState().ai!.models.find((x) => x.id === "gpt")!;
    expect(m.ready).toBe(true);
  });

  it("setPrivacy updates the preset", () => {
    useApp.getState().setPrivacy("local");
    expect(useApp.getState().ai!.privacy).toBe("local");
  });
});

describe("undo send", () => {
  it("queueSend sets an undo entry, cancelUndo clears it", async () => {
    await useApp.getState().queueSend({ to: "a@b.c", subject: "Re: x", body: "hi" });
    expect(useApp.getState().undo).not.toBeNull();
    useApp.getState().cancelUndo();
    expect(useApp.getState().undo).toBeNull();
  });
});
