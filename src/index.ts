#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { startHandler, startInputSchema } from "./tools/start.js";
import { sendKeysHandler, sendKeysInputSchema } from "./tools/send_keys.js";
import { readScreenHandler, readScreenInputSchema } from "./tools/read_screen.js";
import { readStreamHandler, readStreamInputSchema } from "./tools/read_stream.js";
import { waitForHandler, waitForInputSchema } from "./tools/wait_for.js";
import { statusHandler, statusInputSchema } from "./tools/status.js";
import { stopHandler, stopInputSchema } from "./tools/stop.js";
import { resizeHandler, resizeInputSchema } from "./tools/resize.js";
import {
  flutterEndpointsHandler,
  flutterEndpointsInputSchema,
} from "./tools/flutter/endpoints.js";
import { flutterConnectHandler, flutterConnectInputSchema } from "./tools/flutter/connect.js";
import {
  flutterDrainErrorsHandler,
  flutterDrainErrorsInputSchema,
} from "./tools/flutter/drain_errors.js";
import {
  flutterDrainLogsHandler,
  flutterDrainLogsInputSchema,
} from "./tools/flutter/drain_logs.js";
import {
  flutterHotReloadHandler,
  flutterHotReloadInputSchema,
} from "./tools/flutter/hot_reload.js";
import { flutterEvalHandler, flutterEvalInputSchema } from "./tools/flutter/eval.js";

