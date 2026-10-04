import { execFile } from "node:child_process";

/** Error reported by the herdr CLI (JSON on stderr, exit status 1) or a failed invocation. */
export class HerdrError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface AgentInfo {
  pane_id: string;
  agent: string | null;
  agent_status: AgentStatus;
  focused: boolean;
  name: string | null;
  launch_pending?: boolean;
  agent_session: { value: string } | null;
}

export interface ForegroundProcess {
  pid: number;
  name: string;
  argv: string[] | null;
}

export interface ProcessInfo {
  pane_id: string;
  shell_pid: number | null;
  foreground_processes: ForegroundProcess[];
}

/** The subset of the herdr CLI this plugin uses. Narrow on purpose so tests can fake it. */
export interface Herdr {
  agentList(): Promise<AgentInfo[]>;
  agentGet(target: string): Promise<AgentInfo>;
  processInfo(paneId: string): Promise<ProcessInfo>;
  readScreen(paneId: string): Promise<string>;
  sendKeys(paneId: string, keys: string[]): Promise<void>;
  agentStart(name: string, paneId: string, args: string[], timeoutMs: number): Promise<void>;
  openPluginPane(pluginId: string, entrypoint: string, cwd: string, env: Record<string, string>): Promise<void>;
  notify(title: string, body: string): Promise<void>;
  pluginEnabled(pluginId: string): Promise<boolean | undefined>;
}

const TIMEOUT_MS = 20_000;

export class HerdrCli implements Herdr {
  private readonly bin: string;

  constructor(bin: string = process.env.HERDR_BIN_PATH || "herdr") {
    this.bin = bin;
  }

  private run(args: string[], timeoutMs = TIMEOUT_MS): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.bin,
        args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (!error) return resolve(stdout);
          reject(toHerdrError(error, stderr || stdout));
        },
      );
    });
  }

  private async json(args: string[], timeoutMs?: number): Promise<Record<string, unknown>> {
    const out = await this.run(args, timeoutMs);
    try {
      const parsed = JSON.parse(out) as { result?: Record<string, unknown> };
      return parsed.result ?? {};
    } catch {
      throw new HerdrError("invalid_json", `herdr ${args[0]} ${args[1] ?? ""} returned non-JSON output`);
    }
  }

  async agentList(): Promise<AgentInfo[]> {
    const result = await this.json(["agent", "list"]);
    return (result.agents as AgentInfo[] | undefined) ?? [];
  }

  async agentGet(target: string): Promise<AgentInfo> {
    const result = await this.json(["agent", "get", target]);
    return result.agent as AgentInfo;
  }

  async processInfo(paneId: string): Promise<ProcessInfo> {
    const result = await this.json(["pane", "process-info", "--pane", paneId]);
    return result.process_info as ProcessInfo;
  }

  readScreen(paneId: string): Promise<string> {
    return this.run(["pane", "read", paneId, "--source", "visible", "--format", "ansi"]);
  }

  async sendKeys(paneId: string, keys: string[]): Promise<void> {
    await this.run(["agent", "send-keys", paneId, ...keys]);
  }

  async agentStart(name: string, paneId: string, args: string[], timeoutMs: number): Promise<void> {
    await this.run(
      ["agent", "start", name, "--kind", "claude", "--pane", paneId, "--timeout", String(timeoutMs), "--", ...args],
      timeoutMs + TIMEOUT_MS,
    );
  }

  async openPluginPane(pluginId: string, entrypoint: string, cwd: string, env: Record<string, string>): Promise<void> {
    const envArgs = Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
    await this.run(["plugin", "pane", "open", "--plugin", pluginId, "--entrypoint", entrypoint, "--cwd", cwd, ...envArgs]);
  }

  async notify(title: string, body: string): Promise<void> {
    await this.run(["notification", "show", title, "--body", body]);
  }

  async pluginEnabled(pluginId: string): Promise<boolean | undefined> {
    const result = await this.json(["plugin", "list", "--plugin", pluginId, "--json"]);
    const plugins = (result.plugins as Array<{ id?: string; enabled?: boolean }> | undefined) ?? [];
    const plugin = plugins.find((p) => p.id === pluginId);
    return plugin ? plugin.enabled !== false : undefined;
  }
}

export function toHerdrError(error: Error & { code?: unknown; killed?: boolean }, output: string): HerdrError {
  if (error.killed) return new HerdrError("timeout", "herdr command timed out");
  if (error.code === "ENOENT") return new HerdrError("herdr_not_found", "herdr binary not found");
  try {
    const parsed = JSON.parse(output) as { error?: { code?: string; message?: string } };
    if (parsed.error?.code) return new HerdrError(parsed.error.code, parsed.error.message ?? parsed.error.code);
  } catch {
    // not JSON
  }
  const text = output.trim() || error.message;
  return new HerdrError(/server.*not running|connect/i.test(text) ? "server_not_running" : "herdr_failed", text);
}
