// Bridge to the Rust core via Tauri IPC.
// When running in the browser (vite dev without Tauri), we fall back to mock data
// so the whole UI is explorable. In the Tauri shell, these call real `#[tauri::command]`s.

import type {
  Account,
  AiProfile,
  Calendar,
  CalendarEvent,
  CalendarSource,
  CreateLocalCalendarInput,
  EventMutation,
  EventRange,
  FolderInfo,
  InvitationInspection,
  InvitationResponseInput,
  CalDavDiscoveryInput,
  SaveCalDavSourceInput,
  RemoteCalendar,
  SaveAiProviderInput,
  Task,
  Thread,
} from "@/types";
import dayjs from "dayjs";
import { parseExternalWebUrl } from "@/lib/externalLinks";
import {
  account as mockAccount,
  aiProfile as mockAiProfile,
  tasks as mockTasks,
  threads as mockThreads,
} from "@/data/mock";

export interface ImapAccountInput {
  accountId?: string;
  email: string;
  displayName?: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: "ssl" | "starttls" | "none";
  imapUsername?: string;
  imapPassword: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: "ssl" | "starttls" | "none";
  sameCredentials: boolean;
  smtpUsername?: string;
  smtpPassword?: string;
}

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function runtimeMode(): "desktop" | "preview" {
  return inTauri ? "desktop" : "preview";
}

/** Toggle the OS window between maximized/restored (macOS title-bar zoom). */
export async function toggleMaximizeWindow(): Promise<void> {
  if (!inTauri) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().toggleMaximize();
  } catch {
    /* ignore */
  }
}

/** Begin a native OS window drag. Tauri's built-in `data-tauri-drag-region` only
 *  fires when the cursor is exactly on the attributed element (not its children),
 *  so the header strips — packed with a logo, title text and buttons — have almost
 *  no grabbable area. We drive the drag explicitly from a mousedown handler. On
 *  macOS this uses performWindowDragWithEvent, so double-click-to-zoom still works. */
export async function startWindowDrag(): Promise<void> {
  if (!inTauri) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().startDragging();
  } catch {
    /* ignore */
  }
}

/** Double-click on a title-bar / drag-region strip. Intentionally a NO-OP:
 *  Tauri's native `data-tauri-drag-region` already maximizes on double-click
 *  (window/scripts/drag.js → `internal_toggle_maximize`). Toggling again here
 *  double-fired, so the window zoomed and instantly un-zoomed. Kept as a named
 *  export so the drag strips can still reference it without behavioural churn. */
export function titlebarDoubleClick(): void {
  /* native drag-region handles double-click-to-zoom */
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!inTauri) throw new Error("not-in-tauri");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

// Holds the pending update between the check and the install so the UI can show
// a prompt first. Cleared once installed.
let pendingUpdate: { version: string; downloadAndInstall: () => Promise<void> } | null = null;

// The browser preview exercises the same local-first calendar operations as the
// desktop bridge. It intentionally starts empty and never pretends that a
// remote provider connected or returned data.
const previewCalendarSource: CalendarSource = {
  id: "preview-local-source",
  linkedAccountId: null,
  provider: "local",
  label: "Personal",
  address: null,
  authState: "ready",
  capabilities: [],
  lastSyncAt: null,
  syncError: null,
  disabled: false,
};
let previewCalendars: Calendar[] = [{
  id: "preview-local-calendar",
  sourceId: previewCalendarSource.id,
  providerId: null,
  name: "Personal",
  description: "",
  color: "#6f8df6",
  timezone: "Europe/Berlin",
  accessRole: "owner",
  writable: true,
  visible: true,
  isDefault: true,
  sortOrder: 0,
}];
let previewCalendarEvents: CalendarEvent[] = [];
let previewCalendarSequence = 0;
let pendingCalendarDraft: EventMutation | null = null;

function copyCalendarEvent(event: CalendarEvent): CalendarEvent {
  return {
    ...event,
    attendees: event.attendees.map((attendee) => ({ ...attendee })),
    reminders: event.reminders.map((reminder) => ({ ...reminder })),
    recurrence: event.recurrence ? {
      rules: [...event.recurrence.rules],
      dates: [...event.recurrence.dates],
      excludedDates: [...event.recurrence.excludedDates],
    } : null,
  };
}

