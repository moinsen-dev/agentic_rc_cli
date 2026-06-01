# Changelog

All notable changes to `agentic-rc-mcp` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), the
versioning follows [SemVer](https://semver.org/).

The repo's git log is the authoritative record. This file is the
human-readable narrative — especially for the v0.6 → v0.7 pivot.

---

## [0.7.1] — 2026-05-22 · CLI flags for inspection + debugging

Before this release the `agentic-rc-mcp` binary silently swallowed every
argument and unconditionally spawned the MCP stdio server — including
`--help` and `--version`, which gave no feedback at all and left the
process hanging on stdin. Real CLI now:

```
agentic-rc-mcp                       MCP stdio server (default, unchanged)
agentic-rc-mcp --help | -h           usage + 14-tool list + links
agentic-rc-mcp --version | -v        version only ("0.7.1\n")
agentic-rc-mcp --list-tools          name<TAB>title per registered tool
agentic-rc-mcp --print-server-info   JSON {name, version, tool_count, tools[]}
```

Unknown flag → stderr + exit 1. Stdio-server mode (no args) is byte-for-byte
unchanged.

### Why

- `.mcp.json` debugging: `--list-tools` confirms the binary is reachable
  and advertises the 14 expected tools (8 PTY + 6 Flutter).
- Pipeline liveness check: `agentic-rc-mcp --version > /dev/null` is the
  cheapest possible "is the MCP wired up correctly" test.
- Discoverability: `--help` actually documents the tool surface and points
  at Marionette MCP for the cases this MCP deliberately doesn't cover.

### Notes

- SDK shape gotcha captured in code: `McpServer._registeredTools` is a
  plain `{ [name]: entry }` object, **not** a `Map`. Initial
  implementation tried `.forEach()` and silently listed zero tools; fix
  uses `Object.entries(reg)`. Verified against
  `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`.
- SKILL.md (project-local + global) gained a "CLI surface" section with
  the three concrete agent use-cases for each flag.

### Files

- `src/index.ts` — new `dispatchCli()` + `listToolsFromServer()` +
  `printHelp/Version/ListTools/ServerInfoJson()`.
- `README.md` — new `## CLI` section right after Install.
- `.claude/skills/agentic-rc/SKILL.md` + `~/.claude/skills/agentic-rc/SKILL.md` —
  CLI surface documented for the agent.

---

## [0.7.0] — 2026-05-22 · **Pivot to non-invasive RC + observability**

After empirically comparing v0.6.2 against
[Marionette MCP](https://pub.dev/packages/marionette_mcp), we concluded
that Marionette's architectural choice — run inside the app via a
`MarionetteBinding` subclass of `WidgetsFlutterBinding` — is
structurally superior for **agentic UI interaction**. It gets real
`GestureBinding.handlePointerEvent`, hit-test filtering, custom-widget
configuration, multi-touch, screenshots — none of which we can match
through `evaluate` because of `@visibleForTesting` plus the hub-library
re-export problem (see v0.6.2 commit notes).

Rather than ship a worse clone, we **doubled down on what's genuinely
ours**: non-invasive remote control + structured observability for
**any** interactive local program (not just Flutter). The two MCPs are
complementary and designed to coexist in one `.mcp.json`.

### Removed (8 tools, ~3000 LOC)

- `rc_flutter_tap` — Marionette has native tap with real PointerEvents
- `rc_flutter_widget_geometry` — Marionette includes layout info
- `rc_flutter_wait_for_widget` — covered by Marionette's element discovery
- `rc_flutter_enter_text` — Marionette's `enter_text` dispatches through TextInput
- `rc_flutter_widget_tree` — Marionette's `get_interactive_elements` is curated
- `rc_flutter_widget_find` — same
- `rc_flutter_widget_properties` — same
- `rc_flutter_screenshot` — Marionette uses in-app binding, works on every platform

Plus the source files behind them (`gesture_dart.ts`, `inspector.ts`,
8 tool handlers), 2 test files, 4 demo scripts, 3 learning files.

### Kept (14 tools — what's genuinely ours)

**PTY layer** (8): `rc_start`, `rc_send_keys`, `rc_read_screen`,
`rc_read_stream`, `rc_wait_for`, `rc_status`, `rc_stop`, `rc_resize`.
Works on **any** interactive program — `flutter run`, `npm run dev`,
`vite`, REPLs, shells, TUIs.

**Flutter / Dart-VM observability** (6): `rc_flutter_endpoints`,
`rc_flutter_connect`, `rc_flutter_drain_errors`, `rc_flutter_drain_logs`,
`rc_flutter_hot_reload`, `rc_flutter_eval` (read-only). Auto-detects
the VM-service URL from PTY output (no copy-paste), subscribes to
structured error / log streams, programmatic hot-reload with typed
result, eval for read-only state inspection.

### Documentation rewrites

- **README**: "If you need tap / scroll / text input / screenshots →
  use Marionette MCP" table up top, then our scope.
- **SKILL.md** (repo-local + global): "When to use THIS skill vs
  Marionette MCP" section. Canonical loop is now the observability
  loop (rebuild → drain errors → fix), not a UI interaction loop.
- **CLAUDE.md**: pruned learnings trigger map; added "what this repo
  is NOT" section to prevent drift back into UI testing.

### Net change

**−2962 LOC.** The codebase is now small enough to be honest about
what it is.

### Migration from v0.6.x

Any project that used the removed tools will break loudly with
"Unknown tool" errors. That's by design. Switch to Marionette MCP for
those features:

```jsonc
{
  "mcpServers": {
    "agentic-rc": { "command": "agentic-rc-mcp" },
    "marionette": { "command": "dart", "args": ["pub", "global", "run", "marionette_mcp"] }
  }
}
```

---

## [0.6.2] — 2026-05-21 · Eval-probe correctness fix

`evalTargetLibraryId()` was using only `try/catch` to detect failed
library probes — but the VM service's `evaluate` RPC **does not throw**
on compilation failures. It returns a normal response of shape
`{type: "@Error", kind: "error", message: "…"}`. Result: the first
candidate (rootLib) always "won" silently and got cached even when its
scope couldn't resolve `Element`.

**Fix:** inspect the response payload, not just rely on try/catch.
Pre-v0.7 only — the gesture tools that depended on this are gone.

The investigation also surfaced a deeper architectural problem:
**hub libraries (`material.dart`, `widgets.dart`, `cupertino.dart`)
are pure re-exports**. Re-exports do NOT bring symbols into the host
library's evaluate scope. Only the source-file where a symbol is
declared has it in scope. Probing the hub libraries was conceptually
wrong; we'd need `package:flutter/src/widgets/framework.dart` for
`Element`, a different source file for each `*Button`, etc. No single
library has all the framework types our walker needed at once. This was
the death-knell for the in-tool gesture approach and the trigger for
the v0.7 pivot.

---

## [0.6.1] — 2026-05-21 · Library-resolution for Flutter Web

Flutter Web sets the rootLib to a generated bootstrap
(`web_entrypoint.dart`) that does NOT import the framework directly.
Every eval against rootLib failed with RPC 113 "Expression compilation
error".

**Fix:** added `FlutterService.evalTargetLibraryId()` — probe each
candidate library with the bare identifier `Element`. First one that
compiles wins, cached for the session. Order: `rootLib` →
`material.dart` → `widgets.dart` → `cupertino.dart`.

Did not actually work for the real-world Flutter Web app the user
tested (hub libraries don't bring re-exports into eval scope — see
v0.6.2 + v0.7 above). The probe logic itself stayed correct and is
still in place for `rc_flutter_eval`.

---

## [0.6.0] — 2026-05-21 · Real-world hardening (later removed)

Added in response to a real-world Flutter Web feedback session:

- **Universal eval diagnostic** — shared `safeEval` helper, every tool
  result carries `eval_kind` / `eval_error` / `expression_preview` so
  failures are diagnosable.
- **Tap walker** rewritten to `self → descendants → ancestors` so custom
  widget wrappers (`TPKButton` → `TextButton`) work. Ambiguity detection
  with structured `ambiguous_targets` list.
- **`by:"text"` matcher** on tap / geometry / wait_for_widget.
- **`widget_tree` filtering**: default `include_framework:false`
  collapses framework subtrees to elision markers, `source_prefix` for
  strict path filter, `flat:true` for flat list (saves ~70% tokens).

All four tools that benefitted from these features were **removed in
v0.7**. The `safeEval` helper survives — used by `rc_flutter_eval`.

---

## [0.5.0] — 2026-05-21 · Text input (later removed)

`rc_flutter_enter_text`: walked to the underlying `EditableText` and
mutated its `TextEditingController.text` so `onChanged` fired and the
field re-rendered. Modes: `replace` (default), `append`, `clear`.

Server-side 200 ms post-mutation settle to avoid back-to-back enter_text
calls racing the framework's mid-frame ProxyElement.update.

**Removed in v0.7** — Marionette MCP's `enter_text` does this through
the platform `TextInput` channel from inside the app, which handles
IME composition, focus management, and form-field semantics correctly.

---

## [0.4.0] — 2026-05-21 · Gesture injection (later removed)

`rc_flutter_tap`, `rc_flutter_widget_geometry`,
`rc_flutter_wait_for_widget`. The tap tool called widgets' `onPressed`
/ `onTap` closures directly via eval, bypassing `GestureBinding`
because `handlePointerEvent` is `@visibleForTesting` and the VM-service
eval frontend refuses to compile expressions that reference it.

Worked for the counter-app demo (0 → 7 over seven synthetic taps).
Didn't work on real-world apps with custom widget wrappers — eventually
led to the v0.6.x hardening attempts, then the v0.7 pivot.

**Removed in v0.7.**

---

## [0.3.0] — 2026-05-21 · Initial release

First public version. 8 generic PTY tools + 7 Flutter VM-service tools
(endpoints, connect, drain errors, drain logs, hot reload, eval,
screenshot) + 3 Flutter inspector tools (widget tree, find, properties).

22 MCP tools total. Live verification on macOS desktop with the
counter-app demo and the login-flow demo.

Architecture:

- `node-pty` for the PTY layer
- `@xterm/headless` for screen rendering (so TUIs work)
- WebSocket JSON-RPC 2.0 client for the Dart VM service
- Stdio transport for MCP (works with Claude Code)

---

## Lineage in one paragraph

v0.3.0 was an opinionated "agentic Flutter testing" tool. v0.4 + v0.5
added gesture injection + text input via eval-injected Dart. v0.6.0
hardened those against real-world feedback. v0.6.1 + v0.6.2 chased
Flutter Web bugs through the eval-scope rabbit hole. **v0.7.0** stopped
chasing — [Marionette MCP](https://pub.dev/packages/marionette_mcp)
already solves the UI-interaction half of the problem properly by
running inside the app, so we removed our worse-but-non-invasive
attempts and re-centered on the half nobody else covers: non-invasive
remote control + structured observability for any interactive process.

[0.7.0]: https://github.com/moinsen-dev/agentic_rc_cli/releases/tag/v0.7.0
[0.6.2]: https://github.com/moinsen-dev/agentic_rc_cli/compare/d388c46...fd4d867
[0.6.1]: https://github.com/moinsen-dev/agentic_rc_cli/compare/8ea1000...d388c46
[0.6.0]: https://github.com/moinsen-dev/agentic_rc_cli/compare/2b26f16...8ea1000
[0.5.0]: https://github.com/moinsen-dev/agentic_rc_cli/compare/83d8fa6...2b26f16
[0.4.0]: https://github.com/moinsen-dev/agentic_rc_cli/compare/3f8c717...83d8fa6
[0.3.0]: https://github.com/moinsen-dev/agentic_rc_cli/commit/3f8c717
