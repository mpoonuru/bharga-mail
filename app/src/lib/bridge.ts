// Bridge to the Rust core via Tauri IPC.
// When running in the browser (vite dev without Tauri), we fall back to mock data
// so the whole UI is explorable. In the Tauri shell, these call real `#[tauri::command]`s.

import type { Thread, Task, CalEvent, AiProfile, Account } from "@/types";
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

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!inTauri) throw new Error("not-in-tauri");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export const api = {
  async listThreads(): Promise<Thread[]> {
    try {
      return await invoke<Thread[]>("list_threads");
    } catch {
      return mock.threads;
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
    subject: string;
    body: string;
    attachments?: { name: string; mime: string; dataB64: string }[];
    delaySeconds: number;
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

  /** Pull an account's inbox now (Gmail/Graph/IMAP per account id prefix).
   *  `group` controls IMAP conversation grouping (defaults on). Returns the
   *  number of messages stored. Throws (with the reason) on a real failure so
   *  the UI can show it — only the "not running in the desktop app" case is
   *  swallowed. */
  async syncNow(accountId: string, group = true): Promise<number> {
    if (!inTauri) return 0;
    return invoke<number>("sync_now", { accountId, group });
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
