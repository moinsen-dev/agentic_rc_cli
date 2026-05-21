#!/usr/bin/env node
/**
 * On macOS / Linux, npm 10 sometimes extracts node-pty's `spawn-helper`
 * prebuild without preserving the executable bit, which causes
 * `posix_spawnp failed` at runtime. This postinstall step fixes that.
 *
 * No-op on Windows or when the file isn't present.
 */
import { chmodSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const targets = [
  join(root, "node_modules", "node-pty", "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  join(root, "node_modules", "node-pty", "build", "Release", "spawn-helper"),
];

let fixed = 0;
for (const target of targets) {
  if (!existsSync(target)) continue;
  try {
    const mode = statSync(target).mode;
    // Add executable bits for user / group / other (0o111).
    chmodSync(target, mode | 0o111);
    fixed++;
  } catch (err) {
    process.stderr.write(`[agentic-rc] could not chmod ${target}: ${err && err.message}\n`);
  }
}

if (fixed > 0) {
  process.stdout.write(`[agentic-rc] fixed exec bit on ${fixed} node-pty helper(s)\n`);
}
