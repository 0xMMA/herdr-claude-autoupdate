import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { tempDir } from "./helpers.ts";

test("marks round-trip and old marks of gone sessions are pruned", () => {
  const store = new Store(join(tempDir(), "state"));
  store.setMark("live", { version: "2.1.290", result: "done", at: 0 });
  store.setMark("gone", { version: "2.1.290", result: "failed", at: 0 });
  store.setMark("gone-recent", { version: "2.1.290", result: "failed", at: Date.now() });
  store.pruneMarks(new Set(["live"]), Date.now());
  assert.deepEqual(Object.keys(store.readMarks()).sort(), ["gone-recent", "live"]);
});

test("R17: state is private to the user", { skip: process.platform === "win32" && "POSIX permissions only" }, () => {
  const dir = join(tempDir(), "state");
  const store = new Store(dir);
  store.log("a draft could be in here");
  store.setMark("s", { version: "1.0.0", result: "done", at: 0 });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(store.logPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "marks.json")).mode & 0o777, 0o600);
});
