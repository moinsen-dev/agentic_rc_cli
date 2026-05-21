#!/usr/bin/env node
/**
 * The login-flow demo — proves the must-have:
 *   the agent can fill TextFields and pass an auth gate, end to end,
 *   without any GUI access.
 *
 *   1. Patch flutter_example/lib/main.dart with a small login screen:
 *      - email TextField (Key 'email-input')
 *      - password TextField (Key 'password-input', obscured)
 *      - login ElevatedButton (Key 'login-button')
 *      - status Text (Key 'login-status')
 *      onPressed sets _status to "Welcome, <email>" if email contains '@'
 *      and password is non-empty; otherwise "Invalid credentials".
 *   2. Spawn flutter run -d macos against the patched code.
 *   3. rc_flutter_enter_text on email + password.
 *   4. rc_flutter_tap on the login button.
 *   5. Re-read the status Text's `data` — assert success.
 *   6. Clear password, retry — assert failure path now appears.
 *   7. Restore main.dart, quit.
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

const LOGIN_MAIN_DART = `import 'package:flutter/material.dart';

void main() {
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Flutter Login Demo',
      theme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: Colors.deepPurple)),
      home: const LoginPage(),
    );
  }
}

class LoginPage extends StatefulWidget {
  const LoginPage({super.key});
  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  String _status = 'idle';

  void _submit() {
    final email = _email.text;
    final pw = _password.text;
    setState(() {
      if (email.contains('@') && pw.isNotEmpty) {
        _status = 'Welcome, ' + email;
      } else {
        _status = 'Invalid credentials';
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Login Demo')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            TextField(
              key: const ValueKey('email-input'),
              controller: _email,
              decoration: const InputDecoration(labelText: 'Email'),
            ),
            const SizedBox(height: 16),
            TextField(
              key: const ValueKey('password-input'),
              controller: _password,
              obscureText: true,
              decoration: const InputDecoration(labelText: 'Password'),
            ),
            const SizedBox(height: 24),
            ElevatedButton(
              key: const ValueKey('login-button'),
              onPressed: _submit,
              child: const Text('Sign in'),
            ),
            const SizedBox(height: 16),
            Text(
              _status,
              key: const ValueKey('login-status'),
              style: const TextStyle(fontSize: 18),
            ),
          ],
        ),
      ),
    );
  }
}
`;

function patchToLogin() {
  copyFileSync(mainDart, mainDartBak);
  writeFileSync(mainDart, LOGIN_MAIN_DART, "utf8");
}
function restore() {
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
function unwrap(r) {
  return JSON.parse(r.content.find((c) => c.type === "text").text);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Read the live `data` of a Text widget identified by its ValueKey, using
 * direct Dart eval to walk the element tree. More reliable than going
 * through the cached inspector summary, which can drop key info on
 * Text-typed leaves.
 */
async function readTextByKey(sid, key) {
  const dart = `(() {
    Element? found;
    void visit(Element e) {
      if (found != null) return;
      final k = e.widget.key;
      if (k is ValueKey && k.value == '${key.replace(/'/g, "\\'")}') { found = e; return; }
      e.visitChildren(visit);
    }
    WidgetsBinding.instance.rootElement?.visitChildren(visit);
    if (found == null) return 'not_found';
    final w = found!.widget;
    if (w is Text) return 'text:' + (w.data ?? '');
    return 'not_text:' + w.runtimeType.toString();
  })()`.replace(/\s+/g, " ");
  const r = unwrap(
    await send("tools/call", {
      name: "rc_flutter_eval",
      arguments: { session_id: sid, expression: dart },
    }),
  );
  const v = r.valueAsString;
  if (!v) return null;
  if (v === "not_found" || v.startsWith("not_text:")) return null;
  const m = v.match(/^text:(.*)$/s);
  return m ? m[1] : null;
}

async function readStatusText(sid) {
  return await readTextByKey(sid, "login-status");
}

