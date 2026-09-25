// Guards the app-level calendar route against regressing to the old preview.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CalendarView } from "@/components/CalendarView";
import { renderTest } from "@/test/render";

let cleanup: (() => void) | undefined;

afterEach(() => cleanup?.());

describe("CalendarView", () => {
  it("mounts the production calendar workspace", async () => {
    const rendered = renderTest(<CalendarView />);
    cleanup = rendered.unmount;

    await act(async () => {
      await vi.waitFor(() => expect(rendered.host.textContent).toContain("Calendar"));
    });

    expect(rendered.host.textContent).not.toMatch(/calendar preview|example events/i);
    expect([...rendered.host.querySelectorAll("button")].map((button) => button.textContent)).toContain("Month");
  });
});
