import DOMPurify, { type Config } from "dompurify";

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
  const skip = new Set(["A", "STYLE", "SCRIPT", "CODE", "PRE", "MARK", "HEAD", "TITLE", "TEXTAREA", "BUTTON"]);
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

export function processEmail(
  html: string,
  opts: { showImages: boolean; highlight: boolean },
): { html: string; blocked: number } {
  const doc = new DOMParser().parseFromString(sanitizeEmail(html), "text/html");
  if (opts.highlight) {
    try { highlightEntities(doc); } catch { /* never let highlighting break rendering */ }
  }
  const blocked = opts.showImages ? 0 : blockRemoteInDoc(doc);
  return { html: doc.body.innerHTML, blocked };
}
