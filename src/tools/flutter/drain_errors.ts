import { z } from "zod";
import { manager } from "../../manager.js";

export const flutterDrainErrorsInputSchema = {
  session_id: z.string().min(1).describe("Session ID."),
  include_raw: z
    .boolean()
    .optional()
    .describe("Include the raw VM-service event payload (useful for debugging). Default: false."),
};

export async function flutterDrainErrorsHandler(input: {
  session_id: string;
  include_raw?: boolean;
}) {
  const session = manager.get(input.session_id);
  const svc = await session.ensureFlutterService();
  const events = svc.drainErrors().map((e) => {
    if (input.include_raw) return e;
    const { raw: _raw, ...rest } = e;
    void _raw;
    return rest;
  });
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ count: events.length, errors: events }, null, 2),
      },
    ],
  };
}
