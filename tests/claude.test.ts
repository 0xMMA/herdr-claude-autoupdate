import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  defaultModeFromHelp,
  findGitRoot,
  findLauncher,
  isAlive,
  isTrustedFolder,
  launcherFingerprint,
  liveSessions,
  parseSession,
  readSessions,
  readTrustedFolders,
  versionFromInstallPath,
} from "../src/claude.ts";
import { session, tempDir, writeSession } from "./helpers.ts";

const LAUNCHER = process.platform === "win32" ? "claude.exe" : "claude";

test("R8: finds claude on PATH like a shell would", () => {
  const empty = tempDir();
  const bin = tempDir();
  writeFileSync(join(bin, LAUNCHER), "");
  const sep = process.platform === "win32" ? ";" : ":";
  const found = findLauncher({ PATH: [empty, bin].join(sep), PATHEXT: ".COM;.EXE" });
  assert.equal(found, join(bin, LAUNCHER));
  assert.equal(findLauncher({ PATH: empty }), undefined);
});

test("R11: the launcher fingerprint changes when the binary is replaced", () => {
  const dir = tempDir();
  const file = join(dir, LAUNCHER);
  writeFileSync(file, "v1");
  const before = launcherFingerprint(file);
  writeFileSync(file, "version 2");
  assert.notEqual(launcherFingerprint(file), before);
  assert.equal(launcherFingerprint(join(dir, "missing")), undefined);
});

test("R11: on Linux and macOS the version comes from the install path, without starting claude", () => {
  assert.equal(versionFromInstallPath("/home/u/.local/share/claude/versions/2.1.290"), "2.1.290");
  assert.equal(versionFromInstallPath("C:\\Users\\u\\.local\\bin\\claude.exe"), undefined);
});

test("reads Claude's session files and skips anything unexpected", () => {
  const dir = tempDir();
  writeSession(dir, session({ pid: 11, sessionId: "a" }));
  writeSession(dir, session({ pid: 12, sessionId: "b", status: "busy" }));
  writeFileSync(join(dir, "13.json"), "{ half written");
  writeFileSync(join(dir, "14.json"), JSON.stringify({ pid: 14 }));
  writeFileSync(join(dir, "11.abcdef.key"), "secret");
  mkdirSync(join(dir, "15.json.d"));
  const ids = readSessions(dir)
    .map((s) => s.sessionId)
    .sort();
  assert.deepEqual(ids, ["a", "b"]);
  assert.deepEqual(readSessions(join(dir, "nope")), []);
});

test("parses the fields the plugin relies on", () => {
  const parsed = parseSession({
    pid: 1,
    sessionId: "s",
    cwd: "/x",
    version: "2.1.289",
    status: "idle",
    statusUpdatedAt: 5,
    kind: "interactive",
    extra: true,
  });
  assert.deepEqual(parsed, { pid: 1, sessionId: "s", cwd: "/x", version: "2.1.289", status: "idle", statusUpdatedAt: 5, kind: "interactive" });
  assert.equal(parseSession(null), undefined);
});

test("R3: reads the default permission mode name from claude --help", () => {
  const help = [
    "  --permission-mode <mode>   Permission mode to use for the session",
    '                             (choices: "acceptEdits", "auto",',
    '                             "bypassPermissions", "manual",',
    '                             "dontAsk", "plan")',
    "  --plugin-dir <path>        Load a plugin",
  ].join("\n");
  assert.equal(defaultModeFromHelp(help), "manual");
  assert.equal(defaultModeFromHelp(help.replace('"manual"', '"default"')), "default");
  assert.equal(defaultModeFromHelp("no such option"), undefined);
});

test("R16: folder trust comes from Claude's config; the home directory never counts", () => {
  const dir = tempDir();
  const file = join(dir, ".claude.json");
  writeFileSync(
    file,
    JSON.stringify({
      projects: {
        "C:/Source": { hasTrustDialogAccepted: true },
        "/home/u": { hasTrustDialogAccepted: true },
        "/srv/untrusted": { hasTrustDialogAccepted: false },
      },
    }),
  );
  const trusted = readTrustedFolders(file)!;
  assert.deepEqual(trusted, ["C:/Source", "/home/u"]);
  const winHome = "C:\\Users\\u";
  assert.equal(isTrustedFolder("C:\\Source\\notes\\x", trusted, winHome, undefined), true, "outside a repo a trusted parent counts");
  assert.equal(isTrustedFolder("C:\\Source\\repo", trusted, winHome, "C:\\Source\\repo"), false, "the search stops at the git root");
  assert.equal(isTrustedFolder("C:\\Source\\repo\\sub", trusted, winHome, "C:\\Source\\repo"), false);
  assert.equal(isTrustedFolder("C:\\Source", trusted, winHome, undefined), true, "the folder itself");
  assert.equal(isTrustedFolder("C:\\SourceCode", trusted, winHome, undefined), false, "a name prefix is not a parent");
  assert.equal(isTrustedFolder("/home/u", trusted, "/home/u", undefined), false, "home never counts");
  assert.equal(isTrustedFolder("/home/u/notes", trusted, "/home/u", undefined), false, "nor does it count as a parent");
  assert.equal(isTrustedFolder("/srv/untrusted", trusted, "/home/u", undefined), false);
  assert.equal(readTrustedFolders(join(dir, "missing.json")), undefined);
});

test("R16: inside a trusted repository, sub-folders are trusted too", () => {
  const trusted = ["/srv/repo"];
  assert.equal(isTrustedFolder("/srv/repo/packages/app", trusted, "/home/u", "/srv/repo"), true);
  assert.equal(isTrustedFolder("/srv/repo", trusted, "/home/u", "/srv/repo"), true);
});

test("finds the git repository root", () => {
  const repo = tempDir();
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, "a", "b"), { recursive: true });
  assert.equal(findGitRoot(join(repo, "a", "b")), repo);
  assert.equal(findGitRoot(repo), repo);
});

test("drops session files of dead processes and duplicate session ids", () => {
  const alive = new Set([1, 2, 3]);
  const result = liveSessions(
    [
      session({ pid: 1, sessionId: "a", statusUpdatedAt: 10 }),
      session({ pid: 2, sessionId: "a", statusUpdatedAt: 20 }),
      session({ pid: 9, sessionId: "b" }),
      session({ pid: 3, sessionId: "c" }),
    ],
    (pid) => alive.has(pid),
  );
  assert.deepEqual(result.map((s) => `${s.sessionId}:${s.pid}`).sort(), ["a:2", "c:3"]);
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(2 ** 30), false);
});
