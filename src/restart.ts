import { readFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { rebuildArgs, type RebuiltArgs } from "./args.ts";
import type { ClaudeSession } from "./claude.ts";
import type { Config } from "./config.ts";
import {
  claudeStillInForeground,
  findClaudeProcess,
  paneGate,
  screenGate,
  unattendedLongEnough,
  type Assessment,
} from "./gates.ts";
import { HerdrError, type AgentInfo, type ForegroundProcess, type Herdr } from "./herdr.ts";
import { parseScreen, type ScreenInfo } from "./screen.ts";
import { isOlder } from "./version.ts";

export interface RestartDeps {
  herdr: Herdr;
  config: Config;
  installed: string;
  /** The installed CLI's name for the default permission mode, if known. */
  defaultModeName: string | undefined;
  pluginId: string;
  pluginRoot: string;
  stateDir: string;
  readSessions(): ClaudeSession[];
  isAlive(pid: number): boolean;
  /** Reads dry run from config.json now, so switching it on stops a restart that is about to happen. */
  dryRunNow(): boolean;
  log(message: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type Outcome =
  | { kind: "restarted"; draftRestored: boolean | undefined }
  | { kind: "dry-run"; args: string[] }
  | { kind: "declined" }
  /** Not now; try again on a later check. Nothing is recorded. */
  | { kind: "skipped"; reason: string }
  /** Recorded; no further attempt for this session until the next Claude version. */
  | { kind: "failed"; reason: string }
  /** Cannot be restarted in place at all; recorded like a failure, but nothing was touched. */
  | { kind: "unsupported"; reason: string };

/**
 * `unavailable`: the popup could not be opened at all.
 * `no-answer`: it was opened but did not answer in time; it may still be on screen.
 */
export type CountdownAnswer = "proceed" | "cancel" | "unavailable" | "no-answer";

const AGENT_START_TIMEOUT_MS = 60_000;
const EXIT_WAIT_MS = 5_000;
const VERIFY_TIMEOUT_MS = 30_000;

/** herdr agent names: `[a-z][a-z0-9_-]{0,31}`. */
export function agentNameFor(paneId: string): string {
  return `cau-${paneId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 32).replace(/-+$/, "");
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number, stepMs: number, deps: RestartDeps): Promise<boolean> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (deps.now() >= deadline) return false;
    await deps.sleep(stepMs);
  }
}

async function screenOf(deps: RestartDeps, paneId: string): Promise<ScreenInfo> {
  return parseScreen(await deps.herdr.readScreen(paneId));
}

/** Compares drafts loosely: Claude re-wraps long lines, so only the words matter. */
export function sameDraft(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  return norm(a) !== "" && norm(a) === norm(b);
}

interface Fresh {
  agent: AgentInfo;
  proc: ForegroundProcess;
  screen: ScreenInfo;
}

/** All R5 checks, read live. Returns the reason to wait, or what is needed to act. */
async function freshCheck(candidate: Assessment, deps: RestartDeps): Promise<Fresh | string> {
  const { session } = candidate;
  const paneId = candidate.agent!.pane_id;
  const { herdr } = deps;

  const agent = await herdr.agentGet(paneId);
  if (agent.agent_session?.value !== session.sessionId) return "pane now hosts another session";
  const pane = paneGate(agent, session);
  if (!pane.ok) return pane.reason;

  const file = deps.readSessions().find((s) => s.pid === session.pid && s.sessionId === session.sessionId);
  if (!file) return "the session file is gone";
  if (file.status !== "idle") return `claude is ${file.status}`;

  const proc = findClaudeProcess(await herdr.processInfo(paneId), session);
  if (!proc) return "claude is not the pane's foreground process";

  const screen = await screenOf(deps, paneId);
  const verdict = screenGate(screen, deps.config);
  if (!verdict.ok) return verdict.reason;
  return { agent, proc, screen };
}

/**
 * Restarts one pane in place (R2, R3). Every precondition is re-checked right before
 * acting, because the user may have started typing since the candidate was chosen.
 */
export async function restartPane(candidate: Assessment, deps: RestartDeps): Promise<Outcome> {
  const { session } = candidate;
  const paneId = candidate.agent!.pane_id;
  const { config } = deps;

  let fresh = await freshCheck(candidate, deps);
  if (typeof fresh === "string") return { kind: "skipped", reason: fresh };
  // A worktree session lives elsewhere; `claude --resume` in the pane's directory would not find it.
  if ((fresh.proc.argv ?? []).some((a) => a === "--worktree" || a === "-w" || a.startsWith("--worktree="))) {
    return { kind: "unsupported", reason: "started with --worktree; resume it yourself" };
  }
  // Without the CLI's name for the default mode, settings could widen the permissions on resume.
  if (fresh.screen.permissionMode === null && !deps.defaultModeName) {
    return { kind: "skipped", reason: "the default permission mode name is not known yet" };
  }

  if (fresh.agent.focused && !config.dryRun) {
    const answer = await askViaCountdown(deps, paneId, `${paneId} · ${basename(session.cwd) || session.sessionId.slice(0, 8)}`);
    if (answer === "cancel") return { kind: "declined" };
    // A popup that was shown but did not answer may still be on screen: never act behind it.
    if (answer === "no-answer") return { kind: "skipped", reason: "the countdown popup did not answer" };
    if (answer === "unavailable" && !unattendedLongEnough(session, deps.now(), config)) {
      return { kind: "skipped", reason: "focused and the countdown could not be shown" };
    }
    // The popup took a few seconds; look again before touching anything.
    fresh = await freshCheck(candidate, deps);
    if (typeof fresh === "string") return { kind: "skipped", reason: fresh };
  }

  const rebuilt = rebuildArgs((fresh.proc.argv ?? []).slice(1), session.sessionId, fresh.screen.permissionMode, deps.defaultModeName);
  if (rebuilt.droppedUnknown.length > 0) {
    deps.log(`${paneId}: not carrying over unknown flags ${rebuilt.droppedUnknown.join(" ")}`);
  }
  if (rebuilt.droppedPositionals > 0) {
    deps.log(`${paneId}: not carrying over ${rebuilt.droppedPositionals} positional argument(s)`);
  }
  if (config.dryRun || deps.dryRunNow()) return { kind: "dry-run", args: rebuilt.args };

  // From the first key on, any error must still end in a recorded outcome.
  try {
    return await act(candidate, fresh, rebuilt, deps);
  } catch (error) {
    return { kind: "failed", reason: `interrupted: ${(error as Error).message}` };
  }
}

async function act(candidate: Assessment, fresh: Fresh, rebuilt: RebuiltArgs, deps: RestartDeps): Promise<Outcome> {
  const { session } = candidate;
  const paneId = candidate.agent!.pane_id;
  const { herdr } = deps;

  // Any file for this session that exists now is not the resumed process.
  const before = new Set(deps.readSessions().filter((s) => s.sessionId === session.sessionId).map((s) => s.pid));

  // R6: park the draft in Claude's input history before the process goes away.
  const draft = fresh.screen.prompt === "draft" ? fresh.screen.draft : undefined;
  if (draft !== undefined) {
    deps.log(`${paneId}: saving unsent draft to Claude's input history: ${JSON.stringify(draft)}`);
    await herdr.sendKeys(paneId, ["esc", "esc"]);
    await deps.sleep(600);
    const after = await screenOf(deps, paneId);
    if (after.prompt !== "empty") {
      if (after.prompt === "absent") await herdr.sendKeys(paneId, ["esc"]);
      return { kind: "failed", reason: "could not move the draft into the input history" };
    }
  }

  // Ctrl+C on an empty prompt arms "press again to exit"; the second press exits.
  // The window is short, so a retry sends a pair again.
  const gone = async () => !claudeStillInForeground(await herdr.processInfo(paneId), session.pid);
  let exited = false;
  for (let attempt = 0; attempt < 2 && !exited; attempt++) {
    await herdr.sendKeys(paneId, ["ctrl+c"]);
    await deps.sleep(400);
    await herdr.sendKeys(paneId, ["ctrl+c"]);
    exited = await waitFor(gone, EXIT_WAIT_MS, 250, deps);
  }
  // R16: never kill. A process that does not exit is left alone and reported.
  if (!exited) return { kind: "failed", reason: "claude did not exit after Ctrl+C" };

  await deps.sleep(500);
  const name = fresh.agent.name ?? agentNameFor(paneId);
  let blockedAtStart = false;
  try {
    await herdr.agentStart(name, paneId, rebuilt.args, AGENT_START_TIMEOUT_MS);
  } catch (error) {
    // Blocked at startup (a dialog) still means Claude is running; it may need the user.
    if (!(error instanceof HerdrError && error.code === "agent_not_ready")) {
      return { kind: "failed", reason: `agent start failed: ${(error as Error).message}` };
    }
    blockedAtStart = true;
  }

  let resumed: ClaudeSession | undefined;
  await waitFor(
    () => {
      resumed = deps
        .readSessions()
        .find((s) => s.sessionId === session.sessionId && !before.has(s.pid) && deps.isAlive(s.pid));
      return resumed !== undefined;
    },
    VERIFY_TIMEOUT_MS,
    1000,
    deps,
  );
  if (!resumed) {
    return {
      kind: "failed",
      reason: blockedAtStart
        ? "claude started but waits for input in a dialog; answer it in the pane"
        : "the resumed session did not come up",
    };
  }

  // The draft goes back first: it must not depend on the version check below.
  const draftRestored = draft === undefined ? undefined : await restoreDraft(deps, paneId, draft);

  if (isOlder(resumed.version, deps.installed)) {
    return { kind: "failed", reason: `resumed, but still on ${resumed.version}` };
  }
  return { kind: "restarted", draftRestored };
}

async function restoreDraft(deps: RestartDeps, paneId: string, draft: string): Promise<boolean> {
  try {
    return await recallDraft(deps, paneId, draft);
  } catch (error) {
    // The restart itself succeeded; a herdr hiccup here must not turn it into a failure.
    deps.log(`${paneId}: could not recall the draft (${(error as Error).message}); it is in Claude's input history (press Up) and in this log`);
    return false;
  }
}

async function recallDraft(deps: RestartDeps, paneId: string, draft: string): Promise<boolean> {
  const { herdr } = deps;
  let restored = false;
  const ready = await waitFor(async () => (await screenOf(deps, paneId)).prompt === "empty", 15_000, 500, deps);
  if (ready) {
    await herdr.sendKeys(paneId, ["up"]);
    await deps.sleep(600);
    const screen = await screenOf(deps, paneId);
    restored = screen.prompt === "draft" && sameDraft(screen.draft, draft);
    // Up recalled an older prompt instead: step back to the empty prompt.
    if (!restored && screen.prompt === "draft") await herdr.sendKeys(paneId, ["down"]);
  }
  if (!restored) {
    deps.log(`${paneId}: draft not restored automatically; it is in Claude's input history (press Up) and in this log`);
  }
  return restored;
}

/** Shows the countdown popup over the focused pane (R7) and waits for its answer. */
export async function askViaCountdown(deps: RestartDeps, paneId: string, label: string): Promise<CountdownAnswer> {
  const resultFile = join(deps.stateDir, `countdown-${process.pid}-${deps.now()}.result`);
  try {
    await deps.herdr.openPluginPane(deps.pluginId, "countdown", deps.pluginRoot, {
      CAU_RESULT: resultFile,
      CAU_SECONDS: String(deps.config.countdownSeconds),
      CAU_LABEL: label,
    });
  } catch (error) {
    deps.log(`${paneId}: countdown popup unavailable (${(error as Error).message})`);
    return "unavailable";
  }
  const deadline = deps.now() + (deps.config.countdownSeconds + 5) * 1000;
  while (deps.now() < deadline) {
    try {
      const answer = readFileSync(resultFile, "utf8").trim();
      if (answer === "cancel" || answer === "proceed") {
        try {
          unlinkSync(resultFile);
        } catch {
          // already gone
        }
        return answer;
      }
    } catch {
      // not written yet
    }
    await deps.sleep(250);
  }
  deps.log(`${paneId}: no answer from the countdown popup`);
  return "no-answer";
}
