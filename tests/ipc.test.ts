import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { isRunning, request, serveExclusive } from "../src/ipc.ts";
import { clockEndpoint } from "../src/paths.ts";
import { tempDir } from "./helpers.ts";

function endpoint(): string {
  return clockEndpoint(`test-${randomUUID()}`, tempDir(), process.platform);
}

test("the clock endpoint is a single-instance lock and a command channel", async () => {
  const at = endpoint();
  const seen: string[] = [];
  const server = await serveExclusive(at, (command) => {
    seen.push(command);
    return command === "status" ? { mode: "idle" } : "ok";
  });
  assert.ok(server);
  try {
    assert.equal(await isRunning(at), true);
    assert.deepEqual(await request(at, "status"), { mode: "idle" });
    assert.equal(await serveExclusive(at, () => "second"), undefined, "a second clock does not start");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal(await isRunning(at), false);
  assert.ok(seen.includes("status"));
});

test("one endpoint per herdr server", () => {
  const dir = tempDir();
  assert.notEqual(clockEndpoint("/run/a.sock", dir, "linux"), clockEndpoint("/run/b.sock", dir, "linux"));
  assert.match(clockEndpoint("x", dir, "win32"), /^\\\\\.\\pipe\\herdr-claude-autoupdate-[0-9a-f]{16}$/);
  assert.ok(clockEndpoint("x", join(dir, "a".repeat(120)), "linux").length < 110, "long state dirs fall back to tmp");
});
