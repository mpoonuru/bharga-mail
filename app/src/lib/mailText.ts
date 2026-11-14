// Text extraction from untrusted mail HTML. Everything here runs in time linear
// in the input: a regex such as /<[^>]+>/ rescans from every "<" and stalls the
// app on a body that is one long run of them.
import DOMPurify from "dompurify";

/** Upper bound on how much of one message any scanner looks at. */
export const MAIL_SCAN_CHARS = 200_000;

/** Replace every `<…>` tag with a space. An unclosed "<" keeps its text. */
export function stripTags(html: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const open = html.indexOf("<", from);
    if (open < 0) return out + html.slice(from);
    const close = html.indexOf(">", open + 1);
    if (close < 0) return out + html.slice(from);
    out += `${html.slice(from, open)} `;
    from = close + 1;
  }
}

/** Remove each block that starts with `open` and ends with `close` (content
 *  included, case-insensitive). An unclosed block keeps its text. */
export function stripBlocks(html: string, open: string, close: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let from = 0;
  for (;;) {
    const start = lower.indexOf(open, from);
    if (start < 0) return out + html.slice(from);
    const end = lower.indexOf(close, start + open.length);
    if (end < 0) return out + html.slice(from);
    out += `${html.slice(from, start)} `;
    from = end + close.length;
  }
}

const HIDING_STYLE =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|font-size\s*:\s*0(?:\.0+)?(?:px|pt|em|rem|%)?\s*(?:!important\s*)?(?:;|$)|opacity\s*:\s*0(?:\.0+)?\s*(?:!important\s*)?(?:;|$)|(?:max-)?(?:height|width)\s*:\s*0(?:px)?\s*(?:!important\s*)?(?:;|$)|color\s*:\s*transparent)/i;

/** True when the element is styled so its text is never shown. Inline styles and
 *  the `hidden` attribute only; a class rule in a stylesheet is not seen here. */
export function isHiddenElement(el: Element): boolean {
  return el.hasAttribute("hidden") || HIDING_STYLE.test(el.getAttribute("style") ?? "");
}

/** The text a person actually sees in a message: no markup, no stylesheet text,
 *  nothing from hidden elements. This is what may be handed to an AI model, so a
 *  mail cannot slip it instructions the reader never saw. */
export function visibleMailText(html: string, maxChars: number): string {
  const clean = DOMPurify.sanitize(html.slice(0, MAIL_SCAN_CHARS), {
    FORBID_TAGS: ["style", "script", "head", "title", "template"],
  }) as unknown as string;
  const doc = new DOMParser().parseFromString(clean, "text/html");
  for (const el of Array.from(doc.body.querySelectorAll("*"))) {
    if (el.isConnected && isHiddenElement(el)) el.remove();
  }
  return (doc.body.textContent ?? "")
    .replace(/[​-‏‪-‮⁠⁦-⁩﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

// The only formatting a model-written draft needs. No attributes at all: no
// links, no images, nothing that can load or point anywhere.
const DRAFT_TAGS = ["p", "br", "b", "strong", "i", "em", "u", "ul", "ol", "li", "blockquote"];

/** Model output is untrusted too: text in the mail can steer it. Reduce a draft
 *  to plain formatting before it is placed in the editor. */
export function safeDraftHtml(draft: string): string {
  return DOMPurify.sanitize(draft, {
    ALLOWED_TAGS: DRAFT_TAGS,
    ALLOWED_ATTR: [],
  }) as unknown as string;
}
