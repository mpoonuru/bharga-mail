// Strict aggregation boundary for support exports: identifiers and content cannot cross it.
import type { Account, AiModel, AiRole } from "@/types";

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

export function buildRedactedDiagnostics(input: DiagnosticsInput): DiagnosticsSnapshot {
  const providerCounts = new Map<string, number>();
  for (const account of input.accounts) {
    providerCounts.set(account.provider, (providerCounts.get(account.provider) ?? 0) + 1);
  }
  const byProvider = Object.fromEntries([...providerCounts.entries()].sort(([left], [right]) => left.localeCompare(right)));
  const roleCoverage = Object.fromEntries(AI_ROLES.map((role) => [
    role,
    input.models.filter((model) => model.roles.includes(role)).length,
  ])) as Record<AiRole, number>;

  return {
    schemaVersion: 1,
    app: { version: input.version, runtime: input.runtime },
    accounts: {
      total: input.accounts.length,
      byProvider,
      synced: input.accounts.filter((account) => account.lastSyncAt !== undefined).length,
    },
    ai: {
      providers: input.models.length,
      ready: input.models.filter((model) => model.ready).length,
      roleCoverage,
    },
    preferences: { ...input.preferences },
    localData: { threads: input.threadCount, tasks: input.taskCount },
  };
}

export function serializeDiagnostics(snapshot: DiagnosticsSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
