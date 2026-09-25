/** Six-week month grid with date semantics and cross-week event spans. */

import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import type { CSSProperties } from "react";

import { monthCells } from "@/calendar/date";
import { layoutMonthSpans } from "@/calendar/layout";
import type {
  Calendar,
  CalendarEvent,
  CalendarOccurrenceIntent,
  CalendarSlot,
} from "@/calendar/types";

dayjs.extend(utc);
dayjs.extend(timezone);

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function eventDates(event: CalendarEvent, timezoneName: string): { startDate: string; endDate: string } {
  if (event.start.kind === "allDay" && event.end.kind === "allDay") {
    return { startDate: event.start.date, endDate: event.end.date };
  }
  const start = event.start.kind === "timed"
    ? dayjs(event.start.utc).tz(timezoneName)
    : dayjs.tz(event.start.date, "YYYY-MM-DD", timezoneName);
  const end = event.end.kind === "timed"
    ? dayjs(event.end.utc).tz(timezoneName)
    : dayjs.tz(event.end.date, "YYYY-MM-DD", timezoneName);
  const startDate = start.format("YYYY-MM-DD");
  const endDate = end.format("YYYY-MM-DD");
  return {
    startDate,
    endDate: endDate === startDate ? end.add(1, "day").format("YYYY-MM-DD") : endDate,
  };
}

function occurrenceStart(event: CalendarEvent): string {
  return event.start.kind === "timed" ? event.start.utc : event.start.date;
}

interface MonthViewProps {
  anchor: string;
  timezone: string;
  events: CalendarEvent[];
  calendars: Record<string, Calendar>;
  onCreate(slot: CalendarSlot): void;
  onOpen(occurrence: CalendarOccurrenceIntent): void;
}

export function MonthView({
  anchor,
  timezone: timezoneName,
  events,
  calendars,
  onCreate,
  onOpen,
}: MonthViewProps) {
  const cells = monthCells(anchor, timezoneName);
  const visibleStart = cells[0]?.date ?? anchor;
  const visibleEnd = dayjs(cells.at(-1)?.date ?? anchor).add(1, "day").format("YYYY-MM-DD");
  const dated = events.map((event) => ({ event, ...eventDates(event, timezoneName) }));
  const spans = layoutMonthSpans(
    dated.map(({ event, startDate, endDate }) => ({ id: event.id, startDate, endDate })),
    visibleStart,
    visibleEnd,
  );
  const spanEvents = new Set(
    dated.filter(({ startDate, endDate }) => dayjs(endDate).diff(dayjs(startDate), "day") > 1)
      .map(({ event }) => event.id),
  );
  const byId = new Map(events.map((event) => [event.id, event]));

  return (
    <section className="calendar-month" aria-label={dayjs(anchor).format("MMMM YYYY")}>
      <div className="calendar-month-weekdays" role="row">
        {WEEKDAYS.map((weekday) => <div role="columnheader" key={weekday}>{weekday.slice(0, 3)}</div>)}
      </div>
      <div className="calendar-month-body" role="grid" aria-label="Month dates">
        {Array.from({ length: 6 }, (_, weekIndex) => (
          <div className="calendar-month-row" role="row" key={cells[weekIndex * 7]?.date}>
            {cells.slice(weekIndex * 7, weekIndex * 7 + 7).map((cell) => {
              const dayEvents = dated.filter(({ event, startDate }) => startDate === cell.date && !spanEvents.has(event.id));
              return (
                <div
                  className={`calendar-month-cell${cell.isCurrentMonth ? "" : " outside"}${cell.isToday ? " today" : ""}`}
                  role="gridcell"
                  aria-label={dayjs(cell.date).format("dddd, MMMM D, YYYY")}
                  key={cell.date}
                >
                  <button
                    type="button"
                    className="calendar-day-number"
                    aria-label={`Create event on ${cell.date}`}
                    onClick={() => onCreate({ date: cell.date, allDay: true })}
                  >
                    {dayjs(cell.date).format("D")}
                  </button>
                  <div className="calendar-cell-events">
                    {dayEvents.slice(0, 3).map(({ event }) => (
                      <button
                        type="button"
                        className="calendar-event-chip"
                        key={event.id}
                        style={{ "--event-color": calendars[event.calendarId]?.color ?? "var(--accent)" } as CSSProperties}
                        onClick={() => onOpen({ eventId: event.id, occurrenceStart: occurrenceStart(event) })}
                      >
                        {event.start.kind === "timed" && <time>{dayjs(event.start.utc).tz(timezoneName).format("HH:mm")}</time>}
                        <span>{event.title}</span>
                      </button>
                    ))}
                    {dayEvents.length > 3 && <span className="calendar-event-more">+{dayEvents.length - 3} more</span>}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
        <div className="calendar-span-layer" aria-label="Multi-day events">
          {spans.filter((segment) => spanEvents.has(segment.id)).map((segment) => {
            const event = byId.get(segment.id);
            if (!event) return null;
            return (
              <button
                type="button"
                className="calendar-span-event"
                key={segment.segmentKey}
                style={{
                  "--span-column": segment.startColumn + 1,
                  "--span-size": segment.span,
                  "--span-row": segment.weekIndex + 1,
                  "--event-color": calendars[event.calendarId]?.color ?? "var(--accent)",
                } as CSSProperties}
                onClick={() => onOpen({ eventId: event.id, occurrenceStart: occurrenceStart(event) })}
              >
                <span>{segment.continuesBefore ? "…" : ""}{event.title}{segment.continuesAfter ? "…" : ""}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
