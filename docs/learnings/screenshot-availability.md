# `ext.flutter.screenshot` is not registered on every platform

`rc_flutter_screenshot` calls the `ext.flutter.screenshot` service
extension. The Flutter framework registers this extension only on
**some** platforms.

## Where it works

- iOS Simulator ✅
- Android Emulator ✅
- Web (Chrome / Edge in DevTools mode) ✅

## Where it doesn't

- **macOS desktop** ❌
- **Linux desktop** (untested but same architecture) ❌ likely
- **Windows desktop** (untested) ❌ likely

On macOS the Flutter engine uses its own `FlutterMetalLayer` path; the
screenshot extension isn't wired in. The eval returns:

```
VM service RPC error -32601: Unknown method "ext.flutter.screenshot".
```

## How the tool handles it

[`src/tools/flutter/screenshot.ts`](../../src/tools/flutter/screenshot.ts)
catches this case and returns:

```json
{
  "success": false,
  "reason": "extension_not_registered",
  "message": "VM service RPC error -32601: …",
  "hint": "ext.flutter.screenshot is not registered on this device. Use Peekaboo or chrome-devtools-mcp to capture the window instead."
}
```

So the agent gets a structured failure with an actionable hint — it
doesn't crash, just knows to fall through to an external tool.

## Pairing recommendations

When the user's environment is macOS desktop and they want visual
verification:

- **[Peekaboo](https://github.com/steipete/Peekaboo)** — drives any
  visible macOS window via accessibility APIs. Best for native + Flutter
  desktop apps. Has its own MCP wrapper.
- **[chrome-devtools-mcp](https://github.com/cnove/chrome-devtools-mcp)** —
  only useful for Flutter-web running in Chrome; for native Flutter
  desktop, doesn't apply.

Pair them like this:

```
agentic-rc-mcp  → drive the app (tap, enter_text, read state)
peekaboo        → screenshot the rendered window when needed
```

The agent reads state mostly through `rc_flutter_widget_properties`
(text content, callbacks, layout) — actual visual screenshots are
needed only when verifying purely-visual properties (colours, alignment,
spacing) that aren't reflected in widget properties.

## Future: native screenshot fallback

If we want native macOS screenshots in the future without an external
MCP, the cleanest path is `CGWindowListCreateImage` via FFI in a
helper extension. Out of scope for v0.5.0.

## How to test on a fresh platform

```
rc_flutter_screenshot { session_id, save_to: "/tmp/probe.png" }
```

If `success: true` — extension works. If `success: false, reason: "extension_not_registered"`
— platform is in the broken list above. If `success: false` with
different reason — different bug; investigate.
