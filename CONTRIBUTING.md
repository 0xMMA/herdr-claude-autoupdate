# Contributing

Thanks for helping. Bug reports, fixes and improvements are welcome. For larger changes,
please open an issue first so we can agree on the approach.

The plugin types into other people's terminals, so changes are judged first by whether
they stay safe (see [docs/requirements.md](docs/requirements.md), especially R5 and R16).

## Development setup

You need Node.js 22.18 or newer and herdr 0.9.3 or newer.

```sh
git clone https://github.com/0xMMA/herdr-claude-autoupdate
cd herdr-claude-autoupdate
npm install          # dev tools only (TypeScript for type checking)
npm test
npm run typecheck
```

There is no build step: Node.js runs the `.ts` files directly. That only works for
TypeScript syntax that can be erased, so:

- no `enum`, `namespace` or constructor parameter properties;
- import local files with their `.ts` extension, and types with `import type`.

`npm run typecheck` enforces this (`erasableSyntaxOnly`).

To try your working copy in herdr, link it instead of installing it:

```sh
herdr plugin link "$(pwd)"
herdr plugin action invoke claude-autoupdate.ensure-clock
```

After changing code, run the `restart-clock` action so the background process picks it up.
Keep dry run on (`dry-run` action, the default) until you are sure. The log is `plugin.log` in
herdr's plugin state directory.

## Tests

- Tests live in `tests/*.test.ts` and use `node:test`. Test names start with the
  requirement they cover, e.g. `R6: …`.
- Logic that decides whether to act lives in pure functions (`src/gates.ts`,
  `src/args.ts`, `src/screen.ts`) and should be tested there.
- Anything that talks to herdr goes through the `Herdr` interface (`src/herdr.ts`), so
  tests can use `FakeHerdr` from `tests/helpers.ts`.
- Screen fixtures must be built from generic text. Never paste a real pane capture with
  paths, project names or prompts.

## Personal data

Every push to this public repository is visible immediately. Before pushing:

```sh
npm run check:private
```

It scans all tracked and untracked files and the commit metadata for home-directory
paths, e-mail addresses and session ids. Add your own patterns (user name, host names,
project names), one regular expression per line, to a local `.private-patterns` file;
it is git-ignored. CI runs the generic checks on every pull request.

Use your GitHub noreply address for commits in this repository:

```sh
git config user.email "<id>+<username>@users.noreply.github.com"
```

## Manual verification

Unit tests cannot cover herdr and Claude Code themselves. Before a release, check on Linux and Windows:

1. **Idle cost and dry run.** Link the plugin and run `ensure-clock`. After 10 minutes the
   clock's CPU time is practically zero and the log contains no herdr calls. With
   `"fake_installed_version": "9.9.9"` and `tick`, the status lists every Claude pane with a
   reason and no other panes; the log only says "dry run, would restart".
2. **Real restarts in a separate herdr session** (`herdr --session cau-test server` starts
   one headless), with `dry_run: false` and `fake_installed_version` set. The plugin config
   is per user, so stop the clock of your main herdr server first (`stop-clock`) and start
   it again afterwards. Run the test Claude sessions in a folder Claude trusts without
   asking (not your home directory, and not a git repository without its own trust entry),
   for example a new non-git folder below a trusted one:
   - an unfocused pane started with `--model sonnet --add-dir <dir>` restarts in place with
     the same session id and flags (compare `herdr pane process-info` before and after);
   - the focused pane shows the countdown; a key cancels, otherwise it restarts;
   - a one-line and a multi-line draft are back in the prompt afterwards;
   - an open question dialog, a running turn and a pane running `ping` are left alone;
   - with the fake version, each session is tried once and then marked `failed`
     (expected, the version cannot match), and the clock returns to idle.
3. **Remote machine.** With the plugin installed on a remote herdr server: the countdown
   appears when that machine is selected in the client; otherwise it runs out and the pane restarts.
4. **A real Claude Code update.** Keep herdr attached through an update: outdated panes move
   to the new version after the quiet period and the clock returns to idle.

## Pull requests

- Keep changes focused; one topic per pull request.
- Update `CHANGELOG.md` under "Unreleased" for user-visible changes.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages
  (`fix: …`, `feat: …`, `docs: …`).
- CI must pass on Linux, macOS and Windows.

## Node.js versions

The plugin supports the oldest Node.js LTS that can run TypeScript directly (22.18).
`@types/node` therefore stays on that major version, so the type check rejects APIs that
older supported versions lack. CI runs the tests on that minimum, the active LTS and the
current release, to catch upcoming breakage early.

## Releases

1. Update the version in `package.json` **and** `herdr-plugin.toml` (a test checks they match).
2. Move the "Unreleased" entries in `CHANGELOG.md` to the new version with today's date.
3. Tag `vX.Y.Z` on `main` and create a GitHub release with the changelog section.
