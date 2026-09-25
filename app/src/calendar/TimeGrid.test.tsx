import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TimeGrid } from "@/calendar/TimeGrid";
import type { CalendarEvent } from "@/calendar/types";
import { renderTest } from "@/test/render";

let cleanup: (() => void) | undefined;

afterEach(() => cleanup?.());

function timedEvent(id: string, start: string, end: string): CalendarEvent {
  return {
    id,
    calendarId: "calendar-1",
    uid: `${id}@example.test`,
    providerId: null,
    title: `Event ${id.toUpperCase()}`,
    description: "",
    location: "",
    conferenceUrl: null,
    sourceThreadId: null,
    start: { kind: "timed", utc: start },
    end: { kind: "timed", utc: end },
    timezone: "UTC",
    recurrence: null,
    recurrenceId: null,
    parentEventId: null,
    status: "confirmed",
    transparency: "busy",
    visibility: "default",
    organizer: null,
    attendees: [],
    reminders: [],
    sequence: 0,
    providerVersion: null,
    revision: 1,
    syncState: "local",
    deleted: false,
  };
}

describe("TimeGrid", () => {
  it("moves the active slot with arrows and creates with N", () => {
    const onCreate = vi.fn();
    const rendered = renderTest(
      <TimeGrid
        view="week"
        anchor="2026-09-21"
        timezone="UTC"
        events={[]}
        calendars={{}}
        onCreate={onCreate}
        onOpen={() => {}}
      />,
    );
    cleanup = rendered.unmount;
    const grid = rendered.host.querySelector<HTMLElement>('[role="grid"]');

    expect(grid?.getAttribute("aria-label")).toBe("Week of September 21, 2026");
    act(() => {
      grid?.focus();
      grid?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      grid?.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true }));
    });

    expect(onCreate).toHaveBeenCalledWith({ date: "2026-09-22", time: "09:00", allDay: false });
  });

  it("renders deterministic overlap columns in a separate timed layer", () => {
    const rendered = renderTest(
      <TimeGrid
        view="day"
        anchor="2026-09-21"
        timezone="UTC"
        events={[
          timedEvent("b", "2026-09-21T09:30:00Z", "2026-09-21T10:30:00Z"),
          timedEvent("a", "2026-09-21T09:00:00Z", "2026-09-21T10:00:00Z"),
        ]}
        calendars={{}}
        onCreate={() => {}}
        onOpen={() => {}}
      />,
    );
    cleanup = rendered.unmount;
    const timed = [...rendered.host.querySelectorAll<HTMLElement>("[data-calendar-timed-event]")];

    expect(timed.map((event) => [event.dataset.column, event.dataset.columns])).toEqual([
      ["0", "2"],
      ["1", "2"],
    ]);
    expect(rendered.host.querySelector("[data-calendar-all-day-layer]")).not.toBeNull();
  });
});
