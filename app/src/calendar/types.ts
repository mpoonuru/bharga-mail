/** Frontend-only calendar view, selection, and deterministic layout contracts. */

import type {
  Calendar,
  CalendarCommandError,
  CalendarEvent,
  CalendarSource,
  EventMutation,
  EventRange,
  InvitationInspection,
  InvitationResponseInput,
} from "@/types";

export type CalendarView = "month" | "week" | "day" | "agenda";

export interface CalendarDay {
  date: string;
  isCurrentMonth: boolean;
  isToday: boolean;
}

export interface AllDayDateRange {
  startDate: string;
  endDate: string;
}

export interface AllDayLabel {
  start: string;
  endExclusive: string;
}

export interface TimedLayoutInput {
  id: string;
  start: string;
  end: string;
}

export interface TimedLayoutEvent extends TimedLayoutInput {
  column: number;
  columnCount: number;
}

export interface MonthSpanInput {
  id: string;
  startDate: string;
  endDate: string;
}

export interface MonthSpanSegment {
  id: string;
  segmentKey: string;
  weekIndex: number;
  startColumn: number;
  span: number;
  startDate: string;
  endDateExclusive: string;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface SelectedOccurrence {
  eventId: string;
  occurrenceStart: string;
}

export interface CalendarSlot {
  date: string;
  time?: string;
  allDay: boolean;
}

export interface CalendarOccurrenceIntent {
  eventId: string;
  occurrenceStart: string;
}

export interface CalendarApi {
  listSources(): Promise<CalendarSource[]>;
  listCalendars(): Promise<Calendar[]>;
  listEvents(range: EventRange): Promise<CalendarEvent[]>;
  getEvent(eventId: string): Promise<CalendarEvent | undefined>;
  createEvent(input: EventMutation): Promise<CalendarEvent>;
  updateEvent(eventId: string, input: EventMutation): Promise<CalendarEvent>;
  updateRecurringEvent?(
    eventId: string,
    recurrenceId: string,
    scope: "occurrence" | "following" | "series",
    input: EventMutation,
  ): Promise<CalendarEvent[]>;
  importIcs?(calendarId: string): Promise<CalendarEvent[]>;
  exportIcs?(eventIds: string[]): Promise<number>;
  inspectAttachment?(
    accountId: string,
    messageId: string,
    name: string,
  ): Promise<InvitationInspection[]>;
  respondToInvitation?(input: InvitationResponseInput): Promise<CalendarEvent>;
  scheduleFromThread?(threadId: string): Promise<EventMutation>;
  takeScheduledDraft?(): EventMutation | null;
  deleteEvent(eventId: string): Promise<CalendarEvent>;
  createLocalCalendar(input: { name: string; color: string; timezone: string }): Promise<Calendar>;
  setVisibility(calendarId: string, visible: boolean): Promise<void>;
  syncSource(sourceId: string): Promise<void>;
}

export interface CalendarStateSnapshot {
  sources: Record<string, CalendarSource>;
  calendars: Record<string, Calendar>;
  events: Record<string, CalendarEvent>;
  visibleCalendarIds: string[];
  anchor: string;
  view: CalendarView;
  timezone: string;
  selectedOccurrence: SelectedOccurrence | null;
  rangeRequestVersion: number;
  loading: boolean;
  error: CalendarCommandError | null;
}

export type {
  Calendar,
  CalendarCommandError,
  CalendarEvent,
  CalendarSource,
  EventMutation,
  EventRange,
  InvitationInspection,
  InvitationResponseInput,
};
