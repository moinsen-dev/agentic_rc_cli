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
  | { by: "text"; value: string }
  | { by: "value_id"; value: string }
  | { x: number; y: number };

/**
 * Encodes a string as a valid Dart single-quoted string literal. Escapes:
 *   - backslashes
 *   - single quotes
 *   - newlines / CR / tab
 *   - dollar signs (would otherwise trigger string interpolation)
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
    const v = dartString(matcher.value);
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

  if (matcher.by === "text") {
    // Match a Text widget whose `data` (or toString()) contains the value,
    // case-insensitive. Pairs with the descendant-first walker so that
    // by="text" value="Sign In" finds the wrapping button when we then
    // search for a tappable in self/descendants/ancestors.
    const v = dartString(matcher.value.toLowerCase());
    return `
Element? found;
final needle = ${v};
void visit(Element e) {
  if (found != null) return;
  final w = e.widget;
  if (w is Text) {
    final d = w.data;
    if (d != null && d.toLowerCase().contains(needle)) { found = e; return; }
  }
  e.visitChildren(visit);
}
WidgetsBinding.instance.rootElement?.visitChildren(visit);
if (found == null) return "not_found";
`;
  }

  // by === "type"
  const t = dartString(matcher.value);
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
 * Predicate snippet that resolves whether a Widget is tappable, returning
 * a (cb, name) record or null. Used by self/descendants/ancestors phases
 * of the walker — DRY across all three.
 *
 * Custom widgets (TPKButton etc.) are NOT in this list — they wrap a
 * built-in tappable (TextButton, GestureDetector, …) which the
 * descendant phase reaches.
 */
// We return a 2-element List<dynamic> instead of a Dart-3 record because
// the VM-service eval frontend rejects record type annotations
// ({void Function() cb, String name}) with RPC 113. List<dynamic> is
// older Dart but compiles fine.
//
//   List? checkTappable(Widget x) → [VoidCallback, String] | null
//                                      [0]=callback     [1]=name
const CHECK_TAPPABLE = `
List? checkTappable(Widget x) {
  if (x is FloatingActionButton && x.onPressed != null) return [x.onPressed!, "FloatingActionButton.onPressed"];
  if (x is ElevatedButton && x.onPressed != null) return [x.onPressed!, "ElevatedButton.onPressed"];
  if (x is TextButton && x.onPressed != null) return [x.onPressed!, "TextButton.onPressed"];
  if (x is OutlinedButton && x.onPressed != null) return [x.onPressed!, "OutlinedButton.onPressed"];
  if (x is FilledButton && x.onPressed != null) return [x.onPressed!, "FilledButton.onPressed"];
  if (x is IconButton && x.onPressed != null) return [x.onPressed!, "IconButton.onPressed"];
  if (x is GestureDetector && x.onTap != null) return [x.onTap!, "GestureDetector.onTap"];
  if (x is InkWell && x.onTap != null) return [x.onTap!, "InkWell.onTap"];
  if (x is InkResponse && x.onTap != null) return [x.onTap!, "InkResponse.onTap"];
  if (x is ListTile && x.onTap != null) return [x.onTap!, "ListTile.onTap"];
  return null;
}
`;

/**
 * Walker snippet: tries self → descendants → ancestors (if descend) or
 * self → ancestors (if !descend).
 *
 * Why self → descendants → ancestors as default? Real-world apps wrap
 * built-in tappables in custom widgets (TPKButton wraps TextButton).
 * by="type":"TPKButton" hits the wrapper; the tappable is INSIDE.
 * Ancestor-only walk would miss it and report no_callback_found.
 *
 * On ambiguity (multiple tappable descendants found in the subtree),
 * we return "ambiguous:<list>" so the caller can disambiguate via
 * by:"key" / by:"value_id" instead of guessing.
 */
