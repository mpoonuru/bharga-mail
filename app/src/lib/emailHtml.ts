import DOMPurify, { type Config } from "dompurify";
import { assessLink, type LinkAssessment } from "@/lib/linkRisk";
import { avatarColor } from "@/lib/colors";
import { initials } from "@/lib/avatar";

/**
 * Email HTML pipeline (the standard mail-client approach):
 *   1. sanitize() — strip scripts, handlers, javascript: URIs, meta-refresh, forms.
 *   2. highlightEntities() — AI-inbox flourish: wrap dates, percentages, money, and
 *      urgency/sentiment words in <mark data-kind> so they get a soft gradient.
 *   3. block remote images — privacy (tracking pixels), opt-in via "Load images".
 * Steps 2–3 run on a single parsed document; the body is then rendered inside a
 * sandboxed, CSP-locked iframe.
 */

const SANITIZE_OPTS: Config = {
  ADD_TAGS: ["style"],
  ADD_ATTR: ["target"],
  FORBID_TAGS: ["script", "iframe", "object", "embed", "base", "form", "noscript", "meta", "link"],
  FORBID_ATTR: ["ping", "formaction", "form"],
  ALLOW_UNKNOWN_PROTOCOLS: false,
};

export function sanitizeEmail(html: string): string {
  return DOMPurify.sanitize(html, SANITIZE_OPTS) as unknown as string;
}

