#!/usr/bin/env node
/**
 * Demo: can the MCP-driving agent detect a Flutter runtime exception?
 *
 *   1. back up flutter_example/lib/main.dart
 *   2. inject a `throw Exception(...)` at the top of _MyHomePageState.build()
 *   3. spawn flutter via the MCP server
 *   4. wait_for either the ready-banner OR the framework-exception banner
 *   5. snapshot the rendered console
 *   6. restore main.dart in a finally block, quit flutter
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, "..", "dist", "index.js");
const flutterCwd = join(here, "..", "flutter_example");
const mainDart = join(flutterCwd, "lib", "main.dart");
const mainDartBak = mainDart + ".agentic-bak";

function patchMainDart() {
  const original = readFileSync(mainDart, "utf8");
  copyFileSync(mainDart, mainDartBak);
  const marker = "Widget build(BuildContext context) {\n    // This method is rerun";
  if (!original.includes(marker)) {
    throw new Error("could not find injection point in main.dart");
  }
  const patched = original.replace(
    marker,
    `Widget build(BuildContext context) {
    throw Exception('agentic-rc demo: synthetic build-time exception');
    // This method is rerun`,
  );
  writeFileSync(mainDart, patched, "utf8");
}

function restoreMainDart() {
  if (existsSync(mainDartBak)) {
    copyFileSync(mainDartBak, mainDart);
    unlinkSync(mainDartBak);
  }
}

const child = spawn(process.execPath, [serverEntry], { stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let nextId = 1;
let stdoutBuf = "";

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk;
  let idx;
  while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
    const line = stdoutBuf.slice(0, idx);
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => process.stderr.write(`[server] ${c}`));

function send(method, params, timeoutMs = 30_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for ${method} (id=${id})`));
      }
    }, timeoutMs);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}
function unwrap(r) {
  return JSON.parse(r.content.find((c) => c.type === "text").text);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("→ patching main.dart with synthetic build-time exception");
  patchMainDart();

  console.log("→ initialize MCP");
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "flutter-error-detect", version: "0.0.1" },
  });
  notify("notifications/initialized", {});

  console.log("→ rc_start: flutter run -d macos");
  const startInfo = unwrap(
    await send("tools/call", {
      name: "rc_start",
      arguments: {
        command: "flutter",
        args: ["run", "-d", "macos"],
        cwd: flutterCwd,
        cols: 160,
        rows: 60,
      },
    }),
  );
  const sid = startInfo.session_id;
  console.log(`  session=${sid} pid=${startInfo.pid}`);

  console.log("→ rc_wait_for either ready-banner OR exception banner (≤5 min, stream source)");
  const wait = unwrap(
    await send(
      "tools/call",
      {
        name: "rc_wait_for",
        arguments: {
          session_id: sid,
          // regex OR — matches whichever appears first
          pattern: "/EXCEPTION CAUGHT BY WIDGETS LIBRARY|Flutter run key commands/",
          timeout_ms: 300_000,
          source: "stream",
        },
      },
      310_000,
    ),
  );

  const sawException = /EXCEPTION CAUGHT BY WIDGETS LIBRARY/i.test(wait.matched_text ?? "");
  console.log(
    `  matched: '${wait.matched_text}' — ${sawException ? "❌ EXCEPTION DETECTED" : "ready (no error)"}`,
  );

  // Give Flutter a moment more to print the full stack-trace block.
  await sleep(1500);

  console.log("→ rc_read_screen mode=scrollback (last 35 lines)");
  const tail = unwrap(
    await send("tools/call", {
      name: "rc_read_screen",
      arguments: { session_id: sid, mode: "tail", tail_lines: 35 },
    }),
  );
  console.log("  ── captured console ──────────────────────────────────────");
  console.log(
    tail.text
      .split("\n")
      .map((l) => "    " + l)
      .join("\n"),
  );
  console.log("  ──────────────────────────────────────────────────────────");

  console.log("→ rc_send_keys 'q' (quit) and wait for exit");
  await send("tools/call", {
    name: "rc_send_keys",
    arguments: { session_id: sid, keys: "q" },
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const s = unwrap(
      await send("tools/call", {
        name: "rc_status",
        arguments: { session_id: sid },
      }),
    );
    if (s.status !== "running") {
      console.log(`  EXIT status=${s.status} code=${s.exit_code}`);
      break;
    }
    await sleep(500);
  }

  return { sawException };
}

main()
  .then(({ sawException }) => {
    restoreMainDart();
    child.kill("SIGTERM");
    console.log(
      `\n=== RESULT: agent ${sawException ? "DID detect" : "did NOT detect"} the synthetic exception ===`,
    );
    process.exit(sawException ? 0 : 2);
  })
  .catch((err) => {
    restoreMainDart();
    child.kill("SIGKILL");
    console.error("\n=== FAILED ===");
    console.error(err);
    process.exit(1);
  });

// Belt-and-suspenders restore on accidental termination.
process.on("SIGINT", () => {
  restoreMainDart();
  process.exit(130);
});
process.on("SIGTERM", () => {
  restoreMainDart();
  process.exit(143);
});
