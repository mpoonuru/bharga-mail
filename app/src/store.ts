import { create } from "zustand";
import dayjs from "dayjs";
import type { View, Thread, Task, AiProfile, AiRole, AiModel, Account, FolderInfo, SaveAiProviderInput } from "@/types";
import { api, listenMail } from "@/lib/bridge";
import { account } from "@/data/mock";
import { SEND } from "@/config";
import { loadFont, applyFont, loadLocale, applyLocale } from "@/lib/prefs";

/** The account messages are sent from. Derived, never hardcoded at call sites. */
const activeAccountId = `${account.provider === "imap" ? "gmail" : account.provider}:${account.email}`;

/** Fire a desktop notification for newly-arrived mail, but only when the window
 *  is in the background (no point notifying about mail you're looking at). Uses
 *  the Web Notification API the webview already exposes — no extra OS plugin. */
function notifyNewMail(count: number): void {
  try {
    if (typeof Notification === "undefined" || !document.hidden) return;
    const title = count === 1 ? "New message" : `${count} new messages`;
    const show = () => new Notification(title, { body: "Bharga Mail", tag: "bharga-new-mail" });
    if (Notification.permission === "granted") show();
    else if (Notification.permission !== "denied") {
      void Notification.requestPermission().then((p) => { if (p === "granted" && document.hidden) show(); });
    }
  } catch {
    /* notifications unsupported — the auto-refresh still surfaces the mail */
  }
}

type Theme = "dark" | "light";
type Density = "compact" | "cozy" | "comfy";

interface AppState {
  // navigation
  view: View;
  selectedThreadId: string | null;
  selectedMessageId: string | null;
  setView: (v: View) => void;
  selectThread: (id: string, messageId?: string) => void;

  // chrome state
  theme: Theme;
  density: Density;
  focusMode: boolean;
  cmdOpen: boolean;
  modelPickerOpen: boolean;
  composeOpen: boolean;
  // responsive: on narrow layouts, whether the Stage (reading pane) is shown
  // over the Stream, and whether the sidebar drawer is open.
  mobileStage: boolean;
  drawerOpen: boolean;
  toggleTheme: () => void;
  setDensity: (d: Density) => void;
  toggleFocus: () => void;
  setCmd: (o: boolean) => void;
  setModelPicker: (o: boolean) => void;
  setCompose: (o: boolean) => void;
  /** Thread id for which a "reply with AI draft" was requested (e.g. from the command bar). */
  aiReplyFor: string | null;
  requestAiReply: (id: string) => void;
  clearAiReply: () => void;
  /** Open the composer for a thread in a given mode (from the context menu). */
  composeIntent: { id: string; mode: "reply" | "replyAll" | "forward" } | null;
  requestCompose: (id: string, mode: "reply" | "replyAll" | "forward") => void;
  clearComposeIntent: () => void;
  setDrawer: (o: boolean) => void;
  backToStream: () => void;

  // data
  threads: Thread[];
  tasks: Task[];
  ai: AiProfile | null;
  loaded: boolean;
  // connected accounts + which one is in focus (null = unified "All accounts")
  accounts: Account[];
  selectedAccountId: string | null;
  setAccount: (id: string | null) => void;
  // Folders for the focused account, and which folder is open (null = its inbox view).
  folders: FolderInfo[];
  selectedFolder: string | null;
  loadFolders: (accountId: string) => Promise<void>;
  refreshFolders: (accountId: string) => Promise<void>;
  createFolder: (accountId: string, name: string) => Promise<void>;
  renameFolder: (accountId: string, from: string, to: string) => Promise<void>;
  deleteFolder: (accountId: string, name: string) => Promise<void>;
  syncOneFolder: (accountId: string, folder: string) => Promise<void>;
  markFolderRead: (accountId: string, folder: string) => Promise<void>;
  setFolder: (name: string | null) => Promise<void>;
  /** Subscribe to the core's background live-sync (auto-refresh + notify). */
  liveSyncStarted: boolean;
  startLiveSync: () => Promise<void>;
  syncing: boolean;
  syncAll: () => Promise<{ total: number; errors: string[] }>;
  loadingOlder: boolean;
  reachedEnd: boolean;
  loadOlder: () => Promise<number>;
  removeAccount: (id: string) => Promise<void>;
  renameAccount: (id: string, name: string) => Promise<void>;
  load: () => Promise<void>;
  toggleTask: (id: string) => void;
  assignRole: (modelId: string, role: AiRole) => void;
  setPrivacy: (p: AiProfile["privacy"]) => void;
  updateModel: (modelId: string, patch: Partial<AiModel>) => void;
  addModel: () => void;
  saveModel: (input: SaveAiProviderInput) => Promise<void>;
  removeModel: (id: string) => Promise<void>;
  saveAi: () => Promise<void>;
  connectGmail: () => Promise<string>;
  connectMicrosoft: () => Promise<string>;
  createTask: (title: string, sourceThreadId?: string) => Promise<void>;

