import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import type { ClaudeSession } from "../src/claude.ts";
import type { Config } from "../src/config.ts";
import type { Assessment } from "../src/gates.ts";
import { HerdrError } from "../src/herdr.ts";
import { agentNameFor, restartPane, sameDraft, type RestartDeps } from "../src/restart.ts";
import { NBSP, FakeHerdr, agent, config, processInfo, screen, session, tempDir } from "./helpers.ts";

const INSTALLED = "2.1.290";
const OLD = session({ pid: 4242, version: "2.1.289", statusUpdatedAt: 0 });
const CLAUDE = { pid: 4242, name: "claude", argv: ["/usr/bin/claude", "--model", "sonnet", "--resume", "stale-id"] };
const SHELL_ONLY = processInfo([]);
const EMPTY = screen({});

function candidate(focused = false): Assessment {
  return { session: OLD, agent: agent({ focused }), outdated: true, verdict: { ok: true } };
}

function setup(over: Partial<Config> = {}) {
  const herdr = new FakeHerdr();
  let now = 1_000_000;
  const logs: string[] = [];
  let sessions: ClaudeSession[] = [OLD];
  herdr.onAgentStart = () => {
    sessions = [session({ pid: 5000, version: INSTALLED })];
  };
  const deps: RestartDeps = {
    herdr,
    config: config(over),
    installed: INSTALLED,
    defaultModeName: "manual",
    pluginId: "claude-autoupdate",
    pluginRoot: "/plugin",
    stateDir: tempDir(),
    readSessions: () => sessions,
    isAlive: () => true,
    log: (m) => logs.push(m),
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
  };
  const setSessions = (next: ClaudeSession[]) => {
    sessions = next;
  };
  return { herdr, deps, logs, setSessions };
}

test("R2/R3: restarts in place with the original flags and the live session id", async () => {
  const { herdr, deps } = setup();
  herdr.agentGets = [agent()];
  herdr.processInfos = [processInfo([CLAUDE]), SHELL_ONLY];
  herdr.screens = [EMPTY];

  const outcome = await restartPane(candidate(), deps);

  assert.deepEqual(outcome, { kind: "restarted", draftRestored: undefined });
  assert.deepEqual(herdr.keys(), [["ctrl+c"], ["ctrl+c"]]);
  const start = herdr.calls.find((c) => c.method === "agentStart")!;
  assert.equal(start.args[1], "w1:p2", "same pane");
  assert.deepEqual(start.args[2], ["--model", "sonnet", "--permission-mode", "auto", "--resume", OLD.sessionId]);
  assert.equal(herdr.count("openPluginPane"), 0, "no popup for an unfocused pane");
});

test("R16: dry run touches nothing", async () => {
  const { herdr, deps } = setup({ dryRun: true });
  herdr.agentGets = [agent({ focused: true })];
  herdr.processInfos = [processInfo([CLAUDE])];
  herdr.screens = [EMPTY];
  const outcome = await restartPane(candidate(true), deps);
  assert.equal(outcome.kind, "dry-run");
  assert.equal(herdr.count("sendKeys"), 0);
  assert.equal(herdr.count("agentStart"), 0);
  assert.equal(herdr.count("openPluginPane"), 0);
});

test("R5: re-checks right before acting", async () => {
  const { herdr, deps } = setup();
  herdr.agentGets = [agent({ agent_status: "working" })];
  assert.deepEqual(await restartPane(candidate(), deps), { kind: "skipped", reason: "herdr: working" });

  herdr.agentGets = [agent()];
  herdr.processInfos = [processInfo([{ pid: 999, name: "node" }])];
  assert.equal((await restartPane(candidate(), deps)).kind, "skipped", "claude no longer in the foreground");

  herdr.processInfos = [processInfo([CLAUDE])];
  herdr.screens = ["no prompt box here"];
  assert.equal((await restartPane(candidate(), deps)).kind, "skipped", "dialog open");
  assert.equal(herdr.count("sendKeys"), 0);
});

