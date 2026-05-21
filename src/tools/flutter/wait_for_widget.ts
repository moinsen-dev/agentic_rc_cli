import { z } from "zod";
import { manager } from "../../manager.js";
import {
  buildExistsExpression,
  parseExistsResult,
  type WidgetMatcher,
} from "../../flutter/gesture_dart.js";
import { safeEval, diagnosticToJson } from "./_eval_diagnostic.js";

export const flutterWaitForWidgetInputSchema = {
  session_id: z.string().min(1).describe("Session ID."),
  by: z.enum(["key", "type", "text", "value_id"]).describe("Identification mode."),
  value: z.string().min(1).describe("The query value."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("How long to wait. Default: 10000."),
  poll_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Polling interval. Default: 200."),
  appear: z
    .boolean()
    .optional()
    .describe(
      "If true (default), wait until the widget appears. If false, wait until it disappears.",
    ),
};

export async function flutterWaitForWidgetHandler(input: {
  session_id: string;
  by: "key" | "type" | "text" | "value_id";
  value: string;
  timeout_ms?: number;
  poll_ms?: number;
  appear?: boolean;
}) {
  const session = manager.get(input.session_id);
  const svc = await session.ensureFlutterService();
  const matcher = { by: input.by, value: input.value } as Exclude<WidgetMatcher, { x: number }>;
  const expression = buildExistsExpression(matcher);
  const want = input.appear ?? true;
  const timeoutMs = input.timeout_ms ?? 10_000;
  const pollMs = input.poll_ms ?? 200;
  const deadline = Date.now() + timeoutMs;

  let lastType: string | undefined;
  let lastDiag: ReturnType<typeof diagnosticToJson> = {};
  while (Date.now() < deadline) {
    const diag = await safeEval(svc, expression);
    lastDiag = diagnosticToJson(diag);
    if (!diag.ok) {
      // Eval itself blew up — bubble up immediately instead of silently
      // polling forever. Most common cause: the expression references a
      // symbol that doesn't exist in the running app's scope.
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                matched: false,
                reason: `eval_kind_${diag.kind}`,
                matcher,
                ...lastDiag,
              },
              null,
              2,
            ),
          },
        ],
      };
    }
    const parsed = parseExistsResult(diag.value);
    lastType = parsed.type;
    if (parsed.exists === want) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                matched: true,
                exists: parsed.exists,
                widget_type: parsed.type ?? null,
                waited_ms: timeoutMs - Math.max(0, deadline - Date.now()),
                matcher,
                ...lastDiag,
              },
              null,
              2,
            ),
          },
        ],
      };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            matched: false,
            reason: "timeout",
            timeout_ms: timeoutMs,
            last_widget_type: lastType ?? null,
            matcher,
            ...lastDiag,
          },
          null,
          2,
        ),
      },
    ],
  };
}