// Ordered so the `data-kind` maps to the capture-group index.
const KINDS = ["money", "percent", "date", "urgent", "negative", "positive"] as const;
const PATTERNS: RegExp[] = [
  /(?:[$€£]\s?\d[\d.,]*)|(?:\b\d[\d.,]*\s?(?:eur|usd|gbp)\b)/i,
  /\b\d+(?:\.\d+)?\s?%/,
  /\b(?:today|tomorrow|tonight|yesterday|(?:mon|tues?|wed(?:nes)?|thurs?|fri|satur?|sun)(?:day)?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/i,
  /\b(?:urgent|asap|immediately|deadline|critical|overdue|action required)\b/i,
  /\b(?:issue|problem|delay(?:ed|s)?|not happy|unhappy|complaint|fail(?:ed|ure|s)?|cannot|can't|unable|sorry|apologi[sz]e)\b/i,
  /\b(?:thanks|thank you|great|happy|appreciate|excellent|perfect|confirmed|approved|welcome|congrat)\b/i,
];

function highlightEntities(doc: Document) {
  const combined = new RegExp(PATTERNS.map((re) => `(${re.source})`).join("|"), "gi");
  const skip = new Set(["A", "STYLE", "SCRIPT", "CODE", "PRE", "MARK", "HEAD", "TITLE", "TEXTAREA", "BUTTON", "DETAILS"]);
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let el = node.parentElement;
      while (el) {
        if (skip.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        el = el.parentElement;
      }
      return node.nodeValue && node.nodeValue.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const targets: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) targets.push(n as Text);

  let count = 0;
  for (const node of targets) {
    if (count > 250) break;
    const text = node.nodeValue ?? "";
    combined.lastIndex = 0;
    let m: RegExpExecArray | null;
    let last = 0;
    let matched = false;
    const frag = doc.createDocumentFragment();
    while ((m = combined.exec(text)) && count <= 250) {
      matched = true;
      count++;
      const kind = KINDS[m.slice(1).findIndex((g) => g !== undefined)] ?? "date";
      if (m.index > last) frag.appendChild(doc.createTextNode(text.slice(last, m.index)));
      const mark = doc.createElement("mark");
      mark.setAttribute("data-kind", kind);
      mark.textContent = m[0];
      frag.appendChild(mark);
      last = m.index + m[0].length;
    }
    if (matched) {
      if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
      node.parentNode?.replaceChild(frag, node);
    }
  }
}

function blockRemoteInDoc(doc: Document): number {
  let blocked = 0;
  doc.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    if (/^https?:/i.test(src)) {
      img.setAttribute("data-blocked-src", src);
      img.removeAttribute("src");
      img.removeAttribute("srcset");
      blocked++;
    }
  });
  doc.querySelectorAll<HTMLElement>("[style*='url(']").forEach((el) => {
    const style = el.getAttribute("style") ?? "";
    if (/url\(\s*['"]?https?:/i.test(style)) {
      el.setAttribute("style", style.replace(/url\(\s*['"]?https?:[^)]*\)/gi, "none"));
      blocked++;
    }
  });
  return blocked;
}

// ---- Dark-mode colour adaptation -------------------------------------------
// Emails ship their own colours assuming a white background, so a fixed light
// default isn't enough: an email that hardcodes dark text (color:#333) becomes
// dark-on-dark in dark mode. We luminance-map the email's OWN colours instead —
// lighten dark text, neutralise near-white backgrounds — so any email is legible
// in dark mode while emails that already use light-on-dark are left untouched.

const NAMED: Record<string, [number, number, number]> = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0],
  blue: [0, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192],
  navy: [0, 0, 128], maroon: [128, 0, 0], dimgray: [105, 105, 105], dimgrey: [105, 105, 105],
};

function parseColor(raw: string): [number, number, number, number] | null {
  const v = raw.trim().toLowerCase();
  if (v === "transparent") return [0, 0, 0, 0];
  if (NAMED[v]) { const [r, g, b] = NAMED[v]; return [r, g, b, 1]; }
  let m = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return [r, g, b, a];
    }
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (m) {
    const p = m[1].split(",").map((x) => x.trim());
    if (p.length >= 3) {
      const r = parseFloat(p[0]), g = parseFloat(p[1]), b = parseFloat(p[2]);
      const a = p.length >= 4 ? parseFloat(p[3]) : 1;
      if ([r, g, b].every((n) => !Number.isNaN(n))) return [r, g, b, a];
    }
  }
  return null;
}

function relLum([r, g, b]: [number, number, number, number]): number {
  const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Rewrite the colour declarations in a chunk of CSS text (inline style attr or a
 *  <style> block) for dark mode. */
function adaptCssText(css: string): string {
  css = css.replace(/(^|[;{}\s])color\s*:\s*([^;}!]+)/gi, (full, pre, val) => {
    const c = parseColor(val);
    return c && c[3] !== 0 && relLum(c) < 0.5 ? `${pre}color: #e7e8ec` : full;
  });
  css = css.replace(/(^|[;{}\s])background(-color)?\s*:\s*([^;}!]+)/gi, (full, pre, _bc, val) => {
    const c = parseColor(val);
    return c && c[3] !== 0 && relLum(c) > 0.7 ? `${pre}background-color: transparent` : full;
  });
  return css;
}

function adaptForDark(doc: Document): void {
  doc.querySelectorAll("style").forEach((s) => { if (s.textContent) s.textContent = adaptCssText(s.textContent); });
  doc.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
    const st = el.getAttribute("style");
    if (st) el.setAttribute("style", adaptCssText(st));
  });
  // Legacy presentational attributes.
  doc.querySelectorAll<HTMLElement>("[color],[bgcolor],[text]").forEach((el) => {
    for (const attr of ["color", "text"]) {
      const c = parseColor(el.getAttribute(attr) ?? "");
      if (c && c[3] !== 0 && relLum(c) < 0.5) el.setAttribute(attr, "#e7e8ec");
    }
    const bg = parseColor(el.getAttribute("bgcolor") ?? "");
    if (bg && bg[3] !== 0 && relLum(bg) > 0.7) el.removeAttribute("bgcolor");
  });
}

// ---- Quoted-history collapsing (Gmail "•••" behaviour) ---------------------
// Real mail clients show only the NEW content of a reply and tuck the quoted
// history below it behind an expander. We do the same: detect the boundary
// between the reply and the quote, then wrap the quote in a native <details> so
// it collapses with NO JavaScript (the email iframe is script-less; <details>
// is handled by the browser UA). Heuristics mirror Gmail/Apple Mail.

// Known quote containers across providers.
const QUOTE_CONTAINERS =
  ".gmail_quote, blockquote[type='cite'], .moz-cite-prefix, .yahoo_quoted, #divRplyFwdMsg, #appendonsend, #x_divRplyFwdMsg, #x_appendonsend";