test("R7: the focused pane gets a countdown; a key press cancels", async () => {
  const { herdr, deps } = setup();
  herdr.agentGets = [agent({ focused: true })];
  herdr.processInfos = [processInfo([CLAUDE])];
  herdr.screens = [EMPTY];
  herdr.onOpenPane = (env) => writeFileSync(env.CAU_RESULT!, "cancel");
  assert.deepEqual(await restartPane(candidate(true), deps), { kind: "declined" });
  assert.equal(herdr.count("sendKeys"), 0);
});

test("R7: when the countdown runs out, the focused pane is restarted", async () => {
  const { herdr, deps } = setup();
  herdr.agentGets = [agent({ focused: true })];
  herdr.processInfos = [processInfo([CLAUDE]), processInfo([CLAUDE]), SHELL_ONLY];
  herdr.screens = [EMPTY];
  herdr.onOpenPane = (env) => writeFileSync(env.CAU_RESULT!, "proceed");
  assert.equal((await restartPane(candidate(true), deps)).kind, "restarted");
  const open = herdr.calls.find((c) => c.method === "openPluginPane")!;
  assert.equal(open.args[1], "countdown");
  assert.equal((open.args[3] as Record<string, string>).CAU_SECONDS, "5");
});

test("R7: without a popup the focused pane waits unless it has been idle for long", async () => {
  const { herdr, deps } = setup({ focusedUnattendedMinutes: 30 });
  herdr.agentGets = [agent({ focused: true })];
  herdr.processInfos = [processInfo([CLAUDE]), SHELL_ONLY];
  herdr.screens = [EMPTY];
  herdr.openPaneError = new HerdrError("ui_busy", "modal open");
  const recent = { ...candidate(true), session: { ...OLD, statusUpdatedAt: deps.now() - 60_000 } };
  assert.equal((await restartPane(recent, deps)).kind, "skipped");
  herdr.processInfos = [processInfo([CLAUDE]), processInfo([CLAUDE]), SHELL_ONLY];
  const longIdle = { ...candidate(true), session: { ...OLD, statusUpdatedAt: deps.now() - 3_600_000 } };
  assert.equal((await restartPane(longIdle, deps)).kind, "restarted");
});

test("R6: an unsent draft goes through the input history and comes back", async () => {
  const { herdr, deps } = setup();
  const draft = screen({ promptLines: [`❯${NBSP}write the changelog`] });
  herdr.agentGets = [agent()];
  herdr.processInfos = [processInfo([CLAUDE]), SHELL_ONLY];
  // before, after Esc Esc, new session ready, after Up
  herdr.screens = [draft, EMPTY, EMPTY, draft];
  const outcome = await restartPane(candidate(), deps);
  assert.deepEqual(outcome, { kind: "restarted", draftRestored: true });
  assert.deepEqual(herdr.keys(), [["esc", "esc"], ["ctrl+c"], ["ctrl+c"], ["up"]]);
});

test("R6: if Up recalls something else, step back and report it", async () => {
  const { herdr, deps, logs } = setup();
  herdr.agentGets = [agent()];
  herdr.processInfos = [processInfo([CLAUDE]), SHELL_ONLY];
  herdr.screens = [
    screen({ promptLines: [`❯${NBSP}my draft`] }),
    EMPTY,
    EMPTY,
    screen({ promptLines: [`❯${NBSP}an older prompt`] }),
  ];
  const outcome = await restartPane(candidate(), deps);
  assert.deepEqual(outcome, { kind: "restarted", draftRestored: false });
  assert.deepEqual(herdr.keys().at(-1), ["down"]);
  assert.ok(logs.some((l) => l.includes("my draft")), "the draft text is kept in the log");
});

test("R6/R16: if the draft cannot be parked, nothing is restarted", async () => {
  const { herdr, deps } = setup();
  const draft = screen({ promptLines: [`❯${NBSP}keep me`] });
  herdr.agentGets = [agent()];
  herdr.processInfos = [processInfo([CLAUDE])];
  herdr.screens = [draft, draft];
  const outcome = await restartPane(candidate(), deps);
  assert.equal(outcome.kind, "failed");
  assert.equal(herdr.count("agentStart"), 0);
  assert.ok(!herdr.keys().some((k) => k.includes("ctrl+c")));
});

