/** Behavior tests for explicit calendar conflict resolution. */

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConflictDialog } from "@/calendar/ConflictDialog";
import { renderTest } from "@/test/render";
import type { CalendarConflict, CalendarEvent } from "@/types";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function event(title: string): CalendarEvent {
  return {
    id: "event", calendarId: "calendar", uid: "uid", providerId: "remote",
    title, description: "", location: "", conferenceUrl: null, sourceThreadId: null,
    start: { kind: "timed", utc: "2026-09-25T10:00:00Z" },
    end: { kind: "timed", utc: "2026-09-25T11:00:00Z" }, timezone: "UTC",
    recurrence: null, recurrenceId: null, parentEventId: null, status: "confirmed",
    transparency: "busy", visibility: "default", organizer: null, attendees: [], reminders: [],
    sequence: 0, providerVersion: "v1", revision: 2, syncState: "conflict", deleted: false,
  };
}

describe("ConflictDialog", () => {
  it("shows both versions and requires an explicit resolution", () => {
    const onResolve = vi.fn();
    const conflict: CalendarConflict = {
      eventId: "event", local: event("Local title"), remote: event("Remote title"),
      providerVersion: "v2", createdAt: 1,
    };
    const rendered = renderTest(<ConflictDialog conflict={conflict} onClose={() => {}} onResolve={onResolve} />);
    cleanup = rendered.unmount;
    expect(document.body.textContent).toContain("Local title");
    expect(document.body.textContent).toContain("Remote title");
    expect(onResolve).not.toHaveBeenCalled();
    act(() => [...document.querySelectorAll("button")].find((button) => button.textContent === "Keep local")?.click());
    expect(onResolve).toHaveBeenCalledWith("keepLocal");
  });
});
