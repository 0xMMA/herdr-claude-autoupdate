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

export async function installedVersion(launcher: string): Promise<string | undefined> {
  try {
    const fromPath = versionFromInstallPath(realpathSync(launcher));
    if (fromPath) return fromPath;
  } catch {
    // fall through to --version
  }
  const { stdout } = await execFileAsync(launcher, ["--version"], {
    timeout: 30_000,
    windowsHide: true,
    // `claude.cmd` (npm installs on Windows) needs a shell to run.
    shell: /\.(cmd|bat)$/i.test(launcher),
  });
  const version = parseVersion(stdout);
  return version ? formatVersion(version) : undefined;
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
