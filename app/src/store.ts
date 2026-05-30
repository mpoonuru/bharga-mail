import { create } from "zustand";
import type { View, Thread, Task, AiProfile, AiRole, AiModel, Account } from "@/types";
import { api } from "@/lib/bridge";
import { account } from "@/data/mock";
import { SEND } from "@/config";
import { loadFont, applyFont, loadLocale, applyLocale } from "@/lib/prefs";

/** The account messages are sent from. Derived, never hardcoded at call sites. */
const activeAccountId = `${account.provider === "imap" ? "gmail" : account.provider}:${account.email}`;

type Theme = "dark" | "light";
type Density = "compact" | "cozy" | "comfy";

interface AppState {
  // navigation
  view: View;
  selectedThreadId: string | null;
  setView: (v: View) => void;
  selectThread: (id: string) => void;

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
  syncing: boolean;
  syncAll: () => Promise<{ total: number; errors: string[] }>;
  removeAccount: (id: string) => Promise<void>;
  load: () => Promise<void>;
  toggleTask: (id: string) => void;
  assignRole: (modelId: string, role: AiRole) => void;
  setPrivacy: (p: AiProfile["privacy"]) => void;
  updateModel: (modelId: string, patch: Partial<AiModel>) => void;
  addModel: () => void;
  saveAi: () => Promise<void>;
  connectGmail: () => Promise<string>;
  connectMicrosoft: () => Promise<string>;
  createTask: (title: string, sourceThreadId?: string) => Promise<void>;

  // Undo Send
  undo: { id: string; label: string } | null;
  queueSend: (args: {
    to: string;
    subject: string;
    body: string;
    threadId?: string;
    attachments?: { name: string; mime: string; dataB64: string }[];
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

  // Thread actions
  snoozeThread: (id: string) => void;
  archiveThread: (id: string) => void;
  toggleRead: (id: string) => void;
  deleteThread: (id: string) => void;
  triageInbox: () => Promise<number>;
}

export interface Signature {
  id: string;
  name: string;
  html: string;
}

const SIG_KEY = "aether.signature"; // legacy plain-text key (migrated)
const SIGS_KEY = "aether.signatures";
const SIG_DEFAULT_KEY = "aether.signature.default";

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
}

function applyDoc(theme: Theme, density: Density) {
  const el = document.documentElement;
  el.setAttribute("data-theme", theme);
  el.setAttribute("data-density", density);
}

export const useApp = create<AppState>((set, get) => ({
  view: "priority",
  selectedThreadId: "t1",
  setView: (v) => set({ view: v, composeOpen: false, drawerOpen: false, mobileStage: false }),
  selectThread: (id) => set({ selectedThreadId: id, mobileStage: true }),

  theme: "dark",
  density: "cozy",
  focusMode: false,
  cmdOpen: false,
  modelPickerOpen: false,
  composeOpen: false,
  mobileStage: false,
  drawerOpen: false,
  toggleTheme: () => {
    const theme = get().theme === "dark" ? "light" : "dark";
    applyDoc(theme, get().density);
    set({ theme });
  },
  setDensity: (density) => {
    applyDoc(get().theme, density);
    set({ density });
  },
  toggleFocus: () => set({ focusMode: !get().focusMode }),
  setCmd: (cmdOpen) => set({ cmdOpen }),
  setModelPicker: (modelPickerOpen) => set({ modelPickerOpen }),
  setCompose: (composeOpen) => set({ composeOpen }),
  aiReplyFor: null,
  requestAiReply: (id) => set({ aiReplyFor: id, selectedThreadId: id, mobileStage: true }),
  clearAiReply: () => set({ aiReplyFor: null }),
  setDrawer: (drawerOpen) => set({ drawerOpen }),
  backToStream: () => set({ mobileStage: false, composeOpen: false }),

  threads: [],
  tasks: [],
  ai: null,
  loaded: false,
  accounts: [],
  selectedAccountId: null,
  setAccount: (selectedAccountId) => set({ selectedAccountId, view: "inbox", mobileStage: false }),
  syncing: false,
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
  load: async () => {
    const [threads, tasks, ai, accounts] = await Promise.all([
      api.listThreads(),
      api.listTasks(),
      api.getAiProfile(),
      api.listAccounts(),
    ]);
    set({ threads, tasks, ai, accounts, loaded: true });
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
      const needsKey = next.kind === "anthropic" || next.kind === "openai-compatible" || next.kind === "google";
      next.ready = needsKey ? !!next.apiKey : !!next.endpoint;
      return next;
    });
    set({ ai: { ...ai, models } });
  },
  addModel: () => {
    const ai = get().ai;
    if (!ai) return;
    const n = ai.models.filter((m) => m.id.startsWith("custom-")).length + 1;
    const model: AiModel = {
      id: `custom-${Date.now()}`,
      label: `Custom provider ${n}`,
      kind: "openai-compatible",
      roles: [],
      ready: false,
    };
    set({ ai: { ...ai, models: [...ai.models, model] } });
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
  setFont: (font) => { applyFont(font); set({ font }); },
  setLocale: (locale) => { applyLocale(locale); set({ locale }); },
  groupConversations: (() => { try { return localStorage.getItem("aether.group") !== "0"; } catch { return true; } })(),
  setGroupConversations: (v) => { try { localStorage.setItem("aether.group", v ? "1" : "0"); } catch { /* ignore */ } set({ groupConversations: v }); },
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
  triageInbox: async () => {
    const n = await api.triageInbox();
    if (n > 0) set({ threads: await api.listThreads() });
    return n;
  },
  queueSend: async ({ to, subject, body, threadId, attachments }) => {
    const def = get().signatures.find((s) => s.id === get().defaultSignatureId);
    const fullBody = def?.html ? `${body}<br><br>--<br>${def.html}` : body;
    // Route from the right account: a reply uses the thread's account; a new
    // message uses the focused account (or the only/first connected one).
    const thread = threadId ? get().threads.find((t) => t.id === threadId) : null;
    const accountId =
      thread?.accountId ?? get().selectedAccountId ?? get().accounts[0]?.id ?? activeAccountId;
    const id = await api.queueSend({
      accountId,
      threadId,
      to,
      subject,
      body: fullBody,
      attachments,
      delaySeconds: SEND.undoWindowSeconds,
    });
    set({ undo: { id, label: `Sending to ${to || "recipient"}…` } });
    // auto-dismiss the toast after the window; the core flushes it.
    setTimeout(() => {
      if (get().undo?.id === id) set({ undo: null });
    }, SEND.undoWindowSeconds * 1000);
  },
  cancelUndo: () => {
    const u = get().undo;
    if (u) void api.cancelSend(u.id);
    set({ undo: null });
  },
}));
