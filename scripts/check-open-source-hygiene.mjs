import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const blockedIdentities = [
  ["pj", "telesoft"].join(""),
  ["it", "management", "@", "pj", "telesoft", ".", "de"].join(""),
];
const excluded = [
  /(^|\/)(node_modules|target|\.git)\//,
  /(^|\/)(dist|dist-single)\//,
  /\.(png|jpe?g|gif|ico|icns|pdf|zip|lock)$/i,
];

export function scanText(file, text, blocked = blockedIdentities) {
  const findings = [];
  const lowered = text.toLowerCase();
  for (const identity of blocked) {
    let offset = 0;
    const needle = identity.toLowerCase();
    while ((offset = lowered.indexOf(needle, offset)) !== -1) {
      findings.push({
        file,
        line: text.slice(0, offset).split("\n").length,
        rule: "blocked-identity",
      });
      offset += needle.length;
    }
  }
  return findings;
}

export function scanRepository(root = repositoryRoot) {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const findings = [];
  for (const file of tracked) {
    if (excluded.some((pattern) => pattern.test(file))) continue;
    try {
      findings.push(...scanText(file, readFileSync(path.join(root, file), "utf8")));
    } catch {
      // Ignore unreadable and binary inputs.
    }
  }
  return findings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const findings = scanRepository();
  for (const finding of findings) {
    process.stderr.write(`${finding.file}:${finding.line} ${finding.rule}\n`);
  }
  process.exitCode = findings.length === 0 ? 0 : 1;
}
