import { z } from "zod";
import { manager } from "../../manager.js";

export const flutterEvalInputSchema = {
  session_id: z.string().min(1).describe("Session ID."),
  expression: z
    .string()
    .min(1)
    .describe(
      "Dart expression to evaluate in the root library scope of the main isolate. Example: 'WidgetsBinding.instance.framesEnabled' or '1+1'.",
    ),
};

export async function flutterEvalHandler(input: { session_id: string; expression: string }) {
  const session = manager.get(input.session_id);
  const svc = await session.ensureFlutterService();
  const result = await svc.evaluate(input.expression);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}
