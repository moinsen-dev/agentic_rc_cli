#!/usr/bin/env node
/**
 * End-to-end smoke test: spawns the built MCP server over stdio, drives it
 * with hand-rolled JSON-RPC, asserts the full happy path.
 *
 *   1. initialize
 *   2. tools/list — expect all 8 rc_* tools
 *   3. rc_start /bin/sh -i
 *   4. rc_send_keys 'echo hello-from-mcp<Enter>'
 *   5. rc_wait_for 'hello-from-mcp'
 *   6. rc_read_screen scrollback — assert text present
 *   7. rc_status — assert running
 *   8. rc_stop with remove
 *
 * Exits 0 on success, 1 on any failure.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, "..", "dist", "index.js");

const child = spawn(process.execPath, [serverEntry], {
  stdio: ["pipe", "pipe", "pipe"],
});

const pending = new Map(); // id -> {resolve, reject}
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
      console.error("[smoke] non-JSON line on stdout:", line);
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
  process.stderr.write(`[server-stderr] ${chunk}`);
});

function send(method, params) {
  const id = nextId++;
  const frame = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify(frame) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for ${method} (id=${id})`));
      }
    }, 10_000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function unwrapToolText(result) {
  const item = result?.content?.find((c) => c.type === "text");
  if (!item) throw new Error(`No text content in tool result: ${JSON.stringify(result)}`);
  return JSON.parse(item.text);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function main() {
  // 1. initialize
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.1" },
  });
  assert(init.serverInfo?.name === "agentic-rc", `bad serverInfo: ${JSON.stringify(init.serverInfo)}`);
  notify("notifications/initialized", {});
  console.log("OK initialize:", init.serverInfo);

  // 2. tools/list
  const tools = await send("tools/list", {});
  const names = tools.tools.map((t) => t.name).sort();
  const expected = [
    // Generic PTY tools
    "rc_read_screen",
    "rc_read_stream",
    "rc_resize",
    "rc_send_keys",
    "rc_start",
    "rc_status",
    "rc_stop",
    "rc_wait_for",
    // Flutter / Dart-VM observability (no UI interaction — see Marionette MCP for that)
    "rc_flutter_connect",
    "rc_flutter_drain_errors",
    "rc_flutter_drain_logs",
    "rc_flutter_endpoints",
    "rc_flutter_eval",
    "rc_flutter_hot_reload",
  ].sort();
  assert(
    JSON.stringify(names) === JSON.stringify(expected),
    `tools mismatch — got ${JSON.stringify(names)}`,
  );
  console.log("OK tools/list:", names.length, "tools (8 generic + 6 flutter)");

  // 3. rc_start /bin/sh -i
  const startResult = await send("tools/call", {
    name: "rc_start",
    arguments: { command: "/bin/sh", args: ["-i"], cols: 100, rows: 30 },
  });
  const startInfo = unwrapToolText(startResult);
  assert(typeof startInfo.session_id === "string" && startInfo.session_id.length > 0, "no session_id");
  assert(typeof startInfo.pid === "number" && startInfo.pid > 0, "no pid");
  const sid = startInfo.session_id;
  console.log("OK rc_start:", { session_id: sid, pid: startInfo.pid });

  // Give the shell a moment to write its prompt.
  await new Promise((r) => setTimeout(r, 200));

  // 4. rc_send_keys
  const sendRes = await send("tools/call", {
    name: "rc_send_keys",
    arguments: { session_id: sid, keys: "echo hello-from-mcp<Enter>" },
  });
  const sendInfo = unwrapToolText(sendRes);
  assert(sendInfo.bytes_sent > 0, "send_keys bytes_sent == 0");
  console.log("OK rc_send_keys:", sendInfo);

  // 5. rc_wait_for
  const waitRes = await send("tools/call", {
    name: "rc_wait_for",
    arguments: { session_id: sid, pattern: "hello-from-mcp", timeout_ms: 5000 },
  });
  const waitInfo = unwrapToolText(waitRes);
  assert(waitInfo.matched === true, `wait_for did not match: ${JSON.stringify(waitInfo)}`);
  console.log("OK rc_wait_for matched:", waitInfo.matched_text);

  // 6. rc_read_screen scrollback
  const scrollRes = await send("tools/call", {
    name: "rc_read_screen",
    arguments: { session_id: sid, mode: "scrollback" },
  });
  const scrollInfo = unwrapToolText(scrollRes);
  assert(scrollInfo.text.includes("hello-from-mcp"), `scrollback missing text: ${scrollInfo.text}`);
  console.log("OK rc_read_screen scrollback contains 'hello-from-mcp'");

  // 7. rc_status
  const statusRes = await send("tools/call", {
    name: "rc_status",
    arguments: { session_id: sid },
  });
  const statusInfo = unwrapToolText(statusRes);
  assert(statusInfo.status === "running", `status should be running, got ${statusInfo.status}`);
  console.log("OK rc_status:", { status: statusInfo.status, bytes_read: statusInfo.bytes_read });

  // 8. rc_stop with remove
  const stopRes = await send("tools/call", {
    name: "rc_stop",
    arguments: { session_id: sid, signal: "SIGTERM", wait_ms: 2000, remove: true },
  });
  const stopInfo = unwrapToolText(stopRes);
  assert(["exited", "killed"].includes(stopInfo.status), `unexpected stop status: ${stopInfo.status}`);
  assert(stopInfo.removed === true, "session not removed");
  console.log("OK rc_stop:", stopInfo);

  // Verify session no longer in registry.
  const listRes = await send("tools/call", {
    name: "rc_status",
    arguments: {},
  });
  const listInfo = unwrapToolText(listRes);
  assert(listInfo.count === 0, `expected 0 sessions, got ${listInfo.count}`);
  console.log("OK registry empty after remove");

  console.log("\n=== SMOKE TEST PASSED ===");
  child.kill("SIGTERM");
  process.exit(0);
}

main().catch((err) => {
  console.error("\n=== SMOKE TEST FAILED ===");
  console.error(err);
  child.kill("SIGKILL");
  process.exit(1);
});
