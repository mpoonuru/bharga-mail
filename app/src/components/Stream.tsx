import { useState, useRef, useEffect } from "react";
import { motion } from "motion/react";
import dayjs from "dayjs";
import { useApp } from "@/store";
import type { Thread, View, Message } from "@/types";
import { Tag } from "@/components/ui/Tag";
import { Icon } from "@/components/icons";
import { shortTime, whenMs } from "@/lib/date";
import { avatarColor } from "@/lib/colors";
import { initials, senderLabel } from "@/lib/avatar";
import { titlebarDoubleClick } from "@/lib/bridge";
import { highlightInline } from "@/lib/highlightInline";
import { deriveChips } from "@/lib/smartChips";
import { SmartChips } from "@/components/ui/SmartChips";
import { senderTrust } from "@/lib/senderTrust";
import { threadThreat, messageThreat } from "@/lib/threat";

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
function dateBucket(when: string, now: dayjs.Dayjs): string {
  const d = dayjs(when);
  if (!d.isValid()) return "Earlier";
  if (d.isSame(now, "day")) return "Today";
  if (d.isSame(now.subtract(1, "day"), "day")) return "Yesterday";
  if (d.isAfter(now.startOf("week"))) return "This week";
  if (d.isAfter(now.subtract(1, "week").startOf("week"))) return "Last week";
  if (d.isSame(now, "month")) return "This month";
  if (d.isSame(now, "year")) return d.format("MMMM");
  return d.format("MMMM YYYY");
}

// One row per CONVERSATION — `m` is the thread's newest message (used for the
// collapsed row's time/preview/avatar). Multi-message threads expand inline.
type Row = { t: Thread; m: Message };

/** The newest message in a thread (by parsed date — `when` is RFC 2822, not sortable). */
function latestMessage(t: Thread): Message {
  return t.messages.reduce((a, b) => (whenMs(b.when) > whenMs(a.when) ? b : a), t.messages[0]);
}

/** Apple-Mail-style participant line: distinct senders by first appearance,
 *  first names, last one joined with "&" (e.g. "Imran, Aamir & Lilian"). */
function participantsLabel(t: Thread): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const m of t.messages) {
    const addr = (m.from.address || "").toLowerCase();
    const first = m.from.name?.trim().split(/\s+/)[0] || m.from.address || "";
    const key = addr || first.toLowerCase();
    if (!first || seen.has(key)) continue;
    seen.add(key);
    names.push(first);
  }
  if (names.length === 0) return t.participants?.[0] ?? "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

const plainPreview = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
// `when` arrives as the raw RFC 2822 email Date header (e.g. "Wed, 16 Oct 2024
// 13:02:49 +0200"), which is NOT lexically sortable — string compare orders by
// weekday name and day digits, not the actual instant. Always sort on the parsed
// epoch (whenMs), newest first.
function sortRows(rows: Row[], mode: SortMode): Row[] {
  const arr = [...rows];
  if (mode === "sender") {
    arr.sort((a, b) => (a.m.from.name || a.m.from.address).localeCompare(b.m.from.name || b.m.from.address));
  } else if (mode === "unread") {
    arr.sort((a, b) => Number(b.t.unread) - Number(a.t.unread));
  } else {
    arr.sort((a, b) => whenMs(b.m.when) - whenMs(a.m.when));
  }
  return arr;
}

function labelTag(t: Thread) {
  if (t.labels.includes("urgent")) return <Tag variant="urgent">Urgent</Tag>;
  if (t.labels.includes("meeting")) return <Tag variant="cal">Meeting</Tag>;
  return null;
}

