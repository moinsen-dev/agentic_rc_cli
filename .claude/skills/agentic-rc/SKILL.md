---
name: agentic-rc
description: Non-invasive remote control + structured observability for long-running interactive local processes through the agentic-rc-mcp server. Use whenever the user asks you to start a `flutter run` / `npm run dev` / `dart run` / REPL / TUI and you need to drive it (send keys, read screen, wait for patterns) or observe it (capture Flutter exceptions as structured events, drain logs, auto-discover the Dart VM Service URL, programmatic hot-reload, read-only Dart eval). Does NOT do agentic UI testing (tap, scroll, text input, screenshots) — for that, use Marionette MCP (https://pub.dev/packages/marionette_mcp) which runs inside the app with a tiny binding. The two MCPs complement each other and coexist in one .mcp.json.
---

# agentic-rc — non-invasive remote control + observability

This skill teaches you how to drive the `agentic-rc-mcp` MCP server (tool
prefix `mcp__agentic-rc__rc_*`). The server is **deliberately scoped**:

- ✅ **Remote control** of any interactive program through PTY + keystrokes.
- ✅ **Observability** of Flutter / Dart-VM processes: structured error and
  log streams, auto-detected debug URLs, programmatic hot-reload,
  read-only eval against the live app.
- ❌ **Not** agentic UI testing. v0.6 had taps / gestures / text input /
  screenshots; v0.7 removed them — Marionette MCP does that job better
  because it runs INSIDE the app.

## When to reach for THIS skill

- The user wants to start and monitor a long-running interactive thing
  (`flutter run`, `npm run dev`, `vite`, `dart run`, `python manage.py
  runserver`, a REPL, a shell).
- You're about to suggest "now please press X and tell me what you see" —
  stop, use this skill instead.
- The user mentions hot-reload, debug-service URL, DevTools, Dart VM
  Service, or Flutter exceptions they want captured systematically.
- The user pastes a `flutter run` log snippet at you (the ws://… / http://…
  URLs are the giveaway).

## When to use Marionette MCP instead (and explain why to the user)

- "Tap the Sign In button"
- "Enter 'foo@bar.com' in the email field"
- "Scroll down to the next section"
- "Take a screenshot of the home page"
- "Find all the buttons currently on screen"
- "Verify the counter Text shows '7' after I tap the FAB"

These are **UI interactions**. Marionette has them as `tap`, `enter_text`,
`scroll_to`, `swipe`, `take_screenshots`, `get_interactive_elements`. It
needs a 5-line setup on the user's side (add `marionette_flutter` dev-dep,
call `MarionetteBinding.ensureInitialized()` in `main`) but in exchange
you get real `GestureBinding.handlePointerEvent` dispatches, hit-test
filtering, custom-widget configuration, multi-touch. Don't try to recreate
those in `agentic-rc` — there isn't a clean path through eval (see
[`docs/learnings/vm-service-eval-quirks.md`](../../docs/learnings/vm-service-eval-quirks.md)
constraints 2 + 3).

## Tool map

### Generic PTY control (any program)

| Tool | Purpose |
| --- | --- |
| `rc_start` | Spawn a command in a real PTY. Returns `session_id`. |
| `rc_send_keys` | Send keystrokes. Supports `<Enter>`, `<Tab>`, `<Esc>`, `<C-c>`, `<C-d>`, arrows, F-keys, `<M-x>`. Plain text passes through. |
| `rc_read_screen` | Read the **rendered** viewport (modes: `screen` / `scrollback` / `tail`). Use for TUIs (Flutter, vim, top). |
| `rc_read_stream` | Read raw bytes since a cursor. Use for log-style apps. |
| `rc_wait_for` | Block (with timeout) until a pattern appears. Literal substring or `/regex/flags`. |
| `rc_status` | Inspect one session or list all. Includes a `flutter:` field once endpoints are detected. |
| `rc_stop` | Signal a session (SIGTERM → 2 s grace → SIGKILL). |
| `rc_resize` | Change PTY cols/rows. |

### Flutter / Dart-VM observability

