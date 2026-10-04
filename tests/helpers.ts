import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeSession } from "../src/claude.ts";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import type { AgentInfo, Herdr, ProcessInfo } from "../src/herdr.ts";

export const RULE_STYLE = "\u001b[0m\u001b[38;2;136;136;136m";
export const NBSP = " ";

/** Builds a capture shaped like `herdr pane read --format ansi` of an idle Claude pane. */
export function screen(options: {
  promptLines?: string[];
  footer?: string;
  topLabel?: string;
  above?: string[];
}): string {
  const rule = `${RULE_STYLE}${"─".repeat(60)}\u001b[0m`;
  const top = options.topLabel
    ? `${RULE_STYLE}${"─".repeat(40)} ${options.topLabel} ${"─".repeat(4)}\u001b[0m`
    : rule;
  const prompt = options.promptLines ?? [`❯${NBSP}`];
  return [
    ...(options.above ?? ["● Done. The tests pass now.", ""]),
    top,
    ...prompt,
    rule,
    "  \u001b[0m\u001b[38;5;250m12:00\u001b[0m\u001b[2m\u001b[38;2;153;153;153m │ \u001b[0mmy-project",
    options.footer ?? "  \u001b[0m\u001b[38;2;255;193;7m⏵⏵ auto mode on\u001b[0m\u001b[38;2;153;153;153m (shift+tab to cycle)\u001b[0m",
  ].join("\n");
}

export const DIM = (text: string) => `\u001b[2m\u001b[38;2;153;153;153m${text}\u001b[0m`;

export function session(overrides: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    pid: 4242,
    sessionId: "00000000-0000-4000-8000-000000000001",
    cwd: "/work/project",
    version: "2.1.289",
    status: "idle",
    statusUpdatedAt: 0,
    kind: "interactive",
    ...overrides,
  };
}

export function agent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    pane_id: "w1:p2",
    agent: "claude",
    agent_status: "idle",
    focused: false,
    name: null,
    launch_pending: false,
    agent_session: { value: "00000000-0000-4000-8000-000000000001" },
    ...overrides,
  };
}

export function config(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, dryRun: false, ...overrides };
}

export function tempDir(prefix = "cau-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeSession(dir: string, s: ClaudeSession): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${s.pid}.json`), JSON.stringify(s));
}

export function processInfo(pids: Array<{ pid: number; name: string; argv?: string[] }>): ProcessInfo {
  return {
    pane_id: "w1:p2",
    shell_pid: 100,
    foreground_processes: pids.map((p) => ({ pid: p.pid, name: p.name, argv: p.argv ?? [p.name] })),
  };
}

type Call = { method: string; args: unknown[] };

/**
 * Scriptable stand-in for the herdr CLI. Each queue yields its next value per call and
 * repeats its last value once exhausted.
 */
export class FakeHerdr implements Herdr {
  calls: Call[] = [];
  agents: AgentInfo[] = [];
  agentGets: AgentInfo[] = [];
  processInfos: ProcessInfo[] = [];
  screens: string[] = [];
  startError: Error | undefined;
  openPaneError: Error | undefined;
  onOpenPane: ((env: Record<string, string>) => void) | undefined;
  onAgentStart: (() => void) | undefined;
  enabled: boolean | undefined = true;

  private take<T>(queue: T[], what: string): T {
    if (queue.length === 0) throw new Error(`FakeHerdr: no ${what} scripted`);
    return queue.length > 1 ? queue.shift()! : queue[0]!;
  }

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  keys(): string[][] {
    return this.calls.filter((c) => c.method === "sendKeys").map((c) => c.args[1] as string[]);
  }

  async agentList(): Promise<AgentInfo[]> {
    this.calls.push({ method: "agentList", args: [] });
    return this.agents;
  }
  async agentGet(target: string): Promise<AgentInfo> {
    this.calls.push({ method: "agentGet", args: [target] });
    return this.take(this.agentGets, "agentGet");
  }
  async processInfo(paneId: string): Promise<ProcessInfo> {
    this.calls.push({ method: "processInfo", args: [paneId] });
    return this.take(this.processInfos, "processInfo");
  }
  async readScreen(paneId: string): Promise<string> {
    this.calls.push({ method: "readScreen", args: [paneId] });
    return this.take(this.screens, "screen");
  }
  sendKeysError: Error | undefined;
  async sendKeys(paneId: string, keys: string[]): Promise<void> {
    this.calls.push({ method: "sendKeys", args: [paneId, keys] });
    if (this.sendKeysError) throw this.sendKeysError;
  }
  async agentStart(name: string, paneId: string, args: string[], timeoutMs: number): Promise<void> {
    this.calls.push({ method: "agentStart", args: [name, paneId, args, timeoutMs] });
    this.onAgentStart?.();
    if (this.startError) throw this.startError;
  }
  async openPluginPane(pluginId: string, entrypoint: string, cwd: string, env: Record<string, string>): Promise<void> {
    this.calls.push({ method: "openPluginPane", args: [pluginId, entrypoint, cwd, env] });
    if (this.openPaneError) throw this.openPaneError;
    this.onOpenPane?.(env);
  }
  async notify(title: string, body: string): Promise<void> {
    this.calls.push({ method: "notify", args: [title, body] });
  }
  async pluginEnabled(): Promise<boolean | undefined> {
    this.calls.push({ method: "pluginEnabled", args: [] });
    return this.enabled;
  }
}
