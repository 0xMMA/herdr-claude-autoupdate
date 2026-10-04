import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { renderCountdown, runCountdown } from "../src/countdown.ts";
import { tempDir } from "./helpers.ts";

function streams() {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  (output as unknown as PassThrough).resume();
  return { input, output };
}

test("R7: any key cancels", async () => {
  const resultFile = join(tempDir(), "answer");
  const { input, output } = streams();
  const done = runCountdown({ seconds: 5, label: "w1:p2", resultFile, input, output });
  (input as unknown as PassThrough).write("x");
  assert.equal(await done, "cancel");
  assert.equal(readFileSync(resultFile, "utf8"), "cancel");
});

test("R7: no reaction means proceed", async () => {
  const resultFile = join(tempDir(), "answer");
  const { input, output } = streams();
  assert.equal(await runCountdown({ seconds: 1, label: "w1:p2", resultFile, input, output }), "proceed");
  assert.equal(readFileSync(resultFile, "utf8"), "proceed");
});

test("the popup names the pane and the remaining time", () => {
  const text = renderCountdown("w1:p2 · api", 3);
  assert.match(text, /w1:p2 · api in 3 s/);
  assert.match(text, /any key to cancel/);
});
