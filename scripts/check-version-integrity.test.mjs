// Verifies all release manifests carry one authoritative application version.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVersions } from "./check-version-integrity.mjs";

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixtures(packageVersion, tauriVersion, cargoVersion) {
  const dir = mkdtempSync(join(tmpdir(), "bharga-version-"));
  dirs.push(dir);
  const packageJson = join(dir, "package.json");
  const tauriJson = join(dir, "tauri.json");
  const cargoToml = join(dir, "Cargo.toml");
  writeFileSync(packageJson, JSON.stringify({ version: packageVersion }));
  writeFileSync(tauriJson, JSON.stringify({ version: tauriVersion }));
  writeFileSync(cargoToml, `[package]\nname = "fixture"\nversion = "${cargoVersion}"\n`);
  return { packageJson, tauriJson, cargoToml };
}

describe("checkVersions", () => {
  it("rejects divergent package versions", () => {
    expect(() => checkVersions(fixtures("0.1.3", "0.1.2", "0.1.3"))).toThrow("Version mismatch");
  });

  it("returns the shared version", () => {
    expect(checkVersions(fixtures("0.1.3", "0.1.3", "0.1.3"))).toBe("0.1.3");
  });
});
