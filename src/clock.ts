import { readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactArgs } from "./args.ts";
import {
  defaultModeName,
  findGitRoot,
  findLauncher,
  isAlive,
  installedVersion,
  isTrustedFolder,
  launcherFingerprint,
  liveSessions,
  readSessions,
  readTrustedFolders,
  standardLauncherDirs,
  type ClaudeSession,
} from "./claude.ts";
import { CONFIG_FILE, loadConfig, type Config } from "./config.ts";
import { assess, hasPendingWork, restartCandidates, sessionGate, type Assessment } from "./gates.ts";
import { HerdrError, type AgentInfo, type Herdr } from "./herdr.ts";
import { serveExclusive, type Command } from "./ipc.ts";
import type { Paths } from "./paths.ts";
import { restartPane, type Outcome, type RestartDeps } from "./restart.ts";
import type { Store } from "./store.ts";
import { isOlder } from "./version.ts";

/**
 * The clock is the plugin's only long-running process (R11):
 *
 * - idle mode: one stat() of the claude launcher and of config.json per interval;
 * - update mode: entered when either changed (or on start / on demand). It reads Claude's
 *   session files and talks to herdr only while outdated panes remain.
 */

export interface ClockContext {
  paths: Paths;
  store: Store;
  herdr: Herdr;
  pluginId: string;
  pluginRoot: string;
  herdrSocket: string | undefined;
  env: Record<string, string | undefined>;
  /** Process liveness check; injectable for tests. */
  isAlive?: (pid: number) => boolean;
  /** The user's home directory; injectable for tests. */
  home?: string;
  /** Git root lookup; injectable for tests. */
  findGitRoot?: (dir: string) => string | undefined;
  /** Standard install locations searched after PATH; injectable for tests. */
  standardDirs?: readonly string[];
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
const MAX_LOOKUP_FAILURES = 3;
/** A pane that was skipped right before acting is retried after this long; others go first. */
const SKIP_BACKOFF_MS = 3 * 60_000;
/** After this many update-mode checks without a restart, check less often. */
const SLOWDOWN_AFTER = 10;
const SLOWDOWN_FACTOR = 5;
const STALE_COUNTDOWN_MS = 10 * 60_000;

export class Clock {
  private readonly ctx: ClockContext;
  private mode: Mode = "update"; // the first check after start is always a full one
  private config: Config;
  private configWarnings: string[];
  private configStamp: string | undefined;
  private launcher: string | undefined;
  private fingerprint: string | undefined;
  /** What `installed` was derived from: the launcher fingerprint or the fake version. */
  private installedKey: string | undefined;
  private installed: string | undefined;
  private defaultMode: string | undefined;
  private lastCheckAt: number | undefined;
  private agents: AgentInfo[] = [];
  private assessments: Assessment[] = [];
  private readonly skipped = new Map<string, { until: number; reason: string }>();
  private readonly lastReasons = new Map<string, string>();
  private unproductiveChecks = 0;
  private herdrFailures = 0;
  private lookupFailures = 0;
  private defaultModeAttempts = 0;
  private socketMisses = 0;
  private forced = false;
  private reloadRequested = false;
  private launcherMissingLogged = false;
  private stopping = false;
  private readonly startedAt = Date.now();
  private wake: (() => void) | undefined;

