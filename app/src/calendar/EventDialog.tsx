/** Accessible event lifecycle editor with explicit recurring-edit scope. */

import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { useMemo, useRef, useState } from "react";

import { RecurrenceEditor } from "@/calendar/RecurrenceEditor";
import type {
  Calendar,
  EventAttendee,
  EventMutation,
  EventPerson,
  EventReminder,
  EventStatus,
  EventTransparency,
  EventVisibility,
  FreeBusyResult,
  RecurrenceSet,
} from "@/types";
import { Modal } from "@/components/ui/Modal";

dayjs.extend(utc);
dayjs.extend(timezone);

export type RecurrenceEditScope = "occurrence" | "following" | "series";

export interface EventDialogInitial extends EventMutation {
  id?: string;
  recurrenceId?: string | null;
}

export interface EventSaveOptions {
  scope?: RecurrenceEditScope;
  notifyAttendees: boolean;
}

interface EventDialogProps {
  open: boolean;
  initial: EventDialogInitial;
  calendars: Calendar[];
  onSave(input: EventMutation, options: EventSaveOptions): void | Promise<void>;
  onDelete?(): void | Promise<void>;
  onClose(): void;
  returnFocus?: HTMLElement | null;
  onCheckAvailability?(range: { start: string; end: string }, attendees: string[]): Promise<FreeBusyResult>;
  notificationPolicy?: "optional" | "providerManaged" | "none";
}

interface FormState {
  calendarId: string;
  title: string;
  description: string;
  location: string;
  conferenceUrl: string;
  timezone: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  recurrence: RecurrenceSet | null;
  attendees: EventAttendee[];
  reminders: EventReminder[];
  status: EventStatus;
  transparency: EventTransparency;
  visibility: EventVisibility;
  organizer: EventPerson | null;
  notifyAttendees: boolean;
}

function localParts(moment: EventDialogInitial["start"], timezoneName: string) {
  if (moment.kind === "allDay") return { date: moment.date, time: "09:00" };
  const value = dayjs(moment.utc).tz(timezoneName);
  return { date: value.format("YYYY-MM-DD"), time: value.format("HH:mm") };
}

function initialState(initial: EventDialogInitial): FormState {
  const start = localParts(initial.start, initial.timezone);
  const end = localParts(initial.end, initial.timezone);
  return {
    calendarId: initial.calendarId,
    title: initial.title,
    description: initial.description,
    location: initial.location,
    conferenceUrl: initial.conferenceUrl ?? "",
    timezone: initial.timezone,
    allDay: initial.start.kind === "allDay",
    startDate: start.date,
    startTime: start.time,
    endDate: end.date,
    endTime: end.time,
    recurrence: initial.recurrence ?? null,
    attendees: initial.attendees.map((attendee) => ({ ...attendee })),
    reminders: initial.reminders.map((reminder) => ({ ...reminder })),
    status: initial.status,
    transparency: initial.transparency,
    visibility: initial.visibility,
    organizer: initial.organizer ? { ...initial.organizer } : null,
    notifyAttendees: initial.attendees.length > 0,
  };
}

function toMoment(date: string, time: string, timezoneName: string, allDay: boolean) {
  if (allDay) return { kind: "allDay" as const, date };
  return { kind: "timed" as const, utc: dayjs.tz(`${date}T${time}`, timezoneName).toISOString() };
}

function validEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function EventDialog({ open, initial, calendars, onSave, onDelete, onClose, returnFocus, onCheckAvailability, notificationPolicy = "optional" }: EventDialogProps) {
  const original = useMemo(() => initialState(initial), [initial]);
  const [form, setForm] = useState<FormState>(original);
  const [attendeeInput, setAttendeeInput] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [scopeOpen, setScopeOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [availability, setAvailability] = useState<FreeBusyResult | null>(null);
  const [checkingAvailability, setCheckingAvailability] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const endDateRef = useRef<HTMLInputElement>(null);
  const calendarRef = useRef<HTMLSelectElement>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(original);

  const patch = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: "" }));
  };
  const requestClose = () => {
    if (dirty) setCloseOpen(true);
    else onClose();
  };
  const addAttendee = () => {
    const email = attendeeInput.trim().toLowerCase();
    if (!validEmail(email)) {
      setErrors((current) => ({ ...current, attendees: "Enter a valid attendee email" }));
      return;
    }
    if (!form.attendees.some((attendee) => attendee.email.toLowerCase() === email)) {
      patch("attendees", [...form.attendees, {
        email,
        role: "required",
        status: "needsAction",
        rsvp: true,
      }]);
    }
    setAttendeeInput("");
  };

  const validate = (): EventMutation | null => {
    const next: Record<string, string> = {};
    if (!form.title.trim()) next.title = "Title is required";
    const calendar = calendars.find((candidate) => candidate.id === form.calendarId);
    if (!calendar?.writable) next.calendarId = "Choose a calendar you can edit";
    let start;
    let end;
    try {
      start = toMoment(form.startDate, form.startTime, form.timezone, form.allDay);
      end = toMoment(form.endDate, form.endTime, form.timezone, form.allDay);
      const startValue = form.allDay ? dayjs(form.startDate) : dayjs(start.utc);
      const endValue = form.allDay ? dayjs(form.endDate) : dayjs(end.utc);
      if (!startValue.isValid() || !endValue.isValid() || !endValue.isAfter(startValue)) {
        next.endDate = "End must be after start";
      }
    } catch {
      next.endDate = "Enter valid dates, times, and timezone";
    }
    if (form.attendees.length > 100) next.attendees = "Events support up to 100 attendees";
    if (form.reminders.length > 10) next.reminders = "Events support up to 10 reminders";
    setErrors(next);
    if (Object.keys(next).length > 0 || !start || !end) {
      if (next.title) titleRef.current?.focus();
      else if (next.calendarId) calendarRef.current?.focus();
      else if (next.endDate) endDateRef.current?.focus();
      return null;
    }
    return {
      calendarId: form.calendarId,
      title: form.title.trim(),
      description: form.description.trim(),
      location: form.location.trim(),
      conferenceUrl: form.conferenceUrl.trim() || null,
      sourceThreadId: initial.sourceThreadId ?? null,
      start,
      end,
      timezone: form.timezone,
      recurrence: form.recurrence,
      status: form.status,
      transparency: form.transparency,
      visibility: form.visibility,
      organizer: form.organizer,
      attendees: form.attendees,
      reminders: form.reminders,
    };
  };

  const save = async (scope?: RecurrenceEditScope) => {
    const value = validate();
    if (!value) return;
    if (initial.recurrenceId && dirty && !scope) {
      setScopeOpen(true);
      return;
    }
    setSubmitting(true);
    setSaveError("");
    try {
      await onSave(value, {
        scope,
        notifyAttendees: notificationPolicy === "providerManaged"
          ? value.attendees.length > 0
          : notificationPolicy === "optional" && form.notifyAttendees,
      });
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Event could not be saved");
    } finally {
      setSubmitting(false);
    }
  };

  const checkAvailability = async () => {
    if (!onCheckAvailability || form.attendees.length === 0) return;
    setCheckingAvailability(true);
    try {
      const start = dayjs.tz(`${form.startDate}T${form.allDay ? "00:00" : form.startTime}`, form.timezone).toISOString();
      const end = dayjs.tz(`${form.endDate}T${form.allDay ? "00:00" : form.endTime}`, form.timezone).toISOString();
      setAvailability(await onCheckAvailability({ start, end }, form.attendees.map((attendee) => attendee.email)));
    } catch {
      setAvailability({ intervals: [], complete: false });
    } finally {
      setCheckingAvailability(false);
    }
  };

  const requestReminderPermission = async () => {
    try {
      const notifications = await import("@tauri-apps/plugin-notification");
      if (!await notifications.isPermissionGranted()) await notifications.requestPermission();
    } catch {
      // Browser preview and denied OS permission remain non-blocking.
    }
  };

  return (
    <>
      <Modal open={open} onClose={requestClose} title={initial.id ? "Edit event" : "New event"} maxWidth={720} returnFocus={returnFocus}>
        <form className="calendar-event-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label className="calendar-field calendar-field-wide">
            <span>Title</span>
            <input ref={titleRef} aria-label="Title" value={form.title} onChange={(event) => patch("title", event.currentTarget.value)} aria-invalid={!!errors.title} />
            {errors.title && <small className="calendar-field-error">{errors.title}</small>}
          </label>
          <label className="calendar-field calendar-field-wide">
            <span>Calendar</span>
            <select ref={calendarRef} value={form.calendarId} onChange={(event) => patch("calendarId", event.currentTarget.value)} aria-invalid={!!errors.calendarId}>
              {calendars.map((calendar) => <option key={calendar.id} value={calendar.id} disabled={!calendar.writable}>{calendar.name}</option>)}
            </select>
            {errors.calendarId && <small className="calendar-field-error">{errors.calendarId}</small>}
          </label>
          <label className="calendar-check calendar-field-wide">
            <input type="checkbox" checked={form.allDay} onChange={(event) => patch("allDay", event.currentTarget.checked)} />
            <span>All-day event</span>
          </label>
          <label className="calendar-field">
            <span>Starts</span>
            <input type="date" value={form.startDate} onChange={(event) => patch("startDate", event.currentTarget.value)} />
          </label>
          {!form.allDay && <label className="calendar-field"><span>Start time</span><input type="time" value={form.startTime} onChange={(event) => patch("startTime", event.currentTarget.value)} /></label>}
          <label className="calendar-field">
            <span>Ends</span>
            <input ref={endDateRef} type="date" value={form.endDate} onChange={(event) => patch("endDate", event.currentTarget.value)} aria-invalid={!!errors.endDate} />
            {errors.endDate && <small className="calendar-field-error">{errors.endDate}</small>}
          </label>
          {!form.allDay && <label className="calendar-field"><span>End time</span><input type="time" value={form.endTime} onChange={(event) => patch("endTime", event.currentTarget.value)} /></label>}
          <label className="calendar-field calendar-field-wide">
            <span>Timezone</span>
            <input value={form.timezone} onChange={(event) => patch("timezone", event.currentTarget.value)} spellCheck={false} />
          </label>
          <RecurrenceEditor value={form.recurrence} onChange={(value) => patch("recurrence", value)} disabled={!!initial.recurrenceId} />
          <label className="calendar-field calendar-field-wide"><span>Location</span><input value={form.location} onChange={(event) => patch("location", event.currentTarget.value)} /></label>
          <label className="calendar-field calendar-field-wide"><span>Video or meeting URL</span><input type="url" value={form.conferenceUrl} onChange={(event) => patch("conferenceUrl", event.currentTarget.value)} /></label>
          <label className="calendar-field calendar-field-wide"><span>Notes</span><textarea value={form.description} onChange={(event) => patch("description", event.currentTarget.value)} rows={3} /></label>
          <div className="calendar-field calendar-field-wide">
            <span>Attendees</span>
            <div className="calendar-attendees">
              {form.attendees.map((attendee) => (
                <span className="calendar-attendee" key={attendee.email}>
                  {attendee.email}
                  <button type="button" aria-label={`Remove ${attendee.email}`} onClick={() => patch("attendees", form.attendees.filter((item) => item.email !== attendee.email))}>×</button>
                </span>
              ))}
              <input
                type="email"
                aria-label="Add attendee"
                value={attendeeInput}
                placeholder="name@example.com"
                onChange={(event) => setAttendeeInput(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === ",") {
                    event.preventDefault();
                    addAttendee();
                  }
                }}
              />
              <button type="button" onClick={addAttendee}>Add</button>
            </div>
            {errors.attendees && <small className="calendar-field-error">{errors.attendees}</small>}
            {form.attendees.length > 0 && onCheckAvailability && (
              <div className="calendar-availability">
                <button type="button" className="calendar-button calendar-button-quiet" disabled={checkingAvailability} onClick={() => { void checkAvailability(); }}>
                  {checkingAvailability ? "Checking availability…" : "Check availability"}
                </button>
                {availability && (
                  <small role="status">
                    {availability.complete ? "Availability checked" : "Availability incomplete"}
                    {` · ${availability.intervals.length} known busy interval${availability.intervals.length === 1 ? "" : "s"}`}
                  </small>
                )}
              </div>
            )}
          </div>
          <div className="calendar-field">
            <span>Reminder</span>
            <select
              value=""
              onChange={(event) => {
                const minutes = Number(event.currentTarget.value);
                if (minutes && form.reminders.length < 10) {
                  patch("reminders", [...form.reminders, { method: "display", minutesBefore: minutes }]);
                  void requestReminderPermission();
                }
              }}
            >
              <option value="">Add reminder</option>
              <option value="10">10 minutes before</option>
              <option value="30">30 minutes before</option>
              <option value="60">1 hour before</option>
              <option value="1440">1 day before</option>
            </select>
          </div>
          <div className="calendar-reminder-list">
            {form.reminders.map((reminder, index) => (
              <button type="button" key={`${reminder.method}-${reminder.minutesBefore}-${index}`} onClick={() => patch("reminders", form.reminders.filter((_, itemIndex) => itemIndex !== index))}>
                {reminder.minutesBefore} min before ×
              </button>
            ))}
          </div>
          {form.attendees.length > 0 && notificationPolicy === "optional" && (
            <label className="calendar-check calendar-field-wide">
              <input type="checkbox" checked={form.notifyAttendees} onChange={(event) => patch("notifyAttendees", event.currentTarget.checked)} />
              <span>Send updates to attendees</span>
            </label>
          )}
          {form.attendees.length > 0 && notificationPolicy === "providerManaged" && (
            <p className="calendar-field-note calendar-field-wide">
              Invitation delivery is managed by this calendar provider when attendees change.
            </p>
          )}
          {saveError && <p className="calendar-save-error calendar-field-wide" role="alert">{saveError}</p>}
          <div className="calendar-dialog-actions calendar-field-wide">
            {initial.id && onDelete && (
              <button
                type="button"
                className="calendar-button calendar-danger-quiet"
                onClick={() => { void Promise.resolve(onDelete()).then(onClose).catch((error: unknown) => setSaveError(error instanceof Error ? error.message : "Event could not be deleted")); }}
              >
                Delete event
              </button>
            )}
            <button type="button" className="calendar-button calendar-button-quiet" onClick={requestClose}>Cancel</button>
            <button type="submit" className="calendar-button calendar-button-primary" disabled={submitting}>{submitting ? "Saving…" : "Save event"}</button>
          </div>
        </form>
      </Modal>
      <Modal open={scopeOpen} onClose={() => setScopeOpen(false)} ariaLabel="Apply changes" maxWidth={420}>
        <div className="calendar-scope-dialog">
          <h2>Apply changes</h2>
          <p>Choose how much of this recurring event should change.</p>
          <button type="button" onClick={() => { setScopeOpen(false); void save("occurrence"); }}>This event</button>
          <button type="button" onClick={() => { setScopeOpen(false); void save("following"); }}>This and following events</button>
          <button type="button" onClick={() => { setScopeOpen(false); void save("series"); }}>Entire series</button>
        </div>
      </Modal>
      <Modal open={closeOpen} onClose={() => setCloseOpen(false)} ariaLabel="Discard changes" maxWidth={400}>
        <div className="calendar-scope-dialog">
          <h2>Discard changes?</h2>
          <p>Your unsaved event changes will be lost.</p>
          <div className="calendar-dialog-actions">
            <button type="button" className="calendar-button calendar-button-quiet" onClick={() => setCloseOpen(false)}>Keep editing</button>
            <button type="button" className="calendar-button calendar-danger-button" onClick={onClose}>Discard</button>
          </div>
        </div>
      </Modal>
    </>
  );
}
