import { describe, it, expect } from "vitest";
import { parseKeys } from "../src/keys.js";

describe("parseKeys", () => {
  it("passes through plain text", () => {
    expect(parseKeys("hello")).toBe("hello");
  });

  it("translates <Enter> to \\r", () => {
    expect(parseKeys("hello<Enter>")).toBe("hello\r");
  });

  it("translates <Tab> and <Esc>", () => {
    expect(parseKeys("foo<Tab>bar<Esc>")).toBe("foo\tbar\x1b");
  });

  it("translates <C-c> to ETX", () => {
    expect(parseKeys("<C-c>")).toBe("\x03");
  });

  it("translates <Ctrl-d> case-insensitively to EOT", () => {
    expect(parseKeys("<Ctrl-d>")).toBe("\x04");
  });

  it("translates arrow keys", () => {
    expect(parseKeys("<Up>")).toBe("\x1b[A");
    expect(parseKeys("<Down>")).toBe("\x1b[B");
    expect(parseKeys("<Right>")).toBe("\x1b[C");
    expect(parseKeys("<Left>")).toBe("\x1b[D");
  });

  it("translates F-keys", () => {
    expect(parseKeys("<F1>")).toBe("\x1bOP");
    expect(parseKeys("<F5>")).toBe("\x1b[15~");
    expect(parseKeys("<F12>")).toBe("\x1b[24~");
  });

  it("translates <M-x> as ESC + x", () => {
    expect(parseKeys("<M-x>")).toBe("\x1bx");
    expect(parseKeys("<Alt-a>")).toBe("\x1ba");
  });

  it("leaves unknown <foo> tokens intact", () => {
    expect(parseKeys("<UnknownToken>")).toBe("<UnknownToken>");
  });

  it("handles a multi-key sequence (Flutter quit)", () => {
    expect(parseKeys("q<Enter>")).toBe("q\r");
  });

  it("handles vim-style <Esc>:q!<Enter>", () => {
    expect(parseKeys("<Esc>:q!<Enter>")).toBe("\x1b:q!\r");
  });

  it("preserves a standalone '<' that has no matching '>'", () => {
    expect(parseKeys("foo<bar")).toBe("foo<bar");
  });
});
