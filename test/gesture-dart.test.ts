import { describe, it, expect } from "vitest";
import {
  buildTapExpression,
  buildGeometryExpression,
  buildExistsExpression,
  buildEnterTextExpression,
  parseTapResult,
  parseGeometryResult,
  parseExistsResult,
  parseEnterTextResult,
} from "../src/flutter/gesture_dart.js";

describe("buildTapExpression", () => {
  it("emits a coordinate-tap stub that returns the unsupported tag", () => {
    const expr = buildTapExpression({ x: 120, y: 240 });
    expect(expr).toContain("coordinate_tap_unsupported");
    expect(expr.trim().startsWith("(()")).toBe(true);
    expect(expr.trim().endsWith("()")).toBe(true);
  });

  it("emits a key-matcher tap that references ValueKey + onPressed/onTap", () => {
    const expr = buildTapExpression({ by: "key", value: "submit-button" });
    expect(expr).toContain("ValueKey");
    expect(expr).toContain('"submit-button"');
    // We now invoke the widget's callback directly rather than dispatching a pointer event.
    expect(expr).toContain("FloatingActionButton");
    expect(expr).toContain("GestureDetector");
    expect(expr).toContain("visitAncestorElements");
    expect(expr).toContain("cb!.call()");
  });

  it("emits a type-matcher tap that checks runtimeType.toString()", () => {
    const expr = buildTapExpression({ by: "type", value: "FloatingActionButton" });
    expect(expr).toContain("runtimeType.toString()");
    expect(expr).toContain('"FloatingActionButton"');
  });

  it("does not leak JS template interpolation into the Dart source", () => {
    const expr = buildTapExpression({ by: "key", value: "x" });
    expect(expr).not.toContain("undefined");
    expect(expr).not.toContain("NaN");
  });
});

describe("buildGeometryExpression", () => {
  it("returns the geom: tagged shape", () => {
    const expr = buildGeometryExpression({ by: "type", value: "Center" });
    expect(expr).toContain('"geom:');
    expect(expr).toContain("localToGlobal(Offset.zero)");
    expect(expr).toContain("s.width");
    expect(expr).toContain("s.height");
  });
});

describe("buildExistsExpression", () => {
  it("returns a yes:<desc> on found, not_found / no on miss", () => {
    const expr = buildExistsExpression({ by: "key", value: "logout" });
    expect(expr).toContain('"yes:');
    expect(expr).toContain('"not_found"');
  });
});

describe("parseTapResult", () => {
  it("parses called:<callback>", () => {
    expect(parseTapResult("called:FloatingActionButton.onPressed")).toEqual({
      ok: true,
      callback: "FloatingActionButton.onPressed",
    });
    expect(parseTapResult("called:GestureDetector.onTap")).toEqual({
      ok: true,
      callback: "GestureDetector.onTap",
    });
  });
  it("flags not_found", () => {
    expect(parseTapResult("not_found")).toEqual({ ok: false, reason: "not_found" });
  });
  it("returns no_callback_found with the widget type", () => {
    expect(parseTapResult("no_callback_found:Text")).toEqual({
      ok: false,
      reason: "no_callback_found",
      widget_type: "Text",
    });
  });
  it("flags coordinate_tap_unsupported", () => {
    expect(parseTapResult("coordinate_tap_unsupported:Dart eval forbids …")).toEqual({
      ok: false,
      reason: "coordinate_tap_unsupported",
    });
  });
  it("handles null", () => {
    expect(parseTapResult(null)).toEqual({ ok: false, reason: "empty" });
  });
});

describe("parseGeometryResult", () => {
  it("parses the geom:<x>,<y>,<w>,<h>:<type> form", () => {
    const r = parseGeometryResult("geom:10.0,20.0,80.0,40.0:FloatingActionButton");
    expect(r.ok).toBe(true);
    expect(r.rect).toEqual({ x: 10, y: 20, width: 80, height: 40 });
    expect(r.type).toBe("FloatingActionButton");
  });
});

describe("parseExistsResult", () => {
  it("yes/no", () => {
    expect(parseExistsResult("yes:Center")).toEqual({ exists: true, type: "Center" });
    expect(parseExistsResult("no")).toEqual({ exists: false });
    expect(parseExistsResult("not_found")).toEqual({ exists: false });
  });
});

describe("buildEnterTextExpression", () => {
  it("default mode='replace' assigns controller.text", () => {
    const expr = buildEnterTextExpression({ by: "key", value: "email" }, "foo@bar.com", "replace");
    expect(expr).toContain("c.text = 'foo@bar.com'");
    expect(expr).toContain("EditableText");
    expect(expr).toContain("visitChildren");
    // Same-line, no newlines (Dart eval rejects multi-line)
    expect(expr.includes("\n")).toBe(false);
  });

  it("mode='append' concatenates", () => {
    const expr = buildEnterTextExpression({ by: "type", value: "TextField" }, "bar", "append");
    expect(expr).toContain("c.text = c.text + 'bar'");
  });

  it("mode='clear' calls controller.clear()", () => {
    const expr = buildEnterTextExpression({ by: "key", value: "pwd" }, "ignored", "clear");
    expect(expr).toContain("c.clear()");
    expect(expr).not.toContain("'ignored'");
  });

  it("escapes single quotes, backslashes, $, newlines in the value", () => {
    const tricky = "He's \\$\"100\" \n\tnext";
    const expr = buildEnterTextExpression({ by: "key", value: "x" }, tricky, "replace");
    // Single quote escaped
    expect(expr).toContain("He\\'s");
    // Backslash doubled
    expect(expr).toContain("\\\\");
    // $ escaped (would otherwise be interpolation)
    expect(expr).toContain("\\$");
    // No literal newline (we collapse + escape)
    expect(expr.includes("\n")).toBe(false);
    expect(expr).toContain("\\n");
    expect(expr).toContain("\\t");
  });

  it("falls back to no_editable_text when matcher hits a non-input widget", () => {
    const expr = buildEnterTextExpression({ by: "type", value: "Container" }, "x", "replace");
    expect(expr).toContain("no_editable_text:");
  });
});

describe("parseEnterTextResult", () => {
  it("parses set:<value>", () => {
    expect(parseEnterTextResult("set:hello")).toEqual({ ok: true, new_text: "hello" });
  });
  it("parses empty set (after clear)", () => {
    expect(parseEnterTextResult("set:")).toEqual({ ok: true, new_text: "" });
  });
  it("multiline values come back intact (set:.* uses s-flag)", () => {
    expect(parseEnterTextResult("set:line1\nline2")).toEqual({
      ok: true,
      new_text: "line1\nline2",
    });
  });
  it("flags no_editable_text with the widget type", () => {
    expect(parseEnterTextResult("no_editable_text:Container")).toEqual({
      ok: false,
      reason: "no_editable_text",
      widget_type: "Container",
    });
  });
  it("not_found falls through to reason", () => {
    expect(parseEnterTextResult("not_found")).toEqual({ ok: false, reason: "not_found" });
  });
  it("null/empty", () => {
    expect(parseEnterTextResult(null)).toEqual({ ok: false, reason: "empty" });
  });
});
