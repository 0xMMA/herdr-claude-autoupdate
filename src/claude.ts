import { execFile } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { formatVersion, parseVersion } from "./version.ts";

const execFileAsync = promisify(execFile);

type Env = Record<string, string | undefined>;

/** Resolves `claude` the same way a shell would, so it is the binary `herdr agent start` launches. */
export function findLauncher(env: Env = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const exts = platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `claude${ext.toLowerCase()}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

/**
 * Cheap change detector for the idle loop: one stat plus a symlink resolve.
 * The native installer swaps the symlink target (Linux, macOS) or replaces the file (Windows).
 */
export function launcherFingerprint(launcher: string): string | undefined {
  try {
    const stat = statSync(launcher);
    let target = launcher;
    try {
      target = realpathSync(launcher);
    } catch {
      // keep the launcher path
    }
    return `${target}|${stat.size}|${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/** `~/.local/share/claude/versions/2.1.290` → `2.1.290`, without starting the binary. */
export function versionFromInstallPath(realPath: string): string | undefined {
  if (basename(dirname(realPath)) !== "versions") return undefined;
  const version = parseVersion(basename(realPath));
  return version ? formatVersion(version) : undefined;
}

/** Runs the launcher with one argument. `.cmd` shims (npm on Windows) go through cmd.exe, quoted by hand. */
async function runLauncher(launcher: string, arg: string): Promise<string> {
  const options = { timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" as const };
  if (/\.(cmd|bat)$/i.test(launcher)) {
    const { stdout } = await execFileAsync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${launcher}" ${arg}"`], {
      ...options,
      windowsVerbatimArguments: true,
    });
    return stdout;
  }
  const { stdout } = await execFileAsync(launcher, [arg], options);
  return stdout;
}

export async function installedVersion(launcher: string): Promise<string | undefined> {
  try {
    const fromPath = versionFromInstallPath(realpathSync(launcher));
    if (fromPath) return fromPath;
  } catch {
    // fall through to --version
  }
  const version = parseVersion(await runLauncher(launcher, "--version"));
  return version ? formatVersion(version) : undefined;
}

/**
 * The installed CLI's name for the default permission mode, read from `--help`
 * (`manual` today, `default` in older versions). Undefined if neither is offered.
 */
export function defaultModeFromHelp(help: string): string | undefined {
  const match = /--permission-mode[\s\S]*?\(choices:([\s\S]*?)\)/.exec(help);
  if (!match) return undefined;
  const choices = [...match[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return ["manual", "default"].find((name) => choices.includes(name));
}

export async function defaultModeName(launcher: string): Promise<string | undefined> {
  return defaultModeFromHelp(await runLauncher(launcher, "--help"));
}

/** Liveness without starting a process: signal 0 only tests for existence, also on Windows. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Drops files of processes that no longer exist (left behind by a crash) and keeps one
 * entry per session id, the most recently updated one.
 */
export function liveSessions(sessions: readonly ClaudeSession[], alive: (pid: number) => boolean = isAlive): ClaudeSession[] {
  const byId = new Map<string, ClaudeSession>();
  for (const session of sessions) {
    if (!alive(session.pid)) continue;
    const seen = byId.get(session.sessionId);
    if (!seen || session.statusUpdatedAt > seen.statusUpdatedAt) byId.set(session.sessionId, session);
  }
  return [...byId.values()];
}

export interface ClaudeSession {
  pid: number;
  sessionId: string;
  cwd: string;
  version: string;
  /** Observed values: `idle`, `busy`, `shell`. */
  status: string;
  statusUpdatedAt: number;
  kind: string;
}

/** Parses one `~/.claude/sessions/<pid>.json`. Returns undefined for anything unexpected. */
export function parseSession(raw: unknown): ClaudeSession | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.pid !== "number" ||
    typeof r.sessionId !== "string" ||
    typeof r.version !== "string" ||
    typeof r.status !== "string" ||
    typeof r.statusUpdatedAt !== "number"
  ) {
    return undefined;
  }
  return {
    pid: r.pid,
    sessionId: r.sessionId,
    cwd: typeof r.cwd === "string" ? r.cwd : "",
    version: r.version,
    status: r.status,
    statusUpdatedAt: r.statusUpdatedAt,
    kind: typeof r.kind === "string" ? r.kind : "",
  };
}

export function readSessions(sessionsDir: string): ClaudeSession[] {
  let names: string[];
  try {
    names = readdirSync(sessionsDir);
  } catch {
    return [];
  }
  const sessions: ClaudeSession[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const session = parseSession(JSON.parse(readFileSync(join(sessionsDir, name), "utf8")));
      if (session) sessions.push(session);
    } catch {
      // being rewritten or not ours; the next check reads it again
    }
  }
  return sessions;
}
