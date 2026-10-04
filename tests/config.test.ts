import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, loadConfig, parseConfig, writeDryRun } from "../src/config.ts";
import { tempDir } from "./helpers.ts";

test("R16: dry run is on by default", () => {
  assert.equal(DEFAULT_CONFIG.dryRun, true);
  assert.equal(loadConfig(tempDir()).config.dryRun, true);
});

test("R7: the countdown defaults to 5 seconds", () => {
  assert.equal(DEFAULT_CONFIG.countdownSeconds, 5);
});

test("reads snake_case settings", () => {
  const { config, warnings } = parseConfig({
    dry_run: false,
    interval_seconds: 30,
    quiet_seconds: 0,
    countdown_seconds: 8,
    focused_unattended_minutes: 10,
    rescue_drafts: false,
    toast: true,
    fake_installed_version: "9.9.9",
  });
  assert.deepEqual(warnings, []);
  assert.equal(config.dryRun, false);
  assert.equal(config.intervalSeconds, 30);
  assert.equal(config.quietSeconds, 0);
  assert.equal(config.countdownSeconds, 8);
  assert.equal(config.focusedUnattendedMinutes, 10);
  assert.equal(config.rescueDrafts, false);
  assert.equal(config.toast, true);
  assert.equal(config.fakeInstalledVersion, "9.9.9");
});

test("invalid values fall back to defaults with a warning", () => {
  const { config, warnings } = parseConfig({ interval_seconds: 1, dry_run: "no", colour: "blue" });
  assert.equal(config.intervalSeconds, DEFAULT_CONFIG.intervalSeconds);
  assert.equal(config.dryRun, DEFAULT_CONFIG.dryRun);
  assert.equal(warnings.length, 3);
});

test("a broken config.json does not stop the plugin", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "config.json"), "{ not json");
  const { config, warnings } = loadConfig(dir);
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.equal(warnings.length, 1);
  assert.equal(parseConfig([1, 2]).warnings.length, 1);
});

test("an empty fake_installed_version counts as unset", () => {
  assert.equal(parseConfig({ fake_installed_version: "" }).config.fakeInstalledVersion, undefined);
});

test("R14: claude_path can point at a launcher outside PATH", () => {
  assert.equal(parseConfig({ claude_path: "/opt/claude/bin/claude" }).config.claudePath, "/opt/claude/bin/claude");
});

test("R16: the live/dry-run switch keeps the other settings", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "config.json"), JSON.stringify({ quiet_seconds: 30, toast: true }));
  assert.deepEqual(writeDryRun(dir, false), { ok: true });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")), { quiet_seconds: 30, toast: true, dry_run: false });
  assert.equal(loadConfig(dir).config.dryRun, false);
  assert.deepEqual(writeDryRun(dir, true), { ok: true });
  assert.equal(loadConfig(dir).config.dryRun, true);
});

test("R16: the live/dry-run switch creates config.json (and its folder) when there is none", () => {
  const dir = join(tempDir(), "not-yet");
  assert.deepEqual(writeDryRun(dir, false), { ok: true });
  assert.equal(loadConfig(dir).config.dryRun, false);
});

test("R16: the live/dry-run switch never overwrites a config.json it cannot parse", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "config.json"), "{ my half-edited config");
  const result = writeDryRun(dir, false);
  assert.equal(result.ok, false);
  assert.equal(readFileSync(join(dir, "config.json"), "utf8"), "{ my half-edited config");
  writeFileSync(join(dir, "config.json"), "[1, 2]");
  assert.equal(writeDryRun(dir, false).ok, false);
});

test("config.json saved with a UTF-8 byte order mark is read", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "config.json"), "﻿" + JSON.stringify({ dry_run: false, toast: true }));
  assert.equal(loadConfig(dir).config.dryRun, false);
  assert.deepEqual(writeDryRun(dir, true), { ok: true });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")), { dry_run: true, toast: true });
});

test("R16: an empty config.json is treated as no settings; a failed write is reported, not thrown", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "config.json"), "");
  assert.deepEqual(writeDryRun(dir, false), { ok: true });
  assert.equal(loadConfig(dir).config.dryRun, false);

  const notADir = join(tempDir(), "file");
  writeFileSync(notADir, "x");
  const result = writeDryRun(join(notADir, "config"), false);
  assert.equal(result.ok, false);
});
