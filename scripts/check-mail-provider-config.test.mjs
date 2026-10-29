// Verifies community packages remain releasable without bundled OAuth identities.
import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

const script = resolve(import.meta.dir, "check-mail-provider-config.mjs");

function run(overrides = {}) {
  return Bun.spawnSync([process.execPath, script], {
    env: {
      PATH: process.env.PATH ?? "",
      ...overrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("mail provider release configuration", () => {
  it("permits a community package without bundled OAuth client IDs", () => {
    const result = run();

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Community package");
    expect(result.stdout.toString()).toContain("Gmail and Microsoft sign-in disabled");
    expect(result.stderr.toString()).toBe("");
  });

  it("reports an official package when both public client IDs are configured", () => {
    const result = run({
      BHARGA_GMAIL_CLIENT_ID: "google-public-client-id",
      BHARGA_MS_CLIENT_ID: "microsoft-public-client-id",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Official package");
    expect(result.stdout.toString()).toContain("Gmail and Microsoft sign-in enabled");
    expect(result.stdout.toString()).not.toContain("google-public-client-id");
    expect(result.stdout.toString()).not.toContain("microsoft-public-client-id");
  });
});
