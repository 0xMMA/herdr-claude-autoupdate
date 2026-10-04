import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface Paths {
  /** Plugin-owned runtime state: marks, log, countdown results. */
  stateDir: string;
  /** User-editable configuration (`config.json`). */
  configDir: string;
  /** Claude Code's per-process session files (`<pid>.json`). */
  sessionsDir: string;
  /** IPC endpoint of the clock for this herdr server. Doubles as the single-instance lock. */
  clockEndpoint: string;
}

type Env = Record<string, string | undefined>;

export function resolvePaths(env: Env = process.env, platform: NodeJS.Platform = process.platform): Paths {
  const fallback = join(tmpdir(), "herdr-claude-autoupdate");
  const stateDir = env.HERDR_PLUGIN_STATE_DIR || fallback;
  const configDir = env.HERDR_PLUGIN_CONFIG_DIR || stateDir;
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return {
    stateDir,
    configDir,
    sessionsDir: join(claudeDir, "sessions"),
    clockEndpoint: clockEndpoint(env.HERDR_SOCKET_PATH ?? "", stateDir, platform),
  };
}

/**
 * One clock per herdr server: plugin state is shared by all herdr sessions of a user,
 * so the endpoint is keyed by the server's socket path.
 */
export function clockEndpoint(herdrSocket: string, stateDir: string, platform: NodeJS.Platform): string {
  const id = createHash("sha256").update(herdrSocket).digest("hex").slice(0, 16);
  if (platform === "win32") return `\\\\.\\pipe\\herdr-claude-autoupdate-${id}`;
  const preferred = join(stateDir, `clock-${id}.sock`);
  // Unix socket paths are limited to ~104 bytes.
  return Buffer.byteLength(preferred) < 100 ? preferred : join(tmpdir(), `herdr-cau-${id}.sock`);
}
