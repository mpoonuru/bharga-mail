// Keyboard and modal-interaction coverage for the shared accessible select control.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { renderTest } from "@/test/render";

afterEach(() => {
  document.body.replaceChildren();
});

describe("Select", () => {
  it("supports listbox arrow, Home, End, and Enter selection", async () => {
    const onChange = vi.fn();
    renderTest(
      <Select
        ariaLabel="Security"
        value="ssl"
        onChange={onChange}
        options={[
          { value: "ssl", label: "SSL/TLS" },
          { value: "starttls", label: "STARTTLS" },
          { value: "none", label: "None" },
        ]}
      />,
    );
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Security"]');
    act(() => button?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    const first = document.activeElement as HTMLButtonElement;
    act(() => first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(document.activeElement?.textContent).toContain("None");
    act(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onChange).toHaveBeenCalledWith("none");
  });

  it("closes only the listbox when Escape is pressed inside a modal", async () => {
    const closeModal = vi.fn();
    renderTest(
      <Modal open onClose={closeModal} title="Account">
        <Select ariaLabel="Security" value="ssl" onChange={vi.fn()} options={[{ value: "ssl", label: "SSL/TLS" }]} />
      </Modal>,
    );
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Security"]');
    act(() => button?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    act(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(closeModal).not.toHaveBeenCalled();
  });
});
