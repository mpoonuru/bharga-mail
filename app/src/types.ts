// Domain types — shared shape between the React UI and the Rust core (mirror in src-tauri).

export type View =
  | "priority"
  | "inbox"
  | "flagged"
  | "snoozed"
  | "awaiting"
  | "newsletters"
  | "receipts"
  | "calendar"
  | "tasks"
  | "settings";

export interface Account {
  id: string;
  email: string;
  provider: "gmail" | "microsoft" | "jmap" | "imap";
  displayName: string;
  unread?: number;
  /** Unix seconds for the most recent completed provider sync. */
  lastSyncAt?: number;
  /** Non-sensitive persisted provider health status from the latest failure. */
  syncError?: string;
}

export interface FolderInfo {
  name: string;
  role?: string; // inbox|sent|drafts|trash|junk|archive
  unread: number;
  total: number;
}

export interface MessageParty {
  name: string;
  address: string;
}

export interface AttachmentMeta {
  name: string;
  mime: string;
  size: number;
}

export interface MessageMeta {
  cc?: MessageParty[];
  replyTo?: string;
  messageId?: string;
  originIp?: string;
  auth?: string; // "spf=pass; dkim=pass; dmarc=pass"
}

export interface Message {
  id: string;
  from: MessageParty;
  to: MessageParty[];
  when: string; // ISO
  bodyHtml: string;
  attachments?: AttachmentMeta[];
  meta?: MessageMeta;
}

export type Label = "urgent" | "ai-draft" | "meeting" | "receipt" | "newsletter";

export interface Thread {
  id: string;
  accountId: string;
  subject: string;
  preview: string;
  participants: string[];
  lastTime: string; // display string for the concept
  unread: boolean;
  labels: Label[];
  view: View[]; // which folders/views this thread appears in
  folder?: string; // the mailbox (IMAP folder) it belongs to
  aiSummary?: string;
  aiDraft?: string;
  messages: Message[];
}

export interface Task {
  id: string;
  title: string;
  due?: string;
  done: boolean;
  sourceThreadId?: string;
}

export type CalendarProvider = "local" | "calDav" | "google" | "microsoft";
export type CalendarSourceRemovalPolicy = "keepLocalCopy" | "deleteLocalData";
export type CalendarAuthState = "ready" | "reauthorizationRequired" | "error";
export type CalendarAccessRole = "owner" | "writer" | "reader" | "freeBusyReader";

export interface CalendarSource {
  id: string;
  linkedAccountId: string | null;
  provider: CalendarProvider;
  label: string;
  address: string | null;
  authState: CalendarAuthState;
  capabilities: string[];
  lastSyncAt: number | null;
  syncError: string | null;
  disabled: boolean;
}

export interface Calendar {
  id: string;
  sourceId: string;
  providerId: string | null;
  name: string;
  description: string;
  color: string;
  timezone: string;
  accessRole: CalendarAccessRole;
  writable: boolean;
  visible: boolean;
  isDefault: boolean;
  sortOrder: number;
}

export type EventMoment =
  | { kind: "timed"; utc: string }
  | { kind: "allDay"; date: string };

export interface RecurrenceSet {
  rules: string[];
  dates: string[];
  excludedDates: string[];
}

export type EventStatus = "tentative" | "confirmed" | "cancelled";
export type EventTransparency = "busy" | "free";
export type EventVisibility = "default" | "public" | "private" | "confidential";
export type AttendeeRole = "required" | "optional" | "chair" | "nonParticipant";
export type ParticipationStatus = "needsAction" | "accepted" | "declined" | "tentative" | "delegated";
export type ReminderMethod = "display" | "email";
export type EventSyncState = "local" | "pending" | "synced" | "conflict" | "error";

export interface EventPerson {
  name?: string | null;
  email: string;
}

export interface EventAttendee {
  name?: string | null;
  email: string;
  role: AttendeeRole;
  status: ParticipationStatus;
  rsvp: boolean;
  comment?: string | null;
}

export interface EventReminder {
  id?: string | null;
  method: ReminderMethod;
  minutesBefore: number;
}

