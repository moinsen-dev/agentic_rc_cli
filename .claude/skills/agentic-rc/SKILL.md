---
name: agentic-rc
description: Drive long-running interactive local processes (Flutter, dev servers, REPLs, TUIs) through the agentic-rc-mcp server. Use whenever the user asks you to start an app and verify behaviour, when you see `flutter run` / `npm run dev` / `dart run` / interactive shells in the user's request, or when Claude would otherwise be stuck waiting for a human to press a key in the terminal. Especially powerful with Flutter — auto-discovers the Dart VM Service endpoint, exposes structured error / log streams, programmatic hot-reload, Dart expression evaluation, and PNG screenshots without copy-pasting any debug URL.
---

# agentic-rc — autonomous remote control of local processes

This skill teaches you how to drive the `agentic-rc-mcp` MCP server (tool prefix
`mcp__agentic-rc__rc_*`). It exists for one purpose: **eliminate the
human-in-the-loop** when running interactive local programs.

## When to reach for it

- The user wants you to start and verify a long-running thing
  (`flutter run`, `npm run dev`, `vite`, `dart run`, `python manage.py runserver`).
- You're about to suggest "now please press X and tell me what you see" — stop,
  use this skill instead.
- The user mentions hot-reload, debug-service URL, DevTools, Dart VM Service,
  exceptions in a running app, or a button press they want you to simulate
  (caveat: keystrokes only — pixel taps still need Peekaboo / chrome-devtools).
- The user pastes a `flutter run` log snippet at you (the ws://… / http://…
  URLs are the giveaway).

## Tool map

### Generic (any program in a PTY)

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

### Flutter / Dart-VM-specific

| Tool | Purpose |
| --- | --- |
| `rc_flutter_endpoints` | Returns the VM-service WS URL, HTTP URL, DevTools URL (auto-sniffed from the PTY output). Pass `wait_ms` > 0 to block until they appear. |
| `rc_flutter_connect` | Opens a WebSocket to the Dart VM Service and subscribes to Stdout/Stderr/Logging/Extension/Debug streams. Idempotent. (Most other Flutter tools auto-call this on first use, so you rarely need it explicitly.) |
| `rc_flutter_drain_errors` | Returns + clears buffered **structured** error events. **Use this instead of grepping the console for `Exception caught`.** |
| `rc_flutter_drain_logs` | Returns + clears buffered structured log events (Stdout + Logging stream below WARNING). |
| `rc_flutter_hot_reload` | Programmatic hot reload via the VM service. Returns `{success, notices}`. No need to send `r` and grep for "Reloaded". |
| `rc_flutter_eval` | Run arbitrary Dart in the root library scope of the main isolate. |
| `rc_flutter_screenshot` | Captures a PNG via `ext.flutter.screenshot`. With `save_to`, writes to disk. Returns `{success:false, reason:"extension_not_registered"}` on macOS desktop — fall back to Peekaboo. |
| `rc_flutter_widget_tree` | Fetch the live widget tree as JSON (summary). Each node carries `{valueId, description, type, key, source_location, children}`. Cache-aware; pass `refresh: true` after a hot-reload. |
| `rc_flutter_widget_find` | Search the live tree by `key`, `type`, `description` substring, or `source_contains`. Returns matches with ancestry `path` and `valueId`. |
| `rc_flutter_widget_properties` | Read a widget's diagnostic properties (text content, padding, callbacks, colours, …) by its `valueId` from `_find` / `_tree`. |
| `rc_flutter_tap` | **Tap a widget.** Identifies via `key`/`type`/`value_id` and calls the widget's `onPressed`/`onTap` closure directly (FAB, ElevatedButton, GestureDetector, InkWell, ListTile, …). Walks ancestors if the matched widget itself isn't tappable. |
| `rc_flutter_widget_geometry` | Returns `{rect:{x,y,width,height}, widget_type}` of the matched widget — useful for verifying layout or computing tap coordinates for nearby widgets. |
| `rc_flutter_wait_for_widget` | Block (with timeout) until a widget matching `{by, value}` appears (or disappears with `appear:false`). Use after navigation, after tap, after hot-reload — any moment you'd otherwise sleep blindly. |

## The canonical Flutter agent loop

This is the pattern to apply when the user says "run my Flutter app and check
that X works":

