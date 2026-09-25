/** Accessible day/week time geometry with keyboard and pointer slot creation. */

import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";

import { calendarToday, weekDays } from "@/calendar/date";
import { layoutTimedEvents } from "@/calendar/layout";
import type {
  Calendar,
  CalendarDay,
  CalendarEvent,
  CalendarOccurrenceIntent,
  CalendarSlot,
} from "@/calendar/types";

dayjs.extend(utc);
dayjs.extend(timezone);

const HOUR_HEIGHT = 56;
const DAY_HEIGHT = HOUR_HEIGHT * 24;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

interface TimeGridProps {
  view: "week" | "day";
  anchor: string;
  timezone: string;
  events: CalendarEvent[];
  calendars: Record<string, Calendar>;
  onCreate(slot: CalendarSlot): void;
  onOpen(occurrence: CalendarOccurrenceIntent): void;
}

function visibleDays(anchor: string, view: "week" | "day", timezoneName: string): CalendarDay[] {
  if (view === "week") return weekDays(anchor, timezoneName);
  return [{ date: anchor, isCurrentMonth: true, isToday: anchor === calendarToday(timezoneName) }];
}

function occurrenceStart(event: CalendarEvent): string {
  return event.start.kind === "timed" ? event.start.utc : event.start.date;
}

function slotTime(minutes: number): string {
  const hour = Math.floor(minutes / 60).toString().padStart(2, "0");
  const minute = (minutes % 60).toString().padStart(2, "0");
  return `${hour}:${minute}`;
}

