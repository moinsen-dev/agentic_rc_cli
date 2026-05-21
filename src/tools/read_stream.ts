import { z } from "zod";
import { manager } from "../manager.js";

export const readStreamInputSchema = {
  session_id: z.string().min(1).describe("Session ID."),
  since_cursor: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Absolute byte offset returned by a previous call's `new_cursor`. Omit to start at the earliest still-buffered byte.",
    ),
  max_bytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum bytes to return in this call. Default: 65536."),
  strip_ansi: z
    .boolean()
    .optional()
    .describe("Strip ANSI escape sequences from the returned text. Default: true."),
};

export async function readStreamHandler(input: {
  session_id: string;
  since_cursor?: number;
  max_bytes?: number;
  strip_ansi?: boolean;
}) {
  const session = manager.get(input.session_id);
  const result = session.readStream({
    sinceCursor: input.since_cursor,
    maxBytes: input.max_bytes,
    stripAnsi: input.strip_ansi,
  });
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            text: result.text,
            new_cursor: result.newCursor,
            dropped_bytes: result.droppedBytes,
          },
          null,
          2,
        ),
      },
    ],
  };
}
