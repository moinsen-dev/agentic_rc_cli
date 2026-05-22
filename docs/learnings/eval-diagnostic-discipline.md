# Eval-diagnostic discipline — surface `eval_kind` on every eval tool

Real-world feedback (Flutter Web session, May 2026) caught the worst
class of bug in this codebase up to v0.5: tools that called eval would
silently return `{success: false, reason: "empty", raw_eval: null}` on
any failure. The agent had **no way to know why**.

After v0.7 the only eval-driven MCP tool we ship is `rc_flutter_eval`,
but the discipline still matters: any future eval-driven tool — and
any inline eval an agent writes via `rc_flutter_eval` — needs the
same diagnostic shape.

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

## What the user sees on failure

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
adjust."

## Failure modes safeEval distinguishes

| `kind` value | What it means | What to try |
|---|---|---|
| `@Instance` | Eval succeeded, value returned. | Parse the value. |
| `@Error` | Dart code threw an unhandled exception. | Read `eval_error` for the Dart exception message. Often a `Compilation error:` for missing symbols, an out-of-scope identifier (see [vm-service-eval-quirks.md](vm-service-eval-quirks.md) constraint 5), or a runtime `NoSuchMethodError`. |
| `wrapper_error` | Our `flutter_service.evaluate()` itself threw (VM service WebSocket error, timeout, …). | Reconnect, retry, or investigate the VM-service connection. |
| (any other kind) | VM service returned something weird (`@Sentinel`, `@Null`, `ErrorRef`, …). | Look at `eval_error` and `raw_eval`. Rare. |

## Regression alarm

If you ever see `raw_eval: null` and no `eval_kind` field in a tool
result during testing, that's a regression — the handler skipped
safeEval. File a fix.

## Pre-v0.7 history

This learning is the surviving forensic record from the v0.6 era when
we shipped four eval-driven gesture/inspector tools. All four migrated
to safeEval during v0.6.0. They were removed in v0.7.0 in favour of
Marionette MCP for UI interaction, so today only `rc_flutter_eval`
exercises the helper. The pattern is preserved so the next eval tool
(whenever we add one) starts diagnostically-correct from day one.
