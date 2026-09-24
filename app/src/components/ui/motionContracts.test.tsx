// Verifies routine controls and overlays provide feedback without decorative transforms.
import { act, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandBar } from "@/components/CommandBar";
import { ModelPicker } from "@/components/ModelPicker";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Modal } from "@/components/ui/Modal";
import { aiProfile } from "@/data/mock";
import { useApp } from "@/store";

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

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const host of hosts.splice(0)) host.remove();
  document.body.style.overflow = "";
});

describe("routine motion contracts", () => {
  it("keeps primary and icon buttons native and transform-free", () => {
    const onPrimary = vi.fn();
    const onIcon = vi.fn();
    const { host, root } = hostRoot();
    act(() => root.render(
      <>
        <Button onClick={onPrimary}>Save</Button>
        <IconButton icon="close" title="Close" onClick={onIcon} />
      </>,
    ));

    const buttons = host.querySelectorAll<HTMLButtonElement>("button");
    expect(buttons).toHaveLength(2);
    act(() => {
      buttons[0].focus();
      buttons[1].focus();
      buttons[0].click();
      buttons[1].click();
    });
    expect(onPrimary).toHaveBeenCalledOnce();
    expect(onIcon).toHaveBeenCalledOnce();
    expect([...buttons].every((button) => button.style.transform === "")).toBe(true);
  });

  it("opens command, model, and modal surfaces without transform entrances", () => {
    useApp.setState({ cmdOpen: true, modelPickerOpen: true, ai: aiProfile });
    const { root } = hostRoot();
    act(() => root.render(
      <>
        <CommandBar />
        <ModelPicker />
        <Modal open onClose={() => undefined} title="Confirm">Body</Modal>
      </>,
    ));

    for (const selector of [".cmd", ".pop", ".modal-panel"]) {
      expect(document.querySelector<HTMLElement>(selector)?.style.transform).toBe("");
    }
  });

  it("closes a modal before a global Escape handler can rerender it", () => {
    const onClose = vi.fn();
    function Harness() {
      const [, setRevision] = useState(0);
      useLayoutEffect(() => {
        const rerender = (event: KeyboardEvent) => {
          if (event.key === "Escape") flushSync(() => setRevision((value) => value + 1));
        };
        window.addEventListener("keydown", rerender);
        return () => window.removeEventListener("keydown", rerender);
      }, []);
      return <Modal open onClose={() => onClose()} title="Confirm">Body</Modal>;
    }

    const { root } = hostRoot();
    act(() => root.render(<Harness />));
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));

    expect(onClose).toHaveBeenCalledOnce();
  });
});
