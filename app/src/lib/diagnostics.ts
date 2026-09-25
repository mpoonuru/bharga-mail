// Strict aggregation boundary for support exports: identifiers and content cannot cross it.
import dayjs from "dayjs";

import type { Account, AiModel, AiRole, CalendarSource, CalendarSyncHealth } from "@/types";
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
  calendar?: {
    sources: CalendarSource[];
    selectedCalendarCount: number;
    health: CalendarSyncHealth[];
  };
}

export interface DiagnosticsSnapshot {
  schemaVersion: 1;
  app: { version: string; runtime: "desktop" | "preview" };
  accounts: { total: number; byProvider: Record<string, number>; synced: number };
  ai: { providers: number; ready: number; roleCoverage: Record<AiRole, number> };
  preferences: { theme: string; density: string; font: string; locale: string };
  localData: { threads: number; tasks: number };
  calendar: {
    sources: number;
    selectedCalendars: number;
    byProvider: Record<string, number>;
    capabilities: string[];
    status: { ready: number; reconnect: number; error: number };
    pending: number;
    conflicts: number;
    lastSuccess: Record<string, number>;
    errorCategories: Record<string, number>;
  };
}

const AI_ROLES: AiRole[] = ["triage", "embeddings", "summarize", "draft", "agent"];
const ACCOUNT_PROVIDERS = ["gmail", "microsoft", "jmap", "imap"] as const;
const THEMES = new Set(["dark", "light"]);
const DENSITIES = new Set(["compact", "cozy", "comfy"]);
const FONTS_ALLOWED = new Set(FONTS.map((font) => font.value));
const LOCALES_ALLOWED = new Set(LOCALES.map((locale) => locale.value));
const CALENDAR_PROVIDERS = new Set(["local", "calDav", "google", "microsoft"]);
const CALENDAR_CAPABILITIES = new Set(["syncCollection", "scheduling"]);

function allowlisted(value: string, allowed: Set<string>): string {
  return allowed.has(value) ? value : "unknown";
}

function safeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function safeVersion(value: string): string {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value) ? value : "unknown";
}

function countBy(values: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function lastSuccessBucket(timestamp: number | null, now: number): string {
  if (!timestamp) return "never";
  const age = Math.max(0, now - timestamp);
  if (age < 60 * 60) return "lastHour";
  if (age < 24 * 60 * 60) return "lastDay";
  if (age < 7 * 24 * 60 * 60) return "lastWeek";
  return "older";
}

function calendarErrorCategory(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized.includes("auth") || normalized.includes("credential") || normalized.includes("permission")) return "authorization";
  if (normalized.includes("rate")) return "rateLimited";
  if (normalized.includes("network") || normalized.includes("server") || normalized.includes("timeout")) return "connectivity";
  if (normalized.includes("storage")) return "storage";
  if (normalized.includes("conflict") || normalized.includes("precondition")) return "conflict";
  return "other";
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
  const calendarSources = input.calendar?.sources ?? [];
  const calendarHealth = input.calendar?.health ?? [];
  const now = dayjs().unix();
  const calendarProviders = calendarSources.map((source) => CALENDAR_PROVIDERS.has(source.provider) ? source.provider : "unknown");
  const capabilities = [...new Set(calendarSources.flatMap((source) => source.capabilities).filter((capability) => CALENDAR_CAPABILITIES.has(capability)))].sort();
  const healthBySource = new Map(calendarHealth.map((health) => [health.sourceId, health]));
  const lastSuccess = countBy(calendarSources.map((source) => lastSuccessBucket(source.lastSyncAt, now)));
  const errorCategories = countBy(calendarSources.flatMap((source) => {
    const category = calendarErrorCategory(source.syncError ?? healthBySource.get(source.id)?.errorCode ?? null);
    return category ? [category] : [];
  }));

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
    calendar: {
      sources: calendarSources.length,
      selectedCalendars: safeCount(input.calendar?.selectedCalendarCount ?? 0),
      byProvider: countBy(calendarProviders),
      capabilities,
      status: {
        ready: calendarSources.filter((source) => source.authState === "ready" && !source.syncError).length,
        reconnect: calendarSources.filter((source) => source.authState === "reauthorizationRequired").length,
        error: calendarSources.filter((source) => source.authState === "error" || !!source.syncError).length,
      },
      pending: safeCount(calendarHealth.reduce((total, health) => total + health.pendingCount, 0)),
      conflicts: safeCount(calendarHealth.reduce((total, health) => total + health.conflictCount, 0)),
      lastSuccess,
      errorCategories,
    },
  };
}

export function serializeDiagnostics(snapshot: DiagnosticsSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
