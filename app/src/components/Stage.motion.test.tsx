// Guards the reading pane against staggered or translated child entrances.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Stage } from "@/components/Stage";
import { account, threads } from "@/data/mock";
import { THREAD_CROSSFADE } from "@/lib/motion";
import { useApp } from "@/store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("Stage motion", () => {
  it("keeps the reading pane and its children free of translated entrances", () => {
    expect(THREAD_CROSSFADE.duration).toBe(0.12);
    useApp.setState({
      accounts: [account],
      threads: threads.slice(0, 2),
      selectedThreadId: threads[0].id,
      selectedMessageId: null,
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    act(() => root?.render(<Stage />));

    const stage = host.querySelector<HTMLElement>(".stage-inner");
    const summary = host.querySelector<HTMLElement>(".ai-summary");
    const message = host.querySelector<HTMLElement>(".msg");
    expect(stage?.style.transform).toBe("");
    expect(summary?.style.transform).toBe("");
    expect(message?.style.transform).toBe("");
    expect(summary?.style.opacity).toBe("");
    expect(message?.style.opacity).toBe("");

    act(() => useApp.setState({ selectedThreadId: threads[1].id }));
    expect(host.textContent).toContain(threads[1].subject);
  });
});
