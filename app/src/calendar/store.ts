/** Normalized local-first calendar state with stale-response protection. */

import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { create } from "zustand";
import { createStore, type StateCreator } from "zustand/vanilla";

import { calendarRange, calendarToday } from "@/calendar/date";
import type {
  Calendar,
  CalendarApi,
  CalendarCommandError,
  CalendarEvent,
  CalendarStateSnapshot,
  CalendarView,
  EventMutation,
  EventWriteOptions,
  SelectedOccurrence,
} from "@/calendar/types";
import type { CalendarSourceRemovalPolicy } from "@/types";
import { api } from "@/lib/bridge";

dayjs.extend(utc);
dayjs.extend(timezone);

export interface CalendarState extends CalendarStateSnapshot {
  initialize(): Promise<void>;
  loadRange(): Promise<void>;
  setAnchor(anchor: string): Promise<void>;
  setView(view: CalendarView): Promise<void>;
  setTimezone(timezone: string): Promise<void>;
  setSelectedOccurrence(selection: SelectedOccurrence | null): void;
  createEvent(input: EventMutation, options?: EventWriteOptions): Promise<CalendarEvent>;
  updateEvent(eventId: string, patch: Partial<EventMutation>, options?: EventWriteOptions): Promise<CalendarEvent>;
  deleteEvent(eventId: string): Promise<CalendarEvent>;
  createLocalCalendar(input: { name: string; color: string; timezone: string }): Promise<Calendar>;
  setCalendarVisibility(calendarId: string, visible: boolean): Promise<void>;
  syncSource(sourceId: string): Promise<void>;
  updateSourceLabel(sourceId: string, label: string): Promise<void>;
  removeSource(sourceId: string, policy: CalendarSourceRemovalPolicy): Promise<void>;
  setCalendarOrder(calendarIds: string[]): Promise<void>;
  clearError(): void;
}

function recordById<T extends { id: string }>(values: readonly T[]): Record<string, T> {
  return Object.fromEntries(values.map((value) => [value.id, value]));
}

function visibleCalendarIds(calendars: Record<string, Calendar>): string[] {
  return Object.values(calendars)
    .filter((calendar) => calendar.visible)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
    .map((calendar) => calendar.id);
}

function eventMutation(event: CalendarEvent): EventMutation {
  return {
    calendarId: event.calendarId,
    title: event.title,
    description: event.description,
    location: event.location,
    conferenceUrl: event.conferenceUrl,
    sourceThreadId: event.sourceThreadId,
    start: event.start,
    end: event.end,
    timezone: event.timezone,
    recurrence: event.recurrence,
    status: event.status,
    transparency: event.transparency,
    visibility: event.visibility,
    organizer: event.organizer,
    attendees: event.attendees,
    reminders: event.reminders,
  };
}

function calendarError(error: unknown, fallbackCode: string): CalendarCommandError {
  if (typeof error === "object" && error !== null) {
    const candidate = error as Partial<CalendarCommandError>;
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return {
        code: candidate.code,
        message: candidate.message,
        retryable: candidate.retryable === true,
      };
    }
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : "Calendar operation failed",
    retryable: false,
  };
}

function initialTimezone(): string {
  try {
    return dayjs.tz.guess() || "UTC";
  } catch {
    return "UTC";
  }
}