export function Stream() {
  const { view, threads, accounts, selectedThreadId, selectedMessageId, selectThread, triageInbox, setView, archiveThread, snoozeThread, toggleRead, deleteThread, moveThread, markSpam, flaggedIds, toggleFlag, requestCompose, requestAiReply, createTask, folders, selectedAccountId, selectedFolder, syncing, syncAll, loadOlder, loadingOlder, reachedEnd } = useApp();
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
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  // Which conversations have their accordion expanded (thread id set).
  const [expandedConvos, setExpandedConvos] = useState<Set<string>>(new Set());
  const toggleConvo = (id: string) => setExpandedConvos((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // On any selection change (smart view, folder, or account) reset the per-list
  // UI state: scroll to top, clear chip filters, and — importantly — un-collapse
  // date groups. Date-bucket labels ("Last week"…) are shared across folders, so
  // a group collapsed in one folder would otherwise hide the next folder's rows.
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
    setActiveChips(new Set());
    setCollapsedGroups(new Set());
    setExpandedConvos(new Set());
  }, [view, selectedFolder, selectedAccountId]);
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
  // One row per CONVERSATION (Apple-Mail style): the thread, keyed/sorted/bucketed
  // by its NEWEST message. Multi-message threads carry a count badge + a disclosure
  // chevron and expand inline into their messages (newest→oldest).
  const rows: Row[] = sortRows(filtered.map((t) => ({ t, m: latestMessage(t) })), sortMode);
  const grouped = sortMode === "newest" && !query;
  const now = dayjs();
  const groups: { label: string; items: Row[] }[] = [];
  if (grouped) {
    // Group by bucket label into ONE group per label (first-seen order). The
    // previous "merge only adjacent" approach split a label into multiple groups
    // whenever dateBucket revisited it across the sorted list (e.g. week buckets
    // straddling a month, or repeated month names across years). That produced
    // DUPLICATE React keys on the group divs, which silently breaks list
    // reconciliation — the list froze and stopped updating on folder/view switch.
    const byLabel = new Map<string, Row[]>();
    for (const r of rows) {
      const label = dateBucket(r.m.when, now);
      let bucket = byLabel.get(label);
      if (!bucket) { bucket = []; byLabel.set(label, bucket); groups.push({ label, items: bucket }); }
      bucket.push(r);
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
      <div className="list" ref={listRef} key={`${view}|${selectedFolder ?? ""}|${selectedAccountId ?? ""}|${query ? "q" : ""}`}>
        {rows.length === 0 && (
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
          const openCtx = (t: Thread) => (x: number, y: number) =>
            setCtx({ x: Math.max(8, Math.min(x, window.innerWidth - 224)), y: Math.max(8, Math.min(y, window.innerHeight - 580)), t });
          const renderRow = (r: Row, i: number) => {
            const count = r.t.messages.length;
            const isOpen = expandedConvos.has(r.t.id);
            const kids = isOpen && count > 1
              ? [...r.t.messages].sort((a, b) => whenMs(b.when) - whenMs(a.when))
              : [];
            return (
              <div key={r.t.id} className={`convo${isOpen ? " open" : ""}`}>
                <MailRow
                  t={r.t}
                  msg={r.m}
                  convo
                  count={count}
                  expanded={isOpen}
                  onToggleExpand={count > 1 ? () => toggleConvo(r.t.id) : undefined}
                  index={i}
                  selected={selectedThreadId === r.t.id && !selectedMessageId}
                  onOpen={() => selectThread(r.t.id, r.m.id)}
                  onArchive={() => archiveThread(r.t.id)}
                  onSnooze={() => snoozeThread(r.t.id)}
                  mailbox={!selectedAccountId ? acctEmail[r.t.accountId] : undefined}
                  flagged={flaggedIds.includes(r.t.id)}
                  quiet={!!query}
                  onContext={openCtx(r.t)}
                />
                {kids.length > 0 && (
                  <div className="convo-kids">
                    {kids.map((cm) => (
                      <ChildRow
                        key={cm.id}
                        t={r.t}
                        m={cm}
                        selected={selectedMessageId === cm.id}
                        onOpen={() => selectThread(r.t.id, cm.id)}
                        onContext={openCtx(r.t)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          };
          if (!grouped) return rows.map((r, i) => renderRow(r, i));
          return groups.map((g) => {
            const open = !collapsedGroups.has(g.label);
            return (
              <div key={g.label} className="date-group">
                <button className="date-head" onClick={() => toggleGroup(g.label)}>
                  <Icon name={open ? "caretDown" : "caretRight"} size={12} weight="bold" />
                  <span>{g.label}</span>
                  <span className="date-count">{g.items.length}</span>
                </button>
                {open && g.items.map((r, i) => renderRow(r, i))}
              </div>
            );
          });
        })()}
        {!query && rows.length > 0 && (
          reachedEnd ? (
            <div className="load-older load-older--done">All caught up · nothing older</div>
          ) : (
            <button className="load-older" onClick={() => void loadOlder()} disabled={loadingOlder}>
              {loadingOlder ? "Loading older…" : "Load older ↓"}
            </button>
          )
        )}
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
  t, msg, index, selected, onOpen, onArchive, onSnooze, onContext, mailbox, flagged, quiet,
  convo, count, expanded, onToggleExpand,
}: {
  t: Thread; msg?: Message; index: number; selected: boolean; onOpen: () => void; onArchive: () => void; onSnooze: () => void; onContext: (x: number, y: number) => void; mailbox?: string; flagged?: boolean; quiet?: boolean;
  convo?: boolean; count?: number; expanded?: boolean; onToggleExpand?: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  // `convo`: the collapsed conversation header (msg = its newest message, but the
  // sender line shows the whole participant list + a message-count badge).
  const m = msg ?? t.messages[t.messages.length - 1];
  const senderName = msg ? (msg.from.name || msg.from.address) : (t.participants[0] || m?.from.name || m?.from.address || "");
  const senderSeed = m?.from.address || senderName;
  const avPaint = avatarColor(senderSeed);
  const trust = senderTrust(m?.meta?.auth);
  // Escalate to red "Likely phishing" when failed auth + a deceptive link coincide.
  const threat = convo ? threadThreat(t) : msg ? messageThreat(msg) : threadThreat(t);
  const shield = threat.level === "phishing"
    ? { show: true, tone: "bad", icon: "shieldWarning" as const, label: "Likely phishing", detail: threat.reason }
    : { show: trust.level !== "unknown", tone: trust.tone, icon: trust.icon, label: trust.label, detail: trust.detail };
  const hasAttachments = convo ? (t.messages?.some((x) => x.attachments && x.attachments.length > 0) ?? false) : msg ? !!(msg.attachments && msg.attachments.length) : false;
  const multi = !!(convo && count && count > 1);
  const isReplyish = /^\s*(re|aw|fwd|fw)\s*:/i.test(t.subject);
  const rowFrom = convo
    ? participantsLabel(t)
    : msg ? senderLabel(msg.from.name, msg.from.address)
    : t.participants.map((p) => (p.includes("@") && !p.includes(" ") ? senderLabel(undefined, p) : p)).join(", ");
  const rowTime = m?.when ?? t.lastTime;
  const rowPreview = plainPreview(m?.bodyHtml ?? "") || t.preview;
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
            {convo && isReplyish && <Icon name="reply" size={12} weight="bold" className="mail-replyglyph" aria-hidden />}
            <span className="from">{rowFrom}</span>
            <span className="time">
              {shield.show && (
                <span className={`mail-trust trust-${shield.tone}`} title={`${shield.label} — ${shield.detail}`} aria-label={shield.label}>
                  <Icon name={shield.icon} size={15} weight="duotone" />
                </span>
              )}
              {flagged && <Icon name="priority" size={12} weight="fill" className="mail-flag" aria-label="Flagged" />}
              {hasAttachments && <Icon name="attach" size={12} weight="duotone" aria-label="Has attachment" />}
              {shortTime(rowTime)}
            </span>
          </div>
          <div className="subj-row">
            <span className="subj">{t.subject}</span>
            {multi && onToggleExpand && (
              <button
                className={`convo-toggle${expanded ? " open" : ""}`}
                onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
                title={`${count} messages`}
                aria-label={`${count} messages, ${expanded ? "collapse" : "expand"}`}
              >
                <span className="convo-count">{count}</span>
                <Icon name={expanded ? "caretDown" : "caretRight"} size={11} weight="bold" />
              </button>
            )}
          </div>
          {(convo || !msg) && t.aiSummary ? (
            <div className="mail-ai">
              <Icon name="ai" size={12} weight="duotone" />
              <span className="mail-ai-text">{highlightInline(t.aiSummary)}</span>
            </div>
          ) : (
            <div className="prev">{rowPreview}</div>
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

// A compact child row inside an expanded conversation accordion: one message,
// indented under its conversation header, newest→oldest.
function ChildRow({ t, m, selected, onOpen, onContext }: {
  t: Thread; m: Message; selected: boolean; onOpen: () => void; onContext: (x: number, y: number) => void;
}) {
  const sender = senderLabel(m.from.name, m.from.address);
  const av = avatarColor(m.from.address || sender);
  const hasAtt = !!(m.attachments && m.attachments.length);
  const isReplyish = /^\s*(re|aw|fwd|fw)\s*:/i.test(t.subject);
  return (
    <div
      className={`convo-kid${selected ? " sel" : ""}`}
      onClick={onOpen}
      onContextMenu={(e) => { e.preventDefault(); onContext(e.clientX, e.clientY); }}
      role="button"
      tabIndex={0}
    >
      <div className="ck-av" style={{ background: av.bg, color: av.fg }} aria-hidden>{initials(m.from.name || m.from.address)}</div>
      <div className="ck-main">
        <div className="ck-l1">
          {isReplyish && <Icon name="reply" size={11} weight="bold" className="mail-replyglyph" aria-hidden />}
          <span className="ck-from">{sender}</span>
          <span className="ck-time">
            {hasAtt && <Icon name="attach" size={11} weight="duotone" aria-label="Has attachment" />}
            {shortTime(m.when)}
          </span>
        </div>
        <div className="ck-prev">{plainPreview(m.bodyHtml)}</div>
      </div>
    </div>
  );
}
