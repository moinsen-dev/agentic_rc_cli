# agentic-rc-mcp

> **An MCP server for non-invasive remote control + structured observability
> of long-running interactive local processes.** Spawn `flutter run`,
> `npm run dev`, REPLs, TUIs — drive them with keystrokes, read the rendered
> screen, wait for patterns, capture errors and logs as **structured events**.
> No human in the loop pressing `r` or copy-pasting log excerpts.
> No code changes required in the controlled program.

[**14 MCP tools**](#tool-reference) · 25 unit tests · 3 live-driven demo scripts ·
Claude Code skill bundled · v0.7.0 focused on its strengths.

---

## The strict scope of this tool

`agentic-rc-mcp` is **not** an agentic UI testing framework. We tried in
v0.6 — gestures, widget tree introspection, text input, screenshots —
and concluded that **[Marionette MCP](https://pub.dev/packages/marionette_mcp)
does that job better** because it runs INSIDE the Flutter app with a tiny
binding and gets the framework's real `GestureBinding`, hit-test pipeline,
custom-widget configuration, and multi-touch. We removed our gesture /
inspector / text-input tools in v0.7 to stay focused on what's genuinely
ours.

| If you need… | Use… |
|---|---|
| **Tap / scroll / text input / screenshots in a running Flutter app** | [Marionette MCP](https://pub.dev/packages/marionette_mcp) (requires `marionette_flutter` package + one binding line in `main.dart`) |
| **Drive any interactive CLI process (start, send keys, read screen, wait, stop)** | This tool ✓ |
| **Capture Flutter / Dart exceptions as structured events instead of grepping** | This tool ✓ |
| **Auto-discover the Dart VM Service URL from `flutter run`** | This tool ✓ |
| **Hot-reload Flutter and get a typed `{success, libraries_reloaded, duration_ms}` result** | This tool ✓ |
| **Read-only Dart expression eval against the live app** | This tool ✓ |
| **Pixel-level clicks in non-Flutter GUIs (Electron, native Cocoa, browser)** | [Peekaboo](https://github.com/steipete/Peekaboo) or [`chrome-devtools-mcp`](https://github.com/cnove/chrome-devtools-mcp) |

## The problem we DO solve

When you tell Claude Code "run my app and watch for errors", today
without help it gets stuck:

1. It spawns the process in the background. ✅
2. It tails the log a few times. ✅
3. The log stops scrolling. **It can't tell if the app is *ready* or
   *deadlocked*.**
4. To trigger a quit / hot-reload it has to press `q` / `r` in the
   terminal. **It can't.**
5. Something crashes. The full exception is somewhere in 5000 lines of
   scroll. **It has to grep, guess where the error block ends, hope it
   didn't miss anything.**
6. The Dart VM Service URL is buried in the output. **It has to read it
   manually and paste it.**

`agentic-rc-mcp` removes every one of those blockers — for **any**
interactive program, without requiring any modification to that program.

## What you get — two layers

| Layer | What it does | Tools |
|---|---|---|
| **1. PTY remote control** | Spawn programs in a real pseudo-terminal. Send keys (`<Enter>`, `<Tab>`, `<C-c>`, …). Read the rendered screen — including TUIs like Flutter, vim, top. Wait for patterns with timeout. Resize PTY. Clean shutdown via signals. | 8 |
| **2. Flutter / Dart-VM observability** | Auto-detect the VM-service WebSocket URL from `flutter run`'s output. Open a programmatic connection. Subscribe to Stdout / Stderr / Logging / Extension / Debug streams — exceptions arrive as **structured events**. Trigger hot-reload with a typed result. Read-only eval Dart in the live app. | 6 |

Both layers are non-invasive: the controlled program doesn't have to do
anything special to be driven. Spawn it the way you'd spawn it from a
terminal, and the MCP server takes it from there.

## Architecture

```
+------------------+   stdio    +───────── agentic-rc-mcp ──────────────+
|  Claude Code     | <-------> |                                         |
|  (MCP client)    |  JSON-RPC |   ┌─ SessionManager ─────────────────┐ |
+------------------+           |   │   id → Session                   │ |
                               |   └──────────┬──────────────────────┘ |
                               |              │ owns                    |
                               |   ┌─ Session ▼────────────────────────┐|
                               |   │  ┌─── PTY layer ───┐               │|
                               |   │  │ node-pty <══>   │ ──→ child     │|
                               |   │  │ @xterm/headless │   process     │|
                               |   │  │ + raw ring buf  │   (flutter,   │|
                               |   │  └────────┬────────┘   vite, …)    │|
                               |   │           │ feeds                   │|
                               |   │  ┌── Endpoint sniffer ──────────┐  │|
                               |   │  │ regex over PTY output →      │  │|
                               |   │  │ ws / http / devtools URL     │  │|
                               |   │  └──────────┬───────────────────┘  │|
                               |   │             │ unblocks              │|
                               |   │  ┌── VmServiceClient ── WS ──► Dart VM
                               |   │  │  getVM, evaluate (read-only), │  │|
                               |   │  │  streamListen(Stderr,         │  │|
                               |   │  │  Extension, Debug, Logging)   │  │|
                               |   │  └──────────┬────────────────────┘ │|
                               |   │             │ wraps                  │|
                               |   │  ┌── FlutterService ──────────────┐ │|
                               |   │  │  error/log ring buffers,        │ │|
                               |   │  │  hot-reload, eval, library      │ │|
                               |   │  │  probe for eval scope          │ │|
                               |   │  └────────────────────────────────┘ │|
                               |   └────────────────────────────────────┘|
                               +────────────────────────────────────────+
```

- **PTY:** real pseudo-terminal via `node-pty`, so the child program thinks
  it's interactive (`isatty(0)==1`).
- **Screen rendering:** `@xterm/headless` runs xterm.js without a DOM,
  applying ANSI/curses sequences and exposing the rendered viewport — so
  TUIs like Flutter, vim, top render correctly.
- **Endpoint sniffer:** parses PTY output for the four URL forms Flutter
  emits per device (Chrome / macOS / iOS / Android). When the WS URL isn't
  printed explicitly it's synthesised from the DevTools URL's `?uri=`
  query param or the HTTP URL.
- **VM-service client:** JSON-RPC 2.0 over WebSocket. Read-only eval +
  stream subscriptions only. For agentic UI interaction use Marionette
  MCP instead.

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

### 2. Flutter / Dart-VM observability tools

| Tool | Does |
| --- | --- |
| `rc_flutter_endpoints`    | Returns sniffed WS / HTTP / DevTools URLs (auto-synthesised on macOS desktop / Flutter Web where the explicit WS line is absent). |
| `rc_flutter_connect`      | Opens the VM-service WebSocket + subscribes to Stdout / Stderr / Logging / Extension / Debug. Idempotent. Probes for a library scope where `Element` resolves (handles the Flutter Web `web_entrypoint.dart` quirk). |
| `rc_flutter_drain_errors` | Returns + clears **structured** exception events. Use this instead of grepping the console. |
| `rc_flutter_drain_logs`   | Returns + clears structured log events. |
| `rc_flutter_hot_reload`   | Sends `r` over PTY (Flutter's own pipeline), parses the report into `{success, libraries_reloaded, duration_ms}` or `{success:false, reason, console_excerpt}`. |
| `rc_flutter_eval`         | Read-only Dart expression eval against the live app. Surfaces `eval_kind` + `eval_error` on failure so compile / runtime errors are diagnosable. For driving UI interactions, use Marionette MCP. |

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
`mcp__agentic-rc__rc_flutter_drain_errors`, etc. See
[`.mcp.json.example`](.mcp.json.example) for variants (direct dist path, dev
mode via `tsx`).

## Install the bundled Claude Code skill

This repo ships a Claude Code skill at
[`.claude/skills/agentic-rc/SKILL.md`](.claude/skills/agentic-rc/SKILL.md)
that teaches Claude **when** to reach for each tool and **when to redirect
to Marionette MCP** for agentic UI testing.

- **Project-local:** the skill is auto-loaded when you open Claude Code in
  this repo's directory.
- **Global:** copy it to your global skills dir so it's available in *every*
  project:

  ```bash
  npm run install:skill
  # → ~/.claude/skills/agentic-rc/SKILL.md
  ```

  Idempotent — re-run after each `git pull`.

## Example: drive `flutter run` and catch its exceptions

```jsonc
// 1. Spawn the app — same as `flutter run` from the terminal.
rc_start { command: "flutter", args: ["run", "-d", "macos"],
           cwd: "/path/to/my-flutter-app" }
// → { session_id: "8fa45718", pid: 79314 }

// 2. Open the Dart VM Service — endpoint auto-sniffed from PTY output.
//    No copy-paste of debug URLs.
rc_flutter_connect { session_id: "8fa45718", wait_ms: 180000 }
// → { connected: true,
//     ws_url: "ws://127.0.0.1:51658/hSQyXpnxQEo=/ws",
//     main_isolate_id: "isolates/6257046507251003" }

// 3. Edit a Dart file (regular Edit / Write tool — not part of this MCP),
//    then trigger hot reload + verify nothing broke.
rc_flutter_hot_reload { session_id: "8fa45718" }
// → { success: true, libraries_reloaded: 1, duration_ms: 135 }

rc_flutter_drain_errors { session_id: "8fa45718" }
// → { count: 1, errors: [
//     { timestamp: "2026-…", stream: "Extension",
//       message: "EXCEPTION CAUGHT BY WIDGETS LIBRARY … main.dart:72:5 …" } ] }

// 4. (optional) Read-only inspection of live state via Dart eval.
rc_flutter_eval { session_id: "8fa45718",
                  expression: "WidgetsBinding.instance.framesEnabled" }
// → { kind: "Instance", valueAsString: "true",
//     eval_target_lib: "<rootLib>" }

// 5. Clean shutdown — send 'q' over PTY, or signal.
rc_send_keys { session_id: "8fa45718", keys: "q" }
//   …or:
rc_stop { session_id: "8fa45718", wait_ms: 3000, remove: true }
```

For **interacting** with the running UI (tap, scroll, text input), pivot to
Marionette MCP — see [its quick-start](https://pub.dev/packages/marionette_mcp).
Both MCPs coexist happily in one `.mcp.json`.

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
  history of what was rendered, post-curses processing.
- **`rc_read_stream`** — for pure log-style apps (no cursor tricks) where
  you want every byte in order, with a cursor for incremental reads.
- **`rc_flutter_drain_errors`** — once a session has VM-service connected
  this is **always preferred over PTY grepping**. Structured events with
  stream origin, timestamp, message, and the raw VM-service payload.

## Develop

```bash
npm test               # vitest — 25 tests (keys, sessions, endpoints)
npm run typecheck      # strict tsc --noEmit
npm run build          # emit dist/

# Live end-to-end demo scripts (each drives a fresh MCP server over stdio):
npm run smoke                                # 14-tool list + generic PTY happy path
node scripts/flutter-drive.mjs               # spawn flutter, hot-reload, quit
node scripts/flutter-error-detect.mjs        # detect runtime exceptions via PTY
node scripts/flutter-vm-agentic-loop.mjs     # full VM-service feature tour
```

## What this is not

- **Not an agentic UI testing framework.** v0.6 tried (taps, gestures,
  text input, widget tree); v0.7 removed those tools after a real-world
  comparison with [Marionette MCP](https://pub.dev/packages/marionette_mcp)
  showed they do it better with an in-app binding. We complement
  Marionette — they handle interaction inside the app, we handle the
  outside-the-app remote control + observability.
- **Not network-remote.** Stdio only — MCP client and controlled processes
  run on the same machine. (Architecture is ready for it; just no transport
  written.)
- **Not multi-user.** Single process, single session registry, no auth.
- **No persistence.** Killing the MCP server kills every child it started.
- **No Windows yet.** node-pty supports ConPTY; untested with this code.

## License

MIT — see [LICENSE](LICENSE).
