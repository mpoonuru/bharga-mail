import DOMPurify, { type Config } from "dompurify";
import { assessLink, type LinkAssessment } from "@/lib/linkRisk";
import { isHiddenElement, stripBlocks } from "@/lib/mailText";

/**
 * Email HTML pipeline (the standard mail-client approach):
 *   1. sanitize() — strip scripts, handlers, javascript: URIs, meta-refresh, forms.
 *   2. highlightEntities() — AI-inbox flourish: wrap addresses, phone and reference
 *      numbers, dates, percentages, money, and urgency/privacy/security/sentiment
 *      words of the message's own text (not quoted history) in <mark data-kind>.
 *   3. block remote content — privacy: nothing the message would fetch by itself
 *      (images in any form, media, CSS references) loads until "Load images";
 *      tracking pixels stay unloaded even then.
 * Steps 2–3 run on a single parsed document; the body is then rendered inside a
 * sandboxed, CSP-locked iframe.
 */

const SANITIZE_OPTS: Config = {
  ADD_TAGS: ["style"],
  ADD_ATTR: ["target"],
  FORBID_TAGS: [
    "script",
    "iframe",
    "object",
    "embed",
    "base",
    "form",
    "noscript",
    "meta",
    "link",
    "map",
    "area",
  ],
  FORBID_ATTR: ["ping", "formaction", "form", "xlink:href"],
  ALLOW_UNKNOWN_PROTOCOLS: false,
};

export function sanitizeEmail(html: string): string {
  return DOMPurify.sanitize(html, SANITIZE_OPTS) as unknown as string;
}

// Messages are sanitized as whole documents so the <head> <style> block survives:
// most newsletters keep their text colours, fonts and layout there, and dropping
// it leaves only the inline table backgrounds — dark text on a dark card.
const SANITIZE_DOC_OPTS: Config = { ...SANITIZE_OPTS, WHOLE_DOCUMENT: true };

// DOMPurify deletes any element whose text looks like markup (`<u`, `<!--`), and a
// <style> is no exception — so one CSS comment such as "/* … the <u> wrapper … */"
// or the legacy `<!-- … -->` wrapper around a newsletter's rules discards the whole
// stylesheet. Both are ignorable in CSS, so drop them from style blocks first; any
// other markup-like text still makes DOMPurify remove the block.
function stripStyleMarkupNoise(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let from = 0;
  for (;;) {
    const open = lower.indexOf("<style", from);
    if (open < 0) break;
    const openEnd = html.indexOf(">", open);
    if (openEnd < 0) break;
    const close = lower.indexOf("</style", openEnd);
    if (close < 0) break;
    const css = stripBlocks(html.slice(openEnd + 1, close), "/*", "*/")
      .split("<!--")
      .join("")
      .split("-->")
      .join("");
    out += html.slice(from, openEnd + 1) + css;
    from = close;
  }
  return out + html.slice(from);
}

// <body> attributes a message may carry into the reader frame. Everything else
// (event handlers, the `background` image URL) stays behind.
const BODY_ATTRS = ["class", "style", "bgcolor", "text", "link", "vlink", "alink", "dir", "lang"];

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function bodyAttributes(body: HTMLElement): string {
  return BODY_ATTRS.map((name) => {
    const value = body.getAttribute(name);
    return value === null ? "" : ` ${name}="${escapeAttr(value)}"`;
  }).join("");
}

