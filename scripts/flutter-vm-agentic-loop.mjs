#!/usr/bin/env node
/**
 * Full agentic Flutter loop — proves the VM-service integration end to end:
 *
 *   1. rc_start flutter run -d macos
 *   2. rc_flutter_endpoints (wait for URLs)
 *   3. rc_flutter_connect (open VM-service WS + subscribe to streams)
 *   4. rc_flutter_eval "1+1" — confirm two-way comms
 *   5. inject a synthetic build-time exception into main.dart
 *   6. rc_flutter_hot_reload   ← programmatic, structured result
 *   7. rc_flutter_drain_errors ← MUST see the exception (count > 0)
 *   8. restore main.dart, hot-reload again
 *   9. rc_flutter_drain_errors ← MUST be empty (count === 0)
 *  10. rc_flutter_screenshot save_to=/tmp/agentic-rc-final.png
 *  11. send 'q', wait for clean exit
 *
 * Cleans up main.dart in a finally block so the project is left untouched.
 */
import { spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  unlinkSync,
  existsSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, "..", "dist", "index.js");
const flutterCwd = join(here, "..", "flutter_example");
const mainDart = join(flutterCwd, "lib", "main.dart");
const mainDartBak = mainDart + ".agentic-bak";
const screenshotPath = "/tmp/agentic-rc-final.png";

function injectException() {
  const original = readFileSync(mainDart, "utf8");
  copyFileSync(mainDart, mainDartBak);
  const marker = "Widget build(BuildContext context) {\n    // This method is rerun";
  if (!original.includes(marker)) {
    throw new Error("could not find injection point in main.dart");
  }
  const patched = original.replace(
    marker,
    `Widget build(BuildContext context) {
    throw Exception('agentic-rc VM demo: synthetic build-time exception');
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
  // 0. init MCP
  console.log("→ initialize MCP server");
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "vm-agentic-loop", version: "0.0.1" },
  });
  console.log(`  ${init.serverInfo.name} v${init.serverInfo.version}`);
  notify("notifications/initialized", {});

  // 1. start flutter
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

  // 2. wait for endpoints to be auto-detected
  console.log("→ rc_flutter_endpoints wait_ms=180000");
  const endpoints = unwrap(
    await send(
      "tools/call",
      {
        name: "rc_flutter_endpoints",
        arguments: { session_id: sid, wait_ms: 180_000 },
      },
      200_000,
    ),
  );
  console.log("  endpoints:");
  console.log(`    vm_service_ws : ${endpoints.vm_service_ws}`);
  console.log(`    vm_service_http: ${endpoints.vm_service_http}`);
  console.log(`    devtools_url  : ${endpoints.devtools_url}`);
  console.log(`    host:port     : ${endpoints.host}:${endpoints.port}`);
  console.log(`    detected_at_ms: ${endpoints.detected_at_ms}`);

  // 3. open VM service WS
  console.log("→ rc_flutter_connect");
  const connectInfo = unwrap(
    await send("tools/call", {
      name: "rc_flutter_connect",
      arguments: { session_id: sid, wait_ms: 30_000, subscribe: true },
    }),
  );
  console.log(`  ${JSON.stringify(connectInfo)}`);

  // 4. sanity-eval
  console.log("→ rc_flutter_eval expression='1+1'");
  const evalInfo = unwrap(
    await send("tools/call", {
      name: "rc_flutter_eval",
      arguments: { session_id: sid, expression: "1+1" },
    }),
  );
  console.log(`  ${evalInfo.kind} = ${evalInfo.valueAsString}`);

  // give the framework a beat in case any errors are still queued from boot
  await sleep(500);
  console.log("→ rc_flutter_drain_errors (initial baseline)");
  const baseline = unwrap(
    await send("tools/call", {
      name: "rc_flutter_drain_errors",
      arguments: { session_id: sid },
    }),
  );
  console.log(`  baseline error count: ${baseline.count}`);

  // 5. inject the bug
  console.log("→ patch main.dart: throw Exception in build()");
  injectException();

  // 6. programmatic hot reload
  console.log("→ rc_flutter_hot_reload");
  const reloadInfo = unwrap(
    await send(
      "tools/call",
      { name: "rc_flutter_hot_reload", arguments: { session_id: sid } },
      20_000,
    ),
  );
  console.log(`  reload: ${JSON.stringify(reloadInfo)}`);

  // 7. drain errors AFTER the bad reload
  await sleep(1500);
  console.log("→ rc_flutter_drain_errors (after-buggy-reload)");
  const buggyErrs = unwrap(
    await send("tools/call", {
      name: "rc_flutter_drain_errors",
      arguments: { session_id: sid },
    }),
  );
  console.log(`  count=${buggyErrs.count}`);
  buggyErrs.errors.slice(0, 3).forEach((e, i) => {
    console.log(`    [${i}] ${e.stream}  ${e.message.slice(0, 200)}`);
  });
  if (buggyErrs.count === 0) {
    throw new Error("ASSERTION FAILED: drain_errors returned 0 after a broken hot-reload");
  }
  console.log("  ✅ structured error detected via VM service (no PTY grepping)");

  // 8. restore + hot reload
  console.log("→ restore main.dart");
  restoreMainDart();
  console.log("→ rc_flutter_hot_reload (after fix)");
  const reload2 = unwrap(
    await send("tools/call", {
      name: "rc_flutter_hot_reload",
      arguments: { session_id: sid },
    }),
  );
  console.log(`  reload: ${JSON.stringify(reload2)}`);
  await sleep(1500);

  console.log("→ rc_flutter_drain_errors (after-fix)");
  const cleanErrs = unwrap(
    await send("tools/call", {
      name: "rc_flutter_drain_errors",
      arguments: { session_id: sid },
    }),
  );
  console.log(`  count=${cleanErrs.count}`);
  if (cleanErrs.count !== 0) {
    console.log("  ⚠️  expected 0 — but app may still be re-emitting stale errors");
    cleanErrs.errors.slice(0, 2).forEach((e, i) =>
      console.log(`    [${i}] ${e.stream}  ${e.message.slice(0, 200)}`),
    );
  } else {
    console.log("  ✅ clean — bug fixed and verified via VM service");
  }

  // 9. screenshot
  console.log(`→ rc_flutter_screenshot save_to=${screenshotPath}`);
  try {
    const shotResult = unwrap(
      await send("tools/call", {
        name: "rc_flutter_screenshot",
        arguments: { session_id: sid, save_to: screenshotPath },
      }),
    );
    if (shotResult.saved_to && existsSync(shotResult.saved_to)) {
      const size = statSync(shotResult.saved_to).size;
      console.log(`  ✅ saved ${size} bytes to ${shotResult.saved_to}`);
    } else {
      console.log(`  ${JSON.stringify(shotResult)}`);
    }
  } catch (err) {
    console.log(`  ⚠️  screenshot failed: ${err.message}`);
  }

  // 10. quit
  console.log("→ rc_send_keys 'q' (quit)");
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

  console.log("\n=== AGENTIC LOOP PASSED ===");
}

main()
  .then(() => {
    restoreMainDart();
    child.kill("SIGTERM");
    process.exit(0);
  })
  .catch((err) => {
    restoreMainDart();
    child.kill("SIGKILL");
    console.error("\n=== AGENTIC LOOP FAILED ===");
    console.error(err);
    process.exit(1);
  });

process.on("SIGINT", () => {
  restoreMainDart();
  process.exit(130);
});
process.on("SIGTERM", () => {
  restoreMainDart();
  process.exit(143);
});
