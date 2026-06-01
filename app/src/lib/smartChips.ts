// Smart chips — Bharga's AI-first answer to Gmail's fixed Primary/Promotions/
// Social tabs. Instead of one global, fixed taxonomy that every mailbox is
// forced into, chips are DERIVED from *this* inbox and are MULTI-LABEL: a
// single thread can belong to several chips at once (an airline receipt is both
// "Receipts" and, once it clusters, "Lufthansa"). Selecting chips filters the
// stream to their union.
//
// Two kinds of chip:
//   • signal — structural/AI signals already in the data model (urgent, meeting,
//     receipt, newsletter, awaiting-reply, has-attachment, AI-drafted).
//   • org    — emergent clusters discovered from sender domains. Only surfaced
//     once an org forms a real cluster (>= CLUSTER_MIN threads), so the bar
//     stays calm instead of exploding into one chip per sender.
//
// This runs purely on already-synced data (no network, no API cost). It's the
// seed the heavier on-device taxonomy (embeddings clustering + local triage)
// plugs into later — same SmartChip shape, smarter membership.

import type { Thread } from "@/types";
import type { IconName } from "@/components/icons";

export interface SmartChip {
  /** stable id within a render (e.g. "urgent", "org:Stripe") */
  id: string;
  /** human label shown on the chip */
  label: string;
  icon: IconName;
  kind: "signal" | "org";
  /** total threads matching this chip in the current view */
  count: number;
  /** unread threads among the matches (drives the "N new" badge) */
  unread: number;
  /** one-line rationale shown on hover — AI-first should always explain itself */
  why: string;
  /** membership predicate; in-memory only (chips are derived per render, never serialized) */
  test: (t: Thread) => boolean;
}

// Only surface an org once it forms a real cluster — avoids one chip per sender.
const CLUSTER_MIN = 2;

// Nice-cased names for common senders; everything else is title-cased from its
// second-level domain.
const WELL_KNOWN: Record<string, string> = {
  github: "GitHub", gitlab: "GitLab", openai: "OpenAI", chatgpt: "ChatGPT", anthropic: "Anthropic",
  google: "Google", gmail: "Google", youtube: "YouTube", linkedin: "LinkedIn", twitter: "X",
  amazon: "Amazon", apple: "Apple", icloud: "Apple", microsoft: "Microsoft", outlook: "Microsoft",
  stripe: "Stripe", paypal: "PayPal", slack: "Slack", notion: "Notion", figma: "Figma",
  vercel: "Vercel", netflix: "Netflix", spotify: "Spotify", uber: "Uber", airbnb: "Airbnb",
  booking: "Booking", lufthansa: "Lufthansa", dhl: "DHL",
};

function senderAddr(t: Thread): string {
  const last = t.messages[t.messages.length - 1];
  return last?.from.address ?? t.participants[0] ?? "";
}

/** Friendly org/brand name from a sender address' domain, or null if none. */
export function orgFromAddress(addr: string): string | null {
  const at = addr.indexOf("@");
  if (at < 0) return null;
  const parts = addr.slice(at + 1).toLowerCase().split(".").filter(Boolean);
  if (parts.length < 2) return null;
  const sld = parts[parts.length - 2]; // second-level domain (mail.github.com -> github)
  if (!sld) return null;
  return WELL_KNOWN[sld] ?? sld.charAt(0).toUpperCase() + sld.slice(1);
}

function hasAttachment(t: Thread): boolean {
  return t.messages?.some((m) => m.attachments && m.attachments.length > 0) ?? false;
}

/**
 * Derive the smart-chip set for a list of threads.
 * @param threads  the threads currently in view (chips reflect this scope)
 * @param selfDomain  the user's own domain, excluded from org clustering
 */
export function deriveChips(threads: Thread[], selfDomain?: string): SmartChip[] {
  if (!threads.length) return [];
  const chips: SmartChip[] = [];

  const add = (
    id: string, label: string, icon: IconName, kind: SmartChip["kind"],
    why: string, test: (t: Thread) => boolean,
  ) => {
    let count = 0, unread = 0;
    for (const t of threads) if (test(t)) { count++; if (t.unread) unread++; }
    if (count > 0) chips.push({ id, label, icon, kind, count, unread, why, test });
  };

  // --- signal chips (structural + existing AI labels) ---
  add("urgent", "Urgent", "priority", "signal", "Flagged urgent by AI triage", (t) => t.labels.includes("urgent"));
  add("meetings", "Meetings", "calendar", "signal", "Scheduling / meeting requests", (t) => t.labels.includes("meeting") || t.view.includes("calendar"));
  add("receipts", "Receipts", "receipts", "signal", "Payments, invoices & receipts", (t) => t.labels.includes("receipt") || t.view.includes("receipts"));
  add("newsletters", "Newsletters", "newsletters", "signal", "Digests & subscriptions", (t) => t.labels.includes("newsletter") || t.view.includes("newsletters"));
  add("awaiting", "Awaiting reply", "awaiting", "signal", "You're expected to respond", (t) => t.view.includes("awaiting"));
  add("ai-drafted", "AI drafted", "ai", "signal", "Has a ready AI-written reply", (t) => !!t.aiDraft);
  add("attachments", "Attachments", "attach", "signal", "Includes files", hasAttachment);

  // --- emergent org clusters (the inbox-specific, AI-first part) ---
  const byOrg = new Map<string, number>();
  for (const t of threads) {
    const a = senderAddr(t);
    if (selfDomain && a.toLowerCase().endsWith("@" + selfDomain)) continue;
    const org = orgFromAddress(a);
    if (org) byOrg.set(org, (byOrg.get(org) ?? 0) + 1);
  }
  for (const [org, n] of byOrg) {
    if (n < CLUSTER_MIN) continue;
    add(`org:${org}`, org, "folder", "org", `${n} threads from ${org}`, (t) => orgFromAddress(senderAddr(t)) === org);
  }

  // Rank by volume, then unread; on ties, signals lead org clusters.
  chips.sort((a, b) => b.count - a.count || b.unread - a.unread || (a.kind === b.kind ? 0 : a.kind === "signal" ? -1 : 1));
  return chips;
}
