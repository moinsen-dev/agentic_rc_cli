import { z } from "zod";
import { manager } from "../../manager.js";

export const flutterDrainLogsInputSchema = {
  session_id: z.string().min(1).describe("Session ID."),
};

export async function flutterDrainLogsHandler(input: { session_id: string }) {
  const session = manager.get(input.session_id);
  const svc = await session.ensureFlutterService();
  const events = svc.drainLogs();
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ count: events.length, logs: events }, null, 2),
      },
    ],
  };
}
