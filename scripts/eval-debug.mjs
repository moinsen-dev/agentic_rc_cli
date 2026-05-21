#!/usr/bin/env node
/**
 * Phase 4 — test if newlines in the expression break compile.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, "..", "dist", "index.js");
const flutterCwd = join(here, "..", "flutter_example");

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
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    } catch {}
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
        reject(new Error(`Timeout waiting for ${method}`));
      }
    }, timeoutMs);
  });
}
function notify(m, p) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\n");
}
function unwrapText(r) {
  return r.content.find((c) => c.type === "text").text;
}

async function tryEval(label, expression) {
  process.stdout.write(`── ${label} ── (${expression.length} chars)\n`);
  const r = await send("tools/call", {
    name: "rc_flutter_eval",
    arguments: { session_id: sid, expression },
  });
  const t = unwrapText(r);
  try {
    const j = JSON.parse(t);
    if (j.kind === "@Instance") console.log(`  OK = ${j.valueAsString}`);
    else console.log(`  result kind=${j.kind} val=${j.valueAsString}`);
  } catch {
    console.log(`  ERR ${t.slice(0, 250)}`);
  }
}

let sid;
async function main() {
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "eval-debug-4", version: "0.0.1" },
  });
  notify("notifications/initialized", {});

  const startInfo = JSON.parse(
    unwrapText(
      await send("tools/call", {
        name: "rc_start",
        arguments: { command: "flutter", args: ["run", "-d", "macos"], cwd: flutterCwd },
      }),
    ),
  );
  sid = startInfo.session_id;
  console.log(`session=${sid}`);

  await send(
    "tools/call",
    {
      name: "rc_flutter_connect",
      arguments: { session_id: sid, wait_ms: 180_000, subscribe: true },
    },
    200_000,
  );
  await new Promise((r) => setTimeout(r, 1500));

  // Single line — Element? found, etc.
  const oneLine = `(() { Element? found; void visit(Element e) { if (found != null) return; if (e.widget.runtimeType.toString() == "FloatingActionButton") { found = e; return; } e.visitChildren(visit); } WidgetsBinding.instance.rootElement?.visitChildren(visit); if (found == null) return "not_found"; return "found:" + found!.widget.runtimeType.toString(); })()`;
  await tryEval("find FAB one-line", oneLine);

  // Same code with newlines
  const multiLine = `(() {
    Element? found;
    void visit(Element e) {
      if (found != null) return;
      if (e.widget.runtimeType.toString() == "FloatingActionButton") { found = e; return; }
      e.visitChildren(visit);
    }
    WidgetsBinding.instance.rootElement?.visitChildren(visit);
    if (found == null) return "not_found";
    return "found:" + found!.widget.runtimeType.toString();
  })()`;
  await tryEval("find FAB multi-line", multiLine);

  // If multi-line fails, try collapsing
  const collapsed = multiLine.replace(/\s+/g, " ");
  await tryEval("find FAB collapsed whitespace", collapsed);

  // Quit
  await send("tools/call", {
    name: "rc_send_keys",
    arguments: { session_id: sid, keys: "q" },
  });
  await new Promise((r) => setTimeout(r, 2000));
  child.kill("SIGTERM");
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  child.kill("SIGKILL");
  process.exit(1);
});