  // Undo Send
  undo: { id: string; label: string } | null;
  queueSend: (args: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    body: string;
    threadId?: string;
    /** Explicit sending account (the Compose "From" picker). Falls back to the
     *  thread's account / focused account / first account when omitted. */
    accountId?: string;
    attachments?: { name: string; mime: string; dataB64: string }[];
    /** Absolute epoch-seconds to send at (scheduled send). Omit for immediate. */
    sendAt?: number;
  }) => Promise<void>;
  cancelUndo: () => void;

  // Signatures (multiple, rich-text HTML; persisted to localStorage)
  signatures: Signature[];
  defaultSignatureId: string | null;
  addSignature: (name: string, html: string) => string;
  updateSignature: (id: string, patch: Partial<Pick<Signature, "name" | "html">>) => void;
  deleteSignature: (id: string) => void;
  setDefaultSignature: (id: string | null) => void;

  // Appearance prefs
  font: string;
  locale: string;
  setFont: (f: string) => void;
  setLocale: (l: string) => void;
  // Group replies into conversations (IMAP). Applies on next sync.
  groupConversations: boolean;
  setGroupConversations: (v: boolean) => void;
  // AI-inbox smart highlights (dates, %, money, urgency/sentiment) in email bodies.
  highlights: boolean;
  setHighlights: (v: boolean) => void;
  // Reading-pane content font size (px). User-adjustable A−/A+. Persisted.
  contentPx: number;
  setContentPx: (v: number) => void;
  // Auto-organize new mail with AI on arrival (summarize + triage). No-op without a model.
  autoOrganize: boolean;
  setAutoOrganize: (v: boolean) => void;
  // Resizable panel widths (px), persisted. Sidebar and the message-list column.
  panelSidebarW: number;
  panelStreamW: number;
  setPanelWidths: (sidebar: number, stream: number, persist?: boolean) => void;
  // User-collapsed sidebar (icons-only rail), persisted.
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  /** True while a triage pass is running (guards against overlapping runs). */
  triaging: boolean;

  // Thread actions
  snoozeThread: (id: string) => void;
  archiveThread: (id: string) => void;
  toggleRead: (id: string) => void;
  deleteThread: (id: string) => void;
  moveThread: (id: string, toFolder: string) => void;
  markSpam: (id: string) => void;
  /** Flagged (starred) thread ids — persisted locally, drives the Flagged view. */
  flaggedIds: string[];
  toggleFlag: (id: string) => void;
  /** User-defined account order (account ids). Drives the sidebar; persisted to DB. */
  accountOrder: string[];
  setAccountOrder: (ids: string[]) => void;
  /** Pinned folders, keyed `${accountId}${folder}`. Shown at the top; persisted to DB. */
  pinnedFolders: string[];
  togglePinFolder: (accountId: string, folder: string) => void;
  triageInbox: () => Promise<number>;
}

export interface Signature {
  id: string;
  name: string;
  html: string;
}

const SIG_KEY = "bharga.signature"; // legacy plain-text key (migrated)
const SIGS_KEY = "bharga.signatures";
const SIG_DEFAULT_KEY = "bharga.signature.default";

function loadSignatures(): { signatures: Signature[]; defaultId: string | null } {
  try {
    const raw = localStorage.getItem(SIGS_KEY);
    if (raw) {
      const signatures = JSON.parse(raw) as Signature[];
      return { signatures, defaultId: localStorage.getItem(SIG_DEFAULT_KEY) || signatures[0]?.id || null };
    }
    // migrate the old single plain signature, if any
    const legacy = localStorage.getItem(SIG_KEY);
    if (legacy) {
      const sig: Signature = { id: `sig-${Date.now()}`, name: "Default", html: legacy.replace(/\n/g, "<br>") };
      return { signatures: [sig], defaultId: sig.id };
    }
  } catch { /* ignore */ }
  return { signatures: [], defaultId: null };
}

