import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Clock } from "../src/clock.ts";
import { resolvePaths } from "../src/paths.ts";
import { Store } from "../src/store.ts";
import { FakeHerdr, agent, session, tempDir, writeSession } from "./helpers.ts";

const LAUNCHER = process.platform === "win32" ? "claude.exe" : "claude";

function setup(configJson: Record<string, unknown>) {
  const root = tempDir();
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, LAUNCHER), "v1");
  const env = {
    PATH: bin,
    PATHEXT: ".EXE",
    HERDR_PLUGIN_STATE_DIR: join(root, "state"),
    HERDR_PLUGIN_CONFIG_DIR: join(root, "config"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
  };
  mkdirSync(env.HERDR_PLUGIN_CONFIG_DIR);
  writeFileSync(join(env.HERDR_PLUGIN_CONFIG_DIR, "config.json"), JSON.stringify(configJson));
  mkdirSync(env.CLAUDE_CONFIG_DIR);
  // The test sessions live in /work/project, which Claude trusts.
  writeFileSync(
    join(env.CLAUDE_CONFIG_DIR, ".claude.json"),
    JSON.stringify({ projects: { "/work": { hasTrustDialogAccepted: true } } }),
  );
  const paths = resolvePaths(env);
  const herdr = new FakeHerdr();
  const store = new Store(paths.stateDir);
  const clock = new Clock({
    paths,
    store,
    herdr,
    pluginId: "claude-autoupdate",
    pluginRoot: root,
    herdrSocket: undefined,
    env,
    isAlive: () => true,
    home: "/home/u",
    findGitRoot: () => undefined,
    standardDirs: [],
  });
  const writeConfig = (json: Record<string, unknown>) =>
    writeFileSync(join(env.HERDR_PLUGIN_CONFIG_DIR, "config.json"), `${JSON.stringify(json)}\n`);
  return { clock, herdr, paths, store, launcher: join(bin, LAUNCHER), writeConfig };
}

const PROMPT_BOX = ["─".repeat(20), "❯ ", "─".repeat(20), "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");

test("R11: idle mode makes no herdr calls", async () => {
  const { clock, herdr, paths } = setup({ fake_installed_version: "2.1.290" });
  writeSession(paths.sessionsDir, session({ version: "2.1.290" }));

  await clock.check(); // first check after start is always a full one
  assert.equal(clock.snapshot().mode, "idle");
  assert.equal(herdr.calls.length, 0, "all sessions current: no need to ask herdr");

  for (let i = 0; i < 5; i++) await clock.check();
  assert.equal(herdr.calls.length, 0);
  assert.equal(clock.snapshot().mode, "idle");
});

test("R11/R12: a changed launcher switches to update mode, then back to idle", async () => {
  const { clock, herdr, paths, launcher, store } = setup({ fake_installed_version: "2.1.290", dry_run: true, quiet_seconds: 0 });
  writeSession(paths.sessionsDir, session({ version: "2.1.290" }));
  await clock.check();
  assert.equal(clock.snapshot().mode, "idle");

  // Claude's auto-updater installs a new build; one pane still runs the old one.
  writeFileSync(launcher, "version 2, a different size");
  writeSession(paths.sessionsDir, session({ pid: 77, sessionId: "old-one", version: "2.1.289", statusUpdatedAt: 0 }));
  herdr.agents = [agent({ pane_id: "w1:p5", agent_session: { value: "old-one" } })];
  herdr.agentGets = [herdr.agents[0]!];
  herdr.processInfos = [
    { pane_id: "w1:p5", shell_pid: 1, foreground_processes: [{ pid: 77, name: "claude", argv: ["claude"] }] },
  ];
  herdr.screens = [
    ["─".repeat(20), "❯ ", "─".repeat(20), "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n"),
  ];

  await clock.check();
  assert.equal(herdr.count("agentList"), 1);
  assert.equal(store.readMarks()["old-one"]?.result, "dry-run");
  assert.equal(herdr.count("sendKeys"), 0, "dry run");
  assert.equal(clock.snapshot().mode, "idle", "nothing left to do for this version");

  const before = herdr.calls.length;
  await clock.check();
  assert.equal(herdr.calls.length, before, "idle again: no more herdr calls");
});

test("R4/R10: outdated sessions outside herdr do not keep the clock busy", async () => {
  const { clock, herdr, paths } = setup({ fake_installed_version: "2.1.290" });
  writeSession(paths.sessionsDir, session({ version: "2.1.289" }));
  herdr.agents = [];
  await clock.check();
  assert.equal(clock.snapshot().mode, "idle");
  assert.equal(herdr.count("sendKeys") + herdr.count("agentStart"), 0);
});

test("changing or removing fake_installed_version takes effect", async () => {
  const { clock, paths, writeConfig } = setup({ fake_installed_version: "9.9.9" });
  writeSession(paths.sessionsDir, session({ version: "2.1.290" }));
  await clock.check();
  assert.equal(clock.snapshot().installed, "9.9.9");

  writeConfig({ fake_installed_version: "2.1.290", extra_padding_to_change_size: true });
  await clock.check();
  assert.equal(clock.snapshot().installed, "2.1.290");

  // Without the fake, the real launcher is asked; the test launcher cannot answer.
  writeConfig({});
  await clock.check();
  assert.equal(clock.snapshot().installed, undefined);
});

