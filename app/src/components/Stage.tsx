import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { AnimatePresence, motion } from "motion/react";
import { createRef, useEffect, useMemo, useRef, useState } from "react";
import { InvitationCard } from "@/calendar/InvitationCard";
import { Icon } from "@/components/icons";
import {
  ReaderDisplayControls,
  ReaderDisplayProvider,
  useReaderDisplay,
} from "@/components/reader/ReaderDisplay";
import { type Attach, Attachments } from "@/components/ui/Attachments";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { IconButton } from "@/components/ui/IconButton";
import { Modal } from "@/components/ui/Modal";
import { RecipientChips } from "@/components/ui/RecipientChips";
import { RichText, type RichTextHandle } from "@/components/ui/RichText";
import { SendLater } from "@/components/ui/SendLater";
import { Tooltip } from "@/components/ui/Tooltip";
import { accountAddress, replyRecipients } from "@/lib/accountIdentity";
import { folderLabel, initials, senderLabel, showAddressLine } from "@/lib/avatar";
import { api, titlebarDoubleClick } from "@/lib/bridge";
import { avatarColor } from "@/lib/colors";
import { fullTime, whenMs } from "@/lib/date";
import {
  bindEmailFrameLayout,
  type EmailFrameLayout,
  type FrameSize,
} from "@/lib/emailFrameLayout";
import { hiddenContentIsNotable, processEmail } from "@/lib/emailHtml";
import { parseExternalWebUrl } from "@/lib/externalLinks";
import { isKeyboardContextMenu } from "@/lib/keyboard";
import { safeDraftHtml, visibleMailText } from "@/lib/mailText";
import { THREAD_CROSSFADE, useMotionTransition } from "@/lib/motion";
import { senderTrust } from "@/lib/senderTrust";
import { messageThreat } from "@/lib/threat";
import { useApp } from "@/store";
import type { AttachmentMeta, InvitationInspection, Thread } from "@/types";

dayjs.extend(utc);
dayjs.extend(timezone);

type LinkDecision =
  | { kind: "link"; href: string; host: string }
  | { kind: "warning"; href: string; host: string; level: string }
  | { kind: "blocked"; href: string };

/** A click target of the app's own, laid exactly over one box of a link in the
 *  message frame. */
