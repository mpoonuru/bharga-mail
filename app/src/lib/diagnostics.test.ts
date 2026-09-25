// Security-boundary tests ensure hostile state is bucketed rather than exported verbatim.
import { describe, expect, it } from "vitest";

import { buildRedactedDiagnostics, serializeDiagnostics } from "@/lib/diagnostics";

describe("redacted diagnostics", () => {
  it("exports useful diagnostics without identifiers or content", () => {
    const snapshot = buildRedactedDiagnostics({
      version: "0.1.3",
      runtime: "desktop",
      accounts: [{ id: "secret-id", email: "person@company.test", provider: "imap", displayName: "Finance", unread: 7, lastSyncAt: 1_700_000_000 }],
      models: [{ id: "private-provider", label: "Company endpoint", kind: "custom", ready: true, endpoint: "https://private.test", roles: ["draft"] }],
      preferences: { theme: "dark", density: "cozy", font: "inter", locale: "en" },
      threadCount: 18,
      taskCount: 3,
    });
    const json = serializeDiagnostics(snapshot);
    const parsed = JSON.parse(json) as Record<string, unknown>;

    expect(Object.keys(parsed)).toEqual(["schemaVersion", "app", "accounts", "ai", "preferences", "localData"]);
    expect(parsed.accounts).toEqual({ total: 1, byProvider: { imap: 1 }, synced: 1 });
    expect(parsed.ai).toEqual({
      providers: 1,
      ready: 1,
      roleCoverage: { triage: 0, embeddings: 0, summarize: 0, draft: 1, agent: 0 },
    });
    expect(json.endsWith("\n")).toBe(true);
    for (const secret of ["secret-id", "person@company.test", "Finance", "private-provider", "Company endpoint", "private.test"]) {
      expect(json).not.toContain(secret);
    }
  });

  it("buckets hostile categorical values and bounds numeric values", () => {
    const hostile = "private-value@example.test";
    const snapshot = buildRedactedDiagnostics({
      version: hostile,
      runtime: "desktop",
      accounts: [{ id: "id", email: "mail", provider: hostile as "imap", displayName: "", unread: 0 }],
      models: [],
      preferences: { theme: hostile, density: hostile, font: hostile, locale: hostile },
      threadCount: -10,
      taskCount: Number.NaN,
    });
    const json = serializeDiagnostics(snapshot);

    expect(snapshot.app.version).toBe("unknown");
    expect(snapshot.accounts.byProvider).toEqual({ unknown: 1 });
    expect(snapshot.preferences).toEqual({ theme: "unknown", density: "unknown", font: "unknown", locale: "unknown" });
    expect(snapshot.localData).toEqual({ threads: 0, tasks: 0 });
    expect(json).not.toContain(hostile);
  });
});
