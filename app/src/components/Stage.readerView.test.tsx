import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Stage } from "@/components/Stage";
import { account, threads } from "@/data/mock";
import { renderTest } from "@/test/render";
import { useApp } from "@/store";

const mounted: ReturnType<typeof renderTest>[] = [];
afterEach(() => { for (const item of mounted.splice(0)) item.unmount(); });

function renderReader() {
  const thread = {
    ...threads[0],
    messages: [{ ...threads[0].messages[0], bodyHtml: '<table width="1200"><tr><td style="white-space:nowrap">Invoice columns</td></tr></table><img src="https://example.test/tracker.png">' }],
  };
  useApp.setState({ accounts: [account], threads: [thread, threads[1]], selectedThreadId: thread.id, selectedMessageId: null });
  const rendered = renderTest(<Stage />);
  mounted.push(rendered);
  return rendered.host;
}

function button(host: HTMLElement, name: string) {
  const control = host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  expect(control, `${name} control`).not.toBeNull();
  return control!;
}

function choose(host: HTMLElement, label: string, option: string) {
  act(() => button(host, label).click());
  const target = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((node) => node.textContent === option);
  expect(target, option).toBeDefined();
  act(() => target!.click());
}

describe("message display controls", () => {
  it("defaults to Fit width and switches to Original layout without reloading the email", () => {
    const host = renderReader();
    expect(button(host, "Message layout").textContent).toBe("Fit width");
    const frame = host.querySelector<HTMLIFrameElement>("iframe")!;
    const document = frame.srcdoc;
    choose(host, "Message layout", "Original layout");
    expect(button(host, "Message layout").textContent).toBe("Original layout");
    expect(host.querySelector("iframe")).toBe(frame);
    expect(frame.srcdoc).toBe(document);
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frame.srcdoc).toContain("data-blocked-src");
    expect(host.querySelector(".img-banner")).not.toBeNull();
  });

  it("supports whole-message zoom presets, steps, and limits", () => {
    const host = renderReader();
    expect(button(host, "Message zoom").textContent).toBe("100%");
    const frame = host.querySelector<HTMLIFrameElement>("iframe")!;
    const document = frame.srcdoc;
    act(() => button(host, "Zoom in").click());
    expect(button(host, "Message zoom").textContent).toBe("110%");
    choose(host, "Message zoom", "200%");
    expect(button(host, "Zoom in").disabled).toBe(true);
    choose(host, "Message zoom", "50%");
    expect(button(host, "Zoom out").disabled).toBe(true);
    choose(host, "Message zoom", "100%");
    expect(button(host, "Message zoom").textContent).toBe("100%");
    expect(host.querySelector("iframe")).toBe(frame);
    expect(frame.srcdoc).toBe(document);
  });

  it("starts a newly selected conversation at Fit width and 100%", async () => {
    const host = renderReader();
    choose(host, "Message layout", "Original layout");
    choose(host, "Message zoom", "150%");
    act(() => useApp.setState({ selectedThreadId: threads[1].id }));
    await vi.waitFor(() => expect(host.querySelectorAll('button[aria-label="Message layout"]')).toHaveLength(1));
    expect(button(host, "Message layout").textContent).toBe("Fit width");
    expect(button(host, "Message zoom").textContent).toBe("100%");
  });
});