function tappableScan(descend: boolean): string {
  // Each `hit` is List? of [cb, name].
  // Each `cand` collected during descend is List<dynamic> of [cb, name, type].
  const descendBlock = descend
    ? `
if (hit == null) {
  final cands = <List>[];
  void scan(Element e) {
    final h = checkTappable(e.widget);
    if (h != null) {
      cands.add([h[0], h[1], e.widget.runtimeType.toString()]);
      return;
    }
    e.visitChildren(scan);
  }
  found!.visitChildren(scan);
  if (cands.length == 1) {
    hit = [cands[0][0], cands[0][1]];
  } else if (cands.length > 1) {
    final list = cands.map((c) => c[2].toString() + ":" + c[1].toString()).join("|");
    return "ambiguous:" + list;
  }
}
`
    : "";
  return `
${CHECK_TAPPABLE}
List? hit = checkTappable(found!.widget);
${descendBlock}
if (hit == null) {
  found!.visitAncestorElements((el) {
    final h = checkTappable(el.widget);
    if (h != null) { hit = h; return false; }
    return true;
  });
}
if (hit == null) return "no_callback_found:" + found!.widget.runtimeType.toString();
(hit![0] as void Function())();
return "called:" + hit![1].toString();
`;
}

/**
 * Collapse all internal whitespace runs to single spaces. The Dart VM
 * service's `evaluate` RPC rejects multi-line expressions outright
 * (RPC 113 Expression compilation error) — found empirically via
 * scripts/eval-debug.mjs phase 4.
 */
function singleLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export interface TapOptions {
  /** Whether to look for tappables in descendants of the matched widget.
   *  Default: true. Set false to restrict to self → ancestors only. */
  descend?: boolean;
}

export function buildTapExpression(matcher: WidgetMatcher, opts: TapOptions = {}): string {
  if ("x" in matcher) {
    return singleLine(`(() {
      return "coordinate_tap_unsupported:Dart eval forbids handlePointerEvent — use by=key|type|text|value_id instead";
    })()`);
  }
  const descend = opts.descend ?? true;
  return singleLine(`(() {
${findElementSnippet(matcher)}
${tappableScan(descend)}
})()`);
}

/**
 * Geometry: returns rect + type of the matched widget.
 * "geom:<x>,<y>,<w>,<h>:<type>" or "no_render_box" or "not_found".
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
 * Existence probe. Returns "yes:<type>" or "not_found".
 */
export function buildExistsExpression(matcher: Exclude<WidgetMatcher, { x: number }>): string {
  return singleLine(`(() {
${findElementSnippet(matcher)}
return "yes:\${found!.widget.runtimeType.toString()}";
})()`);
}

export type EnterTextMode = "replace" | "append" | "clear";

/**
 * Build a Dart expression that fills a text field by mutating the
 * underlying TextEditingController. Walks down to the EditableText
 * descendant so it works whether the user passed a controller or not.
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

// ─── Result parsers ────────────────────────────────────────────────────

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

export interface TapAmbiguousTarget {
  type: string;
  callback: string;
}

export function parseTapResult(raw: string | null): {
  ok: boolean;
  callback?: string;
  widget_type?: string;
  reason?: string;
  ambiguous?: TapAmbiguousTarget[];
} {
  if (!raw) return { ok: false, reason: "empty" };
  const called = raw.match(/^called:(.+)$/);
  if (called) return { ok: true, callback: called[1] };
  const noCb = raw.match(/^no_callback_found:(.+)$/);
  if (noCb) return { ok: false, reason: "no_callback_found", widget_type: noCb[1] };
  const ambig = raw.match(/^ambiguous:(.+)$/);
  if (ambig) {
    const targets = ambig[1].split("|").map((s) => {
      const idx = s.indexOf(":");
      if (idx < 0) return { type: s, callback: "?" };
      return { type: s.slice(0, idx), callback: s.slice(idx + 1) };
    });
    return { ok: false, reason: "ambiguous_descendants", ambiguous: targets };
  }
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