test("R16: a Claude that does not exit is left running, never killed", async () => {
  const { herdr, deps } = setup();
  herdr.agentGets = [agent()];
  herdr.processInfos = [processInfo([CLAUDE])];
  herdr.screens = [EMPTY];
  const outcome = await restartPane(candidate(), deps);
  assert.deepEqual(outcome, { kind: "failed", reason: "claude did not exit after Ctrl+C" });
  assert.equal(herdr.count("agentStart"), 0);
});

test("agent_not_ready from agent start still counts as started", async () => {
  const { herdr, deps } = setup();
  herdr.agentGets = [agent()];
  herdr.processInfos = [processInfo([CLAUDE]), SHELL_ONLY];
  herdr.screens = [EMPTY];
  herdr.startError = new HerdrError("agent_not_ready", "blocked at startup");
  assert.equal((await restartPane(candidate(), deps)).kind, "restarted");
});

test("R16: a resume that does not come up on the new version is reported as failed", async () => {
  const { herdr, deps } = setup();
  herdr.onAgentStart = undefined; // session files never change
  herdr.agentGets = [agent()];
  herdr.processInfos = [processInfo([CLAUDE]), SHELL_ONLY];
  herdr.screens = [EMPTY];
  assert.equal((await restartPane(candidate(), deps)).kind, "failed");
});

test("reuses the agent's herdr name, or derives a valid one", async () => {
  assert.equal(agentNameFor("wA:p3"), "cau-wa-p3");
  assert.match(agentNameFor("w12345678901234567890:p12345678901"), /^[a-z][a-z0-9_-]{0,31}$/);

  const { herdr, deps } = setup();
  herdr.agentGets = [agent({ name: "reviewer" })];
  herdr.processInfos = [processInfo([CLAUDE]), SHELL_ONLY];
  herdr.screens = [EMPTY];
  await restartPane(candidate(), deps);
  assert.equal(herdr.calls.find((c) => c.method === "agentStart")!.args[0], "reviewer");
});

test("sameDraft ignores re-wrapping", () => {
  assert.equal(sameDraft("a long\nline", "a long line"), true);
  assert.equal(sameDraft("", ""), false);
  assert.equal(sameDraft("a", "b"), false);
});

test("R7: a popup that was shown but never answered blocks the restart", async () => {
  const { herdr, deps } = setup({ focusedUnattendedMinutes: 0 });
  herdr.agentGets = [agent({ focused: true })];
  herdr.processInfos = [processInfo([CLAUDE])];
  herdr.screens = [EMPTY];
  herdr.onOpenPane = () => {}; // opened, but the answer file never appears
  assert.deepEqual(await restartPane(candidate(true), deps), { kind: "skipped", reason: "the countdown popup did not answer" });
  assert.equal(herdr.count("sendKeys"), 0);
});

test("R5: after the countdown the session file is checked again", async () => {
  const { herdr, deps, setSessions } = setup();
  herdr.agentGets = [agent({ focused: true })];
  herdr.processInfos = [processInfo([CLAUDE])];
  herdr.screens = [EMPTY];
  herdr.onOpenPane = (env) => {
    setSessions([{ ...OLD, status: "busy" }]); // the user sent a prompt meanwhile
    writeFileSync(env.CAU_RESULT!, "proceed");
  };
  assert.deepEqual(await restartPane(candidate(true), deps), { kind: "skipped", reason: "claude is busy" });
  assert.equal(herdr.count("sendKeys"), 0);
});

test("R16: a herdr failure after the first key still ends in a recorded failure", async () => {
  const { herdr, deps } = setup();
  herdr.agentGets = [agent()];
  herdr.processInfos = [processInfo([CLAUDE])];
  herdr.screens = [EMPTY];
  herdr.sendKeysError = new HerdrError("timeout", "herdr command timed out");
  const outcome = await restartPane(candidate(), deps);
  assert.equal(outcome.kind, "failed");
  assert.match((outcome as { reason: string }).reason, /interrupted: herdr command timed out/);
});

