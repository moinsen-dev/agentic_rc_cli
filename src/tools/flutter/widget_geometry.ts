import { z } from "zod";
import { manager } from "../../manager.js";
import { buildGeometryExpression, parseGeometryResult, type WidgetMatcher } from "../../flutter/gesture_dart.js";

export const flutterWidgetGeometryInputSchema = {
  session_id: z.string().min(1).describe("Session ID."),
  by: z
    .enum(["key", "type", "value_id"])
    .describe("Identification mode — same matchers as rc_flutter_tap."),
  value: z.string().min(1).describe("The query value."),
};

export async function flutterWidgetGeometryHandler(input: {
  session_id: string;
  by: "key" | "type" | "value_id";
  value: string;
}) {
  const session = manager.get(input.session_id);
  const svc = await session.ensureFlutterService();
  const matcher = { by: input.by, value: input.value } as Exclude<WidgetMatcher, { x: number }>;
  const expr = buildGeometryExpression(matcher);
  let evalResult: { valueAsString: string | null; kind: string; raw: Record<string, unknown> };
  try {
    evalResult = await svc.evaluate(expr);
  } catch (err) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: false,
              reason: "eval_error",
              error: err instanceof Error ? err.message : String(err),
              expression_preview: expr.slice(0, 400),
            },
            null,
            2,
          ),
        },
      ],
    };
  }
  const parsed = parseGeometryResult(evalResult.valueAsString);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: parsed.ok,
            rect: parsed.rect ?? null,
            widget_type: parsed.type ?? null,
            reason: parsed.reason ?? null,
            raw_eval: evalResult.valueAsString,
          },
          null,
          2,
        ),
      },
    ],
  };
}
