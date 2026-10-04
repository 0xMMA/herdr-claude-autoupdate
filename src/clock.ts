import { readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findLauncher, installedVersion, launcherFingerprint, readSessions, type ClaudeSession } from "./claude.ts";
import { CONFIG_FILE, loadConfig, type Config } from "./config.ts";
import { assess, hasPendingWork, nextCandidate, type Assessment } from "./gates.ts";
import { HerdrError, type Herdr } from "./herdr.ts";
import { serveExclusive, type Command } from "./ipc.ts";
import type { Paths } from "./paths.ts";
import { restartPane, type Outcome } from "./restart.ts";
import type { Store } from "./store.ts";
import { isOlder } from "./version.ts";

/**
 * The clock is the plugin's only long-running process (R11):
 *
 * - idle mode: one stat() of the claude launcher per interval, nothing else;
 * - update mode: entered when the launcher changed (or on start / on demand), it reads
 *   Claude's session files and talks to herdr only while outdated panes remain.
 */

export interface ClockContext {
  paths: Paths;
  store: Store;
  herdr: Herdr;
  pluginId: string;
  pluginRoot: string;
  herdrSocket: string | undefined;
  env: Record<string, string | undefined>;
}

export type Mode = "idle" | "update";

export interface ClockSnapshot {
  mode: Mode;
  pid: number;
  startedAt: number;
  lastCheckAt: number | undefined;
  launcher: string | undefined;
  installed: string | undefined;
  config: Config;
  configWarnings: string[];
  panes: Array<{ pane: string | undefined; sessionId: string; version: string; outdated: boolean; status: string }>;
}

const MAX_HERDR_FAILURES = 3;
const MAX_SOCKET_MISSES = 3;

export class Clock {
  private readonly ctx: ClockContext;
  private mode: Mode = "update"; // the first check after start is always a full one
  private config: Config;
  private configWarnings: string[];
  private launcher: string | undefined;
  private fingerprint: string | undefined;
  private installed: string | undefined;
  private lastCheckAt: number | undefined;
  private assessments: Assessment[] = [];
  private lastReasons = new Map<string, string>();
  private herdrFailures = 0;
  private socketMisses = 0;
  private forced = false;
  private configStamp: string | undefined;
  private stopping = false;
  private readonly startedAt = Date.now();
  private wake: (() => void) | undefined;

  constructor(ctx: ClockContext) {
    this.ctx = ctx;
    ({ config: this.config, warnings: this.configWarnings } = loadConfig(ctx.paths.configDir));
  }

  log(message: string): void {
    this.ctx.store.log(message);
  }

  async run(): Promise<void> {
    const server = await serveExclusive(this.ctx.paths.clockEndpoint, (command) => this.handle(command));
    if (!server) return; // another clock serves this herdr server
    // Do not hold the plugin directory as working directory (Windows locks it, herdr#4179).
    process.chdir(homedir());
    this.removeStaleCountdownFiles();
    this.log(`clock started (pid ${process.pid}, dry_run=${this.config.dryRun})`);
    for (const warning of this.configWarnings) this.log(`config: ${warning}`);

    while (!this.stopping) {
      try {
        await this.check();
      } catch (error) {
        this.log(`check failed: ${(error as Error).stack ?? String(error)}`);
      }
      if (this.stopping) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.config.intervalSeconds * 1000);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
    this.log("clock stopped");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handle(command: Command): unknown {
    switch (command) {
      case "ping":
        return "pong";
      case "tick":
        this.forced = true;
        this.wake?.();
        return "ok";
      case "stop":
        this.stopping = true;
        this.wake?.();
        return "ok";
      case "status":
        return this.snapshot();
    }
  }

  snapshot(): ClockSnapshot {
    return {
      mode: this.mode,
      pid: process.pid,
      startedAt: this.startedAt,
      lastCheckAt: this.lastCheckAt,
      launcher: this.launcher,
      installed: this.installed,
      config: this.config,
      configWarnings: this.configWarnings,
      panes: this.assessments.map((a) => ({
        pane: a.agent?.pane_id,
        sessionId: a.session.sessionId,
        version: a.session.version,
        outdated: a.outdated,
        status: a.verdict.ok ? "ready to restart" : a.verdict.reason,
      })),
    };
  }

  /** One interval. Returns quickly in idle mode. */
  async check(): Promise<void> {
    if (!this.herdrServerPresent()) return;

    if (!this.launcher) {
      this.launcher = findLauncher(this.ctx.env);
      if (!this.launcher) {
        if (this.mode !== "idle") this.log("claude not found on PATH; waiting");
        this.mode = "idle";
        return;
      }
    }
    const fingerprint = launcherFingerprint(this.launcher);
    if (!fingerprint) {
      this.launcher = undefined; // moved or reinstalled; search PATH again next time
      return;
    }
    // A config edit (e.g. turning dry_run off) gets a full check without waiting for an update.
    const configStamp = fileStamp(join(this.ctx.paths.configDir, CONFIG_FILE));
    if (configStamp !== this.configStamp) {
      this.configStamp = configStamp;
      this.forced = true;
    }
    if (this.mode === "idle" && fingerprint === this.fingerprint && !this.forced) return;

    // Update mode from here on.
    this.mode = "update";
    this.forced = false;
    this.lastCheckAt = Date.now();
    ({ config: this.config, warnings: this.configWarnings } = loadConfig(this.ctx.paths.configDir));
    if (fingerprint !== this.fingerprint || !this.installed || this.config.fakeInstalledVersion) {
      const installed = this.config.fakeInstalledVersion ?? (await installedVersion(this.launcher));
      if (!installed) {
        this.log(`could not determine the installed claude version (${this.launcher})`);
        this.mode = "idle";
        return;
      }
      if (installed !== this.installed) this.log(`installed claude version: ${installed}`);
      this.installed = installed;
    }
    this.fingerprint = fingerprint;
    const installed = this.installed;

    const sessions = readSessions(this.ctx.paths.sessionsDir);
    if (!sessions.some((s) => isOlder(s.version, installed))) {
      this.assessments = [];
      this.enterIdle("all claude sessions are up to date");
      return;
    }

    const herdr = this.ctx.herdr;
    let agents;
    try {
      agents = await herdr.agentList();
      if ((await herdr.pluginEnabled(this.ctx.pluginId)) === false) {
        this.log("plugin is disabled; stopping");
        this.stopping = true;
        return;
      }
      this.herdrFailures = 0;
    } catch (error) {
      this.onHerdrError(error);
      return;
    }

    const marks = this.ctx.store.readMarks();
    const now = Date.now();
    this.assessments = assess(sessions, agents, installed, marks, now, this.config);
    this.logReasonChanges();
    this.ctx.store.pruneMarks(new Set(sessions.map((s) => s.sessionId)), now);

    const candidate = nextCandidate(this.assessments);
    if (candidate) {
      let outcome: Outcome;
      try {
        outcome = await restartPane(candidate, this.restartDeps(installed));
      } catch (error) {
        if (error instanceof HerdrError) {
          this.onHerdrError(error);
          return;
        }
        outcome = { kind: "failed", reason: (error as Error).message };
      }
      await this.record(candidate, outcome, installed);
      if (outcome.kind !== "skipped") this.assessments = this.assessments.filter((a) => a !== candidate);
    }

    if (!hasPendingWork(this.assessments)) this.enterIdle("no restartable outdated panes left");
  }

  private enterIdle(reason: string): void {
    if (this.mode !== "idle") this.log(`idle: ${reason}`);
    this.mode = "idle";
  }

  private herdrServerPresent(): boolean {
    if (!this.ctx.herdrSocket) return true;
    try {
      statSync(this.ctx.herdrSocket);
      this.socketMisses = 0;
      return true;
    } catch {
      if (++this.socketMisses >= MAX_SOCKET_MISSES) {
        this.log("herdr server is gone; stopping");
        this.stopping = true;
      }
      return false;
    }
  }

  private onHerdrError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.log(`herdr call failed: ${message}`);
    if (++this.herdrFailures >= MAX_HERDR_FAILURES) {
      this.log("herdr is not answering; stopping");
      this.stopping = true;
    }
  }

