# Inspector summary tree drops Key info — use direct eval for key matches

`rc_flutter_widget_find by=key` is built on top of the cached widget
summary tree from `ext.flutter.inspector.getRootWidgetSummaryTree`.
That cache **does not reliably expose Widget Keys**, especially on
leaf widgets like Text. Result: `widget_find by=key value='login-status'`
returns `count: 0` even when the Text widget clearly has
`key: ValueKey('login-status')` in the source.

Discovered during the login flow demo
([`scripts/flutter-login-demo.mjs`](../../scripts/flutter-login-demo.mjs))
when reading the status Text by key kept returning null.

## What the inspector actually returns

For a `Text("idle", key: ValueKey('login-status'))` widget, the
summary node JSON looks something like:

```json
{
  "valueId": "inspector-37",
  "description": "Text",
  "widgetRuntimeType": "Text",
  "properties": [ /* may or may not include the key */ ]
}
```

`description` says just `"Text"`, **not** `"Text(key: [<'login-status'>])"`.
The `properties` array sometimes contains a `{name: "key", value: ...}`
entry, but not consistently for all widget types — leaf widgets like
Text and Icon often have it omitted from the summary form.

[`src/flutter/inspector.ts`](../../src/flutter/inspector.ts)'s
`extractKey()` function does try two strategies:
1. Look for a `properties[].name === "key"` entry
2. Regex `Key\((.+?)\)` against `description`

Both fail when the inspector elides the key info.

## The reliable workaround — direct Dart eval

The element tree itself **always** has the right key. Walk it via
direct eval:

```dart
(() {
  Element? found;
  void visit(Element e) {
    if (found != null) return;
    final k = e.widget.key;
    if (k is ValueKey && k.value == 'login-status') { found = e; return; }
    e.visitChildren(visit);
  }
  WidgetsBinding.instance.rootElement?.visitChildren(visit);
  if (found == null) return 'not_found';
  final w = found!.widget;
  if (w is Text) return 'text:' + (w.data ?? '');
  return 'not_text:' + w.runtimeType.toString();
})()
```

This is exactly what
[`scripts/flutter-login-demo.mjs#readTextByKey`](../../scripts/flutter-login-demo.mjs)
does. The same pattern works in all our gesture tools (tap, enter_text,
geometry, wait_for_widget) — they all use the live-element-tree walk in
their generated Dart, never the inspector cache.

## When this matters in practice

- **Reading visible Text by Key** — the most common case where this
  bites. Direct eval helper, as above.
- **Verifying widget state after an interaction** — same pattern.
- **Iterating over widgets that all share a type** to find the one
  with a specific key — direct eval.

## When the inspector cache is fine

- `by: "type"` — runtime type is in the description, always.
- `by: "description"` — substring of the diagnostic description.
- `by: "source_contains"` — creation-location field, always populated
  by inspector in debug builds.
- Browsing the tree structurally (`rc_flutter_widget_tree`) — the
  hierarchy itself is fine; only the per-node `key` field is
  unreliable.

## Possible cleanup

Mid-term, `rc_flutter_widget_find` should auto-route `by: "key"` to a
direct-Dart-eval implementation instead of the cached path. Filed as
"Next intended step" option #2 in `STATE.md`. The cache path is fast
(~1 ms vs ~30 ms for a fresh eval) so it's worth keeping for the other
matchers.

Until then: when key reliability matters, hand-roll the eval in your
script (see login demo) or use `rc_flutter_widget_find by=type` and
filter the results by looking at properties.
