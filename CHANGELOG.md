# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - unreleased

### Added

- Background clock with an idle mode (one `stat()` per interval) and an update mode that
  only runs while outdated Claude Code sessions exist.
- In-place restart of idle, outdated Claude Code panes with the live session id, the
  original launch flags and the live permission mode.
- Unsent prompt drafts are moved through Claude Code's input history and restored.
- Countdown popup before restarting the focused pane; any key cancels.
- `claude_path` setting, and a search of the standard install locations when herdr's
  server `PATH` lacks `claude`.
- Dry-run mode (default), status popup, `tick`, `ensure-clock`, `restart-clock` and `stop-clock` actions.
- Safety checks: sessions in folders Claude does not trust permanently (e.g. the home
  directory), sessions started in another directory (`--worktree`) and panes showing a
  dialog are never restarted; a pane that has to wait does not hold up the others.
- Requirements specification (`docs/requirements.md`) and design notes (`docs/design.md`).

[Unreleased]: https://github.com/0xMMA/herdr-claude-autoupdate/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/0xMMA/herdr-claude-autoupdate/releases/tag/v0.1.0
