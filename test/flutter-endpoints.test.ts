import { describe, it, expect } from "vitest";
import { FlutterEndpointSniffer } from "../src/flutter/endpoints.js";

const REAL_FLUTTER_OUTPUT = `
Launching lib/main.dart on Chrome in debug mode...
Waiting for connection from debug service on Chrome...              8,4s

Flutter run key commands.
r Hot reload. 🔥🔥🔥
R Hot restart.
q Quit (terminate the application on the device).

This app is linked to the debug service: ws://127.0.0.1:50349/Vd8JemZbOxg=/ws
Debug service listening on ws://127.0.0.1:50349/Vd8JemZbOxg=/ws
A Dart VM Service on Chrome is available at: http://127.0.0.1:50349/Vd8JemZbOxg=
The Flutter DevTools debugger and profiler on Chrome is available at:
http://127.0.0.1:50349/Vd8JemZbOxg=/devtools/?uri=ws://127.0.0.1:50349/Vd8JemZbOxg=/ws
Starting application from main method in: org-dartlang-app:/web_entrypoint.dart.
`;

describe("FlutterEndpointSniffer", () => {
  it("extracts all three URLs from real flutter-run output", () => {
    const s = new FlutterEndpointSniffer();
    s.feed(REAL_FLUTTER_OUTPUT);
    const e = s.current;

    expect(e.vm_service_ws).toBe("ws://127.0.0.1:50349/Vd8JemZbOxg=/ws");
    expect(e.vm_service_http).toBe("http://127.0.0.1:50349/Vd8JemZbOxg=");
    expect(e.devtools_url).toBe(
      "http://127.0.0.1:50349/Vd8JemZbOxg=/devtools/?uri=ws://127.0.0.1:50349/Vd8JemZbOxg=/ws",
    );
    expect(e.host).toBe("127.0.0.1");
    expect(e.port).toBe(50349);
    expect(s.allFound()).toBe(true);
  });

  it("survives the DevTools URL being wrapped across two lines", () => {
    const wrapped =
      "The Flutter DevTools debugger and profiler on macOS is available at:\n" +
      "  http://127.0.0.1:60001/abc=/devtools/?uri=ws://127.0.0.1:60001/abc=/ws\n";
    const s = new FlutterEndpointSniffer();
    s.feed(wrapped);
    expect(s.current.devtools_url).toBe(
      "http://127.0.0.1:60001/abc=/devtools/?uri=ws://127.0.0.1:60001/abc=/ws",
    );
  });

  it("survives the output arriving in many small chunks", () => {
    const s = new FlutterEndpointSniffer();
    for (const ch of REAL_FLUTTER_OUTPUT) s.feed(ch);
    expect(s.allFound()).toBe(true);
    expect(s.current.vm_service_ws).toMatch(/^ws:\/\//);
  });

  it("ignores ANSI color codes", () => {
    const colored =
      "\x1b[32mDebug service listening on \x1b[0mws://127.0.0.1:9999/x=/ws";
    const s = new FlutterEndpointSniffer();
    s.feed(colored);
    expect(s.current.vm_service_ws).toBe("ws://127.0.0.1:9999/x=/ws");
  });

  it("starts empty", () => {
    const s = new FlutterEndpointSniffer();
    const e = s.current;
    expect(e.vm_service_ws).toBeNull();
    expect(e.vm_service_http).toBeNull();
    expect(e.devtools_url).toBeNull();
    expect(s.hasAny()).toBe(false);
    expect(s.allFound()).toBe(false);
  });

  it("derives the ws URL from the DevTools URL when Flutter omits the ws line (macOS desktop)", () => {
    // Real macOS desktop output — only http + devtools, no "Debug service listening on ws://".
    const macOsOutput = `
A Dart VM Service on macOS is available at: http://127.0.0.1:51169/YXKo5QoD05E=/
The Flutter DevTools debugger and profiler on macOS is available at:
http://127.0.0.1:51169/YXKo5QoD05E=/devtools/?uri=ws://127.0.0.1:51169/YXKo5QoD05E=/ws
`;
    const s = new FlutterEndpointSniffer();
    s.feed(macOsOutput);
    expect(s.current.vm_service_ws).toBe("ws://127.0.0.1:51169/YXKo5QoD05E=/ws");
    expect(s.current.vm_service_http).toBe("http://127.0.0.1:51169/YXKo5QoD05E=/");
    expect(s.allFound()).toBe(true);
  });

  it("synthesises the ws URL from http when DevTools URL is missing", () => {
    const minimal =
      "A Dart VM Service on iPhone is available at: http://127.0.0.1:8181/abc123=/";
    const s = new FlutterEndpointSniffer();
    s.feed(minimal);
    expect(s.current.vm_service_ws).toBe("ws://127.0.0.1:8181/abc123=/ws");
  });
});
