/**
 * Rebuilds the Claude Code launch arguments for a resume (requirement R3).
 *
 * Only flags known to describe *how* a session runs are carried over. Flags that pick
 * or create a session, one-shot inputs, and anything unknown are dropped, because a
 * misread value could turn into a prompt or a different session.
 */

type Arity = "none" | "one" | "optional" | "variadic";

interface FlagSpec {
  arity: Arity;
  keep: boolean;
}

const KEEP: Record<string, Arity> = {
  "--model": "one",
  "--effort": "one",
  "--permission-mode": "one",
  "--agent": "one",
  "--agents": "one",
  "--settings": "one",
  "--setting-sources": "one",
  "--fallback-model": "one",
  "--system-prompt": "one",
  "--system-prompt-file": "one",
  "--append-system-prompt": "one",
  "--append-system-prompt-file": "one",
  "--system-prompt-snapshot": "one",
  "--autocompact": "one",
  "--debug-file": "one",
  "--plugin-dir": "one",
  "--plugin-url": "one",
  "--remote-control-session-name-prefix": "one",
  "--add-dir": "variadic",
  "--mcp-config": "variadic",
  "--allowedTools": "variadic",
  "--allowed-tools": "variadic",
  "--disallowedTools": "variadic",
  "--disallowed-tools": "variadic",
  "--tools": "variadic",
  "--betas": "variadic",
  "--debug": "optional",
  "-d": "optional",
  "--remote-control": "optional",
  "--prompt-suggestions": "optional",
  "--strict-mcp-config": "none",
  "--dangerously-skip-permissions": "none",
  "--allow-dangerously-skip-permissions": "none",
  "--chrome": "none",
  "--no-chrome": "none",
  "--ide": "none",
  "--verbose": "none",
  "--brief": "none",
  "--bare": "none",
  "--disable-slash-commands": "none",
  "--ax-screen-reader": "none",
  "--exclude-dynamic-system-prompt-sections": "none",
  "--restricted": "none",
  "--safe-mode": "none",
};

const DROP: Record<string, Arity> = {
  "--resume": "optional",
  "-r": "optional",
  "--continue": "none",
  "-c": "none",
  "--session-id": "one",
  "--fork-session": "none",
  "--name": "one",
  "-n": "one",
  "--worktree": "optional",
  "-w": "optional",
  "--tmux": "optional",
  "--from-pr": "optional",
  "--teleport": "optional",
  "--cloud": "optional",
  "--environment": "one",
  "--file": "variadic",
  "--print": "none",
  "-p": "none",
  "--bg": "none",
  "--background": "none",
  "--desktop": "none",
  "--output-format": "one",
  "--input-format": "one",
  "--json-schema": "one",
  "--max-budget-usd": "one",
  "--permission-prompts": "one",
  "--no-session-persistence": "none",
  "--include-hook-events": "none",
  "--include-partial-messages": "none",
  "--replay-user-messages": "none",
  "--forward-subagent-text": "none",
};

function lookup(flag: string): FlagSpec | undefined {
  if (flag in KEEP) return { arity: KEEP[flag]!, keep: true };
  if (flag in DROP) return { arity: DROP[flag]!, keep: false };
  return undefined;
}

const isFlag = (token: string): boolean => token.startsWith("-") && token !== "-";

export type PermissionMode = "acceptEdits" | "auto" | "bypassPermissions" | "dontAsk" | "plan";

export interface RebuiltArgs {
  args: string[];
  /** Unknown flags that were not carried over. Shown in the status output. */
  droppedUnknown: string[];
  /** Number of positional arguments (an initial prompt) that were dropped. */
  droppedPositionals: number;
}

/**
 * @param argv          the running process' argv *without* the executable
 * @param sessionId     the live session id (from herdr, not from argv: `/clear` changes it)
 * @param permissionMode the live permission mode read from Claude's footer; `null` means
 *                       "default mode is active", `undefined` means "unknown, keep argv"
 */
export function rebuildArgs(
  argv: readonly string[],
  sessionId: string,
  permissionMode?: PermissionMode | null,
): RebuiltArgs {
  const kept: string[][] = [];
  const droppedUnknown: string[] = [];
  let droppedPositionals = 0;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") {
      droppedPositionals += argv.length - i - 1;
      break;
    }
    if (!isFlag(token)) {
      droppedPositionals++;
      continue;
    }

    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const name = eq > 0 ? token.slice(0, eq) : token;
    const spec = lookup(name);
    if (!spec) {
      // An unknown flag's value (if any) is a following non-flag token; that one is
      // counted as a positional and dropped as well.
      droppedUnknown.push(name);
      continue;
    }

    const group = [token];
    if (eq < 0) {
      if (spec.arity === "one") {
        if (i + 1 < argv.length) group.push(argv[++i]!);
      } else if (spec.arity === "optional") {
        if (i + 1 < argv.length && !isFlag(argv[i + 1]!)) group.push(argv[++i]!);
      } else if (spec.arity === "variadic") {
        while (i + 1 < argv.length && !isFlag(argv[i + 1]!)) group.push(argv[++i]!);
      }
    }
    if (spec.keep) kept.push(group);
  }

  let groups = kept;
  if (permissionMode !== undefined) {
    groups = groups.filter((g) => {
      const name = g[0]!.split("=")[0];
      return name !== "--permission-mode";
    });
    // Never resume more permissive than the live session: if the user cycled away from
    // bypass mode, `--dangerously-skip-permissions` would switch it back on at start.
    if (permissionMode !== "bypassPermissions") {
      groups = groups.map((g) =>
        g[0] === "--dangerously-skip-permissions" ? ["--allow-dangerously-skip-permissions"] : g,
      );
    }
    if (permissionMode !== null) groups.push(["--permission-mode", permissionMode]);
  }

  return {
    args: [...groups.flat(), "--resume", sessionId],
    droppedUnknown,
    droppedPositionals,
  };
}
