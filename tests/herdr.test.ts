import assert from "node:assert/strict";
import { test } from "node:test";
import { HerdrCli, HerdrError, toHerdrError, type Runner } from "../src/herdr.ts";

/** Output shapes copied from herdr 0.9.3 (ids shortened, values made generic). */
const PLUGIN_LIST = JSON.stringify({
  id: "cli:plugin",
  result: {
    plugins: [{ plugin_id: "claude-autoupdate", enabled: false, version: "0.1.0" }],
    type: "plugin_list",
  },
});
const AGENT_LIST = JSON.stringify({
  id: "cli:agent:list",
  result: {
    agents: [
      {
        agent: "claude",
        agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "00000000-0000-4000-8000-000000000001" },
        agent_status: "idle",
        cwd: "/work/project",
        focused: false,
        name: null,
        pane_id: "w1:p2",
        workspace_id: "w1",
      },
    ],
  },
});

function cli(outputs: Record<string, string>): { herdr: HerdrCli; calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = async (args) => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    if (!(key in outputs)) throw new Error(`unexpected herdr ${key}`);
    return outputs[key]!;
  };
  return { herdr: new HerdrCli(runner), calls };
}

test("reads the enabled flag from herdr's plugin list (field plugin_id)", async () => {
  const { herdr } = cli({ "plugin list": PLUGIN_LIST });
  assert.equal(await herdr.pluginEnabled("claude-autoupdate"), false);
  assert.equal(await herdr.pluginEnabled("other"), undefined);
});

test("parses agent list", async () => {
  const { herdr } = cli({ "agent list": AGENT_LIST });
  const [agent] = await herdr.agentList();
  assert.equal(agent?.pane_id, "w1:p2");
  assert.equal(agent?.agent_session?.value, "00000000-0000-4000-8000-000000000001");
  assert.equal(agent?.cwd, "/work/project");
});

test("R2/R3: agent start passes Claude's arguments after --", async () => {
  const { herdr, calls } = cli({ "agent start": "{}" });
  await herdr.agentStart("cau-w1-p2", "w1:p2", ["--model", "sonnet", "--resume", "id"], 60_000);
  assert.deepEqual(calls[0], [
    "agent", "start", "cau-w1-p2", "--kind", "claude", "--pane", "w1:p2", "--timeout", "60000",
    "--", "--model", "sonnet", "--resume", "id",
  ]);
});

test("maps herdr's JSON errors", () => {
  const error = toHerdrError(new Error("exit 1"), '{"error":{"code":"agent_not_ready","message":"blocked"},"id":"cli:agent:start"}');
  assert.ok(error instanceof HerdrError);
  assert.equal(error.code, "agent_not_ready");
  assert.equal(toHerdrError(Object.assign(new Error("spawn"), { code: "ENOENT" }), "").code, "herdr_not_found");
  assert.equal(toHerdrError(Object.assign(new Error("t"), { killed: true }), "").code, "timeout");
});

test("R17: errors without herdr output do not repeat the command line", () => {
  const error = toHerdrError(
    Object.assign(new Error("Command failed: herdr agent start x --settings {\"token\":\"s3cret\"}"), { code: 1 }),
    "",
    "herdr agent start",
  );
  assert.equal(error.message, "herdr agent start failed (exit 1)");
});