const SERVER_NAME = "agentic-rc";
const SERVER_VERSION = "0.7.0";

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // ─── Generic PTY remote control ────────────────────────────────────────
  // Works on ANY interactive local program: flutter run, npm run dev, vite,
  // REPLs, shells, TUIs. Non-invasive — does not require the controlled
  // process to expose anything.

  server.registerTool(
    "rc_start",
    {
      title: "Start a PTY session",
      description:
        "Spawn a command inside a real PTY and return a session_id. The process keeps running across MCP calls until stopped. Use this for any interactive or long-running program: `flutter run`, `npm run dev`, REPLs, shells, etc.",
      inputSchema: startInputSchema,
    },
    startHandler,
  );

  server.registerTool(
    "rc_send_keys",
    {
      title: "Send keystrokes to a session",
      description:
        "Write input to a session's PTY. Supports named tokens like <Enter>, <Tab>, <Esc>, <C-c>, <C-d>, arrow keys, and F-keys. Plain text is sent verbatim. Example: `git status<Enter>` runs the command; `<C-c>` interrupts; `r` triggers Flutter hot-reload.",
      inputSchema: sendKeysInputSchema,
    },
    sendKeysHandler,
  );

  server.registerTool(
    "rc_read_screen",
    {
      title: "Read the rendered screen of a session",
      description:
        "Returns what the user would see on the terminal: the rendered viewport (after ANSI/curses processing). Use mode='scrollback' for the full history, 'tail' for the last N lines. Always prefer this over rc_read_stream for TUIs like Flutter or vim.",
      inputSchema: readScreenInputSchema,
    },
    readScreenHandler,
  );

  server.registerTool(
    "rc_read_stream",
    {
      title: "Read raw byte stream of a session",
      description:
        "Returns raw bytes since a cursor. Use this for log-style apps where you want every line ever written. For TUIs that overwrite the screen (Flutter, vim), use rc_read_screen instead. ANSI escapes are stripped by default.",
      inputSchema: readStreamInputSchema,
    },
    readStreamHandler,
  );

  server.registerTool(
    "rc_wait_for",
    {
      title: "Wait until output matches a pattern",
      description:
        "Block (with timeout) until a pattern appears in the session's screen or stream. Pattern is a literal substring by default, or a regex when written as '/pattern/flags'. Returns the matched text + a snapshot of the screen at match time. Essential for 'wait until ready'.",
      inputSchema: waitForInputSchema,
    },
    waitForHandler,
  );

  server.registerTool(
    "rc_status",
    {
      title: "Get session status",
      description:
        "Returns info about a single session (when session_id is given) or all sessions. Includes pid, status (running/exited/killed), exit_code, started_at, screen size, bytes I/O.",
      inputSchema: statusInputSchema,
    },
    statusHandler,
  );

  server.registerTool(
    "rc_stop",
    {
      title: "Stop a session",
      description:
        "Send a signal to a session (default SIGTERM). If the process doesn't exit within `wait_ms` (default 2 s), escalates to SIGKILL. Set `remove: true` to also drop the session from the registry.",
      inputSchema: stopInputSchema,
    },
    stopHandler,
  );

  server.registerTool(
    "rc_resize",
    {
      title: "Resize a session's PTY",
      description:
        "Change the cols/rows of a running PTY. Some TUIs re-render on SIGWINCH, others ignore it.",
      inputSchema: resizeInputSchema,
    },
    resizeHandler,
  );

  // ─── Flutter / Dart-VM observability (still non-invasive) ──────────────
  // These work on any session whose process exposed a Dart VM Service
  // endpoint (`flutter run`, `dart run --observe`, etc.). They auto-detect
  // the endpoint URL from the session's PTY output and talk JSON-RPC to
  // the VM service over WebSocket — no copy-paste of debug URLs needed,
  // no code changes required in the app.
  //
  // For agentic UI INTERACTION (tap, enter text, swipe, screenshot,
  // widget-tree introspection), use Marionette MCP instead — it requires a
  // tiny app-side binding but in exchange gives real GestureBinding
  // pointer events, hit-test filtering, custom-widget configuration, etc.
  // See https://pub.dev/packages/marionette_mcp.

  server.registerTool(
    "rc_flutter_endpoints",
    {
      title: "Read the Flutter / Dart-VM debug endpoints of a session",
      description:
        "Returns the VM-service WebSocket URL, the VM-service HTTP URL, and the DevTools URL that Flutter prints to its console. Pass `wait_ms` > 0 to block until they appear (useful right after rc_start). No copy-paste of debug URLs needed.",
      inputSchema: flutterEndpointsInputSchema,
    },
    flutterEndpointsHandler,
  );

  server.registerTool(
    "rc_flutter_connect",
    {
      title: "Open a Dart VM Service WebSocket for the session",
      description:
        "Connects to the Dart VM Service, subscribes to Stdout/Stderr/Logging/Extension/Debug streams (so subsequent rc_flutter_drain_errors / rc_flutter_drain_logs calls see events), and caches the connection. Idempotent — calling rc_flutter_hot_reload / rc_flutter_eval triggers this automatically.",
      inputSchema: flutterConnectInputSchema,
    },
    flutterConnectHandler,
  );

  server.registerTool(
    "rc_flutter_drain_errors",
    {
      title: "Drain buffered Flutter error events",
      description:
        "Returns + clears the queue of structured error events observed via the VM-service (Stderr, framework Flutter.Error events, WARNING-level Logging, paused-on-exception Debug events). Use this in any after-action loop instead of grepping the console.",
      inputSchema: flutterDrainErrorsInputSchema,
    },
    flutterDrainErrorsHandler,
  );

  server.registerTool(
    "rc_flutter_drain_logs",
    {
      title: "Drain buffered Flutter log events",
      description:
        "Returns + clears the queue of structured log events (Stdout + Logging streams below WARNING). Lets you inspect app output without scrolling the PTY.",
      inputSchema: flutterDrainLogsInputSchema,
    },
    flutterDrainLogsHandler,
  );

  server.registerTool(
    "rc_flutter_hot_reload",
    {
      title: "Trigger Flutter hot reload (structured result)",
      description:
        "Sends 'r' to the `flutter run` process so Flutter's own pipeline does the kernel recompile, then parses the result. Returns { success, libraries_reloaded, duration_ms } on success or { success:false, reason, console_excerpt } on compile failure. Pair with rc_flutter_drain_errors right after to catch runtime exceptions thrown by the new code.",
      inputSchema: flutterHotReloadInputSchema,
    },
    flutterHotReloadHandler,
  );

  server.registerTool(
    "rc_flutter_eval",
    {
      title: "Evaluate a Dart expression in the running app",
      description:
        "Runs an arbitrary Dart expression in the main isolate. Used for read-only inspection of live state, computing values from in-memory objects, calling debug helpers. Example: '1+1', 'WidgetsBinding.instance.framesEnabled', 'MyApp.someGlobal.toString()'. Surfaces eval_kind + eval_error on failure so compile / runtime errors are diagnosable. For driving UI interactions, use Marionette MCP — eval-based gestures hit the @visibleForTesting wall.",
      inputSchema: flutterEvalInputSchema,
    },
    flutterEvalHandler,
  );

  return server;
}

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe to write to over stdio transport (only stdout carries MCP frames).
  process.stderr.write(`[agentic-rc] MCP server v${SERVER_VERSION} listening on stdio\n`);
}

// Run only when invoked as a CLI (not when imported as a library).
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return entry.endsWith("/index.js") || entry.endsWith("\\index.js") || entry.endsWith("agentic-rc-mcp");
})();

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`[agentic-rc] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
