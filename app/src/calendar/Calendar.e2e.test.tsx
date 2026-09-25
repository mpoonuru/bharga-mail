/** End-to-end browser-repository contract for offline calendar event lifecycle. */

import { describe, expect, it } from "vitest";

import { api } from "@/lib/bridge";
import type { EventMutation } from "@/types";

describe("calendar local repository", () => {
  it("persists create, update, query, and delete without example events", async () => {
    const calendar = (await api.calendar.listCalendars())[0];
    const input: EventMutation = {
      calendarId: calendar.id,
      title: "Offline architecture review",
      description: "",
      location: "",
      conferenceUrl: null,
      sourceThreadId: null,
      start: { kind: "timed", utc: "2026-09-25T10:00:00Z" },
      end: { kind: "timed", utc: "2026-09-25T11:00:00Z" },
      timezone: "UTC",
      recurrence: null,
      status: "confirmed",
      transparency: "busy",
      visibility: "default",
      organizer: null,
      attendees: [],
      reminders: [],
    };
    const created = await api.calendar.createEvent(input);
    expect(created.title).toBe("Offline architecture review");
    const updated = await api.calendar.updateEvent(created.id, { ...input, title: "Updated offline review" });
    expect(updated.revision).toBe(created.revision + 1);
    const listed = await api.calendar.listEvents({
      start: "2026-09-01T00:00:00Z",
      end: "2026-10-01T00:00:00Z",
    });
    expect(listed.some((event) => event.id === created.id && event.title === "Updated offline review")).toBe(true);
    expect(listed.some((event) => /example event|marco.*pipeline/i.test(event.title))).toBe(false);
    await api.calendar.deleteEvent(created.id);
    expect(await api.calendar.getEvent(created.id)).toMatchObject({ deleted: true });
  });
});
