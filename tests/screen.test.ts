import assert from "node:assert/strict";
import { test } from "node:test";
import { cells, parseScreen, plain } from "../src/screen.ts";
import { DIM, NBSP, screen } from "./helpers.ts";

test("R5: an empty prompt box is recognised", () => {
  const info = parseScreen(screen({}));
  assert.equal(info.prompt, "empty");
  assert.equal(info.draft, "");
});

test("R5: the top rule may carry the session name", () => {
  assert.equal(parseScreen(screen({ topLabel: "my-session" })).prompt, "empty");
});

test("R6: typed text is a draft", () => {
  const info = parseScreen(screen({ promptLines: [`❯${NBSP}refactor the parser`] }));
  assert.equal(info.prompt, "draft");
  assert.equal(info.draft, "refactor the parser");
  assert.equal(info.hasAttachment, false);
});

test("R6: multi-line drafts keep their lines", () => {
  const info = parseScreen(screen({ promptLines: [`❯${NBSP}first line`, "  second line", "  third"] }));
  assert.equal(info.draft, "first line\nsecond line\nthird");
});

test("R6: dim or grey placeholder text is not a draft", () => {
  assert.equal(parseScreen(screen({ promptLines: [`❯${NBSP}${DIM('Try "write a test for parser.ts"')}`] })).prompt, "empty");
  const grey = `❯${NBSP}\u001b[38;2;153;153;153msuggested next step\u001b[0m`;
  assert.equal(parseScreen(screen({ promptLines: [grey] })).prompt, "empty");
});

test("R6: drafts with pasted content or images are flagged", () => {
  assert.equal(parseScreen(screen({ promptLines: [`❯${NBSP}look at [Image #1] please`] })).hasAttachment, true);
  assert.equal(parseScreen(screen({ promptLines: [`❯${NBSP}[Pasted text #2 +40 lines]`] })).hasAttachment, true);
});

test("R5: no prompt box (a dialog is open) is reported as absent", () => {
  const dialog = [
    "● Which database should I use?",
    "",
    "  ❯ 1. PostgreSQL",
    "    2. SQLite",
    "",
    "  Enter to select · Esc to cancel",
  ].join("\n");
  const info = parseScreen(dialog);
  assert.equal(info.prompt, "absent");
  assert.equal(info.permissionMode, undefined);
});

test("R5: a selection dialog drawn between rules is not a prompt box", () => {
  const boxed = screen({ promptLines: [`❯ 1. PostgreSQL`, "  2. SQLite"] });
  assert.equal(parseScreen(boxed).prompt, "absent");
  const withHint = screen({ promptLines: [`❯${NBSP}Yes`, "  No"], footer: "  Enter to select · Esc to cancel" });
  assert.equal(parseScreen(withHint).prompt, "absent");
});

test("R5: a quoted prompt in the transcript is not mistaken for the prompt box", () => {
  const info = parseScreen(screen({ above: ["❯ earlier user message", "● answer", ""] }));
  assert.equal(info.prompt, "empty");
});

test("R3: reads the live permission mode from the footer", () => {
  const footer = (text: string) => `  \u001b[38;2;255;193;7m${text}\u001b[0m (shift+tab to cycle)`;
  assert.equal(parseScreen(screen({})).permissionMode, "auto");
  assert.equal(parseScreen(screen({ footer: footer("⏵⏵ accept edits on") })).permissionMode, "acceptEdits");
  assert.equal(parseScreen(screen({ footer: footer("⏸ plan mode on") })).permissionMode, "plan");
  assert.equal(parseScreen(screen({ footer: footer("⏵⏵ bypass permissions on") })).permissionMode, "bypassPermissions");
  assert.equal(parseScreen(screen({ footer: "  ? for shortcuts" })).permissionMode, null);
});

test("strips SGR sequences and tracks faint text", () => {
  const line = "\u001b[2mdim\u001b[22m normal \u001b[38;5;244mgrey\u001b[39m";
  assert.equal(plain(line), "dim normal grey");
  const faint = cells(line)
    .filter((c) => c.faint)
    .map((c) => c.ch)
    .join("");
  assert.equal(faint, "dimgrey");
});
