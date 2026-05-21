import { z } from "zod";
import { manager } from "../../manager.js";

export const flutterWidgetTreeInputSchema = {
  session_id: z.string().min(1).describe("Session ID."),
  refresh: z
    .boolean()
    .optional()
    .describe(
      "Force a fresh fetch from the VM service. The tree is cached otherwise so repeated calls within the same UI state are cheap. Default: false.",
    ),
  max_depth: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Clip the returned tree at this depth. Useful to keep the payload small (a real Flutter app's tree can have 200+ nodes). Default: 6.",
    ),
  include_raw: z
    .boolean()
    .optional()
    .describe("Include the raw VM-service diagnostic node alongside each widget. Default: false."),
};

interface TrimmedNode {
  valueId: string | null;
  description: string;
  type: string;
  key: string | null;
  source_location: string | null;
  child_count: number;
  children: TrimmedNode[];
  raw?: Record<string, unknown>;
}

function trim(
  node: import("../../flutter/inspector.js").WidgetNode,
  depth: number,
  maxDepth: number,
  includeRaw: boolean,
): TrimmedNode {
  const trimmed: TrimmedNode = {
    valueId: node.valueId,
    description: node.description,
    type: node.type,
    key: node.key,
    source_location: node.source_location,
    child_count: node.children.length,
    children:
      depth >= maxDepth
        ? []
        : node.children.map((c) => trim(c, depth + 1, maxDepth, includeRaw)),
  };
  if (includeRaw) trimmed.raw = node.raw;
  return trimmed;
}

export async function flutterWidgetTreeHandler(input: {
  session_id: string;
  refresh?: boolean;
  max_depth?: number;
  include_raw?: boolean;
}) {
  const session = manager.get(input.session_id);
  const svc = await session.ensureFlutterService();
  const tree = await svc.inspector.rootWidgetTree({ refresh: input.refresh ?? false });
  const maxDepth = input.max_depth ?? 6;
  const includeRaw = input.include_raw ?? false;
  const out = trim(tree, 0, maxDepth, includeRaw);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            tree: out,
            cache_age_ms: svc.inspector.cacheAgeMs,
            max_depth: maxDepth,
          },
          null,
          2,
        ),
      },
    ],
  };
}