function persistSignatures(signatures: Signature[], defaultId: string | null) {
  try {
    localStorage.setItem(SIGS_KEY, JSON.stringify(signatures));
    if (defaultId) localStorage.setItem(SIG_DEFAULT_KEY, defaultId);
    else localStorage.removeItem(SIG_DEFAULT_KEY);
  } catch { /* ignore */ }
  // Durable copy in the core settings store (DB), like other user prefs.
  void api.setSetting("signatures", JSON.stringify(signatures));
  void api.setSetting("signature_default", defaultId ?? "");
}

function applyDoc(theme: Theme, density: Density) {
  const el = document.documentElement;
  el.setAttribute("data-theme", theme);
  el.setAttribute("data-density", density);
}

// Persisted appearance prefs (theme + density) — survive refresh/restart.
function loadTheme(): Theme {
  try { return localStorage.getItem("bharga.theme") === "light" ? "light" : "dark"; } catch { return "dark"; }
}
function loadDensity(): Density {
  try {
    const v = localStorage.getItem("bharga.density");
    return v === "compact" || v === "comfy" ? v : "cozy";
  } catch { return "cozy"; }
}
// Persist a UI pref to both the instant localStorage cache and the durable core
// settings store (so it lives in the app's data model, not just the webview).
function persistPref(name: string, value: string) {
  try { localStorage.setItem(`bharga.${name}`, value); } catch { /* ignore */ }
  void api.setSetting(name, value);
}

// Apply the saved theme/density to <html> immediately on load so a refresh
// doesn't flash the default dark theme.
applyDoc(loadTheme(), loadDensity());

