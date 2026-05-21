/**
 * Shared eval-call wrapper used by every tool that runs a Dart expression
 * through the VM service. Normalises:
 *
 *   - successful eval → { ok: true, value: string|null, kind: "@Instance", error: null }
 *   - VM-service threw  → { ok: false, value: null, kind: "@Error",
 *                           error: <message from raw.message>, raw_preview }
 *   - TS-side throw    → { ok: false, value: null, kind: "wrapper_error",
 *                          error: <thrown message>, raw_preview }
 *
 * Why this matters: before this helper, three tools (tap, widget_geometry,
 * wait_for_widget) silently returned `reason: "empty", raw_eval: null` on
 * any failure — diagnostically blind. Now every failure surfaces the
 * VM-service's error string + the expression we sent.
 */

import type { FlutterService } from "../../flutter/flutter_service.js";

export interface EvalDiagnostic {
  ok: boolean;
  value: string | null;
  kind: string;
  error: string | null;
  /** First 400 chars of the expression — useful when error is opaque. */
  expression_preview: string;
}

export async function safeEval(svc: FlutterService, expression: string): Promise<EvalDiagnostic> {
  const preview = expression.slice(0, 400);
  let result: { valueAsString: string | null; kind: string; raw: Record<string, unknown> };
  try {
    result = await svc.evaluate(expression);
  } catch (err) {
    return {
      ok: false,
      value: null,
      kind: "wrapper_error",
      error: err instanceof Error ? err.message : String(err),
      expression_preview: preview,
    };
  }
  // VM service returned a structured response. @Instance is success; anything
  // else (@Error, ErrorRef, …) means the Dart code itself threw.
  if (result.kind === "@Instance") {
    return {
      ok: true,
      value: result.valueAsString,
      kind: result.kind,
      error: null,
      expression_preview: preview,
    };
  }
  const rawMessage =
    typeof result.raw["message"] === "string" ? (result.raw["message"] as string) : null;
  return {
    ok: false,
    value: result.valueAsString,
    kind: result.kind,
    error: rawMessage ?? `eval returned kind=${result.kind} without a message`,
    expression_preview: preview,
  };
}

/**
 * Spread the diagnostic into a flat JSON object so each tool's output
 * is consistent. Tools merge tool-specific fields ON TOP of this base.
 */
export function diagnosticToJson(d: EvalDiagnostic): Record<string, unknown> {
  return {
    eval_ok: d.ok,
    eval_kind: d.kind,
    eval_error: d.error,
    raw_eval: d.value,
    expression_preview: d.error || !d.ok ? d.expression_preview : undefined,
  };
}
