# Eval-diagnostic discipline — every handler must surface `eval_kind`

Real-world feedback (Flutter Web session, May 2026) caught the worst
class of bug in this codebase so far: `rc_flutter_tap` silently returned
`{success: false, reason: "empty", raw_eval: null}` on every attempt
across four different matchers. The agent had **no way to know why**.

The cause was that three of our four eval-driven tool handlers (`tap`,
`widget_geometry`, `wait_for_widget`) checked only `evalResult.valueAsString`.
If the Dart eval returned an `@Error` kind (Dart code threw) or an
empty `@Instance` value (the IIFE returned `null`), all three failures
collapsed to the same opaque `reason: "empty"`. Only `enter_text` had
the proper diagnostic — it surfaced `eval_kind` + `eval_error` after
the login-demo debugging session.

## The rule

**Every MCP tool handler that calls `svc.evaluate(...)` MUST use the
shared `safeEval` helper.** Located at:

```
src/tools/flutter/_eval_diagnostic.ts
```

API:

```ts
const diag = await safeEval(svc, expression);
//   → { ok, value, kind, error, expression_preview }

return { ...diagnosticToJson(diag), success: parsed.ok && diag.ok, ... };
```

`diagnosticToJson` spreads the diagnostic into the tool result as
`eval_ok`, `eval_kind`, `eval_error`, `raw_eval`, and
`expression_preview` (only when failed). Tool-specific fields go on top.

## What the agent now sees on failure

Before (v0.5):

```json
{ "success": false, "reason": "empty", "raw_eval": null }
```

After (v0.6+):

```json
{
  "success": false,
  "reason": "eval_kind_@Error",
  "eval_ok": false,
  "eval_kind": "@Error",
  "eval_error": "Compilation error: Undefined name 'TPKButton'.",
  "raw_eval": null,
  "expression_preview": "(() { Element? found; void visit(Element e) { …"
}
```

That's the difference between "I'm stuck, ask the human" and "the
expression references a symbol the running app doesn't have — let me
adjust the matcher."

## When to add safeEval

- New tool handler that calls `svc.evaluate(...)`: always use safeEval.
- Existing tool handler that has a `try/catch await svc.evaluate(...)`
  pattern: migrate to `safeEval` — the existing pattern only catches
  thrown errors, not `@Error` kind responses (which are NOT thrown by
  our flutter_service.evaluate).

## Failure modes safeEval distinguishes

| `kind` value | What it means | What the agent should try |
|---|---|---|
| `@Instance` | Eval succeeded, value returned. | Parse the value with the tool-specific parser. |
| `@Error` | Dart code threw an unhandled exception. | Read `eval_error` for the Dart exception message. Often a `Compilation error:` for missing symbols or a runtime `NoSuchMethodError`. |
| `wrapper_error` | Our `flutter_service.evaluate()` itself threw (VM service WebSocket error, timeout, …). | Reconnect, retry, or investigate the VM-service connection. |
| (any other kind) | VM service returned something weird (`@Sentinel`, `@Null`, `ErrorRef`, …). | Look at `eval_error` and `raw_eval` — rare. |

## What this means going forward

When `agentic-rc-mcp` evolves to new gestures (long_press, scroll,
drag), each new handler **MUST** go through safeEval. The discipline is
guarded by the convention, not by tests — but the migration of all
existing handlers in v0.6.0 set the precedent.

If you ever see `raw_eval: null` and no `eval_kind` field in a tool
result during testing, that's a regression — the handler skipped safeEval.
File a fix.