export const useApp = create<AppState>((set, get) => ({
  view: "priority",
  selectedThreadId: "t1",
  selectedMessageId: null,
  // A smart view (Priority / All Inbox / Flagged…) spans folders, so leaving a
  // specific mailbox: clear selectedFolder. Otherwise the view and a folder would
  // both read as selected, and the list would still be folder-filtered.
  // Changing what list you're looking at also resets the reading pane — otherwise
  // the Stage keeps showing the previously-opened email (it resolves the thread
  // from the GLOBAL thread list, which still contains the old folder's mail).
  setView: (v) => set({ view: v, selectedFolder: null, selectedThreadId: null, selectedMessageId: null, composeOpen: false, drawerOpen: false, mobileStage: false }),
  selectThread: (id, messageId) => {
    set({ selectedThreadId: id, selectedMessageId: messageId ?? null, mobileStage: true });
    // Opening a conversation marks it read — locally now, and \Seen on the server
    // (best-effort). Only fire when it was actually unread.
    const t = get().threads.find((x) => x.id === id);
    if (t?.unread) {
      set({ threads: get().threads.map((x) => (x.id === id ? { ...x, unread: false } : x)) });
      void api.setThreadRead(id, t.accountId, false);
    }
  },

  theme: loadTheme(),
  density: loadDensity(),
  focusMode: false,
  cmdOpen: false,
  modelPickerOpen: false,
  composeOpen: false,
  mobileStage: false,
  drawerOpen: false,
  toggleTheme: () => {
    const theme = get().theme === "dark" ? "light" : "dark";
    applyDoc(theme, get().density);
    persistPref("theme", theme);
    set({ theme });
  },
  setDensity: (density) => {
    applyDoc(get().theme, density);
    persistPref("density", density);
    set({ density });
  },
  toggleFocus: () => set({ focusMode: !get().focusMode }),
  setCmd: (cmdOpen) => set({ cmdOpen }),
  setModelPicker: (modelPickerOpen) => set({ modelPickerOpen }),
  setCompose: (composeOpen) => set({ composeOpen }),
  aiReplyFor: null,
  requestAiReply: (id) => set({ aiReplyFor: id, selectedThreadId: id, mobileStage: true }),
  clearAiReply: () => set({ aiReplyFor: null }),
  composeIntent: null,
  requestCompose: (id, mode) => set({ composeIntent: { id, mode }, selectedThreadId: id, mobileStage: true }),
  clearComposeIntent: () => set({ composeIntent: null }),
  setDrawer: (drawerOpen) => set({ drawerOpen }),
  backToStream: () => set({ mobileStage: false, composeOpen: false }),

  threads: [],
  tasks: [],
  ai: null,
  loaded: false,
  accounts: [],
  selectedAccountId: null,
  folders: [],
  selectedFolder: null,
  setAccount: (selectedAccountId) => {
    set({ selectedAccountId, selectedFolder: null, selectedThreadId: null, selectedMessageId: null, folders: [], view: "inbox", mobileStage: false, reachedEnd: false });
    if (selectedAccountId) {
      void get().loadFolders(selectedAccountId);
      void get().refreshFolders(selectedAccountId);
    }
  },
  loadFolders: async (accountId) => {
    const folders = await api.folders(accountId);
    if (get().selectedAccountId === accountId) set({ folders });
  },
  // Folder management (IMAP). Each mirrors the change locally then refreshes the
  // sidebar; rename/delete also reload the thread list (their mail moved/vanished).
  createFolder: async (accountId, name) => {
    await api.createFolder(accountId, name);
    await get().loadFolders(accountId);
  },
  renameFolder: async (accountId, from, to) => {
    await api.renameFolder(accountId, from, to);
    if (get().selectedFolder === from) set({ selectedFolder: to });
    await get().loadFolders(accountId);
    set({ threads: await api.listThreads() });
  },
  deleteFolder: async (accountId, name) => {
    await api.deleteFolder(accountId, name);
    if (get().selectedFolder === name) set({ selectedFolder: null });
    await get().loadFolders(accountId);
    set({ threads: await api.listThreads() });
  },
  liveSyncStarted: false,
  startLiveSync: async () => {
    if (get().liveSyncStarted) return;
    set({ liveSyncStarted: true });
    await listenMail({
      onSync: async () => {
        // New mail (or any server change) landed in the local store — refresh the
        // visible list and the folder counts without the user pressing Sync.
        set({ threads: await api.listThreads() });
        const acct = get().selectedAccountId;
        if (acct) void get().loadFolders(acct);
        // Auto-organize newly-arrived mail (summarize + triage). Incremental and
        // a no-op without a model, so it's cheap when nothing's new.
        if (get().autoOrganize) void get().triageInbox();
      },
      onNew: (count) => notifyNewMail(count),
    });
  },
  // Enumerate folders from the server (IMAP LIST), then refresh counts.
  // Sync a single folder on demand (without changing the current selection).
  syncOneFolder: async (accountId, folder) => {
    try { await api.syncFolder(accountId, folder, get().groupConversations); } catch { /* surfaced via counts */ }
    set({ threads: await api.listThreads() });
    if (get().selectedAccountId === accountId) await get().loadFolders(accountId);
  },
  // Mark every loaded thread in a folder as read (local now + best-effort \Seen).
  markFolderRead: async (accountId, folder) => {
    const targets = get().threads.filter((t) => t.accountId === accountId && t.folder === folder && t.unread);
    if (!targets.length) return;
    set({ threads: get().threads.map((t) => (t.accountId === accountId && t.folder === folder && t.unread ? { ...t, unread: false } : t)) });
    await Promise.all(targets.map((t) => api.setThreadRead(t.id, t.accountId, false).catch(() => {})));
    if (get().selectedAccountId === accountId) await get().loadFolders(accountId);
  },
  refreshFolders: async (accountId) => {
    await api.listFolders(accountId);
    await get().loadFolders(accountId);
  },
  setFolder: async (name) => {
    const acct = get().selectedAccountId;
    set({ selectedFolder: name, selectedThreadId: null, selectedMessageId: null, view: "inbox", mobileStage: false, reachedEnd: false });
    if (acct && name) {
      try {
        await api.syncFolder(acct, name, get().groupConversations);
      } catch {
        /* surfaced via folder counts / empty list */
      }
      set({ threads: await api.listThreads() });
      await get().loadFolders(acct);
    }
  },
  syncing: false,
  loadingOlder: false,
  reachedEnd: false,
  loadOlder: async () => {
    const { accounts, selectedFolder, groupConversations, loadingOlder, reachedEnd } = get();
    if (loadingOlder || reachedEnd || accounts.length === 0) return 0;
    set({ loadingOlder: true });
    const folder = selectedFolder || "INBOX";
    const PAGE = 75; // fetch one fixed page of OLDER mail per call (no re-download)
    let stored = 0;
    for (const a of accounts) {
      try { stored += await api.loadOlder(a.id, folder, PAGE, groupConversations); } catch { /* per-account; ignore non-IMAP */ }
    }
    // Nothing older came back across every account → we've hit the bottom.
    set({ threads: await api.listThreads(), loadingOlder: false, reachedEnd: stored === 0 });
    return stored;
  },

  syncAll: async () => {
    const accts = get().accounts;
    if (accts.length === 0 || get().syncing) return { total: 0, errors: [] };
    set({ syncing: true });
    let total = 0;
    const errors: string[] = [];
    for (const a of accts) {
      try {
        total += await api.syncNow(a.id, get().groupConversations);
      } catch (e) {
        errors.push(`${a.email}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const [threads, accounts] = await Promise.all([api.listThreads(), api.listAccounts()]);
    set({ threads, accounts, syncing: false });
    // Keep the focused account's folder list fresh on a global sync too.
    const focused = get().selectedAccountId;
    if (focused) void get().refreshFolders(focused);
    return { total, errors };
  },
  removeAccount: async (id) => {
    await api.removeAccount(id);
    const [threads, accounts] = await Promise.all([api.listThreads(), api.listAccounts()]);
    set({
      threads,
      accounts,
      selectedAccountId: get().selectedAccountId === id ? null : get().selectedAccountId,
    });
  },
  renameAccount: async (id, name) => {
    await api.renameAccount(id, name);
    set({ accounts: await api.listAccounts() });
  },
  load: async () => {
    // Hydrate durable UI settings from the core (source of truth), falling back
    // to the localStorage cache, then apply + mirror back so both stay in sync.
    try {
      const remote = await api.getSettings();
      const pick = (k: string) => remote[k] ?? (() => { try { return localStorage.getItem(`bharga.${k}`) ?? undefined; } catch { return undefined; } })();
      const theme: Theme = pick("theme") === "light" ? "light" : "dark";
      const dRaw = pick("density");
      const density: Density = dRaw === "compact" || dRaw === "comfy" ? dRaw : "cozy";
      const font = pick("font") ?? "inter";
      const locale = pick("locale") ?? "en";
      const groupConversations = (pick("group") ?? "1") !== "0";
      const highlights = (pick("highlights") ?? "1") !== "0";
      const autoOrganize = (pick("autoOrganize") ?? "1") !== "0";
      applyDoc(theme, density);
      applyFont(font);
      applyLocale(locale);
      persistPref("theme", theme);
      persistPref("density", density);
      persistPref("font", font);
      persistPref("locale", locale);
      persistPref("group", groupConversations ? "1" : "0");
      persistPref("highlights", highlights ? "1" : "0");
      persistPref("autoOrganize", autoOrganize ? "1" : "0");
      let flaggedIds: string[] = get().flaggedIds;
      try { flaggedIds = JSON.parse(pick("flaggedIds") || "[]"); } catch { /* keep */ }
      persistPref("flaggedIds", JSON.stringify(flaggedIds));
      const psw = parseInt(pick("panelSidebarW") || "", 10);
      const ptw = parseInt(pick("panelStreamW") || "", 10);
      const panelSidebarW = Number.isFinite(psw) ? Math.max(180, Math.min(380, psw)) : get().panelSidebarW;
      const panelStreamW = Number.isFinite(ptw) ? Math.max(280, Math.min(640, ptw)) : get().panelStreamW;
      persistPref("panelSidebarW", String(panelSidebarW));
      persistPref("panelStreamW", String(panelStreamW));
      const sidebarCollapsed = (pick("sidebarCollapsed") ?? "0") === "1";
      persistPref("sidebarCollapsed", sidebarCollapsed ? "1" : "0");
      let accountOrder: string[] = get().accountOrder;
      try { accountOrder = JSON.parse(pick("accountOrder") || "[]"); } catch { /* keep */ }
      persistPref("accountOrder", JSON.stringify(accountOrder));
      let pinnedFolders: string[] = get().pinnedFolders;
      try { pinnedFolders = JSON.parse(pick("pinnedFolders") || "[]"); } catch { /* keep */ }
      persistPref("pinnedFolders", JSON.stringify(pinnedFolders));
      set({ theme, density, font, locale, groupConversations, highlights, autoOrganize, flaggedIds, panelSidebarW, panelStreamW, sidebarCollapsed, accountOrder, pinnedFolders });

      // Signatures: DB is the source of truth; fall back to the local cache.
      if (remote["signatures"]) {
        try {
          const sigs: Signature[] = JSON.parse(remote["signatures"]);
          const def = remote["signature_default"] || null;
          persistSignatures(sigs, def);
          set({ signatures: sigs, defaultSignatureId: def && sigs.some((s) => s.id === def) ? def : sigs[0]?.id ?? null });
        } catch { /* ignore malformed */ }
      } else if (get().signatures.length > 0) {
        // migrate existing local signatures into the DB
        persistSignatures(get().signatures, get().defaultSignatureId);
      }
    } catch {
      /* keep module-load defaults */
    }

    const [threads, tasks, ai, accounts, serverFlagged] = await Promise.all([
      api.listThreads(),
      api.listTasks(),
      api.getAiProfile(),
      api.listAccounts(),
      api.flaggedIds(),
    ]);
    // Union server-synced flags (\Flagged) with any optimistic local flags.
    const mergedFlags = Array.from(new Set([...get().flaggedIds, ...serverFlagged]));
    persistPref("flaggedIds", JSON.stringify(mergedFlags));
    set({ threads, tasks, ai, accounts, flaggedIds: mergedFlags, loaded: true });
    // Organize anything that arrived while away (no-op without a model configured).
    if (get().autoOrganize) void get().triageInbox();
  },
  toggleTask: (id) => {
    const next = get().tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
    set({ tasks: next });
    const t = next.find((x) => x.id === id);
    if (t) void api.setTaskDone(id, t.done);
  },
  assignRole: (modelId, role) => {
    const ai = get().ai;
    if (!ai) return;
    const models = ai.models.map((m) => ({
      ...m,
      roles: m.id === modelId ? Array.from(new Set([...m.roles, role])) : m.roles.filter((r) => r !== role),
    }));
    set({ ai: { ...ai, models } });
  },
  setPrivacy: (privacy) => {
    const ai = get().ai;
    if (ai) set({ ai: { ...ai, privacy } });
  },
  updateModel: (modelId, patch) => {
    const ai = get().ai;
    if (!ai) return;
    const models = ai.models.map((m) => {
      if (m.id !== modelId) return m;
      const next = { ...m, ...patch };
      // a model is "ready" once it has credentials (cloud) or an endpoint (local/custom)
      next.ready = next.kind === "local" ? !!next.endpoint : next.ready;
      return next;
    });
    set({ ai: { ...ai, models } });
  },
  addModel: () => {
    const ai = get().ai;
    if (!ai) return;
    const n = ai.models.filter((model) => model.kind === "openai-compatible" || model.kind === "custom").length + 1;
    const model: AiModel = {
      id: crypto.randomUUID(),
      label: `Custom provider ${n}`,
      kind: "openai-compatible",
      roles: [],
      ready: false,
    };
    set({ ai: { ...ai, models: [...ai.models, model] } });
  },
  saveModel: async (input) => {
    const ai = await api.saveAiProvider(input);
    set({ ai });
  },
  removeModel: async (id) => {
    await api.removeAiProvider(id);
    const ai = get().ai;
    if (!ai) return;
    set({ ai: { ...ai, models: ai.models.filter((model) => model.id !== id) } });
  },
  saveAi: async () => {
    const ai = get().ai;
    if (ai) await api.setAiProfile(ai);
  },
  connectGmail: async () => {
    const accountId = await api.connectGmail(); // throws in browser preview
    set({ threads: await api.listThreads() });
    return accountId;
  },
  connectMicrosoft: async () => {
    const accountId = await api.connectMicrosoft();
    set({ threads: await api.listThreads() });
    return accountId;
  },
  createTask: async (title, sourceThreadId) => {
    // optimistic add (also shows in browser preview), then persist to the core
    const t: Task = { id: `k-${Date.now()}`, title, done: false, sourceThreadId };
    set({ tasks: [...get().tasks, t] });
    await api.createTask(title, sourceThreadId);
  },

  undo: null,
  ...(() => {
    const { signatures, defaultId } = loadSignatures();
    return { signatures, defaultSignatureId: defaultId };
  })(),
  addSignature: (name, html) => {
    const sig: Signature = { id: `sig-${Date.now()}`, name: name || "Untitled", html };
    const signatures = [...get().signatures, sig];
    const defaultSignatureId = get().defaultSignatureId ?? sig.id;
    persistSignatures(signatures, defaultSignatureId);
    set({ signatures, defaultSignatureId });
    return sig.id;
  },
  updateSignature: (id, patch) => {
    const signatures = get().signatures.map((s) => (s.id === id ? { ...s, ...patch } : s));
    persistSignatures(signatures, get().defaultSignatureId);
    set({ signatures });
  },
  deleteSignature: (id) => {
    const signatures = get().signatures.filter((s) => s.id !== id);
    let defaultSignatureId = get().defaultSignatureId;
    if (defaultSignatureId === id) defaultSignatureId = signatures[0]?.id ?? null;
    persistSignatures(signatures, defaultSignatureId);
    set({ signatures, defaultSignatureId });
  },
  setDefaultSignature: (id) => {
    persistSignatures(get().signatures, id);
    set({ defaultSignatureId: id });
  },
  font: loadFont(),
  locale: loadLocale(),
  setFont: (font) => { applyFont(font); persistPref("font", font); set({ font }); },
  setLocale: (locale) => { applyLocale(locale); persistPref("locale", locale); set({ locale }); },
  groupConversations: (() => { try { return localStorage.getItem("bharga.group") !== "0"; } catch { return true; } })(),
  setGroupConversations: (v) => { persistPref("group", v ? "1" : "0"); set({ groupConversations: v }); },
  highlights: (() => { try { return localStorage.getItem("bharga.highlights") !== "0"; } catch { return true; } })(),
  setHighlights: (v) => { persistPref("highlights", v ? "1" : "0"); set({ highlights: v }); },
  contentPx: (() => { try { const n = parseFloat(localStorage.getItem("bharga.contentPx") ?? ""); return Number.isFinite(n) && n >= 12 && n <= 22 ? n : 14.5; } catch { return 14.5; } })(),
  setContentPx: (v) => { const px = Math.min(22, Math.max(12, v)); persistPref("contentPx", String(px)); set({ contentPx: px }); },
  autoOrganize: (() => { try { return localStorage.getItem("bharga.autoOrganize") !== "0"; } catch { return true; } })(),
  setAutoOrganize: (v) => { persistPref("autoOrganize", v ? "1" : "0"); set({ autoOrganize: v }); },
  panelSidebarW: (() => { try { const v = parseInt(localStorage.getItem("bharga.panelSidebarW") || "", 10); return Number.isFinite(v) ? v : 234; } catch { return 234; } })(),
  panelStreamW: (() => { try { const v = parseInt(localStorage.getItem("bharga.panelStreamW") || "", 10); return Number.isFinite(v) ? v : 360; } catch { return 360; } })(),
  setPanelWidths: (sidebar, stream, persist = false) => {
    const s = Math.max(180, Math.min(380, Math.round(sidebar)));
    const st = Math.max(280, Math.min(640, Math.round(stream)));
    set({ panelSidebarW: s, panelStreamW: st });
    if (persist) { persistPref("panelSidebarW", String(s)); persistPref("panelStreamW", String(st)); }
  },
  sidebarCollapsed: (() => { try { return localStorage.getItem("bharga.sidebarCollapsed") === "1"; } catch { return false; } })(),
  toggleSidebar: () => { const v = !get().sidebarCollapsed; persistPref("sidebarCollapsed", v ? "1" : "0"); set({ sidebarCollapsed: v }); },
  triaging: false,
  flaggedIds: (() => { try { return JSON.parse(localStorage.getItem("bharga.flaggedIds") || "[]") as string[]; } catch { return []; } })(),
  toggleFlag: (id) => {
    const cur = get().flaggedIds;
    const flagged = !cur.includes(id);
    const next = flagged ? [...cur, id] : cur.filter((x) => x !== id);
    persistPref("flaggedIds", JSON.stringify(next));
    set({ flaggedIds: next });
    // Push to the server (best-effort) so the star round-trips with other clients.
    const accountId = get().threads.find((t) => t.id === id)?.accountId;
    if (accountId) void api.flagThread(id, accountId, flagged);
  },
  accountOrder: (() => { try { return JSON.parse(localStorage.getItem("bharga.accountOrder") || "[]") as string[]; } catch { return []; } })(),
  setAccountOrder: (ids) => { persistPref("accountOrder", JSON.stringify(ids)); set({ accountOrder: ids }); },
  pinnedFolders: (() => { try { return JSON.parse(localStorage.getItem("bharga.pinnedFolders") || "[]") as string[]; } catch { return []; } })(),
  togglePinFolder: (accountId, folder) => {
    const key = `${accountId}${folder}`;
    const cur = get().pinnedFolders;
    const next = cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key];
    persistPref("pinnedFolders", JSON.stringify(next));
    set({ pinnedFolders: next });
  },
  snoozeThread: (id) => {
    set({
      threads: get().threads.map((t) =>
        t.id === id ? { ...t, view: Array.from(new Set([...t.view.filter((v) => v !== "priority" && v !== "inbox"), "snoozed"])) } : t
      ),
      mobileStage: false,
    });
    void api.snoozeThread(id);
  },
  archiveThread: (id) => {
    const t = get().threads.find((x) => x.id === id);
    set({ threads: get().threads.map((x) => (x.id === id ? { ...x, view: [] } : x)), mobileStage: false });
    if (t) void api.archiveThread(id, t.accountId);
  },
  toggleRead: (id) => {
    const t = get().threads.find((x) => x.id === id);
    const nextUnread = t ? !t.unread : false;
    set({ threads: get().threads.map((x) => (x.id === id ? { ...x, unread: nextUnread } : x)) });
    if (t) void api.setThreadRead(id, t.accountId, nextUnread);
  },
  deleteThread: (id) => {
    const t = get().threads.find((x) => x.id === id);
    set({
      threads: get().threads.filter((x) => x.id !== id),
      selectedThreadId: get().selectedThreadId === id ? null : get().selectedThreadId,
      mobileStage: false,
    });
    if (t) void api.deleteThread(id, t.accountId);
  },
  moveThread: (id, toFolder) => {
    const t = get().threads.find((x) => x.id === id);
    // Move = leave the current view now (like archive); the destination folder
    // shows it again on its next sync. Removing (not relabelling) avoids a stale
    // duplicate once the moved copy syncs back under a new folder-scoped id.
    set({
      threads: get().threads.filter((x) => x.id !== id),
      selectedThreadId: get().selectedThreadId === id ? null : get().selectedThreadId,
      mobileStage: false,
    });
    if (t) void api.moveThread(id, t.accountId, toFolder);
  },
  markSpam: (id) => {
    const t = get().threads.find((x) => x.id === id);
    set({
      threads: get().threads.filter((x) => x.id !== id),
      selectedThreadId: get().selectedThreadId === id ? null : get().selectedThreadId,
      mobileStage: false,
    });
    if (t) void api.markSpam(id, t.accountId);
  },
  triageInbox: async () => {
    if (get().triaging) return 0; // never run two passes at once
    set({ triaging: true });
    try {
      const n = await api.triageInbox();
      if (n > 0) set({ threads: await api.listThreads() });
      return n;
    } finally {
      set({ triaging: false });
    }
  },
  queueSend: async ({ to, cc, bcc, subject, body, threadId, accountId: fromId, attachments, sendAt }) => {
    const def = get().signatures.find((s) => s.id === get().defaultSignatureId);
    const fullBody = def?.html ? `${body}<br><br>--<br>${def.html}` : body;
    // Route from the right account: an explicit From (Compose picker) wins, else a
    // reply uses the thread's account, else the focused / first connected one.
    const thread = threadId ? get().threads.find((t) => t.id === threadId) : null;
    const accountId =
      fromId ?? thread?.accountId ?? get().selectedAccountId ?? get().accounts[0]?.id ?? activeAccountId;
    const scheduled = typeof sendAt === "number" && sendAt * 1000 > Date.now();
    const id = await api.queueSend({
      accountId,
      threadId,
      to,
      cc,
      bcc,
      subject,
      body: fullBody,
      attachments,
      delaySeconds: SEND.undoWindowSeconds,
      sendAt: scheduled ? sendAt : undefined,
    });
    const label = scheduled
      ? `Scheduled for ${dayjs((sendAt as number) * 1000).format("ddd, MMM D · HH:mm")}`
      : `Sending to ${to || "recipient"}…`;
    set({ undo: { id, label } });
    // Keep the cancel toast visible long enough to undo. Scheduled sends get a
    // longer window since there's no rush; immediate sends use the undo window.
    const visibleMs = (scheduled ? 8 : SEND.undoWindowSeconds) * 1000;
    setTimeout(() => {
      if (get().undo?.id === id) set({ undo: null });
    }, visibleMs);
  },
  cancelUndo: () => {
    const u = get().undo;
    if (u) void api.cancelSend(u.id);
    set({ undo: null });
  },
}));
