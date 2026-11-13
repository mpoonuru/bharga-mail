import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/bridge";
import { useApp } from "@/store";
import type { OutgoingMessage } from "@/types";

const draft: OutgoingMessage = {
  id: "ob-draft",
  accountId: "acc1",
  to: "person@example.test",
  cc: "",
  bcc: "",
  subject: "Subject",
  body: "<p>Body</p>",
  attachments: [],
  scheduledTs: 100,
  status: "queued",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("outgoing draft state", () => {
  it("loads pending drafts but hides messages already sent", async () => {
    vi.spyOn(api, "listOutbox").mockResolvedValue([
      draft,
      { ...draft, id: "ob-sent", status: "sent" },
    ]);
    vi.spyOn(api, "listDeadLetters").mockResolvedValue([]);

    await useApp.getState().loadDeadLetters();

    expect(useApp.getState().outbox.map((item) => item.id)).toEqual(["ob-draft"]);
  });

  it("removes a pending draft only after replacement queuing succeeds", async () => {
    const cancel = vi.spyOn(api, "cancelSend").mockResolvedValue(true);
    vi.spyOn(api, "listOutbox").mockResolvedValue([]);
    vi.spyOn(api, "listDeadLetters").mockResolvedValue([]);

    await useApp.getState().completeDraft(draft);

    expect(cancel).toHaveBeenCalledWith("ob-draft");
  });

  it("discards the old dead letter after its replacement is queued", async () => {
    const discard = vi.spyOn(api, "discardDeadLetter").mockResolvedValue(undefined);
    vi.spyOn(api, "listOutbox").mockResolvedValue([]);
    vi.spyOn(api, "listDeadLetters").mockResolvedValue([]);

    await useApp.getState().completeDraft({ ...draft, status: "dead" });

    expect(discard).toHaveBeenCalledWith("ob-draft");
  });
});
