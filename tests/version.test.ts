import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions, isOlder, parseVersion } from "../src/version.ts";

test("parses the version printed by claude --version", () => {
  assert.deepEqual(parseVersion("2.1.289 (Claude Code)"), [2, 1, 289]);
  assert.equal(parseVersion("no version here"), undefined);
});

test("compares numerically, not lexically", () => {
  assert.ok(compareVersions([2, 1, 99], [2, 1, 100]) < 0);
  assert.ok(compareVersions([2, 10, 0], [2, 9, 9]) > 0);
  assert.equal(compareVersions([1, 2, 3], [1, 2, 3]), 0);
});

test("R1: isOlder is true only for a strictly older running version", () => {
  assert.equal(isOlder("2.1.288", "2.1.289"), true);
  assert.equal(isOlder("2.1.289", "2.1.289"), false);
  assert.equal(isOlder("2.1.290", "2.1.289"), false, "never move a session to an older build");
  assert.equal(isOlder("garbage", "2.1.289"), false, "unparsable versions are left alone");
});
