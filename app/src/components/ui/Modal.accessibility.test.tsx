// Verifies dialog semantics, focus containment, and opener restoration.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Modal } from "@/components/ui/Modal";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const hosts: HTMLDivElement[] = [];

function hostRoot() {
  const host = document.createElement("div");
  document.body.append(host);
  hosts.push(host);
  const root = createRoot(host);
  roots.push(root);
  return { host, root };
}

function DialogHarness({ labelOnly = false }: { labelOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
      {labelOnly ? (
        <Modal open={open} onClose={() => setOpen(false)} ariaLabel="Attachment preview">
          <button type="button">Only action</button>
        </Modal>
      ) : (
        <Modal open={open} onClose={() => setOpen(false)} title="Confirm action">
          <button type="button">First action</button>
          <button type="button">Last action</button>
        </Modal>
      )}
    </>
  );
}

function ControlledDialogHarness() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open editor</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Edit signature">
        <label>
          Name
          <input value={value} onInput={(event) => setValue(event.currentTarget.value)} />
        </label>
      </Modal>
    </>
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const host of hosts.splice(0)) host.remove();
  document.body.style.overflow = "";
});

describe("Modal accessibility", () => {
  it("names the dialog and moves initial focus to its close button", () => {
    const { host, root } = hostRoot();
    act(() => root.render(<DialogHarness />));
    const opener = host.querySelector<HTMLButtonElement>("button");
    act(() => opener?.click());

    const panel = document.querySelector<HTMLElement>(".modal-panel");
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]');
    const title = document.querySelector<HTMLElement>(".modal-head b");
    expect(panel?.getAttribute("role")).toBe("dialog");
    expect(panel?.getAttribute("aria-modal")).toBe("true");
    expect(panel?.getAttribute("aria-labelledby")).toBe(title?.id);
    expect(document.activeElement).toBe(close);
  });

  it("wraps focus in both directions", () => {
    const { host, root } = hostRoot();
    act(() => root.render(<DialogHarness />));
    act(() => host.querySelector<HTMLButtonElement>("button")?.click());
    const controls = [...document.querySelectorAll<HTMLButtonElement>(".modal-panel button")];
    const first = controls[0];
    const last = controls[controls.length - 1];

    act(() => {
      last.focus();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", cancelable: true }));
    });
    expect(document.activeElement).toBe(first);

    act(() => {
      first.focus();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(last);
  });

  it("closes with Escape and restores the opener", () => {
    const { host, root } = hostRoot();
    act(() => root.render(<DialogHarness />));
    const opener = host.querySelector<HTMLButtonElement>("button")!;
    act(() => {
      opener.focus();
      opener.click();
    });

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));

    expect(document.activeElement).toBe(opener);
  });

  it("closes from the backdrop and restores the opener", () => {
    const { host, root } = hostRoot();
    act(() => root.render(<DialogHarness />));
    const opener = host.querySelector<HTMLButtonElement>("button")!;
    act(() => {
      opener.focus();
      opener.click();
    });
    const overlay = document.querySelector<HTMLElement>(".modal-overlay")!;

    act(() => overlay.click());

    expect(document.activeElement).toBe(opener);
  });

  it("supports an accessible label without a visible title", () => {
    const { host, root } = hostRoot();
    act(() => root.render(<DialogHarness labelOnly />));
    act(() => host.querySelector<HTMLButtonElement>("button")?.click());

    const panel = document.querySelector<HTMLElement>(".modal-panel");
    expect(panel?.getAttribute("aria-label")).toBe("Attachment preview");
    expect(panel?.getAttribute("aria-labelledby")).toBeNull();
  });

  it("does not reset focus when a controlled field rerenders its parent", () => {
    const { host, root } = hostRoot();
    act(() => root.render(<ControlledDialogHarness />));
    act(() => host.querySelector<HTMLButtonElement>("button")?.click());
    const input = document.querySelector<HTMLInputElement>('.modal-panel input')!;

    act(() => {
      input.focus();
      input.value = "W";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(document.activeElement).toBe(input);
  });
});