  constructor(ctx: ClockContext) {
    this.ctx = ctx;
    ({ config: this.config, warnings: this.configWarnings } = loadConfig(ctx.paths.configDir));
    this.configStamp = fileStamp(join(ctx.paths.configDir, CONFIG_FILE));
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
        const timer = setTimeout(resolve, this.intervalMs());
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

  private intervalMs(): number {
    const base = this.config.intervalSeconds * 1000;
    return this.mode === "update" && this.unproductiveChecks >= SLOWDOWN_AFTER ? base * SLOWDOWN_FACTOR : base;
  }

  private handle(command: Command): unknown {
    switch (command) {
      case "ping":
        return "pong";
      case "tick":
        this.reloadRequested = true;
        this.unproductiveChecks = 0;
        this.skipped.clear();
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
    const now = Date.now();
    return {
      mode: this.mode,
      pid: process.pid,
      startedAt: this.startedAt,
      lastCheckAt: this.lastCheckAt,
      launcher: this.launcher,
      installed: this.installed,
      config: this.config,
      configWarnings: this.configWarnings,
      panes: this.assessments.map((a) => {
        const skip = this.skipped.get(a.session.sessionId);
        let status = a.verdict.ok ? "ready to restart" : a.verdict.reason;
        if (a.verdict.ok && skip && skip.until > now) status = `waiting: ${skip.reason}`;
        return { pane: a.agent?.pane_id, sessionId: a.session.sessionId, version: a.session.version, outdated: a.outdated, status };
      }),
    };
  }

  /** One interval. Returns quickly in idle mode. */
  async check(): Promise<void> {
    if (!this.herdrServerPresent()) return;

    // A config edit (e.g. turning dry_run off) or a tick gets one reload and a full check
    // without waiting for an update. The reload itself happens once, not every interval.
    const configStamp = fileStamp(join(this.ctx.paths.configDir, CONFIG_FILE));
    if (configStamp !== this.configStamp || this.reloadRequested) {
      this.configStamp = configStamp;
      this.reloadRequested = false;
      this.forced = true;
      ({ config: this.config, warnings: this.configWarnings } = loadConfig(this.ctx.paths.configDir));
      for (const warning of this.configWarnings) this.log(`config: ${warning}`);
      this.launcher = undefined; // claude_path may have changed
      this.launcherMissingLogged = false;
    }

    if (!this.launcher) this.launcher = this.resolveLauncher();
    const fingerprint = this.launcher ? launcherFingerprint(this.launcher) : undefined;
    if (!this.launcher || !fingerprint) {
      if (!this.launcherMissingLogged) {
        this.launcherMissingLogged = true;
        this.log(
          this.config.claudePath
            ? `claude_path ${this.config.claudePath} does not exist`
            : "claude not found on PATH or in the standard locations; set claude_path in config.json",
        );
      }
      this.launcher = undefined; // look again next interval (a few stat() calls)
      this.enterIdle("claude not found");
      return;
    }
    this.launcherMissingLogged = false;
    if (this.mode === "idle" && fingerprint === this.fingerprint && !this.forced) return;

    // Update mode from here on.
    this.forced = false;
    this.mode = "update";
    this.lastCheckAt = Date.now();
    this.fingerprint = fingerprint; // stored first: a failed lookup must not repeat every interval

    const installed = await this.resolveInstalled(fingerprint);
    if (!installed) {
      // A few retries (e.g. an antivirus scan of a fresh binary), then wait for the next change.
      if (this.lookupFailures >= MAX_LOOKUP_FAILURES) this.enterIdle("installed version unknown");
      return;
    }

    const sessions = liveSessions(readSessions(this.ctx.paths.sessionsDir), this.ctx.isAlive);
    const outdated = sessions.filter((s) => isOlder(s.version, installed));
    if (outdated.length === 0) {
      this.assessments = [];
      this.enterIdle("all claude sessions are up to date");
      return;
    }

    // Ask herdr only if some outdated session could be restarted now (R11).
    const now = Date.now();
    const marks = this.ctx.store.readMarks();
    const actionable = outdated.some(
      (s) => sessionGate(s, installed, marks[s.sessionId], now, this.config).ok && !this.inBackoff(s, now),
    );
    let agentsFresh = false;
    if (actionable || this.agents.length === 0) {
      try {
        this.agents = await this.ctx.herdr.agentList();
        agentsFresh = true;
        if ((await this.ctx.herdr.pluginEnabled(this.ctx.pluginId)) === false) {
          this.log("plugin is disabled; stopping");
          this.stopping = true;
          return;
        }
        this.herdrFailures = 0;
      } catch (error) {
        this.onHerdrError(error);
        return;
      }
    }

    // Claude's config is read at most once per check, and only when a session reaches the trust gate.
    let trusted: string[] | undefined | null = null;
    const home = this.ctx.home ?? homedir();
    const gitRoot = this.ctx.findGitRoot ?? findGitRoot;
    this.assessments = assess(sessions, this.agents, installed, marks, now, this.config, {
      agentsFresh,
      isTrusted: (cwd) => {
        if (trusted === null) {
          trusted = readTrustedFolders(this.ctx.paths.claudeConfigFile);
          if (!trusted) this.log(`cannot read ${this.ctx.paths.claudeConfigFile}; trying again later`);
        }
        return trusted ? isTrustedFolder(cwd, trusted, home, gitRoot(cwd)) : undefined;
      },
    });
    this.logReasonChanges();
    this.ctx.store.pruneMarks(new Set(sessions.map((s) => s.sessionId)), now);

    const acted = await this.restartOne(installed, now);
    this.unproductiveChecks = acted ? 0 : this.unproductiveChecks + 1;

    if (!hasPendingWork(this.assessments)) this.enterIdle("no restartable outdated panes left");
  }

  /** Tries candidates in order (longest idle first) until one is acted on; skips do not block the rest. */
  private async restartOne(installed: string, now: number): Promise<boolean> {
    const candidates = restartCandidates(this.assessments).filter((a) => !this.inBackoff(a.session, now));
    for (const candidate of candidates) {
      if (this.stopping) return false;
      let outcome: Outcome;
      try {
        outcome = await restartPane(candidate, await this.restartDeps(installed));
      } catch (error) {
        // Only the read-only checks can throw here; nothing was sent to the pane.
        const reason = `check failed: ${(error as Error).message}`;
        if (error instanceof HerdrError) this.onHerdrError(error);
        else this.log(`${candidate.agent?.pane_id}: ${reason}`);
        this.skipped.set(candidate.session.sessionId, { until: Date.now() + SKIP_BACKOFF_MS, reason });
        continue;
      }
      await this.record(candidate, outcome, installed);
      if (outcome.kind === "skipped") {
        this.skipped.set(candidate.session.sessionId, { until: Date.now() + SKIP_BACKOFF_MS, reason: outcome.reason });
        continue;
      }
      this.skipped.delete(candidate.session.sessionId);
      this.assessments = this.assessments.filter((a) => a !== candidate);
      return true;
    }
    return false;
  }

  private inBackoff(session: ClaudeSession, now: number): boolean {
    const skip = this.skipped.get(session.sessionId);
    return skip !== undefined && skip.until > now;
  }

  private async resolveInstalled(fingerprint: string): Promise<string | undefined> {
    const fake = this.config.fakeInstalledVersion;
    const key = fake ? `fake:${fake}` : `real:${fingerprint}`;
    if (key !== this.installedKey) {
      this.installedKey = key;
      this.installed = undefined;
      this.defaultMode = undefined;
      this.lookupFailures = 0;
      this.defaultModeAttempts = 0;
    }
    if (!this.installed) {
      try {
        this.installed = fake ?? (await installedVersion(this.launcher!));
      } catch (error) {
        this.log(`could not run ${this.launcher} --version: ${(error as Error).message}`);
      }
      if (!this.installed) {
        this.lookupFailures++;
        this.log(`could not determine the installed claude version (attempt ${this.lookupFailures} of ${MAX_LOOKUP_FAILURES})`);
        return undefined;
      }
      this.lookupFailures = 0;
      this.log(`installed claude version: ${this.installed}${fake ? " (fake_installed_version)" : ""}`);
    }
    // Needed to resume in the default permission mode; retried on a few later checks if it fails.
    if (!this.defaultMode && this.defaultModeAttempts < MAX_LOOKUP_FAILURES) {
      this.defaultModeAttempts++;
      try {
        this.defaultMode = await defaultModeName(this.launcher!);
      } catch {
        this.defaultMode = undefined;
      }
      if (!this.defaultMode) this.log("could not read the default permission mode name from claude --help");
    }
    return this.installed;
  }

  private resolveLauncher(): string | undefined {
    const configured = this.config.claudePath;
    if (configured) {
      // `~` is not expanded by anyone else here.
      return configured.replace(/^~(?=$|[\\/])/, this.ctx.home ?? homedir());
    }
    return findLauncher(this.ctx.env, process.platform, this.ctx.standardDirs ?? standardLauncherDirs(process.platform, this.ctx.home ?? homedir()));
  }

  private enterIdle(reason: string): void {
    if (this.mode !== "idle") this.log(`idle: ${reason}`);
    this.mode = "idle";
    this.unproductiveChecks = 0;
    this.agents = []; // panes change while idle; never judge with an old list
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

  private async restartDeps(installed: string): Promise<RestartDeps> {
    return {
      herdr: this.ctx.herdr,
      config: this.config,
      installed,
      defaultModeName: this.defaultMode,
      pluginId: this.ctx.pluginId,
      pluginRoot: this.ctx.pluginRoot,
      stateDir: this.ctx.paths.stateDir,
      readSessions: () => readSessions(this.ctx.paths.sessionsDir),
      isAlive: this.ctx.isAlive ?? isAlive,
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
        this.log(`${pane} ${short(session)}: dry run, would restart with: claude ${redactArgs(outcome.args).join(" ")}`);
        break;
      case "declined":
        store.setMark(session.sessionId, { version: installed, result: "declined", at });
        this.log(`${pane} ${short(session)}: countdown cancelled; leaving it on ${session.version}`);
        break;
      case "unsupported":
        store.setMark(session.sessionId, { version: installed, result: "failed", reason: `not restarted: ${outcome.reason}`, at });
        this.log(`${pane} ${short(session)}: not restarted: ${outcome.reason}`);
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

  /** Answer files of popups that never finished. Recent ones may belong to another clock. */
  private removeStaleCountdownFiles(): void {
    const dir = this.ctx.paths.stateDir;
    try {
      for (const name of readdirSync(dir)) {
        if (!name.startsWith("countdown-")) continue;
        const path = join(dir, name);
        if (Date.now() - statSync(path).mtimeMs > STALE_COUNTDOWN_MS) unlinkSync(path);
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
