// Phishing / dangerous-link detection — Phase 1: deterministic, instant, local,
// zero AI cost. Scans the links in a message for the classic phishing tells and
// returns a verdict + plain-English reasons. (Phase 2 layers the local AI model's
// judgment on top; this is the always-on baseline that needs no model configured.)

export type RiskLevel = "safe" | "suspicious" | "dangerous";

export interface LinkAssessment {
  href: string;
  /** anchor display text */
  text: string;
  /** registrable domain the link actually goes to (eTLD+1) */
  host: string;
  level: RiskLevel;
  /** why it was flagged, in plain language */
  reasons: string[];
}

// TLDs disproportionately used for abuse / look-alikes.
const SUSPICIOUS_TLDS = new Set(["zip", "mov", "top", "xyz", "gq", "tk", "ml", "cf", "country", "click", "link", "rest", "fit", "review"]);
// Commonly-impersonated brands.
const BRANDS = ["paypal", "apple", "icloud", "microsoft", "outlook", "office365", "google", "gmail", "amazon", "netflix", "facebook", "instagram", "whatsapp", "dhl", "fedex", "ups", "stripe", "coinbase", "binance", "linkedin", "telekom", "sparkasse"];
// Credential / urgency lures.
const LURE = /\b(verify|login|log[-\s]?in|sign[-\s]?in|account|password|secure|update|confirm|suspend|unlock|billing|payment|invoice|wallet|reset|bank)\b/i;

// Lightweight eTLD+1. Not a full Public Suffix List, but covers the common
// two-level TLDs (co.uk, com.au, …) well enough for a phishing heuristic.
const TWO_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const last = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  if (last.length === 2 && TWO_LEVEL.has(second)) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** If the visible link text itself contains a domain, return its registrable form. */
function domainInText(text: string): string | null {
  const m = text.match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i);
  if (!m?.[1] || !/\.[a-z]{2,}$/i.test(m[1])) return null;
  return registrableDomain(m[1]);
}

const RANK: Record<RiskLevel, number> = { safe: 0, suspicious: 1, dangerous: 2 };

/** Assess a single link. Returns null for non-web links (mailto/tel/anchors). */
export function assessLink(href: string, text: string, senderDomain?: string): LinkAssessment | null {
  let url: URL;
  try { url = new URL(href); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase();
  const reg = registrableDomain(host);
  const reasons: string[] = [];
  let level: RiskLevel = "safe";
  const bump = (l: RiskLevel) => { if (RANK[l] > RANK[level]) level = l; };

  // Userinfo trick: http://paypal.com@evil.ru — the real host is after the '@'.
  if (url.username || url.password) { reasons.push("Hides its real destination using '@' in the address"); bump("dangerous"); }
  // Raw IP instead of a named domain.
  if (IPV4.test(host)) { reasons.push("Points to a raw IP address, not a domain"); bump("suspicious"); }
  // Punycode / homograph look-alikes.
  if (host.split(".").some((l) => l.startsWith("xn--"))) { reasons.push("Uses a look-alike (punycode) domain"); bump("dangerous"); }

  // The classic tell: link text shows one domain, href goes to another.
  const textDom = domainInText(text);
  if (textDom && textDom !== reg) { reasons.push(`Text says “${textDom}” but it actually goes to “${reg}”`); bump("dangerous"); }

  // Brand impersonation. A domain is the brand's only when the registrable
  // domain's main label EXACTLY equals the brand (paypal.com / paypal.de) — not
  // merely contains it. This catches embedded look-alikes the old substring test
  // let through, e.g. "secure-paypal-login.com" or "paypal.com.evil.ru".
  const hay = `${text} ${url.pathname}`.toLowerCase();
  const regLabel = reg.split(".")[0] ?? "";
  const brand = BRANDS.find((b) => hay.includes(b) || reg.includes(b));
  if (brand && regLabel !== brand) {
    reasons.push(`Mentions “${brand}” but the real domain is “${reg}”`);
    // Embedding the brand inside the domain, or pairing it with a sign-in lure,
    // is a strong phishing signal.
    bump(reg.includes(brand) || LURE.test(hay) ? "dangerous" : "suspicious");
  }

  // Sign-in request over plain http.
  if (url.protocol === "http:" && LURE.test(hay)) { reasons.push("Asks you to sign in over an unencrypted (http) link"); bump("suspicious"); }

  // Abuse-prone TLD.
  const tld = reg.split(".").pop() ?? "";
  if (SUSPICIOUS_TLDS.has(tld)) { reasons.push(`Unusual top-level domain (.${tld})`); bump("suspicious"); }

  // Slight nudge if it claims to sign you in somewhere other than the sender's domain.
  if (senderDomain && reg !== registrableDomain(senderDomain) && LURE.test(hay) && level === "safe") {
    reasons.push(`Sign-in link to “${reg}”, not the sender’s domain`);
    bump("suspicious");
  }

  return { href, text, host: reg, level, reasons };
}

/** Assess many (href,text) pairs; returns only the risky ones, worst first. */
export function scanLinks(links: { href: string; text: string }[], senderDomain?: string): LinkAssessment[] {
  return links
    .map((l) => assessLink(l.href, l.text, senderDomain))
    .filter((a): a is LinkAssessment => !!a && a.level !== "safe")
    .sort((a, b) => RANK[b.level] - RANK[a.level]);
}
