import { describe, it, expect } from "vitest";
import { api } from "@/lib/bridge";

// Outside Tauri, the bridge falls back to seed data — verify those paths.
describe("bridge fallbacks (non-Tauri)", () => {
  it("listThreads returns seed threads", async () => {
    const threads = await api.listThreads();
    expect(threads.length).toBeGreaterThan(0);
    expect(threads[0]).toHaveProperty("subject");
  });

  it("listTasks and getAiProfile resolve", async () => {
    expect((await api.listTasks()).length).toBeGreaterThan(0);
    const ai = await api.getAiProfile();
    expect(ai.models.length).toBeGreaterThan(0);
  });

  it("draftReply returns the seed draft for a known thread", async () => {
    const draft = await api.draftReply("t1", "Subject: x");
    expect(typeof draft).toBe("string");
    expect(draft.length).toBeGreaterThan(0);
  });

  it("askInbox echoes the query in its fallback answer", async () => {
    const ans = await api.askInbox("renewal deadline");
    expect(ans).toContain("renewal deadline");
  });

  it("queueSend returns an id and cancelSend resolves", async () => {
    const id = await api.queueSend({ accountId: "gmail:me", to: "x@y.z", subject: "s", body: "b", delaySeconds: 10 });
    expect(typeof id).toBe("string");
    expect(await api.cancelSend(id)).toBe(true);
  });
});
