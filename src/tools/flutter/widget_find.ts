import { z } from "zod";
import { manager } from "../../manager.js";

export const flutterWidgetFindInputSchema = {
  session_id: z.string().min(1).describe("Session ID."),
  by: z
    .enum(["key", "type", "description", "source_contains"])
    .describe(
      "Search dimension. 'key' matches Widget keys, 'type' matches the runtime type (e.g. 'FloatingActionButton'), 'description' does a case-insensitive substring match against the diagnostic description, 'source_contains' matches anywhere in the source file:line.",
    ),
  value: z.string().min(1).describe("The query value to match."),
  limit: z.number().int().positive().optional().describe("Cap on returned matches. Default: 50."),
  refresh: z
    .boolean()
    .optional()
    .describe("Force-refresh the cached widget tree before searching. Default: false."),
};

export async function flutterWidgetFindHandler(input: {
  session_id: string;
  by: "key" | "type" | "description" | "source_contains";
  value: string;
  limit?: number;
  refresh?: boolean;
}) {
  const session = manager.get(input.session_id);
  const svc = await session.ensureFlutterService();
  if (input.refresh) {
    await svc.inspector.rootWidgetTree({ refresh: true });
  }
  const matches = await svc.inspector.find({ by: input.by, value: input.value }, input.limit ?? 50);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            query: { by: input.by, value: input.value },
            count: matches.length,
            matches,
          },
          null,
          2,
        ),
      },
    ],
  };
}
