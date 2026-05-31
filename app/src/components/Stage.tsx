import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useApp } from "@/store";
import { api } from "@/lib/bridge";
import { account } from "@/data/mock";
import type { Thread } from "@/types";
import { Icon } from "@/components/icons";
import { IconButton } from "@/components/ui/IconButton";
import { Chip } from "@/components/ui/Chip";
import { Button } from "@/components/ui/Button";
import { RichText, type RichTextHandle } from "@/components/ui/RichText";
import { Attachments, type Attach } from "@/components/ui/Attachments";
import { SendLater } from "@/components/ui/SendLater";
import { RecipientChips } from "@/components/ui/RecipientChips";
import { Modal } from "@/components/ui/Modal";
import { fullTime } from "@/lib/date";
import { avatarColor } from "@/lib/colors";
import { initials, senderLabel, showAddressLine, folderLabel } from "@/lib/avatar";
import { processEmail } from "@/lib/emailHtml";

/**
 * Render an email body with the standard mail-client pipeline:
 * sanitize (DOMPurify) → block remote images by default → render in a sandboxed
 * iframe (no scripts) with an internal CSP. Auto-sizes to its content.
 */
function EmailBody({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [showImages, setShowImages] = useState(false);
  const highlights = useApp((s) => s.highlights);
  const theme = useApp((s) => s.theme);
  const dark = theme === "dark";

  const processed = useMemo(
    () => processEmail(html, { showImages, highlight: highlights }),
    [html, showImages, highlights],
  );
  const body = processed.html;
  // Defense in depth: the sandbox already blocks scripts (no allow-scripts); this
  // internal CSP additionally forbids scripts/objects/frames inside the email and
  // only permits images, inline styles, and fonts.
  const csp = "default-src 'none'; img-src http: https: data: cid:; style-src 'unsafe-inline'; font-src data: https:; media-src https: data:;";
  // Theme-aware base. In dark mode we render the page on a dark surface with light
  // default text (plain-text + simple emails adapt cleanly); emails that ship their
  // own background/colors keep them, exactly like Gmail/Apple Mail do.
  const surface = dark ? "#15161b" : "#ffffff";
  const ink = dark ? "#e7e8ec" : "#1b1c20";
  const link = dark ? "#8ab0ff" : "#2563eb";
  const doc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
  html,body{margin:0;background:${surface};color:${ink};color-scheme:${dark ? "dark" : "light"};
    font:14.5px/1.7 -apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;
    word-break:break-word;overflow-wrap:anywhere;}
  body{padding:20px 24px;}
  img{max-width:100%;height:auto;}
  table{max-width:100%;}
  a{color:${link};}
  *{max-width:100%;box-sizing:border-box;}
  /* AI-inbox smart highlights */
  mark{border-radius:4px;padding:0 3px;color:inherit;background:none;animation:hlin .45s ease both;}
  mark[data-kind=date]{background:linear-gradient(120deg,rgba(37,99,235,.16),rgba(37,99,235,.06));box-shadow:inset 0 -2px rgba(37,99,235,.22);}
  mark[data-kind=percent]{background:linear-gradient(120deg,rgba(139,92,246,.18),rgba(139,92,246,.06));box-shadow:inset 0 -2px rgba(139,92,246,.22);}
  mark[data-kind=money]{background:linear-gradient(120deg,rgba(16,185,129,.18),rgba(16,185,129,.06));box-shadow:inset 0 -2px rgba(16,185,129,.22);}
  mark[data-kind=urgent]{background:linear-gradient(120deg,rgba(245,158,11,.22),rgba(245,158,11,.08));box-shadow:inset 0 -2px rgba(245,158,11,.3);}
  mark[data-kind=negative]{background:linear-gradient(120deg,rgba(239,68,68,.18),rgba(239,68,68,.06));box-shadow:inset 0 -2px rgba(239,68,68,.25);}
  mark[data-kind=positive]{background:linear-gradient(120deg,rgba(16,185,129,.18),rgba(16,185,129,.06));box-shadow:inset 0 -2px rgba(16,185,129,.25);}
  @keyframes hlin{from{opacity:.35;}to{opacity:1;}}
</style></head><body>${body}</body></html>`;

  const resize = () => {
    const f = ref.current;
    if (!f) return;
    try {
      const d = f.contentDocument;
      if (!d) return;
      const h = Math.max(
        d.body?.scrollHeight ?? 0,
        d.body?.offsetHeight ?? 0,
        d.documentElement?.scrollHeight ?? 0,
        d.documentElement?.offsetHeight ?? 0,
      );
      if (h > 0) f.style.height = `${Math.min(h + 16, 8000)}px`;
    } catch {
      /* cross-origin (shouldn't happen for srcDoc) */
    }
  };

  const onLoad = () => {
    resize();
    // Re-measure as fonts/images/late layout settle so the last lines aren't clipped.
    [60, 200, 500, 1200].forEach((ms) => setTimeout(resize, ms));
    try {
      ref.current?.contentDocument?.querySelectorAll("img").forEach((img) => {
        if (!(img as HTMLImageElement).complete) img.addEventListener("load", resize, { once: true });
      });
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="email-body">
      {processed.blocked > 0 && !showImages && (
        <button className="img-banner" onClick={() => setShowImages(true)}>
          <Icon name="attach" size={13} weight="duotone" />
          {processed.blocked} remote image{processed.blocked > 1 ? "s" : ""} blocked for your privacy — Load images
        </button>
      )}
      <iframe
        ref={ref}
        key={`${showImages ? "i" : "n"}${highlights ? "h" : ""}${dark ? "d" : "l"}`}
        className="email-frame"
        aria-label="Message body"
        sandbox="allow-same-origin allow-popups"
        srcDoc={doc}
        onLoad={onLoad}
      />
    </div>
  );
}

type Mode = "reply" | "replyAll" | "forward";

export function Stage() {
  const { threads, accounts, selectedThreadId, toggleFocus, createTask, snoozeThread, archiveThread, toggleRead, deleteThread, setView } = useApp();
  const thread = useMemo(() => threads.find((t) => t.id === selectedThreadId) ?? null, [threads, selectedThreadId]);
  // The mailbox this conversation lives in (account email), for the header chip.
  const mailboxLabel = accounts.find((a) => a.id === thread?.accountId)?.email ?? "";
  const [moreOpen, setMoreOpen] = useState(false);
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const [dl, setDl] = useState<{ name: string; state: "busy" | "error" } | null>(null);
  const [preview, setPreview] = useState<{ name: string; url: string; mime: string } | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);

  async function openPreview(messageId: string, a: { name: string; mime: string }, accountId: string) {
    setPreviewing(a.name);
    try {
      const url = await api.previewAttachment(accountId, messageId, a.name, a.mime);
      setPreview({ name: a.name, url, mime: a.mime });
    } catch {
      /* fall back to download on failure */
      void downloadAttachment(messageId, a.name, accountId);
    } finally {
      setPreviewing(null);
    }
  }
  const canPreview = (mime: string) => mime.startsWith("image/") || mime === "application/pdf";
  const composerRef = useRef<{ open: (m: Mode, draft?: boolean) => void } | null>(null);

  async function downloadAttachment(messageId: string, name: string, accountId: string) {
    setDl({ name, state: "busy" });
    try {
      await api.downloadAttachment(accountId, messageId, name);
      setDl(null);
    } catch {
      setDl({ name, state: "error" });
    }
  }

  if (!thread) {
    return <section className="stage"><div className="empty" style={{ marginTop: 80 }}>Select a conversation</div></section>;
  }
  const makeTask = () => void createTask(`Follow up: ${thread.subject}`, thread.id);

  return (
    <section className="stage">
      <AnimatePresence mode="wait">
        <motion.div className="stage-inner" key={thread.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}>
          <div className="stage-bar">
            <IconButton icon="focus" title="Focus mode (F)" onClick={toggleFocus} />
            <IconButton icon="reply" title="Reply" onClick={() => composerRef.current?.open("reply")} />
            <IconButton icon="replyAll" title="Reply all" onClick={() => composerRef.current?.open("replyAll")} />
            <IconButton icon="forward" title="Forward" onClick={() => composerRef.current?.open("forward")} />
            <IconButton icon="snoozed" title="Snooze" onClick={() => snoozeThread(thread.id)} />
            <IconButton icon="tasks" title="Turn into task" onClick={makeTask} />
            <div className="spacer" />
            <div style={{ position: "relative" }}>
              <IconButton icon="more" title="More" onClick={() => setMoreOpen((v) => !v)} />
              {moreOpen && (
                <div className="menu" onMouseLeave={() => setMoreOpen(false)}>
                  <button onClick={() => { archiveThread(thread.id); setMoreOpen(false); }}>Archive</button>
                  <button onClick={() => { toggleRead(thread.id); setMoreOpen(false); }}>{thread.unread ? "Mark as read" : "Mark as unread"}</button>
                  <button onClick={() => { snoozeThread(thread.id); setMoreOpen(false); }}>Snooze</button>
                  <button className="danger" onClick={() => { deleteThread(thread.id); setMoreOpen(false); }}>Delete</button>
                </div>
              )}
            </div>
          </div>

          <h1 className="subject">{thread.subject}</h1>

          {thread.aiSummary && (
            <motion.div className="ai-summary" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.05, type: "spring", stiffness: 260, damping: 24 }}>
              <div className="lbl"><Icon name="ai" size={14} weight="duotone" /> AI Summary · by your model</div>
              <p>{thread.aiSummary}</p>
              <div className="chips">
                <Chip solid icon="reply" onClick={() => composerRef.current?.open("reply", true)}>Use AI draft reply</Chip>
                {thread.labels.includes("meeting") && <Chip icon="schedule" onClick={() => setView("calendar")}>Schedule from thread</Chip>}
                <Chip icon="tasks" onClick={makeTask}>Create task</Chip>
              </div>
            </motion.div>
          )}

          {thread.messages.map((m, i) => (
            <motion.div className={`msg${i > 0 ? " reply" : ""}`} key={m.id} style={i > 0 ? { marginLeft: Math.min(i, 5) * 30 } : undefined} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 + i * 0.06, ease: [0.2, 0.8, 0.2, 1] }}>
              {i > 0 && <span className="reply-arrow" title="Reply"><Icon name="reply" size={13} weight="duotone" /></span>}
              {(() => { const c = avatarColor(m.from.address || m.from.name); return (
              <div className="avatar" style={{ background: c.bg, color: c.fg, boxShadow: `0 0 0 1.5px ${c.ring}` }}>{initials(m.from.name || m.from.address)}</div>
              ); })()}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="meta">
                  <span className="name">{senderLabel(m.from.name, m.from.address)}</span>
                  {showAddressLine(m.from.name, m.from.address) && <span className="addr">{m.from.address}</span>}
                  <span className="when">{fullTime(m.when)}</span>
                  <button className="details-toggle" title="Show details" onClick={() => setDetailsFor(detailsFor === m.id ? null : m.id)}>
                    <Icon name={detailsFor === m.id ? "close" : "more"} size={12} />
                  </button>
                </div>
                <div className="meta-sub">
                  {m.to.length > 0 && <span className="to-line">To: {m.to.map((p) => p.name || p.address).join(", ")}</span>}
                  {i === 0 && <span className="mail-chip"><Icon name="folder" size={11} weight="duotone" /> {folderLabel(thread.folder)}{accounts.length > 1 && mailboxLabel ? ` · ${mailboxLabel}` : ""}</span>}
                </div>
                {detailsFor === m.id && (
                  <div className="msg-details">
                    <div><span>From</span><b>{m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address}</b></div>
                    {m.to.length > 0 && <div><span>To</span><b>{m.to.map((p) => p.address).join(", ")}</b></div>}
                    {m.meta?.cc && m.meta.cc.length > 0 && <div><span>Cc</span><b>{m.meta.cc.map((p) => p.address).join(", ")}</b></div>}
                    <div><span>Date</span><b>{fullTime(m.when)}</b></div>
                    {m.meta?.originIp && <div><span>Origin IP</span><b>{m.meta.originIp}</b></div>}
                    {m.meta?.auth && <div><span>Authentication</span><b className={/fail/i.test(m.meta.auth) ? "auth-bad" : "auth-ok"}>{m.meta.auth}</b></div>}
                    {m.meta?.messageId && <div><span>Message-ID</span><b className="mono">{m.meta.messageId}</b></div>}
                    {!m.meta && <div className="msg-details-note">Full headers are captured for IMAP accounts on the next sync.</div>}
                  </div>
                )}
                <EmailBody html={m.bodyHtml} />
                {m.attachments && m.attachments.length > 0 && (
                  <div className="attach-row" style={{ marginTop: 10 }}>
                    {m.attachments.map((a) => {
                      const busy = dl?.name === a.name && dl.state === "busy";
                      const failed = dl?.name === a.name && dl.state === "error";
                      const prev = previewing === a.name;
                      return (
                        <span className="attach-group" key={a.name}>
                          <button
                            className="attach-chip"
                            disabled={busy}
                            onClick={() => downloadAttachment(m.id, a.name, thread.accountId)}
                            title={failed ? "Download failed — click to retry" : `Download · ${a.mime} · ${humanSize(a.size)}`}
                          >
                            <Icon name={busy ? "ai" : failed ? "close" : "attach"} size={12} /> {a.name}{" "}
                            <span className="attach-size">{busy ? "downloading…" : humanSize(a.size)}</span>
                          </button>
                          {canPreview(a.mime) && (
                            <button
                              className="attach-preview"
                              title="Preview"
                              disabled={prev}
                              onClick={() => openPreview(m.id, a, thread.accountId)}
                            >
                              <Icon name={prev ? "ai" : "focus"} size={12} />
                            </button>
                          )}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            </motion.div>
          ))}

          <Composer ref={composerRef} thread={thread} />

          <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.name ?? "Preview"} maxWidth={820}>
            {preview && (preview.mime.startsWith("image/")
              ? <img src={preview.url} alt={preview.name} style={{ maxWidth: "100%", borderRadius: 10, display: "block", margin: "0 auto" }} />
              : <iframe src={preview.url} title={preview.name} style={{ width: "100%", height: "70vh", border: "none", borderRadius: 10 }} />)}
          </Modal>
        </motion.div>
      </AnimatePresence>
    </section>
  );
}

import { forwardRef, useImperativeHandle } from "react";

const Composer = forwardRef<{ open: (m: Mode, draft?: boolean) => void }, { thread: Thread }>(function Composer({ thread }, ref) {
  const queueSend = useApp((s) => s.queueSend);
  const editorRef = useRef<RichTextHandle>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [files, setFiles] = useState<Attach[]>([]);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [sentLabel, setSentLabel] = useState("Sent");

  const last = thread.messages[thread.messages.length - 1];
  const self = account.email.toLowerCase();

  const open = (m: Mode, draft = false) => {
    setMode(m);
    setSent(false);
    const from = last?.from.address ?? "";
    const recips = (last?.to ?? []).map((p) => p.address);
    const origCc = (last?.meta?.cc ?? []).map((p) => p.address);
    setBcc("");
    if (m === "reply") { setTo(from); setCc(""); setShowCc(false); }
    else if (m === "replyAll") {
      // Reply-all: original sender + other To recipients on the To line,
      // original Cc carried into Cc — all minus yourself, de-duped.
      const toLine = [from, ...recips].filter((a) => a && a.toLowerCase() !== self);
      const ccLine = origCc.filter((a) => a && a.toLowerCase() !== self && !toLine.some((t) => t.toLowerCase() === a.toLowerCase()));
      setTo(Array.from(new Set(toLine)).join(", "));
      setCc(Array.from(new Set(ccLine)).join(", "));
      setShowCc(ccLine.length > 0);
    } else { setTo(""); setCc(""); setShowCc(false); }
    setTimeout(() => {
      if (m === "forward") {
        editorRef.current?.setHtml(`<p></p><p>---------- Forwarded message ----------</p><blockquote>${last?.bodyHtml ?? ""}</blockquote>`);
      } else if (draft && thread.aiDraft) {
        editorRef.current?.setHtml(`<p>${thread.aiDraft}</p>`);
      } else {
        editorRef.current?.setHtml("");
      }
      editorRef.current?.focus();
    }, 0);
  };

  useImperativeHandle(ref, () => ({ open }));

  // React to a "Reply with AI draft" request from the command bar.
  const aiReplyFor = useApp((s) => s.aiReplyFor);
  const clearAiReply = useApp((s) => s.clearAiReply);
  useEffect(() => {
    if (aiReplyFor && aiReplyFor === thread.id) {
      open("reply");
      void regen();
      clearAiReply();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiReplyFor, thread.id]);

  // Open the composer in a specific mode when requested from the context menu.
  const composeIntent = useApp((s) => s.composeIntent);
  const clearComposeIntent = useApp((s) => s.clearComposeIntent);
  useEffect(() => {
    if (composeIntent && composeIntent.id === thread.id) {
      open(composeIntent.mode);
      clearComposeIntent();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composeIntent, thread.id]);

  const subject = mode === "forward"
    ? (thread.subject.startsWith("Fwd:") ? thread.subject : `Fwd: ${thread.subject}`)
    : (thread.subject.startsWith("Re:") ? thread.subject : `Re: ${thread.subject}`);

  async function regen() {
    setBusy(true);
    const text = `Subject: ${thread.subject}\n${thread.messages.map((m) => m.bodyHtml.replace(/<[^>]+>/g, " ")).join("\n")}`;
    editorRef.current?.setHtml(await api.draftReply(thread.id, text));
    setBusy(false);
  }

  async function send(atTs?: number) {
    const html = editorRef.current?.getHtml() ?? "";
    await queueSend({ to, cc, bcc, subject, body: html, threadId: thread.id, sendAt: atTs, attachments: files.map(({ name, mime, dataB64 }) => ({ name, mime, dataB64 })) });
    setSentLabel(atTs ? "Scheduled" : "Sent");
    setSent(true);
    setMode(null);
    setTimeout(() => setSent(false), 2200);
  }

  if (sent) {
    return <motion.div className="card sent-card" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}><Icon name={sentLabel === "Scheduled" ? "schedule" : "send"} size={14} weight="fill" /> {sentLabel}</motion.div>;
  }

  if (!mode) {
    return (
      <div className="reply-bar">
        <button className="reply-action" onClick={() => open("reply")}><Icon name="reply" size={15} weight="duotone" /> Reply</button>
        <button className="reply-action" onClick={() => open("replyAll")}><Icon name="replyAll" size={15} weight="duotone" /> Reply all</button>
        <button className="reply-action" onClick={() => open("forward")}><Icon name="forward" size={15} weight="duotone" /> Forward</button>
      </div>
    );
  }

  const titleMap: Record<Mode, string> = { reply: "Reply", replyAll: "Reply all", forward: "Forward" };

  return (
    <div className="composer">
      <div className="chead">
        <Icon name={mode === "forward" ? "forward" : mode === "replyAll" ? "replyAll" : "reply"} size={13} /> {titleMap[mode]}
        <span style={{ marginLeft: "auto" }} />
        <IconButton icon="close" title="Discard" onClick={() => setMode(null)} />
      </div>
      <div className="recip-row">
        <span className="recip-lbl">To</span>
        <RecipientChips value={to} onChange={setTo} placeholder="Add people…" />
        {!showCc && (
          <button type="button" className="recip-toggle" onClick={() => setShowCc(true)} title="Add Cc / Bcc">Cc / Bcc</button>
        )}
      </div>
      {showCc && <div className="recip-row"><span className="recip-lbl">Cc</span><RecipientChips value={cc} onChange={setCc} placeholder="Add Cc…" /></div>}
      {showCc && <div className="recip-row"><span className="recip-lbl">Bcc</span><RecipientChips value={bcc} onChange={setBcc} placeholder="Add Bcc…" /></div>}
      <div className="recip-subject">{subject}</div>
      <RichText ref={editorRef} placeholder="Write your message…" minHeight={120} />
      <div className="cfoot">
        <Button onClick={() => send()} icon="send">Send</Button>
        <SendLater onSchedule={(ts) => send(ts)} />
        <Attachments files={files} onAdd={(f) => setFiles((p) => [...p, ...f])} onRemove={(n) => setFiles((p) => p.filter((x) => x.name !== n))} />
        <IconButton icon="ai" weight="duotone" title="Draft / rewrite with AI" onClick={regen} />
        {busy && <span className="ghost-pill">Drafting…</span>}
      </div>
    </div>
  );
});

function humanSize(bytes: number) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
