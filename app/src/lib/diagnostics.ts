// Strict aggregation boundary for support exports: identifiers and content cannot cross it.
import type { Account, AiModel, AiRole } from "@/types";
import { FONTS, LOCALES } from "@/lib/prefs";

export interface DiagnosticsInput {
  version: string;
  runtime: "desktop" | "preview";
  accounts: Account[];
  models: AiModel[];
  preferences: {
    theme: string;
    density: string;
    font: string;
    locale: string;
  };
  threadCount: number;
  taskCount: number;
}

export interface DiagnosticsSnapshot {
  schemaVersion: 1;
  app: { version: string; runtime: "desktop" | "preview" };
  accounts: { total: number; byProvider: Record<string, number>; synced: number };
  ai: { providers: number; ready: number; roleCoverage: Record<AiRole, number> };
  preferences: { theme: string; density: string; font: string; locale: string };
  localData: { threads: number; tasks: number };
}

const AI_ROLES: AiRole[] = ["triage", "embeddings", "summarize", "draft", "agent"];
const ACCOUNT_PROVIDERS = ["gmail", "microsoft", "jmap", "imap"] as const;
const THEMES = new Set(["dark", "light"]);
const DENSITIES = new Set(["compact", "cozy", "comfy"]);
const FONTS_ALLOWED = new Set(FONTS.map((font) => font.value));
const LOCALES_ALLOWED = new Set(LOCALES.map((locale) => locale.value));

function allowlisted(value: string, allowed: Set<string>): string {
  return allowed.has(value) ? value : "unknown";
}

function safeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function safeVersion(value: string): string {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value) ? value : "unknown";
}

export function buildRedactedDiagnostics(input: DiagnosticsInput): DiagnosticsSnapshot {
  const providerCounts = new Map<string, number>();
  for (const account of input.accounts) {
    const provider = ACCOUNT_PROVIDERS.includes(account.provider as typeof ACCOUNT_PROVIDERS[number])
      ? account.provider
      : "unknown";
    providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
  }
  const byProvider = Object.fromEntries([...providerCounts.entries()].sort(([left], [right]) => left.localeCompare(right)));
  const roleCoverage = Object.fromEntries(AI_ROLES.map((role) => [
    role,
    input.models.filter((model) => model.roles.includes(role)).length,
  ])) as Record<AiRole, number>;

  return {
    schemaVersion: 1,
    app: { version: safeVersion(input.version), runtime: input.runtime },
    accounts: {
      total: input.accounts.length,
      byProvider,
      synced: input.accounts.filter((account) => typeof account.lastSyncAt === "number").length,
    },
    ai: {
      providers: safeCount(input.models.length),
      ready: safeCount(input.models.filter((model) => model.ready).length),
      roleCoverage,
    },
    preferences: {
      theme: allowlisted(input.preferences.theme, THEMES),
      density: allowlisted(input.preferences.density, DENSITIES),
      font: allowlisted(input.preferences.font, FONTS_ALLOWED),
      locale: allowlisted(input.preferences.locale, LOCALES_ALLOWED),
    },
    localData: { threads: safeCount(input.threadCount), tasks: safeCount(input.taskCount) },
  };
}

export function serializeDiagnostics(snapshot: DiagnosticsSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
