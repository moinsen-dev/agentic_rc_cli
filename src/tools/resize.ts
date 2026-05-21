import { z } from "zod";
import { manager } from "../manager.js";

export const resizeInputSchema = {
  session_id: z.string().min(1).describe("Session ID."),
  cols: z.number().int().positive().describe("New column width."),
  rows: z.number().int().positive().describe("New row height."),
};

export async function resizeHandler(input: { session_id: string; cols: number; rows: number }) {
  const session = manager.get(input.session_id);
  session.resize(input.cols, input.rows);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: true, cols: session.cols, rows: session.rows }, null, 2),
      },
    ],
  };
}
