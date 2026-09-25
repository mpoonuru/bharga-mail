/** Explicit local/remote conflict comparison; no version is chosen implicitly. */

import dayjs from "dayjs";

import { Modal } from "@/components/ui/Modal";
import type { CalendarConflict, ConflictResolution } from "@/types";

interface ConflictDialogProps {
  conflict: CalendarConflict | null;
  onClose(): void;
  onResolve(resolution: ConflictResolution): void | Promise<void>;
}

function eventTime(conflict: CalendarConflict["local"]): string {
  if (conflict.start.kind === "allDay") return `${conflict.start.date} · All day`;
  return dayjs(conflict.start.utc).format("ddd, MMM D · HH:mm");
}

function Version({ label, event }: { label: string; event: CalendarConflict["local"] }) {
  return (
    <section className="calendar-conflict-version" aria-label={label}>
      <span>{label}</span>
      <h3>{event.title || "Untitled event"}</h3>
      <p>{eventTime(event)}</p>
      {event.location && <p>{event.location}</p>}
      {event.description && <small>{event.description}</small>}
      {event.deleted && <strong>This version was deleted</strong>}
    </section>
  );
}

export function ConflictDialog({ conflict, onClose, onResolve }: ConflictDialogProps) {
  return (
    <Modal open={!!conflict} onClose={onClose} title="Resolve calendar conflict" maxWidth={760}>
      {conflict && (
        <div className="calendar-conflict-dialog">
          <p>Both this device and the calendar provider changed this event. Choose which version to keep.</p>
          <div className="calendar-conflict-versions">
            <Version label="On this device" event={conflict.local} />
            <Version label="From provider" event={conflict.remote} />
          </div>
          <div className="calendar-conflict-actions">
            <button type="button" className="calendar-button calendar-button-quiet" onClick={onClose}>Decide later</button>
            <button type="button" className="calendar-button calendar-button-quiet" onClick={() => void onResolve("duplicate")}>Keep both</button>
            <button type="button" className="calendar-button calendar-button-quiet" onClick={() => void onResolve("useRemote")}>Use provider version</button>
            <button type="button" className="calendar-button calendar-button-primary" onClick={() => void onResolve("keepLocal")}>Keep local</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
