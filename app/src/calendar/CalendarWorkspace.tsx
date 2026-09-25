/** Production calendar shell: navigation, source rail, views, and intent boundary. */

import dayjs from "dayjs";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";

import { AgendaView } from "@/calendar/AgendaView";
import { CalendarSidebar } from "@/calendar/CalendarSidebar";
import { CalendarToolbar } from "@/calendar/CalendarToolbar";
import { calendarToday } from "@/calendar/date";
import { EventDialog, type EventDialogInitial } from "@/calendar/EventDialog";
import { MonthView } from "@/calendar/MonthView";
import { createCalendarStore } from "@/calendar/store";
import { TimeGrid } from "@/calendar/TimeGrid";
import type {
  CalendarApi,
  CalendarOccurrenceIntent,
  CalendarSlot,
  CalendarView,
} from "@/calendar/types";
import { api } from "@/lib/bridge";
import { useViewport } from "@/lib/useViewport";

import "@/calendar/calendar.css";

interface CalendarSettingsApi {
  getSettings(): Promise<Record<string, string>>;
  setSetting(key: string, value: string): Promise<void>;
}

interface CalendarWorkspaceProps {
  calendarApi?: CalendarApi;
  settingsApi?: CalendarSettingsApi;
  onCreate?(slot: CalendarSlot): void;
  onOpen?(occurrence: CalendarOccurrenceIntent): void;
}

const VALID_VIEWS = new Set<CalendarView>(["month", "week", "day", "agenda"]);

function shiftAnchor(anchor: string, view: CalendarView, direction: -1 | 1): string {
  const value = dayjs(anchor);
  const amount = view === "month" ? 1 : view === "week" ? 7 : view === "agenda" ? 30 : 1;
  const unit = view === "month" ? "month" : "day";
  return value.add(direction * amount, unit).format("YYYY-MM-DD");
}

