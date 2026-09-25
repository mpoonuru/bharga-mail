/** Source health and calendar visibility controls for the workspace rail. */

import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { useRef, useState } from "react";

import type { Calendar, CalendarSource } from "@/calendar/types";
import type { CalendarSyncHealth } from "@/types";
import { SourceDialog } from "@/calendar/SourceDialog";
import { Modal } from "@/components/ui/Modal";

dayjs.extend(relativeTime);

interface CalendarSidebarProps {
  sources: CalendarSource[];
  calendars: Calendar[];
  visibleCalendarIds: readonly string[];
  loading: boolean;
  onVisibility(calendarId: string, visible: boolean): void;
  onSync(sourceId: string): void;
  onSourceAdded?(): void;
  health?: Record<string, CalendarSyncHealth>;
  onOrder?(calendarIds: string[]): void;
  onRenameSource?(sourceId: string, label: string): Promise<void>;
  onRemoveSource?(sourceId: string, keepLocalCopy: boolean): Promise<void>;
}

function sourceStatus(source: CalendarSource, health?: CalendarSyncHealth): { label: string; tone: string } {
  if (source.authState === "reauthorizationRequired") return { label: "Reconnect", tone: "warning" };
  if (health?.conflictCount) return { label: `${health.conflictCount} conflict${health.conflictCount === 1 ? "" : "s"}`, tone: "danger" };
  if (source.syncError) return { label: "Needs attention", tone: "danger" };
  if (health?.pendingCount) return { label: `${health.pendingCount} change${health.pendingCount === 1 ? "" : "s"} pending`, tone: "warning" };
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
  health,
  onOrder,
  onRenameSource,
  onRemoveSource,
}: CalendarSidebarProps) {
  const [sourceOpen, setSourceOpen] = useState(false);
  const [managedSource, setManagedSource] = useState<CalendarSource | null>(null);
  const [managedLabel, setManagedLabel] = useState("");
  const [managementError, setManagementError] = useState("");
  const [managementBusy, setManagementBusy] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <aside className="calendar-sidebar" aria-label="Calendars">
      <div className="calendar-sidebar-head">
        <h2>My calendars</h2>
        <span>{visibleCalendarIds.length}/{calendars.length}</span>
      </div>
      <div className="calendar-list">
        {calendars.map((calendar, index) => (
          <div className="calendar-order-row" key={calendar.id}>
            <label className="calendar-toggle">
              <input
                type="checkbox"
                checked={visibleCalendarIds.includes(calendar.id)}
                onChange={(event) => onVisibility(calendar.id, event.currentTarget.checked)}
              />
              <span className="calendar-color" style={{ backgroundColor: calendar.color }} aria-hidden="true" />
              <span>{calendar.name}</span>
            </label>
            {onOrder && calendars.length > 1 && (
              <span className="calendar-order-controls" aria-label={`Order ${calendar.name}`}>
                <button type="button" disabled={index === 0} aria-label={`Move ${calendar.name} up`} onClick={() => {
                  const ids = calendars.map((item) => item.id);
                  [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
                  onOrder(ids);
                }}>↑</button>
                <button type="button" disabled={index === calendars.length - 1} aria-label={`Move ${calendar.name} down`} onClick={() => {
                  const ids = calendars.map((item) => item.id);
                  [ids[index], ids[index + 1]] = [ids[index + 1], ids[index]];
                  onOrder(ids);
                }}>↓</button>
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="calendar-sidebar-divider" />
      <div className="calendar-sidebar-head">
        <h2>Connections</h2>
        <button ref={addButtonRef} type="button" className="calendar-sidebar-add" onClick={() => setSourceOpen(true)}>Add</button>
      </div>
      <div className="calendar-source-list">
        {sources.map((source) => {
          const status = sourceStatus(source, health?.[source.id]);
          return (
            <div className="calendar-source" key={source.id}>
              <span className={`calendar-health ${status.tone}`} aria-hidden="true" />
              <div>
                <b>{source.label}</b>
                <small>{status.label}</small>
              </div>
              <div className="calendar-source-actions-compact">
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
                {(onRenameSource || onRemoveSource) && (
                  <button
                    type="button"
                    className="calendar-source-manage"
                    aria-label={`Manage ${source.label}`}
                    onClick={() => {
                      setManagedSource(source);
                      setManagedLabel(source.label);
                      setManagementError("");
                    }}
                  >Manage</button>
                )}
              </div>
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
      <Modal open={!!managedSource} onClose={() => setManagedSource(null)} title="Calendar connection" maxWidth={520}>
        {managedSource && (
          <div className="calendar-source-management">
            <label className="calendar-field">
              <span>Connection name</span>
              <input value={managedLabel} onChange={(event) => setManagedLabel(event.currentTarget.value)} />
            </label>
            {managementError && <p className="calendar-source-error" role="alert">{managementError}</p>}
            <div className="calendar-source-management-actions">
              <button type="button" className="calendar-button calendar-button-primary" disabled={managementBusy || !managedLabel.trim()} onClick={() => {
                if (!onRenameSource) return;
                setManagementBusy(true);
                setManagementError("");
                void onRenameSource(managedSource.id, managedLabel).then(() => setManagedSource(null)).catch((error: unknown) => {
                  setManagementError(error instanceof Error ? error.message : "Connection could not be renamed");
                }).finally(() => setManagementBusy(false));
              }}>Save name</button>
            </div>
            <div className="calendar-source-danger">
              <h3>{managedSource.provider === "local" ? "Delete local calendar" : "Disconnect calendar"}</h3>
              <p>{managedSource.provider === "local"
                ? "This permanently removes this calendar and its events from this device."
                : "Disconnecting never deletes events from the calendar provider."}</p>
              {managedSource.provider !== "local" && (
                <button type="button" className="calendar-button calendar-button-quiet" disabled={managementBusy} onClick={() => {
                  if (!onRemoveSource) return;
                  setManagementBusy(true);
                  void onRemoveSource(managedSource.id, true).then(() => setManagedSource(null)).catch((error: unknown) => {
                    setManagementError(error instanceof Error ? error.message : "Connection could not be removed");
                  }).finally(() => setManagementBusy(false));
                }}>Disconnect and keep a local copy</button>
              )}
              <button type="button" className="calendar-button calendar-danger-button" disabled={managementBusy} onClick={() => {
                if (!onRemoveSource) return;
                setManagementBusy(true);
                void onRemoveSource(managedSource.id, false).then(() => setManagedSource(null)).catch((error: unknown) => {
                  setManagementError(error instanceof Error ? error.message : "Connection could not be removed");
                }).finally(() => setManagementBusy(false));
              }}>{managedSource.provider === "local" ? "Delete calendar data" : "Disconnect and delete local data"}</button>
            </div>
          </div>
        )}
      </Modal>
    </aside>
  );
}
