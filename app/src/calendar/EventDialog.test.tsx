import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EventDialog, type EventDialogInitial } from "@/calendar/EventDialog";
import type { Calendar } from "@/calendar/types";
import { renderTest, setInputValue } from "@/test/render";

let cleanup: (() => void) | undefined;

afterEach(() => cleanup?.());

const calendars: Calendar[] = [{
  id: "calendar-1",
  sourceId: "source-1",
  providerId: null,
  name: "Work",
  description: "",
  color: "#6f8df6",
  timezone: "Europe/Berlin",
  accessRole: "owner",
  writable: true,
  visible: true,
  isDefault: true,
  sortOrder: 0,
}];

function initial(overrides: Partial<EventDialogInitial> = {}): EventDialogInitial {
  return {
    id: "event-1",
    calendarId: "calendar-1",
    title: "Architecture review",
    description: "",
    location: "",
    conferenceUrl: null,
    sourceThreadId: null,
    start: { kind: "timed", utc: "2026-09-25T10:00:00Z" },
    end: { kind: "timed", utc: "2026-09-25T09:00:00Z" },
    timezone: "UTC",
    recurrence: null,
    recurrenceId: null,
    organizer: null,
    attendees: [],
    reminders: [],
    status: "confirmed",
    transparency: "busy",
    visibility: "default",
    ...overrides,
  };
}

describe("EventDialog", () => {
  it("does not save an invalid interval", () => {
    const onSave = vi.fn();
    const rendered = renderTest(
      <EventDialog open initial={initial()} calendars={calendars} onSave={onSave} onClose={() => {}} />,
    );
    cleanup = rendered.unmount;
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent === "Save event");

    act(() => save?.click());

    expect(document.body.textContent).toContain("End must be after start");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("requires a scope before changing one occurrence", () => {
    const onSave = vi.fn();
    const rendered = renderTest(
      <EventDialog
        open
        initial={initial({
          recurrence: { rules: ["FREQ=WEEKLY"], dates: [], excludedDates: [] },
          recurrenceId: "2026-09-25T10:00:00Z",
          end: { kind: "timed", utc: "2026-09-25T11:00:00Z" },
        })}
        calendars={calendars}
        onSave={onSave}
        onClose={() => {}}
      />,
    );
    cleanup = rendered.unmount;
    const title = document.querySelector<HTMLInputElement>('input[aria-label="Title"]');
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent === "Save event");

    if (title) setInputValue(title, "Architecture review changed");
    act(() => save?.click());

    expect(document.querySelector('[role="dialog"][aria-label="Apply changes"]')).not.toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });
});
