#!/usr/bin/env node
/**
 * The killer end-to-end demo: drive the Flutter counter app like a human
 * would, *without any screen access* — purely through the agentic-rc MCP.
 *
 *   1. flutter run -d macos
 *   2. inspect: find the counter Text + the FAB
 *   3. read the counter's `data` property (initial: "0")
 *   4. rc_flutter_tap on the FAB
 *   5. wait for a frame, refresh tree, re-read counter (expected: "1")
 *   6. tap again — assert "2"
 *   7. tap five more times — assert "7"
 *   8. quit cleanly
 *
 * This is exactly the "test the UI without Peekaboo/chrome-devtools" loop.
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

async function readCounterValue(sid) {
  // The Flutter counter sample shows the count via the second Text in the
  // Column. We re-find it (after refresh) and read its `data` property.
  // refresh:true makes sure inspector valueIds are fresh after the rebuild.
  const find = unwrap(
    await send("tools/call", {
      name: "rc_flutter_widget_find",
      arguments: { session_id: sid, by: "type", value: "Text", refresh: true, limit: 20 },
    }),
  );
  // The counter is whichever Text is inside the Column on the home page.
  // It's a single-character integer; the other Texts have descriptive copy.
  const candidates = find.matches.filter((m) => m.path.includes("Column"));
  for (const c of candidates) {
    const props = unwrap(
      await send("tools/call", {
        name: "rc_flutter_widget_properties",
        arguments: { session_id: sid, value_id: c.valueId },
      }),
    );
    const data = props.properties.find((p) => p.name === "data");
    if (!data || !data.description) continue;
    // `data.description` looks like '"0"' — drop the surrounding quotes.
    const stripped = data.description.replace(/^"|"$/g, "");
    if (/^\d+$/.test(stripped)) {
      return { value: parseInt(stripped, 10), valueId: c.valueId };
    }
  }
  return { value: null, valueId: null };
}

async function main() {
  console.log("→ initialize MCP");
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "flutter-tap-demo", version: "0.0.1" },
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

  console.log("→ rc_flutter_connect");
  await send(
    "tools/call",
    {
      name: "rc_flutter_connect",
      arguments: { session_id: sid, wait_ms: 180_000, subscribe: true },
    },
    200_000,
  );
  await sleep(1500);

  console.log("→ rc_flutter_widget_geometry on FAB (optional — may fail on some Flutter versions)");
  const geom = unwrap(
    await send("tools/call", {
      name: "rc_flutter_widget_geometry",
      arguments: { session_id: sid, by: "type", value: "FloatingActionButton" },
    }),
  );
  if (geom.success) {
    console.log(
      `  FAB rect = (${geom.rect.x}, ${geom.rect.y}, ${geom.rect.width} × ${geom.rect.height})`,
    );
  } else {
    console.log(`  geometry failed (${geom.reason}) — moving on, tap doesn't need it`);
  }

  // Initial counter reading
  let prev = await readCounterValue(sid);
  console.log(`→ initial counter value: ${prev.value}`);
  if (prev.value === null) throw new Error("could not read initial counter");

  const taps = [1, 2, 3, 4, 5, 6, 7];
  for (const expected of taps) {
    console.log(`→ rc_flutter_tap by=type FloatingActionButton  (expect counter=${expected})`);
    const tap = unwrap(
      await send("tools/call", {
        name: "rc_flutter_tap",
        arguments: { session_id: sid, by: "type", value: "FloatingActionButton" },
      }),
    );
    if (!tap.success) {
      console.error("tap full:", JSON.stringify(tap, null, 2));
      throw new Error(`tap failed: ${tap.reason}`);
    }
    console.log(`  fired callback: ${tap.callback}`);

    // Give the framework a frame to rebuild.
    await sleep(300);

    const now = await readCounterValue(sid);
    console.log(`  counter now: ${now.value}`);
    if (now.value !== expected) {
      throw new Error(`ASSERTION: expected counter=${expected}, got ${now.value}`);
    }
  }

  // Also exercise wait_for_widget on something we know is there.
  console.log("→ rc_flutter_wait_for_widget by=type AppBar");
  const wait = unwrap(
    await send("tools/call", {
      name: "rc_flutter_wait_for_widget",
      arguments: { session_id: sid, by: "type", value: "AppBar", timeout_ms: 3000 },
    }),
  );
  console.log(`  ${wait.matched ? "✅ AppBar present" : "⚠️ no AppBar"}`);

  console.log("\n→ rc_send_keys 'q' (quit)");
  await send("tools/call", {
    name: "rc_send_keys",
    arguments: { session_id: sid, keys: "q" },
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const s = unwrap(
      await send("tools/call", { name: "rc_status", arguments: { session_id: sid } }),
    );
    if (s.status !== "running") {
      console.log(`  EXIT status=${s.status} code=${s.exit_code}`);
      break;
    }
    await sleep(500);
  }

  console.log("\n=== AGENTIC TAP DEMO PASSED ===");
  console.log(`Counter incremented from 0 → 7 via ${taps.length} synthetic taps,`);
  console.log(`each verified by reading the Text widget's data property. No`);
  console.log(`screenshots, no Peekaboo, no chrome-devtools. Pure VM-service.`);
}

main()
  .then(() => {
    child.kill("SIGTERM");
    process.exit(0);
  })
  .catch((err) => {
    child.kill("SIGKILL");
    console.error("\n=== AGENTIC TAP DEMO FAILED ===");
    console.error(err);
    process.exit(1);
  });
