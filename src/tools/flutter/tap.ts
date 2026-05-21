import { z } from "zod";
import { manager } from "../../manager.js";
import { buildTapExpression, parseTapResult, type WidgetMatcher } from "../../flutter/gesture_dart.js";

export const flutterTapInputSchema = {
  session_id: z.string().min(1).describe("Session ID."),
  by: z
    .enum(["key", "type", "value_id", "coordinate"])
    .describe(
      "Identification mode. 'key' matches a Widget Key (ValueKey<String> or toString()). 'type' matches the runtime type name (e.g. 'FloatingActionButton'). 'value_id' uses the inspector valueId from rc_flutter_widget_find. 'coordinate' uses raw screen coordinates from x/y.",
    ),
  value: z
    .string()
    .optional()
    .describe("The query value (required for by=key/type/value_id, ignored for coordinate)."),
  x: z.number().optional().describe("Screen X (required when by=coordinate)."),
  y: z.number().optional().describe("Screen Y (required when by=coordinate)."),
};

export async function flutterTapHandler(input: {
  session_id: string;
  by: "key" | "type" | "value_id" | "coordinate";
  value?: string;
  x?: number;
  y?: number;
}) {
  const session = manager.get(input.session_id);
  const svc = await session.ensureFlutterService();

  let matcher: WidgetMatcher;
  if (input.by === "coordinate") {
    if (input.x === undefined || input.y === undefined) {
      throw new Error("by='coordinate' requires both x and y");
    }
    matcher = { x: input.x, y: input.y };
  } else {
    if (!input.value) throw new Error(`by='${input.by}' requires a value`);
    matcher = { by: input.by, value: input.value };
  }

  const expression = buildTapExpression(matcher);
  let evalResult: { valueAsString: string | null; kind: string; raw: Record<string, unknown> };
  try {
    evalResult = await svc.evaluate(expression);
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
              expression_preview: expression.slice(0, 400),
            },
            null,
            2,
          ),
        },
      ],
    };
  }
  const parsed = parseTapResult(evalResult.valueAsString);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: parsed.ok,
            callback: parsed.callback ?? null,
            widget_type: parsed.widget_type ?? null,
            reason: parsed.reason ?? null,
            raw_eval: evalResult.valueAsString,
            matcher: "x" in matcher ? { by: "coordinate", x: matcher.x, y: matcher.y } : matcher,
          },
          null,
          2,
        ),
      },
    ],
  };
}
