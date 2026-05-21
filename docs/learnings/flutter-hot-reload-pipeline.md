# Flutter hot reload — why we send "r" over PTY (not VM service)

The intuitive design for `rc_flutter_hot_reload` is "call the VM
service's `reloadSources` RPC directly". It doesn't work. Here's why,
and what we do instead.

## The trap

`reloadSources` only tells the VM "load this new kernel". The VM
itself doesn't have a Dart-source-to-kernel compiler — that lives in
the **`frontend_server`** process, which is spawned and managed by
`flutter run`'s CLI, not the VM.

So when we call `reloadSources` directly via WebSocket:
1. The VM service expects pre-compiled kernel bytes
2. We don't provide any
3. The VM tries to compile from source itself, fails immediately

Symptom (seen in [`scripts/flutter-vm-agentic-loop.mjs`](../../scripts/flutter-vm-agentic-loop.mjs)
when it briefly tried this approach):

```json
{ "success": false, "notices": ["Error while starting Kernel isolate task"] }
```

## The actual reload pipeline

When a human types `r` in the `flutter run` terminal:

```
'r' keystroke → flutter_tools CLI hot-reload handler
  → spawn frontend_server (or reuse the cached one)
  → frontend_server compiles only the changed .dart files to kernel
  → kernel bytes sent to VM via `reloadSources` (with the right source map)
  → VM swaps source
  → flutter_tools calls `ext.flutter.reassemble` to rebuild widget tree
  → "Reloaded N libraries in M ms" printed to stdout
```

Steps 2-5 are owned by the CLI. We can't fake them from outside.

## What `rc_flutter_hot_reload` does

[`src/tools/flutter/hot_reload.ts`](../../src/tools/flutter/hot_reload.ts):

1. Mark the PTY stream cursor.
2. `session.write("r")` — keystroke goes to flutter_tools.
3. Poll the stream from that cursor for a known result line:
   - `/Reloaded (\d+)(?: of (\d+))? librar(?:y|ies) in (\d+)ms/` → success
   - `/Compiler message:|Error:.*lib\/.*\.dart|Try again after fixing/` → fail
4. Return a structured result either way.

Returning structured results from text parsing isn't ideal, but it's the
only working route. We use the **VM service for everything else** (eval,
inspector, error subscription) — just not for the reload trigger.

## The success-message regex must handle multiple Flutter versions

Older Flutter: `"Reloaded 1 library in 105ms."`
Modern (3.x): `"Reloaded 1 of 753 libraries in 105ms (compile: 9 ms, reload: 52 ms, reassemble: 32 ms)."`

The regex accepts both. If a future Flutter changes the wording again,
this is the place to look.

## When `rc_flutter_hot_reload` returns `success: false`

The most common failure modes:
- **Dart syntax error** in the changed file — `console_excerpt` will
  contain `Compiler message: lib/foo.dart:42:5: Error: Expected …`.
  Fix the source and call again.
- **Reload not supported for the change** — adding a top-level method,
  changing class hierarchies, etc. Need a hot **restart** (`R`) not
  hot reload. We don't currently expose that; send `R` via
  `rc_send_keys` if needed.
- **flutter run is not in a state to reload** (e.g. paused at a
  breakpoint). `console_excerpt` will hint at this.

## When NOT to use this tool

If you've changed code and your test scenario needs **fresh state**
(no leftover counter values, no stale auth), use **hot restart** via
`rc_send_keys "R"` — preserves nothing. Hot reload preserves state,
which is usually what you want, but sometimes burns you.
