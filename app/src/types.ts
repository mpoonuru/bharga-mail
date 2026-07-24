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

export interface CalEvent {
  id: string;
  title: string;
  day: number; // 0..6 for the concept week grid
  time: string;
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
