import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findLauncher, installedVersion, readSessions } from "./claude.ts";
import { Clock, type ClockSnapshot } from "./clock.ts";
import { loadConfig, writeDryRun } from "./config.ts";
import { runCountdown } from "./countdown.ts";
import { HerdrCli } from "./herdr.ts";
import { isRunning, request } from "./ipc.ts";
import { resolvePaths } from "./paths.ts";
import { Store } from "./store.ts";
import { isOlder } from "./version.ts";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(PLUGIN_ROOT, "bin", "claude-autoupdate.mjs");
const DEFAULT_PLUGIN_ID = "claude-autoupdate";

const USAGE = `usage: claude-autoupdate <command>

  live            turn dry run off and make sure the clock is running
  dry-run         turn dry run back on (only log what would happen)
  ensure-clock    start the background clock unless it is already running
  restart-clock   stop the running clock and start a new one (after an update of this plugin)
  stop-clock      stop the running clock
  tick            run a full check now (also reloads config.json)
  status          show what the plugin sees and why each pane is (not) restarted
  show-status     open the status as a herdr popup
  clock           run the clock in the foreground (used internally)
  countdown       the popup UI shown over the focused pane (used internally)`;

export async function main(argv: readonly string[]): Promise<number> {
  const paths = resolvePaths();
  const command = argv[0];
  switch (command) {
    case "ensure-clock":
      return ensureClock(paths.clockEndpoint);
    case "live":
    case "dry-run": {
      const live = command === "live";
      const written = writeDryRun(paths.configDir, !live);
      if (!written.ok) {
        console.error(written.error);
        return 1;
      }
      const code = await ensureClock(paths.clockEndpoint);
      if (code !== 0) return code;
      // Apply now instead of at the next interval.
      await request(paths.clockEndpoint, "tick").catch(() => undefined);
      console.log(
        live
          ? "live: idle, outdated Claude panes will be restarted"
          : "dry run: the plugin only logs what it would do (also stops a restart that is about to start)",
      );
      return 0;
    }
    case "restart-clock":
      if (!(await stopClock(paths.clockEndpoint))) return 1;
      return ensureClock(paths.clockEndpoint);
    case "stop-clock":
      return (await stopClock(paths.clockEndpoint)) ? 0 : 1;
    case "tick":
      if (!(await isRunning(paths.clockEndpoint))) {
        console.log("clock is not running; start it with ensure-clock");
        return 1;
      }
      await request(paths.clockEndpoint, "tick");
      console.log("full check requested");
      return 0;
    case "status":
      return status(paths, argv.includes("--wait"));
    case "show-status":
      try {
        await new HerdrCli().openPluginPane(process.env.HERDR_PLUGIN_ID || DEFAULT_PLUGIN_ID, "status", PLUGIN_ROOT, {});
        return 0;
      } catch {
        return status(paths, false);
      }
    case "clock": {
      const store = new Store(paths.stateDir);
      const clock = new Clock({
        paths,
        store,
        herdr: new HerdrCli(),
        pluginId: process.env.HERDR_PLUGIN_ID || DEFAULT_PLUGIN_ID,
        pluginRoot: process.env.HERDR_PLUGIN_ROOT || PLUGIN_ROOT,
        herdrSocket: process.env.HERDR_SOCKET_PATH,
        env: process.env,
      });
      await clock.run();
      return 0;
    }
    case "countdown":
      return countdown();
    default:
      console.error(USAGE);
      return command === undefined || command === "help" || command === "--help" ? 0 : 2;
  }
}

async function ensureClock(endpoint: string): Promise<number> {
  if (await isRunning(endpoint)) {
    console.log("clock already running");
    return 0;
  }
  // Detached and without inherited pipes: herdr waits for startup commands to exit.
  const child = spawn(process.execPath, [ENTRY, "clock"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: homedir(),
    env: process.env,
  });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await isRunning(endpoint)) {
      console.log(`clock started (pid ${child.pid})`);
      return 0;
    }
  }
  console.error("clock did not come up; see the plugin log (status shows its path)");
  return 1;
}

