import { z } from "zod";
import { manager } from "../../manager.js";

export const flutterWidgetPropertiesInputSchema = {
  session_id: z.string().min(1).describe("Session ID."),
  value_id: z
    .string()
    .min(1)
    .describe(
      "The inspector valueId of the widget — get it from a previous rc_flutter_widget_tree or rc_flutter_widget_find call.",
    ),
};

interface RawProp {
  name?: string;
  type?: string;
  description?: string;
  value?: unknown;
  defaultLevel?: string;
  level?: string;
}

export async function flutterWidgetPropertiesHandler(input: { session_id: string; value_id: string }) {
  const session = manager.get(input.session_id);
  const svc = await session.ensureFlutterService();
  const props = (await svc.inspector.properties(input.value_id)) as unknown as RawProp[];
  const trimmed = props.map((p) => ({
    name: p.name ?? null,
    description: p.description ?? null,
    type: p.type ?? null,
    value: p.value ?? null,
    level: p.level ?? p.defaultLevel ?? null,
  }));
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            value_id: input.value_id,
            count: trimmed.length,
            properties: trimmed,
          },
          null,
          2,
        ),
      },
    ],
  };
}
