#!/usr/bin/env node
/**
 * Real-world demo: drive `flutter run` inside flutter_example/ end-to-end via
 * the agentic-rc MCP server.
 *
 *   1. start the MCP server over stdio
 *   2. rc_start flutter run -d macos (cwd = flutter_example)
 *   3. rc_wait_for the Flutter ready-banner
 *   4. snapshot screen (tail)
 *   5. rc_send_keys 'r' → hot reload
 *   6. rc_wait_for 'Reloaded'
 *   7. rc_send_keys 'q' → quit
 *   8. poll rc_status until exited
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, "..", "dist", "index.js");
const flutterCwd = join(here, "..", "flutter_example");

const child = spawn(process.execPath, [serverEntry], {
  stdio: ["pipe", "pipe", "pipe"],
});

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
child.stderr.on("data", (chunk) => {
  process.stderr.write(`[server] ${chunk}`);
});

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
function unwrap(result) {
  return JSON.parse(result.content.find((c) => c.type === "text").text);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("→ initialize MCP server");
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "flutter-drive", version: "0.0.1" },
  });
  console.log(`  server: ${init.serverInfo.name} v${init.serverInfo.version}`);
  notify("notifications/initialized", {});

  console.log("→ rc_start: flutter run -d macos");
  const startInfo = unwrap(
    await send("tools/call", {
      name: "rc_start",
      arguments: {
        command: "flutter",
        args: ["run", "-d", "macos"],
        cwd: flutterCwd,
        cols: 140,
        rows: 50,
      },
    }),
  );
  const sid = startInfo.session_id;
  console.log(`  session=${sid}  pid=${startInfo.pid}`);

  console.log("→ rc_wait_for ready-banner ('Flutter run key commands') — up to 5 min");
  const waitReady = unwrap(
    await send(
      "tools/call",
      {
        name: "rc_wait_for",
        arguments: {
          session_id: sid,
          pattern: "Flutter run key commands",
          timeout_ms: 300_000,
          source: "stream",
        },
      },
      310_000,
    ),
  );
  if (!waitReady.matched) {
    throw new Error(`Flutter never reached ready state: ${JSON.stringify(waitReady)}`);
  }
  console.log("  READY");

  console.log("→ rc_read_screen mode=tail");
  const tail = unwrap(
    await send("tools/call", {
      name: "rc_read_screen",
      arguments: { session_id: sid, mode: "tail", tail_lines: 15 },
    }),
  );
  console.log("  screen tail:");
  console.log(
    tail.text
      .split("\n")
      .map((l) => "    | " + l)
      .join("\n"),
  );

  console.log("→ rc_send_keys 'r' (hot reload)");
  await send("tools/call", {
    name: "rc_send_keys",
    arguments: { session_id: sid, keys: "r" },
  });

  console.log("→ rc_wait_for 'Reloaded'");
  const reload = unwrap(
    await send(
      "tools/call",
      {
        name: "rc_wait_for",
        arguments: {
          session_id: sid,
          pattern: "Reloaded",
          timeout_ms: 30_000,
          source: "stream",
        },
      },
      35_000,
    ),
  );
  console.log(
    reload.matched ? `  HOT-RELOAD OK — '${reload.matched_text}'` : "  HOT-RELOAD MISS",
  );

  console.log("→ rc_send_keys 'q' (quit)");
  await send("tools/call", {
    name: "rc_send_keys",
    arguments: { session_id: sid, keys: "q" },
  });

  console.log("→ poll rc_status until exited (max 30 s)");
  const exitDeadline = Date.now() + 30_000;
  let finalStatus = null;
  while (Date.now() < exitDeadline) {
    const s = unwrap(
      await send("tools/call", {
        name: "rc_status",
        arguments: { session_id: sid },
      }),
    );
    if (s.status !== "running") {
      finalStatus = s;
      break;
    }
    await sleep(500);
  }
  if (!finalStatus) {
    console.log("  did not exit on 'q' — escalating via rc_stop");
    finalStatus = unwrap(
      await send("tools/call", {
        name: "rc_stop",
        arguments: { session_id: sid, wait_ms: 5000, remove: true },
      }),
    );
  }
  console.log(`  EXIT — status=${finalStatus.status} code=${finalStatus.exit_code}`);

  console.log("\n=== FLUTTER DRIVE PASSED ===");
  child.kill("SIGTERM");
  process.exit(0);
}

main().catch((err) => {
  console.error("\n=== FLUTTER DRIVE FAILED ===");
  console.error(err);
  child.kill("SIGKILL");
  process.exit(1);
});