// "On <date>, <name> wrote:" + de/fr/it/es equivalents.
const REPLY_HEADER = /^\s*(on\b.+\bwrote:|am\b.+\bschrieb.*:|le\b.+\ba\s+écrit\s*:|il\b.+\bha\s+scritto\s*:|el\b.+\bescribió\s*:)\s*$/i;
// Outlook forwarded/replied header block (From/Sent/Subject, localized). No \b
// before "subject" because the lines often run together (<br>-joined text has no
// space, e.g. "…meSubject:").
const FWD_HEADER = /\b(from|von|da|de):.*\b(sent|gesendet|inviato|enviado|date):.*(subject|betreff|oggetto|objet|asunto):/i;
// A line of underscores/dashes used as a divider.
const DIVIDER = /^[\s_–—-]{8,}$/;

function isDivider(el: Element): boolean {
  return el.tagName === "HR" || DIVIDER.test((el.textContent ?? "").trim());
}

function findQuoteBoundary(doc: Document): Element | null {
  const body = doc.body;
  // 1) Known quote containers — pick the earliest in document order.
  const containers = [...body.querySelectorAll(QUOTE_CONTAINERS)];
  if (containers.length) {
    return containers.reduce((best, el) =>
      best.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING ? el : best);
  }
  const blocks = [...body.querySelectorAll("p,div,blockquote,span,td,hr,font,pre")];
  // 2) A divider line immediately followed by a reply/forward header.
  for (let i = 0; i < blocks.length; i++) {
    if (!isDivider(blocks[i])) continue;
    const after = blocks.slice(i + 1, i + 6).map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim()).join(" ");
    if (REPLY_HEADER.test(after.slice(0, 140)) || FWD_HEADER.test(after)) return blocks[i];
  }
  // 3) A reply/forward header on its own (prefer a divider right before it).
  for (const el of blocks) {
    const own = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!own) continue;
    if (REPLY_HEADER.test(own) || FWD_HEADER.test(own)) {
      const prev = el.previousElementSibling;
      return prev && isDivider(prev) ? prev : el;
    }
  }
  return null;
}

/** Pull the quoted sender + date + depth out of the quote header so the collapsed
 *  node can show WHO wrote the earlier message (not a faceless "•••"). */
