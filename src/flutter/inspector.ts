/**
 * Wrapper around Flutter's `ext.flutter.inspector.*` service extensions.
 *
 * The Flutter framework exposes a rich inspector API that DevTools uses to
 * render the widget tree, navigate, and read properties. We use the same API
 * to give an AI agent structured access to the running UI.
 *
 * Key concepts:
 *   - groupName: a token that ties together widget references returned by
 *     successive calls. When you dispose the group, all those refs become
 *     invalid. We hold one stable group per session ("agentic-rc") and
 *     dispose it on session exit / explicit refresh.
 *   - valueId: every node returned by getRootWidgetSummaryTree carries a
 *     `valueId` string. You pass that id back to getProperties /
 *     getDetailsSubtree / setSelectionById.
 *
 * Refs:
 *   https://docs.flutter.dev/release/breaking-changes/widget-inspector-types
 *   https://github.com/flutter/flutter/blob/main/packages/flutter/lib/src/widgets/widget_inspector.dart
 */
import { VmServiceClient } from "./vm_service.js";

/**
 * A node in the widget summary tree. Flutter sends a JSON object with fields
 * we *care* about plus a lot of internal metadata we keep in `raw` for power
 * users. Field names match Flutter's diagnostic-tree JSON.
 */
export interface WidgetNode {
  /** Inspector ref ID — pass back to getProperties / getDetailsSubtree. */
  valueId: string | null;
  /** Display name, e.g. "Center", "Text", "FloatingActionButton". */
  description: string;
  /** widgetRuntimeType from Flutter (often equals description). */
  type: string;
  /** Stringified Key if any (e.g. "[<'submit-button'>]" or "[#abc]"). */
  key: string | null;
  /** Best-effort source location: file:line:col. */
  source_location: string | null;
  /** Boolean from inspector: is this widget the locally-defined root? */
  is_app_root: boolean;
  /** Recursively-walked children. */
  children: WidgetNode[];
  /** Original VM-service event — kept for diagnostics. */
  raw: Record<string, unknown>;
}

export interface FindMatch {
  valueId: string | null;
  description: string;
  type: string;
  key: string | null;
  source_location: string | null;
  /** Dotted ancestry path, e.g. "MaterialApp > Scaffold > Center > Text". */
  path: string;
}

export type WidgetFindQuery =
  | { by: "key"; value: string }
  | { by: "type"; value: string }
  | { by: "description"; value: string }
  | { by: "source_contains"; value: string };

interface RawDiagnosticNode {
  valueId?: string;
  description?: string;
  widgetRuntimeType?: string;
  type?: string;
  shouldIndent?: boolean;
  children?: RawDiagnosticNode[];
  properties?: RawDiagnosticNode[];
  // Many Flutter versions wrap the key string inside the properties array,
  // others surface it under "summaryTree" specific fields. We try a few.
  name?: string;
  value?: unknown;
  // Newer diagnostic nodes include a "creationLocation".
  creationLocation?: { file?: string; line?: number; column?: number };
  // Older "locationId" lookup table form.
  locationId?: number;
  isExplicitlySized?: boolean;
}

function nullable<T>(v: T | undefined | null): T | null {
  return v === undefined || v === null ? null : v;
}

function formatLocation(loc: RawDiagnosticNode["creationLocation"]): string | null {
  if (!loc) return null;
  if (!loc.file) return null;
  const file = loc.file.replace(/^file:\/\//, "");
  if (loc.line != null && loc.column != null) return `${file}:${loc.line}:${loc.column}`;
  if (loc.line != null) return `${file}:${loc.line}`;
  return file;
}

function extractKey(node: RawDiagnosticNode): string | null {
  // Flutter sometimes exposes the key as a property named "key" in the
  // properties array; other times it's encoded into the description as a
  // "Key('foo')" suffix. Try both.
  if (Array.isArray(node.properties)) {
    for (const p of node.properties) {
      if (p.name === "key" && typeof p.value === "string" && p.value.length > 0) return p.value;
      if (p.name === "key" && p.value && typeof (p.value as { toString?: () => string }).toString === "function") {
        const s = (p.value as { toString: () => string }).toString();
        if (s && s !== "null") return s;
      }
    }
  }
  const desc = node.description ?? "";
  const m = desc.match(/Key\(([^)]+)\)/);
  if (m) return m[1];
  return null;
}

/** Convert a single Flutter diagnostic node into our trim WidgetNode shape. */
function normalize(node: RawDiagnosticNode): WidgetNode {
  return {
    valueId: nullable(node.valueId),
    description: node.description ?? node.widgetRuntimeType ?? "<unknown>",
    type: node.widgetRuntimeType ?? node.type ?? node.description ?? "<unknown>",
    key: extractKey(node),
    source_location: formatLocation(node.creationLocation),
    is_app_root: false,
    children: (node.children ?? []).map(normalize),
    raw: node as unknown as Record<string, unknown>,
  };
}

/** Depth-first traversal yielding (node, ancestry-path). */
export function* walk(node: WidgetNode, parents: string[] = []): Iterable<{ node: WidgetNode; path: string }> {
  const path = [...parents, node.description].join(" > ");
  yield { node, path };
  for (const child of node.children) {
    yield* walk(child, [...parents, node.description]);
  }
}

