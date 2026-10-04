import assert from "node:assert/strict";
import { test } from "node:test";
import { rebuildArgs, redactArgs } from "../src/args.ts";

const SID = "00000000-0000-4000-8000-0000000000aa";

test("R3: carries over launch flags with their values and resumes the live session", () => {
  const { args } = rebuildArgs(
    ["--model", "sonnet", "--add-dir", "/a", "/b", "--effort", "high", "--strict-mcp-config", "--mcp-config", "x.json"],
    SID,
  );
  assert.deepEqual(args, [
    "--model", "sonnet",
    "--add-dir", "/a", "/b",
    "--effort", "high",
    "--strict-mcp-config",
    "--mcp-config", "x.json",
    "--resume", SID,
  ]);
});

test("R3: replaces a stale --resume id (after /clear the session id changes)", () => {
  const { args } = rebuildArgs(["--resume", "11111111-old", "--model", "opus"], SID);
  assert.deepEqual(args, ["--model", "opus", "--resume", SID]);
  assert.deepEqual(rebuildArgs(["-r", "old"], SID).args, ["--resume", SID]);
  assert.deepEqual(rebuildArgs(["--continue", "--fork-session"], SID).args, ["--resume", SID]);
});

test("R3: keeps the --flag=value form", () => {
  assert.deepEqual(rebuildArgs(["--model=sonnet", "--resume=old"], SID).args, ["--model=sonnet", "--resume", SID]);
});

test("R3: drops an initial prompt and session-selecting flags", () => {
  const result = rebuildArgs(["--name", "my session", "--worktree", "feature", "fix the bug", "--", "more"], SID);
  assert.deepEqual(result.args, ["--resume", SID]);
  assert.equal(result.droppedPositionals, 2);
});

test("R3: drops unknown flags and reports them", () => {
  const result = rebuildArgs(["--shiny-new-flag", "value", "--verbose"], SID);
  assert.deepEqual(result.args, ["--verbose", "--resume", SID]);
  assert.deepEqual(result.droppedUnknown, ["--shiny-new-flag"]);
});

test("R3: the live permission mode from the footer wins over argv", () => {
  assert.deepEqual(rebuildArgs(["--permission-mode", "plan"], SID, "auto").args, ["--permission-mode", "auto", "--resume", SID]);
  assert.deepEqual(rebuildArgs(["--permission-mode", "plan"], SID, null).args, ["--resume", SID], "default mode: flag removed");
  assert.deepEqual(rebuildArgs(["--permission-mode", "plan"], SID, undefined).args, ["--permission-mode", "plan", "--resume", SID]);
});

test("R3/R16: never resumes more permissive than the live session", () => {
  assert.deepEqual(rebuildArgs(["--dangerously-skip-permissions"], SID, null).args, [
    "--allow-dangerously-skip-permissions",
    "--resume",
    SID,
  ]);
  assert.deepEqual(rebuildArgs(["--dangerously-skip-permissions"], SID, "bypassPermissions").args, [
    "--dangerously-skip-permissions",
    "--permission-mode",
    "bypassPermissions",
    "--resume",
    SID,
  ]);
});

test("optional-value flags only take a following non-flag token", () => {
  assert.deepEqual(rebuildArgs(["--debug", "--model", "x"], SID).args, ["--debug", "--model", "x", "--resume", SID]);
  assert.deepEqual(rebuildArgs(["--debug", "api,hooks"], SID).args, ["--debug", "api,hooks", "--resume", SID]);
});

test("R3/R16: without a mode indicator the default mode is passed explicitly", () => {
  // A defaultMode from settings must not make the resumed session more permissive.
  assert.deepEqual(rebuildArgs([], SID, null, "manual").args, ["--permission-mode", "manual", "--resume", SID]);
  assert.deepEqual(rebuildArgs([], SID, null, undefined).args, ["--resume", SID], "unknown name: nothing passed");
  assert.deepEqual(rebuildArgs([], SID, undefined, "manual").args, ["--resume", SID], "unknown live mode: argv kept as is");
});

test("R17: sensitive flag values are masked for the log", () => {
  assert.deepEqual(
    redactArgs(["--model", "sonnet", "--mcp-config", "a.json", "{\"token\":1}", "--settings={\"k\":2}", "--resume", SID]),
    ["--model", "sonnet", "--mcp-config", "<redacted>", "<redacted>", "--settings=<redacted>", "--resume", SID],
  );
});
