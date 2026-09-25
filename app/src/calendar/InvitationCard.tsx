/** Trusted presentation for invitations already parsed and validated by Rust. */

import dayjs from "dayjs";
import timezonePlugin from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { useState } from "react";

import type { InvitationInspection, ParticipationStatus } from "@/types";

import "@/calendar/InvitationCard.css";

dayjs.extend(utc);
dayjs.extend(timezonePlugin);

type ResponseStatus = Extract<ParticipationStatus, "accepted" | "tentative" | "declined">;

interface InvitationCardProps {
  inspection: InvitationInspection;
  timezone: string;
  onRespond(status: ResponseStatus): Promise<void> | void;
}

function eventTime(inspection: InvitationInspection, timezoneName: string): string {
  const { start, end } = inspection.event;
  if (start.kind === "allDay" && end.kind === "allDay") {
    return `${dayjs(start.date).format("ddd, MMM D")} · all day`;
  }
  if (start.kind !== "timed" || end.kind !== "timed") return "Time unavailable";
  const localStart = dayjs(start.utc).tz(timezoneName);
  const localEnd = dayjs(end.utc).tz(timezoneName);
  return `${localStart.format("ddd, MMM D · HH:mm")}–${localEnd.format("HH:mm")}`;
}

function responseErrorMessage(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  if (cause instanceof Error && cause.message.trim()) return cause.message.trim();
  return "The response was not queued. Try again.";
}

export function InvitationCard({ inspection, timezone: timezoneName, onRespond }: InvitationCardProps) {
  const [pending, setPending] = useState<ResponseStatus | null>(null);
  const [result, setResult] = useState<ResponseStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { event } = inspection;
  const organizer = event.organizer
    ? `${event.organizer.name ? `${event.organizer.name} · ` : ""}${event.organizer.email}`
    : "Organizer unavailable";
  const recurrence = event.recurrence?.rules[0]?.replace(/^RRULE:/, "") ?? null;
  const canRespond = !["stale", "cancelled"].includes(inspection.state) && inspection.method !== "REPLY";

  const respond = async (status: ResponseStatus) => {
    setPending(status);
    setError(null);
    try {
      await onRespond(status);
      setResult(status);
    } catch (cause) {
      setError(responseErrorMessage(cause));
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="invitation-card" aria-label={`Calendar invitation: ${event.title}`}>
      <div className="invitation-card-kicker">
        <span>Calendar invitation</span>
        <span>Sequence {event.sequence}</span>
      </div>
      <h3>{event.title}</h3>
      <dl>
        <div><dt>When</dt><dd>{eventTime(inspection, timezoneName)}</dd></div>
        <div><dt>Organizer</dt><dd>{organizer}</dd></div>
        {event.location && <div><dt>Where</dt><dd>{event.location}</dd></div>}
        <div><dt>Timezone</dt><dd>{event.timezone}{event.timezone !== timezoneName ? ` · shown in ${timezoneName}` : ""}</dd></div>
        {recurrence && <div><dt>Repeats</dt><dd>{recurrence}</dd></div>}
        <div><dt>Received via</dt><dd>Email calendar attachment</dd></div>
      </dl>
      {inspection.conflicts.length > 0 && (
        <p className="invitation-card-warning" role="status">
          Conflicts with {inspection.conflicts.length} calendar {inspection.conflicts.length === 1 ? "event" : "events"}.
        </p>
      )}
      {inspection.state === "stale" && (
        <p className="invitation-card-warning">A newer version of this invitation is already in your calendar.</p>
      )}
      {inspection.state === "cancelled" && <p className="invitation-card-warning">This meeting was cancelled.</p>}
      {result ? (
        <p className="invitation-card-result" role="status">Response queued · {result}</p>
      ) : canRespond ? (
        <div className="invitation-card-actions" aria-label="Respond to invitation">
          <button type="button" disabled={pending !== null} onClick={() => { void respond("accepted"); }}>Accept</button>
          <button type="button" disabled={pending !== null} onClick={() => { void respond("tentative"); }}>Maybe</button>
          <button type="button" disabled={pending !== null} onClick={() => { void respond("declined"); }}>Decline</button>
        </div>
      ) : null}
      {error && <p className="invitation-card-error" role="alert">{error}</p>}
    </section>
  );
}