function calendarState(calendarApi: CalendarApi): StateCreator<CalendarState> {
  const timezone = initialTimezone();
  return (set, get) => ({
    sources: {},
    calendars: {},
    events: {},
    syncHealth: {},
    visibleCalendarIds: [],
    anchor: calendarToday(timezone),
    view: "month",
    timezone,
    selectedOccurrence: null,
    rangeRequestVersion: 0,
    loading: false,
    error: null,

    async initialize() {
      set({ loading: true, error: null });
      try {
        const [sources, calendars, health] = await Promise.all([
          calendarApi.listSources(),
          calendarApi.listCalendars(),
          calendarApi.listSyncHealth?.() ?? Promise.resolve([]),
        ]);
        const normalizedCalendars = recordById(calendars);
        set({
          sources: recordById(sources),
          calendars: normalizedCalendars,
          syncHealth: Object.fromEntries(health.map((item) => [item.sourceId, item])),
          visibleCalendarIds: visibleCalendarIds(normalizedCalendars),
        });
        await get().loadRange();
      } catch (error) {
        set({ loading: false, error: calendarError(error, "calendar-load-failed") });
        throw error;
      }
    },

    async loadRange() {
      const version = get().rangeRequestVersion + 1;
      const range = calendarRange(get().anchor, get().view, get().timezone);
      set({ rangeRequestVersion: version, loading: true, error: null });
      try {
        const events = await calendarApi.listEvents(range);
        if (get().rangeRequestVersion !== version) return;
        set({ events: recordById(events.filter((event) => !event.deleted)), loading: false });
      } catch (error) {
        if (get().rangeRequestVersion === version) {
          set({ loading: false, error: calendarError(error, "calendar-range-failed") });
        }
        throw error;
      }
    },

    async setAnchor(anchor) {
      calendarRange(anchor, get().view, get().timezone);
      set({ anchor });
      await get().loadRange();
    },

    async setView(view) {
      set({ view });
      await get().loadRange();
    },

    async setTimezone(nextTimezone) {
      calendarRange(get().anchor, get().view, nextTimezone);
      set({ timezone: nextTimezone });
      await get().loadRange();
    },

    setSelectedOccurrence(selectedOccurrence) {
      set({ selectedOccurrence });
    },

    async createEvent(input, options) {
      try {
        const created = await calendarApi.createEvent(input, options);
        set((state) => ({ events: { ...state.events, [created.id]: created }, error: null }));
        return created;
      } catch (error) {
        set({ error: calendarError(error, "calendar-create-failed") });
        throw error;
      }
    },

    async updateEvent(eventId, patch, options) {
      const existing = get().events[eventId];
      if (!existing) throw new Error(`Calendar event ${eventId} was not found`);
      const optimistic: CalendarEvent = {
        ...existing,
        ...patch,
        revision: existing.revision + 1,
        syncState: "pending",
      };
      set((state) => ({ events: { ...state.events, [eventId]: optimistic }, error: null }));
      try {
        const updated = await calendarApi.updateEvent(eventId, eventMutation(optimistic), options);
        set((state) => ({ events: { ...state.events, [eventId]: updated } }));
        return updated;
      } catch (error) {
        set((state) => ({
          events: { ...state.events, [eventId]: existing },
          error: calendarError(error, "calendar-update-failed"),
        }));
        throw error;
      }
    },

    async deleteEvent(eventId) {
      try {
        const deleted = await calendarApi.deleteEvent(eventId);
        set((state) => {
          const events = { ...state.events };
          delete events[eventId];
          return { events, error: null };
        });
        return deleted;
      } catch (error) {
        set({ error: calendarError(error, "calendar-delete-failed") });
        throw error;
      }
    },

    async createLocalCalendar(input) {
      try {
        const created = await calendarApi.createLocalCalendar(input);
        set((state) => {
          const calendars = { ...state.calendars, [created.id]: created };
          return { calendars, visibleCalendarIds: visibleCalendarIds(calendars), error: null };
        });
        return created;
      } catch (error) {
        set({ error: calendarError(error, "calendar-create-calendar-failed") });
        throw error;
      }
    },

    async setCalendarVisibility(calendarId, visible) {
      const existing = get().calendars[calendarId];
      if (!existing) throw new Error(`Calendar ${calendarId} was not found`);
      const applyVisibility = (calendar: Calendar) => {
        const calendars = { ...get().calendars, [calendarId]: calendar };
        set({ calendars, visibleCalendarIds: visibleCalendarIds(calendars) });
      };
      applyVisibility({ ...existing, visible });
      try {
        await calendarApi.setVisibility(calendarId, visible);
        set({ error: null });
      } catch (error) {
        applyVisibility(existing);
        set({ error: calendarError(error, "calendar-visibility-failed") });
        throw error;
      }
    },

    async syncSource(sourceId) {
      try {
        const result = await calendarApi.syncSource(sourceId);
        const [sources, calendars, health] = await Promise.all([
          calendarApi.listSources(),
          calendarApi.listCalendars(),
          calendarApi.listSyncHealth?.() ?? Promise.resolve(result ? [result] : []),
        ]);
        const normalizedCalendars = recordById(calendars);
        set({
          sources: recordById(sources),
          calendars: normalizedCalendars,
          syncHealth: Object.fromEntries(health.map((item) => [item.sourceId, item])),
          visibleCalendarIds: visibleCalendarIds(normalizedCalendars),
          error: null,
        });
        await get().loadRange();
      } catch (error) {
        set({ error: calendarError(error, "calendar-sync-failed") });
        throw error;
      }
    },

    async updateSourceLabel(sourceId, label) {
      if (!calendarApi.updateSourceLabel) throw new Error("Calendar source editing is unavailable");
      await calendarApi.updateSourceLabel(sourceId, label);
      set((state) => ({
        sources: {
          ...state.sources,
          [sourceId]: { ...state.sources[sourceId], label: label.trim() },
        },
        error: null,
      }));
    },

    async removeSource(sourceId, policy) {
      if (!calendarApi.removeSource) throw new Error("Calendar source removal is unavailable");
      await calendarApi.removeSource(sourceId, policy);
      await get().initialize();
    },

    async setCalendarOrder(calendarIds) {
      if (!calendarApi.setCalendarOrder) throw new Error("Calendar ordering is unavailable");
      const previous = get().calendars;
      const calendars = { ...previous };
      calendarIds.forEach((id, index) => {
        if (calendars[id]) calendars[id] = { ...calendars[id], sortOrder: index };
      });
      set({ calendars, visibleCalendarIds: visibleCalendarIds(calendars) });
      try {
        await calendarApi.setCalendarOrder(calendarIds);
      } catch (error) {
        set({ calendars: previous, visibleCalendarIds: visibleCalendarIds(previous), error: calendarError(error, "calendar-order-failed") });
        throw error;
      }
    },

    clearError() {
      set({ error: null });
    },
  });
}

export function createCalendarStore(calendarApi: CalendarApi = api.calendar) {
  return createStore<CalendarState>(calendarState(calendarApi));
}

export const useCalendar = create<CalendarState>(calendarState(api.calendar));
