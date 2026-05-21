#!/usr/bin/env node
/**
 * Live demo of the Flutter Inspector tools.
 *
 *   1. start `flutter run -d macos` against flutter_example/
 *   2. wait for VM-service endpoint
 *   3. rc_flutter_connect
 *   4. rc_flutter_widget_tree max_depth=8 — print a tree summary
 *   5. rc_flutter_widget_find by=type, value="FloatingActionButton"
 *   6. rc_flutter_widget_properties on the FAB's valueId
 *   7. rc_flutter_widget_find by=type, value="Text" — find the counter label
 *   8. quit
 *
 * Read-only against the live UI — no files patched, no destructive ops.
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

function printTree(node, depth = 0) {
  const indent = "  ".repeat(depth);
  const keyPart = node.key ? `  key=${node.key}` : "";
  const srcPart = node.source_location ? `  ← ${node.source_location.split("/").slice(-2).join("/")}` : "";
  console.log(`${indent}- ${node.description}${keyPart}${srcPart}`);
  for (const c of node.children) printTree(c, depth + 1);
}

async function main() {
  console.log("→ initialize MCP");
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "flutter-inspector-demo", version: "0.0.1" },
  });
  notify("notifications/initialized", {});

  console.log("→ rc_start: flutter run -d macos");
  const startInfo = unwrap(
    await send("tools/call", {
      name: "rc_start",
      arguments: { command: "flutter", args: ["run", "-d", "macos"], cwd: flutterCwd },
    }),
  );
  const sid = startInfo.session_id;
  console.log(`  session=${sid}`);

  console.log("→ rc_flutter_connect wait_ms=180000");
  await send(
    "tools/call",
    {
      name: "rc_flutter_connect",
      arguments: { session_id: sid, wait_ms: 180_000, subscribe: true },
    },
    200_000,
  );

  // Give Flutter a beat to actually finish building the first frame.
  await sleep(1500);

  console.log("→ rc_flutter_widget_tree max_depth=10");
  const treeRes = unwrap(
    await send(
      "tools/call",
      {
        name: "rc_flutter_widget_tree",
        arguments: { session_id: sid, max_depth: 10 },
      },
      30_000,
    ),
  );
  console.log("\n── widget tree ─────────────────────────────────────────");
  printTree(treeRes.tree);
  console.log(`── (cache_age=${treeRes.cache_age_ms} ms, max_depth=${treeRes.max_depth})`);

  console.log("\n→ rc_flutter_widget_find by=type, value=FloatingActionButton");
  const fabFind = unwrap(
    await send("tools/call", {
      name: "rc_flutter_widget_find",
      arguments: { session_id: sid, by: "type", value: "FloatingActionButton" },
    }),
  );
  console.log(`  matches: ${fabFind.count}`);
  fabFind.matches.forEach((m, i) => {
    console.log(`    [${i}] ${m.path}`);
    console.log(`        valueId=${m.valueId}  source=${m.source_location}`);
  });

  if (fabFind.count === 0) {
    throw new Error("expected to find FloatingActionButton in counter app — search broke");
  }

  console.log("\n→ rc_flutter_widget_properties on FAB");
  const fabId = fabFind.matches[0].valueId;
  const fabProps = unwrap(
    await send("tools/call", {
      name: "rc_flutter_widget_properties",
      arguments: { session_id: sid, value_id: fabId },
    }),
  );
  console.log(`  ${fabProps.count} properties:`);
  fabProps.properties.slice(0, 12).forEach((p) => {
    const v = p.description ?? JSON.stringify(p.value);
    console.log(`    ${(p.name ?? "(unnamed)").padEnd(18)} ${v}`);
  });
  if (fabProps.count > 12) console.log(`    … and ${fabProps.count - 12} more`);

  console.log("\n→ rc_flutter_widget_find by=type, value=Text");
  const textFind = unwrap(
    await send("tools/call", {
      name: "rc_flutter_widget_find",
      arguments: { session_id: sid, by: "type", value: "Text" },
    }),
  );
  console.log(`  matches: ${textFind.count}`);
  textFind.matches.slice(0, 5).forEach((m) => {
    console.log(`    ${m.path}`);
  });

  // For the counter Text — read its content via properties.
  if (textFind.count > 0) {
    // Counter value Text is typically the deepest Text on the home page.
    const counterText = textFind.matches.find((m) => m.path.includes("Column")) ?? textFind.matches[textFind.matches.length - 1];
    console.log(`\n→ rc_flutter_widget_properties on counter Text (valueId=${counterText.valueId})`);
    const props = unwrap(
      await send("tools/call", {
        name: "rc_flutter_widget_properties",
        arguments: { session_id: sid, value_id: counterText.valueId },
      }),
    );
    const data = props.properties.find((p) => p.name === "data" || p.name === "text");
    if (data) {
      console.log(`    data = ${data.description ?? data.value}`);
    } else {
      props.properties.slice(0, 5).forEach((p) =>
        console.log(`    ${(p.name ?? "?").padEnd(12)} ${p.description ?? JSON.stringify(p.value)}`),
      );
    }
  }

  console.log("\n→ quit");
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

  console.log("\n=== INSPECTOR DEMO PASSED ===");
}

main()
  .then(() => {
    child.kill("SIGTERM");
    process.exit(0);
  })
  .catch((err) => {
    child.kill("SIGKILL");
    console.error("\n=== INSPECTOR DEMO FAILED ===");
    console.error(err);
    process.exit(1);
  });
