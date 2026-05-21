# STATE — agentic_rc_cli

> **Frozen:** 2026-05-21 17:30 (Europe/Berlin)
> **Branch:** develop
> **Last commit:** `fd4d867` · fix(eval): probing must inspect response for @Error
> **Version:** v0.6.2 published, v0.6.3 planning surfaced (see below)

## Last work-unit

Shipped **v0.6.2** — probing-loop must inspect the evaluate-RPC response
for `{type: "@Error"}`, not rely on try/catch alone. The VM-service
`evaluate` RPC does NOT throw on compilation failures; it returns a
normal response of shape `{type: "@Error", kind: "error", message: "…"}`.
Pre-fix, the v0.6.1 probing loop's catch never fired, the first
candidate (rootLib) always "won" silently and got cached even when its
scope couldn't resolve `Element`. Every gesture tool then used the
broken target.

Verified by direct VM-service test against the TPK Web Console
session that reproduced the original problem.

## ⚠️ But — fundamental architecture issue uncovered

User then tried v0.6.2 against TWO Flutter targets (Web on Chrome AND
macOS native) for the TesterPayKit Web Console (a real, non-trivial
Flutter app with `moinsen_runapp` wrapper, GoRouter, Riverpod). Both
failed at the probing stage with `eval_error: "No library in the
running isolate has Element in scope. Probed: <rootLib>, material.dart,
widgets.dart, cupertino.dart"`.

Direct VM-service probe with `evaluate` RPC against each library
confirmed:

- `package:flutter/material.dart` → `Element` undefined
- `package:flutter/widgets.dart` → `Element` undefined
- `package:flutter/cupertino.dart` → `Element` undefined
- `package:flutter/src/widgets/framework.dart` → ✅ `Element` resolves
- `package:flutter/src/widgets/binding.dart` → ✅ `WidgetsBinding` resolves

**The hub libraries (material/widgets/cupertino) are pure re-exports.**
Re-exports do NOT bring symbols into the host library's evaluate-scope.
Only the source-file where a symbol is DIRECTLY declared has it in
scope. The probing strategy was correct in concept but probed the
wrong library URIs.

**Worse:** even with `framework.dart` as targetId, our gesture-walker
expressions still reference `FloatingActionButton`, `TextButton`,
`GestureDetector`, etc. — those live in different source files.
**No single library has all the framework types our walker uses in
its evaluate-scope at the same time.**

## Next intended step — v0.6.3 candidate paths

Two routes under consideration, neither trivial:

### Path A — Reflection-based expression builder

Rewrite every eval expression in `gesture_dart.ts` to use
`runtimeType.toString()` comparisons instead of `is` checks:

```dart
// Before (needs FloatingActionButton in eval-scope):
if (x is FloatingActionButton && x.onPressed != null) …

// After (needs only Widget + runtimeType comparison):
if (x.runtimeType.toString() == 'FloatingActionButton') {
  final cb = (x as dynamic).onPressed;
  if (cb != null) …
}
```

With this rewrite, `framework.dart` alone (which has `Element`,
`Widget`, `RenderObject` directly) is enough for the full gesture
walker. Loses static type safety inside the eval string, but the
expression is already a string-constructed Dart fragment so there was
no real static safety to begin with.

Effort: ~60-90 min including unit-test regression + live-demo
verification on both desktop and Web.

### Path B — Migrate to `ext.flutter.inspector.*` service extensions

Flutter's widget inspector exposes service extensions that don't need
an evaluate-scope at all:

- `ext.flutter.inspector.getRootWidgetSummaryTree` — already used.
- `ext.flutter.inspector.getProperties` — already used.
- `ext.flutter.inspector.getRenderObject` — gives us a RenderObject
  ObjectId we can `getObject` on to read its size + position.
- `ext.flutter.inspector.getLayoutExplorerNode` — even richer layout
  info.

For taps, no built-in service extension exists. Path B requires
shipping a custom service extension as part of the SDK that an app
opts into by `import 'package:agentic_rc_helpers/agentic_rc_helpers.dart'
+ AgenticRcHelpers.register()` in main. Heavier on the app side but
zero eval-scope dependency at the tool side.

Effort: ~3-4 hours including the helper-package scaffold.

### Recommended approach

**Path A first**, then Path B as a v1.0 hardening. Path A is incremental
on what's there; Path B is the eventual architecturally correct answer
but adds a runtime dep for the consuming app.

## Scope documented for users

The `~/.claude/skills/agentic-rc/SKILL.md` has been trimmed to
**Flutter process control + read-only introspection** as the
recommended scope. The 4 eval-based interaction tools (tap,
enter_text, wait_for_widget by:text, widget_geometry) are listed in
an "⚠️ Experimental / known limitations" section at the bottom with
the full architectural explanation and pointer to this STATE.md for
the v0.6.3 plan.

Net effect on agent behaviour: agents using the skill will no longer
attempt to drive UI agentically on real apps and will default to
`Peekaboo` / `chrome-devtools-mcp` for tap dispatch, with agentic-rc
filling the introspection + drain_errors role.

## Open friction (still relevant)

- `rc_flutter_screenshot` `extension_not_registered` on macOS desktop.
- `widget_find by=key` uses the cached inspector path that drops keys
  on Text leaves (eval workaround in `docs/learnings/inspector-tree-keys.md`).
- The 4 interaction tools listed above — covered in detail in the
  v0.6.3 plan.

## Live context for the agent

- **Active spec areas:**
  [`src/flutter/gesture_dart.ts`](src/flutter/gesture_dart.ts) — needs
  Path-A reflection rewrite,
  [`src/flutter/flutter_service.ts`](src/flutter/flutter_service.ts) —
  `evalTargetLibraryId()` probing list candidates (line 235-280)
  also wants framework.dart added before material.dart for the
  pre-Path-A case.
- **Empirical Dart-eval constraints** captured in
  [`docs/learnings/vm-service-eval-quirks.md`](docs/learnings/vm-service-eval-quirks.md):
  single-line only, no `@visibleForTesting`, no Dart 3 records, hub
  libraries don't bring re-exports into evaluate-scope (new Constraint #6
  — needs adding).
- **User-code-only widget tree by default** — pass
  `include_framework:true` only when debugging framework wrappers.
- **Demo discipline:** every new tool gets a live-driven script under
  `scripts/`. Live verification is the truth, not the unit tests.

## How to resume

1. Read this file.
2. `git log -5 --oneline` and `git status -s` — drift detection.
3. If user says "weiter" or "v0.6.3":
   - Read `gesture_dart.ts` to scope the reflection rewrite.
   - Start with one gesture (tap) → reflection-port → live-demo
     against tester app on macOS (the proven setup).
   - If green, port the other three (enter_text, wait_for_widget,
     geometry) in sequence.
4. Recent calibration: v0.6.0 + v0.6.1 + v0.6.2 came in ~90 min of work
   across three commits. Path A estimate of 60-90 min is consistent
   with that velocity.
