import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftsView } from "@/components/DraftsView";
import { account } from "@/data/mock";
import { useApp } from "@/store";
import { renderTest } from "@/test/render";
import type { OutgoingMessage } from "@/types";

const failedDraft: OutgoingMessage = {
  id: "ob-failed",
  accountId: account.id,
  to: "person@example.test",
  cc: "copy@example.test",
  bcc: "",
  subject: "Saved subject",
  body: "<p>Saved body</p>",
  attachments: [{ name: "notes.txt", mime: "text/plain", dataB64: "c2F2ZWQ=" }],
  scheduledTs: 100,
  status: "dead",
  error: "transient: Connection error: timed out",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DraftsView", () => {
  it("shows failed sends and reopens their saved content", () => {
    useApp.setState({ outbox: [], deadLetters: [failedDraft], accounts: [account] });
    const view = renderTest(<DraftsView />);

    expect(view.host.textContent).toContain("Failed");
    expect(view.host.textContent).toContain("Saved subject");
    expect(view.host.textContent).toContain("1 attachment");
    act(() => view.host.querySelector<HTMLButtonElement>(".draft-open")?.click());
    expect(useApp.getState().composeDraft?.id).toBe("ob-failed");
    expect(useApp.getState().composeOpen).toBe(true);
    view.unmount();
  });

  it("shows pending scheduled sends separately from failed sends", () => {
    useApp.setState({
      outbox: [
        { ...failedDraft, id: "ob-scheduled", status: "queued", scheduledTs: 4_000_000_000 },
      ],
      deadLetters: [],
      accounts: [account],
    });
    const view = renderTest(<DraftsView />);

    expect(view.host.textContent).toContain("Scheduled");
    expect(view.host.textContent).not.toContain("Retrying");
    view.unmount();
  });
});
