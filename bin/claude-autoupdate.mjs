#!/usr/bin/env node
// Plain JavaScript on purpose: this check must run even on a Node.js that cannot
// load TypeScript, so the user gets a clear message instead of a syntax error.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(
    `herdr-claude-autoupdate needs Node.js 22.18 or newer (found ${process.versions.node}); ` +
      "it runs its TypeScript sources directly.",
  );
  process.exit(1);
}

const { main } = await import("../src/main.ts");
process.exitCode = await main(process.argv.slice(2));