function eventIntersectsRange(event: CalendarEvent, range: EventRange): boolean {
  const eventStart = event.start.kind === "timed" ? dayjs(event.start.utc) : dayjs(event.start.date);
  const eventEnd = event.end.kind === "timed" ? dayjs(event.end.utc) : dayjs(event.end.date);
  return eventStart.isBefore(dayjs(range.end)) && eventEnd.isAfter(dayjs(range.start));
}

/** Check GitHub Releases for a newer signed build. Returns the new version
 *  string if one is available, else null. No-op outside the desktop app. */
export async function checkForUpdate(): Promise<string | null> {
  if (!inTauri) return null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const upd = await check();
    if (upd && upd.available) {
      pendingUpdate = upd as unknown as typeof pendingUpdate;
      return upd.version;
    }
  } catch {
    /* offline / no update / not packaged — ignore */
  }
  return null;
}

/** Download + install the pending update (verified against our public key) and
 *  relaunch the app. */
export async function installUpdateAndRestart(): Promise<void> {
  if (!inTauri || !pendingUpdate) return;
  await pendingUpdate.downloadAndInstall();
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

/** Show the unread count on the Dock (macOS) / taskbar (Windows) icon, like
 *  Apple Mail. `0` clears the badge. No-op in the browser preview. */
export async function setDockBadge(count: number): Promise<void> {
  if (!inTauri) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setBadgeCount(count > 0 ? count : undefined);
  } catch {
    /* ignore */
  }
}

/** The build id the CURRENT core expects its frontend to be. Compared against the
 *  loaded frontend's compiled-in `__BUILD_ID__` to detect a stale WebView-cached
 *  shell. Null outside the desktop app (browser preview / dev). */
export async function expectedBuildId(): Promise<string | null> {
  if (!inTauri) return null;
  try {
    return await invoke<string | null>("expected_build_id");
  } catch {
    return null;
  }
}

/** Subscribe to background live-sync events from the core. Returns an unsubscribe
 *  function. No-ops outside the desktop app (browser preview). */
export async function listenMail(handlers: { onSync?: () => void; onNew?: (count: number) => void }): Promise<() => void> {
  if (!inTauri) return () => {};
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const offSync = await listen("mail:sync", () => handlers.onSync?.());
    const offNew = await listen<{ count: number }>("mail:new", (e) => handlers.onNew?.(e.payload?.count ?? 1));
    return () => { offSync(); offNew(); };
  } catch {
    return () => {};
  }
}