function extractQuoteMeta(raw: string): { who: string; when: string; count: number } {
  // Strip divider runs first — "________From:" would otherwise hide the \b before
  // "from" (underscore is a word char), so the sender wouldn't parse.
  const t = raw.replace(/[_]{2,}|[-–—]{2,}/g, " ").replace(/\s+/g, " ").slice(0, 800);
  let who = "";
  let when = "";
  // Outlook: "From: NAME <…>"  +  "Sent/Date: …"
  const from = t.match(/\b(?:from|von|da|de):\s*([^<\n]+?)\s*(?:<|sent:|gesendet:|inviato:|enviado:|date:|$)/i);
  if (from?.[1]) who = from[1].trim();
  const sent = t.match(/\b(?:sent|gesendet|inviato|enviado|date):\s*(.+?)(?:\s*\b(?:to|an|à|para|cc):|$)/i);
  if (sent?.[1]) when = sent[1].trim();
  // Gmail: "On <when>, <who> wrote:"
  if (!who || !when) {
    const on = t.match(/\bon\b\s+(.+?)\s+wrote:/i);
    if (on?.[1]) {
      const seg = on[1].replace(/<[^>]+>/g, "").trim();
      const lc = seg.lastIndexOf(",");
      if (lc > -1) { if (!when) when = seg.slice(0, lc).trim(); if (!who) who = seg.slice(lc + 1).trim(); }
      else if (!who) who = seg;
    }
  }
  if (who.includes("@")) who = (who.split("@")[0] ?? "").replace(/[._-]+/g, " ").trim();
  who = who.replace(/["']/g, "").trim().slice(0, 28);
  if (who && who === who.toLowerCase()) who = who.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  // Shorten the date to "Mon DD" when we can find it.
  const dm = when.match(/\b([A-Z][a-z]{2,8})\.?\s+(\d{1,2})\b/);
  when = dm ? `${dm[1]} ${dm[2]}` : when.slice(0, 18).trim();
  const count = ((t.match(/\b(?:from|von|da|de):/gi)?.length) ?? 0) + ((t.match(/\bwrote:/gi)?.length) ?? 0);
  return { who: who || "Earlier messages", when, count: Math.max(1, count) };
}

/** Collapse quoted history into a <details>, presented as a Bharga "thread node"
 *  (the earlier sender's avatar bead + name + date on a spine) rather than a
 *  generic "•••". Returns true if anything collapsed. */
function collapseQuotes(doc: Document): boolean {
  const boundary = findQuoteBoundary(doc);
  if (!boundary?.parentNode) return false;
  // Don't collapse a pure forward (no real new content above the quote) — there'd
  // be nothing left to show. A short reply like "Thanks!" must still collapse.
  try {
    const range = doc.createRange();
    range.setStart(doc.body, 0);
    range.setEndBefore(boundary);
    if (range.toString().replace(/\s+/g, "").length < 3) return false;
  } catch { return false; }

  const details = doc.createElement("details");
  details.className = "bh-quoted";
  const summary = doc.createElement("summary");
  summary.className = "bh-qnode";
  summary.setAttribute("title", "Show earlier messages");
  details.appendChild(summary);
  boundary.parentNode.insertBefore(details, boundary);
  // Move the boundary and everything after it (within this parent) into <details>.
  while (details.nextSibling) details.appendChild(details.nextSibling);

  // Build the node from the quoted header now that the quote is inside <details>.
  const meta = extractQuoteMeta(details.textContent ?? "");
  const paint = avatarColor(meta.who);
  const bead = doc.createElement("span");
  bead.className = "bh-qbead";
  bead.textContent = initials(meta.who);
  bead.setAttribute("style", `background:${paint.bg};color:${paint.fg};box-shadow:0 0 0 1.5px ${paint.ring}`);
  const label = doc.createElement("span");
  label.className = "bh-qtext";
  const who = doc.createElement("b");
  who.textContent = meta.who;
  label.appendChild(who);
  if (meta.when) label.appendChild(doc.createTextNode(` · ${meta.when}`));
  if (meta.count > 1) {
    const c = doc.createElement("span");
    c.className = "bh-qcount";
    c.textContent = ` · +${meta.count - 1} more`;
    label.appendChild(c);
  }
  const chev = doc.createElement("span");
  chev.className = "bh-qchev";
  chev.textContent = "›";
  summary.append(bead, label, chev);
  return true;
}

/** Flag risky links in-place (data-risk + data-real for the iframe CSS / click
 *  interceptor) and return the risky ones for the warning banner. */
function scanLinksInDoc(doc: Document, senderDomain?: string): LinkAssessment[] {
  const risky: LinkAssessment[] = [];
  doc.querySelectorAll("a[href]").forEach((a) => {
    const r = assessLink(a.getAttribute("href") ?? "", (a.textContent ?? "").trim(), senderDomain);
    if (r && r.level !== "safe") {
      a.setAttribute("data-risk", r.level);
      a.setAttribute("data-real", r.host);
      risky.push(r);
    }
  });
  return risky;
}

export function processEmail(
  html: string,
  opts: { showImages: boolean; highlight: boolean; dark?: boolean; sender?: string },
): { html: string; blocked: number; links: LinkAssessment[] } {
  const doc = new DOMParser().parseFromString(sanitizeEmail(html), "text/html");
  try { collapseQuotes(doc); } catch { /* never let quote-collapsing break rendering */ }
  if (opts.dark) {
    try { adaptForDark(doc); } catch { /* never let adaptation break rendering */ }
  }
  if (opts.highlight) {
    try { highlightEntities(doc); } catch { /* never let highlighting break rendering */ }
  }
  let links: LinkAssessment[] = [];
  try { links = scanLinksInDoc(doc, opts.sender?.split("@")[1]?.toLowerCase()); } catch { /* never let link-scan break rendering */ }
  const blocked = opts.showImages ? 0 : blockRemoteInDoc(doc);
  return { html: doc.body.innerHTML, blocked, links };
}
