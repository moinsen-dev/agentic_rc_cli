import { z } from "zod";
import { manager } from "../../manager.js";
import {
  buildGeometryExpression,
  parseGeometryResult,
  type WidgetMatcher,
} from "../../flutter/gesture_dart.js";
import { safeEval, diagnosticToJson } from "./_eval_diagnostic.js";

export const flutterWidgetGeometryInputSchema = {
  session_id: z.string().min(1).describe("Session ID."),
  by: z
    .enum(["key", "type", "text", "value_id"])
    .describe("Identification mode — same matchers as rc_flutter_tap."),
  value: z.string().min(1).describe("The query value."),
};

export async function flutterWidgetGeometryHandler(input: {
  session_id: string;
  by: "key" | "type" | "text" | "value_id";
  value: string;
}) {
  const session = manager.get(input.session_id);
  const svc = await session.ensureFlutterService();
  const matcher = { by: input.by, value: input.value } as Exclude<WidgetMatcher, { x: number }>;
  const expr = buildGeometryExpression(matcher);
  const diag = await safeEval(svc, expr);
  const parsed = parseGeometryResult(diag.value);
  const finalSuccess = parsed.ok && diag.ok;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: finalSuccess,
            rect: parsed.rect ?? null,
            widget_type: parsed.type ?? null,
            reason:
              parsed.reason ??
              (finalSuccess ? null : diag.ok ? "unknown" : `eval_kind_${diag.kind}`),
            matcher,
            ...diagnosticToJson(diag),
          },
          null,
          2,
        ),
      },
    ],
  };
}
