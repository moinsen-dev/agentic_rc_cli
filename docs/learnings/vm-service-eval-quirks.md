# Dart VM Service `evaluate` — what it won't compile

The `evaluate` RPC is the central tool for any code we inject into a
running Flutter app. It's not just "Dart with current scope" — there are
non-obvious constraints that the spec doesn't mention. Both bit us
hard; both have workarounds.

## Constraint 1 — single-line expressions only

The frontend compiler that backs `evaluate` rejects multi-line strings
outright with **RPC error 113 "Expression compilation error"**. Same
source, same parser, but newlines fail.

Verified empirically with [`scripts/eval-debug.mjs`](../../scripts/eval-debug.mjs)
phase 4:

```dart
// passes
(() { final p = Offset(10, 20); return "${p.dx},${p.dy}"; })()

// FAILS with err 113
(() {
  final p = Offset(10, 20);
  return "${p.dx},${p.dy}";
})()
```

**Workaround:** the `singleLine()` helper in
[`src/flutter/gesture_dart.ts`](../../src/flutter/gesture_dart.ts) runs
`.replace(/\s+/g, " ").trim()` on every generated expression before
sending. Authors write multi-line templates for readability; the helper
collapses them. Don't bypass it.

## Constraint 2 — `@visibleForTesting` methods are blocked

Just **referencing** a method annotated `@visibleForTesting` in the
expression triggers RPC 113, even if you never call it.

Confirmed blocked:
- `WidgetsBinding.instance.handlePointerEvent(...)`
- `GestureBinding.instance.handlePointerEvent(...)`
- `WidgetsBinding.instance.hitTestInView(...)`
- Anything in `flutter_test`

**Workaround for gestures:** don't dispatch synthetic pointer events.
Walk to the nearest interactive widget (FAB / ElevatedButton /
GestureDetector / InkWell / ListTile / …) and call its callback
directly. Implemented in `TAPPABLE_SCAN` snippet of `gesture_dart.ts`.

**Workaround for text input:** don't synthesise keyboard events. Walk
to the `EditableText` and mutate `widget.controller.text` directly.
Implemented in `buildEnterTextExpression`.

The semantic difference vs the "real" path:
- No ripple / press animation
- No GestureRecognizer state-machine transitions
- For text input: cursor stays at end of text, no IME composition

For **behavioural verification** these don't matter. For animation /
visual tests they would — but we're not in that game.

## Constraint 3 — eval runs on the main isolate's event loop

Eval doesn't pause the isolate. If you call eval while the framework
is mid-frame, your expression *can* run inside `Element.update` etc.
A mutation that fires `notifyListeners` then triggers `setState` from
within a build → "setState during build" assertion → Flutter's error
reporter blows up on parsing the eval's anonymous stack frame.

See [`framework-rebuild-pacing.md`](framework-rebuild-pacing.md) for the
mitigation pattern.

## Constraint 4 — Dart 3 record types are rejected

Annotations like `({void Function() cb, String name})?` (Dart 3 named
records) cause RPC 113 "Expression compilation error". The eval
frontend is lagging Dart 3's syntax even on a Flutter 3.44 / Dart 3.12
toolchain.

**Workaround:** use plain `List<dynamic>` 2-tuples.

```dart
// Don't:
({void Function() cb, String name})? checkTappable(Widget x) { … }

// Do:
List? checkTappable(Widget x) {                                  // [cb, name]
  if (x is FloatingActionButton && x.onPressed != null) {
    return [x.onPressed!, "FloatingActionButton.onPressed"];
  }
  // …
  return null;
}
// Caller:
final hit = checkTappable(w);
if (hit != null) {
  (hit[0] as void Function())();
  print("called: " + hit[1].toString());
}
```

`List` is `List<dynamic>` (always allowed); casting at the call site
is mildly verbose but compiles. Discovered while building the
descendant-first walker for v0.6.

## Constraint 5 — root library may not import the framework

Eval expressions compile in the scope of a target Library (the `targetId`
parameter). The intuitive default — `isolate.rootLib` — works on macOS,
iOS, Android desktop because Flutter's bootstrap there is the user's
`main.dart`, which `import 'package:flutter/material.dart'`. So
`Element`, `WidgetsBinding`, `FloatingActionButton` etc. all resolve.

**Flutter Web is different.** The rootLib is a generated
`web_entrypoint.dart`:

```dart
import 'main.dart' as entrypoint;
void main() async {
  await ui_web.bootstrapEngine();
  entrypoint.main();
}
```

No framework import in scope. Every eval that references `Element`
fails with RPC 113.

**Workaround:** in `FlutterService.evalTargetLibraryId()` we probe each
candidate library with the bare identifier `Element`. Order:
`rootLib` → `package:flutter/material.dart` → `widgets.dart` →
`cupertino.dart`. The first library where `Element` compiles wins, and
is cached for the session. macOS keeps using rootLib; Web transparently
falls back to material.dart.

The diagnostic surface exposes which library is currently active via
`evalTargetLibraryUri` (visible in tool results via the future
`eval_target_lib` field).

## Diagnostic technique

`scripts/eval-debug.mjs` is the canonical bisection tool — when a new
expression fails, copy-paste it in, narrow the failing piece by halving.
Phase 1 (basic API access), Phase 2 (binding/dispatch), Phase 3
(complex IIFE shapes), Phase 4 (whitespace) — successively-zoomed
probes already exist; pattern them.

When extending `gesture_dart.ts` and the new expression fails:
1. Print the generated string (`console.log(buildXyzExpression(…))`).
2. Paste into `eval-debug.mjs` `tryEval(…)` to see VM service's actual
   error message.
3. Bisect: halve, retry, halve again.

## Tagged-string return convention

Eval's `valueAsString` is a single string — we encode structured results
with a tag prefix (`called:…`, `set:…`, `not_found`, `geom:…`, …) and
parse on the TypeScript side. Don't return JSON-as-string; the eval
escape rules will bite you. The tag-prefix convention is the contract
between `buildXyzExpression` and `parseXyzResult` in gesture_dart.ts.
