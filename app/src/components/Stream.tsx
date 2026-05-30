import { useState } from "react";
import { motion } from "motion/react";
import dayjs from "dayjs";
import { useApp } from "@/store";
import type { Thread, View } from "@/types";
import { Tag } from "@/components/ui/Tag";
import { Icon } from "@/components/icons";
import { shortTime } from "@/lib/date";
import { accountColor } from "@/lib/colors";

const TITLES: Record<string, string> = {
  priority: "Priority",
  inbox: "All Inbox",
  snoozed: "Snoozed",
  awaiting: "Awaiting reply",
  newsletters: "Newsletters",
  receipts: "Receipts",
};

type SortMode = "newest" | "sender" | "unread";
const SORT_LABEL: Record<SortMode, string> = { newest: "Newest", sender: "Sender", unread: "Unread" };
const NEXT: Record<SortMode, SortMode> = { newest: "sender", sender: "unread", unread: "newest" };

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
  const { view, threads, selectedThreadId, selectThread, triageInbox, setView, archiveThread, snoozeThread, selectedAccountId, syncing, syncAll } = useApp();
  const [sorting, setSorting] = useState(false);
  const [sortMsg, setSortMsg] = useState("");
  const [syncMsg, setSyncMsg] = useState("");

  const doSync = async () => {
    if (syncing) return;
    setSyncMsg("");
    const { total, errors } = await syncAll();
    setSyncMsg(errors.length ? `Sync failed: ${errors[0]}` : `Synced ${total} message${total === 1 ? "" : "s"}`);
    setTimeout(() => setSyncMsg(""), 4000);
  };
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [q, setQ] = useState("");

  // Scope to the focused account first (null = all accounts), then to the view.
  const scoped = selectedAccountId ? threads.filter((t) => t.accountId === selectedAccountId) : threads;
  const inView = scoped.filter((t) => t.view.includes(view as View));
  const query = q.trim().toLowerCase();
  const filtered = query
    ? scoped.filter((t) => [t.subject, t.preview, t.participants.join(" ")].join(" ").toLowerCase().includes(query))
    : inView;
  const list = sortThreads(filtered, sortMode);

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
      <div className="stream-head" data-tauri-drag-region>
        <h2>{TITLES[view] ?? "Inbox"}</h2>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="filter" onClick={doSync} disabled={syncing} title="Sync all accounts" style={{ display: "inline-flex", alignItems: "center", gap: 5, opacity: syncing ? 0.7 : 1 }}>
            <Icon name="cloud" size={12} weight="duotone" /> {syncing ? "Syncing…" : syncMsg || "Sync"}
          </button>
          <button className="filter" onClick={() => setSortMode(NEXT[sortMode])} title="Sort order" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <Icon name="snoozed" size={12} weight="duotone" /> {SORT_LABEL[sortMode]}
          </button>
          <button className="filter" onClick={sort} disabled={sorting} title="Summarize + prioritize with AI" style={{ display: "inline-flex", alignItems: "center", gap: 5, opacity: sorting ? 0.7 : 1 }}>
            <Icon name="ai" size={12} weight="duotone" /> {sorting ? "Sorting…" : sortMsg || "AI sort"}
          </button>
        </div>
      </div>
      <div className="search-box">
        <Icon name="search" size={15} weight="duotone" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search mail…" />
        {q && <button className="search-clear" onClick={() => setQ("")} title="Clear"><Icon name="close" size={13} /></button>}
      </div>
      <div className="list">
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
        {list.map((t, i) => (
          <MailRow
            key={t.id}
            t={t}
            index={i}
            selected={selectedThreadId === t.id}
            onOpen={() => selectThread(t.id)}
            onArchive={() => archiveThread(t.id)}
            onSnooze={() => snoozeThread(t.id)}
          />
        ))}
      </div>
    </section>
  );
}

function MailRow({
  t, index, selected, onOpen, onArchive, onSnooze,
}: {
  t: Thread; index: number; selected: boolean; onOpen: () => void; onArchive: () => void; onSnooze: () => void;
}) {
  const [dragging, setDragging] = useState(false);
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
        drag="x"
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.5}
        onDragStart={() => setDragging(true)}
        onDragEnd={(_e, info) => {
          setDragging(false);
          if (info.offset.x <= -90) onArchive();
          else if (info.offset.x >= 90) onSnooze();
        }}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: Math.min(index * 0.035, 0.3), ease: [0.2, 0.8, 0.2, 1] }}
      >
        <div className="top">
          <span className="acct-dot" style={{ background: accountColor(t.accountId) }} title="Account" />
          <span className="from">{t.participants.join(", ")}</span>
          <span className="time">{shortTime(t.lastTime)}</span>
        </div>
        {(labelTag(t) || t.aiDraft) && (
          <div className="top" style={{ margin: "0 0 4px" }}>
            {labelTag(t)}
            {t.aiDraft && <Tag variant="ai" icon="ai">AI draft ready</Tag>}
          </div>
        )}
        <div className="subj">{t.subject}</div>
        <div className="prev">{t.preview}</div>
      </motion.div>
    </div>
  );
}
