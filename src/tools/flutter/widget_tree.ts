import { z } from "zod";
import { manager } from "../../manager.js";
import type { WidgetNode } from "../../flutter/inspector.js";

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
  include_framework: z
    .boolean()
    .optional()
    .describe(
      "Include framework-internal widgets (package:flutter/, dart-sdk, pub-cache). Default: false — framework subtrees collapse to a single elision marker `[… +N framework nodes]`. Set to true when debugging framework wrappers themselves.",
    ),
  source_prefix: z
    .string()
    .optional()
    .describe(
      "Only return widgets whose source_location starts with this string. Overrides include_framework. Typical use: pass your project's `lib/` absolute path to see ONLY user-code widgets.",
    ),
  flat: z
    .boolean()
    .optional()
    .describe(
      "Return a flat list of matching widgets instead of a tree. Combines naturally with source_prefix — gives you 'all user-code widgets in this app, with path + valueId'. Saves significant tokens by dropping the parent/children structure. Default: false.",
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

interface FlatNode {
  valueId: string | null;
  description: string;
  type: string;
  key: string | null;
  source_location: string | null;
  /** Dotted ancestry path so flat results stay structurally meaningful. */
  path: string;
}

// Source-location substrings that mark a widget as framework-internal.
// We match against absolute paths (`/.../flutter/lib/...`) and the
// package-URI form (`package:flutter/...`) — Flutter inspector emits both
// depending on build mode.
const FRAMEWORK_MARKERS = [
  "/flutter/packages/flutter/",
  "/flutter/packages/flutter_localizations/",
  "/flutter/bin/cache/",
  "/.pub-cache/",
  "/dart-sdk/",
  "/dart-lang/sdk/",
  "package:flutter/",
  "package:cupertino_",
  "package:material_",
];

function isFramework(node: WidgetNode): boolean {
  const loc = node.source_location;
  if (!loc) return false;
  return FRAMEWORK_MARKERS.some((m) => loc.includes(m));
}

function passesFilter(
  node: WidgetNode,
  includeFramework: boolean,
  sourcePrefix: string | null,
): boolean {
  if (sourcePrefix !== null) {
    return node.source_location !== null && node.source_location.startsWith(sourcePrefix);
  }
  if (includeFramework) return true;
  return !isFramework(node);
}

/**
 * Count every node in a subtree (including the root). Used to render the
 * elision marker for collapsed framework subtrees.
 */
function countSubtree(node: WidgetNode): number {
  let n = 1;
  for (const c of node.children) n += countSubtree(c);
  return n;
}

/**
 * Trim a node:
 *   - clip at max_depth
 *   - drop framework subtrees that contain no user-code descendant
 *     (collapse them to a single elision marker)
 *   - apply source_prefix if set
 */
function trim(
  node: WidgetNode,
  depth: number,
  maxDepth: number,
  includeRaw: boolean,
  includeFramework: boolean,
  sourcePrefix: string | null,
): TrimmedNode | { _elided: true; framework_node_count: number; description: string } {
  if (!passesFilter(node, includeFramework, sourcePrefix)) {
    // Subtree contains no relevant widgets either? Then elide.
    if (!subtreeHasUserCode(node, includeFramework, sourcePrefix)) {
      return {
        _elided: true,
        framework_node_count: countSubtree(node),
        description: node.description,
      };
    }
    // Otherwise recurse — there's something interesting deeper. We still
    // include the framework wrapper to preserve the path, but mark it so
    // the LLM understands it's a passthrough.
  }
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
        : node.children
            .map((c) => trim(c, depth + 1, maxDepth, includeRaw, includeFramework, sourcePrefix))
            .filter(Boolean) as TrimmedNode[],
  };
  if (includeRaw) trimmed.raw = node.raw;
  return trimmed;
}

function subtreeHasUserCode(
  node: WidgetNode,
  includeFramework: boolean,
  sourcePrefix: string | null,
): boolean {
  if (passesFilter(node, includeFramework, sourcePrefix)) return true;
  for (const c of node.children) {
    if (subtreeHasUserCode(c, includeFramework, sourcePrefix)) return true;
  }
  return false;
}

function flatten(
  node: WidgetNode,
  parents: string[],
  out: FlatNode[],
  includeFramework: boolean,
  sourcePrefix: string | null,
): void {
  if (passesFilter(node, includeFramework, sourcePrefix)) {
    out.push({
      valueId: node.valueId,
      description: node.description,
      type: node.type,
      key: node.key,
      source_location: node.source_location,
      path: [...parents, node.description].join(" > "),
    });
  }
  for (const c of node.children) {
    flatten(c, [...parents, node.description], out, includeFramework, sourcePrefix);
  }
}

export async function flutterWidgetTreeHandler(input: {
  session_id: string;
  refresh?: boolean;
  max_depth?: number;
  include_framework?: boolean;
  source_prefix?: string;
  flat?: boolean;
  include_raw?: boolean;
}) {
  const session = manager.get(input.session_id);
  const svc = await session.ensureFlutterService();
  const tree = await svc.inspector.rootWidgetTree({ refresh: input.refresh ?? false });
  const maxDepth = input.max_depth ?? 6;
  const includeRaw = input.include_raw ?? false;
  const includeFramework = input.include_framework ?? false;
  const sourcePrefix = input.source_prefix ?? null;
  const flat = input.flat ?? false;

  if (flat) {
    const list: FlatNode[] = [];
    flatten(tree, [], list, includeFramework, sourcePrefix);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              flat: true,
              count: list.length,
              widgets: list,
              filter: {
                include_framework: includeFramework,
                source_prefix: sourcePrefix,
              },
              cache_age_ms: svc.inspector.cacheAgeMs,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const out = trim(tree, 0, maxDepth, includeRaw, includeFramework, sourcePrefix);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            tree: out,
            cache_age_ms: svc.inspector.cacheAgeMs,
            max_depth: maxDepth,
            filter: {
              include_framework: includeFramework,
              source_prefix: sourcePrefix,
            },
          },
          null,
          2,
        ),
      },
    ],
  };
}
