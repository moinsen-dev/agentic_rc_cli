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

const SERVER_NAME = "agentic-rc";
const SERVER_VERSION = "0.1.0";

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