export function findWidgets(root: WidgetNode, query: WidgetFindQuery, limit = 50): FindMatch[] {
  const matches: FindMatch[] = [];
  for (const { node, path } of walk(root)) {
    let hit = false;
    switch (query.by) {
      case "key":
        hit =
          node.key != null &&
          (node.key === query.value ||
            node.key.includes(query.value) ||
            node.key.replace(/^\[?<?'?/, "").replace(/'?>?\]?$/, "") === query.value);
        break;
      case "type":
        hit = node.type === query.value || node.description === query.value;
        break;
      case "description":
        hit = node.description.toLowerCase().includes(query.value.toLowerCase());
        break;
      case "source_contains":
        hit = node.source_location != null && node.source_location.includes(query.value);
        break;
    }
    if (hit) {
      matches.push({
        valueId: node.valueId,
        description: node.description,
        type: node.type,
        key: node.key,
        source_location: node.source_location,
        path,
      });
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

export class WidgetInspector {
  private cachedTree: WidgetNode | null = null;
  private cachedAt = 0;
  private groupCounter = 0;
  private currentGroupName: string | null = null;

  constructor(
    private readonly client: VmServiceClient,
    private readonly getIsolateId: () => Promise<string>,
    private readonly groupPrefix: string = "agentic-rc-inspector",
  ) {}

  private async newGroup(): Promise<string> {
    const isolateId = await this.getIsolateId();
    // Dispose the previous group so its refs free memory in the framework.
    if (this.currentGroupName) {
      try {
        await this.client.call("ext.flutter.inspector.disposeGroup", {
          isolateId,
          objectGroup: this.currentGroupName,
        });
      } catch {
        // group may not exist any more — ignore
      }
    }
    this.groupCounter += 1;
    this.currentGroupName = `${this.groupPrefix}-${this.groupCounter}`;
    return this.currentGroupName;
  }

  /**
   * Fetches the root widget *summary* tree (compact; the full tree is much
   * larger and rarely needed). Caches the result on the instance — pass
   * `refresh: true` to bust it (e.g. after a hot reload).
   */
  async rootWidgetTree({ refresh = false }: { refresh?: boolean } = {}): Promise<WidgetNode> {
    if (this.cachedTree && !refresh) return this.cachedTree;
    const isolateId = await this.getIsolateId();
    const objectGroup = await this.newGroup();
    // Newer Flutter versions split the tree into "creation summary" + "previews".
    // We try the simpler API first, then fall back.
    let raw: RawDiagnosticNode;
    try {
      const result = (await this.client.call("ext.flutter.inspector.getRootWidgetSummaryTree", {
        isolateId,
        objectGroup,
      })) as { result?: RawDiagnosticNode } & RawDiagnosticNode;
      raw = result.result ?? result;
    } catch (err) {
      // Some Flutter versions return the tree under "ext.flutter.inspector.getRootWidget".
      const msg = err instanceof Error ? err.message : String(err);
      if (!/method not found|-32601|extension does not exist/i.test(msg)) throw err;
      const result = (await this.client.call("ext.flutter.inspector.getRootWidget", {
        isolateId,
        objectGroup,
      })) as { result?: RawDiagnosticNode } & RawDiagnosticNode;
      raw = result.result ?? result;
    }
    const tree = normalize(raw);
    tree.is_app_root = true;
    this.cachedTree = tree;
    this.cachedAt = Date.now();
    return tree;
  }

  async ensureTree(): Promise<WidgetNode> {
    return this.cachedTree ?? (await this.rootWidgetTree());
  }

  find(query: WidgetFindQuery, limit = 50): Promise<FindMatch[]> {
    return this.ensureTree().then((tree) => findWidgets(tree, query, limit));
  }

  async properties(valueId: string): Promise<RawDiagnosticNode[]> {
    if (!this.currentGroupName) {
      // The valueId only makes sense relative to a group — fetch a tree first
      // to establish one.
      await this.rootWidgetTree({ refresh: true });
    }
    const isolateId = await this.getIsolateId();
    const result = (await this.client.call("ext.flutter.inspector.getProperties", {
      isolateId,
      arg: valueId,
      objectGroup: this.currentGroupName,
    })) as RawDiagnosticNode[] | { result?: RawDiagnosticNode[] };
    if (Array.isArray(result)) return result;
    if (result && Array.isArray(result.result)) return result.result;
    return [];
  }

  get cacheAgeMs(): number | null {
    return this.cachedTree ? Date.now() - this.cachedAt : null;
  }

  invalidate(): void {
    this.cachedTree = null;
    this.cachedAt = 0;
  }

  async dispose(): Promise<void> {
    if (!this.currentGroupName) return;
    try {
      const isolateId = await this.getIsolateId();
      await this.client.call("ext.flutter.inspector.disposeGroup", {
        isolateId,
        objectGroup: this.currentGroupName,
      });
    } catch {
      /* ignore */
    } finally {
      this.currentGroupName = null;
      this.cachedTree = null;
    }
  }
}
