# Requirements

This is the specification the plugin is built and tested against. Each requirement has an
ID that tests and pull requests refer to (test names start with the ID, e.g. `R3: …`).

**Source** says where a requirement comes from:

- **Stated**: asked for or decided by the maintainer while the plugin was designed.
- **Derived**: follows from the stated requirements or from what can go wrong.

**Verified by** names the automated tests (`tests/*.test.ts`) or the manual check in
[CONTRIBUTING.md](../CONTRIBUTING.md#manual-verification) that covers it.

## Background

Claude Code's native installer updates itself in the background, but every running
session keeps using the binary it was started with until it is restarted. With many
long-lived sessions in herdr panes, the update notice tends to show up right when work
starts, and applying it meant waiting until all agents were idle, stopping the herdr
server (which also kills panes running scripts or servers) and starting everything again.

## R1 Restart outdated sessions automatically

**Requirement:** A Claude Code session that runs an older version than the installed one
is restarted onto the installed version without manual steps once it is idle.
**Rationale:** The whole point: no more `herdr server stop` and manual `claude update` cycles.
**Acceptance:** After Claude Code's auto-updater installs a new version, every idle,
outdated Claude pane runs the new version within a few minutes; no user action is needed.
**Source:** Stated. **Verified by:** `version.test.ts`, `gates.test.ts`, `clock.test.ts`, manual check 4.

## R2 Restart in place

**Requirement:** The new process runs in the same herdr pane. No new windows, tabs or terminals.
**Rationale:** herdr is the place where sessions live; a session that moves elsewhere is lost from view.
**Acceptance:** Pane id, tab and workspace are unchanged after the restart.
**Source:** Stated. **Verified by:** `restart.test.ts`, manual check 2.

## R3 Same conversation, same launch flags

**Requirement:** The restarted process resumes the same conversation with the same launch flags.
**Rationale:** A restart must be invisible apart from the version number.
**Acceptance:**
- The session id is the live one reported by herdr, not the `--resume` id in the original
  command line (it changes after `/clear`).
- Flags that describe how the session runs (`--model`, `--add-dir`, `--mcp-config`, ...)
  are carried over with their values; flags that select or create a session, one-shot
  inputs and unknown flags are dropped and reported.
- The live permission mode is kept and passed explicitly, also when it is the default
  mode. The session is never resumed with more permissions than it had
  (`--dangerously-skip-permissions` is downgraded when bypass mode is off).
- A session that cannot be resumed in the pane's directory (e.g. started with
  `--worktree`) is not stopped at all.
**Source:** Stated. **Verified by:** `args.test.ts`, `screen.test.ts`, `restart.test.ts`, manual check 2.

## R4 Leave non-Claude panes alone

**Requirement:** Panes that do not run Claude Code (scripts, servers, shells) are never
touched, and the plugin does not wait for them.
**Rationale:** Restarting the herdr server killed these; the plugin must not.
**Acceptance:** Only panes whose herdr agent session matches a Claude session file are
candidates; every Claude pane is handled on its own.
**Source:** Stated. **Verified by:** `gates.test.ts`, `clock.test.ts`, manual check 2.

## R5 Only restart when the session is really idle

**Requirement:** A session is restarted only when no turn is running, no background work
is running, no dialog is open, and it has been idle for a minimum time.
**Rationale:** Interrupting work or answering a dialog by accident is worse than an old version.
**Acceptance:**
- Claude's own session file reports `idle` (not `busy` or `shell`) **and** herdr reports
  `idle` or `done`.
- The session has been idle for at least `quiet_seconds` (default 120).
- The prompt box is visible; when a dialog or selection list is shown instead, the pane waits.
- All checks are repeated right before acting, and again after the countdown.
- A pane that has to wait does not hold up other outdated panes.
**Source:** Stated (idle), derived (details). **Verified by:** `gates.test.ts`, `screen.test.ts`, `restart.test.ts`, manual check 2.

## R6 Keep an unsent draft

**Requirement:** Text typed into the prompt but not sent survives the restart. If that
cannot be done safely, the pane is not restarted.
**Rationale:** Losing half-written prompts is exactly the kind of interruption the plugin should avoid.
**Acceptance:**
- A draft is moved into Claude's input history (`Esc Esc`) before the restart and recalled
  (`Up`) afterwards; the restored text is compared with the original.
- The draft text is also written to the local plugin log.
- Drafts with pasted content or images are not restarted.
- Grey placeholder or suggestion text is not treated as a draft.
**Source:** Stated. **Verified by:** `screen.test.ts`, `restart.test.ts`, manual check 2.

## R7 Countdown for the focused pane

**Requirement:** Before the pane that has focus is restarted, a popup counts down 5
seconds. Any key cancels; without a reaction the restart happens.
**Rationale:** "Either I see it and cancel, or I am not looking and do not care."
**Acceptance:**
- Cancelling leaves the pane on its version until the next Claude Code update.
- When the popup cannot be shown, the focused pane is only restarted after
  `focused_unattended_minutes` (default 30) of idle time.