async function main() {
  console.log("→ patching main.dart with login form");
  patchToLogin();

  console.log("→ initialize MCP");
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "flutter-login-demo", version: "0.0.1" },
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

  console.log("→ wait for login-button to be mounted");
  await send("tools/call", {
    name: "rc_flutter_wait_for_widget",
    arguments: { session_id: sid, by: "key", value: "login-button", timeout_ms: 15000 },
  });
  await sleep(500);

  // ── Round 1: valid credentials ──
  console.log("\n── Round 1: valid credentials ──");
  console.log("→ enter_text email = developer@moinsen.dev");
  const r1 = unwrap(
    await send("tools/call", {
      name: "rc_flutter_enter_text",
      arguments: {
        session_id: sid,
        by: "key",
        value: "email-input",
        text: "developer@moinsen.dev",
      },
    }),
  );
  console.log(`  ${JSON.stringify(r1)}`);
  if (!r1.success) throw new Error(`email entry failed: ${r1.reason}`);

  console.log("→ enter_text password = s3cret!");
  const r2 = unwrap(
    await send("tools/call", {
      name: "rc_flutter_enter_text",
      arguments: { session_id: sid, by: "key", value: "password-input", text: "s3cret!" },
    }),
  );
  console.log(`  ${JSON.stringify(r2)}`);
  if (!r2.success) throw new Error(`password entry failed: ${r2.reason}`);

  console.log("→ tap login-button");
  const t1 = unwrap(
    await send("tools/call", {
      name: "rc_flutter_tap",
      arguments: { session_id: sid, by: "key", value: "login-button" },
    }),
  );
  console.log(`  ${JSON.stringify(t1)}`);
  if (!t1.success) throw new Error(`login tap failed: ${t1.reason}`);

  await sleep(300);
  let status = await readStatusText(sid);
  console.log(`  status text: ${status}`);
  if (status !== "Welcome, developer@moinsen.dev") {
    throw new Error(`ASSERTION: expected welcome banner, got '${status}'`);
  }
  console.log("  ✅ login succeeded as expected");

  // ── Round 2: bad credentials ──
  console.log("\n── Round 2: clear password + retry ──");
  console.log("→ enter_text password = (clear)");
  const r3 = unwrap(
    await send("tools/call", {
      name: "rc_flutter_enter_text",
      arguments: {
        session_id: sid,
        by: "key",
        value: "password-input",
        text: "",
        mode: "clear",
      },
    }),
  );
  console.log(`  ${JSON.stringify(r3)}`);

  console.log("→ tap login-button again");
  await send("tools/call", {
    name: "rc_flutter_tap",
    arguments: { session_id: sid, by: "key", value: "login-button" },
  });
  // Poll for the status to change — login-page rebuild involves two
  // TextFields, which is heavier than the counter demo's plain Text. Allow
  // up to 3 s for the new value to surface.
  status = null;
  const pollDeadline = Date.now() + 3000;
  while (Date.now() < pollDeadline) {
    await sleep(150);
    status = await readStatusText(sid);
    if (status === "Invalid credentials") break;
  }
  console.log(`  status text: ${status}`);
  if (status !== "Invalid credentials") {
    throw new Error(`ASSERTION: expected invalid-credentials, got '${status}'`);
  }
  console.log("  ✅ failure path triggered as expected");

  // ── Round 3: prove append mode works ──
  console.log("\n── Round 3: append mode ──");
  console.log("→ enter_text email mode=append += '.test'");
  const r4 = unwrap(
    await send("tools/call", {
      name: "rc_flutter_enter_text",
      arguments: {
        session_id: sid,
        by: "key",
        value: "email-input",
        text: ".test",
        mode: "append",
      },
    }),
  );
  console.log(`  new_text=${r4.new_text}`);
  if (r4.new_text !== "developer@moinsen.dev.test") {
    throw new Error(`ASSERTION: append produced '${r4.new_text}'`);
  }
  console.log("  ✅ append concatenated correctly");

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

  console.log("\n=== AGENTIC LOGIN DEMO PASSED ===");
  console.log("Filled 2 TextFields, tapped Submit, verified state text — all");
  console.log("structurally through MCP. No screenshots, no Peekaboo, no keys.");
}

main()
  .then(() => {
    restore();
    child.kill("SIGTERM");
    process.exit(0);
  })
  .catch((err) => {
    restore();
    child.kill("SIGKILL");
    console.error("\n=== AGENTIC LOGIN DEMO FAILED ===");
    console.error(err);
    process.exit(1);
  });

process.on("SIGINT", () => { restore(); process.exit(130); });
process.on("SIGTERM", () => { restore(); process.exit(143); });