export function CalendarWorkspace({
  calendarApi = api.calendar,
  settingsApi = api,
  onCreate,
  onOpen,
}: CalendarWorkspaceProps) {
  const storeRef = useRef<ReturnType<typeof createCalendarStore> | null>(null);
  if (!storeRef.current) storeRef.current = createCalendarStore(calendarApi);
  const store = storeRef.current;
  const snapshot = useStore(store);
  const viewport = useViewport();
  const [editing, setEditing] = useState<EventDialogInitial | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const settings = await settingsApi.getSettings();
      await store.getState().initialize();
      if (!active) return;
      const scheduledDraft = calendarApi.takeScheduledDraft?.();
      if (scheduledDraft) setEditing({ ...scheduledDraft, recurrenceId: null });
      const savedView = settings["calendar.view"] as CalendarView | undefined;
      if (savedView && VALID_VIEWS.has(savedView) && savedView !== store.getState().view) {
        await store.getState().setView(savedView);
      }
      const savedVisible = settings["calendar.visible"];
      if (savedVisible) {
        try {
          const ids = new Set(JSON.parse(savedVisible) as string[]);
          await Promise.all(Object.values(store.getState().calendars).map((calendar) => (
            calendar.visible === ids.has(calendar.id)
              ? Promise.resolve()
              : store.getState().setCalendarVisibility(calendar.id, ids.has(calendar.id))
          )));
        } catch {
          // Ignore a stale preference; the authoritative calendar flags remain intact.
        }
      }
    })().catch(() => {
      // The store exposes the structured error and retry action in the workspace.
    });
    return () => { active = false; };
  }, [settingsApi, store]);

  useEffect(() => {
    if (viewport === "narrow" && (snapshot.view === "month" || snapshot.view === "week")) {
      void store.getState().setView("agenda").catch(() => {});
    }
  }, [snapshot.view, store, viewport]);

  const visibleEvents = useMemo(() => {
    const visible = new Set(snapshot.visibleCalendarIds);
    return Object.values(snapshot.events).filter((event) => visible.has(event.calendarId));
  }, [snapshot.events, snapshot.visibleCalendarIds]);
  const calendars = Object.values(snapshot.calendars)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  const sources = Object.values(snapshot.sources).sort((left, right) => left.label.localeCompare(right.label));

  const chooseView = (view: CalendarView) => {
    void settingsApi.setSetting("calendar.view", view);
    void store.getState().setView(view).catch(() => {});
  };
  const changeVisibility = (calendarId: string, visible: boolean) => {
    void store.getState().setCalendarVisibility(calendarId, visible).then(() => (
      settingsApi.setSetting("calendar.visible", JSON.stringify(store.getState().visibleCalendarIds))
    )).catch(() => {});
  };
  const changeAnchor = (anchor: string) => {
    void store.getState().setAnchor(anchor).catch(() => {});
  };
  const openCreate = (slot: CalendarSlot) => {
    onCreate?.(slot);
    const calendar = calendars.find((candidate) => candidate.writable && candidate.visible)
      ?? calendars.find((candidate) => candidate.writable);
    if (!calendar) return;
    const startLocal = dayjs.tz(`${slot.date}T${slot.time ?? "09:00"}`, snapshot.timezone);
    setEditing({
      calendarId: calendar.id,
      title: "",
      description: "",
      location: "",
      conferenceUrl: null,
      sourceThreadId: null,
      start: slot.allDay
        ? { kind: "allDay", date: slot.date }
        : { kind: "timed", utc: startLocal.toISOString() },
      end: slot.allDay
        ? { kind: "allDay", date: dayjs(slot.date).add(1, "day").format("YYYY-MM-DD") }
        : { kind: "timed", utc: startLocal.add(1, "hour").toISOString() },
      timezone: snapshot.timezone,
      recurrence: null,
      recurrenceId: null,
      status: "confirmed",
      transparency: "busy",
      visibility: "default",
      organizer: null,
      attendees: [],
      reminders: [{ method: "display", minutesBefore: 10 }],
    });
  };
  const openOccurrence = (occurrence: CalendarOccurrenceIntent) => {
    onOpen?.(occurrence);
    const event = snapshot.events[occurrence.eventId];
    if (event) setEditing({ ...event, recurrenceId: event.recurrenceId ?? (event.recurrence ? occurrence.occurrenceStart : null) });
  };

  return (
    <div className="calendar-workspace">
      <CalendarToolbar
        anchor={snapshot.anchor}
        view={snapshot.view}
        timezone={snapshot.timezone}
        onToday={() => changeAnchor(calendarToday(snapshot.timezone))}
        onPrevious={() => changeAnchor(shiftAnchor(snapshot.anchor, snapshot.view, -1))}
        onNext={() => changeAnchor(shiftAnchor(snapshot.anchor, snapshot.view, 1))}
        onView={chooseView}
        onCreate={() => openCreate({ date: snapshot.anchor, allDay: false })}
        onImport={calendarApi.importIcs ? () => {
          const target = calendars.find((calendar) => calendar.writable && calendar.isDefault)
            ?? calendars.find((calendar) => calendar.writable);
          if (!target) return;
          void calendarApi.importIcs!(target.id).then((events) => {
            if (events.length > 0) void store.getState().loadRange();
          }).catch(() => {});
        } : undefined}
        onExport={calendarApi.exportIcs && visibleEvents.length > 0 ? () => {
          void calendarApi.exportIcs!(visibleEvents.map((event) => event.id)).catch(() => {});
        } : undefined}
      />
      <div className="calendar-workspace-body">
        <CalendarSidebar
          sources={sources}
          calendars={calendars}
          visibleCalendarIds={snapshot.visibleCalendarIds}
          loading={snapshot.loading}
          onVisibility={changeVisibility}
          onSync={(sourceId) => { void store.getState().syncSource(sourceId).catch(() => {}); }}
          onSourceAdded={() => { void store.getState().initialize().catch(() => {}); }}
        />
        <main className="calendar-canvas" aria-busy={snapshot.loading}>
          {snapshot.error && (
            <div className="calendar-error" role="alert">
              <span>{snapshot.error.message}</span>
              <button type="button" onClick={() => { void store.getState().loadRange().catch(() => {}); }}>Try again</button>
            </div>
          )}
          {snapshot.loading && Object.keys(snapshot.events).length === 0 ? (
            <div className="calendar-loading" aria-label="Loading calendar">
              <span /><span /><span />
            </div>
          ) : snapshot.view === "month" ? (
            <MonthView
              anchor={snapshot.anchor}
              timezone={snapshot.timezone}
              events={visibleEvents}
              calendars={snapshot.calendars}
              onCreate={openCreate}
              onOpen={openOccurrence}
            />
          ) : snapshot.view === "week" || snapshot.view === "day" ? (
            <TimeGrid
              view={snapshot.view}
              anchor={snapshot.anchor}
              timezone={snapshot.timezone}
              events={visibleEvents}
              calendars={snapshot.calendars}
              onCreate={openCreate}
              onOpen={openOccurrence}
            />
          ) : (
            <AgendaView
              events={visibleEvents}
              calendars={snapshot.calendars}
              timezone={snapshot.timezone}
              onCreate={openCreate}
              onOpen={openOccurrence}
            />
          )}
        </main>
      </div>
      {editing && (
        <EventDialog
          open
          initial={editing}
          calendars={calendars}
          onClose={() => setEditing(null)}
          onDelete={editing.id ? async () => {
            await store.getState().deleteEvent(editing.id!);
          } : undefined}
          onSave={async (input, options) => {
            if (!editing.id) {
              await store.getState().createEvent(input);
              return;
            }
            if (editing.recurrenceId && options.scope && calendarApi.updateRecurringEvent) {
              await calendarApi.updateRecurringEvent(editing.id, editing.recurrenceId, options.scope, input);
              await store.getState().loadRange();
              return;
            }
            await store.getState().updateEvent(editing.id, input);
          }}
        />
      )}
    </div>
  );
}