export const api = {
  calendar: {
    async listSources(): Promise<CalendarSource[]> {
      if (inTauri) return invoke<CalendarSource[]>("list_calendar_sources");
      return [{ ...previewCalendarSource, capabilities: [...previewCalendarSource.capabilities] }];
    },

    async listCalendars(): Promise<Calendar[]> {
      if (inTauri) return invoke<Calendar[]>("list_calendars");
      return previewCalendars.map((calendar) => ({ ...calendar }));
    },

    async listEvents(range: EventRange): Promise<CalendarEvent[]> {
      if (inTauri) return invoke<CalendarEvent[]>("list_calendar_events", { input: range });
      return previewCalendarEvents
        .filter((event) => !event.deleted && eventIntersectsRange(event, range))
        .map(copyCalendarEvent);
    },

    async getEvent(eventId: string): Promise<CalendarEvent | undefined> {
      if (inTauri) {
        return (await invoke<CalendarEvent | null>("get_calendar_event", { eventId })) ?? undefined;
      }
      const event = previewCalendarEvents.find((candidate) => candidate.id === eventId);
      return event ? copyCalendarEvent(event) : undefined;
    },

    async createEvent(input: EventMutation): Promise<CalendarEvent> {
      if (inTauri) return invoke<CalendarEvent>("create_calendar_event", { input });
      previewCalendarSequence += 1;
      const event: CalendarEvent = {
        ...input,
        id: `preview-event-${previewCalendarSequence}`,
        uid: `preview-event-${previewCalendarSequence}@bharga.local`,
        providerId: null,
        conferenceUrl: input.conferenceUrl ?? null,
        sourceThreadId: input.sourceThreadId ?? null,
        recurrence: input.recurrence ?? null,
        recurrenceId: null,
        parentEventId: null,
        organizer: input.organizer ?? null,
        sequence: 0,
        providerVersion: null,
        revision: 1,
        syncState: "pending",
        deleted: false,
      };
      previewCalendarEvents = [...previewCalendarEvents, event];
      return copyCalendarEvent(event);
    },

    async updateEvent(eventId: string, input: EventMutation): Promise<CalendarEvent> {
      if (inTauri) return invoke<CalendarEvent>("update_calendar_event", { eventId, input });
      const existing = previewCalendarEvents.find((candidate) => candidate.id === eventId);
      if (!existing) throw new Error("Calendar event was not found");
      const updated: CalendarEvent = {
        ...existing,
        ...input,
        revision: existing.revision + 1,
        syncState: "pending",
      };
      previewCalendarEvents = previewCalendarEvents.map((candidate) =>
        candidate.id === eventId ? updated : candidate);
      return copyCalendarEvent(updated);
    },

    async updateRecurringEvent(
      eventId: string,
      recurrenceId: string,
      scope: "occurrence" | "following" | "series",
      input: EventMutation,
    ): Promise<CalendarEvent[]> {
      if (!inTauri) return [await this.updateEvent(eventId, input)];
      const nativeScope = scope === "occurrence"
        ? "thisOccurrence"
        : scope === "following"
          ? "thisAndFollowing"
          : "entireSeries";
      const result = await invoke<{
        original: CalendarEvent;
        following: CalendarEvent | null;
        exception: CalendarEvent | null;
      }>("update_recurring_calendar_event", { eventId, recurrenceId, scope: nativeScope, input });
      return [result.original, result.following, result.exception].filter(
        (event): event is CalendarEvent => event !== null,
      );
    },

    async importIcs(calendarId: string): Promise<CalendarEvent[]> {
      if (!inTauri) return [];
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Calendar", extensions: ["ics", "ical"] }],
      });
      if (!path || Array.isArray(path)) return [];
      return invoke<CalendarEvent[]>("import_ics", { path, calendarId });
    },

    async exportIcs(eventIds: string[]): Promise<number> {
      if (!inTauri || eventIds.length === 0) return 0;
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: "calendar.ics",
        filters: [{ name: "Calendar", extensions: ["ics"] }],
      });
      if (!path) return 0;
      return invoke<number>("export_ics", { path, eventIds });
    },

    async inspectAttachment(
      accountId: string,
      messageId: string,
      name: string,
    ): Promise<InvitationInspection[]> {
      if (!inTauri) return [];
      return invoke<InvitationInspection[]>("inspect_calendar_attachment", {
        accountId,
        messageId,
        name,
      });
    },

    async respondToInvitation(input: InvitationResponseInput): Promise<CalendarEvent> {
      return invoke<CalendarEvent>("respond_to_invitation", { input });
    },

    async scheduleFromThread(threadId: string): Promise<EventMutation> {
      let draft: EventMutation;
      if (inTauri) {
        draft = await invoke<EventMutation>("schedule_from_thread", { threadId });
      } else {
        const thread = mockThreads.find((candidate) => candidate.id === threadId);
        const calendar = previewCalendars.find((candidate) => candidate.writable);
        if (!thread || !calendar) throw new Error("A writable calendar is required");
        const start = dayjs().add(1, "hour").minute(0).second(0).millisecond(0);
        draft = {
          calendarId: calendar.id,
          title: thread.subject,
          description: thread.preview,
          location: "",
          conferenceUrl: null,
          sourceThreadId: thread.id,
          start: { kind: "timed", utc: start.toISOString() },
          end: { kind: "timed", utc: start.add(1, "hour").toISOString() },
          timezone: calendar.timezone,
          recurrence: null,
          status: "confirmed",
          transparency: "busy",
          visibility: "default",
          organizer: null,
          attendees: [],
          reminders: [],
        };
      }
      pendingCalendarDraft = draft;
      return draft;
    },

    takeScheduledDraft(): EventMutation | null {
      const draft = pendingCalendarDraft;
      pendingCalendarDraft = null;
      return draft;
    },

    async discoverCalDav(input: CalDavDiscoveryInput): Promise<RemoteCalendar[]> {
      if (!inTauri) throw new Error("CalDAV discovery requires the desktop app");
      return invoke<RemoteCalendar[]>("discover_caldav", { input });
    },

    async saveCalDavSource(input: SaveCalDavSourceInput): Promise<CalendarSource> {
      if (!inTauri) throw new Error("CalDAV connections require the desktop app");
      return invoke<CalendarSource>("save_caldav_source", { input });
    },

    async connectGoogleCalendar(): Promise<CalendarSource> {
      if (!inTauri) throw new Error("Google Calendar authorization requires the desktop app");
      return invoke<CalendarSource>("connect_google_calendar");
    },

    async connectMicrosoftCalendar(): Promise<CalendarSource> {
      if (!inTauri) throw new Error("Microsoft Calendar authorization requires the desktop app");
      return invoke<CalendarSource>("connect_microsoft_calendar");
    },

    async deleteEvent(eventId: string): Promise<CalendarEvent> {
      if (inTauri) return invoke<CalendarEvent>("delete_calendar_event", { eventId });
      const existing = previewCalendarEvents.find((candidate) => candidate.id === eventId);
      if (!existing) throw new Error("Calendar event was not found");
      const deleted = {
        ...existing,
        revision: existing.revision + 1,
        syncState: "pending" as const,
        deleted: true,
      };
      previewCalendarEvents = previewCalendarEvents.map((candidate) =>
        candidate.id === eventId ? deleted : candidate);
      return copyCalendarEvent(deleted);
    },

    async createLocalCalendar(input: CreateLocalCalendarInput): Promise<Calendar> {
      if (inTauri) return invoke<Calendar>("create_local_calendar", { input });
      previewCalendarSequence += 1;
      const calendar: Calendar = {
        id: `preview-calendar-${previewCalendarSequence}`,
        sourceId: previewCalendarSource.id,
        providerId: null,
        name: input.name,
        description: "",
        color: input.color,
        timezone: input.timezone,
        accessRole: "owner",
        writable: true,
        visible: true,
        isDefault: previewCalendars.length === 0,
        sortOrder: previewCalendars.length,
      };
      previewCalendars = [...previewCalendars, calendar];
      return { ...calendar };
    },

    async setVisibility(calendarId: string, visible: boolean): Promise<void> {
      if (inTauri) {
        await invoke<void>("set_calendar_visibility", { calendarId, visible });
        return;
      }
      if (!previewCalendars.some((calendar) => calendar.id === calendarId)) {
        throw new Error("Calendar was not found");
      }
      previewCalendars = previewCalendars.map((calendar) =>
        calendar.id === calendarId ? { ...calendar, visible } : calendar);
    },

    async syncSource(sourceId: string): Promise<void> {
      if (inTauri) {
        await invoke<void>("sync_calendar_source", { sourceId });
      }
    },
  },

  async openExternalUrl(rawUrl: string): Promise<void> {
    const destination = parseExternalWebUrl(rawUrl);
    if (!destination) throw new Error("Blocked external link: only valid http and https URLs are allowed.");
    if (!inTauri) {
      window.open(destination.href, "_blank", "noopener,noreferrer");
      return;
    }
    await invoke<void>("open_external_url", { url: destination.href });
  },

  async getAppVersion(): Promise<string> {
    if (!inTauri) return __APP_VERSION__;
    const { getVersion } = await import("@tauri-apps/api/app");
    return getVersion();
  },

  async listThreads(): Promise<Thread[]> {
    try {
      return await invoke<Thread[]>("list_threads");
    } catch {
      return mockThreads;
    }
  },

  /** Full-text search over the WHOLE email content (FTS5), not just the preview. */
  async searchMail(query: string): Promise<Thread[]> {
    const q = query.trim();
    if (!q) return [];
    try {
      return await invoke<Thread[]>("search_mail", { query: q });
    } catch {
      // Browser/preview fallback — search subject + preview + body across the mock.
      const lc = q.toLowerCase();
      return mockThreads.filter((t) =>
        [t.subject, t.preview, t.participants.join(" "), ...t.messages.map((m) => m.bodyHtml)]
          .join(" ").toLowerCase().includes(lc));
    }
  },

  /** Durable user settings (theme, density, font, locale, …) from the core. */
  async getSettings(): Promise<Record<string, string>> {
    try {
      return await invoke<Record<string, string>>("get_settings");
    } catch {
      return {};
    }
  },

  /** Persist one user setting to the core. */
  async setSetting(key: string, value: string): Promise<void> {
    try {
      await invoke<void>("set_setting", { key, value });
    } catch {
      /* browser preview: localStorage-only */
    }
  },

  /** Connected mail accounts (for the sidebar account switcher). */
  async listAccounts(): Promise<Account[]> {
    if (!inTauri) return [mockAccount];
    // In the desktop app an empty list means "no account connected yet" and
    // an IPC error must remain an error rather than inventing an identity.
    return invoke<Account[]>("list_accounts");
  },

  async listTasks(): Promise<Task[]> {
    try {
      return await invoke<Task[]>("list_tasks");
    } catch {
      return mockTasks;
    }
  },

  async getAiProfile(): Promise<AiProfile> {
    if (!inTauri) return mockAiProfile;
    return invoke<AiProfile>("get_ai_profile");
  },

  /** Persist only the privacy field; provider mutations use dedicated commands. */
  async setAiPrivacy(privacy: AiProfile["privacy"]): Promise<void> {
    if (!inTauri) return;
    await invoke<void>("set_ai_privacy", { privacy });
  },

  async saveAiProvider(input: SaveAiProviderInput): Promise<AiProfile> {
    if (!inTauri) {
      const { apiKey, ...metadata } = input;
      const model = { ...metadata, ready: input.kind === "local" ? !!input.endpoint : !!apiKey };
      const models = mockAiProfile.models.filter((candidate) => candidate.id !== input.id);
      return { ...mockAiProfile, models: [...models, model] };
    }
    return invoke<AiProfile>("save_ai_provider", { input });
  },

  async removeAiProvider(providerId: string): Promise<AiProfile> {
    if (!inTauri) {
      return { ...mockAiProfile, models: mockAiProfile.models.filter((model) => model.id !== providerId) };
    }
    return invoke<AiProfile>("remove_ai_provider", { providerId });
  },

  async testAiProvider(input: SaveAiProviderInput): Promise<string> {
    if (!inTauri) return "Configuration looks valid. Run the desktop app to test the connection.";
    return invoke<string>("test_ai_provider", { input });
  },

  /** Ask the AI engine to (re)draft a reply for a thread, routed to the "draft" role model. */
  async draftReply(threadId: string, threadText: string): Promise<string> {
    try {
      return await invoke<string>("ai_draft_reply", { threadId, threadText });
    } catch {
      const t = mockThreads.find((x) => x.id === threadId);
      return t?.aiDraft ?? "Thanks for your message — I'll get back to you shortly.";
    }
  },

  /** Phase-2 phishing verdict. Production routes to the local Triage model
   *  (ai_phishing_check) — private, no API cost. In the browser preview (no
   *  model) a lightweight on-device heuristic stands in so the UX is demoable. */
  async phishingCheck(
    threadText: string,
    links: string,
  ): Promise<{ level: "phishing" | "suspicious" | "safe"; confidence: number; reason: string } | null> {
    try {
      return JSON.parse(await invoke<string>("ai_phishing_check", { threadText, links }));
    } catch {
      const t = `${threadText} ${links}`.toLowerCase();
      const lc = links.toLowerCase();
      const threat = /(suspend|unusual activity|within \d+\s?h|verify your|confirm your|update your|account will be|locked|unauthori[sz]ed|act now|click here)/.test(t);
      const cred = /(log\s?in|sign\s?in|password|verify|account|billing|payment|wallet|bank)/.test(t);
      const hasDanger = /dangerous/.test(lc);
      const hasRisky = /dangerous|suspicious/.test(lc);
      if (hasDanger && (threat || cred)) return { level: "phishing", confidence: 88, reason: "Urgency/credential lure paired with a deceptive link." };
      if (threat && cred) return { level: "phishing", confidence: 80, reason: "Urgent account threat asking you to verify or sign in." };
      if (hasRisky || threat) return { level: "suspicious", confidence: 58, reason: hasRisky ? "Contains a suspicious link." : "Uses pressure/urgency language." };
      return { level: "safe", confidence: 12, reason: "No phishing signals detected." };
    }
  },

  /** Auto-triage the inbox: summarize + classify priority for new threads. */
  async triageInbox(): Promise<number> {
    try {
      return await invoke<number>("ai_triage_inbox");
    } catch {
      return 0;
    }
  },

  /** Build the semantic search index (embeds threads). Returns count indexed. */
  async reindex(): Promise<number> {
    try {
      return await invoke<number>("reindex_embeddings");
    } catch {
      return 0;
    }
  },

  /** Natural-language "ask my inbox" — RAG over the local store. */
  async askInbox(query: string): Promise<string> {
    try {
      return await invoke<string>("ai_ask_inbox", { query });
    } catch {
      return `(${mockAiProfile.name} engine) Here's what I found across your mailbox for: "${query}". Connect a model in Settings — then run the desktop app — to enable live answers.`;
    }
  },

  /** Queue an outgoing message with an Undo-Send window. Returns the outbox id. */
  async queueSend(args: {
    accountId: string;
    threadId?: string;
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    body: string;
    attachments?: { name: string; mime: string; dataB64: string }[];
    delaySeconds: number;
    /** Absolute epoch-seconds to send at (scheduled send). Omit for immediate. */
    sendAt?: number;
  }): Promise<string> {
    if (!inTauri) return `preview-${dayjs().valueOf()}`;
    return invoke<string>("queue_send", { ...args });
  },

  async cancelSend(id: string): Promise<boolean> {
    try {
      return await invoke<boolean>("cancel_send", { id });
    } catch {
      return true;
    }
  },

  async flushOutbox(): Promise<number> {
    try {
      return await invoke<number>("flush_outbox");
    } catch {
      return 0;
    }
  },

  async setTaskDone(id: string, done: boolean): Promise<void> {
    try {
      await invoke<void>("set_task_done", { id, done });
    } catch {
      // browser preview: state-only
    }
  },

  async createTask(title: string, sourceThreadId?: string): Promise<void> {
    try {
      await invoke<void>("create_task", { title, sourceThreadId });
    } catch {
      // browser preview: state-only (store adds optimistically)
    }
  },

  /** Launch the Gmail OAuth flow in the desktop app. Returns the new account id. */
  async connectGmail(): Promise<string> {
    return invoke<string>("connect_gmail"); // throws in browser preview (no Tauri)
  },

  /** Launch the Microsoft 365 OAuth flow. Returns the new account id. */
  async connectMicrosoft(): Promise<string> {
    return invoke<string>("connect_microsoft");
  },

  /** Register IMAP/SMTP config plus locally encrypted account-bound credentials. */
  async saveImapAccount(input: ImapAccountInput): Promise<string> {
    return invoke<string>("save_imap_account", { input });
  },

  /** Test IMAP login + SMTP connection without saving. Throws with the reason on failure. */
  async testImapAccount(input: ImapAccountInput): Promise<string> {
    return invoke<string>("test_imap_account", { input });
  },

  /** Saved IMAP/SMTP settings (no password) to pre-fill the edit form. */
  async getImapAccount(accountId: string): Promise<Partial<ImapAccountInput> | null> {
    try {
      const a = await invoke<Record<string, unknown> | null>("get_imap_account", { accountId });
      if (!a) return null;
      return {
        email: a.email as string,
        displayName: a.displayName as string,
        imapHost: a.imapHost as string,
        imapPort: a.imapPort as number,
        imapSecurity: a.imapSecurity as ImapAccountInput["imapSecurity"],
        imapUsername: a.imapUsername as string,
        smtpHost: a.smtpHost as string,
        smtpPort: a.smtpPort as number,
        smtpSecurity: a.smtpSecurity as ImapAccountInput["smtpSecurity"],
        smtpUsername: a.smtpUsername as string,
        sameCredentials: a.sameCredentials as boolean,
      };
    } catch {
      return null;
    }
  },

  /** Remove an account and its data + stored credentials. */
  async removeAccount(accountId: string): Promise<void> {
    if (!inTauri) return;
    await invoke<void>("remove_account", { accountId });
  },

  /** Set an account's friendly display name (shown instead of the raw address). */
  async renameAccount(accountId: string, name: string): Promise<void> {
    if (!inTauri) return;
    await invoke<void>("rename_account", { accountId, name });
  },

  /** Cached folders (with counts) for an account's sidebar list. */
  async folders(accountId: string): Promise<FolderInfo[]> {
    try {
      return await invoke<FolderInfo[]>("folders", { accountId });
    } catch {
      return [];
    }
  },

  /** Create / rename / delete an IMAP mailbox on the server (throws on failure). */
  async createFolder(accountId: string, name: string): Promise<void> {
    if (!inTauri) return;
    await invoke("create_folder", { accountId, name });
  },
  async renameFolder(accountId: string, from: string, to: string): Promise<void> {
    if (!inTauri) return;
    await invoke("rename_folder", { accountId, from, to });
  },
  async deleteFolder(accountId: string, name: string): Promise<void> {
    if (!inTauri) return;
    await invoke("delete_folder", { accountId, name });
  },

  /** Enumerate folders from the server (IMAP LIST), persist + return their names. */
  async listFolders(accountId: string): Promise<string[]> {
    try {
      return await invoke<string[]>("list_folders", { accountId });
    } catch {
      return ["INBOX"];
    }
  },

  /** Sync one folder; returns messages stored. Throws on real failure. */
  async syncFolder(accountId: string, folder: string, group = true): Promise<number> {
    if (!inTauri) return 0;
    return invoke<number>("sync_folder", { accountId, folder, group });
  },

  /** Pull an account's inbox now (Gmail/Graph/IMAP per account id prefix).
   *  `group` controls IMAP conversation grouping (defaults on). Returns the
   *  number of messages stored. Throws (with the reason) on a real failure so
   *  the UI can show it — only the "not running in the desktop app" case is
   *  swallowed. */
  async syncNow(accountId: string, group = true): Promise<number> {
    if (!inTauri) return 0;
    return invoke<number>("sync_now", { accountId, group });
  },

  /** Backfill older mail for a folder by growing the fetch window. Returns stored count. */
  async loadOlder(accountId: string, folder: string, count: number, group = true): Promise<number> {
    if (!inTauri) return 0;
    return invoke<number>("load_older", { accountId, folder, count, group });
  },

  /** Persist read/unread for a thread (and best-effort push to the provider). */
  async setThreadRead(threadId: string, accountId: string, unread: boolean): Promise<void> {
    try {
      await invoke<void>("set_thread_read", { threadId, accountId, unread });
    } catch {
      /* preview: state-only */
    }
  },

  /** Archive a thread (local + provider). */
  async archiveThread(threadId: string, accountId: string): Promise<void> {
    try {
      await invoke<void>("archive_thread", { threadId, accountId });
    } catch {
      /* preview: state-only */
    }
  },

  /** Snooze a thread (local smart view). */
  async snoozeThread(threadId: string): Promise<void> {
    try {
      await invoke<void>("snooze_thread", { threadId });
    } catch {
      /* preview: state-only */
    }
  },

  /** Delete a thread: soft-delete locally + best-effort provider trash. */
  async deleteThread(threadId: string, accountId: string): Promise<void> {
    try {
      await invoke<void>("delete_thread", { threadId, accountId });
    } catch {
      /* preview: state-only */
    }
  },

  /** Move a thread to another mailbox (local-first; IMAP server move best-effort). */
  async moveThread(threadId: string, accountId: string, toFolder: string): Promise<void> {
    try {
      await invoke<void>("move_thread", { threadId, accountId, toFolder });
    } catch (e) {
      // The local move already applied in the core; just log the server-side reason.
      console.warn("move_thread:", e);
    }
  },

  /** Report a thread as spam/junk (local tombstone + best-effort provider move). */
  async markSpam(threadId: string, accountId: string): Promise<void> {
    try {
      await invoke<void>("mark_spam", { threadId, accountId });
    } catch {
      /* preview: state-only */
    }
  },

  /** Flag / unflag a thread. Updates the local mirror and pushes the IMAP
   *  \Flagged keyword so the star round-trips with other mail clients. */
  async flagThread(threadId: string, accountId: string, flagged: boolean): Promise<void> {
    try {
      await invoke<void>("flag_thread", { threadId, accountId, flagged });
    } catch (e) {
      // Local flag already applied; surface only the server-side reason.
      console.warn("flag_thread:", e);
    }
  },

  /** All flagged thread ids (local mirror, kept in step with the server's
   *  \Flagged keyword by the IMAP sync). Returns [] if the call fails. */
  async flaggedIds(): Promise<string[]> {
    try {
      return await invoke<string[]>("flagged_ids");
    } catch {
      return [];
    }
  },

  /** Download an inbound attachment to the OS Downloads folder and open it.
   *  Returns the saved path. Throws (with the reason) on failure. */
  async downloadAttachment(accountId: string, messageId: string, name: string): Promise<string> {
    return invoke<string>("download_attachment", { accountId, messageId, name });
  },

  /** Fetch an attachment as a data: URL for inline preview (images/PDF). */
  async previewAttachment(accountId: string, messageId: string, name: string, mime: string): Promise<string> {
    return invoke<string>("preview_attachment", { accountId, messageId, name, mime });
  },
};
