// Covers fail-closed account selection and visible send errors in new-message compose.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Compose } from "@/components/Compose";
import { useApp } from "@/store";

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(async () => {
  await useApp.getState().load();
  useApp.setState({ composeOpen: true, undo: null });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

async function renderCompose() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<Compose />));
}

function sendButton(): HTMLButtonElement {
  const button = [...(host?.querySelectorAll("button") ?? [])]
    .find((candidate) => candidate.textContent?.trim() === "Send");
  if (!(button instanceof HTMLButtonElement)) throw new Error("Send button not found");
  return button;
}

describe("Compose", () => {
  it("disables send actions when no valid From account exists", async () => {
    useApp.setState({ accounts: [], selectedAccountId: null });
    await renderCompose();

    expect(sendButton().disabled).toBe(true);
    expect(host?.querySelector('button[title="Send later"]')).toHaveProperty("disabled", true);
  });

  it("keeps the draft open and shows a send failure", async () => {
    const failure = "The message could not be queued.";
    vi.spyOn(useApp.getState(), "queueSend").mockRejectedValue(new Error(failure));
    await renderCompose();

    await act(async () => sendButton().click());

    expect(useApp.getState().composeOpen).toBe(true);
    expect(host?.querySelector('[role="alert"]')?.textContent).toContain(failure);
  });
});
