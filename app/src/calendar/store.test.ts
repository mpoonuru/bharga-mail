import { describe, expect, it } from "vitest";

import { createCalendarStore } from "@/calendar/store";
import type { CalendarApi, CalendarEvent, EventMutation, EventRange } from "@/calendar/types";

function event(id: string, title = "Provider title"): CalendarEvent {
  return {
    id,
    calendarId: "calendar-1",
    uid: `${id}@example.test`,
    providerId: id,
    title,
    description: "",
    location: "",
    conferenceUrl: null,
    sourceThreadId: null,
    start: { kind: "timed", utc: "2026-03-10T09:00:00Z" },
    end: { kind: "timed", utc: "2026-03-10T10:00:00Z" },
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
    sequence: 0,
    providerVersion: "1",
    revision: 1,
    syncState: "synced",
    deleted: false,
  };
}

function mutationEvent(existing: CalendarEvent, input: EventMutation): CalendarEvent {
  return {
    ...existing,
    ...input,
    revision: existing.revision + 1,
    syncState: "pending",
  };
}

function baseApi(overrides: Partial<CalendarApi> = {}): CalendarApi {
  const existing = event("e1");
  return {
    async listSources() {
      return [{
        id: "source-1",
        linkedAccountId: null,
        provider: "calDav",
        label: "Work",
        address: "calendar.example.test",
        authState: "ready",
        capabilities: ["events"],
        lastSyncAt: null,
        syncError: null,
        disabled: false,
      }];
    },
    async listCalendars() {
      return [{
        id: "calendar-1",
        sourceId: "source-1",
        providerId: "remote-calendar-1",
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
    },
    async listEvents() {
      return [existing];
    },
    async getEvent(eventId) {
      return eventId === existing.id ? existing : undefined;
    },
    async createEvent(input) {
      return mutationEvent(existing, input);
    },
    async updateEvent(_eventId, input) {
      return mutationEvent(existing, input);
    },
    async deleteEvent() {
      return { ...existing, deleted: true, syncState: "pending" };
    },
    async createLocalCalendar(input) {
      return {
        id: "calendar-local",
        sourceId: "source-local",
        providerId: null,
        name: input.name,
        description: "",
        color: input.color,
        timezone: input.timezone,
        accessRole: "owner",
        writable: true,
        visible: true,
        isDefault: false,
        sortOrder: 1,
      };
    },
    async setVisibility() {},
    async syncSource() {},
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("calendar store", () => {
  it("keeps an offline edit visible when provider refresh fails", async () => {
    const offline = { code: "offline", message: "Provider is offline", retryable: true };
    const store = createCalendarStore(baseApi({
      async syncSource() {
        throw offline;
      },
    }));
    await store.getState().initialize();

    await store.getState().updateEvent("e1", { title: "Local title" });
    await expect(store.getState().syncSource("source-1")).rejects.toMatchObject({ code: "offline" });

    expect(store.getState().events.e1).toMatchObject({
      title: "Local title",
      syncState: "pending",
    });
    expect(store.getState().error).toMatchObject({ code: "offline", retryable: true });
  });

  it("ignores an older range response that arrives last", async () => {
    const first = deferred<CalendarEvent[]>();
    const second = deferred<CalendarEvent[]>();
    const requested: EventRange[] = [];
    const store = createCalendarStore(baseApi({
      listEvents(range) {
        requested.push(range);
        return requested.length === 1 ? first.promise : second.promise;
      },
    }));

    const firstLoad = store.getState().loadRange();
    const secondLoad = store.getState().setAnchor("2026-04-15");
    second.resolve([event("new", "April")]);
    await secondLoad;
    first.resolve([event("old", "March")]);
    await firstLoad;

    expect(Object.keys(store.getState().events)).toEqual(["new"]);
    expect(store.getState().rangeRequestVersion).toBe(2);
  });
});