test("R1: a pane that is skipped right before acting does not block the others", async () => {
  const { clock, herdr, paths, store } = setup({ fake_installed_version: "2.1.290", dry_run: true, quiet_seconds: 0 });
  writeSession(paths.sessionsDir, session({ pid: 1, sessionId: "first", version: "2.1.289", statusUpdatedAt: 1 }));
  writeSession(paths.sessionsDir, session({ pid: 2, sessionId: "second", version: "2.1.289", statusUpdatedAt: 2 }));
  const a = agent({ pane_id: "w1:p1", agent_session: { value: "first" } });
  const b = agent({ pane_id: "w1:p2", agent_session: { value: "second" } });
  herdr.agents = [a, b];
  // "first" goes first (idle longest) but is busy again by the time it is re-checked.
  herdr.agentGets = [{ ...a, agent_status: "working" }, b];
  herdr.processInfos = [{ pane_id: "w1:p2", shell_pid: 1, foreground_processes: [{ pid: 2, name: "claude", argv: ["claude"] }] }];
  herdr.screens = [PROMPT_BOX];

  await clock.check();
  const marks = store.readMarks();
  assert.equal(marks.second?.result, "dry-run");
  assert.equal(marks.first, undefined);
  const first = clock.snapshot().panes.find((p) => p.sessionId === "first")!;
  assert.equal(first.status, "waiting: herdr: working");
  assert.equal(clock.snapshot().mode, "update", "the skipped pane is still pending");
});

test("R11: while no outdated session is idle, herdr is not asked again", async () => {
  const { clock, herdr, paths } = setup({ fake_installed_version: "2.1.290" });
  writeSession(paths.sessionsDir, session({ version: "2.1.289", status: "busy" }));
  herdr.agents = [agent()];
  await clock.check();
  const calls = herdr.count("agentList");
  for (let i = 0; i < 3; i++) await clock.check();
  assert.equal(herdr.count("agentList"), calls);
  assert.equal(clock.snapshot().mode, "update");
});

test("R16: sessions in folders Claude does not trust permanently are never restarted", async () => {
  const { clock, herdr, paths } = setup({ fake_installed_version: "2.1.290", dry_run: false, quiet_seconds: 0 });
  writeSession(paths.sessionsDir, session({ version: "2.1.289", cwd: "/home/u" }));
  herdr.agents = [agent()];
  await clock.check();
  const pane = clock.snapshot().panes[0]!;
  assert.match(pane.status, /folder not trusted/);
  assert.equal(herdr.count("agentGet") + herdr.count("sendKeys"), 0);
  assert.equal(clock.snapshot().mode, "idle");
});

test("R1: a session missing from an old agent list waits instead of being given up", async () => {
  const { clock, herdr, paths } = setup({ fake_installed_version: "2.1.290" });
  writeSession(paths.sessionsDir, session({ pid: 1, sessionId: "a", version: "2.1.289", status: "busy" }));
  herdr.agents = [agent({ agent_session: { value: "a" } })];
  await clock.check(); // fetches the list once
  // A new session appears in a pane after the list was fetched; nothing is idle yet.
  writeSession(paths.sessionsDir, session({ pid: 2, sessionId: "b", version: "2.1.289", status: "busy" }));
  await clock.check();
  const b = clock.snapshot().panes.find((p) => p.sessionId === "b")!;
  assert.match(b.status, /pane not known yet/);
  assert.equal(clock.snapshot().mode, "update");
});

test("R16: an unreadable .claude.json means wait, not give up", async () => {
  const { clock, herdr, paths } = setup({ fake_installed_version: "2.1.290", quiet_seconds: 0 });
  writeFileSync(paths.claudeConfigFile, "{ half written");
  writeSession(paths.sessionsDir, session({ version: "2.1.289" }));
  herdr.agents = [agent()];
  await clock.check();
  assert.match(clock.snapshot().panes[0]!.status, /cannot read Claude's trusted folders/);
  assert.equal(clock.snapshot().mode, "update");
  assert.equal(herdr.count("sendKeys"), 0);
});

test("a failed version lookup is retried a few times, then waits for the next change", async () => {
  const { clock, paths } = setup({});
  writeSession(paths.sessionsDir, session({ version: "2.1.289" }));
  await clock.check(); // the test launcher cannot answer --version
  assert.equal(clock.snapshot().mode, "update");
  await clock.check();
  await clock.check();
  assert.equal(clock.snapshot().mode, "idle");
});

test("a disabled plugin stops the clock", async () => {
  const { clock, herdr, paths, store } = setup({ fake_installed_version: "2.1.290" });
  writeSession(paths.sessionsDir, session({ version: "2.1.289" }));
  herdr.enabled = false;
  await clock.check();
  assert.ok(store.tailLog(5).some((l) => l.includes("plugin is disabled")));
});

test("claude_path in config.json is used, and a config edit takes effect even before claude was found", async () => {
  const { clock, launcher, writeConfig } = setup({ fake_installed_version: "2.1.290", claude_path: "/nowhere/claude" });
  await clock.check();
  assert.equal(clock.snapshot().launcher, undefined, "claude_path does not exist");
  writeConfig({ fake_installed_version: "2.1.290", claude_path: launcher });
  await clock.check();
  assert.equal(clock.snapshot().launcher, launcher);
});

test("R11: without claude, a config edit is read once, not on every interval", async () => {
  const { clock, store, writeConfig } = setup({});
  await clock.check();
  writeConfig({ claude_path: "/nowhere/claude", unknown_key: 1 });
  for (let i = 0; i < 4; i++) await clock.check();
  const log = store.tailLog(50);
  assert.equal(log.filter((l) => l.includes("unknown setting unknown_key")).length, 1, "config parsed once");
  assert.equal(log.filter((l) => l.includes("claude_path /nowhere/claude does not exist")).length, 1, "reported once");
  assert.equal(clock.snapshot().mode, "idle");
});

test("claude_path may start with ~", async () => {
  const { clock } = setup({ fake_installed_version: "2.1.290", claude_path: "~/missing/claude" });
  await clock.check();
  assert.equal(clock.snapshot().launcher, undefined);
});
