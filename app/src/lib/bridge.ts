// Bridge to the Rust core via Tauri IPC.
// When running in the browser (vite dev without Tauri), we fall back to mock data
// so the whole UI is explorable. In the Tauri shell, these call real `#[tauri::command]`s.

import type { Thread, Task, CalEvent, AiProfile, Account, FolderInfo } from "@/types";
import * as mock from "@/data/mock";

export interface ImapAccountInput {
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
  smtpUsername?: string;
  smtpPassword?: string;
}

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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

/** Double-click handler for title-bar / drag-region strips: zoom (maximize) the
 *  window like a native macOS title bar — but ignore double-clicks that land on
 *  interactive controls (buttons, inputs, links) inside the strip. */
export function titlebarDoubleClick(e: { target: EventTarget | null }): void {
  const el = e.target as HTMLElement | null;
  if (el && el.closest('button, input, textarea, a, [role="button"], [contenteditable="true"]')) return;
  void toggleMaximizeWindow();
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!inTauri) throw new Error("not-in-tauri");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
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
  async listThreads(): Promise<Thread[]> {
    try {
      return await invoke<Thread[]>("list_threads");
    } catch {
      return mock.threads;
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
    try {
      const a = await invoke<Account[]>("list_accounts");
      // In the desktop app an empty list means "no account connected yet".
      return a;
    } catch {
      return [mock.account];
    }
  },

  async listTasks(): Promise<Task[]> {
    try {
      return await invoke<Task[]>("list_tasks");
    } catch {
      return mock.tasks;
    }
  },

  async listEvents(): Promise<CalEvent[]> {
    try {
      return await invoke<CalEvent[]>("list_events");
    } catch {
      return mock.events;
    }
  },

  async getAiProfile(): Promise<AiProfile> {
    try {
      return await invoke<AiProfile>("get_ai_profile");
    } catch {
      return mock.aiProfile;
    }
  },

  /** Persist the AI profile (model/role assignment, keys, endpoints) to the core. */
  async setAiProfile(profile: AiProfile): Promise<void> {
    try {
      await invoke<void>("set_ai_profile", { profile });
    } catch {
      // browser preview: nothing to persist
    }
  },

  /** Ask the AI engine to (re)draft a reply for a thread, routed to the "draft" role model. */
  async draftReply(threadId: string, threadText: string): Promise<string> {
    try {
      return await invoke<string>("ai_draft_reply", { threadId, threadText });
    } catch {
      const t = mock.threads.find((x) => x.id === threadId);
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
      return `(${mock.aiProfile.name} engine) Here's what I found across your mailbox for: "${query}". Connect a model in Settings — then run the desktop app — to enable live answers.`;
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
    try {
      return await invoke<string>("queue_send", { ...args });
    } catch {
      return `preview-${Date.now()}`; // browser preview
    }
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

  /** Register a full IMAP/SMTP account (passwords stored in the OS keychain). */
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
      };
    } catch {
      return null;
    }
  },

  /** Remove an account and its data + stored credentials. */
  async removeAccount(accountId: string): Promise<void> {
    try {
      await invoke<void>("remove_account", { accountId });
    } catch {
      /* preview: no-op */
    }
  },

  /** Cached folders (with counts) for an account's sidebar list. */
  async folders(accountId: string): Promise<FolderInfo[]> {
    try {
      return await invoke<FolderInfo[]>("folders", { accountId });
    } catch {
      return [];
    }
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
