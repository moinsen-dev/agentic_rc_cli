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
import {
  flutterScreenshotHandler,
  flutterScreenshotInputSchema,
} from "./tools/flutter/screenshot.js";
import {
  flutterWidgetTreeHandler,
  flutterWidgetTreeInputSchema,
} from "./tools/flutter/widget_tree.js";
import {
  flutterWidgetFindHandler,
  flutterWidgetFindInputSchema,
} from "./tools/flutter/widget_find.js";
import {
  flutterWidgetPropertiesHandler,
  flutterWidgetPropertiesInputSchema,
} from "./tools/flutter/widget_properties.js";
import { flutterTapHandler, flutterTapInputSchema } from "./tools/flutter/tap.js";
import {
  flutterWidgetGeometryHandler,
  flutterWidgetGeometryInputSchema,
} from "./tools/flutter/widget_geometry.js";
import {
  flutterWaitForWidgetHandler,
  flutterWaitForWidgetInputSchema,
} from "./tools/flutter/wait_for_widget.js";

const SERVER_NAME = "agentic-rc";
const SERVER_VERSION = "0.4.0";

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
      },
    },
  );

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

  // ─── Flutter-specific tools ────────────────────────────────────────────
  // These work on top of any session whose process exposed a Dart VM Service
  // endpoint (`flutter run`, `dart run --observe`, etc.). They auto-detect
  // the endpoint URL from the session's PTY output, then talk JSON-RPC to
  // the VM service over WebSocket — no manual URL copying required.

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
        "Connects to the Dart VM Service, subscribes to Stdout/Stderr/Logging/Extension/Debug streams (so subsequent rc_flutter_drain_errors / rc_flutter_drain_logs calls see events), and caches the connection. Idempotent — calling rc_flutter_hot_reload / rc_flutter_eval / rc_flutter_screenshot triggers this automatically.",
      inputSchema: flutterConnectInputSchema,
    },
    flutterConnectHandler,
  );

  server.registerTool(
    "rc_flutter_drain_errors",
    {
      title: "Drain buffered Flutter error events",
      description:
        "Returns + clears the queue of structured error events observed via the VM-service (Stderr, framework Flutter.Error events, WARNING-level Logging, paused-on-exception Debug events). Use this in the agent's after-action loop instead of grepping the console.",
      inputSchema: flutterDrainErrorsInputSchema,
    },
    flutterDrainErrorsHandler,
  );

  server.registerTool(
    "rc_flutter_drain_logs",
    {
      title: "Drain buffered Flutter log events",
      description:
        "Returns + clears the queue of structured log events (Stdout + Logging streams below WARNING). Lets the agent inspect app output without scrolling the PTY.",
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
        "Runs an arbitrary Dart expression in the root library scope of the main isolate. Useful for inspecting state, computing values from live objects, calling debug helpers. Example: '1+1', 'WidgetsBinding.instance.framesEnabled', 'MyApp.someGlobal.toString()'.",
      inputSchema: flutterEvalInputSchema,
    },
    flutterEvalHandler,
  );

  server.registerTool(
    "rc_flutter_screenshot",
    {
      title: "Capture a PNG screenshot of the Flutter window",
      description:
        "Captures the rendered Flutter scene via ext.flutter.screenshot. If `save_to` is given, writes the PNG to disk and returns the absolute path; otherwise returns the base64 data inline.",
      inputSchema: flutterScreenshotInputSchema,
    },
    flutterScreenshotHandler,
  );

  server.registerTool(
    "rc_flutter_widget_tree",
    {
      title: "Fetch the Flutter widget tree (summary) as JSON",
      description:
        "Calls ext.flutter.inspector.getRootWidgetSummaryTree and returns the live widget hierarchy as a trimmed JSON tree. Each node has { valueId, description, type, key, source_location, child_count, children }. Use this to understand the UI structure before interacting with it. Pass `refresh: true` after a hot-reload to bust the cache. Default `max_depth: 6` keeps the payload small.",
      inputSchema: flutterWidgetTreeInputSchema,
    },
    flutterWidgetTreeHandler,
  );

  server.registerTool(
    "rc_flutter_widget_find",
    {
      title: "Search the Flutter widget tree",
      description:
        "Finds widgets in the live tree by `key`, `type`, `description`, or `source_contains`. Returns an array of matches with `{valueId, type, description, key, source_location, path}`. Hand the `valueId` to rc_flutter_widget_properties for full attribute readout.",
      inputSchema: flutterWidgetFindInputSchema,
    },
    flutterWidgetFindHandler,
  );

  server.registerTool(
    "rc_flutter_widget_properties",
    {
      title: "Read a Flutter widget's properties",
      description:
        "Calls ext.flutter.inspector.getProperties on a widget id (use rc_flutter_widget_find to obtain one). Returns the widget's diagnostic properties — colour, padding, alignment, text content, etc. — exactly as Flutter DevTools shows them.",
      inputSchema: flutterWidgetPropertiesInputSchema,
    },
    flutterWidgetPropertiesHandler,
  );

  // ─── Agentic interaction (gesture injection) ───────────────────────────
  // These tools inject real pointer events through GestureBinding so the
  // same hit-test path fires that the OS would trigger from a touch. Means
  // a Claude agent can drive the running Flutter app end-to-end without
  // Peekaboo or chrome-devtools-mcp — both of which work poorly with
  // Flutter's custom-rendered canvas.

  server.registerTool(
    "rc_flutter_tap",
    {
      title: "Tap a Flutter widget (real pointer event)",
      description:
        "Injects a PointerDown+PointerUp pair into GestureBinding at the center of a target widget (or at given coordinates). The widget's onPressed / GestureDetector / InkWell fires exactly as if a human tapped — no Peekaboo or external automation needed. Identify via {by:'key', value:'submit-button'} / {by:'type', value:'FloatingActionButton'} / {by:'value_id', value:<from rc_flutter_widget_find>} / {by:'coordinate', x, y}.",
      inputSchema: flutterTapInputSchema,
    },
    flutterTapHandler,
  );

  server.registerTool(
    "rc_flutter_widget_geometry",
    {
      title: "Get the screen rect of a Flutter widget",
      description:
        "Returns {rect:{x,y,width,height}, widget_type} for the matched widget — useful for verifying layout or computing tap coordinates for adjacent widgets. Uses the same key/type/value_id matchers as rc_flutter_tap.",
      inputSchema: flutterWidgetGeometryInputSchema,
    },
    flutterWidgetGeometryHandler,
  );

  server.registerTool(
    "rc_flutter_wait_for_widget",
    {
      title: "Wait until a Flutter widget appears (or disappears)",
      description:
        "Polls the live element tree until a widget matching {by, value} appears (default) or disappears (`appear:false`). Use after navigation, after rc_flutter_tap, after a hot reload — any moment where you'd otherwise sleep blindly. Default timeout 10 s, default poll 200 ms.",
      inputSchema: flutterWaitForWidgetInputSchema,
    },
    flutterWaitForWidgetHandler,
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
