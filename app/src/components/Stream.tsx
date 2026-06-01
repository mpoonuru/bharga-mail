import { useState, useRef, useEffect } from "react";
import { motion } from "motion/react";
import dayjs from "dayjs";
import { useApp } from "@/store";
import type { Thread, View } from "@/types";
import { Tag } from "@/components/ui/Tag";
import { Icon } from "@/components/icons";
import { shortTime } from "@/lib/date";
import { avatarColor } from "@/lib/colors";
import { initials, senderLabel } from "@/lib/avatar";
import { titlebarDoubleClick } from "@/lib/bridge";
import { highlightInline } from "@/lib/highlightInline";
import { deriveChips } from "@/lib/smartChips";
import { SmartChips } from "@/components/ui/SmartChips";
import { senderTrust } from "@/lib/senderTrust";
import { threadThreat } from "@/lib/threat";

const TITLES: Record<string, string> = {
  priority: "Priority",
  inbox: "All Inbox",
  flagged: "Flagged",
  snoozed: "Snoozed",
  awaiting: "Awaiting reply",
  newsletters: "Newsletters",
  receipts: "Receipts",
};

type SortMode = "newest" | "sender" | "unread";
const SORT_LABEL: Record<SortMode, string> = { newest: "Newest", sender: "Sender", unread: "Unread" };
const NEXT: Record<SortMode, SortMode> = { newest: "sender", sender: "unread", unread: "newest" };

// Date bucket for the grouped (accordion) view — Outlook-style sections.
function dateBucket(t: Thread, now: dayjs.Dayjs): string {
  const d = dayjs(t.lastTime);
  if (!d.isValid()) return "Earlier";
  if (d.isSame(now, "day")) return "Today";
  if (d.isSame(now.subtract(1, "day"), "day")) return "Yesterday";
  if (d.isAfter(now.startOf("week"))) return "This week";
  if (d.isAfter(now.subtract(1, "week").startOf("week"))) return "Last week";
  if (d.isSame(now, "month")) return "This month";
  if (d.isSame(now, "year")) return d.format("MMMM");
  return d.format("MMMM YYYY");
}

function labelTag(t: Thread) {
  if (t.labels.includes("urgent")) return <Tag variant="urgent">Urgent</Tag>;
  if (t.labels.includes("meeting")) return <Tag variant="cal">Meeting</Tag>;
  return null;
}

function sortThreads(list: Thread[], mode: SortMode): Thread[] {
  const arr = [...list];
  if (mode === "sender") {
    arr.sort((a, b) => (a.participants[0] ?? "").localeCompare(b.participants[0] ?? ""));
  } else if (mode === "unread") {
    arr.sort((a, b) => Number(b.unread) - Number(a.unread));
  } else {
    arr.sort((a, b) => {
      const da = dayjs(a.lastTime);
      const db = dayjs(b.lastTime);
      if (da.isValid() && db.isValid()) return db.valueOf() - da.valueOf();
      return 0;
    });
  }
  return arr;
}