```text
1. rc_start: { command: "flutter", args: ["run", "-d", "macos"], cwd: <project> }
   → save session_id

2. rc_flutter_connect: { session_id, wait_ms: 180000 }
   → blocks until VM service is up + subscribes to error streams

3. (optional) rc_flutter_eval: { session_id, expression: "1+1" }
   → smoke-test the VM service is talking

4. perform action:
   • make a code change                       (Edit / Write)
   • rc_flutter_hot_reload: { session_id }
   • OR rc_send_keys: { session_id, keys: "r" }  (fallback when no VM service)

5. rc_flutter_drain_errors: { session_id }
   → returns [] when clean; otherwise a list of {timestamp, stream, message}.
     A non-empty list ALWAYS means the change broke something — fix and goto 4.

6. (optional) rc_flutter_screenshot: { session_id, save_to: "/tmp/after.png" }
   → for visual verification; otherwise drain_errors is your gate.

7. rc_send_keys: { session_id, keys: "q" }   → graceful quit
   OR rc_stop: { session_id, wait_ms: 5000, remove: true }
```

The key insight is **step 5**. Before this MCP existed you had to:
- send `r` over the terminal
- wait for `Reloaded` to appear in scrollback
- regex-grep for `Exception caught by widgets library` in tail / scrollback
- hope you didn't miss anything between buffer windows

Now: `rc_flutter_drain_errors` returns a fully-structured array of exception
events the moment they occur, with stream origin (Stderr / Extension / Debug
/ Logging) and the raw VM-service event payload available for deep
inspection.

## Agentic UI introspection — the inspector loop

When the user asks something about the **structure of the running UI** ("is
there a button with key X?", "what's the current value of the counter?",
"why does the Submit button look disabled?"), use the inspector tools instead
of guessing from code or sending pointless keystrokes:

```text
1. rc_flutter_widget_tree { session_id, max_depth: 8 }
   → returns JSON of the live UI hierarchy with source_locations.

2. rc_flutter_widget_find { session_id, by: "type", value: "FloatingActionButton" }
   → finds the widget. Read the `valueId` and `path`.

3. rc_flutter_widget_properties { session_id, value_id: <from step 2> }
   → returns the widget's diagnostic properties.
     For a Text  : the `data` property is the live displayed string.
     For a Button: the `onPressed` shows the bound callback function ref.
     For a Container: backgroundColor, padding, alignment, child …

4. (after a hot-reload that may have changed structure)
   rc_flutter_widget_tree { session_id, refresh: true }
   → invalidates the cache so subsequent `find` sees the new tree.
```

Key search modes for `rc_flutter_widget_find`:

- `by: "key"` — widgets with `Key('login-button')`. Works against the literal
  string inside the `Key(...)` constructor.
- `by: "type"` — exact runtime type. Best when you know what kind of widget
  you're looking for.
