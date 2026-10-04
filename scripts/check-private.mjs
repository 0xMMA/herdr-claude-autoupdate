#!/usr/bin/env node
// Scans the files that would be published, and the commit metadata, for personal data:
// home-directory paths with real user names, e-mail addresses, session ids, and any
// patterns listed in a local, git-ignored `.private-patterns` file (one regular
// expression per line, `#` starts a comment). Run before every push:
//
//   npm run check:private
//
// `--ci` skips the commit-metadata check, which needs the full history.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const ci = process.argv.includes("--ci");

const GENERIC = [
  { name: "Windows home path", re: /[A-Za-z]:[\\/]+Users[\\/]+(?!(u|user|you|runneradmin|<[^>]+>)[\\/])[A-Za-z0-9._-]+/g },
  { name: "Unix home path", re: /\/(home|Users)\/(?!(u|user|you|runner|<[^>]+>)\/)[a-z0-9._-]+\//g },
  { name: "e-mail address", re: /[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com\b)(?!example\.(com|org)\b)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[a-z]{2,}/g },
  { name: "session id (UUID)", re: /\b(?!00000000-)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
];

function personalPatterns() {
  if (!existsSync(".private-patterns")) return [];
  return readFileSync(".private-patterns", "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => ({ name: "personal pattern", re: new RegExp(line, "gi") }));
}

const patterns = [...GENERIC, ...personalPatterns()];
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const files = [
  ...git("ls-files", "-z").split("\0"),
  ...git("ls-files", "-z", "--others", "--exclude-standard").split("\0"),
].filter((f) => f && f !== "package-lock.json" && f !== "LICENSE" && existsSync(f));

const findings = [];
for (const file of new Set(files)) {
  const buffer = readFileSync(file);
  if (buffer.includes(0)) continue; // binary
  const lines = buffer.toString("utf8").split("\n");
  lines.forEach((line, index) => {
    for (const { name, re } of patterns) {
      re.lastIndex = 0;
      const match = re.exec(line);
      if (match) findings.push(`${file}:${index + 1}: ${name}: ${match[0]}`);
    }
  });
}

if (!ci) {
  const log = git("log", "--format=%H%x00%an <%ae>%x00%cn <%ce>%x00%B%x01");
  for (const entry of log.split("\x01")) {
    const [hash, author, committer, message] = entry.trim().split("\0");
    if (!hash) continue;
    for (const who of [author, committer]) {
      if (who && !/users\.noreply\.github\.com>$|noreply@github\.com>$/.test(who)) {
        findings.push(`commit ${hash.slice(0, 7)}: identity is not a GitHub noreply address: ${who}`);
      }
    }
    for (const { name, re } of patterns) {
      re.lastIndex = 0;
      const match = re.exec(message ?? "");
      if (match) findings.push(`commit ${hash.slice(0, 7)} message: ${name}: ${match[0]}`);
    }
  }
}

if (findings.length > 0) {
  console.error(`Possible personal data (${findings.length}):`);
  for (const finding of findings) console.error(`  ${finding}`);
  console.error("Fix these, or add a narrower exception to scripts/check-private.mjs if they are intended.");
  process.exit(1);
}
console.log(`No personal data found in ${new Set(files).size} files${ci ? "" : " and the commit history"}.`);
