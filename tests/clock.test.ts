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
  const paths = resolvePaths(env);
  const herdr = new FakeHerdr();
  const store = new Store(paths.stateDir);
  const clock = new Clock({ paths, store, herdr, pluginId: "claude-autoupdate", pluginRoot: root, herdrSocket: undefined, env });
  return { clock, herdr, paths, store, launcher: join(bin, LAUNCHER) };
}

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
    ["─".repeat(20), "❯ ", "─".repeat(20), "  ? for shortcuts"].join("\n"),
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

test("a disabled plugin stops the clock", async () => {
  const { clock, herdr, paths, store } = setup({ fake_installed_version: "2.1.290" });
  writeSession(paths.sessionsDir, session({ version: "2.1.289" }));
  herdr.enabled = false;
  await clock.check();
  assert.ok(store.tailLog(5).some((l) => l.includes("plugin is disabled")));
});
