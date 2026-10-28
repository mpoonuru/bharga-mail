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

async function dropFiles(files: File[]) {
  const editor = host?.querySelector(".rt-area");
  if (!(editor instanceof HTMLDivElement)) throw new Error("Message editor not found");

  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { files, types: ["Files"] },
  });

  await act(async () => editor.dispatchEvent(event));
  await vi.waitFor(() => {
    expect(host?.querySelector(".attach-row")).not.toBeNull();
  });
}

async function enterWithFiles(files: File[]) {
  const editor = host?.querySelector(".rt-area");
  if (!(editor instanceof HTMLDivElement)) throw new Error("Message editor not found");

  const event = new Event("dragenter", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      files,
      items: files.map(() => ({ kind: "file" })),
      types: ["Files"],
    },
  });

  await act(async () => editor.dispatchEvent(event));
}

async function dragFilesOverEditor(files: File[], onEditorDragOver: () => void) {
  const editor = host?.querySelector(".rt-area");
  if (!(editor instanceof HTMLDivElement)) throw new Error("Message editor not found");
  editor.addEventListener("dragover", onEditorDragOver);

  const event = new Event("dragover", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { files, items: files.map(() => ({ kind: "file" })), types: ["Files"], dropEffect: "none" },
  });

  await act(async () => editor.dispatchEvent(event));
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

  it("attaches every file dropped onto the composer", async () => {
    await renderCompose();

    await dropFiles([
      new File(["quarterly results"], "results.pdf", { type: "application/pdf" }),
      new File(["project notes"], "notes.txt", { type: "text/plain" }),
    ]);

    expect(host?.querySelector(".attach-row")?.textContent).toContain("results.pdf");
    expect(host?.querySelector(".attach-row")?.textContent).toContain("notes.txt");
  });

  it("shows a file-aware drop tray while attachments are dragged over the message", async () => {
    await renderCompose();

    await enterWithFiles([
      new File(["first"], "first.pdf", { type: "application/pdf" }),
      new File(["second"], "second.png", { type: "image/png" }),
    ]);

    const status = host?.querySelector('[role="status"]');
    expect(status?.classList.contains("composer-drop-overlay")).toBe(true);
    expect(status?.querySelector(".composer-drop-tray")).not.toBeNull();
    expect(status?.textContent).toContain("Release to attach 2 files");
    expect(status?.textContent).toContain("They’ll be added to this draft");
  });

  it("keeps file drag-over events away from the rich-text editor", async () => {
    await renderCompose();
    const editorDragOver = vi.fn();

    await dragFilesOverEditor(
      [new File(["archive"], "documents.zip", { type: "application/zip" })],
      editorDragOver,
    );

    expect(editorDragOver).not.toHaveBeenCalled();
  });
});
