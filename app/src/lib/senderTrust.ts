// Sender trust — turns a message's raw SPF/DKIM/DMARC summary (meta.auth, parsed
// by the Rust IMAP sync from the Authentication-Results header) into a single,
// human verdict + shield. DMARC is the authoritative, alignment-aware check;
// SPF/DKIM are supporting signals. We never claim "verified" without DMARC pass.

import type { IconName } from "@/components/icons";

export type TrustLevel = "verified" | "caution" | "failed" | "unknown";

export interface SenderTrust {
  level: TrustLevel;
  icon: Extract<IconName, "shieldCheck" | "shieldWarning">;
  /** short label, e.g. "Verified sender" */
  label: string;
  /** longer rationale for the tooltip, e.g. "SPF · DKIM · DMARC all passed" */
  detail: string;
  /** styling tone */
  tone: "ok" | "warn" | "bad" | "muted";
}

/** Pull a single mechanism's result out of "spf=pass; dkim=fail; dmarc=none". */
function result(auth: string, key: string): string | null {
  const m = auth.toLowerCase().match(new RegExp(`${key}\\s*=\\s*([a-z]+)`));
  return m?.[1] ?? null;
}

const isPass = (v: string | null) => v === "pass";
const isFail = (v: string | null) =>
  v === "fail" || v === "softfail" || v === "permerror" || v === "temperror" || v === "reject" || v === "quarantine";

/** Compute a sender-trust verdict from a compact auth summary. */
export function senderTrust(auth?: string | null): SenderTrust {
  if (!auth || !auth.trim()) {
    return {
      level: "unknown",
      icon: "shieldWarning",
      label: "Unverified",
      detail: "No authentication results on this message.",
      tone: "muted",
    };
  }

  const spf = result(auth, "spf");
  const dkim = result(auth, "dkim");
  const dmarc = result(auth, "dmarc");

  const detail =
    ([["SPF", spf], ["DKIM", dkim], ["DMARC", dmarc]] as const)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k} ${v}`)
      .join(" · ") || "Authentication results present.";

  // Strongest signal: DMARC passes with an aligned SPF or DKIM → genuinely verified.
  if (isPass(dmarc) && (isPass(spf) || isPass(dkim))) {
    return { level: "verified", icon: "shieldCheck", label: "Verified sender", detail, tone: "ok" };
  }
  // Hard failure: DMARC failed, or both SPF and DKIM failed → likely spoofed.
  if (isFail(dmarc) || (isFail(spf) && isFail(dkim))) {
    return { level: "failed", icon: "shieldWarning", label: "Failed authentication", detail: `${detail} — this message may be spoofed.`, tone: "bad" };
  }
  // Something passes but no DMARC alignment → partial trust.
  if (isPass(spf) || isPass(dkim)) {
    return { level: "caution", icon: "shieldWarning", label: "Partly verified", detail: `${detail} — not fully aligned.`, tone: "warn" };
  }
  // Auth present but nothing passed.
  return { level: "failed", icon: "shieldWarning", label: "Failed authentication", detail: `${detail} — this message may be spoofed.`, tone: "bad" };
}
