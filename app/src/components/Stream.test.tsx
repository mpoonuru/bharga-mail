// Verifies routine inbox rendering is stable instead of replaying row entrances.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Stream } from "@/components/Stream";
import { account, threads } from "@/data/mock";
import { useApp } from "@/store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];
const containers: HTMLDivElement[] = [];
const originalScrollTo = HTMLElement.prototype.scrollTo;

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const container of containers.splice(0)) container.remove();
  HTMLElement.prototype.scrollTo = originalScrollTo;
});

describe("Stream row motion", () => {
  it("renders existing mail without inline entrance opacity or translation", () => {
    HTMLElement.prototype.scrollTo = () => undefined;
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    useApp.setState({
      accounts: [account],
      threads: [threads[0]],
      view: "inbox",
      selectedAccountId: null,
      selectedFolder: null,
      selectedThreadId: null,
    });

    act(() => root.render(<Stream />));

    const row = container.querySelector<HTMLElement>(".mail");
    expect(row).not.toBeNull();
    expect(row?.style.opacity).toBe("");
    expect(row?.style.transform).toBe("");
  });
});
