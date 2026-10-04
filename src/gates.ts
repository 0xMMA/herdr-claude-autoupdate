/**
 * Pure decision logic: no I/O, so every reason for "not now" is unit-testable.
 * A verdict marked `final` will not change before the next Claude Code version, so
 * the clock does not stay in update mode waiting for it.
 */
import type { ClaudeSession } from "./claude.ts";
import type { Config } from "./config.ts";
import type { AgentInfo, ProcessInfo, ForegroundProcess } from "./herdr.ts";
import type { ScreenInfo } from "./screen.ts";
import type { Mark, Marks } from "./store.ts";
import { isOlder } from "./version.ts";

export type Verdict = { ok: true } | { ok: false; reason: string; final: boolean };

const OK: Verdict = { ok: true };
const wait = (reason: string): Verdict => ({ ok: false, reason, final: false });
const never = (reason: string): Verdict => ({ ok: false, reason, final: true });

type GateConfig = Pick<Config, "dryRun" | "quietSeconds" | "rescueDrafts" | "focusedUnattendedMinutes">;

/** Cheap checks on Claude's own session file; run before any herdr call. */
export function sessionGate(
  session: ClaudeSession,
  installed: string,
  mark: Mark | undefined,
  now: number,
  config: GateConfig,
): Verdict {
  if (!isOlder(session.version, installed)) return never("up to date");
  if (mark && mark.version === installed) {
    if (mark.result === "dry-run") {
      if (config.dryRun) return never("dry run: already logged");
    } else {
      return never(`${mark.result}${mark.reason ? `: ${mark.reason}` : ""}`);
    }
  }
  if (session.kind !== "interactive") return never(`not interactive (${session.kind || "unknown"})`);
  if (session.status !== "idle") return wait(`claude is ${session.status}`);
  const idleFor = now - session.statusUpdatedAt;
  if (idleFor < config.quietSeconds * 1000) return wait("quiet period");
  return OK;
}

export function paneGate(agent: AgentInfo): Verdict {
  if (agent.agent !== "claude") return never("pane is no longer running claude");
  if (agent.launch_pending) return wait("herdr: launch pending");
  if (agent.agent_status !== "idle" && agent.agent_status !== "done") return wait(`herdr: ${agent.agent_status}`);
  return OK;
}

export function screenGate(screen: ScreenInfo, config: GateConfig): Verdict {
  if (screen.prompt === "absent") return wait("prompt box not visible (dialog open?)");
  if (screen.prompt === "draft") {
    if (!config.rescueDrafts) return wait("unsent draft in the prompt");
    if (screen.hasAttachment) return wait("unsent draft contains attachments");
  }
  return OK;
}

/** The Claude process must still be the pane's foreground process. */
export function findClaudeProcess(info: ProcessInfo, session: ClaudeSession): ForegroundProcess | undefined {
  return info.foreground_processes.find((p) => p.pid === session.pid);
}

export function claudeStillInForeground(info: ProcessInfo, pid: number): boolean {
  return info.foreground_processes.some((p) => p.pid === pid || /^claude(\.exe)?$/i.test(p.name));
}

/** When the countdown popup cannot be shown, the focused pane is only touched after a long idle time. */
export function unattendedLongEnough(session: ClaudeSession, now: number, config: GateConfig): boolean {
  return now - session.statusUpdatedAt >= config.focusedUnattendedMinutes * 60_000;
}

export interface Assessment {
  session: ClaudeSession;
  agent: AgentInfo | undefined;
  outdated: boolean;
  verdict: Verdict;
}

/**
 * Pairs Claude sessions with herdr panes by session id and decides which ones may be
 * restarted now. Sessions outside herdr are reported but never acted on (R4, R10).
 */
export function assess(
  sessions: readonly ClaudeSession[],
  agents: readonly AgentInfo[],
  installed: string,
  marks: Marks,
  now: number,
  config: GateConfig,
): Assessment[] {
  const bySession = new Map<string, AgentInfo>();
  for (const agent of agents) {
    const id = agent.agent_session?.value;
    if (agent.agent === "claude" && id) bySession.set(id, agent);
  }

  const out: Assessment[] = [];
  for (const session of sessions) {
    const agent = bySession.get(session.sessionId);
    const outdated = isOlder(session.version, installed);
    if (!agent) {
      if (outdated) out.push({ session, agent, outdated, verdict: never("not in a herdr pane on this server") });
      continue;
    }
    let verdict = sessionGate(session, installed, marks[session.sessionId], now, config);
    if (verdict.ok) verdict = paneGate(agent);
    out.push({ session, agent, outdated, verdict });
  }
  return out;
}

/** True while some outdated session in a herdr pane may still become restartable. */
export function hasPendingWork(assessments: readonly Assessment[]): boolean {
  return assessments.some((a) => a.outdated && (a.verdict.ok || !a.verdict.final));
}

/** Restart order: the session that has been idle longest goes first. */
export function nextCandidate(assessments: readonly Assessment[]): Assessment | undefined {
  return assessments
    .filter((a) => a.verdict.ok && a.agent)
    .sort((a, b) => a.session.statusUpdatedAt - b.session.statusUpdatedAt)[0];
}
