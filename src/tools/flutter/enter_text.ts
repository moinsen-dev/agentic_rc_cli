import { z } from "zod";
import { manager } from "../../manager.js";
import {
  buildEnterTextExpression,
  parseEnterTextResult,
  type EnterTextMode,
  type WidgetMatcher,
} from "../../flutter/gesture_dart.js";

export const flutterEnterTextInputSchema = {
  session_id: z.string().min(1).describe("Session ID."),
  by: z
    .enum(["key", "type", "value_id"])
    .describe(
      "How to identify the text field. 'key' / 'type' / 'value_id' — same matchers as rc_flutter_tap.",
    ),
  value: z.string().min(1).describe("Matcher value (e.g. 'email-input', 'TextField')."),
  text: z
    .string()
    .describe("The text to write. Ignored when mode='clear'."),
  mode: z
    .enum(["replace", "append", "clear"])
    .optional()
    .describe(
      "How to update the controller. 'replace' (default) overwrites; 'append' concatenates; 'clear' empties.",
    ),
};

export async function flutterEnterTextHandler(input: {
  session_id: string;
  by: "key" | "type" | "value_id";
  value: string;
  text: string;
  mode?: EnterTextMode;
}) {
  const session = manager.get(input.session_id);
  const svc = await session.ensureFlutterService();
  const matcher = { by: input.by, value: input.value } as Exclude<WidgetMatcher, { x: number }>;
  const mode = input.mode ?? "replace";
  const expression = buildEnterTextExpression(matcher, input.text, mode);

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
              expression_preview: expression.slice(0, 500),
            },
            null,
            2,
          ),
        },
      ],
    };
  }
  // Yield ~200 ms so the framework can finish whatever rebuild was kicked off
  // by the controller mutation we just did. Without this, back-to-back
  // enter_text calls race the framework's build cycle — the second mutation
  // runs while ProxyElement.update is still on the stack from the previous,
  // and listener setState calls throw "setState during build" via the
  // controller's notifyListeners.
  await new Promise((r) => setTimeout(r, 200));

  const parsed = parseEnterTextResult(evalResult.valueAsString);
  // Surface the eval kind so callers can distinguish "no value returned" from
  // an unhandled Dart exception. ErrorRef / UnhandledException carry their
  // detail in raw.message; @Instance is the happy path.
  const evalKind = evalResult.kind;
  const evalErrorDetail =
    typeof evalResult.raw?.["message"] === "string"
      ? (evalResult.raw["message"] as string)
      : null;
  const finalSuccess = parsed.ok && evalKind === "@Instance";
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: finalSuccess,
            new_text: parsed.new_text ?? null,
            reason: parsed.reason ?? (finalSuccess ? null : "eval_kind_" + evalKind),
            widget_type: parsed.widget_type ?? null,
            mode,
            raw_eval: evalResult.valueAsString,
            eval_kind: evalKind,
            eval_error: evalErrorDetail,
          },
          null,
          2,
        ),
      },
    ],
  };
}