  private logReasonChanges(): void {
    for (const a of this.assessments) {
      if (!a.outdated) continue;
      const reason = a.verdict.ok ? "ready to restart" : a.verdict.reason;
      if (this.lastReasons.get(a.session.sessionId) !== reason) {
        this.lastReasons.set(a.session.sessionId, reason);
        this.log(`${a.agent?.pane_id ?? "(no pane)"} ${short(a.session)} ${a.session.version}: ${reason}`);
      }
    }
  }

  private restartDeps(installed: string) {
    return {
      herdr: this.ctx.herdr,
      config: this.config,
      installed,
      pluginId: this.ctx.pluginId,
      pluginRoot: this.ctx.pluginRoot,
      stateDir: this.ctx.paths.stateDir,
      readSessions: () => readSessions(this.ctx.paths.sessionsDir),
      log: (message: string) => this.log(message),
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    };
  }

  private async record(candidate: Assessment, outcome: Outcome, installed: string): Promise<void> {
    const { session } = candidate;
    const pane = candidate.agent?.pane_id ?? "?";
    const at = Date.now();
    const store = this.ctx.store;
    switch (outcome.kind) {
      case "restarted":
        store.setMark(session.sessionId, { version: installed, result: "done", at });
        this.log(
          `${pane} ${short(session)}: restarted ${session.version} -> ${installed}` +
            (outcome.draftRestored === undefined ? "" : outcome.draftRestored ? ", draft restored" : ", draft NOT restored"),
        );
        await this.notify("Claude Code updated", `${pane}: ${session.version} → ${installed}`);
        break;
      case "dry-run":
        store.setMark(session.sessionId, { version: installed, result: "dry-run", at });
        this.log(`${pane} ${short(session)}: dry run, would restart with: claude ${outcome.args.join(" ")}`);
        break;
      case "declined":
        store.setMark(session.sessionId, { version: installed, result: "declined", at });
        this.log(`${pane} ${short(session)}: countdown cancelled; leaving it on ${session.version}`);
        break;
      case "failed":
        store.setMark(session.sessionId, { version: installed, result: "failed", reason: outcome.reason, at });
        this.log(`${pane} ${short(session)}: FAILED: ${outcome.reason}`);
        await this.notify("Claude Code update: restart failed", `${pane}: ${outcome.reason}`);
        break;
      case "skipped":
        this.log(`${pane} ${short(session)}: not now: ${outcome.reason}`);
        break;
    }
  }

  private async notify(title: string, body: string): Promise<void> {
    if (!this.config.toast) return;
    try {
      await this.ctx.herdr.notify(title, body);
    } catch {
      // best effort
    }
  }

  private removeStaleCountdownFiles(): void {
    try {
      for (const name of readdirSync(this.ctx.paths.stateDir)) {
        if (name.startsWith("countdown-")) unlinkSync(join(this.ctx.paths.stateDir, name));
      }
    } catch {
      // nothing to clean
    }
  }
}

function short(session: ClaudeSession): string {
  return session.sessionId.slice(0, 8);
}

function fileStamp(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return `${stat.size}|${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}
