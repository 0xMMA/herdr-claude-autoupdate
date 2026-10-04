# Security policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please do **not** open a public issue. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/0xMMA/herdr-claude-autoupdate/security/advisories/new).
You should get an answer within a week.

## What the plugin does on your machine

Knowing this helps to judge whether something is a vulnerability:

- It runs as your user, inside herdr's plugin environment, like any herdr plugin. herdr
  does not sandbox plugins.
- It starts one background Node.js process per herdr server. That process listens on a
  local socket (a named pipe on Windows) that accepts four commands: `ping`, `tick`,
  `status` and `stop`. None of them can run commands or send input to panes.
- It calls the herdr CLI to list agents, read pane screens and process lists, send the keys
  `Esc`, `Ctrl+C`, `Up` and `Down` to Claude Code panes, and start Claude Code with
  `herdr agent start --kind claude`.
- The arguments for the restarted Claude Code are taken from the running process and
  filtered through an allow-list. The session is never resumed with more permissions
  than it had.
- It reads Claude Code's session files (`~/.claude/sessions/*.json`) and runs
  `claude --version`. It does not read transcripts, credentials or settings.
- It makes no network connections.
- Its log (`plugin.log` in herdr's plugin state directory) can contain the text of an
  unsent prompt draft that was moved during a restart.