- When the popup was shown but did not answer, the pane is not restarted.
**Source:** Stated. **Verified by:** `countdown.test.ts`, `restart.test.ts`, `manifest.test.ts`, manual check 2.

## R8 Do not replace Claude Code's updater

**Requirement:** Claude Code's own auto-updater stays enabled. The plugin never installs
updates and works with any release channel.
**Rationale:** Disabling a core feature to work around a notice is the wrong trade.
**Acceptance:** The plugin only reads the installed version; it never runs `claude update` or changes Claude settings.
**Source:** Stated. **Verified by:** code review (no update calls), manual check 4.

## R9 Linux, Windows and macOS

**Requirement:** Works on Linux and native Windows (not only WSL), and on macOS.
**Rationale:** The maintainer runs Claude Code on Linux and Windows machines.
**Acceptance:** CI runs the test suite on all three; the manifest declares all three; manual checks pass on Linux and Windows.
**Source:** Stated. **Verified by:** CI matrix, `manifest.test.ts`, manual checks 1–3.

## R10 One installation per herdr server

**Requirement:** Each herdr server runs its own copy and only handles its own panes,
including servers that are attached as remote machines.
**Rationale:** Claude binaries and session files live on the machine that runs them; a
server keeps working when the client machine is off.
**Acceptance:** Sessions without a pane on the local server are reported, never acted on.
**Source:** Stated (multi-machine setup), derived (consequence). **Verified by:** `gates.test.ts`, `clock.test.ts`, manual check 3.

## R11 Effort proportional to the task

**Requirement:** While nothing is outdated, the plugin does no work: no process starts and no herdr calls.
**Rationale:** Updates arrive at most a few times a day; the plugin must not cost anything in between.
**Acceptance:**
- One long-lived process; no herdr event hooks.
- In idle mode a check is a `stat()` of the `claude` launcher and of `config.json`.
- herdr is only called while outdated sessions exist.
- The idle process uses practically no CPU time.
**Source:** Stated. **Verified by:** `clock.test.ts`, `manifest.test.ts`, manual check 1.

## R12 As stateless as possible

**Requirement:** Decisions are made from live sources each time. Only what is needed to
avoid loops and to remember a cancellation is stored.
**Rationale:** Less state, fewer ways to get out of sync.
**Acceptance:** The only persisted state is `marks.json` (session id → target version and
result). Losing it at worst causes one extra attempt.
**Source:** Stated. **Verified by:** `gates.test.ts`, `clock.test.ts`.

## R13 Lightweight runtime

**Requirement:** TypeScript on Node.js ≥ 22.18 without runtime dependencies and without a build step.
**Rationale:** Node.js is commonly present where Claude Code is used; requiring another
runtime for a small job is too much.
**Acceptance:** `package.json` has no `dependencies`; Node runs the `.ts` sources directly;
an older Node prints a clear message.
**Source:** Stated. **Verified by:** `manifest.test.ts`, CI (Node 22.18 and 24).

## R14 Standalone and portable

**Requirement:** A repository of its own, not tied to any personal setup, installable with
`herdr plugin install <owner>/<repo>`, with no hard-coded paths.
**Rationale:** It has to work on other machines (e.g. a work laptop) without copying files around.
**Acceptance:** Paths come from herdr's plugin environment, `PATH` and `CLAUDE_CONFIG_DIR`; `herdr plugin install` works on a clean machine.
**Source:** Stated. **Verified by:** `claude.test.ts`, manual check 3.

## R15 Open-source quality

**Requirement:** A public repository that follows common open-source practice, with these
requirements documented in it.
**Acceptance:** License, README, contributing guide, code of conduct, security policy,
changelog, issue and PR templates, CI, and this document.
**Source:** Stated. **Verified by:** repository contents.

## R16 Safety

**Requirement:** Processes are never killed; each session gets one attempt per version;
there is a dry-run mode and a readable log.
**Rationale:** An automation that types into terminals must fail safe.
**Acceptance:**
- The plugin only sends `Ctrl+C`; a Claude that does not exit is left running and reported.
- After `done`, `failed` or `declined` for a version, a session is not tried again until a newer version is installed.
- Dry run is the default after installation.
- Every decision that changes something is logged.
**Source:** Derived. **Verified by:** `restart.test.ts`, `gates.test.ts`, `config.test.ts`.

## R17 Privacy

**Requirement:** The repository, its history and its test fixtures contain no personal
data. The log stays on the machine and the plugin makes no network connections.
**Acceptance:** `npm run check:private` passes locally (with personal patterns) and in CI;
the code makes no network calls; the plugin's state directory and files are private to the
user on Linux and macOS; values of flags that can hold credentials are masked in the log.
**Source:** Derived. **Verified by:** `scripts/check-private.mjs`, CI.
