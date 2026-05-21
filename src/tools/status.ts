import { z } from "zod";
import { manager } from "../manager.js";

export const statusInputSchema = {
  session_id: z
    .string()
    .optional()
    .describe("Specific session to inspect. Omit to list all sessions."),
};

export async function statusHandler(input: { session_id?: string }) {
  if (input.session_id) {
    const session = manager.get(input.session_id);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(session.info(), null, 2),
        },
      ],
    };
  }
  const all = manager.list().map((s) => s.info());
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ sessions: all, count: all.length }, null, 2),
      },
    ],
  };
}
