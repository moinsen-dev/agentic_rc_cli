import { z } from "zod";
import { manager } from "../manager.js";
import { parseKeys } from "../keys.js";

export const sendKeysInputSchema = {
  session_id: z.string().min(1).describe("Session ID returned by rc_start."),
  keys: z
    .string()
    .describe(
      "Keys to send. Supports named tokens like <Enter>, <Tab>, <Esc>, <Space>, <Backspace>, <Up>, <Down>, <C-c>, <C-d>, <M-x>, <F1>..<F12>. Plain characters are sent verbatim. Example: 'git status<Enter>' or '<C-c>'.",
    ),
  raw: z
    .boolean()
    .optional()
    .describe("If true, send `keys` byte-for-byte without parsing named tokens. Default: false."),
};

export async function sendKeysHandler(input: {
  session_id: string;
  keys: string;
  raw?: boolean;
}) {
  const session = manager.get(input.session_id);
  const payload = input.raw ? input.keys : parseKeys(input.keys);
  const bytes = session.write(payload);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ bytes_sent: bytes, decoded_chars: payload.length }, null, 2),
      },
    ],
  };
}
