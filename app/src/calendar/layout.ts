/** Deterministic, side-effect-free placement for timed and month-span events. */

import dayjs from "dayjs";
import isoWeek from "dayjs/plugin/isoWeek";
import utc from "dayjs/plugin/utc";

import { parseDateOnly } from "@/calendar/date";
import type {
  MonthSpanInput,
  MonthSpanSegment,
  TimedLayoutEvent,
  TimedLayoutInput,
} from "@/calendar/types";

dayjs.extend(utc);
dayjs.extend(isoWeek);

interface PositionedEvent extends TimedLayoutEvent {
  startValue: number;
  endValue: number;
}

function timedValue(value: string, label: string): number {
  const parsed = dayjs(value);
  if (!parsed.isValid()) throw new RangeError(`Invalid ${label}: ${value}`);
  return parsed.valueOf();
}

export function layoutTimedEvents(events: readonly TimedLayoutInput[]): TimedLayoutEvent[] {
  const positioned = events.map((event) => {
    const startValue = timedValue(event.start, "event start");
    const endValue = timedValue(event.end, "event end");
    if (endValue <= startValue) throw new RangeError(`Event ${event.id} must end after it starts`);
    return { ...event, column: 0, columnCount: 1, startValue, endValue };
  });
  positioned.sort((left, right) =>
    left.startValue - right.startValue
    || (right.endValue - right.startValue) - (left.endValue - left.startValue)
    || left.id.localeCompare(right.id),
  );

  let active: PositionedEvent[] = [];
  let group: PositionedEvent[] = [];
  let groupEnd = Number.NEGATIVE_INFINITY;

  const finishGroup = () => {
    const columnCount = group.reduce((maximum, event) => Math.max(maximum, event.column + 1), 1);
    for (const event of group) event.columnCount = columnCount;
    group = [];
  };

  for (const event of positioned) {
    if (event.startValue >= groupEnd) {
      finishGroup();
      active = [];
      groupEnd = event.endValue;
    } else {
      active = active.filter((candidate) => candidate.endValue > event.startValue);
      groupEnd = Math.max(groupEnd, event.endValue);
    }
    const occupied = new Set(active.map((candidate) => candidate.column));
    let column = 0;
    while (occupied.has(column)) column += 1;
    event.column = column;
    active.push(event);
    group.push(event);
  }
  finishGroup();

  return positioned.map(({ startValue: _start, endValue: _end, ...event }) => event);
}

export function layoutMonthSpans(
  events: readonly MonthSpanInput[],
  visibleStartDate: string,
  visibleEndDate: string,
): MonthSpanSegment[] {
  const visibleStart = parseDateOnly(visibleStartDate);
  const visibleEnd = parseDateOnly(visibleEndDate);
  if (!visibleEnd.isAfter(visibleStart, "day") || visibleStart.isoWeekday() !== 1) {
    throw new RangeError("Visible month range must be a non-empty ISO-week grid");
  }

  const sorted = [...events].sort((left, right) =>
    left.startDate.localeCompare(right.startDate)
    || left.endDate.localeCompare(right.endDate)
    || left.id.localeCompare(right.id),
  );
  const segments: MonthSpanSegment[] = [];

  for (const event of sorted) {
    const eventStart = parseDateOnly(event.startDate);
    const eventEnd = parseDateOnly(event.endDate);
    if (!eventEnd.isAfter(eventStart, "day")) {
      throw new RangeError(`Month event ${event.id} must end after it starts`);
    }
    let segmentStart = eventStart.isAfter(visibleStart, "day") ? eventStart : visibleStart;
    const clippedEnd = eventEnd.isBefore(visibleEnd, "day") ? eventEnd : visibleEnd;
    while (segmentStart.isBefore(clippedEnd, "day")) {
      const weekStart = segmentStart.startOf("isoWeek");
      const weekEnd = weekStart.add(7, "day");
      const segmentEnd = clippedEnd.isBefore(weekEnd, "day") ? clippedEnd : weekEnd;
      const startDate = segmentStart.format("YYYY-MM-DD");
      segments.push({
        id: event.id,
        segmentKey: `${event.id}:${startDate}`,
        weekIndex: weekStart.diff(visibleStart, "week"),
        startColumn: segmentStart.isoWeekday() - 1,
        span: segmentEnd.diff(segmentStart, "day"),
        startDate,
        endDateExclusive: segmentEnd.format("YYYY-MM-DD"),
        continuesBefore: segmentStart.isAfter(eventStart, "day"),
        continuesAfter: segmentEnd.isBefore(eventEnd, "day"),
      });
      segmentStart = segmentEnd;
    }
  }
  return segments;
}
