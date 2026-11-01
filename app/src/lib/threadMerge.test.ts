import { describe, expect, it } from "vitest";
import type { Message, Thread } from "@/types";
import { keepLoadedBodies, messageSignature, needsBodies } from "./threadMerge";

const message = (id: string, bodyHtml = ""): Message => ({
  id,
  from: { name: "A", address: "a@example.test" },
  to: [],
  when: "2026-11-01T05:31:00Z",
  bodyHtml,
});

const thread = (id: string, messages: Message[], extra: Partial<Thread> = {}): Thread =>
  ({ id, accountId: "acc", subject: id, preview: "", participants: [], lastTime: "", unread: false, labels: [], view: ["inbox"], folder: "INBOX", messages, ...extra }) as Thread;

describe("keepLoadedBodies", () => {
  it("keeps a loaded body when a body-less refresh arrives (the blank reader bug)", () => {
    const open = thread("t1", [message("m1", "<table>report</table>")]);
    const refreshed = thread("t1", [message("m1")], { unread: true });
    const [merged] = keepLoadedBodies([refreshed], [open]);
    expect(merged.messages[0].bodyHtml).toBe("<table>report</table>");
    expect(merged.unread).toBe(true); // metadata comes from the fresh list
  });

  it("leaves new messages empty and untouched threads by reference", () => {
    const previous = [thread("t1", [message("m1", "<p>old</p>")])];
    const other = thread("t2", [message("x1")]);
    const fresh = [thread("t1", [message("m1"), message("m2")]), other];
    const merged = keepLoadedBodies(fresh, previous);
    expect(merged[0].messages.map((m) => m.bodyHtml)).toEqual(["<p>old</p>", ""]);
    expect(merged[1]).toBe(other);
    expect(needsBodies(merged[0])).toBe(true);
  });

  it("does not move a body between threads that share a message id", () => {
    const merged = keepLoadedBodies([thread("t2", [message("m1")])], [thread("t1", [message("m1", "<p>t1</p>")])]);
    expect(merged[0].messages[0].bodyHtml).toBe("");
  });

  it("signature changes when a message arrives", () => {
    expect(messageSignature(thread("t", [message("a")]))).not.toBe(messageSignature(thread("t", [message("a"), message("b")])));
  });
});
