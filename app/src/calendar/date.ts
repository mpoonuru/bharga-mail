/** Timezone-aware calendar range math. Date-only values never become instants. */

import dayjs, { type Dayjs } from "dayjs";
import advancedFormat from "dayjs/plugin/advancedFormat";
import customParseFormat from "dayjs/plugin/customParseFormat";
import isoWeek from "dayjs/plugin/isoWeek";
import localizedFormat from "dayjs/plugin/localizedFormat";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";

import type {
  AllDayDateRange,
  AllDayLabel,
  CalendarDay,
  CalendarView,
  EventRange,
} from "@/calendar/types";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isoWeek);
dayjs.extend(localizedFormat);
dayjs.extend(advancedFormat);
dayjs.extend(customParseFormat);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_FORMAT = "YYYY-MM-DD";

function assertTimezone(value: string): void {
  try {
    dayjs.tz("2000-01-01", DATE_FORMAT, value);
  } catch {
    throw new RangeError(`Unknown calendar timezone: ${value}`);
  }
}

export function parseDateOnly(value: string): Dayjs {
  if (!DATE_ONLY.test(value)) {
    throw new RangeError(`Invalid calendar date: ${value}`);
  }
  const parsed = dayjs(value, DATE_FORMAT, true);
  if (!parsed.isValid() || parsed.format(DATE_FORMAT) !== value) {
    throw new RangeError(`Invalid calendar date: ${value}`);
  }
  return parsed;
}

function zonedAnchor(anchor: string, viewerTimezone: string): Dayjs {
  assertTimezone(viewerTimezone);
  const value = DATE_ONLY.test(anchor)
    ? dayjs.tz(anchor, DATE_FORMAT, viewerTimezone)
    : dayjs(anchor).tz(viewerTimezone);
  if (!value.isValid()) throw new RangeError(`Invalid calendar anchor: ${anchor}`);
  return value;
}

function addZonedDays(value: Dayjs, days: number, viewerTimezone: string): Dayjs {
  const targetDate = value.add(days, "day").format(DATE_FORMAT);
  return dayjs.tz(targetDate, DATE_FORMAT, viewerTimezone);
}

export function allDayLabel(range: AllDayDateRange, viewerTimezone: string): AllDayLabel {
  assertTimezone(viewerTimezone);
  const start = parseDateOnly(range.startDate);
  const end = parseDateOnly(range.endDate);
  if (!end.isAfter(start, "day")) {
    throw new RangeError("All-day event end must be after its start");
  }
  return { start: range.startDate, endExclusive: range.endDate };
}

export function weekDays(anchor: string, viewerTimezone: string): CalendarDay[] {
  const selected = zonedAnchor(anchor, viewerTimezone);
  const start = selected.startOf("isoWeek");
  const today = dayjs().tz(viewerTimezone).format(DATE_FORMAT);
  return Array.from({ length: 7 }, (_, index) => {
    const value = addZonedDays(start, index, viewerTimezone);
    const date = value.format(DATE_FORMAT);
    return {
      date,
      isCurrentMonth: value.month() === selected.month(),
      isToday: date === today,
    };
  });
}

export function monthCells(anchor: string, viewerTimezone: string): CalendarDay[] {
  const selected = zonedAnchor(anchor, viewerTimezone);
  const start = selected.startOf("month").startOf("isoWeek");
  const today = dayjs().tz(viewerTimezone).format(DATE_FORMAT);
  return Array.from({ length: 42 }, (_, index) => {
    const value = addZonedDays(start, index, viewerTimezone);
    const date = value.format(DATE_FORMAT);
    return {
      date,
      isCurrentMonth: value.month() === selected.month(),
      isToday: date === today,
    };
  });
}

export function calendarRange(
  anchor: string,
  view: CalendarView,
  viewerTimezone: string,
): EventRange {
  const selected = zonedAnchor(anchor, viewerTimezone);
  let start: Dayjs;
  let end: Dayjs;
  switch (view) {
    case "month":
      start = selected.startOf("month").startOf("isoWeek");
      end = addZonedDays(start, 42, viewerTimezone);
      break;
    case "week":
      start = selected.startOf("isoWeek");
      end = addZonedDays(start, 7, viewerTimezone);
      break;
    case "day":
      start = selected.startOf("day");
      end = addZonedDays(start, 1, viewerTimezone);
      break;
    case "agenda":
      start = selected.startOf("day");
      end = addZonedDays(start, 30, viewerTimezone);
      break;
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

export function calendarToday(viewerTimezone: string): string {
  assertTimezone(viewerTimezone);
  return dayjs().tz(viewerTimezone).format(DATE_FORMAT);
}
