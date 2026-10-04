import assert from "node:assert/strict";
import { test } from "node:test";
import { assess, hasPendingWork, paneGate, restartCandidates, samePath, screenGate, sessionGate } from "../src/gates.ts";
import type { ScreenInfo } from "../src/screen.ts";
import { agent, config, session } from "./helpers.ts";

const NOW = 10_000_000;
const INSTALLED = "2.1.290";
const idleLongAgo = { statusUpdatedAt: NOW - 600_000 };

function reason(v: { ok: boolean; reason?: string }): string {
  return v.ok ? "ok" : (v.reason ?? "");
}

test("R1: an outdated, idle, quiet session passes", () => {
  assert.deepEqual(sessionGate(session(idleLongAgo), INSTALLED, undefined, NOW, config()), { ok: true });
});

test("R1: an up-to-date session is final", () => {
  const v = sessionGate(session({ ...idleLongAgo, version: INSTALLED }), INSTALLED, undefined, NOW, config());
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.final, true);
});

test("R5: busy or shell status waits", () => {
  for (const status of ["busy", "shell"]) {
    const v = sessionGate(session({ ...idleLongAgo, status }), INSTALLED, undefined, NOW, config());
    assert.equal(reason(v), `claude is ${status}`);
    assert.equal(!v.ok && v.final, false);
  }
});

test("R5: the quiet period is measured from statusUpdatedAt", () => {
  const recent = session({ statusUpdatedAt: NOW - 30_000 });
  assert.equal(reason(sessionGate(recent, INSTALLED, undefined, NOW, config({ quietSeconds: 120 }))), "quiet period");
  assert.equal(sessionGate(recent, INSTALLED, undefined, NOW, config({ quietSeconds: 10 })).ok, true);
});

test("R16: one attempt per session and version", () => {
  for (const result of ["done", "failed", "declined"] as const) {
    const v = sessionGate(session(idleLongAgo), INSTALLED, { version: INSTALLED, result, at: 0 }, NOW, config());
    assert.equal(v.ok, false);
    assert.equal(!v.ok && v.final, true);
  }
  // A mark for an older target version does not block the next update.
  assert.equal(sessionGate(session(idleLongAgo), INSTALLED, { version: "2.1.289", result: "failed", at: 0 }, NOW, config()).ok, true);
});

test("R16: dry-run marks only block while dry run is on", () => {
  const mark = { version: INSTALLED, result: "dry-run" as const, at: 0 };
  assert.equal(sessionGate(session(idleLongAgo), INSTALLED, mark, NOW, config({ dryRun: true })).ok, false);
  assert.equal(sessionGate(session(idleLongAgo), INSTALLED, mark, NOW, config({ dryRun: false })).ok, true);
});

test("non-interactive sessions are never touched", () => {
  assert.equal(sessionGate(session({ ...idleLongAgo, kind: "print" }), INSTALLED, undefined, NOW, config()).ok, false);
});

test("R5: herdr must also see the pane as idle or done", () => {
  assert.equal(paneGate(agent({ agent_status: "done" }), session()).ok, true);
  assert.equal(reason(paneGate(agent({ agent_status: "working" }), session())), "herdr: working");
  assert.equal(reason(paneGate(agent({ agent_status: "blocked" }), session())), "herdr: blocked");
  assert.equal(paneGate(agent({ launch_pending: true }), session()).ok, false);
});

test("R5/R6: screen gate", () => {
  const info = (over: Partial<ScreenInfo>): ScreenInfo => ({ prompt: "empty", draft: "", hasAttachment: false, permissionMode: null, ...over });
  assert.equal(screenGate(info({}), config()).ok, true);
  assert.equal(screenGate(info({ prompt: "absent" }), config()).ok, false);
  assert.equal(screenGate(info({ prompt: "draft", draft: "x" }), config()).ok, true);
  assert.equal(screenGate(info({ prompt: "draft", draft: "x" }), config({ rescueDrafts: false })).ok, false);
  assert.equal(screenGate(info({ prompt: "draft", draft: "x", hasAttachment: true }), config()).ok, false);
});

test("R4/R10: sessions are paired with panes by session id; others are never acted on", () => {
  const inHerdr = session({ ...idleLongAgo, pid: 1, sessionId: "a" });
  const outside = session({ ...idleLongAgo, pid: 2, sessionId: "b" });
  const current = session({ ...idleLongAgo, pid: 3, sessionId: "c", version: INSTALLED });
  const agents = [agent({ pane_id: "w1:p1", agent_session: { value: "a" } }), agent({ pane_id: "w1:p3", agent_session: { value: "c" } })];
  const result = assess([inHerdr, outside, current], agents, INSTALLED, {}, NOW, config());

  const byId = new Map(result.map((a) => [a.session.sessionId, a]));
  assert.equal(byId.get("a")!.verdict.ok, true);
  assert.equal(reason(byId.get("b")!.verdict), "not in a herdr pane on this server");
  assert.equal(byId.get("c")!.outdated, false);
  assert.equal(restartCandidates(result)[0]!.session.sessionId, "a");
});

test("R11: update mode ends when nothing outdated can still be restarted", () => {
  const outside = session({ ...idleLongAgo, sessionId: "b" });
  assert.equal(hasPendingWork(assess([outside], [], INSTALLED, {}, NOW, config())), false);

  const busy = session({ ...idleLongAgo, sessionId: "a", status: "busy" });
  const agents = [agent({ agent_session: { value: "a" } })];
  assert.equal(hasPendingWork(assess([busy], agents, INSTALLED, {}, NOW, config())), true, "busy panes keep update mode on");

  const marks = { a: { version: INSTALLED, result: "declined" as const, at: 0 } };
  assert.equal(hasPendingWork(assess([session({ ...idleLongAgo, sessionId: "a" })], agents, INSTALLED, marks, NOW, config())), false);
});

test("the longest-idle session goes first", () => {
  const older = session({ sessionId: "old", pid: 1, statusUpdatedAt: NOW - 900_000 });
  const newer = session({ sessionId: "new", pid: 2, statusUpdatedAt: NOW - 300_000 });
  const agents = [
    agent({ pane_id: "w1:p1", agent_session: { value: "new" } }),
    agent({ pane_id: "w1:p2", agent_session: { value: "old" } }),
  ];
  assert.deepEqual(restartCandidates(assess([newer, older], agents, INSTALLED, {}, NOW, config())).map((a) => a.session.sessionId), ["old", "new"]);
});

test("R2/R3: a session living in another directory than the pane's shell is never restarted", () => {
  const worktree = session({ cwd: "/repo/.claude/worktrees/feature" });
  const v = paneGate(agent({ cwd: "/repo" }), worktree);
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.final, true);
  assert.equal(paneGate(agent({ cwd: "C:\\Source\\App\\" }), session({ cwd: "c:/source/app" })).ok, true);
  assert.equal(paneGate(agent({ cwd: null }), worktree).ok, true, "unknown shell directory: no opinion");
});

test("samePath normalises separators, trailing slashes and drive-letter case", () => {
  assert.equal(samePath("C:\\Work\\x\\", "c:/work/x"), true);
  assert.equal(samePath("/home/u/x", "/home/u/X"), false, "POSIX paths stay case-sensitive");
});