export interface EventMutation {
  calendarId: string;
  title: string;
  description: string;
  location: string;
  conferenceUrl?: string | null;
  sourceThreadId?: string | null;
  start: EventMoment;
  end: EventMoment;
  timezone: string;
  recurrence?: RecurrenceSet | null;
  status: EventStatus;
  transparency: EventTransparency;
  visibility: EventVisibility;
  organizer?: EventPerson | null;
  attendees: EventAttendee[];
  reminders: EventReminder[];
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  uid: string;
  providerId: string | null;
  title: string;
  description: string;
  location: string;
  conferenceUrl: string | null;
  sourceThreadId: string | null;
  start: EventMoment;
  end: EventMoment;
  timezone: string;
  recurrence: RecurrenceSet | null;
  recurrenceId: string | null;
  parentEventId: string | null;
  status: EventStatus;
  transparency: EventTransparency;
  visibility: EventVisibility;
  organizer: EventPerson | null;
  attendees: EventAttendee[];
  reminders: EventReminder[];
  sequence: number;
  providerVersion: string | null;
  revision: number;
  syncState: EventSyncState;
  deleted: boolean;
}

export interface CalendarConflict {
  eventId: string;
  local: CalendarEvent;
  remote: CalendarEvent;
  providerVersion: string | null;
  createdAt: number;
}

export type ConflictResolution = "keepLocal" | "useRemote" | "duplicate";

export interface CalendarSyncHealth {
  sourceId: string;
  pendingCount: number;
  conflictCount: number;
  lastSyncAt: number | null;
  errorCode: string | null;
  retryAt: number | null;
}

export interface BusyInterval {
  start: string;
  end: string;
}

export interface FreeBusyResult {
  intervals: BusyInterval[];
  complete: boolean;
}

export interface EventRange {
  start: string;
  end: string;
}

export interface CreateLocalCalendarInput {
  name: string;
  color: string;
  timezone: string;
}

export interface CalendarCommandError {
  code: string;
  message: string;
  retryable: boolean;
}

export type InvitationState = "new" | "update" | "current" | "stale" | "cancelled";

export interface InvitationInspection {
  state: InvitationState;
  method: "PUBLISH" | "REQUEST" | "REPLY" | "CANCEL" | null;
  event: CalendarEvent;
  conflicts: CalendarEvent[];
  transport: "emailAttachment" | string;
}

export interface InvitationResponseInput {
  accountId: string;
  threadId?: string | null;
  calendarId: string;
  event: CalendarEvent;
  status: Extract<ParticipationStatus, "accepted" | "tentative" | "declined">;
}

export interface RemoteCalendar {
  id: string;
  href: string;
  name: string;
  description: string;
  color: string;
  timezone: string;
  writable: boolean;
  supportsSyncCollection: boolean;
  supportsScheduling: boolean;
  ctag: string | null;
  syncToken: string | null;
}

export interface CalDavDiscoveryInput {
  url: string;
  username: string;
  password: string;
}

export interface SaveCalDavSourceInput extends CalDavDiscoveryInput {
  label: string;
  selectedCalendarIds: string[];
}

// ---- Plug-and-play AI engine (mirrors Rust `ai` module) ----

export type AiProviderKind =
  | "anthropic"
  | "openai-compatible"
  | "google"
  | "local"
  | "custom";

export type AiRole = "triage" | "embeddings" | "summarize" | "draft" | "agent";

export interface AiModel {
  id: string;
  label: string;
  kind: AiProviderKind;
  /** roles this model is currently assigned to */
  roles: AiRole[];
  /** whether the user has supplied credentials / a reachable endpoint */
  ready: boolean;
  endpoint?: string; // for local / custom / openai-compatible
  /** provider-specific model id, e.g. "gpt-4o", "llama3" */
  model?: string;
  caps?: {
    context_tokens: number;
    tool_calling: boolean;
    vision: boolean;
    embeddings: boolean;
    streaming: boolean;
  };
}

export interface SaveAiProviderInput extends Omit<AiModel, "ready"> {
  /** Write-only. The core stores it securely and never returns it. */
  apiKey?: string;
}

export interface AiProfile {
  name: string;
  privacy: "cloud" | "hybrid" | "local";
  models: AiModel[];
}