export function Stream() {
  const { view, threads, accounts, selectedThreadId, selectThread, triageInbox, setView, archiveThread, snoozeThread, toggleRead, deleteThread, moveThread, markSpam, flaggedIds, toggleFlag, requestCompose, requestAiReply, createTask, folders, selectedAccountId, selectedFolder, syncing, syncAll } = useApp();
  // When viewing all accounts together, show which mailbox each thread is from.
  const acctEmail: Record<string, string> = Object.fromEntries(accounts.map((a) => [a.id, a.email]));
  const copyText = (s: string) => { try { void navigator.clipboard.writeText(s); } catch { /* ignore */ } };
  const [sorting, setSorting] = useState(false);
  const [sortMsg, setSortMsg] = useState("");
  const [syncMsg, setSyncMsg] = useState("");
  const [ctx, setCtx] = useState<{ x: number; y: number; t: Thread } | null>(null);
  const [ctxSub, setCtxSub] = useState<null | "move">(null);
  // Reset the scroll to the top when the view/folder/account changes, so you
  // never land mid-scroll on a half-clipped row.
  const listRef = useRef<HTMLDivElement>(null);
  // Smart-chip filters are scoped to the current view — reset the selection (and
  // scroll) whenever the view/folder/account changes.
  const [activeChips, setActiveChips] = useState<Set<string>>(new Set());
  useEffect(() => { listRef.current?.scrollTo({ top: 0 }); setActiveChips(new Set()); }, [view, selectedFolder, selectedAccountId]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (label: string) => setCollapsedGroups((s) => { const n = new Set(s); if (n.has(label)) n.delete(label); else n.add(label); return n; });

  const doSync = async () => {
    if (syncing) return;
    setSyncMsg("");
    const { total, errors } = await syncAll();
    setSyncMsg(errors.length ? `Sync failed: ${errors[0]}` : `Synced ${total} message${total === 1 ? "" : "s"}`);
    setTimeout(() => setSyncMsg(""), 4000);
  };
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [q, setQ] = useState("");

  // Scope to the focused account, then to the chosen folder (if any), then view.
  const scoped = threads
    .filter((t) => !selectedAccountId || t.accountId === selectedAccountId)
    .filter((t) => !selectedFolder || t.folder === selectedFolder);
  // A selected folder shows all of its mail; otherwise apply the smart-view filter.
  // Priority has a fallback so it's never an empty dead-end: if AI triage hasn't
  // tagged anything yet, fall back to unread/urgent mail, then to recent.
  const aiPriority = scoped.filter((t) => t.view.includes("priority"));
  const priorityFallback = view === "priority" && !selectedFolder && aiPriority.length === 0 && scoped.length > 0;
  let inView: Thread[];
  if (selectedFolder) {
    inView = scoped;
  } else if (view === "flagged") {
    inView = scoped.filter((t) => flaggedIds.includes(t.id));
  } else if (view === "priority") {
    if (aiPriority.length > 0) inView = aiPriority;
    else {
      const heur = scoped.filter((t) => t.unread || t.labels.includes("urgent"));
      inView = heur.length > 0 ? heur : scoped;
    }
  } else {
    inView = scoped.filter((t) => t.view.includes(view as View));
  }
  // Smart chips — emergent, multi-label filters derived from the threads in view.
  const selfDomain = (selectedAccountId ? accounts.find((a) => a.id === selectedAccountId)?.email : accounts[0]?.email)?.split("@")[1];
  const chips = deriveChips(inView, selfDomain);
  // Drop any selection that no longer exists in the current chip set.
  const liveChips = new Set([...activeChips].filter((id) => chips.some((c) => c.id === id)));
  const chipScoped = liveChips.size
    ? inView.filter((t) => chips.some((c) => liveChips.has(c.id) && c.test(t)))
    : inView;
  const toggleChip = (id: string) => setActiveChips((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const query = q.trim().toLowerCase();
  const filtered = query
    ? scoped.filter((t) => [t.subject, t.preview, t.participants.join(" ")].join(" ").toLowerCase().includes(query))
    : chipScoped;
  const list = sortThreads(filtered, sortMode);
  // Date-grouped accordion sections, but only when sorting by date (Newest) and
  // not searching — grouping by date is meaningless under sender/unread sort.
  const grouped = sortMode === "newest" && !query;
  const now = dayjs();
  const groups: { label: string; items: Thread[] }[] = [];
  if (grouped) {
    for (const t of list) {
      const label = dateBucket(t, now);
      const tail = groups[groups.length - 1];
      if (tail && tail.label === label) tail.items.push(t);
      else groups.push({ label, items: [t] });
    }
  }

  const sort = async () => {
    if (sorting) return;
    setSorting(true);
    setSortMsg("");
    try {
      const n = await triageInbox();
      setSortMsg(n > 0 ? `Sorted ${n} thread${n === 1 ? "" : "s"}` : "Assign models in Settings");
    } finally {
      setSorting(false);
      setTimeout(() => setSortMsg(""), 2500);
    }
  };

  return (
    <section className="stream">
      <div className="stream-head" data-tauri-drag-region onDoubleClick={titlebarDoubleClick}>
        <h2>{TITLES[view] ?? "Inbox"}</h2>
        <div className="head-actions">
          <button className="filter" onClick={doSync} disabled={syncing} title="Sync all accounts" style={{ opacity: syncing ? 0.7 : 1 }}>
            <Icon name="cloud" size={12} weight="duotone" /> {syncing ? "Syncing…" : "Sync"}
          </button>
          <button className="filter" onClick={() => setSortMode(NEXT[sortMode])} title="Sort order">
            <Icon name="snoozed" size={12} weight="duotone" /> {SORT_LABEL[sortMode]}
          </button>
          <button className="filter" onClick={sort} disabled={sorting} title="Summarize + prioritize with AI" style={{ opacity: sorting ? 0.7 : 1 }}>
            <Icon name="ai" size={12} weight="duotone" /> {sorting ? "Sorting…" : "AI sort"}
          </button>
        </div>
      </div>
      {(syncMsg || sortMsg) && (
        <div className={`stream-status${syncMsg && /fail/i.test(syncMsg) ? " err" : ""}`} title={syncMsg || sortMsg}>
          {syncMsg || sortMsg}
        </div>
      )}
      <div className="search-box">
        <Icon name="search" size={15} weight="duotone" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search mail…" />
        {q && <button className="search-clear" onClick={() => setQ("")} title="Clear"><Icon name="close" size={13} /></button>}
      </div>
      {!query && <SmartChips chips={chips} active={liveChips} onToggle={toggleChip} onClear={() => setActiveChips(new Set())} />}
      {priorityFallback && !query && (
        <div className="priority-hint">
          <Icon name="ai" size={12} weight="duotone" /> <span>Not AI-sorted yet — showing unread &amp; urgent.</span>
        </div>
      )}
      <div className="list" ref={listRef}>
        {list.length === 0 && (
          query ? (
            <div className="empty">No results for “{q}”</div>
          ) : threads.length === 0 ? (
            <div className="empty">
              <p style={{ marginBottom: 12 }}>No mail yet.</p>
              <button className="send" onClick={() => setView("settings")}>Connect an account</button>
            </div>
          ) : (
            <div className="empty">Nothing here. Inbox zero. ✦</div>
          )
        )}
        {(() => {
          const renderRow = (t: Thread, i: number) => (
            <MailRow
              key={t.id}
              t={t}
              index={i}
              selected={selectedThreadId === t.id}
              onOpen={() => selectThread(t.id)}
              onArchive={() => archiveThread(t.id)}
              onSnooze={() => snoozeThread(t.id)}
              mailbox={!selectedAccountId ? acctEmail[t.accountId] : undefined}
              flagged={flaggedIds.includes(t.id)}
              quiet={!!query}
              onContext={(x, y) => setCtx({ x: Math.max(8, Math.min(x, window.innerWidth - 224)), y: Math.max(8, Math.min(y, window.innerHeight - 580)), t })}
            />
          );
          if (!grouped) return list.map((t, i) => renderRow(t, i));
          return groups.map((g) => {
            const open = !collapsedGroups.has(g.label);
            return (
              <div key={g.label} className="date-group">
                <button className="date-head" onClick={() => toggleGroup(g.label)}>
                  <Icon name={open ? "caretDown" : "caretRight"} size={12} weight="bold" />
                  <span>{g.label}</span>
                  <span className="date-count">{g.items.length}</span>
                </button>
                {open && g.items.map((t, i) => renderRow(t, i))}
              </div>
            );
          });
        })()}
      </div>

      {ctx && (() => {
        const t = ctx.t;
        const close = () => { setCtx(null); setCtxSub(null); };
        const run = (fn: () => void) => () => { fn(); close(); };
        const senderEmail = t.messages?.[0]?.from?.address ?? t.participants[0] ?? "";
        // Move targets: this account's real folders, minus the one it's already in.
        const moveTargets = folders.filter((f) => f.name !== t.folder);
        return (
          <>
            <div className="ctx-backdrop" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
            <div className="ctx-menu" style={{ left: ctx.x, top: ctx.y }} role="menu">
              {ctxSub === "move" ? (
                <>
                  <button role="menuitem" className="ctx-back" onClick={() => setCtxSub(null)}><Icon name="reply" size={13} /> Move to folder</button>
                  <div className="ctx-sep" />
                  {moveTargets.length === 0 && <div className="ctx-empty">No other folders</div>}
                  {moveTargets.map((f) => (
                    <button key={f.name} role="menuitem" onClick={run(() => moveThread(t.id, f.name))}>
                      <Icon name="folder" size={14} /> {f.name}
                    </button>
                  ))}
                </>
              ) : (
                <>
                  <button role="menuitem" onClick={run(() => selectThread(t.id))}><Icon name="inbox" size={14} /> Open</button>
                  <div className="ctx-sep" />
                  <button role="menuitem" onClick={run(() => requestCompose(t.id, "reply"))}><Icon name="reply" size={14} /> Reply</button>
                  <button role="menuitem" onClick={run(() => requestCompose(t.id, "replyAll"))}><Icon name="replyAll" size={14} /> Reply all</button>
                  <button role="menuitem" onClick={run(() => requestCompose(t.id, "forward"))}><Icon name="forward" size={14} /> Forward</button>
                  <button role="menuitem" onClick={run(() => requestAiReply(t.id))}><Icon name="ai" size={14} weight="duotone" /> Draft reply with AI</button>
                  <div className="ctx-sep" />
                  <button role="menuitem" onClick={run(() => toggleRead(t.id))}>
                    <Icon name={t.unread ? "envelopeOpen" : "envelope"} size={14} /> Mark as {t.unread ? "read" : "unread"}
                  </button>
                  <button role="menuitem" onClick={run(() => toggleFlag(t.id))}><Icon name="priority" size={14} weight={flaggedIds.includes(t.id) ? "fill" : "regular"} /> {flaggedIds.includes(t.id) ? "Unflag" : "Flag"}</button>
                  <button role="menuitem" onClick={run(() => archiveThread(t.id))}><Icon name="archive" size={14} weight="duotone" /> Archive</button>
                  <button role="menuitem" onClick={run(() => snoozeThread(t.id))}><Icon name="snoozed" size={14} /> Snooze</button>
                  {moveTargets.length > 0 && (
                    <button role="menuitem" className="ctx-submenu" onClick={() => setCtxSub("move")}><Icon name="folder" size={14} /> Move to folder<span className="ctx-caret">›</span></button>
                  )}
                  <button role="menuitem" onClick={run(() => createTask(`Follow up: ${t.subject}`, t.id))}><Icon name="tasks" size={14} /> Turn into task</button>
                  <div className="ctx-sep" />
                  <button role="menuitem" onClick={run(() => copyText(senderEmail))}><Icon name="copy" size={14} /> Copy sender email</button>
                  <button role="menuitem" onClick={run(() => copyText(t.subject))}><Icon name="copy" size={14} /> Copy subject</button>
                  <div className="ctx-sep" />
                  <button role="menuitem" onClick={run(() => markSpam(t.id))}><Icon name="flag" size={14} /> Report spam</button>
                  <button role="menuitem" className="danger" onClick={run(() => deleteThread(t.id))}><Icon name="trash" size={14} /> Delete</button>
                </>
              )}
            </div>
          </>
        );
      })()}
    </section>
  );
}

function MailRow({
  t, index, selected, onOpen, onArchive, onSnooze, onContext, mailbox, flagged, quiet,
}: {
  t: Thread; index: number; selected: boolean; onOpen: () => void; onArchive: () => void; onSnooze: () => void; onContext: (x: number, y: number) => void; mailbox?: string; flagged?: boolean; quiet?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const last = t.messages[t.messages.length - 1];
  const senderName = t.participants[0] || last?.from.name || last?.from.address || "";
  const senderSeed = last?.from.address || senderName;
  const avPaint = avatarColor(senderSeed);
  const trust = senderTrust(last?.meta?.auth);
  // Escalate to red "Likely phishing" when failed auth + a deceptive link coincide.
  const threat = threadThreat(t);
  const shield = threat.level === "phishing"
    ? { show: true, tone: "bad", icon: "shieldWarning" as const, label: "Likely phishing", detail: threat.reason }
    : { show: trust.level !== "unknown", tone: trust.tone, icon: trust.icon, label: trust.label, detail: trust.detail };
  const hasAttachments = t.messages?.some((m) => m.attachments && m.attachments.length > 0) ?? false;
  return (
    <div className="mail-wrap">
      {/* swipe-action background — only rendered while actually dragging */}
      {dragging && (
        <div className="swipe-bg">
          <span className="swipe-left"><Icon name="snoozed" size={16} weight="duotone" /> Snooze</span>
          <span className="swipe-right">Archive <Icon name="awaiting" size={16} weight="duotone" /></span>
        </div>
      )}
      <motion.div
        className={`mail${t.unread ? " unread" : ""}${selected ? " sel" : ""}`}
        onClick={onOpen}
        onContextMenu={(e) => { e.preventDefault(); onContext(e.clientX, e.clientY); }}
        drag="x"
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.5}
        onDragStart={() => setDragging(true)}
        onDragEnd={(_e, info) => {
          setDragging(false);
          if (info.offset.x <= -90) onArchive();
          else if (info.offset.x >= 90) onSnooze();
        }}
        initial={quiet ? { opacity: 0 } : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={quiet ? { duration: 0.13, ease: "easeOut" } : { delay: Math.min(index * 0.035, 0.3), ease: [0.2, 0.8, 0.2, 1] }}
      >
        <div className="mail-av" style={{ background: avPaint.bg, color: avPaint.fg, boxShadow: `0 0 0 1.5px ${avPaint.ring}` }} aria-hidden>{initials(senderName)}</div>
        <div className="mail-main">
          <div className="mail-l1">
            {t.unread && <span className="mail-unread" aria-label="Unread" />}
            <span className="from">{t.participants.map((p) => (p.includes("@") && !p.includes(" ") ? senderLabel(undefined, p) : p)).join(", ")}</span>
            <span className="time">
              {shield.show && (
                <span className={`mail-trust trust-${shield.tone}`} title={`${shield.label} — ${shield.detail}`} aria-label={shield.label}>
                  <Icon name={shield.icon} size={15} weight="duotone" />
                </span>
              )}
              {flagged && <Icon name="priority" size={12} weight="fill" className="mail-flag" aria-label="Flagged" />}
              {hasAttachments && <Icon name="attach" size={12} weight="duotone" aria-label="Has attachment" />}
              {shortTime(t.lastTime)}
            </span>
          </div>
          <div className="subj">{t.subject}</div>
          {t.aiSummary ? (
            <div className="mail-ai">
              <Icon name="ai" size={12} weight="duotone" />
              <span className="mail-ai-text">{highlightInline(t.aiSummary)}</span>
            </div>
          ) : (
            <div className="prev">{t.preview}</div>
          )}
          {(labelTag(t) || t.aiDraft || mailbox) && (
            <div className="mail-foot">
              {labelTag(t)}
              {t.aiDraft && <Tag variant="ai" icon="ai">AI draft</Tag>}
              {mailbox && <span className="mail-chip"><Icon name="folder" size={11} weight="duotone" /> {mailbox}</span>}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
