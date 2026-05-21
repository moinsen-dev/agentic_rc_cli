/**
 * Minimal Dart VM Service client.
 *
 * The Dart VM Service is JSON-RPC 2.0 over WebSocket. Flutter's `flutter run`
 * spawns it automatically and prints the endpoint URL — we get the URL from
 * the FlutterEndpointSniffer, and use this client to:
 *
 *   - call methods (getVM, evaluate, callServiceExtension, …)
 *   - subscribe to streams (Stdout, Stderr, Logging, Debug, Extension)
 *
 * We deliberately implement just enough of the protocol to support the
 * higher-level FlutterService helpers in flutter_service.ts. The full Dart VM
 * Service API is documented at
 *   https://github.com/dart-lang/sdk/blob/main/runtime/vm/service/service.md
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";

export interface VmServiceEvent {
  streamId: string;
  event: Record<string, unknown>;
}

export type VmServiceEventListener = (ev: VmServiceEvent) => void;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class VmServiceClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private subscribedStreams = new Set<string>();
  private _connected = false;
  private _closed = false;
  private connectError: Error | null = null;

  constructor(public readonly url: string) {
    super();
  }

  get connected(): boolean {
    return this._connected;
  }

  get closed(): boolean {
    return this._closed;
  }

  async connect(timeoutMs = 10_000): Promise<void> {
    if (this._connected) return;
    if (this._closed) throw new Error("VmServiceClient is closed");

    const ws = new WebSocket(this.url);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`VM service WebSocket connect timed out after ${timeoutMs} ms`));
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }, timeoutMs);

      ws.once("open", () => {
        clearTimeout(timer);
        this._connected = true;
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        this.connectError = err instanceof Error ? err : new Error(String(err));
        reject(this.connectError);
      });
    });

    ws.on("message", (data) => {
      this.onMessage(data.toString("utf8"));
    });
    ws.on("close", () => {
      this._connected = false;
      this._closed = true;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error("VM service WebSocket closed"));
      }
      this.pending.clear();
      this.emit("close");
    });
    ws.on("error", (err) => {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    });
  }

  async close(): Promise<void> {
    if (!this.ws) return;
    this._closed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  /**
   * Send a JSON-RPC method call. Throws on RPC error or timeout.
   */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    if (!this._connected || !this.ws) {
      throw new Error("VmServiceClient is not connected");
    }
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`VM service call ${method} (id=${id}) timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      this.ws!.send(frame, (err?: Error) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * Subscribe to a VM service stream (Stdout, Stderr, Logging, Debug,
   * Isolate, VM, Extension). Idempotent — repeated calls are no-ops.
   */
  async streamListen(streamId: string): Promise<void> {
    if (this.subscribedStreams.has(streamId)) return;
    try {
      await this.call("streamListen", { streamId });
      this.subscribedStreams.add(streamId);
    } catch (err) {
      // "Stream already subscribed" comes back as error code 103. Treat it as success.
      const msg = err instanceof Error ? err.message : String(err);
      if (/103|already subscribed/i.test(msg)) {
        this.subscribedStreams.add(streamId);
        return;
      }
      throw err;
    }
  }

  /** Register an event listener for a specific stream. */
  onEvent(streamId: string, listener: VmServiceEventListener): () => void {
    const wrapped = (ev: VmServiceEvent) => {
      if (ev.streamId === streamId) listener(ev);
    };
    this.on("event", wrapped);
    return () => this.off("event", wrapped);
  }

  private onMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    const m = msg as {
      id?: number;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
      method?: string;
      params?: { streamId: string; event: Record<string, unknown> };
    };
    if (typeof m.id === "number") {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) {
        p.reject(new Error(`VM service RPC error ${m.error.code}: ${m.error.message}`));
      } else {
        p.resolve(m.result);
      }
      return;
    }
    // Notification: typically method === "streamNotify".
    if (m.method === "streamNotify" && m.params) {
      this.emit("event", { streamId: m.params.streamId, event: m.params.event } satisfies VmServiceEvent);
    }
  }

  get lastConnectError(): Error | null {
    return this.connectError;
  }
}
