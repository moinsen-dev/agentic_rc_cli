# Flutter debug-endpoint sniffing — Chrome vs macOS vs iOS

`flutter run` prints different URL strings depending on the target
device. The sniffer in [`src/flutter/endpoints.ts`](../../src/flutter/endpoints.ts)
has to handle all variants — including the case where Flutter omits the
WebSocket URL entirely (it does, on macOS desktop).

## What each device prints

**Chrome (web)** — four lines, ws URL explicit:

```
This app is linked to the debug service: ws://127.0.0.1:50349/Vd8JemZbOxg=/ws
Debug service listening on ws://127.0.0.1:50349/Vd8JemZbOxg=/ws
A Dart VM Service on Chrome is available at: http://127.0.0.1:50349/Vd8JemZbOxg=
The Flutter DevTools debugger and profiler on Chrome is available at:
http://127.0.0.1:50349/Vd8JemZbOxg=/devtools/?uri=ws://127.0.0.1:50349/Vd8JemZbOxg=/ws
```

**macOS desktop** — only http + devtools URL, **no ws line**:

```
A Dart VM Service on macOS is available at: http://127.0.0.1:51169/YXKo5QoD05E=/
The Flutter DevTools debugger and profiler on macOS is available at:
http://127.0.0.1:51169/YXKo5QoD05E=/devtools/?uri=ws://127.0.0.1:51169/YXKo5QoD05E=/ws
```

**iOS Simulator / Android Emulator** — http URL with `iPhone` / `Android` in
the device-name slot, otherwise similar to macOS.

## How the sniffer copes

[`src/flutter/endpoints.ts`](../../src/flutter/endpoints.ts) runs three
independent regexes against an ANSI-stripped, whitespace-normalised
rolling buffer:

```ts
// vm_service_ws — first attempt: explicit ws line
text.match(/Debug service listening on (ws:\/\/[\w.:\-]+:\d+\/[^\s]+)/)
text.match(/linked to the debug service:\s*(ws:\/\/[\w.:\-]+:\d+\/[^\s]+)/)

// vm_service_http — works on every device
text.match(/Dart VM Service on [^\s].*?available at:\s*(https?:\/\/[\w.:\-]+:\d+\/[^\s]*)/)

// devtools_url — works on every device, URL may wrap across lines
text.match(/(https?:\/\/[\w.:\-]+:\d+\/[^\s]*\/devtools\/\?uri=ws:\/\/[\w.:\-]+:\d+\/[^\s]+)/)
```

## The synthesis fallback

For macOS / iOS / Android, the explicit `ws` line is absent — so after
the regex pass we cross-derive in priority order:

1. Extract `?uri=ws://…` from the DevTools URL (encoded query param,
   `decodeURIComponent` if needed). This is the **canonical** ws URL
   Flutter would have printed.
2. If no DevTools URL either, synthesise from http: replace `http://`
   with `ws://` and append `/ws`.

```ts
// in tryExtract(), after the regex pass:
if (!this.endpoints.vm_service_ws) {
  if (this.endpoints.devtools_url) {
    const m = this.endpoints.devtools_url.match(/[?&]uri=(ws:\/\/…)/);
    if (m) this.endpoints.vm_service_ws = decodeURIComponent(m[1]);
  }
  if (!this.endpoints.vm_service_ws && this.endpoints.vm_service_http) {
    let ws = this.endpoints.vm_service_http.replace(/^http/, "ws");
    if (!ws.endsWith("/ws")) ws = ws.replace(/\/?$/, "/ws");
    this.endpoints.vm_service_ws = ws;
  }
}
```

Both paths verified in `test/flutter-endpoints.test.ts`.

## When the sniffer breaks

If endpoints come back null and `flutter run` clearly printed something:
1. Check the test `test/flutter-endpoints.test.ts` reproduces what
   Flutter prints on your device — grab a snippet, add a test.
2. The buffer is capped at 64 KiB (rolling) to keep memory bounded.
   In theory Flutter prints the URL within the first few KiB; in
   practice we've never seen it not detected by the first 1 KiB.
3. Whitespace normalisation collapses `\s+` to single space — URLs
   don't contain whitespace so this is safe.

## Cross-derivation order matters

Don't synthesise BEFORE the regex pass — an explicit
"Debug service listening on ws://…" should win over a synthesised URL,
because Flutter is the source of truth. The current code respects this.
