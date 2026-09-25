/** Secure two-step CalDAV discovery and collection selection dialog. */

import { useEffect, useMemo, useRef, useState } from "react";

import type { CalendarSource, RemoteCalendar } from "@/types";
import { api } from "@/lib/bridge";
import { Modal } from "@/components/ui/Modal";

interface SourceApi {
  discoverCalDav: NonNullable<typeof api.calendar.discoverCalDav>;
  saveCalDavSource: NonNullable<typeof api.calendar.saveCalDavSource>;
  connectGoogleCalendar?: NonNullable<typeof api.calendar.connectGoogleCalendar>;
}

interface SourceDialogProps {
  open: boolean;
  onClose(): void;
  onSaved(source: CalendarSource): void;
  returnFocus?: HTMLElement | null;
  sourceApi?: SourceApi;
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function SourceDialog({ open, onClose, onSaved, returnFocus, sourceApi = api.calendar as SourceApi }: SourceDialogProps) {
  const [label, setLabel] = useState("CalDAV");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [calendars, setCalendars] = useState<RemoteCalendar[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "discovering" | "saving">("idle");
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setPassword("");
      setError(null);
      setStatus("idle");
    }
  }, [open]);

  const host = useMemo(() => {
    try { return new URL(url).host; } catch { return ""; }
  }, [url]);

  const discover = async () => {
    if (!validUrl(url)) {
      setError("Use an HTTPS CalDAV URL without embedded credentials.");
      urlRef.current?.focus();
      return;
    }
    if (!username.trim() || !password) {
      setError("Username and password are required.");
      return;
    }
    setStatus("discovering");
    setError(null);
    try {
      const discovered = await sourceApi.discoverCalDav({ url: url.trim(), username: username.trim(), password });
      setCalendars(discovered);
      setSelected(discovered.map((calendar) => calendar.id));
      if (discovered.length === 0) setError("No calendar collections were found.");
    } catch (reason) {
      setError(reason && typeof reason === "object" && "message" in reason ? String(reason.message) : "CalDAV discovery failed.");
    } finally {
      setStatus("idle");
    }
  };

  const save = async () => {
    if (selected.length === 0) {
      setError("Select at least one calendar.");
      return;
    }
    setStatus("saving");
    setError(null);
    try {
      const source = await sourceApi.saveCalDavSource({
        label: label.trim() || host || "CalDAV",
        url: url.trim(),
        username: username.trim(),
        password,
        selectedCalendarIds: selected,
      });
      setPassword("");
      onSaved(source);
      onClose();
    } catch (reason) {
      setError(reason && typeof reason === "object" && "message" in reason ? String(reason.message) : "Connection could not be saved.");
    } finally {
      setStatus("idle");
    }
  };

  const connectGoogle = async () => {
    if (!sourceApi.connectGoogleCalendar) return;
    setStatus("saving");
    setError(null);
    try {
      const source = await sourceApi.connectGoogleCalendar();
      onSaved(source);
      onClose();
    } catch (reason) {
      setError(reason && typeof reason === "object" && "message" in reason ? String(reason.message) : "Google Calendar authorization did not complete.");
    } finally {
      setStatus("idle");
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add calendar connection" maxWidth={620} returnFocus={returnFocus}>
      <form className="calendar-source-form" onSubmit={(event) => { event.preventDefault(); void (calendars.length ? save() : discover()); }}>
        <p className="calendar-source-intro">Connect any standards-based CalDAV server. Credentials are encrypted on this device.</p>
        {sourceApi.connectGoogleCalendar && (
          <>
            <button type="button" className="calendar-provider-choice" disabled={status !== "idle"} onClick={() => { void connectGoogle(); }}>
              <b>Google Calendar</b><span>Authorize calendar access separately from Gmail</span>
            </button>
            <div className="calendar-source-separator"><span>or connect CalDAV</span></div>
          </>
        )}
        <label><span>Connection name</span><input value={label} onChange={(event) => setLabel(event.currentTarget.value)} autoComplete="off" /></label>
        <label><span>Server URL</span><input ref={urlRef} aria-label="CalDAV URL" type="url" value={url} onChange={(event) => { setUrl(event.currentTarget.value); setCalendars([]); }} placeholder="https://calendar.example.com" autoComplete="url" /></label>
        <div className="calendar-source-credentials">
          <label><span>Username</span><input aria-label="Username" value={username} onChange={(event) => setUsername(event.currentTarget.value)} autoComplete="username" /></label>
          <label><span>Password or app password</span><input aria-label="Password" type="password" value={password} onChange={(event) => setPassword(event.currentTarget.value)} autoComplete="current-password" /></label>
        </div>
        {calendars.length > 0 && (
          <fieldset className="calendar-source-collections">
            <legend>Calendars on {host}</legend>
            {calendars.map((calendar) => (
              <label key={calendar.id}>
                <input type="checkbox" checked={selected.includes(calendar.id)} onChange={(event) => setSelected((current) => event.currentTarget.checked ? [...current, calendar.id] : current.filter((id) => id !== calendar.id))} />
                <span className="calendar-color" style={{ backgroundColor: calendar.color }} aria-hidden="true" />
                <span><b>{calendar.name}</b><small>{calendar.writable ? "Can edit" : "Read only"}{calendar.supportsSyncCollection ? " · Fast sync" : ""}</small></span>
              </label>
            ))}
          </fieldset>
        )}
        {error && <p className="calendar-source-error" role="alert">{error}</p>}
        <div className="calendar-source-actions">
          <button type="button" className="calendar-button calendar-button-quiet" onClick={onClose}>Cancel</button>
          <button type="submit" className="calendar-button calendar-button-primary" disabled={status !== "idle"}>
            {status === "discovering" ? "Discovering…" : status === "saving" ? "Saving…" : calendars.length ? "Add connection" : "Discover calendars"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
