# herdr-claude-autoupdate

[![CI](https://github.com/0xMMA/herdr-claude-autoupdate/actions/workflows/ci.yml/badge.svg)](https://github.com/0xMMA/herdr-claude-autoupdate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [herdr](https://herdr.dev) plugin that moves idle Claude Code panes onto the newly
installed Claude Code version: **in place, same session, same flags, draft kept.**

Claude Code updates itself in the background, but every running session keeps the old
binary until it is restarted. With a dozen sessions in herdr, that means an "update
installed, restart to apply" notice at the worst moment and a manual restart round.
This plugin does the restart for you, one pane at a time, when the pane is really idle.

- **In place:** the pane, tab and workspace stay the same; no new terminals.
- **Same conversation and flags:** resumes the live session id with the original
  launch flags (`--model`, `--add-dir`, `--mcp-config`, ...) and the current permission mode.
- **Only when idle:** Claude and herdr must both report idle, the session must have been
  quiet for 2 minutes, and no dialog may be open.
- **Unsent drafts survive:** a half-typed prompt is moved through Claude's input history and put back.
- **Focused pane:** a 5-second countdown popup; any key cancels.
- **Other panes are never touched:** scripts, servers and shells keep running.
- **Costs nothing while idle:** one `stat()` per minute until an update arrives. The
  sleeping Node.js process uses practically no CPU and about 60–90 MB of memory.
- **Linux, macOS and Windows**, no runtime dependencies.

The full specification is in [docs/requirements.md](docs/requirements.md), the design in
[docs/design.md](docs/design.md).

## How it works

```
 every 60 s:  stat(claude launcher) ── unchanged ──▶ sleep
                      │ changed (Claude's auto-updater installed a new version)
                      ▼
 ~/.claude/sessions/*.json: which sessions run an older version?
                      ▼
 for each such pane, when idle:  Ctrl+C, Ctrl+C ─▶ herdr agent start --kind claude --
                                 <same flags> --resume <same session>
```

The plugin never installs updates itself; Claude Code's own updater keeps doing that.

## Requirements

- herdr 0.9.3 or newer, with herdr's Claude Code integration installed
  (`herdr integration install claude`; check with `herdr integration status`). It tells
  herdr which session runs in which pane; without it no pane can be matched.
- Node.js 22.18 or newer on the `PATH` of the herdr server (`node --version`)
- Claude Code installed with the native installer, npm, Homebrew or WinGet. The plugin
  looks for `claude` on the herdr server's `PATH` and in the standard install locations;
  see `claude_path` below if yours is elsewhere.

## Installation

Install it on **every machine that runs a herdr server** with Claude panes. Plugins run on
the server they are installed on, and each server only handles its own panes, also when
you attach to it as a remote machine.

Try it first in **dry-run mode**, where it only logs what it would do:

```sh
herdr plugin install 0xMMA/herdr-claude-autoupdate --yes
herdr plugin action invoke claude-autoupdate.ensure-clock
herdr plugin action invoke claude-autoupdate.status   # what it would restart, and why
```

Then go live:

```sh
herdr plugin action invoke claude-autoupdate.live
```

Or do both in one go:

```sh
herdr plugin install 0xMMA/herdr-claude-autoupdate --yes && herdr plugin action invoke claude-autoupdate.live
```

`ensure-clock`, `live` and `dry-run` start the background process right away if it is not
running; after that herdr starts it on every server start. `live` sets `"dry_run": false`
in `config.json` and keeps your other settings; `dry-run` switches back, and also stops a
restart that is just about to send its first key.

For remote machines you can run it from your workstation over SSH (use a login shell so
`herdr` is on the `PATH`):

```sh
ssh <host> 'bash -lc "herdr plugin install 0xMMA/herdr-claude-autoupdate --yes && herdr plugin action invoke claude-autoupdate.live"'
```

### Updating the plugin

```sh
herdr plugin install 0xMMA/herdr-claude-autoupdate --yes && herdr plugin action invoke claude-autoupdate.restart-clock
```

Your `config.json` lives outside the plugin's code and is kept. The restart makes the
running background process load the new code.

## Configuration

`config.json` in the plugin's config directory (`herdr plugin config-dir claude-autoupdate`).
All settings are optional.

| Setting | Default | Meaning |
|---|---|---|
| `dry_run` | `true` | Log what would happen without touching any pane. |
| `interval_seconds` | `60` | How often to check (minimum 10). |
| `quiet_seconds` | `120` | How long a session must have been idle before it is restarted. |
| `countdown_seconds` | `5` | Length of the countdown popup for the focused pane. |
| `focused_unattended_minutes` | `30` | If the popup cannot be shown, restart the focused pane only after this much idle time. |
| `rescue_drafts` | `true` | Keep unsent drafts across the restart. `false`: panes with a draft wait instead. |
| `toast` | `false` | Show a herdr notification after each restart or failure. |
| `claude_path` | – | Use this `claude` launcher instead of searching the herdr server's `PATH` and the standard locations (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`). It must be the same `claude` your panes start, and the launcher itself (e.g. `~/.local/bin/claude`), not a versioned binary under `~/.local/share/claude/versions/`, or updates are never noticed. |
| `fake_installed_version` | – | Testing only: pretend this Claude Code version is installed. |

## Actions

| Action | What it does |
|---|---|
| `claude-autoupdate.live` | Turn dry run off and make sure the background process runs. |
| `claude-autoupdate.dry-run` | Turn dry run back on: only log what would be restarted. |
| `claude-autoupdate.status` | Popup with the installed version, every outdated pane and why it is or is not restarted yet, and the recent log. |
| `claude-autoupdate.tick` | Run a full check now (also re-reads `config.json`). |
| `claude-autoupdate.ensure-clock` | Start the background process unless it is running. |
| `claude-autoupdate.restart-clock` | Restart it, e.g. after updating the plugin. |
| `claude-autoupdate.stop-clock` | Stop it until the next server start. |

Run them with `herdr plugin action invoke <action>` or bind them to keys in herdr's
`config.toml`. A plugin cannot declare key bindings itself.

## Safety

- Claude Code is only ever asked to exit with `Ctrl+C`. A process that does not exit is
  left running and reported; nothing is killed.
- Every check is repeated right before acting. A pane that starts working, gets focus,
  shows a dialog or gets typed into in the meantime is left alone.
- Each session gets one attempt per Claude Code version. A failure or a cancelled
  countdown is remembered until the next version.
- The session is never resumed with more permissions than it had: the live permission
  mode is passed explicitly, also when it is the default mode.
- A pane without a herdr agent name gets one (`cau-<pane>`), because `herdr agent start`
  needs a name.
- The plugin makes no network connections. Its log (`plugin.log` in herdr's plugin state
  directory, readable only by you on Linux and macOS) stays on your machine. It may contain
  the text of a rescued draft; values of `--mcp-config`, `--settings`, `--agents` and the
  system-prompt flags are masked.

See [SECURITY.md](SECURITY.md) for what the plugin is allowed to do.

## Troubleshooting

Start with the status action; it shows each outdated pane with the reason it is waiting.

| Status says | Meaning |
|---|---|
| `claude is busy` / `claude is shell` | Claude is working or running a shell command. It waits. |
| `quiet period` | The session became idle less than `quiet_seconds` ago. |
| `prompt box not visible (dialog open?)` | A question, permission prompt or menu is open. Answer it. |
| `unsent draft contains attachments` | Drafts with pasted text blocks or images are not moved. Send or clear it. |
| `focused and the countdown could not be shown` | Another herdr popup or modal was open. It retries. |
| `waiting: …` | The pane was skipped right before acting (reason shown); it is retried after 3 minutes, other panes go first. |
| `session directory differs from the pane's shell directory` | The session lives in another directory (e.g. started with `--worktree`) and cannot be resumed in place. Restart it yourself. |
| `folder not trusted permanently` | Claude would ask "Do you trust this folder?" on start (always in your home directory, and in git repositories without their own trust entry). Restart it yourself, or start Claude there once and answer the trust question. |
| `not in a herdr pane on this server` | The session runs outside herdr, on another machine, or herdr's Claude integration is missing. It is never touched. |
| `failed: …` | See the log. The pane is not retried until the next Claude Code version. |
| `clock: NOT running` | Run the `ensure-clock` action. |
| `claude: not found`, or a different `claude` than your shell uses | herdr's server has its own `PATH`. Set `claude_path` in `config.json` to the launcher your panes run (`which claude` / `where claude`). |

## FAQ

**Why not just restart the herdr server?** That restarts every pane, including scripts
and servers, and resumes Claude sessions without their launch flags.

**Why not a Claude Code hook inside each session?** A process cannot replace itself in its
own terminal, so such hooks open new windows or tmux panes, outside herdr. They also only
run when a turn ends, so an update that lands overnight is never applied.

**Does it work with the stable and latest release channels?** Yes. It only compares the
version of the running session with the installed one.

**What about the pane I am typing in?** Before the focused pane is restarted, a 5-second
countdown popup appears. Any key cancels it (that key press goes to the popup, not to
Claude), and the pane then keeps its version until the next update. If you are not
looking, the restart happens and your unsent draft is put back into the prompt.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please read the [code of conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)
