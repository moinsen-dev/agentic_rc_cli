/**
 * Named-key parser.
 *
 *   parseKeys("hello<Enter>")          -> "hello\r"
 *   parseKeys("<C-c>")                 -> "\x03"
 *   parseKeys("git status<Enter>")     -> "git status\r"
 *   parseKeys("foo<Tab><Enter>")       -> "foo\t\r"
 *   parseKeys("<Esc>:q!<Enter>")       -> "\x1b:q!\r"
 *
 * Unknown <...> tokens are left as-is (so users can pass raw text containing
 * angle brackets if they don't match a known key).
 */

const NAMED_KEYS: Record<string, string> = {
  enter: "\r",
  return: "\r",
  cr: "\r",
  lf: "\n",
  tab: "\t",
  esc: "\x1b",
  escape: "\x1b",
  space: " ",
  backspace: "\x7f",
  bs: "\x7f",
  delete: "\x1b[3~",
  del: "\x1b[3~",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  f1: "\x1bOP",
  f2: "\x1bOQ",
  f3: "\x1bOR",
  f4: "\x1bOS",
  f5: "\x1b[15~",
  f6: "\x1b[17~",
  f7: "\x1b[18~",
  f8: "\x1b[19~",
  f9: "\x1b[20~",
  f10: "\x1b[21~",
  f11: "\x1b[23~",
  f12: "\x1b[24~",
};

function controlChar(ch: string): string | null {
  const c = ch.toLowerCase();
  if (c.length !== 1) return null;
  const code = c.charCodeAt(0);
  // a..z -> Ctrl-A..Ctrl-Z (0x01..0x1A)
  if (code >= 0x61 && code <= 0x7a) {
    return String.fromCharCode(code - 0x60);
  }
  // Common symbolic control chars
  switch (c) {
    case "@":
      return "\x00";
    case "[":
      return "\x1b";
    case "\\":
      return "\x1c";
    case "]":
      return "\x1d";
    case "^":
      return "\x1e";
    case "_":
      return "\x1f";
    case " ":
      return "\x00";
    case "?":
      return "\x7f";
  }
  return null;
}

export function parseKeys(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] === "<") {
      const close = input.indexOf(">", i + 1);
      if (close === -1) {
        out += input[i];
        i++;
        continue;
      }
      const token = input.slice(i + 1, close);
      const translated = translateToken(token);
      if (translated !== null) {
        out += translated;
        i = close + 1;
        continue;
      }
      // Unknown token — keep the literal text (including the angle brackets).
      out += input.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    out += input[i];
    i++;
  }
  return out;
}

function translateToken(token: string): string | null {
  const t = token.trim();
  if (!t) return null;

  // Ctrl: <C-c>, <Ctrl-c>, <ctrl-x>
  const ctrlMatch = t.match(/^(?:C|Ctrl)-(.+)$/i);
  if (ctrlMatch) {
    return controlChar(ctrlMatch[1]);
  }

  // Meta/Alt: <M-a>, <Alt-x>  -> ESC + key
  const metaMatch = t.match(/^(?:M|Alt|Meta)-(.+)$/i);
  if (metaMatch) {
    return "\x1b" + metaMatch[1];
  }

  // Named key
  const named = NAMED_KEYS[t.toLowerCase()];
  if (named !== undefined) return named;

  return null;
}