// Ordered so the `data-kind` maps to the capture-group index. Specific shapes
// (addresses, numbers) come before word lists, so "192.168.1.10" is an address
// and not a date, and "fraud" is a security term rather than plain sentiment.
const KINDS = [
  "email",
  "phone",
  "ref",
  "money",
  "percent",
  "date",
  "urgent",
  "sensitive",
  "security",
  "negative",
  "positive",
] as const;
// Every quantifier over mail text is bounded: the text is the sender's, and an
// open-ended one makes a long run of "a.a.a.…" take quadratic time.
const PATTERNS: RegExp[] = [
  /\b[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,8}\.[a-z]{2,24}\b/i,
  /\+\d[\d\s()./-]{6,24}\d/,
  // IPv4 addresses, and labelled reference numbers ("Invoice no. 2026-0042").
  /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:invoice|order|ticket|case|reference|ref|tracking|booking|customer|rechnungs?|bestell|auftrags?|kunden|vorgangs?)[\s-]?(?:no\.?|nr\.?|number|nummer|id)?\s?[:#]?\s?(?=[a-z0-9-]{0,40}\d)[a-z0-9][a-z0-9-]{3,40}\b/i,
  /(?:[$€£]\s?\d[\d.,]{0,24})|(?:\b\d[\d.,]{0,24}\s?(?:eur|usd|gbp)\b)/i,
  /\b\d+(?:\.\d+)?\s?%/,
  /\b(?:today|tomorrow|tonight|yesterday|(?:mon|tues?|wed(?:nes)?|thurs?|fri|satur?|sun)(?:day)?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/i,
  /\b(?:urgent|asap|immediately|deadline|critical|overdue|action required|dringend|sofort|frist|fällig)\b/i,
  // Privacy: credentials and personal data the reader should handle with care.
  /\b(?:passwords?|passwort|kennwort|passcode|otp|one[- ]time (?:code|password)|verification code|security code|2fa|api key|confidential|vertraulich|do not (?:share|forward)|personal data|gdpr|dsgvo|datenschutz|data protection|privacy(?! policy| notice| statement| settings)|iban|credit card|kreditkarte|passport|social security)\b/i,
  // Abuse and security: reports, threats and account or legal trouble.
  /\b(?:abuse|spam|phishing|scam|fraud(?:ulent)?|malware|ransomware|virus|hack(?:ed|ing)?|compromised|unauthori[sz]ed|suspicious|data breach|breach|leak(?:ed)?|suspend(?:ed|sion)?|blocked|blacklist(?:ed)?|takedown|violations?|infring(?:ement|ing|es?)|legal action|lawsuit|chargeback|betrug|missbrauch|gesperrt|abmahnung|mahnung)\b/i,
  /\b(?:issue|problem|delay(?:ed|s)?|not happy|unhappy|complaint|fail(?:ed|ure|s)?|cannot|can't|unable|sorry|apologi[sz]e)\b/i,
  /\b(?:thanks|thank you|great|happy|appreciate|excellent|perfect|confirmed|approved|welcome|congrat)\b/i,
];

// Quoted history is someone else's earlier mail: highlighting it again buries
// what is new in this message.
const QUOTE_ANCESTORS = "blockquote, .gmail_quote, .yahoo_quoted, .moz-cite-prefix";

function highlightEntities(doc: Document) {
  const combined = new RegExp(PATTERNS.map((re) => `(${re.source})`).join("|"), "gi");
  const skip = new Set([
    "A",
    "STYLE",
    "SCRIPT",
    "CODE",
    "PRE",
    "MARK",
    "HEAD",
    "TITLE",
    "TEXTAREA",
    "BUTTON",
  ]);
  // The quoted tail (reply/forward header and everything after it), when the
  // message also has text of its own.
  const quoted = new Set<Element>();
  for (let el = quotedTailStart(doc); el; el = el.nextElementSibling) quoted.add(el);
  const inQuote = (el: Element | null) => {
    if (el?.closest(QUOTE_ANCESTORS)) return true;
    for (let cur = el; cur; cur = cur.parentElement) if (quoted.has(cur)) return true;
    return false;
  };
  // Addresses usually arrive as mailto: links, whose text the walker skips.
  doc.querySelectorAll("a[href]").forEach((a) => {
    if (/^mailto:/i.test(a.getAttribute("href") ?? "") && !inQuote(a))
      a.setAttribute("data-hl", "email");
  });
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let el = node.parentElement;
      if (inQuote(el)) return NodeFilter.FILTER_REJECT;
      while (el) {
        if (skip.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        el = el.parentElement;
      }
      return node.nodeValue && node.nodeValue.trim().length > 0
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
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

// A reference the reader would fetch: anything with a scheme other than the
// self-contained ones, or a protocol-relative "//host". Control characters and
// spaces are dropped first, as a browser does ("ht\ttps://…", " https:/host"),
// and a backslash counts as a slash ("\\host\path" loads from //host/path).
function isRemoteRef(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const cleaned = value.replace(/[\u0000- ]/g, "").replace(/\\/g, "/");
  if (/^(?:data|cid|blob|about):/i.test(cleaned)) return false;
  return /^(?:[a-z][a-z0-9+.-]{0,30}:|\/\/)/i.test(cleaned);
}
// The same inside CSS: every url(…) that is not a data: URI or a fragment, and
// quoted remote strings (image-set("https://…"), @import "https://…"). CSS
// escapes ("\68ttps:") are not decoded, so a url() is held back unless it is
// plainly self-contained. Bounded so hostile CSS stays linear.
const CSS_REMOTE_URL = /url\(\s*['"]?(?!\s*(?:data:|#))[^)]{0,2000}\)/gi;
const CSS_REMOTE_STRING = /(['"])(?:https?:)?\/\/[^'"]{0,2000}\1/gi;
// Every element and attribute that loads something by itself. Links (<a href>)
// are not here: they load nothing until activated, and never open from the reader.
const REMOTE_ELEMENTS =
  "img,picture source,video,audio,source,track,input,embed,image,use,feImage,[background],[poster]";
const REMOTE_ATTRS = ["src", "srcset", "poster", "background", "href", "xlink:href"];
const BLANK_PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

function blockRemoteCss(css: string): { css: string; hits: number } {
  let hits = 0;
  const count = (replacement: string) => () => {
    hits++;
    return replacement;
  };
  return {
    css: css.replace(CSS_REMOTE_URL, count("none")).replace(CSS_REMOTE_STRING, count('""')),
    hits,
  };
}

/** Strip everything the message would fetch by itself: images in any form
 *  (src, srcset, legacy background attributes, SVG images), audio and video,
 *  and remote references in inline styles and stylesheets. */
function blockRemoteInDoc(doc: Document): number {
  let blocked = 0;
  doc.querySelectorAll(REMOTE_ELEMENTS).forEach((el) => {
    let hit = false;
    for (const attr of REMOTE_ATTRS) {
      const value = el.getAttribute(attr);
      if (value === null) continue;
      // A srcset is a list; one remote candidate is enough to drop it.
      const remote =
        attr === "srcset"
          ? value.split(",").some((candidate) => isRemoteRef(candidate))
          : isRemoteRef(value);
      if (!remote) continue;
      if (attr === "src" && el.tagName === "IMG") el.setAttribute("data-blocked-src", value);
      el.removeAttribute(attr);
      hit = true;
    }
    if (hit) {
      if (el.tagName === "IMG") el.removeAttribute("srcset");
      blocked++;
    }
  });
  doc.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
    const result = blockRemoteCss(el.getAttribute("style") ?? "");
    if (result.hits > 0) {
      el.setAttribute("style", result.css);
      blocked++;
    }
  });
  // Stylesheets can pull remote images too (background-image in a <style> block).
  doc.querySelectorAll("style").forEach((el) => {
    const result = blockRemoteCss(el.textContent ?? "");
    if (result.hits > 0) {
      el.textContent = result.css;
      blocked += result.hits;
    }
  });
  return blocked;
}

/** True for an image that exists to report the open, not to be seen: 1–2 px in
 *  either direction, or hidden outright. */
function isTrackingPixel(img: Element): boolean {
  const style = img.getAttribute("style") ?? "";
  if (
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?\s*(?:;|$))/i.test(
      style,
    )
  )
    return true;
  return ["width", "height"].some((name) => {
    const inline = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*(\\d{1,5}(?:\\.\\d{1,3})?)px`, "i").exec(
      style,
    );
    const raw = inline?.[1] ?? img.getAttribute(name) ?? "";
    return /^\s*\d{1,5}(?:\.\d{1,3})?\s*(?:px)?\s*$/i.test(raw) && parseFloat(raw) <= 2;
  });
}

/** With images allowed, tracking pixels still stay unloaded: they show nothing
 *  and only tell the sender that, when and from where the mail was opened. */
function dropTrackingPixels(doc: Document): number {
  let dropped = 0;
  doc.querySelectorAll("img").forEach((img) => {
    if (!isRemoteRef(img.getAttribute("src") ?? "") || !isTrackingPixel(img)) return;
    img.setAttribute("src", BLANK_PIXEL);
    img.removeAttribute("srcset");
    dropped++;
  });
  return dropped;
}

// ---- Hidden content ----------------------------------------------------------
// Text the sender put in the message but styled so the reader never sees it.
// Short hidden "preheader" lines are normal in newsletters; long hidden text,
// hidden links and direction-override characters are how a mail says one thing
// to the person and another to a filter, a search or an AI summary.

export interface HiddenContent {
  /** Characters of hidden text (whitespace and zero-width padding not counted). */
  textChars: number;
  /** The start of the hidden text, for showing it to the person. */
  sample: string;
  /** Links inside hidden parts. */
  links: number;
  /** Direction-override characters in visible text (they reorder what is shown,
   *  e.g. "invoice‮fdp.exe" reads as "invoiceexe.pdf"). */
  directionOverrides: number;
}

const PADDING_CHARS = /\s|\u00ad|\u034f|[\u200b-\u200d]|\u2060|\ufeff/g;
const DIRECTION_OVERRIDES = /[\u202a-\u202e\u2066-\u2069]/g;
/** Hidden text up to this length is treated as an ordinary preheader. */
export const HIDDEN_TEXT_NOTICE_CHARS = 300;

function detectHidden(doc: Document): HiddenContent {
  const found: HiddenContent = { textChars: 0, sample: "", links: 0, directionOverrides: 0 };
  const samples: string[] = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const el = node as Element;
      if (el.tagName === "STYLE" || el.tagName === "SCRIPT") return NodeFilter.FILTER_REJECT;
      // Count a hidden part once, at its outermost element; do not descend.
      return isHiddenElement(el) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  // Document order: a nested hidden element can only sit inside the one before.
  const hidden: Element[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node as Element;
    if (!hidden[hidden.length - 1]?.contains(el)) hidden.push(el);
  }
  for (const el of hidden) {
    const text = el.textContent ?? "";
    const meaningful = text.replace(PADDING_CHARS, "").length;
    found.textChars += meaningful;
    found.links += el.matches("a[href]") ? 1 : el.querySelectorAll("a[href]").length;
    if (meaningful > 0) samples.push(text.replace(/\s+/g, " ").trim());
  }
  found.sample = samples.join(" … ").slice(0, 280);
  found.directionOverrides = (doc.body.textContent ?? "").match(DIRECTION_OVERRIDES)?.length ?? 0;
  return found;
}

/** Whether the hidden content is worth telling the person about. */
export function hiddenContentIsNotable(hidden: HiddenContent): boolean {
  return (
    hidden.links > 0 || hidden.directionOverrides > 0 || hidden.textChars > HIDDEN_TEXT_NOTICE_CHARS
  );
}

// ---- Dark-mode colour adaptation -------------------------------------------
// Emails ship their own colours assuming a white background, so a fixed light
// default isn't enough: an email that hardcodes dark text (color:#333) becomes
// dark-on-dark in dark mode. We luminance-map the email's OWN colours instead —
// lighten dark text, neutralise near-white backgrounds — so any email is legible
// in dark mode while emails that already use light-on-dark are left untouched.

const NAMED: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  silver: [192, 192, 192],
  navy: [0, 0, 128],
  maroon: [128, 0, 0],
  dimgray: [105, 105, 105],
  dimgrey: [105, 105, 105],
};

function parseColor(raw: string): [number, number, number, number] | null {
  const v = raw.trim().toLowerCase();
  if (v === "transparent") return [0, 0, 0, 0];
  if (NAMED[v]) {
    const [r, g, b] = NAMED[v];
    return [r, g, b, 1];
  }
  let m = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3)
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16),
        g = parseInt(h.slice(2, 4), 16),
        b = parseInt(h.slice(4, 6), 16);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return [r, g, b, a];
    }
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (m) {
    const p = m[1].split(",").map((x) => x.trim());
    if (p.length >= 3) {
      const r = parseFloat(p[0]),
        g = parseFloat(p[1]),
        b = parseFloat(p[2]);
      const a = p.length >= 4 ? parseFloat(p[3]) : 1;
      if ([r, g, b].every((n) => !Number.isNaN(n))) return [r, g, b, a];
    }
  }
  return null;
}

function relLum([r, g, b]: [number, number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
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

/** True when the message paints its own dark canvas (body bgcolor, body inline
 *  style, or a `body`/`html` rule in a stylesheet). Such emails are already designed
 *  for dark, so their colours — brand reds, blues — must be left exactly as sent. */
function declaresDarkCanvas(doc: Document): boolean {
  const isDark = (raw: string | null | undefined) => {
    const c = raw ? parseColor(raw) : null;
    return !!c && c[3] !== 0 && relLum(c) < 0.2;
  };
  const body = doc.body;
  if (isDark(body.getAttribute("bgcolor"))) return true;
  const inline = /background(?:-color)?\s*:\s*([^;!]+)/i.exec(body.getAttribute("style") ?? "");
  if (isDark(inline?.[1])) return true;
  for (const style of doc.querySelectorAll("style")) {
    for (const rule of (style.textContent ?? "").matchAll(
      /(?:^|[}\s,])(?:html|body)\s{0,20}\{([^}]{0,2000})\}/gi,
    )) {
      const bg = /background(?:-color)?\s*:\s*([^;!}]+)/i.exec(rule[1]);
      if (isDark(bg?.[1])) return true;
    }
  }
  return false;
}

function adaptForDark(doc: Document): void {
  if (declaresDarkCanvas(doc)) return;
  doc.querySelectorAll("style").forEach((s) => {
    if (s.textContent) s.textContent = adaptCssText(s.textContent);
  });
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

// Conversation cards: when the message a reply quotes is ALREADY shown as its own
// card above, the embedded copy is redundant, so remove it (just the tail — never
// an accordion, never the original message). Conservative: only acts on a clear
// quote container or header, and never strips when there's no new content above.
const TRIM_CONTAINERS =
  ".gmail_quote, blockquote[type='cite'], .moz-cite-prefix, .yahoo_quoted, #divRplyFwdMsg, #appendonsend, #x_divRplyFwdMsg, #x_appendonsend";
// Reply and forward headers, as steps that must match one after the other. They
// are searched step by step (see matchesInOrder) rather than as one `a.*b.*c`
// expression: on hostile text such as "from: sent: from: sent: …" a single
// expression retries every combination and stalls the reader for minutes.
const TRIM_FWD_STEPS = [
  /\b(?:from|von|da):/gi,
  /\b(?:sent|gesendet|inviato|date):/gi,
  /(?:subject|betreff|oggetto|objet|asunto):/gi,
];
const TRIM_REPLY_STEPS = [
  [/\bon\b/gi, /\bwrote:/gi],
  [/am\b/gi, /\bschrieb/gi, /:/gi],
  [/il\b/gi, /\bha\s+scritto:/gi],
  [/le\b/gi, /\ba\s+écrit\s*:/gi],
  [/el\b/gi, /\bescribió\s*:/gi],
];

/** True when every step matches, each one after the end of the one before. One
 *  pass over the text per step, so the cost stays linear in its length. */
function matchesInOrder(text: string, steps: RegExp[]): boolean {
  let from = 0;
  for (const step of steps) {
    step.lastIndex = from;
    const match = step.exec(text);
    if (!match) return false;
    from = match.index + match[0].length;
  }
  return true;
}

function isQuoteHeader(text: string): boolean {
  return (
    TRIM_REPLY_STEPS.some((steps) => matchesInOrder(text, steps)) ||
    matchesInOrder(text, TRIM_FWD_STEPS)
  );
}

/** First element of the quoted tail, or null when there is none or when nothing
 *  new stands above it (a bare forward is the message, not history). */
function quotedTailStart(doc: Document): Element | null {
  let b: Element | null = doc.body.querySelector(TRIM_CONTAINERS);
  if (!b) {
    for (const el of doc.body.querySelectorAll("p,div,blockquote,td,font,pre")) {
      const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (t && isQuoteHeader(t)) {
        b = el;
        break;
      }
    }
  }
  if (!b?.parentNode) return null;
  // Pull preceding dividers/empties so the separator doesn't linger.
  let s: Element = b;
  for (
    let p = s.previousElementSibling;
    p &&
    (p.tagName === "HR" ||
      /^[\s_–—-]{6,}$/.test((p.textContent ?? "").trim()) ||
      ((p.textContent ?? "").trim() === "" && !p.querySelector("img,table")));
    p = s.previousElementSibling
  )
    s = p;
  // Never strip if there's essentially no new content above (would blank the card).
  try {
    const r = doc.createRange();
    r.setStart(doc.body, 0);
    r.setEndBefore(s);
    if (r.toString().replace(/\s+/g, "").length < 3) return null;
  } catch {
    return null;
  }
  return s;
}

function trimQuotedTail(doc: Document): void {
  const s = quotedTailStart(doc);
  if (!s) return;
  const parent = s.parentNode;
  if (!parent) return;
  while (s.nextSibling) parent.removeChild(s.nextSibling);
  parent.removeChild(s);
}

export function processEmail(
  html: string,
  opts: {
    showImages: boolean;
    highlight: boolean;
    dark?: boolean;
    sender?: string;
    trimQuote?: boolean;
  },
): {
  html: string;
  /** The message's own <head> <style> blocks, to place after the reader's base CSS. */
  headStyles: string;
  /** Safe attributes of the message's <body>, serialized for the reader's <body> tag. */
  bodyAttrs: string;
  blocked: number;
  /** Tracking pixels kept unloaded although images are shown. */
  trackers: number;
  /** Text, links and characters the sender hid from the reader. */
  hidden: HiddenContent;
  links: LinkAssessment[];
} {
  const sanitized = DOMPurify.sanitize(
    stripStyleMarkupNoise(html),
    SANITIZE_DOC_OPTS,
  ) as unknown as string;
  const doc = new DOMParser().parseFromString(sanitized, "text/html");
  let hidden: HiddenContent = { textChars: 0, sample: "", links: 0, directionOverrides: 0 };
  try {
    hidden = detectHidden(doc);
  } catch {
    /* never let detection break rendering */
  }
  if (opts.trimQuote) {
    try {
      trimQuotedTail(doc);
    } catch {
      /* never let trimming break rendering */
    }
  }
  if (opts.dark) {
    try {
      adaptForDark(doc);
    } catch {
      /* never let adaptation break rendering */
    }
  }
  if (opts.highlight) {
    try {
      highlightEntities(doc);
    } catch {
      /* never let highlighting break rendering */
    }
  }
  let links: LinkAssessment[] = [];
  try {
    links = scanLinksInDoc(doc, opts.sender?.split("@")[1]?.toLowerCase());
  } catch {
    /* never let link-scan break rendering */
  }
  // Nothing in the frame may be navigable: where the app's click target does not
  // cover a link (odd layout, the box limit), a click must still go nowhere. The
  // reader works from data-href.
  doc.querySelectorAll("a[href], area[href]").forEach((a) => {
    a.setAttribute("data-href", a.getAttribute("href") ?? "");
    a.removeAttribute("href");
    a.removeAttribute("target");
  });
  let blocked = 0;
  let trackers = 0;
  try {
    if (opts.showImages) trackers = dropTrackingPixels(doc);
    else blocked = blockRemoteInDoc(doc);
  } catch {
    // Failing open would load what the reader promised to hold back.
    doc.body.textContent = "This message could not be displayed safely.";
  }
  // Collect every stylesheet the message carries. They normally live in <head>,
  // but a parser is allowed to hoist a <style> into <body>; scanning the whole
  // document means the reader still gets them after its base CSS. Strip them
  // from the body afterwards so the frame injects exactly one copy.
  const styleEls = Array.from(doc.querySelectorAll("style"));
  const headStyles = styleEls.map((style) => style.outerHTML).join("");
  for (const style of styleEls) style.remove();
  return {
    html: doc.body.innerHTML,
    headStyles,
    bodyAttrs: bodyAttributes(doc.body),
    blocked,
    trackers,
    hidden,
    links,
  };
}