/** Asks the clock to stop. A restart in progress is finished first, which can take up to two minutes. */
async function stopClock(endpoint: string): Promise<boolean> {
  if (!(await isRunning(endpoint))) {
    console.log("clock is not running");
    return true;
  }
  await request(endpoint, "stop");
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    if (!(await isRunning(endpoint))) {
      console.log("clock stopped");
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.error("clock is still finishing a restart; it stops afterwards. Run ensure-clock again later.");
  return false;
}

async function status(paths: ReturnType<typeof resolvePaths>, waitForKey: boolean): Promise<number> {
  const store = new Store(paths.stateDir);
  const lines: string[] = [];
  let snapshot: ClockSnapshot | undefined;
  try {
    snapshot = (await request(paths.clockEndpoint, "status")) as ClockSnapshot;
  } catch {
    snapshot = undefined;
  }

  if (snapshot) {
    lines.push(`clock:      running (pid ${snapshot.pid}), ${snapshot.mode} mode`);
    lines.push(`last check: ${snapshot.lastCheckAt ? new Date(snapshot.lastCheckAt).toLocaleString() : "not yet"}`);
    lines.push(`claude:     ${snapshot.launcher ?? "not found (set claude_path in config.json)"} (${snapshot.installed ?? "version unknown"})`);
    lines.push(`dry run:    ${snapshot.config.dryRun ? "yes (run the live action to act)" : "no"}`);
    for (const warning of snapshot.configWarnings) lines.push(`config:     ${warning}`);
    lines.push("");
    if (snapshot.panes.length === 0) lines.push("no outdated Claude sessions");
    for (const p of snapshot.panes) {
      lines.push(`  ${(p.pane ?? "-").padEnd(8)} ${p.sessionId.slice(0, 8)}  ${p.version.padEnd(9)} ${p.outdated ? p.status : "up to date"}`);
    }
  } else {
    const { config, warnings } = loadConfig(paths.configDir);
    const launcher = config.claudePath || findLauncher();
    let installed: string | undefined;
    try {
      installed = config.fakeInstalledVersion ?? (launcher ? await installedVersion(launcher) : undefined);
    } catch {
      installed = undefined;
    }
    const outdated = installed ? readSessions(paths.sessionsDir).filter((s) => isOlder(s.version, installed)) : [];
    lines.push("clock:      NOT running (start it with the ensure-clock action)");
    lines.push(`claude:     ${launcher ?? "not found (set claude_path in config.json)"} (${installed ?? "version unknown"})`);
    lines.push(`dry run:    ${config.dryRun ? "yes" : "no"}`);
    for (const warning of warnings) lines.push(`config:     ${warning}`);
    lines.push(`outdated Claude sessions on this machine: ${outdated.length}`);
  }
  lines.push("");
  lines.push(`config: ${join(paths.configDir, "config.json")}`);
  lines.push(`log:    ${store.logPath}`);
  lines.push("");
  lines.push("recent log:");
  for (const line of store.tailLog(12)) lines.push(`  ${line}`);

  console.log(lines.join("\n"));
  if (waitForKey && process.stdin.isTTY) {
    console.log("\npress any key to close");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    await new Promise((resolve) => process.stdin.once("data", resolve));
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  return 0;
}

async function countdown(): Promise<number> {
  const resultFile = process.env.CAU_RESULT;
  if (!resultFile) {
    console.error("countdown: CAU_RESULT is not set");
    return 2;
  }
  await runCountdown({
    seconds: Number(process.env.CAU_SECONDS) || 5,
    label: process.env.CAU_LABEL || "this pane",
    resultFile,
    input: process.stdin,
    output: process.stdout,
  });
  await new Promise((resolve) => setTimeout(resolve, 700));
  return 0;
}