export function TimeGrid({
  view,
  anchor,
  timezone: timezoneName,
  events,
  calendars,
  onCreate,
  onOpen,
}: TimeGridProps) {
  const days = useMemo(() => visibleDays(anchor, view, timezoneName), [anchor, timezoneName, view]);
  const [activeDay, setActiveDay] = useState(0);
  const [activeMinutes, setActiveMinutes] = useState(9 * 60);
  const activeDayRef = useRef(0);
  const activeMinutesRef = useRef(9 * 60);
  const scrollRef = useRef<HTMLDivElement>(null);
  const today = calendarToday(timezoneName);
  const label = view === "week"
    ? `Week of ${dayjs(days[0]?.date).format("MMMM D, YYYY")}`
    : dayjs(anchor).format("dddd, MMMM D, YYYY");

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 7 * HOUR_HEIGHT;
  }, [view]);

  useEffect(() => {
    activeDayRef.current = Math.min(activeDayRef.current, days.length - 1);
    setActiveDay(activeDayRef.current);
  }, [days.length]);

  const byDate = useMemo(() => {
    const result = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      const date = event.start.kind === "allDay"
        ? event.start.date
        : dayjs(event.start.utc).tz(timezoneName).format("YYYY-MM-DD");
      result.set(date, [...(result.get(date) ?? []), event]);
    }
    return result;
  }, [events, timezoneName]);

  const createActiveSlot = () => onCreate({
    date: days[activeDayRef.current]?.date ?? anchor,
    time: slotTime(activeMinutesRef.current),
    allDay: false,
  });
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") {
      activeDayRef.current = Math.min(days.length - 1, activeDayRef.current + 1);
      setActiveDay(activeDayRef.current);
    } else if (event.key === "ArrowLeft") {
      activeDayRef.current = Math.max(0, activeDayRef.current - 1);
      setActiveDay(activeDayRef.current);
    } else if (event.key === "ArrowDown") {
      activeMinutesRef.current = Math.min(23 * 60 + 45, activeMinutesRef.current + 30);
      setActiveMinutes(activeMinutesRef.current);
    } else if (event.key === "ArrowUp") {
      activeMinutesRef.current = Math.max(0, activeMinutesRef.current - 30);
      setActiveMinutes(activeMinutesRef.current);
    }
    else if (event.key.toLowerCase() === "n" || event.key === "Enter") createActiveSlot();
    else return;
    event.preventDefault();
  };
  const createPointerSlot = (event: MouseEvent<HTMLDivElement>, date: string) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const raw = ((event.clientY - bounds.top) / HOUR_HEIGHT) * 60;
    const minutes = Math.max(0, Math.min(23 * 60 + 45, Math.round(raw / 15) * 15));
    onCreate({ date, time: slotTime(minutes), allDay: false });
  };

  return (
    <section className={`calendar-time-grid ${view}`}>
      <div className="calendar-time-grid-head">
        <div className="calendar-time-corner" aria-hidden="true">GMT</div>
        <div className="calendar-time-days" style={{ "--calendar-days": days.length } as CSSProperties}>
          {days.map((day) => (
            <div className={day.isToday ? "today" : ""} key={day.date}>
              <span>{dayjs(day.date).format("ddd")}</span>
              <b>{dayjs(day.date).format("D")}</b>
            </div>
          ))}
        </div>
      </div>
      <div className="calendar-all-day-row" data-calendar-all-day-layer>
        <div className="calendar-all-day-label">All day</div>
        <div className="calendar-all-day-days" style={{ "--calendar-days": days.length } as CSSProperties}>
          {days.map((day) => (
            <div key={day.date}>
              {(byDate.get(day.date) ?? []).filter((event) => event.start.kind === "allDay").map((event) => (
                <button
                  type="button"
                  key={event.id}
                  style={{ "--event-color": calendars[event.calendarId]?.color ?? "var(--accent)" } as CSSProperties}
                  onClick={() => onOpen({ eventId: event.id, occurrenceStart: occurrenceStart(event) })}
                >
                  {event.title}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div
        className="calendar-time-scroll"
        ref={scrollRef}
        role="grid"
        aria-label={label}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <div className="calendar-time-hours" aria-hidden="true">
          {HOURS.map((hour) => <span key={hour} style={{ top: hour * HOUR_HEIGHT }}>{`${hour.toString().padStart(2, "0")}:00`}</span>)}
        </div>
        <div className="calendar-time-columns" style={{ "--calendar-days": days.length, height: DAY_HEIGHT } as CSSProperties}>
          {days.map((day, dayIndex) => {
            const timedEvents = (byDate.get(day.date) ?? []).filter((event) => event.start.kind === "timed" && event.end.kind === "timed");
            const layouts = layoutTimedEvents(timedEvents.map((event) => ({
              id: event.id,
              start: event.start.kind === "timed" ? event.start.utc : day.date,
              end: event.end.kind === "timed" ? event.end.utc : day.date,
            })));
            const lookup = new Map(timedEvents.map((event) => [event.id, event]));
            return (
              <div
                className={`calendar-time-column${day.date === today ? " today" : ""}`}
                role="gridcell"
                aria-label={dayjs(day.date).format("dddd, MMMM D")}
                key={day.date}
                onDoubleClick={(event) => createPointerSlot(event, day.date)}
              >
                {HOURS.map((hour) => <span className="calendar-hour-rule" key={hour} style={{ top: hour * HOUR_HEIGHT }} />)}
                {dayIndex === activeDay && (
                  <span className="calendar-active-slot" style={{ top: (activeMinutes / 60) * HOUR_HEIGHT }} aria-hidden="true" />
                )}
                {day.date === today && (
                  <span
                    className="calendar-now-line"
                    style={{ top: ((dayjs().tz(timezoneName).hour() * 60 + dayjs().tz(timezoneName).minute()) / 60) * HOUR_HEIGHT }}
                    aria-hidden="true"
                  />
                )}
                {layouts.map((layout) => {
                  const calendarEvent = lookup.get(layout.id);
                  if (!calendarEvent || calendarEvent.start.kind !== "timed" || calendarEvent.end.kind !== "timed") return null;
                  const startUtc = calendarEvent.start.utc;
                  const start = dayjs(startUtc).tz(timezoneName);
                  const end = dayjs(calendarEvent.end.utc).tz(timezoneName);
                  const top = ((start.hour() * 60 + start.minute()) / 60) * HOUR_HEIGHT;
                  const height = Math.max(22, (end.diff(start, "minute") / 60) * HOUR_HEIGHT);
                  return (
                    <button
                      type="button"
                      className="calendar-timed-event"
                      data-calendar-timed-event
                      data-column={layout.column}
                      data-columns={layout.columnCount}
                      key={layout.id}
                      style={{
                        "--event-color": calendars[calendarEvent.calendarId]?.color ?? "var(--accent)",
                        "--event-column": layout.column,
                        "--event-columns": layout.columnCount,
                        top,
                        height,
                      } as CSSProperties}
                      onClick={() => onOpen({ eventId: calendarEvent.id, occurrenceStart: startUtc })}
                      title="Open event to edit, move, or resize"
                    >
                      <b>{calendarEvent.title}</b>
                      <small>{start.format("HH:mm")}–{end.format("HH:mm")}</small>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <p className="calendar-grid-help">Arrow keys move the active slot. Press N or Enter to create.</p>
    </section>
  );
}
