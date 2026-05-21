# agentic-rc-mcp

> **An MCP server that turns an AI agent into an autonomous operator of
> interactive local programs.** Spawn `flutter run`, `npm run dev`, REPLs,
> TUIs — then *drive*, *observe*, *introspect*, and *quit* them through
> structured tool calls. No human in the loop pressing `r`, copy-pasting log
> excerpts, or reading the Dart VM Service URL off the terminal.

[**18 MCP tools**](#tool-reference) · 33 unit tests · 5 live-driven demo scripts ·
Claude Code skill bundled.

---

## The problem

When you tell Claude Code "run my app and verify the new feature works", today
it gets stuck in the same place every time:

1. It spawns the process in the background. ✅
2. It tails the log a few times. ✅
3. The log stops scrolling. **It can't tell if the app is *ready* or
   *deadlocked*.** Asks you.
4. To trigger hot-reload it has to press `r`. **It can't.** Asks you to press
   it and paste what happened.
5. Something crashes. The full exception is somewhere in 5000 lines of scroll.
   **It has to grep, guess where the error block ends, hope it didn't miss
   anything.**
6. The bug is "the counter Text widget doesn't show the right value". The
   agent can't *see* the widget. It can only re-read the source code and
   guess. **It has no introspection.**

`agentic-rc-mcp` removes every one of those blockers.

## What you get — three layers

| Layer | What it does | Why it matters |
|---|---|---|
| **1. PTY control** (8 tools) | Spawn programs in a real pseudo-terminal. Send keys (`<Enter>`, `<Tab>`, `<C-c>`, …). Read the rendered screen — including TUIs like Flutter, vim, top. Wait for patterns with timeout. | The agent can press `r`, see what changed, know when "ready" appeared — exactly like a human at the terminal. |
| **2. Flutter / Dart-VM lifecycle** (7 tools) | Auto-detect the VM-service WebSocket URL from `flutter run`'s output. Open a programmatic connection. Trigger hot-reload with a structured `{success, duration_ms}` result. Subscribe to Stdout / Stderr / Logging / Extension / Debug streams. Evaluate Dart in the live app. Capture screenshots. | No more grep-the-console for `Exception caught` — exceptions arrive as **structured events** with file:line, widget name, stack trace. No copy-pasting Debug URLs. |
| **3. Flutter inspector** (3 tools) | Fetch the live widget tree as JSON with source locations. Search by `Key`, runtime type, description substring, or source file. Read any widget's properties — colour, alignment, text content, callback bindings. | The agent can *see* the UI structurally without a screenshot. "Find the FAB" → `valueId`. "What does the counter Text say?" → `data: "You have pushed the button this many times:"`. |

The three layers compose: at the bottom you can still `rc_send_keys("r")` for
anything; at the top you can `rc_flutter_widget_find({by: "key", value: "submit"})`
and get back an exact widget reference in milliseconds. Same MCP server, one
session ID flowing through all of it.

## Architecture

```
+------------------+   stdio    +────────────────────── agentic-rc-mcp ──────────────────────+
|  Claude Code     | <-------> |                                                              |
|  (MCP client)    |  JSON-RPC |   ┌─ SessionManager ─────────────────────────────────────┐  |
+------------------+           |   │   id → Session                                       │  |
                               |   └──────────┬──────────────────────────────────────────┘  |
                               |              │ owns                                          |
                               |   ┌─ Session ▼─────────────────────────────────────────┐    |
                               |   │                                                    │    |
                               |   │   ┌───── PTY layer ──────┐                          │    |
                               |   │   │  node-pty <══>       │ ──→ child process        │    |
                               |   │   │  @xterm/headless     │     (flutter / vite / …) │    |
                               |   │   │  + raw ring buffer   │                          │    |
                               |   │   └──────────┬───────────┘                          │    |
                               |   │              │ feeds                                 │    |
                               |   │   ┌──── Endpoint sniffer ─────────────────────────┐ │    |
                               |   │   │ regex over PTY output → ws / http / devtools │ │    |
                               |   │   └──────────┬───────────────────────────────────┘ │    |
                               |   │              │ unblocks                               │   |
                               |   │   ┌──── VmServiceClient ──── WS ─────► Dart VM       │   |
                               |   │   │   getVM, evaluate,                                │   |
                               |   │   │   streamListen(Stderr,                            │   |
                               |   │   │   Extension, Debug, …)                            │   |
                               |   │   └──────────┬─────────────────                       │   |
                               |   │              │ wraps                                   │   |
                               |   │   ┌──── FlutterService ────┐  ─── ext.flutter.* ───►   │   |
                               |   │   │  error buffer, logs,    │  ext.flutter.inspector.* │   |
                               |   │   │  hot-reload, eval,      │                          │   |
                               |   │   │  screenshot, inspector  │                          │   |
                               |   │   └─────────────────────────┘                          │   |
                               |   └───────────────────────────────────────────────────────┘   |
                               +───────────────────────────────────────────────────────────────+
```

- **PTY:** real pseudo-terminal via `node-pty`, so the child program thinks
  it's interactive (`isatty(0)==1`).
- **Screen rendering:** `@xterm/headless` runs xterm.js without a DOM,
  applying ANSI/curses sequences and exposing the rendered viewport
  programmatically — so TUIs like Flutter, vim, top render correctly.
- **Endpoint sniffer:** parses every chunk of Flutter output for the four
  forms Flutter prints (Chrome / macOS desktop / iOS / Android each emit
  different strings). When the WS URL isn't printed explicitly it's
  synthesised from the DevTools URL's `?uri=` query param or the HTTP URL.
- **VM-service client:** JSON-RPC 2.0 over WebSocket. Used for everything
  that isn't a keystroke or screen-read.

## Tool reference

### 1. Generic PTY tools (any program)

| Tool | Does |
| --- | --- |
| `rc_start`       | Spawn a command inside a real PTY. Returns `session_id`. |
| `rc_send_keys`   | Write input. Supports `<Enter>`, `<Tab>`, `<Esc>`, `<C-c>`, `<C-d>`, arrows, F-keys, `<M-x>`. Plain text passes through. |
| `rc_read_screen` | Read the **rendered** viewport. Modes: `screen` / `scrollback` / `tail`. |
| `rc_read_stream` | Read raw bytes since a cursor (for log-style apps). |
| `rc_wait_for`    | Block (with timeout) until a pattern appears. Literal substring or `/regex/flags`. |
| `rc_status`      | Status of one or all sessions: pid, state, exit_code, bytes I/O, Flutter endpoints once detected. |
| `rc_stop`        | Terminate a session. SIGTERM → 2 s grace → SIGKILL. |
| `rc_resize`      | Change cols/rows of a running PTY. |

### 2. Flutter / Dart-VM lifecycle tools

| Tool | Does |
| --- | --- |
| `rc_flutter_endpoints`    | Returns sniffed WS / HTTP / DevTools URLs (auto-synthesised on macOS desktop where Flutter omits the WS line). |
| `rc_flutter_connect`      | Opens the VM-service WebSocket + subscribes to Stdout / Stderr / Logging / Extension / Debug. Idempotent. |
| `rc_flutter_drain_errors` | Returns + clears **structured** exception events. Use this instead of grepping the console. |
| `rc_flutter_drain_logs`   | Returns + clears structured log events. |
| `rc_flutter_hot_reload`   | Triggers `r`, parses Flutter's report into `{success, libraries_reloaded, duration_ms}` or `{success:false, reason, console_excerpt}`. |
| `rc_flutter_eval`         | Run arbitrary Dart in the root library scope of the main isolate. |
| `rc_flutter_screenshot`   | PNG via `ext.flutter.screenshot`. Graceful `extension_not_registered` fallback on macOS desktop — pair with Peekaboo for that platform. |

### 3. Flutter inspector tools (agentic UI introspection)

| Tool | Does |
| --- | --- |
| `rc_flutter_widget_tree`       | Fetch live widget hierarchy as JSON. Each node: `{valueId, description, type, key, source_location, children}`. Cache-aware; pass `refresh: true` after a hot reload. |
| `rc_flutter_widget_find`       | Search by `key` / `type` / `description` / `source_contains`. Returns matches with ancestry `path` and `valueId`. |
| `rc_flutter_widget_properties` | Diagnostic properties of any widget by `valueId` — text content, padding, colour, callbacks (incl. closure name!), …. |

## Install

Requires Node ≥ 20.

```bash
git clone <this-repo>
cd agentic_rc_cli
npm install        # postinstall fixes node-pty's spawn-helper perms on macOS
npm run build
npm link            # makes `agentic-rc-mcp` available globally
```

> **Heads-up:** npm 10 occasionally extracts `node-pty`'s `spawn-helper`
> prebuilt binary without the executable bit, which manifests at runtime as
> `posix_spawnp failed`. The included postinstall script
> ([`scripts/fix-node-pty-permissions.js`](scripts/fix-node-pty-permissions.js))
> chmods it back. If you ever see that error after a clean install,
> re-run `npm install`.

## Wire it into Claude Code

Drop `.mcp.json` next to the project you want the agent to drive (or merge
into an existing one):

```json
{
  "mcpServers": {
    "agentic-rc": {
      "command": "agentic-rc-mcp"
    }
  }
}
```

Restart Claude Code. The tools appear as `mcp__agentic-rc__rc_start`,
`mcp__agentic-rc__rc_flutter_widget_find`, etc. See
[`.mcp.json.example`](.mcp.json.example) for variants (direct dist path, dev
mode via `tsx`).

## Install the bundled Claude Code skill

This repo ships a Claude Code skill at
[`.claude/skills/agentic-rc/SKILL.md`](.claude/skills/agentic-rc/SKILL.md)
that teaches Claude **when** to reach for each tool — the canonical Flutter
agentic loop, the inspector pattern, named-key cheat sheet, platform gotchas.

- **Project-local:** the skill is auto-loaded when you open Claude Code in
  this repo's directory.
- **Global:** copy it to your global skills dir so it's available in *every*
  project:

  ```bash
  npm run install:skill
  # → ~/.claude/skills/agentic-rc/SKILL.md
  ```

  Idempotent — re-run after each `git pull`.

## Example: the full agentic loop on a Flutter app

```jsonc
// 1. Spawn the app — same as `flutter run` from the terminal.
rc_start { command: "flutter", args: ["run", "-d", "macos"],
           cwd: "/path/to/my-flutter-app" }
// → { session_id: "8fa45718", pid: 79314 }

// 2. Open the Dart VM Service — endpoints are auto-sniffed from the
//    PTY output, no copy-pasting URLs.
rc_flutter_connect { session_id: "8fa45718", wait_ms: 180000 }
// → { connected: true,
//     ws_url: "ws://127.0.0.1:51658/hSQyXpnxQEo=/ws",
//     main_isolate_id: "isolates/6257046507251003" }

// 3. Edit a Dart file (regular Edit / Write tool — not part of this MCP),
//    then trigger hot reload programmatically.
rc_flutter_hot_reload { session_id: "8fa45718" }
// → { success: true, libraries_reloaded: 1, libraries_total: 753,
//     duration_ms: 135 }

// 4. Did the new code throw? Get every exception as a structured event —
//    no console scraping.
rc_flutter_drain_errors { session_id: "8fa45718" }
// → { count: 1, errors: [
//     { timestamp: "2026-…", stream: "Extension",
//       message: "EXCEPTION CAUGHT BY WIDGETS LIBRARY … main.dart:72:5 …" } ] }

// 5. Introspect the live UI to see what's actually rendered.
rc_flutter_widget_find { session_id: "8fa45718",
                         by: "type", value: "FloatingActionButton" }
// → { count: 1, matches: [
//     { valueId: "inspector-11",
//       path: "[root] > MyApp > … > FloatingActionButton",
//       source_location: "lib/main.dart:115:29" } ] }

// 6. Read the bound callback to confirm wiring.
rc_flutter_widget_properties { session_id: "8fa45718",
                               value_id: "inspector-11" }
// → { properties: [
//     { name: "onPressed",
//       description: "Closure: () => void from Function '_incrementCounter@…'" },
//     { name: "tooltip", description: "\"Increment\"" }, … ] }

// 7. Run arbitrary Dart in the app's context.
rc_flutter_eval { session_id: "8fa45718",
                  expression: "WidgetsBinding.instance.framesEnabled" }
// → { kind: "Instance", valueAsString: "true" }

// 8. Clean shutdown.
rc_send_keys { session_id: "8fa45718", keys: "q" }
//   …or fall back to a signal:
rc_stop { session_id: "8fa45718", wait_ms: 3000, remove: true }
```

That sequence is exactly what
[`scripts/flutter-inspector-demo.mjs`](scripts/flutter-inspector-demo.mjs)
and [`scripts/flutter-vm-agentic-loop.mjs`](scripts/flutter-vm-agentic-loop.mjs)
run as end-to-end smoke tests against the sample
[`flutter_example/`](flutter_example) counter app.

## Named-key cheat sheet (`rc_send_keys`)

| Token                              | Bytes sent           |
| ---------------------------------- | -------------------- |
| `<Enter>` / `<Return>`             | `\r`                 |
| `<Tab>`                            | `\t`                 |
| `<Esc>` / `<Escape>`               | `\x1b`               |
| `<Space>`                          | ` `                  |
| `<Backspace>` / `<BS>`             | `\x7f`               |
| `<Delete>`                         | `\x1b[3~`            |
| `<Up>` `<Down>` `<Left>` `<Right>` | `\x1b[A..D`          |
| `<Home>` / `<End>`                 | `\x1b[H` / `\x1b[F`  |
| `<PageUp>` / `<PageDown>`          | `\x1b[5~` / `\x1b[6~` |
| `<F1>`..`<F12>`                    | xterm sequences       |
| `<C-c>` / `<Ctrl-c>` (any letter)  | `\x03`               |
| `<M-x>` / `<Alt-x>` (any letter)   | `\x1b` + `x`         |

Plain characters pass through verbatim. Set `"raw": true` to skip the parser
and send literal `<` / `>`.

## When to use which read tool

- **`rc_read_screen` with `mode: "screen"`** — for any TUI that redraws
  (Flutter, vim, top, `npm run dev` with spinners). You get what the user
  would *see* on the terminal right now.
- **`rc_read_screen` with `mode: "scrollback"` or `"tail"`** — for the
  history of what was rendered, post-curses processing. Best for log lines
  that scrolled off the viewport.
- **`rc_read_stream`** — for pure log-style apps (no cursor tricks) where
  you want every byte in order, with a cursor for incremental reads.
- **`rc_flutter_drain_errors`** — once a session has VM-service errors going
  this is **always preferred over PTY grepping**. You get structured events
  with stream origin, timestamp, message, and the raw VM-service payload.

## Develop

```bash
npm test               # vitest — 33 tests (keys, sessions, endpoints, inspector)
npm run typecheck      # strict tsc --noEmit
npm run build          # emit dist/

# Live end-to-end demo scripts (each drives a fresh MCP server over stdio):
npm run smoke                                # 8 generic PTY tools
node scripts/flutter-drive.mjs               # spawn flutter, hot-reload, quit
node scripts/flutter-error-detect.mjs        # detect runtime exceptions via PTY
node scripts/flutter-vm-agentic-loop.mjs     # full structured loop via VM service
node scripts/flutter-inspector-demo.mjs      # widget-tree + find + properties
```

## What this is not (yet)

- **Not network-remote.** Stdio only — MCP client and controlled processes
  run on the same machine. (Architecture is ready for it; just no transport
  written.)
- **Not multi-user.** Single process, single session registry, no auth.
- **No persistence.** Killing the MCP server kills every child it started.
- **No pixel taps inside the running app window.** This MCP sends *keystrokes
  to the PTY*, not pointer events to the GUI. For real clicks inside the
  Flutter / Electron / browser window, pair with
  [Peekaboo](https://github.com/steipete/Peekaboo) or
  [`chrome-devtools-mcp`](https://github.com/cnove/chrome-devtools-mcp) —
  then drain errors via this MCP to see what your tap broke.
- **No Windows yet.** node-pty supports ConPTY; untested with this code.

## License

MIT — see [LICENSE](LICENSE).
