// Verifies global shortcuts never act on mail hidden behind an application modal.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal } from "@/components/ui/Modal";
import { threads } from "@/data/mock";
import { useHotkeys } from "@/lib/useHotkeys";
import { useApp } from "@/store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];

function Harness() {
  useHotkeys();
  return (
    <Modal open onClose={() => undefined} title="Confirm action">
      <button type="button">Keep editing</button>
    </Modal>
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  document.body.style.overflow = "";
});

describe("global keyboard shortcuts", () => {
  it("does not run mail actions while a modal is open", () => {
    const archiveThread = vi.fn();
    useApp.setState({
      threads: [threads[0]],
      view: "inbox",
      selectedThreadId: threads[0].id,
      archiveThread,
      cmdOpen: false,
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(<Harness />));

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true })));

    expect(archiveThread).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
