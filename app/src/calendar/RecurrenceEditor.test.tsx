import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RecurrenceEditor } from "@/calendar/RecurrenceEditor";
import { renderTest } from "@/test/render";

let cleanup: (() => void) | undefined;

afterEach(() => cleanup?.());

describe("RecurrenceEditor", () => {
  it("emits a normalized weekly rule", () => {
    const onChange = vi.fn();
    const rendered = renderTest(<RecurrenceEditor value={null} onChange={onChange} />);
    cleanup = rendered.unmount;
    const repeat = rendered.host.querySelector<HTMLSelectElement>('select[aria-label="Repeat"]');

    act(() => {
      if (!repeat) return;
      repeat.value = "weekly";
      repeat.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith({ rules: ["FREQ=WEEKLY"], dates: [], excludedDates: [] });
  });

  it("preserves a custom RFC rule without executing it in the browser", () => {
    const onChange = vi.fn();
    const rendered = renderTest(
      <RecurrenceEditor value={{ rules: ["FREQ=WEEKLY;INTERVAL=2"], dates: [], excludedDates: [] }} onChange={onChange} />,
    );
    cleanup = rendered.unmount;

    expect(rendered.host.querySelector<HTMLInputElement>('input[aria-label="Recurrence rule"]')?.value)
      .toBe("FREQ=WEEKLY;INTERVAL=2");
  });
});
