/** Source health and calendar visibility controls for the workspace rail. */

import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { useRef, useState } from "react";

import type { Calendar, CalendarSource } from "@/calendar/types";
import { SourceDialog } from "@/calendar/SourceDialog";

dayjs.extend(relativeTime);

interface CalendarSidebarProps {
  sources: CalendarSource[];
  calendars: Calendar[];
  visibleCalendarIds: readonly string[];
  loading: boolean;
  onVisibility(calendarId: string, visible: boolean): void;
  onSync(sourceId: string): void;
  onSourceAdded?(): void;
}

function sourceStatus(source: CalendarSource): { label: string; tone: string } {
  if (source.authState === "reauthorizationRequired") return { label: "Reconnect", tone: "warning" };
  if (source.syncError) return { label: "Needs attention", tone: "danger" };
  if (source.lastSyncAt) return { label: `Updated ${dayjs.unix(source.lastSyncAt).fromNow()}`, tone: "healthy" };
  return { label: source.provider === "local" ? "On this device" : "Ready to sync", tone: "neutral" };
}

export function CalendarSidebar({
  sources,
  calendars,
  visibleCalendarIds,
  loading,
  onVisibility,
  onSync,
  onSourceAdded,
}: CalendarSidebarProps) {
  const [sourceOpen, setSourceOpen] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <aside className="calendar-sidebar" aria-label="Calendars">
      <div className="calendar-sidebar-head">
        <h2>My calendars</h2>
        <span>{visibleCalendarIds.length}/{calendars.length}</span>
      </div>
      <div className="calendar-list">
        {calendars.map((calendar) => (
          <label className="calendar-toggle" key={calendar.id}>
            <input
              type="checkbox"
              checked={visibleCalendarIds.includes(calendar.id)}
              onChange={(event) => onVisibility(calendar.id, event.currentTarget.checked)}
            />
            <span className="calendar-color" style={{ backgroundColor: calendar.color }} aria-hidden="true" />
            <span>{calendar.name}</span>
          </label>
        ))}
      </div>
      <div className="calendar-sidebar-divider" />
      <div className="calendar-sidebar-head">
        <h2>Connections</h2>
        <button ref={addButtonRef} type="button" className="calendar-sidebar-add" onClick={() => setSourceOpen(true)}>Add</button>
      </div>
      <div className="calendar-source-list">
        {sources.map((source) => {
          const status = sourceStatus(source);
          return (
            <div className="calendar-source" key={source.id}>
              <span className={`calendar-health ${status.tone}`} aria-hidden="true" />
              <div>
                <b>{source.label}</b>
                <small>{status.label}</small>
              </div>
              {source.provider !== "local" && (
                <button
                  type="button"
                  onClick={() => onSync(source.id)}
                  disabled={loading}
                  aria-label={`Sync ${source.label}`}
                >
                  Sync
                </button>
              )}
            </div>
          );
        })}
      </div>
      <SourceDialog
        open={sourceOpen}
        onClose={() => setSourceOpen(false)}
        onSaved={() => onSourceAdded?.()}
        returnFocus={addButtonRef.current}
      />
    </aside>
  );
}
