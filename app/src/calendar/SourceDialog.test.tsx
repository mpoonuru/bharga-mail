/** Behavior tests for secure CalDAV source discovery and selection. */

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SourceDialog } from "@/calendar/SourceDialog";
import { renderTest, setInputValue } from "@/test/render";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function fields() {
  return {
    url: document.querySelector<HTMLInputElement>('input[aria-label="CalDAV URL"]')!,
    username: document.querySelector<HTMLInputElement>('input[aria-label="Username"]')!,
    password: document.querySelector<HTMLInputElement>('input[aria-label="Password"]')!,
  };
}

describe("SourceDialog", () => {
  it("rejects insecure URLs before discovery", () => {
    const discoverCalDav = vi.fn();
    const rendered = renderTest(<SourceDialog open onClose={() => {}} onSaved={() => {}} sourceApi={{ discoverCalDav, saveCalDavSource: vi.fn() }} />);
    cleanup = rendered.unmount;
    const input = fields();
    setInputValue(input.url, "http://calendar.example.test");
    setInputValue(input.username, "alex");
    setInputValue(input.password, "not-rendered");
    const discover = [...document.querySelectorAll("button")].find((button) => button.textContent === "Discover calendars");
    act(() => discover?.click());
    expect(document.body.textContent).toContain("Use an HTTPS CalDAV URL");
    expect(discoverCalDav).not.toHaveBeenCalled();
    expect(input.password.type).toBe("password");
    expect(document.body.textContent).not.toContain("not-rendered");
  });

  it("shows discovered collections and saves only selected ids", async () => {
    const discoverCalDav = vi.fn().mockResolvedValue([{ id: "work", href: "https://dav.example.test/work/", name: "Work", description: "", color: "#123456", timezone: "UTC", writable: true, supportsSyncCollection: true, supportsScheduling: false, ctag: null, syncToken: null }]);
    const saveCalDavSource = vi.fn().mockResolvedValue({ id: "source", provider: "calDav", label: "Team", address: null });
    const rendered = renderTest(<SourceDialog open onClose={() => {}} onSaved={() => {}} sourceApi={{ discoverCalDav, saveCalDavSource }} />);
    cleanup = rendered.unmount;
    const input = fields();
    setInputValue(input.url, "https://dav.example.test");
    setInputValue(input.username, "alex");
    setInputValue(input.password, "hidden-secret");
    await act(async () => { [...document.querySelectorAll("button")].find((button) => button.textContent === "Discover calendars")?.click(); });
    expect(document.body.textContent).toContain("Work");
    expect(document.body.textContent).not.toContain("hidden-secret");
    await act(async () => { [...document.querySelectorAll("button")].find((button) => button.textContent === "Add connection")?.click(); });
    expect(saveCalDavSource).toHaveBeenCalledWith(expect.objectContaining({ selectedCalendarIds: ["work"] }));
  });
});
