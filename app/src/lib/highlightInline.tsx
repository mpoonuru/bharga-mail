import type { ReactNode } from "react";

// Lightweight inline entity highlighter for the AI summary line in the mail list.
// Wraps money, percentages, and dates in styled <mark> pills. This is a compact
// cousin of the full body highlighter in emailHtml.ts — safe (no HTML injection,
// returns React nodes) and cheap enough to run per row.

const MONEY = /[$€£]\s?\d[\d.,]*/;
const PERCENT = /\d+(?:\.\d+)?\s?%/;
const DATE = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s?\d{1,2}(?:,?\s?\d{4})?\b/;
const COMBINED = new RegExp(`(${MONEY.source}|${PERCENT.source}|${DATE.source})`, "gi");

function kindOf(match: string): "money" | "percent" | "date" {
  if (/[$€£]/.test(match)) return "money";
  if (/%/.test(match)) return "percent";
  return "date";
}

/** Split `text` into React nodes, wrapping detected entities in highlight pills. */
export function highlightInline(text: string): ReactNode[] {
  if (!text) return [];
  const out: ReactNode[] = [];
  const re = new RegExp(COMBINED.source, "gi");
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <mark key={key++} className={`hl hl-${kindOf(m[0])}`}>
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-length matches
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