- `by: "description"` — case-insensitive substring of the diagnostic
  description (good when you don't know the exact class).
- `by: "source_contains"` — match anywhere in the `file:line:col` source
  location string. Use this to find "the widget defined around lib/foo.dart:42".

## Agentic interaction loop — tap and verify behaviour

This is the **endgame** of agentic testing: the agent presses a button and
verifies the resulting state change — entirely through MCP, without Peekaboo
or chrome-devtools-mcp (which both work poorly against Flutter's
custom-rendered canvas).

```text
1. (optional) rc_flutter_widget_geometry { session_id, by: "type",
                                           value: "FloatingActionButton" }
   → confirm the widget is actually laid out + visible (rect is non-zero).

2. rc_flutter_tap { session_id, by: "type", value: "FloatingActionButton" }
   → returns { success: true, callback: "FloatingActionButton.onPressed" }
     We invoke the widget's own `onPressed` closure directly. setState fires,
     framework rebuilds.

3. wait ~300 ms for the rebuild (Flutter's microtask + frame cycle).

4. rc_flutter_widget_find { session_id, by: "type", value: "Text",
                            refresh: true }   ← refresh after rebuild
   → re-locate the relevant Text node.

5. rc_flutter_widget_properties { session_id, value_id: <from step 4> }
   → read the `data` property.   ASSERT it matches the expected new state.

6. (after the whole sequence) rc_flutter_drain_errors → must be empty.
```

This loop is the verified pattern in
[`scripts/flutter-tap-demo.mjs`](../../scripts/flutter-tap-demo.mjs):
7 synthetic taps on the counter app's FAB, each verified by reading the
counter Text's `data` property — 0 → 7 with no human and no GUI access.

### Why tap calls onPressed directly (and not synthetic pointer events)

The natural reflex is to dispatch `PointerDownEvent` + `PointerUpEvent` via
`WidgetsBinding.handlePointerEvent`. That **does not work** because
`handlePointerEvent` is annotated `@visibleForTesting` and the Dart VM
service's `evaluate` RPC refuses to compile expressions that reference
test-only APIs (error code 113). We discovered this empirically — see
`scripts/eval-debug.mjs` for the bisection.

Workaround: walk the element tree to the nearest interactive widget and
**invoke its callback directly**. Semantically identical (setState fires,
framework rebuilds, side effects run); only difference is no ripple
animation and no GestureRecognizer state-machine transition. For
behavioural verification that's perfect; for animation verification it's
not — but in practice we never verify ripples agentically anyway.

Supported tappable widget types (covered by ancestor-walking):
FloatingActionButton, ElevatedButton, TextButton, OutlinedButton,
FilledButton, IconButton, GestureDetector, InkWell, InkResponse, ListTile.

### Why expressions are single-line

Another empirical finding: the Dart VM service's `evaluate` RPC rejects
multi-line expression strings with "Expression compilation error" (code
113). The internal `gesture_dart.ts` builder writes templates with
newlines for readability, then collapses to one line before sending.

## When NOT to use this skill

- **Pure read-only file inspection** — just read the file.
- **One-off shell commands** that print and exit fast (`ls`, `git status`,
  `cat`). Bash tool is leaner.
- **Pixel taps inside the running app window** — `agentic-rc` only sends
  keystrokes to the PTY, not pointer events to the GUI. Use Peekaboo or
  `chrome-devtools-mcp` for those, then drain errors via `agentic-rc` to see
  what the tap broke.
- **CI / non-interactive flows** — when there's no need for hot-reload or
  to send keys, plain `Bash` with `run_in_background` is enough.

## Important defaults & quirks

- `rc_wait_for` defaults to matching against the **rendered screen** (TUI-safe).
  For long log streams use `source: "stream"`.
- `rc_send_keys` parses `<Enter>` etc. by default. Set `raw: true` for verbatim.
- `rc_stop` defaults to SIGTERM with a 2 s grace. Interactive shells often
  ignore SIGTERM — the escalation to SIGKILL is automatic.
- Endpoint detection is best-effort regex over the PTY output. If Flutter
  redirects stdout into a file or runs with `--quiet`, sniffing won't work
  and you must pass the WS URL manually via the underlying VmServiceClient
  (not currently exposed as a tool — open an issue if you need it).
- Sessions are tied to the MCP server process — if Claude Code restarts,
  all `agentic-rc` sessions are killed (clean exit, no zombies).

## Examples

### Spin up Flutter, hot-reload after a code change, verify clean

```jsonc
rc_start { command: "flutter", args: ["run", "-d", "macos"],
           cwd: "/Users/me/proj/flutter_app" }
// → { session_id: "abc12345", pid: 9876 }

rc_flutter_connect { session_id: "abc12345", wait_ms: 180000 }
// → { connected: true, ws_url: "ws://127.0.0.1:50349/.../ws",
//     main_isolateId: "isolates/123" }

// … edit lib/main.dart in the editor …

rc_flutter_hot_reload { session_id: "abc12345" }
// → { success: true, notices: [] }

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

### Inspect the live widget tree

```jsonc
rc_flutter_widget_tree { session_id: "abc12345", max_depth: 8 }
// → { tree: { description: "MyApp", children: [
//      { description: "MaterialApp", children: [
//        { description: "MyHomePage", source_location: "lib/main.dart:33:19",
//          children: [ { description: "Scaffold", … } ] } ] } ] } }

rc_flutter_widget_find { session_id: "abc12345",
                         by: "type", value: "FloatingActionButton" }
// → { count: 1, matches: [
//     { valueId: "inspector-11",
//       path: "[root] > MyApp > … > FloatingActionButton",
//       source_location: "lib/main.dart:115:29" } ] }

rc_flutter_widget_properties { session_id: "abc12345",
                               value_id: "inspector-11" }
// → { count: 22, properties: [
//     { name: "tooltip", description: "\"Increment\"" },
//     { name: "onPressed",
//       description: "Closure: () => void from Function '_incrementCounter@…'" },
//     … ] }
```

### Inspect live state via Dart eval

```jsonc
rc_flutter_eval { session_id: "abc12345",
                  expression: "WidgetsBinding.instance.framesEnabled" }
// → { kind: "Instance", valueAsString: "true", raw: {…} }
```

### Take a screenshot for visual diff

```jsonc
rc_flutter_screenshot { session_id: "abc12345",
                        save_to: "/tmp/agentic/after-fix.png" }
// → { format: "png", saved_to: "/tmp/agentic/after-fix.png",
//     base64_bytes: 0, base64: null }
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

… and restart Claude Code.
