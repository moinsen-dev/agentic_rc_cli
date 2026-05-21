/**
 * Parses the URLs Flutter prints to its console when it spawns a debug build.
 * Typical output (Chrome example):
 *
 *   Debug service listening on ws://127.0.0.1:50349/Vd8JemZbOxg=/ws
 *   This app is linked to the debug service: ws://127.0.0.1:50349/Vd8JemZbOxg=/ws
 *   A Dart VM Service on Chrome is available at: http://127.0.0.1:50349/Vd8JemZbOxg=
 *   The Flutter DevTools debugger and profiler on Chrome is available at:
 *   http://127.0.0.1:50349/Vd8JemZbOxg=/devtools/?uri=ws://127.0.0.1:50349/Vd8JemZbOxg=/ws
 *
 * We accumulate raw bytes (after ANSI stripping) and regex-scan for each URL
 * type. First match wins (Flutter sometimes prints the same URL twice). The
 * sniffer is line-tolerant: the DevTools URL on macOS is often split across
 * two console lines after a soft-wrap, so we strip newlines before matching.
 */

export interface FlutterEndpoints {
  vm_service_ws: string | null;
  vm_service_http: string | null;
  devtools_url: string | null;
  // Convenience: the host:port shared by all of the above.
  host: string | null;
  port: number | null;
  /** When the first URL was observed (ms since session start). */
  detected_at_ms: number | null;
}

// xterm.js / terminal renderers sometimes inject literal " \r\n" between chars
// when the line wraps. Normalize to a single buffer with newlines collapsed
// to single spaces — URLs never contain whitespace anyway.
function normalize(buf: string): string {
  return buf.replace(/\s+/g, " ");
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export class FlutterEndpointSniffer {
  private buffer = "";
  private startedAt = Date.now();
  private endpoints: FlutterEndpoints = {
    vm_service_ws: null,
    vm_service_http: null,
    devtools_url: null,
    host: null,
    port: null,
    detected_at_ms: null,
  };
  /** Limit the rolling buffer so a long-running app doesn't grow unbounded. */
  private static readonly MAX_BUFFER = 64 * 1024;

  feed(chunk: string): void {
    // Strip ANSI so the regex doesn't trip on color codes.
    const cleaned = chunk.replace(ANSI, "");
    this.buffer += cleaned;
    if (this.buffer.length > FlutterEndpointSniffer.MAX_BUFFER) {
      this.buffer = this.buffer.slice(-FlutterEndpointSniffer.MAX_BUFFER);
    }
    this.tryExtract();
  }

  private tryExtract(): void {
    if (this.allFound()) return;
    const text = normalize(this.buffer);

    if (!this.endpoints.vm_service_ws) {
      // Multiple phrasings depending on device:
      //   Chrome: "Debug service listening on ws://…"
      //   Chrome: "This app is linked to the debug service: ws://…"
      // macOS desktop / iOS Simulator only print the http variant + the
      // DevTools URL — we fall back to those further down.
      const m =
        text.match(/Debug service listening on (ws:\/\/[\w.:\-]+:\d+\/[^\s]+)/) ??
        text.match(/linked to the debug service:\s*(ws:\/\/[\w.:\-]+:\d+\/[^\s]+)/);
      if (m) this.recordMatch("vm_service_ws", m[1]);
    }

    if (!this.endpoints.vm_service_http) {
      // "A Dart VM Service on <device> is available at: <http-url>"
      const m = text.match(
        /Dart VM Service on [^\s].*?available at:\s*(https?:\/\/[\w.:\-]+:\d+\/[^\s]*)/,
      );
      if (m) this.recordMatch("vm_service_http", m[1]);
    }

    if (!this.endpoints.devtools_url) {
      // The DevTools URL can wrap across lines, hence the normalize() above.
      const m = text.match(
        /(https?:\/\/[\w.:\-]+:\d+\/[^\s]*\/devtools\/\?uri=ws:\/\/[\w.:\-]+:\d+\/[^\s]+)/,
      );
      if (m) this.recordMatch("devtools_url", m[1]);
    }

    // Cross-derive missing URLs from the ones we do have.
    // Order matters: do this after the regex pass so an explicit ws-line
    // takes precedence over a synthesised one.
    if (!this.endpoints.vm_service_ws) {
      // (a) Extract from DevTools URL's ?uri= query param.
      if (this.endpoints.devtools_url) {
        const m = this.endpoints.devtools_url.match(/[?&]uri=(ws:\/\/[\w.:\-]+:\d+\/[^\s&]+)/);
        if (m) this.endpoints.vm_service_ws = decodeURIComponent(m[1]);
      }
      // (b) Synthesise from http URL: replace scheme + ensure trailing /ws.
      if (!this.endpoints.vm_service_ws && this.endpoints.vm_service_http) {
        let ws = this.endpoints.vm_service_http.replace(/^http/, "ws");
        if (!ws.endsWith("/ws")) ws = ws.replace(/\/?$/, "/ws");
        this.endpoints.vm_service_ws = ws;
      }
      if (this.endpoints.vm_service_ws && this.endpoints.detected_at_ms === null) {
        this.endpoints.detected_at_ms = Date.now() - this.startedAt;
      }
    }
    if (!this.endpoints.vm_service_http && this.endpoints.devtools_url) {
      // The /devtools/ prefix sits *after* the base URL, so cut at that boundary.
      const m = this.endpoints.devtools_url.match(/^(https?:\/\/[\w.:\-]+:\d+\/[^\s]*?\/)devtools\//);
      if (m) this.endpoints.vm_service_http = m[1];
    }

    // Derive host + port from whichever URL we have.
    const seedUrl =
      this.endpoints.vm_service_ws ??
      this.endpoints.vm_service_http ??
      this.endpoints.devtools_url;
    if (seedUrl && (this.endpoints.host == null || this.endpoints.port == null)) {
      const m = seedUrl.match(/\/\/([\w.\-]+):(\d+)\//);
      if (m) {
        this.endpoints.host = m[1];
        this.endpoints.port = parseInt(m[2], 10);
      }
    }
  }

  private recordMatch(key: "vm_service_ws" | "vm_service_http" | "devtools_url", value: string): void {
    this.endpoints[key] = value;
    if (this.endpoints.detected_at_ms === null) {
      this.endpoints.detected_at_ms = Date.now() - this.startedAt;
    }
  }

  get current(): FlutterEndpoints {
    return { ...this.endpoints };
  }

  allFound(): boolean {
    return (
      this.endpoints.vm_service_ws !== null &&
      this.endpoints.vm_service_http !== null &&
      this.endpoints.devtools_url !== null
    );
  }

  hasAny(): boolean {
    return this.endpoints.vm_service_ws !== null || this.endpoints.vm_service_http !== null;
  }
}
