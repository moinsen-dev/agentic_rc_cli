import { z } from "zod";
import { manager } from "../manager.js";

export const readScreenInputSchema = {
  session_id: z.string().min(1).describe("Session ID."),
  mode: z
    .enum(["screen", "scrollback", "tail"])
    .optional()
    .describe(
      "'screen' = the current rendered viewport (default). 'scrollback' = entire scrollback + screen. 'tail' = the last `tail_lines` lines of scrollback+screen.",
    ),
  tail_lines: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Lines to return when mode='tail'. Default: 50."),
};

export async function readScreenHandler(input: {
  session_id: string;
  mode?: "screen" | "scrollback" | "tail";
  tail_lines?: number;
}) {
  const session = manager.get(input.session_id);
  const mode = input.mode ?? "screen";

  if (mode === "screen") {
    const screen = session.readScreen();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(screen, null, 2),
        },
      ],
    };
  }

  if (mode === "scrollback") {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              text: session.readScrollback(),
              rows: session.rows,
              cols: session.cols,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // mode === "tail"
  const tailLines = input.tail_lines ?? 50;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            text: session.readTail(tailLines),
            tail_lines: tailLines,
          },
          null,
          2,
        ),
      },
    ],
  };
}
