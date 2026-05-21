import { z } from "zod";
import { manager } from "../../manager.js";
import { buildTapExpression, parseTapResult, type WidgetMatcher } from "../../flutter/gesture_dart.js";
import { safeEval, diagnosticToJson } from "./_eval_diagnostic.js";

export const flutterTapInputSchema = {
  session_id: z.string().min(1).describe("Session ID."),
  by: z
    .enum(["key", "type", "text", "value_id", "coordinate"])
    .describe(
      "Identification mode. 'key' matches a Widget Key (ValueKey<String> or toString()). 'type' matches the runtime type name (e.g. 'FloatingActionButton'). 'text' matches a Text widget whose `data` contains the value (case-insensitive substring) — pairs with the descendant-first walker so `by:'text', value:'Sign In'` finds the wrapping button. 'value_id' uses the inspector valueId from rc_flutter_widget_find. 'coordinate' uses raw screen coordinates from x/y.",
    ),
  value: z
    .string()
    .optional()
    .describe("The query value (required for by=key/type/text/value_id, ignored for coordinate)."),
  x: z.number().optional().describe("Screen X (required when by=coordinate)."),
  y: z.number().optional().describe("Screen Y (required when by=coordinate)."),
  descend: z
    .boolean()
    .optional()
    .describe(
      "If true (default), the tap walker checks self → descendants → ancestors of the matched widget to find the nearest tappable callback. Set to false to restrict to self → ancestors only (the pre-v0.6.0 behaviour) when a parent widget wraps multiple tappable descendants and you want the exact match.",
    ),
};

export async function flutterTapHandler(input: {
  session_id: string;
  by: "key" | "type" | "text" | "value_id" | "coordinate";
  value?: string;
  x?: number;
  y?: number;
  descend?: boolean;
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

  const descend = input.descend ?? true;
  const expression = buildTapExpression(matcher, { descend });
  const diag = await safeEval(svc, expression);
  const parsed = parseTapResult(diag.value);
  const finalSuccess = parsed.ok && diag.ok;

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: finalSuccess,
            callback: parsed.callback ?? null,
            widget_type: parsed.widget_type ?? null,
            ambiguous_targets: parsed.ambiguous ?? null,
            reason:
              parsed.reason ??
              (finalSuccess ? null : diag.ok ? "unknown" : `eval_kind_${diag.kind}`),
            matcher: "x" in matcher ? { by: "coordinate", x: matcher.x, y: matcher.y } : matcher,
            descend,
            ...diagnosticToJson(diag),
          },
          null,
          2,
        ),
      },
    ],
  };
}
