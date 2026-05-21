import { z } from "zod";
import { manager } from "../manager.js";

export const waitForInputSchema = {
  session_id: z.string().min(1).describe("Session ID."),
  pattern: z
    .string()
    .min(1)
    .describe(
      "Pattern to wait for. Bare text is matched as a literal substring. Use '/regex/flags' to match as a regex (e.g. '/Hot reload/i').",
    ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("How long to wait before giving up. Default: 30000 ms."),
  source: z
    .enum(["screen", "stream"])
    .optional()
    .describe(
      "What to match against: 'screen' (the rendered viewport, default) or 'stream' (all output since session start, ANSI-stripped).",
    ),
  poll_ms: z.number().int().positive().optional().describe("Polling interval. Default: 100 ms."),
};

function compilePattern(pattern: string): RegExp {
  const m = pattern.match(/^\/(.+)\/([gimsuy]*)$/s);
  if (m) {
    return new RegExp(m[1], m[2]);
  }
  // Literal substring → escape regex meta-chars.
  return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

export async function waitForHandler(input: {
  session_id: string;
  pattern: string;
  timeout_ms?: number;
  source?: "screen" | "stream";
  poll_ms?: number;
}) {
  const session = manager.get(input.session_id);
  const regex = compilePattern(input.pattern);
  const timeoutMs = input.timeout_ms ?? 30_000;
  const pollMs = input.poll_ms ?? 100;
  const source = input.source ?? "screen";
  const deadline = Date.now() + timeoutMs;

  let streamCursor = 0;
  let streamAccum = "";

  while (Date.now() < deadline) {
    let haystack: string;
    if (source === "screen") {
      haystack = session.readScrollback();
    } else {
      const chunk = session.readStream({
        sinceCursor: streamCursor,
        maxBytes: 256 * 1024,
        stripAnsi: true,
      });
      streamCursor = chunk.newCursor;
      streamAccum += chunk.text;
      haystack = streamAccum;
    }

    const match = haystack.match(regex);
    if (match) {
      const screen = session.readScreen();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                matched: true,
                matched_text: match[0],
                source,
                screen_at_match: screen.text,
                cursor_at_match: screen.cursor,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (session.status !== "running") {
      // Process exited without matching — one last check, then fail.
      const finalMatch = (source === "screen" ? session.readScrollback() : streamAccum).match(
        regex,
      );
      if (finalMatch) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  matched: true,
                  matched_text: finalMatch[0],
                  source,
                  process_exited: true,
                  exit_code: session.exitCode,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                matched: false,
                reason: "process_exited",
                exit_code: session.exitCode,
                source,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
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
            source,
          },
          null,
          2,
        ),
      },
    ],
  };
}