| Tool | Purpose |
| --- | --- |
| `rc_flutter_endpoints` | Returns the VM-service WS URL, HTTP URL, DevTools URL (auto-sniffed from PTY output). Pass `wait_ms` > 0 to block until they appear. Synthesises the WS URL when Flutter omits it (macOS desktop, iOS Simulator). |
| `rc_flutter_connect` | Opens the VM-service WebSocket + subscribes to Stdout/Stderr/Logging/Extension/Debug. Idempotent. Probes for a library scope where `Element` resolves (handles Flutter Web's `web_entrypoint.dart` quirk transparently). |
| `rc_flutter_drain_errors` | Returns + clears buffered **structured** error events. **Use this instead of grepping the console for `Exception caught`.** |
| `rc_flutter_drain_logs` | Returns + clears buffered structured log events (Stdout + Logging stream below WARNING). |
| `rc_flutter_hot_reload` | Sends `r` to flutter_tools and parses the report. Returns `{success, libraries_reloaded, duration_ms}` or `{success:false, reason, console_excerpt}`. |
| `rc_flutter_eval` | Read-only Dart expression eval against the live app. Surfaces `eval_kind` + `eval_error` on failure. For UI driving, use Marionette MCP. |

## The canonical remote-control loop

This is the pattern when the user says "run my Flutter app and watch for
errors after I make a code change":

```text
1. rc_start: { command: "flutter", args: ["run", "-d", "macos"], cwd: <project> }
   → save session_id

2. rc_flutter_connect: { session_id, wait_ms: 180000 }
   → blocks until VM service is up + subscribes to error / log streams

3. (user / you edits source files normally)

4. rc_flutter_hot_reload: { session_id }
   → { success: true, libraries_reloaded: 1, duration_ms: 135 }
   → if success:false, read console_excerpt for the compile error

5. rc_flutter_drain_errors: { session_id }
   → returns [] when clean
   → otherwise structured array of {timestamp, stream, message}; each
     entry includes file:line where available. A non-empty list ALWAYS
     means the change broke something — surface it, decide next action.

6. (optional) rc_flutter_drain_logs: { session_id }
   → app's print() output + Logging records below WARNING

7. rc_send_keys: { session_id, keys: "q" }   → graceful quit
   OR rc_stop: { session_id, wait_ms: 5000, remove: true }
```

The key insight is **step 5**. Without this MCP you'd:
- send `r` over the terminal
- wait for `Reloaded` to appear in scrollback
- regex-grep for `Exception caught by widgets library` in tail / scrollback
- hope you didn't miss anything between buffer windows

With it: a fully-structured array of exception events the moment they
occur — stream origin (Stderr / Extension / Debug / Logging), timestamp,
message, plus the raw VM-service event payload for deep inspection.

## Pairing with Marionette MCP

The two are designed to coexist:

```jsonc
{
  "mcpServers": {
    "agentic-rc": { "command": "agentic-rc-mcp" },
    "marionette": { "command": "dart", "args": ["pub", "global", "run", "marionette_mcp"] }
  }
}
```

Typical hybrid loop:

1. **agentic-rc** spawns `flutter run`, captures the VM-service URL.
2. **marionette** connects to that URL (paste it from
   `rc_flutter_endpoints` output), drives the UI (tap, enter text, etc.).
3. **agentic-rc** drains structured errors during / after the UI
   interactions — Marionette doesn't have a structured error stream that
   covers framework-level Flutter.Error events the way our VM-service
   subscription does.
4. **agentic-rc** does the clean shutdown via `rc_stop` or `rc_send_keys "q"`.

## Tool quirks (read on demand)

- `rc_wait_for` defaults to matching against the **rendered screen**
  (TUI-safe). For long log streams use `source: "stream"`.
- `rc_send_keys` parses `<Enter>` etc. by default. Set `raw: true` for
  verbatim — useful if you literally need to send the characters `<` `>`.
- `rc_stop` defaults to SIGTERM with a 2 s grace. Interactive shells often
  ignore SIGTERM — the escalation to SIGKILL is automatic.
- `rc_flutter_endpoints` sniffing is best-effort regex over PTY output.
  If Flutter redirects stdout into a file or runs with `--quiet`, sniffing
  won't work and the user must pass the WS URL manually.
- Sessions are tied to the MCP-server process. If Claude Code restarts,
  all `agentic-rc` sessions are killed (clean exit, no zombies).
- `rc_flutter_eval` is **read-only by convention** — mutating state via
  eval can race the framework's build cycle and trigger "setState during
  build". Inspection only.

## When NOT to use THIS skill

- **Driving the UI of a Flutter app** (tap, type, scroll, screenshot) →
  Marionette MCP. We deliberately don't ship those tools.
- **Pure read-only file inspection** — just read the file.
- **One-off shell commands** that print and exit fast (`ls`, `git status`,
  `cat`) — Bash tool is leaner.
- **Pixel taps in non-Flutter GUIs** (Electron, native Cocoa, browser) —
  Peekaboo or `chrome-devtools-mcp`.
- **CI / non-interactive flows** — when there's no need for hot-reload or
  to send keys, plain `Bash` with `run_in_background` is enough.

## Examples

### Spin up Flutter, watch for errors after a code change

```jsonc
rc_start { command: "flutter", args: ["run", "-d", "macos"],
           cwd: "/Users/me/proj/flutter_app" }
// → { session_id: "abc12345", pid: 9876 }

rc_flutter_connect { session_id: "abc12345", wait_ms: 180000 }
// → { connected: true,
//     ws_url: "ws://127.0.0.1:50349/.../ws",
//     main_isolate_id: "isolates/123",
//     eval_target_lib: "<rootLib>" }

// … edit lib/main.dart in the editor …

rc_flutter_hot_reload { session_id: "abc12345" }
// → { success: true, libraries_reloaded: 1, duration_ms: 142 }

rc_flutter_drain_errors { session_id: "abc12345" }
// → { count: 0, errors: [] }   ✅ clean reload
```

### Detect a runtime exception structurally

```jsonc
// after a hot reload that breaks build()
rc_flutter_drain_errors { session_id: "abc12345" }
// → { count: 1, errors: [
//     { timestamp: "2026-…", stream: "Extension",
//       message: "Exception: NoSuchMethodError on null at lib/main.dart:72:5" }
//   ] }
```

### Inspect live state via Dart eval (read-only)

```jsonc
rc_flutter_eval { session_id: "abc12345",
                  expression: "WidgetsBinding.instance.framesEnabled" }
// → { kind: "Instance", valueAsString: "true",
//     eval_target_lib: "<rootLib>" }

rc_flutter_eval { session_id: "abc12345",
                  expression: "MyApp.someGlobal.toString()" }
// → { kind: "Instance", valueAsString: "<expected string>" }
```

If you see `eval_kind: "@Error"`, read `eval_error` for the Dart
compile / runtime error. The library-probe in `rc_flutter_connect`
should have already picked a scope where framework types resolve; if
your expression references user-app symbols only visible in
`main.dart`, those may not resolve from a fallback scope — pass the
fully qualified library prefix or use Marionette for in-app calls.

### Drive a non-Flutter dev server

```jsonc
rc_start { command: "npm", args: ["run", "dev"], cwd: "/path/to/web-app" }
rc_wait_for { session_id: "…", pattern: "/Local:.*localhost:5173/" }
// vite is ready

// Make a change to your code...

rc_read_screen { session_id: "…", mode: "tail", tail_lines: 30 }
// → shows the HMR update lines and any compile errors
```

## Installation reminder (only if the user asks)

```bash
cd /path/to/agentic_rc_cli
npm install      # postinstall fixes node-pty spawn-helper exec bit
npm run build
npm link         # bin = `agentic-rc-mcp`
```

Then in the target project's root, drop `.mcp.json`:

```json
{ "mcpServers": { "agentic-rc": { "command": "agentic-rc-mcp" } } }
```

… and restart Claude Code. For Flutter UI interaction, add Marionette
MCP alongside — they're complements, not alternatives.
