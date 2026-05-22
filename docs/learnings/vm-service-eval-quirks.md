# Dart VM Service `evaluate` — what it won't compile

The `evaluate` RPC backs our `rc_flutter_eval` tool. It's not just "Dart
with current scope" — there are non-obvious constraints that the spec
doesn't mention. Each of these bit us at least once during the build of
the v0.6 gesture tools (since removed in v0.7) and still applies to any
agent / tool author writing eval expressions today.

## Constraint 1 — single-line expressions only

The frontend compiler that backs `evaluate` rejects multi-line strings
outright with **RPC error 113 "Expression compilation error"**. Same
source, same parser, but newlines fail.

```dart
// passes
(() { final p = Offset(10, 20); return "${p.dx},${p.dy}"; })()

// FAILS with err 113
(() {
  final p = Offset(10, 20);
  return "${p.dx},${p.dy}";
})()
```

**Workaround:** if you generate expressions programmatically, collapse
internal whitespace with `s.replace(/\s+/g, " ").trim()` before
sending. If you're typing eval calls by hand, just keep it on one line.

## Constraint 2 — `@visibleForTesting` methods are blocked

Just **referencing** a method annotated `@visibleForTesting` in the
expression triggers RPC 113, even if you never call it.

Confirmed blocked:
- `WidgetsBinding.instance.handlePointerEvent(...)`
- `GestureBinding.instance.handlePointerEvent(...)`
- `WidgetsBinding.instance.hitTestInView(...)`
- Anything in `flutter_test`

This is the structural reason we don't ship gesture / hit-test tools
any more — eval can't reach the APIs that would make them work
correctly. Use [Marionette MCP](https://pub.dev/packages/marionette_mcp)
for those: it runs INSIDE the app with a tiny binding, and the
`@visibleForTesting` filter doesn't apply at runtime.

For our remaining read-only `rc_flutter_eval`, just stay out of the
test APIs and you're fine.

## Constraint 3 — eval runs on the main isolate's event loop

Eval doesn't pause the isolate. If your expression has side effects
(mutations that fire `notifyListeners`, listeners that call `setState`),
it can run inside `Element.update` and trigger "setState during build"
assertions. Flutter's error reporter then asserts on parsing the eval's
anonymous stack frame, and you get an opaque crash.

This is one more reason `rc_flutter_eval` is positioned as
**read-only inspection**: `WidgetsBinding.instance.framesEnabled`,
`MyApp.someGlobal.toString()`, `1+1`. Don't mutate.

## Constraint 4 — Dart 3 record types are rejected

Annotations like `({void Function() cb, String name})?` (Dart 3 named
records) cause RPC 113 "Expression compilation error". The eval
frontend lags Dart 3's syntax even on a Flutter 3.44 / Dart 3.12
toolchain.

**Workaround:** plain `List<dynamic>` 2-tuples.

```dart
// Don't:
({void Function() cb, String name})? checkTappable(Widget x) { … }

// Do:
List? checkTappable(Widget x) {                                  // [cb, name]
  if (x is FloatingActionButton && x.onPressed != null) {
    return [x.onPressed!, "FloatingActionButton.onPressed"];
  }
  return null;
}
final hit = checkTappable(w);
if (hit != null) (hit[0] as void Function())();
```

`List` is `List<dynamic>` (always allowed); casting at the call site
is mildly verbose but compiles. Discovered while building the v0.6
descendant-first walker.

## Constraint 5 — root library may not import the framework

Eval expressions compile in the scope of a target Library (the `targetId`
parameter). The intuitive default — `isolate.rootLib` — works on macOS,
iOS, Android because Flutter's bootstrap there is the user's
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

**Workaround (already shipped in [`flutter_service.ts`](../../src/flutter/flutter_service.ts)
`evalTargetLibraryId()`):** probe each candidate library with the bare
identifier `Element`. Order:
`rootLib` → `package:flutter/material.dart` → `widgets.dart` →
`cupertino.dart`. The first library where `Element` resolves wins, and
is cached for the session. macOS uses rootLib; Web transparently falls
back to material.dart. Important: the `evaluate` RPC does **not** throw
on compile errors — it returns `{type: "@Error", message: "…"}`, so the
probe code inspects the response shape, not just try/catch.

## Diagnostic technique

When a new eval expression fails:

1. Print the literal expression that's being sent.
2. Run it by hand via `rc_flutter_eval` and read the surfaced
   `eval_kind` + `eval_error` fields — the universal-diagnostic helper
   exposes the VM service's actual error message instead of swallowing
   it to `reason: "empty"`. See
   [`eval-diagnostic-discipline.md`](eval-diagnostic-discipline.md).
3. Bisect: comment out half the expression, retry, halve again until
   you isolate the offending identifier or syntax.

## Tagged-string return convention

`valueAsString` is a single string per eval call. If you want
structured returns, encode them with a tag prefix (`set:`, `geom:`,
`not_found`, …) and parse on the JS side. Don't return JSON-as-string;
the eval escape rules will bite you (mostly the `$` interpolation
ambiguity).
