# Design

How the plugin meets the [requirements](requirements.md), and which alternatives were rejected.

## Overview

```
 herdr server (one per machine; each runs its own copy of the plugin)
 ┌────────────────────────────────────────────────────────────────────────┐
 │ [[startup]] ─▶ starts the "clock" (once, detached)                     │
 │                                                                        │
 │  clock ─ sleeps 60 s ─▶ stat(claude launcher) ─ unchanged ─┐           │
 │    ▲                         │ changed                     │           │
 │    └─────────────────────────┼─────────────────────────────┘           │
 │                              ▼                                         │
 │           installed version ◀─ symlink target (Linux/macOS)            │
 │                              │  or `claude --version` (Windows)        │
 │                              ▼                                         │
 │           ~/.claude/sessions/*.json: anything older? ── no ──▶ idle    │
 │                              ▼ yes                                     │
 │           herdr CLI, only for those: agent list · process-info ·       │
 │           pane read · send-keys · agent start                          │
 │                                                                        │
 │  Pane w1:p2:  shell ─▶ claude 2.1.289  ══ restart ══▶ claude 2.1.290   │
 │  Pane w1:p3:  shell ─▶ npm run dev     (not Claude → never touched)    │
 └────────────────────────────────────────────────────────────────────────┘
        ▲ Claude Code's own auto-updater installs the new version
```

## The clock

The plugin has exactly one long-running process per herdr server (R11). It is started by
the `[[startup]]` hook (or the `ensure-clock` action), detaches itself, and changes its
working directory away from the plugin directory so it does not lock it on Windows.

It has two modes:

| | idle mode | update mode |
|---|---|---|
| when | almost always | after the launcher changed, on start, after `config.json` changed, on `tick` |
| each interval | `stat()` of the launcher and of `config.json` | read session files; herdr calls for outdated sessions only |
| ends | when the launcher changes | when no outdated session in a herdr pane can still be restarted |

**Single instance and control.** The clock listens on a local socket (a named pipe on
Windows), keyed by the herdr server's socket path. The operating system releases it when
the process dies, so it works as a lock without heartbeats, and the `tick`, `status` and
`stop` actions talk to the clock through it instead of through polled files.

**State.** Everything is read live (R12): herdr's agent list, Claude's session files
(`version`, `status`, `statusUpdatedAt`), the process list of a pane and its screen. The
only stored state is `marks.json`, which records per session the version a restart was
attempted for and its result (`done`, `failed`, `declined`, `dry-run`).

## Deciding and restarting

```
 cheap (files only):
 marks.json already says done/failed/declined for this version? ── yes ──▶ skip
        │ no
 session file: status "idle" AND idle for ≥ quiet_seconds? ── no ──▶ next check
        │ yes
 herdr:
 pane found for this session AND herdr says idle/done? ── no ──▶ next check
        │ yes
 prompt box visible (no dialog)? ── no ──▶ next check
        │ yes
 pane focused? ── yes ──▶ popup: "Restarting in 5 s · any key cancels"
        │ no              │ cancelled ─▶ declined (until the next version)
        │◀────────────────┘ ran out
        ▼
 check everything again
        ─▶ draft? ── yes ──▶ Esc Esc (draft → input history), confirm the box is empty
        ─▶ Ctrl+C, Ctrl+C ─▶ wait until only the shell is left (≤ 10 s)
        ─▶ herdr agent start <name> --kind claude --pane <id> --
               <carried-over flags> [--permission-mode <live>] --resume <session id>
        ─▶ confirm: same session id, new version ─▶ done
        ─▶ had a draft? ── yes ──▶ Up (recall it), compare with the original
        (any step fails ─▶ stop, never kill, record failed)
```

Details:

- **Pairing panes and sessions.** herdr reports the Claude session id of each pane
  (`agent_session`). Session files are matched by that id, and `pane process-info` must
  show the same PID in the foreground before anything is sent.
- **Flags.** `src/args.ts` keeps an allow-list of flags that describe how a session runs
  and a list of flags that select or create sessions. Unknown flags are dropped, because a
  misread value could become a prompt.
- **Prompt box.** `src/screen.ts` reads an ANSI capture of the pane. The prompt box is the
  bottom-most block between two horizontal rules that starts with `❯`. Dim or grey text in
  it is a placeholder, not a draft. Option lists and dialog hints mean "not the prompt box".
- **Stopping.** Two `Ctrl+C` on an empty prompt exit Claude Code cleanly. A third is sent
  if needed. Nothing is ever killed (R16).
- **Starting.** `herdr agent start --kind claude` runs `claude` from `PATH`, which is the
  new version, quotes the arguments for the pane's shell, and waits until herdr detects
  the agent.

## Rejected alternatives

| Alternative | Why not |
|---|---|
| A Claude Code hook in each session that restarts itself (the approach of `restart_on_update` in the techne plugin) | A process cannot replace itself in its terminal; that approach opens a new tmux window or Windows Terminal tab, which takes the session out of herdr (R2). It also only runs when a turn ends, so an update that lands while everything is idle overnight is never applied. |
| Stopping the herdr server so its session restore resumes everything | Kills panes that run scripts and servers (R4), and drops launch flags. |
| herdr event hooks (`pane.agent_status_changed`, …) | Each event starts a new process; during active work that is dozens per minute for nothing (R11). Events also cannot measure "idle for two minutes" or notice an update that lands while nothing happens. |
| Disabling Claude Code's auto-updater and running `claude update` from the plugin | Turns off a core feature to hide a notice (R8). |
| Python | Not installed by default on Windows; requires per-platform launchers (`python3`, `py`, `python`). Node.js is present where Claude Code is commonly used and runs TypeScript directly (R13). |
| A heartbeat file for single-instance | Needs periodic writes and a staleness timeout; a local socket gives the same guarantee for free and doubles as a control channel. |

## Known limitations

- **Draft recall** relies on Claude Code's input history (`Esc Esc`, then `Up`). If `Up`
  recalls a different entry, the plugin steps back to an empty prompt and the draft stays
  in the history and in the plugin log.
- **Effort set with `/effort` inside a session** is not visible from outside; the resumed
  session uses the effort from settings or from the original `--effort` flag.
- **Permission mode** is read from the footer text (`auto mode on`, `accept edits on`,
  `plan mode on`, `bypass permissions on`). Without a mode indicator, the session resumes in
  the default mode from settings.
- **Screen heuristics** depend on Claude Code's UI. If a future version changes the prompt
  box, the plugin sees "prompt box not visible" and waits instead of acting.