interface LinkShield {
  key: string;
  /** Index of the link among the frame's `a[href]` elements. */
  link: number;
  /** A link wrapping over several lines has several boxes; only the first is a
   *  tab stop and is announced. */
  first: boolean;
  label: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

// More boxes than any real message carries. Links past it stay unshielded: inert
// in WebKit, and caught by the in-frame listener elsewhere.
const MAX_LINK_SHIELDS = 600;

/** A message quoted into the compose editor, which lives in the main window:
 *  cleaned like the reader does it, with nothing remote left to load. */
function forwardedHtml(html: string): string {
  return processEmail(html, { showImages: false, highlight: false }).html;
}

/**
 * Render an email body with the standard mail-client pipeline:
 * sanitize (DOMPurify) → block remote images by default → render in a sandboxed
 * iframe (no scripts) with an internal CSP. Auto-sizes to its content.
 */
export function EmailBody({
  html,
  sender,
  trimQuote,
}: {
  html: string;
  sender?: string;
  trimQuote?: boolean;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<HTMLDivElement>(null);
  const sizingRef = useRef<EmailFrameLayout | null>(null);
  const display = useReaderDisplay();
  const displayRef = useRef(display);
  displayRef.current = display;
  const [frameSize, setFrameSize] = useState<FrameSize>({ width: 0, viewportWidth: 0 });
  const detachFrameRef = useRef<() => void>(() => {});
  const linkOpenerRef = useRef<HTMLElement | null>(null);
  const shieldKeyRef = useRef("");
  const [shields, setShields] = useState<LinkShield[]>([]);
  const [showImages, setShowImages] = useState(false);
  const [decision, setDecision] = useState<LinkDecision | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const highlights = useApp((s) => s.highlights);
  const theme = useApp((s) => s.theme);
  const contentPx = useApp((s) => s.contentPx);
  const dark = theme === "dark";

  useEffect(() => {
    sizingRef.current?.update({ layout: display.layout, zoom: display.zoom });
  }, [display.layout, display.zoom]);

  const processed = useMemo(
    () => processEmail(html, { showImages, highlight: highlights, dark, sender, trimQuote }),
    [html, showImages, highlights, dark, sender, trimQuote],
  );
  const body = processed.html;

  // Phase-2: ask the local AI model whether the message itself reads like a
  // phishing attempt (intent — urgency, credential harvesting), beyond the
  // deterministic link checks. Only runs when there's something worth judging.
  const [aiVerdict, setAiVerdict] = useState<{
    level: string;
    confidence: number;
    reason: string;
  } | null>(null);
  useEffect(() => {
    setAiVerdict(null);
    const plain = visibleMailText(html, 4000);
    const lure =
      /(verify|suspend|unusual activity|within \d+\s?h|confirm your|update your|password|account will be|sign\s?in|log\s?in)/i.test(
        plain,
      );
    if (processed.links.length === 0 && !lure) return;
    const summary = processed.links
      .map((l) => `${l.level.toUpperCase()} ${l.host}: ${l.reasons[0]}`)
      .join("\n");
    let alive = true;
    void api.phishingCheck(plain, summary).then((v) => {
      if (alive && v && v.level !== "safe") setAiVerdict(v);
    });
    return () => {
      alive = false;
    };
  }, [html, processed.links]);
  // Defense in depth: the sandbox already blocks scripts (no allow-scripts); this
  // internal CSP additionally forbids scripts/objects/frames inside the email and
  // only permits images, inline styles, and fonts.
  // Until "Load images" is pressed the policy itself allows nothing remote, so a
  // reference the cleaning pass did not recognise still cannot be fetched.
  const remote = showImages
    ? "img-src http: https: data: cid:; font-src data: https:; media-src https: data:;"
    : "img-src data: cid:; font-src data:; media-src data:;";
  const csp = `default-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'; style-src 'unsafe-inline'; ${remote}`;
  // Theme-aware base. In dark mode we render the page on a dark surface with light
  // default text (plain-text + simple emails adapt cleanly); emails that ship their
  // own background/colors keep them, exactly like Gmail/Apple Mail do.
  const surface = dark ? "#15161b" : "#ffffff";
  const ink = dark ? "#e7e8ec" : "#1b1c20";
  const link = dark ? "#8ab0ff" : "#2563eb";
  const doc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta http-equiv="x-dns-prefetch-control" content="off">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html,body{margin:0;background:${surface};color:${ink};color-scheme:${dark ? "dark" : "light"};
    font:${contentPx}px/1.7 -apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;
    min-height:0!important;height:auto!important;}
  html{overflow:hidden;}
  body{display:flow-root;padding:20px var(--bharga-message-padding,24px);}
  a{color:${link};}
  /* Phishing / risky-link marking (see lib/linkRisk). */
  a[data-risk]{text-decoration:underline wavy #d97706;text-underline-offset:2px;cursor:pointer;}
  a[data-risk=dangerous]{text-decoration-color:#ef4444;background:rgba(239,68,68,.10);border-radius:3px;}
  a[data-risk]::after{content:" \\26A0\\FE0F";font-size:.8em;}
  *{box-sizing:border-box;}
  /* Tame quoted history: browsers default blockquotes to margin:0 40px (both
     sides, per nesting level), which collapses deeply-nested "On … wrote:"
     replies into a one-word-per-line sliver. Replace with a small left-only
     indent + guide bar so quotes stay readable at any depth. */
  blockquote{margin:8px 0;padding:2px 0 2px 12px;border-left:2px solid ${dark ? "rgba(255,255,255,.16)" : "rgba(0,0,0,.14)"};border-inline-end:0;}
  blockquote blockquote{margin-left:2px;}
  /* AI-inbox smart highlights */
  mark{border-radius:4px;padding:0 3px;color:inherit;background:none;animation:hlin .45s ease both;}
  mark[data-kind=date]{background:linear-gradient(120deg,rgba(37,99,235,.16),rgba(37,99,235,.06));box-shadow:inset 0 -2px rgba(37,99,235,.22);}
  mark[data-kind=percent]{background:linear-gradient(120deg,rgba(139,92,246,.18),rgba(139,92,246,.06));box-shadow:inset 0 -2px rgba(139,92,246,.22);}
  mark[data-kind=money]{background:linear-gradient(120deg,rgba(16,185,129,.18),rgba(16,185,129,.06));box-shadow:inset 0 -2px rgba(16,185,129,.22);}
  mark[data-kind=email],a[data-hl=email]{border-radius:4px;padding:0 3px;background:linear-gradient(120deg,rgba(14,165,233,.18),rgba(14,165,233,.06));box-shadow:inset 0 -2px rgba(14,165,233,.28);}
  mark[data-kind=phone]{background:linear-gradient(120deg,rgba(20,184,166,.18),rgba(20,184,166,.06));box-shadow:inset 0 -2px rgba(20,184,166,.26);}
  mark[data-kind=ref]{background:linear-gradient(120deg,rgba(100,116,139,.2),rgba(100,116,139,.07));box-shadow:inset 0 -2px rgba(100,116,139,.3);}
  mark[data-kind=sensitive]{background:linear-gradient(120deg,rgba(236,72,153,.18),rgba(236,72,153,.06));box-shadow:inset 0 -2px rgba(236,72,153,.28);}
  mark[data-kind=security]{background:linear-gradient(120deg,rgba(220,38,38,.22),rgba(220,38,38,.08));box-shadow:inset 0 -2px rgba(220,38,38,.38);}
  mark[data-kind=urgent]{background:linear-gradient(120deg,rgba(245,158,11,.22),rgba(245,158,11,.08));box-shadow:inset 0 -2px rgba(245,158,11,.3);}
  mark[data-kind=negative]{background:linear-gradient(120deg,rgba(239,68,68,.18),rgba(239,68,68,.06));box-shadow:inset 0 -2px rgba(239,68,68,.25);}
  mark[data-kind=positive]{background:linear-gradient(120deg,rgba(16,185,129,.18),rgba(16,185,129,.06));box-shadow:inset 0 -2px rgba(16,185,129,.25);}
  @keyframes hlin{from{opacity:.35;}to{opacity:1;}}
</style>${processed.headStyles}<style>a[data-href]{cursor:pointer!important;}a[data-risk]{text-decoration:underline wavy #d97706!important;}a[data-risk=dangerous]{text-decoration-color:#ef4444!important;background:rgba(239,68,68,.10)!important;}a[data-risk]::after{content:" \\26A0\\FE0F"!important;}</style></head><body${processed.bodyAttrs}>${body}</body></html>`;

  const closeDecision = () => {
    const opener = linkOpenerRef.current;
    setDecision(null);
    setCopyStatus("idle");
    window.setTimeout(() => {
      if (opener?.isConnected) opener.focus();
    }, 0);
  };

  const copyLink = async (href: string) => {
    try {
      await navigator.clipboard.writeText(href);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
  };

  // Links never open from a message. Activating one shows where it really goes
  // and offers to copy it; whether to visit it is decided in the browser.
  const reviewLink = (anchor: HTMLAnchorElement, opener: HTMLElement = anchor) => {
    const rawHref = anchor.getAttribute("data-href")?.trim() ?? "";
    const destination = parseExternalWebUrl(rawHref);
    linkOpenerRef.current = opener;
    setCopyStatus("idle");
    if (!destination) {
      setDecision({ kind: "blocked", href: rawHref });
      return;
    }
    const level = anchor.getAttribute("data-risk");
    setDecision(
      level
        ? { kind: "warning", href: destination.href, host: destination.host, level }
        : { kind: "link", href: destination.href, host: destination.host },
    );
  };

  const reviewShield = (link: number, opener: HTMLElement) => {
    const anchor =
      ref.current?.contentDocument?.querySelectorAll<HTMLAnchorElement>("a[data-href]")[link];
    if (anchor) reviewLink(anchor, opener);
  };

  // The frame runs no scripts, and WebKit then also skips listeners the app adds
  // to it, so a click inside the frame cannot be relied on. Each link therefore
  // gets a button of the app's own on top of it, placed from the link's boxes.
  const measureShields = (frame: HTMLIFrameElement) => {
    const anchors =
      frame.contentDocument?.querySelectorAll<HTMLAnchorElement>("a[data-href]") ?? [];
    const next: LinkShield[] = [];
    for (let link = 0; link < anchors.length && next.length < MAX_LINK_SHIELDS; link++) {
      const anchor = anchors[link];
      const label = (anchor.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      // A linked image can be taller than the inline box of its anchor.
      const boxes = [
        ...anchor.getClientRects(),
        ...[...anchor.querySelectorAll("img")].map((image) => image.getBoundingClientRect()),
      ];
      let first = true;
      for (const box of boxes) {
        if (box.width < 1 || box.height < 1 || next.length >= MAX_LINK_SHIELDS) continue;
        next.push({
          key: `${link}:${next.length}`,
          link,
          first,
          label: label || "image",
          left: Math.round(box.left + frame.clientLeft),
          top: Math.round(box.top + frame.clientTop),
          width: Math.round(box.width),
          height: Math.round(box.height),
        });
        first = false;
      }
    }
    const key = next
      .map((item) => `${item.link},${item.left},${item.top},${item.width},${item.height}`)
      .join(";");
    if (key === shieldKeyRef.current) return;
    shieldKeyRef.current = key;
    setShields(next);
  };

  useEffect(() => () => detachFrameRef.current(), []);

  const onLoad = () => {
    detachFrameRef.current();
    try {
      const frame = ref.current;
      const d = frame?.contentDocument;
      const viewport = viewportRef.current;
      if (!frame || !d?.body || !viewport) return;
      const sizing = bindEmailFrameLayout(frame, viewport, displayRef.current, (next) => {
        setFrameSize((current) =>
          current.width === next.width && current.viewportWidth === next.viewportWidth
            ? current
            : next,
        );
        measureShields(frame);
      });
      sizingRef.current = sizing;
      // Where listeners do run inside the frame (Chromium), they hold every link
      // activation back as well. The embedded mail document never receives
      // navigation or popup permissions.
      const onLinkActivate = (e: MouseEvent) => {
        if (e.type === "auxclick" && e.button !== 1) return;
        const a = (e.target as HTMLElement | null)?.closest?.(
          "a[data-href]",
        ) as HTMLAnchorElement | null;
        if (!a) return;
        e.preventDefault();
        e.stopPropagation();
        reviewLink(a);
      };
      const onLinkKeyDown = (e: KeyboardEvent) => {
        const a = (e.target as HTMLElement | null)?.closest?.(
          "a[data-href]",
        ) as HTMLAnchorElement | null;
        if (!a || !isKeyboardContextMenu(e)) return;
        e.preventDefault();
        e.stopPropagation();
        reviewLink(a);
      };
      d.addEventListener("click", onLinkActivate, true);
      d.addEventListener("auxclick", onLinkActivate, true);
      d.addEventListener("contextmenu", onLinkActivate, true);
      d.addEventListener("keydown", onLinkKeyDown, true);
      detachFrameRef.current = () => {
        sizing.dispose();
        if (sizingRef.current === sizing) sizingRef.current = null;
        d.removeEventListener("click", onLinkActivate, true);
        d.removeEventListener("auxclick", onLinkActivate, true);
        d.removeEventListener("contextmenu", onLinkActivate, true);
        d.removeEventListener("keydown", onLinkKeyDown, true);
      };
    } catch {
      /* ignore */
    }
  };

  const danger =
    processed.links.some((l) => l.level === "dangerous") || aiVerdict?.level === "phishing";
  const showPhish = processed.links.length > 0 || (!!aiVerdict && aiVerdict.level !== "safe");
  return (
    <div className="email-body">
      {showPhish && (
        <div className={`phish-banner${danger ? " danger" : ""}`}>
          <Icon name="shieldWarning" size={15} weight="fill" />
          <div className="phish-main">
            <b>{danger ? "This message may be a phishing attempt" : "Suspicious message"}</b>
            {aiVerdict && (
              <div className="phish-ai">
                <Icon name="ai" size={11} weight="duotone" /> Bharga AI · {aiVerdict.confidence}%
                confident — {aiVerdict.reason}
              </div>
            )}
            {processed.links.length > 0 && (
              <ul className="phish-list">
                {processed.links.slice(0, 4).map((l, i) => (
                  <li key={i}>
                    <span className="phish-host">{l.host}</span> — {l.reasons[0]}
                  </li>
                ))}
              </ul>
            )}
            <span className="phish-hint">
              Links never open from Bharga. Select one to see and copy its real destination.
            </span>
          </div>
        </div>
      )}
      {hiddenContentIsNotable(processed.hidden) && (
        <div className="phish-banner">
          <Icon name="shieldWarning" size={15} weight="fill" />
          <div className="phish-main">
            <b>This message contains hidden content</b>
            <ul className="phish-list">
              {processed.hidden.textChars > 0 && (
                <li>
                  {processed.hidden.textChars} characters of text you cannot see
                  {processed.hidden.sample && <>: “{processed.hidden.sample}”</>}
                </li>
              )}
              {processed.hidden.links > 0 && (
                <li>
                  {processed.hidden.links} hidden link{processed.hidden.links > 1 ? "s" : ""}
                </li>
              )}
              {processed.hidden.directionOverrides > 0 && (
                <li>
                  Characters that reorder the text on screen, used to disguise file names and
                  addresses
                </li>
              )}
            </ul>
            <span className="phish-hint">
              Hidden content is often harmless, but it can be meant for filters or AI summaries
              instead of you.
            </span>
          </div>
        </div>
      )}
      {processed.blocked > 0 && !showImages && (
        <button className="img-banner" onClick={() => setShowImages(true)}>
          <Icon name="attach" size={13} weight="duotone" />
          {processed.blocked} remote image{processed.blocked > 1 ? "s" : ""} blocked for your
          privacy — Load images
        </button>
      )}
      <Modal
        open={!!decision}
        onClose={closeDecision}
        title={
          decision?.kind === "blocked"
            ? "Link blocked"
            : decision?.kind === "link"
              ? "Link destination"
              : decision?.level === "dangerous"
                ? "Dangerous link"
                : "Suspicious link"
        }
        maxWidth={560}
      >
        {decision && (
          <div
            className={`link-decision${decision.kind === "warning" && decision.level === "dangerous" ? " danger" : ""}`}
          >
            <div className="link-decision-summary">
              {decision.kind !== "link" && <Icon name="shieldWarning" size={19} weight="fill" />}
              <p>
                {decision.kind === "link" && (
                  <>
                    This link goes to <b>{decision.host}</b>. Bharga never opens links from a
                    message. If you trust it, copy it and open it in your browser.
                  </>
                )}
                {decision.kind === "warning" && (
                  <>
                    This link goes to <b>{decision.host}</b>. Bharga flagged the destination as
                    possibly unsafe, and never opens links from a message.
                  </>
                )}
                {decision.kind === "blocked" && (
                  <>
                    Bharga blocked this destination because it is not a valid HTTP or HTTPS web
                    link.
                  </>
                )}
              </p>
            </div>
            <div className="lc-url">{decision.href || "No destination provided"}</div>
            <div className="lc-actions">
              <button type="button" onClick={() => void copyLink(decision.href)}>
                Copy link
              </button>
              <button type="button" onClick={closeDecision}>
                {decision.kind === "link" ? "Close" : "Stay safe"}
              </button>
            </div>
            <div className="link-copy-status" aria-live="polite">
              {copyStatus === "copied"
                ? "Link copied."
                : copyStatus === "error"
                  ? "Could not copy the link."
                  : ""}
            </div>
          </div>
        )}
      </Modal>
      <div
        ref={viewportRef}
        className="email-viewport"
        onScroll={(event) => {
          if (
            panRef.current &&
            Math.abs(panRef.current.scrollLeft - event.currentTarget.scrollLeft) > 0.5
          )
            panRef.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
      >
        <iframe
          ref={ref}
          key={`${showImages ? "i" : "n"}${highlights ? "h" : ""}${dark ? "d" : "l"}${contentPx}`}
          className="email-frame"
          aria-label="Message body"
          sandbox="allow-same-origin"
          scrolling="no"
          srcDoc={doc}
          onLoad={onLoad}
        />
        {shields.map((shield) => (
          <button
            key={shield.key}
            type="button"
            className="link-shield"
            style={{
              left: shield.left,
              top: shield.top,
              width: shield.width,
              height: shield.height,
            }}
            tabIndex={shield.first ? 0 : -1}
            aria-hidden={shield.first ? undefined : true}
            aria-label={`Link: ${shield.label}. Show destination`}
            onClick={(event) => reviewShield(shield.link, event.currentTarget)}
            onContextMenu={(event) => {
              event.preventDefault();
              reviewShield(shield.link, event.currentTarget);
            }}
          />
        ))}
      </div>
      {frameSize.width > frameSize.viewportWidth + 1 && (
        <div
          className="email-pan"
          role="region"
          aria-label="Scroll message horizontally"
          tabIndex={0}
          ref={(node) => {
            panRef.current = node;
            if (node && viewportRef.current) node.scrollLeft = viewportRef.current.scrollLeft;
          }}
          onScroll={(event) => {
            if (
              viewportRef.current &&
              Math.abs(viewportRef.current.scrollLeft - event.currentTarget.scrollLeft) > 0.5
            )
              viewportRef.current.scrollLeft = event.currentTarget.scrollLeft;
          }}
        >
          <div style={{ width: frameSize.width, height: 1 }} />
        </div>
      )}
    </div>
  );
}

type Mode = "reply" | "replyAll" | "forward";

function CalendarAttachmentPanel({
  accountId,
  threadId,
  messageId,
  attachment,
}: {
  accountId: string;
  threadId: string;
  messageId: string;
  attachment: AttachmentMeta;
}) {
  const [inspections, setInspections] = useState<InvitationInspection[]>([]);
  const isCalendar =
    attachment.mime.toLowerCase().startsWith("text/calendar") || /\.ics$/i.test(attachment.name);

  useEffect(() => {
    let active = true;
    if (!isCalendar || !api.calendar.inspectAttachment)
      return () => {
        active = false;
      };
    void api.calendar
      .inspectAttachment(accountId, messageId, attachment.name)
      .then((result) => {
        if (active) setInspections(result);
      })
      .catch(() => {
        if (active) setInspections([]);
      });
    return () => {
      active = false;
    };
  }, [accountId, attachment.name, isCalendar, messageId]);

  if (!isCalendar || inspections.length === 0) return null;
  return (
    <div className="invitation-card-stack">
      {inspections.map((inspection) => (
        <InvitationCard
          key={`${inspection.event.uid}:${inspection.event.recurrenceId ?? "master"}`}
          inspection={inspection}
          timezone={dayjs.tz.guess()}
          onRespond={async (status) => {
            if (!api.calendar.respondToInvitation)
              throw new Error("Invitation responses are unavailable");
            await api.calendar.respondToInvitation({
              accountId,
              threadId,
              calendarId: inspection.event.calendarId,
              event: inspection.event,
              status,
            });
          }}
        />
      ))}
    </div>
  );
}

export function Stage() {
  const {
    threads,
    accounts,
    selectedThreadId,
    selectedMessageId,
    toggleFocus,
    createTask,
    snoozeThread,
    archiveThread,
    toggleRead,
    deleteThread,
    setView,
    contentPx,
    setContentPx,
  } = useApp();
  const thread = useMemo(
    () => threads.find((t) => t.id === selectedThreadId) ?? null,
    [threads, selectedThreadId],
  );
  // The conversation root (oldest message) keeps its full content; replies above
  // it have their redundant quoted copy trimmed.
  const oldestMessageId = useMemo(
    () =>
      thread?.messages.reduce(
        (o, m) => (o && whenMs(o.when) <= whenMs(m.when) ? o : m),
        thread.messages[0],
      )?.id,
    [thread],
  );
  // The mailbox this conversation lives in (account email), for the header chip.
  const mailboxLabel = accounts.find((a) => a.id === thread?.accountId)?.email ?? "";
  const [moreOpen, setMoreOpen] = useState(false);
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const [dl, setDl] = useState<{ name: string; state: "busy" | "error" } | null>(null);
  const [preview, setPreview] = useState<{ name: string; url: string; mime: string } | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const crossfadeTransition = useMotionTransition(THREAD_CROSSFADE);

  async function openPreview(
    messageId: string,
    a: { name: string; mime: string },
    accountId: string,
  ) {
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
  // Same list as `is_previewable_mime` in lib.rs: passive formats only, never SVG.
  const canPreview = (mime: string) =>
    ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "application/pdf"].includes(
      mime.trim().toLowerCase(),
    );
  // Each presence-keyed pane owns its own imperative composer handle. An
  // outgoing pane must never clear the incoming thread's toolbar actions.
  const composerRef = useMemo(
    () => createRef<{ open: (m: Mode, draft?: boolean) => void }>(),
    [thread?.id],
  );

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
    return (
      <section className="stage" data-tauri-drag-region onDoubleClick={titlebarDoubleClick}>
        <div className="empty" style={{ marginTop: 80 }}>
          Select a conversation
        </div>
      </section>
    );
  }
  const makeTask = () => void createTask(`Follow up: ${thread.subject}`, thread.id);
  const scheduleThread = () => {
    if (!api.calendar.scheduleFromThread) {
      setView("calendar");
      return;
    }
    void api.calendar
      .scheduleFromThread(thread.id)
      .then(() => setView("calendar"))
      .catch(() => {});
  };

  return (
    <section className="stage stage-reader">
      <div className="stage-presence" style={{ display: "grid" }}>
        <AnimatePresence initial={false}>
          <ReaderDisplayProvider key={thread.id}>
            <motion.div
              className="stage-inner"
              key={thread.id}
              style={{ gridArea: "1 / 1" }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={crossfadeTransition}
            >
              <div className="stage-bar">
                <IconButton icon="focus" title="Focus mode (F)" onClick={toggleFocus} />
                <IconButton
                  icon="reply"
                  title="Reply"
                  onClick={() => composerRef.current?.open("reply")}
                />
                <IconButton
                  icon="replyAll"
                  title="Reply all"
                  onClick={() => composerRef.current?.open("replyAll")}
                />
                <IconButton
                  icon="forward"
                  title="Forward"
                  onClick={() => composerRef.current?.open("forward")}
                />
                <IconButton
                  icon={thread.unread ? "envelopeOpen" : "envelope"}
                  title={thread.unread ? "Mark as read (U)" : "Mark as unread (U)"}
                  onClick={() => toggleRead(thread.id)}
                />
                <IconButton icon="snoozed" title="Snooze" onClick={() => snoozeThread(thread.id)} />
                <IconButton icon="tasks" title="Turn into task" onClick={makeTask} />
                <div
                  className="spacer"
                  data-tauri-drag-region
                  onDoubleClick={titlebarDoubleClick}
                />
                <div className="font-step" role="group" aria-label="Text size">
                  <Tooltip label="Smaller text" side="bottom">
                    <button
                      className="iconbtn"
                      aria-label="Smaller text"
                      onClick={() => setContentPx(contentPx - 1)}
                      disabled={contentPx <= 12}
                    >
                      A−
                    </button>
                  </Tooltip>
                  <Tooltip label="Reset text size" side="bottom">
                    <button
                      className="iconbtn font-reset"
                      aria-label="Reset text size"
                      onClick={() => setContentPx(14.5)}
                    >
                      A
                    </button>
                  </Tooltip>
                  <Tooltip label="Larger text" side="bottom">
                    <button
                      className="iconbtn"
                      aria-label="Larger text"
                      onClick={() => setContentPx(contentPx + 1)}
                      disabled={contentPx >= 22}
                    >
                      A+
                    </button>
                  </Tooltip>
                </div>
                <div style={{ position: "relative" }}>
                  <IconButton icon="more" title="More" onClick={() => setMoreOpen((v) => !v)} />
                  {moreOpen && (
                    <div className="menu" onMouseLeave={() => setMoreOpen(false)}>
                      <button
                        onClick={() => {
                          archiveThread(thread.id);
                          setMoreOpen(false);
                        }}
                      >
                        Archive
                      </button>
                      <button
                        onClick={() => {
                          snoozeThread(thread.id);
                          setMoreOpen(false);
                        }}
                      >
                        Snooze
                      </button>
                      <button
                        className="danger"
                        onClick={() => {
                          deleteThread(thread.id);
                          setMoreOpen(false);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <ReaderDisplayControls />
              <h1 className="subject">{thread.subject}</h1>

              <div
                className="reader-scroll"
                role="region"
                aria-label="Conversation content"
                tabIndex={0}
              >
                {thread.aiSummary && (
                  <div className="ai-summary">
                    <div className="lbl">
                      <Icon name="ai" size={14} weight="duotone" /> AI Summary · by your model
                    </div>
                    <p>{thread.aiSummary}</p>
                    <div className="chips">
                      <Chip
                        solid
                        icon="reply"
                        onClick={() => composerRef.current?.open("reply", true)}
                      >
                        Use AI draft reply
                      </Chip>
                      {thread.labels.includes("meeting") && (
                        <Chip icon="schedule" onClick={scheduleThread}>
                          Schedule from thread
                        </Chip>
                      )}
                      <Chip icon="tasks" onClick={makeTask}>
                        Create task
                      </Chip>
                    </div>
                  </div>
                )}

                {/* Conversation: the message you clicked is on top; the rest of the chain
              follows newest-first as individual connected cards. */}
                {[...thread.messages]
                  .sort((a, b) => {
                    if (selectedMessageId) {
                      if (a.id === selectedMessageId) return -1;
                      if (b.id === selectedMessageId) return 1;
                    }
                    return whenMs(b.when) - whenMs(a.when);
                  })
                  .map((m, i) => (
                    <div
                      className={`msg${i > 0 ? " reply" : ""}`}
                      key={m.id}
                      style={i > 0 ? { marginLeft: Math.min(i, 5) * 30 } : undefined}
                    >
                      {i > 0 && (
                        <span className="reply-arrow" title="Earlier message">
                          <Icon name="reply" size={13} weight="duotone" />
                        </span>
                      )}
                      {(() => {
                        const c = avatarColor(m.from.address || m.from.name);
                        return (
                          <div
                            className="avatar"
                            style={{
                              background: c.bg,
                              color: c.fg,
                              boxShadow: `inset 0 0 0 1.5px ${c.ring}`,
                            }}
                          >
                            {initials(m.from.name || m.from.address)}
                          </div>
                        );
                      })()}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="meta">
                          <span className="name">{senderLabel(m.from.name, m.from.address)}</span>
                          {showAddressLine(m.from.name, m.from.address) && (
                            <span className="addr">{m.from.address}</span>
                          )}
                          <span className="meta-right">
                            {(() => {
                              const tr = senderTrust(m.meta?.auth);
                              const th = messageThreat(m);
                              const s =
                                th.level === "phishing"
                                  ? {
                                      tone: "bad",
                                      icon: "shieldWarning" as const,
                                      label: "Likely phishing",
                                      detail: th.reason,
                                      show: true,
                                    }
                                  : {
                                      tone: tr.tone,
                                      icon: tr.icon,
                                      label: tr.label,
                                      detail: tr.detail,
                                      show: tr.level !== "unknown",
                                    };
                              if (!s.show) return null;
                              return (
                                <Tooltip label={`${s.label} — ${s.detail}`} side="bottom">
                                  <span className={`trust trust-${s.tone}`} aria-label={s.label}>
                                    <Icon name={s.icon} size={17} weight="duotone" />
                                  </span>
                                </Tooltip>
                              );
                            })()}
                            <span className="when">{fullTime(m.when)}</span>
                            <button
                              className="details-toggle"
                              title="Show details"
                              onClick={() => setDetailsFor(detailsFor === m.id ? null : m.id)}
                            >
                              <Icon name={detailsFor === m.id ? "close" : "more"} size={12} />
                            </button>
                          </span>
                        </div>
                        <div className="meta-sub">
                          {m.to.length > 0 && (
                            <span className="to-line">
                              To: {m.to.map((p) => p.name || p.address).join(", ")}
                            </span>
                          )}
                          {i === 0 && (
                            <span className="mail-chip">
                              <Icon name="folder" size={11} weight="duotone" />{" "}
                              {folderLabel(thread.folder)}
                              {accounts.length > 1 && mailboxLabel ? ` · ${mailboxLabel}` : ""}
                            </span>
                          )}
                        </div>
                        {detailsFor === m.id && (
                          <div className="msg-details">
                            <div>
                              <span>From</span>
                              <b>
                                {m.from.name
                                  ? `${m.from.name} <${m.from.address}>`
                                  : m.from.address}
                              </b>
                            </div>
                            {m.to.length > 0 && (
                              <div>
                                <span>To</span>
                                <b>{m.to.map((p) => p.address).join(", ")}</b>
                              </div>
                            )}
                            {m.meta?.cc && m.meta.cc.length > 0 && (
                              <div>
                                <span>Cc</span>
                                <b>{m.meta.cc.map((p) => p.address).join(", ")}</b>
                              </div>
                            )}
                            <div>
                              <span>Date</span>
                              <b>{fullTime(m.when)}</b>
                            </div>
                            {m.meta?.originIp && (
                              <div>
                                <span>Origin IP</span>
                                <b>{m.meta.originIp}</b>
                              </div>
                            )}
                            {m.meta?.auth && (
                              <div>
                                <span>Authentication</span>
                                <b className={/fail/i.test(m.meta.auth) ? "auth-bad" : "auth-ok"}>
                                  {m.meta.auth}
                                </b>
                              </div>
                            )}
                            {m.meta?.messageId && (
                              <div>
                                <span>Message-ID</span>
                                <b className="mono">{m.meta.messageId}</b>
                              </div>
                            )}
                            {!m.meta && (
                              <div className="msg-details-note">
                                Full headers are captured for IMAP accounts on the next sync.
                              </div>
                            )}
                          </div>
                        )}
                        <EmailBody
                          html={m.bodyHtml}
                          sender={m.from.address}
                          trimQuote={m.id !== oldestMessageId}
                        />
                        {m.attachments && m.attachments.length > 0 && (
                          <>
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
                                      onClick={() =>
                                        downloadAttachment(m.id, a.name, thread.accountId)
                                      }
                                      title={
                                        failed
                                          ? "Download failed — click to retry"
                                          : `Download · ${a.mime} · ${humanSize(a.size)}`
                                      }
                                    >
                                      <Icon
                                        name={busy ? "ai" : failed ? "close" : "attach"}
                                        size={12}
                                      />{" "}
                                      {a.name}{" "}
                                      <span className="attach-size">
                                        {busy ? "downloading…" : humanSize(a.size)}
                                      </span>
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
                            {m.attachments.map((attachment) => (
                              <CalendarAttachmentPanel
                                key={`calendar:${attachment.name}`}
                                accountId={thread.accountId}
                                threadId={thread.id}
                                messageId={m.id}
                                attachment={attachment}
                              />
                            ))}
                          </>
                        )}
                      </div>
                    </div>
                  ))}

                <Composer ref={composerRef} thread={thread} />
              </div>

              <Modal
                open={!!preview}
                onClose={() => setPreview(null)}
                title={preview?.name ?? "Preview"}
                maxWidth={820}
              >
                {preview &&
                  (preview.mime.startsWith("image/") ? (
                    <img
                      src={preview.url}
                      alt={preview.name}
                      style={{
                        maxWidth: "100%",
                        borderRadius: 10,
                        display: "block",
                        margin: "0 auto",
                      }}
                    />
                  ) : (
                    <iframe
                      src={preview.url}
                      title={preview.name}
                      style={{ width: "100%", height: "70vh", border: "none", borderRadius: 10 }}
                    />
                  ))}
              </Modal>
            </motion.div>
          </ReaderDisplayProvider>
        </AnimatePresence>
      </div>
    </section>
  );
}

import { forwardRef, useImperativeHandle } from "react";

const Composer = forwardRef<{ open: (m: Mode, draft?: boolean) => void }, { thread: Thread }>(
  function Composer({ thread }, ref) {
    const queueSend = useApp((s) => s.queueSend);
    const accounts = useApp((s) => s.accounts);
    const editorRef = useRef<RichTextHandle>(null);
    const [mode, setMode] = useState<Mode | null>(null);
    const [to, setTo] = useState("");
    const [cc, setCc] = useState("");
    const [bcc, setBcc] = useState("");
    const [showCc, setShowCc] = useState(false);
    const [files, setFiles] = useState<Attach[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const last = thread.messages[thread.messages.length - 1];

    const open = (m: Mode, draft = false) => {
      setError("");
      setMode(m);
      const from = last?.from.address ?? "";
      const recips = (last?.to ?? []).map((p) => p.address);
      const origCc = (last?.meta?.cc ?? []).map((p) => p.address);
      setBcc("");
      if (m === "reply") {
        setTo(from);
        setCc("");
        setShowCc(false);
      } else if (m === "replyAll") {
        // Reply-all: original sender + other To recipients on the To line,
        // original Cc carried into Cc — all minus yourself, de-duped.
        try {
          const recipients = replyRecipients({
            self: accountAddress(accounts, thread.accountId),
            sender: from,
            to: recips,
            cc: origCc,
          });
          setTo(recipients.to);
          setCc(recipients.cc);
          setShowCc(Boolean(recipients.cc));
        } catch (cause) {
          setMode(null);
          setError(
            cause instanceof Error ? cause.message : "The message account is no longer connected.",
          );
          return;
        }
      } else {
        setTo("");
        setCc("");
        setShowCc(false);
      }
      setTimeout(() => {
        if (m === "forward") {
          editorRef.current?.setHtml(
            `<p></p><p>---------- Forwarded message ----------</p><blockquote>${forwardedHtml(last?.bodyHtml ?? "")}</blockquote>`,
          );
        } else if (draft && thread.aiDraft) {
          editorRef.current?.setHtml(safeDraftHtml(`<p>${thread.aiDraft}</p>`));
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

    const subject =
      mode === "forward"
        ? thread.subject.startsWith("Fwd:")
          ? thread.subject
          : `Fwd: ${thread.subject}`
        : thread.subject.startsWith("Re:")
          ? thread.subject
          : `Re: ${thread.subject}`;

    async function regen() {
      setBusy(true);
      // Only what the person can see goes to the model, and its answer comes back
      // as plain formatting: text in a mail can steer both.
      const text = `Subject: ${thread.subject}\n${thread.messages.map((m) => visibleMailText(m.bodyHtml, 8000)).join("\n")}`;
      editorRef.current?.setHtml(safeDraftHtml(await api.draftReply(thread.id, text)));
      setBusy(false);
    }

    async function send(atTs?: number) {
      const html = editorRef.current?.getHtml() ?? "";
      setError("");
      try {
        await queueSend({
          to,
          cc,
          bcc,
          subject,
          body: html,
          threadId: thread.id,
          sendAt: atTs,
          attachments: files.map(({ name, mime, dataB64 }) => ({ name, mime, dataB64 })),
        });
        // Collapse straight back to the reply bar — the global bottom toast ("Sending…
        // / Scheduled · Undo") is the single confirmation, no inline card.
        setMode(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The message could not be queued.");
      }
    }

    if (!mode) {
      return (
        <>
          {error && (
            <div className="stream-status err" role="alert">
              {error}
            </div>
          )}
          <div className="reply-bar">
            <button className="reply-action" onClick={() => open("reply")}>
              <Icon name="reply" size={15} weight="duotone" /> Reply
            </button>
            <button className="reply-action" onClick={() => open("replyAll")}>
              <Icon name="replyAll" size={15} weight="duotone" /> Reply all
            </button>
            <button className="reply-action" onClick={() => open("forward")}>
              <Icon name="forward" size={15} weight="duotone" /> Forward
            </button>
          </div>
        </>
      );
    }

    const titleMap: Record<Mode, string> = {
      reply: "Reply",
      replyAll: "Reply all",
      forward: "Forward",
    };

    return (
      <div className="composer">
        {error && (
          <div className="stream-status err" role="alert">
            {error}
          </div>
        )}
        <div className="chead">
          <Icon
            name={mode === "forward" ? "forward" : mode === "replyAll" ? "replyAll" : "reply"}
            size={13}
          />{" "}
          {titleMap[mode]}
          <span style={{ marginLeft: "auto" }} />
          <IconButton icon="close" title="Discard" onClick={() => setMode(null)} />
        </div>
        <div className="recip-row">
          <span className="recip-lbl">To</span>
          <RecipientChips value={to} onChange={setTo} placeholder="Add people…" />
          {!showCc && (
            <button
              type="button"
              className="recip-toggle"
              onClick={() => setShowCc(true)}
              title="Add Cc / Bcc"
            >
              Cc / Bcc
            </button>
          )}
        </div>
        {showCc && (
          <div className="recip-row">
            <span className="recip-lbl">Cc</span>
            <RecipientChips value={cc} onChange={setCc} placeholder="Add Cc…" />
          </div>
        )}
        {showCc && (
          <div className="recip-row">
            <span className="recip-lbl">Bcc</span>
            <RecipientChips value={bcc} onChange={setBcc} placeholder="Add Bcc…" />
          </div>
        )}
        <div className="recip-subject">{subject}</div>
        <RichText ref={editorRef} placeholder="Write your message…" minHeight={120} />
        <div className="cfoot">
          <Button onClick={() => send()} icon="send">
            Send
          </Button>
          <SendLater onSchedule={(ts) => send(ts)} />
          <Attachments
            files={files}
            onAdd={(f) => setFiles((p) => [...p, ...f])}
            onRemove={(n) => setFiles((p) => p.filter((x) => x.name !== n))}
          />
          <IconButton icon="ai" weight="duotone" title="Draft / rewrite with AI" onClick={regen} />
          {busy && <span className="ghost-pill">Drafting…</span>}
        </div>
      </div>
    );
  },
);

function humanSize(bytes: number) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
