import { readFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { rebuildArgs } from "./args.ts";
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
import { HerdrError, type Herdr } from "./herdr.ts";
import { parseScreen, type ScreenInfo } from "./screen.ts";
import { isOlder } from "./version.ts";

export interface RestartDeps {
  herdr: Herdr;
  config: Config;
  installed: string;
  pluginId: string;
  pluginRoot: string;
  stateDir: string;
  readSessions(): ClaudeSession[];
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
  | { kind: "failed"; reason: string };

export type CountdownAnswer = "proceed" | "cancel" | "unavailable";

const AGENT_START_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 10_000;
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

/**
 * Restarts one pane in place (R2, R3). Every precondition is re-checked right before
 * acting, because the user may have started typing since the candidate was chosen.
 */
export async function restartPane(candidate: Assessment, deps: RestartDeps): Promise<Outcome> {
  const { session } = candidate;
  const paneId = candidate.agent!.pane_id;
  const { herdr, config } = deps;

  const agent = await herdr.agentGet(paneId);
  if (agent.agent_session?.value !== session.sessionId) return { kind: "skipped", reason: "pane now hosts another session" };
  let verdict = paneGate(agent);
  if (!verdict.ok) return { kind: "skipped", reason: verdict.reason };

  const proc = findClaudeProcess(await herdr.processInfo(paneId), session);
  if (!proc) return { kind: "skipped", reason: "claude is not the pane's foreground process" };

  let screen = await screenOf(deps, paneId);
  verdict = screenGate(screen, config);
  if (!verdict.ok) return { kind: "skipped", reason: verdict.reason };

  if (agent.focused && !config.dryRun) {
    const answer = await askViaCountdown(deps, paneId, `${paneId} · ${basename(session.cwd) || session.sessionId.slice(0, 8)}`);
    if (answer === "cancel") return { kind: "declined" };
    if (answer === "unavailable" && !unattendedLongEnough(session, deps.now(), config)) {
      return { kind: "skipped", reason: "focused and the countdown could not be shown" };
    }
    // The popup took a few seconds; look again before touching anything.
    verdict = paneGate(await herdr.agentGet(paneId));
    if (!verdict.ok) return { kind: "skipped", reason: verdict.reason };
    screen = await screenOf(deps, paneId);
    verdict = screenGate(screen, config);
    if (!verdict.ok) return { kind: "skipped", reason: verdict.reason };
  }

  const rebuilt = rebuildArgs((proc.argv ?? []).slice(1), session.sessionId, screen.permissionMode);
  if (rebuilt.droppedUnknown.length > 0) {
    deps.log(`${paneId}: not carrying over unknown flags ${rebuilt.droppedUnknown.join(" ")}`);
  }
  if (config.dryRun) return { kind: "dry-run", args: rebuilt.args };

  // R6: park the draft in Claude's input history before the process goes away.
  const draft = screen.prompt === "draft" ? screen.draft : undefined;
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
  await herdr.sendKeys(paneId, ["ctrl+c"]);
  await deps.sleep(400);
  await herdr.sendKeys(paneId, ["ctrl+c"]);
  const gone = async () => !claudeStillInForeground(await herdr.processInfo(paneId), session.pid);
  let exited = await waitFor(gone, EXIT_TIMEOUT_MS / 2, 250, deps);
  if (!exited) {
    await herdr.sendKeys(paneId, ["ctrl+c"]);
    exited = await waitFor(gone, EXIT_TIMEOUT_MS / 2, 250, deps);
  }
  // R16: never kill. A process that does not exit is left alone and reported.
  if (!exited) return { kind: "failed", reason: "claude did not exit after Ctrl+C" };

  await deps.sleep(500);
  const name = agent.name ?? agentNameFor(paneId);
  try {
    await herdr.agentStart(name, paneId, rebuilt.args, AGENT_START_TIMEOUT_MS);
  } catch (error) {
    // Blocked at startup (e.g. a trust dialog) still means Claude is running.
    if (!(error instanceof HerdrError && error.code === "agent_not_ready")) {
      return { kind: "failed", reason: `agent start failed: ${(error as Error).message}` };
    }
  }

  const verified = await waitFor(
    () =>
      deps
        .readSessions()
        .some((s) => s.sessionId === session.sessionId && s.pid !== session.pid && !isOlder(s.version, deps.installed)),
    VERIFY_TIMEOUT_MS,
    1000,
    deps,
  );
  if (!verified) return { kind: "failed", reason: "resumed session did not come up on the new version" };

  let draftRestored: boolean | undefined;
  if (draft !== undefined) {
    draftRestored = false;
    const ready = await waitFor(async () => (await screenOf(deps, paneId)).prompt === "empty", 15_000, 500, deps);
    if (ready) {
      await herdr.sendKeys(paneId, ["up"]);
      await deps.sleep(600);
      const restored = await screenOf(deps, paneId);
      draftRestored = restored.prompt === "draft" && sameDraft(restored.draft, draft);
      // Up recalled an older prompt instead: step back to the empty prompt.
      if (!draftRestored && restored.prompt === "draft") await herdr.sendKeys(paneId, ["down"]);
    }
    if (!draftRestored) {
      deps.log(`${paneId}: draft not restored automatically; it is in Claude's input history (press Up) and in this log`);
    }
  }
  return { kind: "restarted", draftRestored };
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
  return "unavailable";
}
