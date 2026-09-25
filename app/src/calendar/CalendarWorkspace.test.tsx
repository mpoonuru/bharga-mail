import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CalendarWorkspace } from "@/calendar/CalendarWorkspace";
import type { CalendarApi, CalendarEvent } from "@/calendar/types";
import { renderTest } from "@/test/render";

let cleanup: (() => void) | undefined;

afterEach(() => cleanup?.());

function fixtureEvent(): CalendarEvent {
  return {
    id: "event-1",
    calendarId: "calendar-1",
    uid: "board@example.test",
    providerId: "provider-event-1",
    title: "Board meeting",
    description: "Quarterly review",
    location: "Room 4",
    conferenceUrl: null,
    sourceThreadId: null,
    start: { kind: "timed", utc: "2026-09-25T08:00:00Z" },
    end: { kind: "timed", utc: "2026-09-25T09:00:00Z" },
    timezone: "Europe/Berlin",
    recurrence: null,
    recurrenceId: null,
    parentEventId: null,
    status: "confirmed",
    transparency: "busy",
    visibility: "default",
    organizer: null,
    attendees: [],
    reminders: [],
    sequence: 1,
    providerVersion: "1",
    revision: 1,
    syncState: "synced",
    deleted: false,
  };
}

function calendarFixtureApi(): CalendarApi {
  const event = fixtureEvent();
  return {
    async listSources() {
      return [{
        id: "source-1",
        linkedAccountId: null,
        provider: "calDav",
        label: "Operations",
        address: "calendar.example.test",
        authState: "ready",
        capabilities: ["events"],
        lastSyncAt: 1_795_000_000,
        syncError: null,
        disabled: false,
      }];
    },
    async listCalendars() {
      return [{
        id: "calendar-1",
        sourceId: "source-1",
        providerId: "work",
        name: "Operations",
        description: "",
        color: "#6f8df6",
        timezone: "Europe/Berlin",
        accessRole: "owner",
        writable: true,
        visible: true,
        isDefault: true,
        sortOrder: 0,
      }];
    },
    async listEvents() { return [event]; },
    async getEvent() { return event; },
    async createEvent() { return event; },
    async updateEvent() { return event; },
    async deleteEvent() { return { ...event, deleted: true }; },
    async createLocalCalendar() { throw new Error("not used"); },
    async setVisibility() {},
    async syncSource() {},
  };
}

describe("CalendarWorkspace", () => {
  it("renders persisted events and all four view choices without preview copy", async () => {
    const setSetting = vi.fn(async () => {});
    const rendered = renderTest(
      <CalendarWorkspace
        calendarApi={calendarFixtureApi()}
        settingsApi={{ async getSettings() { return {}; }, setSetting }}
      />,
    );
    cleanup = rendered.unmount;

    await act(async () => {
      await vi.waitFor(() => expect(rendered.host.textContent).toContain("Board meeting"));
    });

    const buttons = [...rendered.host.querySelectorAll("button")];
    for (const name of ["Month", "Week", "Day", "Agenda"]) {
      expect(buttons.some((button) => button.textContent === name)).toBe(true);
    }
    expect(rendered.host.textContent).toContain("Operations");
    expect(rendered.host.textContent).not.toMatch(/preview|example events/i);

    const week = buttons.find((button) => button.textContent === "Week");
    await act(async () => week?.click());
    expect(setSetting).toHaveBeenCalledWith("calendar.view", "week");
  });
});
