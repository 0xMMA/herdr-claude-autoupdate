import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = readFileSync(join(ROOT, "herdr-plugin.toml"), "utf8");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  version: string;
  engines: { node: string };
  dependencies?: Record<string, string>;
};

test("the manifest and package.json carry the same version", () => {
  const version = /^version\s*=\s*"([^"]+)"/m.exec(manifest)?.[1];
  assert.equal(version, pkg.version);
});

test("R9: declares Linux, macOS and Windows", () => {
  assert.match(manifest, /^platforms\s*=\s*\["linux", "macos", "windows"\]/m);
});

test("R11: no event hooks (each event would start a process)", () => {
  assert.doesNotMatch(manifest, /^\[\[events\]\]/m);
});

test("R13: no runtime dependencies, Node >= 22.18, every command runs node on an existing file", () => {
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.engines.node, ">=22.18.0");
  const commands = [...manifest.matchAll(/^command\s*=\s*\[(.*)\]/gm)].map((m) => JSON.parse(`[${m[1]}]`) as string[]);
  assert.ok(commands.length > 0);
  for (const argv of commands) {
    assert.equal(argv[0], "node");
    assert.ok(existsSync(join(ROOT, argv[1]!)), `${argv[1]} exists`);
  }
});

test("R7: the countdown is a popup entrypoint", () => {
  assert.match(manifest, /id = "countdown"\s*\ntitle = "[^"]+"\s*\nplacement = "popup"/);
});
