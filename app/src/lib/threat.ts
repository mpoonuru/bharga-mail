// Phase-3: a thread/message threat verdict that COMBINES the two signals we
// already compute separately — sender authentication (SPF/DKIM/DMARC, see
// senderTrust) and deterministic link risk (see linkRisk). Failed auth on its
// own is noisy (lots of legit bulk mail fails DMARC); a deceptive link on its
// own might be a forwarded joke. Together they're a strong phishing signal — so
// we escalate the trust shield to red "Likely phishing" only when they coincide.

import type { Message, Thread } from "@/types";
import { senderTrust } from "@/lib/senderTrust";
import { scanLinks } from "@/lib/linkRisk";

export type ThreatLevel = "none" | "suspicious" | "phishing";
export interface Threat {
  level: ThreatLevel;
  reason: string;
}

const ANCHOR = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const LURE = /\b(verify|suspend|unusual activity|confirm your|update your|password|account will be|sign\s?in|log\s?in|unauthori[sz]ed|act now)\b/i;

function anchors(html: string): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  ANCHOR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANCHOR.exec(html)) && out.length < 50) {
    out.push({ href: m[1] ?? "", text: (m[2] ?? "").replace(/<[^>]+>/g, " ").trim() });
  }
  return out;
}

/** Threat verdict for a single message. */
export function messageThreat(m: Message): Threat {
  const trust = senderTrust(m.meta?.auth);
  const authFailed = trust.level === "failed";
  const html = m.bodyHtml ?? "";
  const senderDomain = m.from.address.split("@")[1];
  const risky = scanLinks(anchors(html), senderDomain);
  const dangerous = risky.some((r) => r.level === "dangerous");
  const lure = LURE.test(html.replace(/<[^>]+>/g, " "));

  // Strongest: failed auth + any deceptive link, OR a dangerous link in a lure.
  if ((authFailed && risky.length > 0) || (dangerous && (authFailed || lure))) {
    return { level: "phishing", reason: authFailed ? "Failed authentication with a deceptive link" : "Deceptive link in an urgent message" };
  }
  if (dangerous) return { level: "suspicious", reason: "Contains a deceptive link" };
  if (authFailed && lure) return { level: "suspicious", reason: "Failed authentication with a sign-in lure" };
  if (risky.length > 0) return { level: "suspicious", reason: "Contains a risky link" };
  return { level: "none", reason: "" };
}

// Tiny cache so re-renders (e.g. deriveChips over the inbox) don't re-scan bodies.
const cache = new Map<string, Threat>();
function cached(key: string, compute: () => Threat): Threat {
  const hit = cache.get(key);
  if (hit) return hit;
  const v = compute();
  if (cache.size > 400) cache.clear();
  cache.set(key, v);
  return v;
}

/** Threat verdict for a thread (judged from its most recent message). */
export function threadThreat(t: Thread): Threat {
  const last = t.messages[t.messages.length - 1];
  if (!last) return { level: "none", reason: "" };
  return cached(`${t.id}:${last.bodyHtml?.length ?? 0}`, () => messageThreat(last));
}
