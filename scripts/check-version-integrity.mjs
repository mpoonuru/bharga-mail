// Release guard: all package manifests must advertise one application version.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function jsonVersion(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed.version !== "string" || !parsed.version.trim()) {
    throw new Error(`Missing version in ${path}`);
  }
  return parsed.version.trim();
}

function cargoVersion(path) {
  const source = readFileSync(path, "utf8");
  const marker = source.indexOf("[package]");
  if (marker < 0) throw new Error(`Missing [package] section in ${path}`);
  const packageBody = source.slice(marker + "[package]".length);
  const nextSection = packageBody.search(/^\s*\[/m);
  const bounded = nextSection >= 0 ? packageBody.slice(0, nextSection) : packageBody;
  const match = bounded.match(/^\s*version\s*=\s*"([^"]+)"\s*$/m);
  if (!match) throw new Error(`Missing package version in ${path}`);
  return match[1];
}

export function checkVersions({ packageJson, tauriJson, cargoToml }) {
  const versions = [jsonVersion(packageJson), jsonVersion(tauriJson), cargoVersion(cargoToml)];
  if (!versions.every((version) => version === versions[0])) {
    throw new Error(`Version mismatch: package=${versions[0]}, tauri=${versions[1]}, cargo=${versions[2]}`);
  }
  return versions[0];
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const root = resolve(dirname(scriptPath), "..");
  try {
    const version = checkVersions({
      packageJson: resolve(root, "app/package.json"),
      tauriJson: resolve(root, "app/src-tauri/tauri.conf.json"),
      cargoToml: resolve(root, "app/src-tauri/Cargo.toml"),
    });
    console.log(`Version ${version} is consistent.`);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : "Version integrity check failed.");
    process.exitCode = 1;
  }
}
