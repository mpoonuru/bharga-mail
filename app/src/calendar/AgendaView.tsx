/** Chronological agenda optimized for narrow windows and scanning. */

import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";

import type {
  Calendar,
  CalendarEvent,
  CalendarOccurrenceIntent,
  CalendarSlot,
} from "@/calendar/types";

dayjs.extend(utc);
dayjs.extend(timezone);

interface AgendaViewProps {
  events: CalendarEvent[];
  calendars: Record<string, Calendar>;
  timezone: string;
  onCreate(slot: CalendarSlot): void;
  onOpen(occurrence: CalendarOccurrenceIntent): void;
}

function eventDate(event: CalendarEvent, timezoneName: string): string {
  return event.start.kind === "allDay"
    ? event.start.date
    : dayjs(event.start.utc).tz(timezoneName).format("YYYY-MM-DD");
}

export function AgendaView({ events, calendars, timezone: timezoneName, onCreate, onOpen }: AgendaViewProps) {
  const sorted = [...events].sort((left, right) => {
    const leftValue = left.start.kind === "timed" ? left.start.utc : left.start.date;
    const rightValue = right.start.kind === "timed" ? right.start.utc : right.start.date;
    return leftValue.localeCompare(rightValue) || left.id.localeCompare(right.id);
  });
  const groups = new Map<string, CalendarEvent[]>();
  for (const event of sorted) {
    const date = eventDate(event, timezoneName);
    groups.set(date, [...(groups.get(date) ?? []), event]);
  }

  if (groups.size === 0) {
    return (
      <div className="calendar-empty">
        <div className="calendar-empty-mark" aria-hidden="true">24</div>
        <h2>Your time is open</h2>
        <p>Create an event or connect a calendar to start planning here.</p>
        <button type="button" className="calendar-button calendar-button-primary" onClick={() => onCreate({ date: dayjs().tz(timezoneName).format("YYYY-MM-DD"), allDay: false })}>
          Create an event
        </button>
      </div>
    );
  }

  return (
    <section className="calendar-agenda" aria-label="Agenda">
      {[...groups].map(([date, dayEvents]) => (
        <section className="calendar-agenda-day" key={date}>
          <header>
            <time dateTime={date}>{dayjs(date).format("ddd")}</time>
            <span>{dayjs(date).format("D")}</span>
            <div>
              <b>{dayjs(date).format("MMMM D")}</b>
              <small>{dayEvents.length} {dayEvents.length === 1 ? "event" : "events"}</small>
            </div>
          </header>
          <div className="calendar-agenda-events">
            {dayEvents.map((event) => (
              <button
                type="button"
                key={event.id}
                className="calendar-agenda-event"
                onClick={() => onOpen({
                  eventId: event.id,
                  occurrenceStart: event.start.kind === "timed" ? event.start.utc : event.start.date,
                })}
              >
                <span className="calendar-agenda-color" style={{ backgroundColor: calendars[event.calendarId]?.color ?? "var(--accent)" }} />
                <span className="calendar-agenda-time">
                  {event.start.kind === "timed" ? dayjs(event.start.utc).tz(timezoneName).format("HH:mm") : "All day"}
                </span>
                <span className="calendar-agenda-copy">
                  <b>{event.title}</b>
                  {(event.location || calendars[event.calendarId]?.name) && (
                    <small>{[event.location, calendars[event.calendarId]?.name].filter(Boolean).join(" · ")}</small>
                  )}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </section>
  );
}
