/** Calendar navigation and view controls; every action remains keyboard reachable. */

import dayjs from "dayjs";
import localizedFormat from "dayjs/plugin/localizedFormat";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";

import type { CalendarView } from "@/calendar/types";
import { Icon } from "@/components/icons";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(localizedFormat);

const VIEWS: readonly { id: CalendarView; label: string }[] = [
  { id: "month", label: "Month" },
  { id: "week", label: "Week" },
  { id: "day", label: "Day" },
  { id: "agenda", label: "Agenda" },
];

function heading(anchor: string, view: CalendarView, timezoneName: string): string {
  const value = dayjs.tz(anchor, "YYYY-MM-DD", timezoneName);
  if (view === "day") return value.format("dddd, MMMM D");
  if (view === "week") {
    const start = value.startOf("isoWeek");
    const end = start.add(6, "day");
    return start.month() === end.month()
      ? `${start.format("MMMM D")}–${end.format("D, YYYY")}`
      : `${start.format("MMM D")}–${end.format("MMM D, YYYY")}`;
  }
  if (view === "agenda") return `${value.format("MMMM D")} · 30 days`;
  return value.format("MMMM YYYY");
}

interface CalendarToolbarProps {
  anchor: string;
  view: CalendarView;
  timezone: string;
  onToday(): void;
  onPrevious(): void;
  onNext(): void;
  onView(view: CalendarView): void;
  onCreate(): void;
  onImport?(): void;
  onExport?(): void;
}

export function CalendarToolbar({
  anchor,
  view,
  timezone: timezoneName,
  onToday,
  onPrevious,
  onNext,
  onView,
  onCreate,
  onImport,
  onExport,
}: CalendarToolbarProps) {
  return (
    <header className="calendar-toolbar">
      <div className="calendar-toolbar-title">
        <h1>Calendar</h1>
        <p aria-live="polite">{heading(anchor, view, timezoneName)}</p>
      </div>
      <div className="calendar-toolbar-nav" aria-label="Calendar navigation">
        <button type="button" className="calendar-button calendar-button-quiet" onClick={onToday}>Today</button>
        <button type="button" className="calendar-icon-button" aria-label="Previous period" onClick={onPrevious}>
          <Icon name="caretLeft" size={17} weight="bold" />
        </button>
        <button type="button" className="calendar-icon-button" aria-label="Next period" onClick={onNext}>
          <Icon name="caretRight" size={17} weight="bold" />
        </button>
      </div>
      <div className="calendar-view-switcher" aria-label="Calendar view">
        {VIEWS.map((option) => (
          <button
            type="button"
            key={option.id}
            aria-pressed={view === option.id}
            onClick={() => onView(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <button type="button" className="calendar-button calendar-button-primary" onClick={onCreate}>
        <Icon name="plus" size={16} weight="bold" />
        New event
      </button>
      {(onImport || onExport) && (
        <div className="calendar-file-actions" aria-label="Calendar files">
          {onImport && <button type="button" className="calendar-button calendar-button-quiet" onClick={onImport}>Import .ics</button>}
          {onExport && <button type="button" className="calendar-button calendar-button-quiet" onClick={onExport}>Export .ics</button>}
        </div>
      )}
    </header>
  );
}