test("R6: the draft comes back even when the version check fails afterwards", async () => {
  const { herdr, deps, setSessions } = setup();
  herdr.onAgentStart = () => setSessions([session({ pid: 5000, version: "2.1.289" })]);
  const draft = screen({ promptLines: [`❯${NBSP}keep this`] });
  herdr.agentGets = [agent()];
  herdr.processInfos = [processInfo([CLAUDE]), SHELL_ONLY];
  herdr.screens = [draft, EMPTY, EMPTY, draft];
  const outcome = await restartPane(candidate(), deps);
  assert.deepEqual(outcome, { kind: "failed", reason: "resumed, but still on 2.1.289" });
  assert.deepEqual(herdr.keys().at(-1), ["up"], "draft recalled before reporting the failure");
});

test("R3/R16: no mode in the footer resumes in the default mode, not the settings default", async () => {
  const { herdr, deps } = setup();
  herdr.agentGets = [agent()];
  herdr.processInfos = [processInfo([CLAUDE]), SHELL_ONLY];
  herdr.screens = [screen({ footer: "  ? for shortcuts" })];
  await restartPane(candidate(), deps);
  const args = herdr.calls.find((c) => c.method === "agentStart")!.args[2] as string[];
  assert.deepEqual(args, ["--model", "sonnet", "--permission-mode", "manual", "--resume", OLD.sessionId]);
});

test("R3: a session started with --worktree is not touched", async () => {
  const { herdr, deps } = setup();
  herdr.agentGets = [agent()];
  herdr.processInfos = [processInfo([{ ...CLAUDE, argv: ["claude", "-w", "feature"] }])];
  herdr.screens = [EMPTY];
  const outcome = await restartPane(candidate(), deps);
  assert.equal(outcome.kind, "unsupported");
  assert.equal(herdr.count("sendKeys"), 0);
});

test("R3/R16: without the default mode's name, a pane in default mode waits", async () => {
  const { herdr, deps } = setup();
  deps.defaultModeName = undefined;
  herdr.agentGets = [agent()];
  herdr.processInfos = [processInfo([CLAUDE])];
  herdr.screens = [screen({ footer: "  ? for shortcuts" })];
  assert.deepEqual(await restartPane(candidate(), deps), { kind: "skipped", reason: "the default permission mode name is not known yet" });
  assert.equal(herdr.count("sendKeys"), 0);
});

test("R16: a leftover session file of an earlier process is not taken for the resumed one", async () => {
  const { herdr, deps, setSessions } = setup();
  const stale = session({ pid: 777, version: INSTALLED }); // same session id, crashed earlier
  setSessions([OLD, stale]);
  herdr.onAgentStart = () => setSessions([stale]); // the resume never comes up
  herdr.agentGets = [agent()];
  herdr.processInfos = [processInfo([CLAUDE]), SHELL_ONLY];
  herdr.screens = [EMPTY];
  assert.deepEqual(await restartPane(candidate(), deps), { kind: "failed", reason: "the resumed session did not come up" });
});

test("R6: a herdr error while recalling the draft does not turn a restart into a failure", async () => {
  const { herdr, deps, setSessions } = setup();
  herdr.onAgentStart = () => {
    setSessions([session({ pid: 5000, version: INSTALLED })]);
    herdr.sendKeysError = new HerdrError("timeout", "herdr command timed out");
  };
  herdr.agentGets = [agent()];
  herdr.processInfos = [processInfo([CLAUDE]), SHELL_ONLY];
  herdr.screens = [screen({ promptLines: [`❯${NBSP}my draft`] }), EMPTY, EMPTY];
  assert.deepEqual(await restartPane(candidate(), deps), { kind: "restarted", draftRestored: false });
});

test("R16: a retry sends Ctrl+C as a pair again", async () => {
  const { herdr, deps } = setup();
  herdr.agentGets = [agent()];
  herdr.processInfos = [processInfo([CLAUDE])];
  herdr.screens = [EMPTY];
  await restartPane(candidate(), deps);
  assert.deepEqual(herdr.keys(), [["ctrl+c"], ["ctrl+c"], ["ctrl+c"], ["ctrl+c"]]);
});
