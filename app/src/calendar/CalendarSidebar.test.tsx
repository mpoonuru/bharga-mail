/** Source lifecycle and discoverable order-control behavior tests. */

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CalendarSidebar } from "@/calendar/CalendarSidebar";
import { renderTest } from "@/test/render";
import type { Calendar, CalendarSource } from "@/types";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const source: CalendarSource = {
  id: "source", linkedAccountId: null, provider: "calDav", label: "Team calendar",
  address: null, authState: "ready", capabilities: [], lastSyncAt: null,
  syncError: null, disabled: false,
};
const calendars: Calendar[] = ["Work", "Personal"].map((name, index) => ({
  id: name.toLowerCase(), sourceId: "source", providerId: name, name, description: "",
  color: "#6f8df6", timezone: "UTC", accessRole: "owner", writable: true,
  visible: true, isDefault: index === 0, sortOrder: index,
}));

describe("CalendarSidebar", () => {
  it("keeps reorder controls discoverable and explains provider-safe disconnect", () => {
    const onOrder = vi.fn();
    const rendered = renderTest(
      <CalendarSidebar
        sources={[source]}
        calendars={calendars}
        visibleCalendarIds={calendars.map((calendar) => calendar.id)}
        loading={false}
        onVisibility={() => {}}
        onSync={() => {}}
        onOrder={onOrder}
        onRenameSource={vi.fn()}
        onRemoveSource={vi.fn()}
      />,
    );
    cleanup = rendered.unmount;
    expect(document.querySelector('[aria-label="Move Work down"]')).not.toBeNull();
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Move Work down"]')?.click());
    expect(onOrder).toHaveBeenCalledWith(["personal", "work"]);
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Manage Team calendar"]')?.click());
    expect(document.body.textContent).toContain("Disconnecting never deletes events from the calendar provider");
    expect(document.body.textContent).toContain("Disconnect and keep a local copy");
  });
});
