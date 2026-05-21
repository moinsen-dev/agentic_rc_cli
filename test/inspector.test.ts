import { describe, it, expect } from "vitest";
import { findWidgets, walk, type WidgetNode } from "../src/flutter/inspector.js";

/** Build a small fake widget tree resembling the Flutter counter app. */
function makeCounterTree(): WidgetNode {
  const make = (
    description: string,
    type: string,
    key: string | null,
    children: WidgetNode[] = [],
    valueId: string | null = description,
    source: string | null = null,
  ): WidgetNode => ({
    valueId,
    description,
    type,
    key,
    source_location: source,
    is_app_root: false,
    children,
    raw: {},
  });

  return make("MyApp", "MyApp", null, [
    make("MaterialApp", "MaterialApp", null, [
      make("MyHomePage", "MyHomePage", null, [
        make("Scaffold", "Scaffold", null, [
          make("AppBar", "AppBar", null, [make("Text", "Text", null, [], "title-text")]),
          make("Center", "Center", null, [
            make("Column", "Column", null, [
              make("Text", "Text", null, [], "counter-label"),
              make("Text", "Text", "<'counter-value'>", [], "counter-value", "lib/main.dart:109:13"),
            ]),
          ]),
          make("FloatingActionButton", "FloatingActionButton", "<'fab-increment'>", [
            make("Icon", "Icon", null),
          ], "fab", "lib/main.dart:115:30"),
        ]),
      ]),
    ]),
  ]);
}

describe("inspector.walk", () => {
  it("yields every node depth-first", () => {
    const tree = makeCounterTree();
    const nodes = [...walk(tree)];
    expect(nodes.length).toBeGreaterThan(10);
    // First yielded is the root.
    expect(nodes[0].node.description).toBe("MyApp");
    // Path strings join with " > ".
    const fabEntry = nodes.find((n) => n.node.description === "FloatingActionButton");
    expect(fabEntry?.path).toBe(
      "MyApp > MaterialApp > MyHomePage > Scaffold > FloatingActionButton",
    );
  });
});

describe("inspector.findWidgets", () => {
  it("finds by type", () => {
    const tree = makeCounterTree();
    const hits = findWidgets(tree, { by: "type", value: "FloatingActionButton" });
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toContain("Scaffold > FloatingActionButton");
    expect(hits[0].valueId).toBe("fab");
  });

  it("finds all Text widgets", () => {
    const tree = makeCounterTree();
    const hits = findWidgets(tree, { by: "type", value: "Text" });
    expect(hits.length).toBe(3);
    expect(hits.map((h) => h.valueId).sort()).toEqual(
      ["counter-label", "counter-value", "title-text"].sort(),
    );
  });

  it("finds by key (literal value extracted from `<'foo'>` form)", () => {
    const tree = makeCounterTree();
    const hits = findWidgets(tree, { by: "key", value: "fab-increment" });
    expect(hits).toHaveLength(1);
    expect(hits[0].description).toBe("FloatingActionButton");
  });

  it("finds by description substring (case-insensitive)", () => {
    const tree = makeCounterTree();
    const hits = findWidgets(tree, { by: "description", value: "appbar" });
    expect(hits).toHaveLength(1);
    expect(hits[0].description).toBe("AppBar");
  });

  it("finds by source_contains", () => {
    const tree = makeCounterTree();
    const hits = findWidgets(tree, { by: "source_contains", value: "main.dart:109" });
    expect(hits).toHaveLength(1);
    expect(hits[0].source_location).toBe("lib/main.dart:109:13");
  });

  it("respects the limit", () => {
    const tree = makeCounterTree();
    const hits = findWidgets(tree, { by: "type", value: "Text" }, 2);
    expect(hits).toHaveLength(2);
  });

  it("returns empty when nothing matches", () => {
    const tree = makeCounterTree();
    expect(findWidgets(tree, { by: "type", value: "NonExistent" })).toHaveLength(0);
  });
});
