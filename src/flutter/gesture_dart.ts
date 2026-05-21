/**
 * Builds Dart expression strings that, when fed to `evaluate` over the VM
 * service, simulate user gestures *inside* the running Flutter app — by
 * invoking the widgets' own `onPressed` / `onTap` closures directly.
 *
 * Why not dispatch synthetic pointer events?
 *
 *   `WidgetsBinding.instance.handlePointerEvent(...)` is annotated
 *   `@visibleForTesting` in the Flutter framework. The Dart VM-service
 *   `evaluate` RPC refuses to compile expressions that even *reference*
 *   such methods — they return "Expression compilation error" (RPC 113).
 *   Same for `hitTestInView`. We discovered this empirically through
 *   scripts/eval-debug.mjs.
 *
 *   So instead of going through GestureBinding's hit-test pipeline, we
 *   walk to the nearest interactive widget and call its callback
 *   directly. Semantically the same effect: the user's onPressed runs,
 *   setState triggers a rebuild, the UI updates. The only thing we
 *   skip is the ripple animation and the recogniser state machine —
 *   both irrelevant for behavioural verification.
 *
 * Each builder returns ONE Dart expression (an IIFE). The IIFE evaluates
 * to a tagged result string like `"called:FloatingActionButton.onPressed"`
 * or `"not_found"`. The TypeScript caller parses it back into a typed
 * object.
 */

export type WidgetMatcher =
  | { by: "key"; value: string }
  | { by: "type"; value: string }
  | { by: "value_id"; value: string }
  | { x: number; y: number };

/**
 * Lookup snippet that defines `Element? found` and either populates it
 * or returns early with a tagged failure string.
 */
function findElementSnippet(matcher: Exclude<WidgetMatcher, { x: number }>): string {
  if (matcher.by === "value_id") {
    const id = JSON.stringify(matcher.value);
    return `
final inspector = WidgetInspectorService.instance;
final ref = inspector.toObject(${id});
Element? found = ref is Element ? ref : null;
if (found == null) return "not_found";
`;
  }

  if (matcher.by === "key") {
    const v = JSON.stringify(matcher.value);
    return `
Element? found;
void visit(Element e) {
  if (found != null) return;
  final k = e.widget.key;
  if (k != null) {
    final ks = k.toString();
    if (ks.contains(${v})) { found = e; return; }
    if (k is ValueKey && k.value == ${v}) { found = e; return; }
  }
  e.visitChildren(visit);
}
WidgetsBinding.instance.rootElement?.visitChildren(visit);
if (found == null) return "not_found";
`;
  }

  // by === "type"
  const t = JSON.stringify(matcher.value);
  return `
Element? found;
void visit(Element e) {
  if (found != null) return;
  if (e.widget.runtimeType.toString() == ${t}) { found = e; return; }
  e.visitChildren(visit);
}
WidgetsBinding.instance.rootElement?.visitChildren(visit);
if (found == null) return "not_found";
`;
}

/**
 * Snippet that, starting from `found` (an Element with a Widget), looks
 * for a tappable callback on the widget itself OR any ancestor widget.
 * Sets `cb` (Function?) and `cbName` (String?).
 */
const TAPPABLE_SCAN = `
void Function()? cb;
String? cbName;
void tryWidget(Widget x) {
  if (cb != null) return;
  if (x is FloatingActionButton && x.onPressed != null) { cb = x.onPressed; cbName = "FloatingActionButton.onPressed"; }
  else if (x is ElevatedButton && x.onPressed != null)  { cb = x.onPressed; cbName = "ElevatedButton.onPressed"; }
  else if (x is TextButton && x.onPressed != null)      { cb = x.onPressed; cbName = "TextButton.onPressed"; }
  else if (x is OutlinedButton && x.onPressed != null)  { cb = x.onPressed; cbName = "OutlinedButton.onPressed"; }
  else if (x is FilledButton && x.onPressed != null)    { cb = x.onPressed; cbName = "FilledButton.onPressed"; }
  else if (x is IconButton && x.onPressed != null)      { cb = x.onPressed; cbName = "IconButton.onPressed"; }
  else if (x is GestureDetector && x.onTap != null)     { cb = x.onTap; cbName = "GestureDetector.onTap"; }
  else if (x is InkWell && x.onTap != null)             { cb = x.onTap; cbName = "InkWell.onTap"; }
  else if (x is InkResponse && x.onTap != null)         { cb = x.onTap; cbName = "InkResponse.onTap"; }
  else if (x is ListTile && x.onTap != null)            { cb = x.onTap; cbName = "ListTile.onTap"; }
}
tryWidget(found!.widget);
if (cb == null) {
  found!.visitAncestorElements((el) {
    tryWidget(el.widget);
    return cb == null;
  });
}
if (cb == null) return "no_callback_found:" + found!.widget.runtimeType.toString();
cb!.call();
`;

/**
 * Build a tap expression. For widget-matcher modes, it calls the nearest
 * `onPressed`/`onTap` on the found widget or any ancestor. For coordinate
 * mode it currently no-ops with a tagged result (true coord-based tap
 * would need handlePointerEvent which is blocked — workaround: identify
 * the widget by type/key and use that instead).
 */
/**
 * Collapse all internal whitespace runs to single spaces. The Dart VM
 * service's `evaluate` RPC rejects multi-line expressions outright
 * (RPC 113 Expression compilation error) — found empirically via
 * scripts/eval-debug.mjs phase 4. We keep the template multi-line for
 * readability and squash before sending.
 */
function singleLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function buildTapExpression(matcher: WidgetMatcher): string {
  if ("x" in matcher) {
    return singleLine(`(() {
      return "coordinate_tap_unsupported:Dart eval forbids handlePointerEvent — use by=key|type|value_id instead";
    })()`);
  }
  return singleLine(`(() {
${findElementSnippet(matcher)}
${TAPPABLE_SCAN}
return "called:" + cbName!;
})()`);
}

/**
 * Geometry without referencing `RenderBox.localToGlobal` directly through
 * `@visibleForTesting`-marked paths. RenderBox is fine to *touch*; we
 * just have to be careful not to invoke any test-only methods.
 *
 * Returns "geom:<x>,<y>,<w>,<h>:<type>" or a tagged failure.
 */
export function buildGeometryExpression(matcher: Exclude<WidgetMatcher, { x: number }>): string {
  return singleLine(`(() {
${findElementSnippet(matcher)}
final ro = found!.renderObject;
if (ro is! RenderBox) return "no_render_box";
final p = ro.localToGlobal(Offset.zero);
final s = ro.size;
final desc = found!.widget.runtimeType.toString();
return "geom:\${p.dx.toStringAsFixed(1)},\${p.dy.toStringAsFixed(1)},\${s.width.toStringAsFixed(1)},\${s.height.toStringAsFixed(1)}:\${desc}";
})()`);
}

/**
 * Existence probe. Returns "yes:<type>" or "no"/"not_found".
 */
export function buildExistsExpression(matcher: Exclude<WidgetMatcher, { x: number }>): string {
  return singleLine(`(() {
${findElementSnippet(matcher)}
return "yes:\${found!.widget.runtimeType.toString()}";
})()`);
}

export type EnterTextMode = "replace" | "append" | "clear";

/**
 * Encodes a string as a valid Dart string literal. Escapes:
 *   - backslashes
 *   - single quotes (we wrap with ')
 *   - newlines / carriage returns
 *   - dollar signs (would otherwise trigger interpolation)
 */
function dartString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\$/g, "\\$")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `'${escaped}'`;
}

/**
 * Build a Dart expression that fills a text field by mutating the
 * underlying TextEditingController. Works for TextField, TextFormField,
 * and direct EditableText matches — we always walk down to find an
 * EditableText descendant, which guarantees a controller reference.
 *
 * Modes:
 *   replace — controller.text = value     (default)
 *   append  — controller.text = controller.text + value
 *   clear   — controller.clear()  (value is ignored)
 *
 * Returns "set:<new-text>" on success, or a tagged failure.
 */
export function buildEnterTextExpression(
  matcher: Exclude<WidgetMatcher, { x: number }>,
  value: string,
  mode: EnterTextMode,
): string {
  const literal = dartString(value);
  let assignment: string;
  switch (mode) {
    case "append":
      assignment = `c.text = c.text + ${literal};`;
      break;
    case "clear":
      assignment = `c.clear();`;
      break;
    case "replace":
    default:
      assignment = `c.text = ${literal};`;
      break;
  }
  return singleLine(`(() {
${findElementSnippet(matcher)}
Element? editable;
if (found!.widget is EditableText) {
  editable = found;
} else {
  void deepFind(Element e) {
    if (editable != null) return;
    if (e.widget is EditableText) { editable = e; return; }
    e.visitChildren(deepFind);
  }
  found!.visitChildren(deepFind);
}
if (editable == null) return "no_editable_text:" + found!.widget.runtimeType.toString();
final w = editable!.widget;
if (w is! EditableText) return "not_editable_text";
final c = w.controller;
${assignment}
return "set:\${c.text}";
})()`);
}

export function parseEnterTextResult(raw: string | null): {
  ok: boolean;
  new_text?: string;
  reason?: string;
  widget_type?: string;
} {
  if (!raw) return { ok: false, reason: "empty" };
  const set = raw.match(/^set:(.*)$/s);
  if (set) return { ok: true, new_text: set[1] };
  const noEd = raw.match(/^no_editable_text:(.+)$/);
  if (noEd) return { ok: false, reason: "no_editable_text", widget_type: noEd[1] };
  return { ok: false, reason: raw };
}

// ─── Result parsers ────────────────────────────────────────────────────

export function parseTapResult(raw: string | null): {
  ok: boolean;
  callback?: string;
  widget_type?: string;
  reason?: string;
} {
  if (!raw) return { ok: false, reason: "empty" };
  const called = raw.match(/^called:(.+)$/);
  if (called) {
    return { ok: true, callback: called[1] };
  }
  const noCb = raw.match(/^no_callback_found:(.+)$/);
  if (noCb) return { ok: false, reason: "no_callback_found", widget_type: noCb[1] };
  const coord = raw.match(/^coordinate_tap_unsupported:(.+)$/);
  if (coord) return { ok: false, reason: "coordinate_tap_unsupported" };
  return { ok: false, reason: raw };
}

export function parseGeometryResult(raw: string | null): {
  ok: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  type?: string;
  reason?: string;
} {
  if (!raw) return { ok: false, reason: "empty" };
  const m = raw.match(/^geom:([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+):(.*)$/);
  if (m) {
    return {
      ok: true,
      rect: {
        x: parseFloat(m[1]),
        y: parseFloat(m[2]),
        width: parseFloat(m[3]),
        height: parseFloat(m[4]),
      },
      type: m[5],
    };
  }
  return { ok: false, reason: raw };
}

export function parseExistsResult(raw: string | null): { exists: boolean; type?: string } {
  if (!raw) return { exists: false };
  if (raw === "no" || raw === "not_found") return { exists: false };
  const m = raw.match(/^yes:(.*)$/);
  if (m) return { exists: true, type: m[1] };
  return { exists: false };
}
