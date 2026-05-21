import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { Terminal as ITerminal } from "@xterm/headless";
import { spawn as ptySpawn, type IPty } from "node-pty";
import type { SessionId, SessionStatus, SessionInfo, SpawnOptions } from "./types.js";
import { FlutterEndpointSniffer, type FlutterEndpoints } from "./flutter/endpoints.js";
import { VmServiceClient } from "./flutter/vm_service.js";
import { FlutterService } from "./flutter/flutter_service.js";

// @xterm/headless is published as CJS without a real ESM facade, so the only
// reliable cross-runtime import (Node 20+ and vitest) is to require it.
const xtermRequire = createRequire(import.meta.url);
const { Terminal } = xtermRequire("@xterm/headless") as {
  Terminal: new (opts: Record<string, unknown>) => ITerminal;
};

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const DEFAULT_SCROLLBACK = 5000;
const DEFAULT_RAW_BUFFER_BYTES = 1_048_576; // 1 MiB

// Strip ANSI escape sequences for plain-text rendering of the raw stream.
// Reasonably comprehensive: CSI, OSC, simple ESC sequences, and a few cursor controls.
const ANSI_REGEX =
  // eslint-disable-next-line no-control-regex
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[\[\(]?[0-?]*[ -/]*[@-~]|\x1b[=>78cDEHMNOZ]/g;

export interface SessionEvents {
  data: (chunk: string) => void;
  exit: (info: { exitCode: number; signal: number | null }) => void;
}

let nextSequence = 1;

function nextSessionName(command: string): string {
  const base = command.split("/").pop()?.split(/\s+/)[0] ?? "session";
  const safe = base.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `${safe}-${nextSequence++}`;
}

export class Session extends EventEmitter {
  readonly id: SessionId;
  readonly name: string;
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  readonly startedAt: string;

  private pty: IPty;
  private term: ITerminal;
  private rawBuffer: string = "";
  private rawDroppedBytes = 0;
  private totalBytesRead = 0;
  private totalBytesWritten = 0;
  private maxRawBufferBytes: number;
  private _status: SessionStatus = "running";
  private _exitCode: number | null = null;
  private _cols: number;
  private _rows: number;
  private flutterSniffer = new FlutterEndpointSniffer();
  private _flutterService: FlutterService | null = null;
  private _flutterServiceConnecting: Promise<FlutterService> | null = null;

  constructor(opts: SpawnOptions) {
    super();
    this.id = randomUUID().slice(0, 8);
    this.name = opts.name ?? nextSessionName(opts.command);
    this.command = opts.command;
    this.args = opts.args ?? [];
    this.cwd = opts.cwd ?? process.cwd();
    this._cols = opts.cols ?? DEFAULT_COLS;
    this._rows = opts.rows ?? DEFAULT_ROWS;
    this.maxRawBufferBytes = DEFAULT_RAW_BUFFER_BYTES;
    this.startedAt = new Date().toISOString();

    this.term = new Terminal({
      cols: this._cols,
      rows: this._rows,
      scrollback: DEFAULT_SCROLLBACK,
      allowProposedApi: true,
    });

    const env = { ...process.env, ...(opts.env ?? {}) } as Record<string, string>;
    // node-pty wants TERM set; "xterm-256color" matches what xterm.js emulates.
    if (!env.TERM) env.TERM = "xterm-256color";

    this.pty = ptySpawn(this.command, this.args, {
      name: env.TERM,
      cols: this._cols,
      rows: this._rows,
      cwd: this.cwd,
      env,
    });

    this.pty.onData((chunk: string) => {
      this.term.write(chunk);
      this.totalBytesRead += Buffer.byteLength(chunk, "utf8");
      this.appendRaw(chunk);
      this.flutterSniffer.feed(chunk);
      this.emit("data", chunk);
    });

    this.pty.onExit(({ exitCode, signal }) => {
      this._exitCode = exitCode;
      // If we explicitly killed, leave status as "killed"; otherwise mark exited.
      if (this._status !== "killed") {
        this._status = "exited";
      }
      // Tear down any VM-service connection so we don't leak sockets.
      void this._flutterService?.dispose().catch(() => undefined);
      this._flutterService = null;
      this.emit("exit", { exitCode, signal: signal ?? null });
    });
  }

  private appendRaw(chunk: string): void {
    this.rawBuffer += chunk;
    const overflow = Buffer.byteLength(this.rawBuffer, "utf8") - this.maxRawBufferBytes;
    if (overflow > 0) {
      // Drop from the front in approximate byte amounts.
      // Walk forward by character until we've dropped >= overflow bytes.
      let dropped = 0;
      let i = 0;
      while (i < this.rawBuffer.length && dropped < overflow) {
        const ch = this.rawBuffer.charCodeAt(i);
        dropped += ch < 0x80 ? 1 : ch < 0x800 ? 2 : 3;
        i++;
      }
      this.rawBuffer = this.rawBuffer.slice(i);
      this.rawDroppedBytes += dropped;
    }
  }

  write(data: string): number {
    if (this._status !== "running") {
      throw new Error(`Session ${this.id} is not running (status=${this._status})`);
    }
    this.pty.write(data);
    const bytes = Buffer.byteLength(data, "utf8");
    this.totalBytesWritten += bytes;
    return bytes;
  }

  resize(cols: number, rows: number): void {
    if (this._status !== "running") {
      throw new Error(`Session ${this.id} is not running (status=${this._status})`);
    }
    this._cols = cols;
    this._rows = rows;
    this.term.resize(cols, rows);
    this.pty.resize(cols, rows);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    // Idempotent: allow re-signaling (e.g. SIGTERM → SIGKILL escalation) as
    // long as the OS still considers the process alive. Only short-circuit
    // once we've observed the actual exit.
    if (this._status === "exited") return;
    if (this._status === "running") this._status = "killed";
    try {
      this.pty.kill(signal);
    } catch {
      // Process may already be gone.
    }
  }

  /**
   * Returns the visible screen as a string of `rows` lines, with embedded
   * newlines and trailing whitespace trimmed per line. Empty trailing lines
   * are kept so the cursor row is always identifiable.
   */
  readScreen(): { text: string; cursor: { row: number; col: number }; rows: number; cols: number } {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < this._rows; y++) {
      const line = buf.getLine(buf.baseY + y);
      lines.push(line ? line.translateToString(true) : "");
    }
    return {
      text: lines.join("\n"),
      cursor: { row: buf.cursorY, col: buf.cursorX },
      rows: this._rows,
      cols: this._cols,
    };
  }

  /**
   * Returns the entire scrollback (including the visible viewport).
   */
  readScrollback(): string {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : "");
    }
    // Trim trailing empty lines for readability.
    while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }

  /**
   * Returns the last `tailLines` non-empty-or-cursor-line lines of the
   * combined scrollback + screen.
   */
  readTail(tailLines: number): string {
    const all = this.readScrollback().split("\n");
    return all.slice(-tailLines).join("\n");
  }

  /**
   * Returns raw bytes (as UTF-8 text) since the caller's cursor. The cursor
   * is the absolute byte offset into the stream from the start of the
   * session. If part of the requested range has been dropped from the ring
   * buffer, `dropped_bytes` is non-zero and the returned text starts at the
   * earliest still-buffered byte.
   */
  readStream(opts: {
    sinceCursor?: number;
    maxBytes?: number;
    stripAnsi?: boolean;
  }): { text: string; newCursor: number; droppedBytes: number } {
    const since = opts.sinceCursor ?? this.rawDroppedBytes;
    const startAbs = Math.max(since, this.rawDroppedBytes);
    const dropped = Math.max(0, this.rawDroppedBytes - since);

    // Convert absolute byte offset into a character offset inside rawBuffer.
    let bufByteOffset = 0;
    let charOffset = 0;
    const targetByteOffset = startAbs - this.rawDroppedBytes;
    while (charOffset < this.rawBuffer.length && bufByteOffset < targetByteOffset) {
      const ch = this.rawBuffer.charCodeAt(charOffset);
      bufByteOffset += ch < 0x80 ? 1 : ch < 0x800 ? 2 : 3;
      charOffset++;
    }

    let slice = this.rawBuffer.slice(charOffset);
    const maxBytes = opts.maxBytes ?? 65536;
    if (Buffer.byteLength(slice, "utf8") > maxBytes) {
      // Truncate to maxBytes by char-walking.
      let bytes = 0;
      let i = 0;
      while (i < slice.length && bytes < maxBytes) {
        const ch = slice.charCodeAt(i);
        const adv = ch < 0x80 ? 1 : ch < 0x800 ? 2 : 3;
        if (bytes + adv > maxBytes) break;
        bytes += adv;
        i++;
      }
      slice = slice.slice(0, i);
    }

    const consumedBytes = Buffer.byteLength(slice, "utf8");
    const stripAnsi = opts.stripAnsi ?? true;
    const text = stripAnsi ? stripAnsiCodes(slice) : slice;

    return {
      text,
      newCursor: startAbs + consumedBytes,
      droppedBytes: dropped,
    };
  }

  get status(): SessionStatus {
    return this._status;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get pid(): number {
    return this.pty.pid;
  }

  get cols(): number {
    return this._cols;
  }

  get rows(): number {
    return this._rows;
  }

  get streamTotalBytes(): number {
    return this.totalBytesRead;
  }

  get bytesWritten(): number {
    return this.totalBytesWritten;
  }

  /** Snapshot of Flutter debug-service endpoints scraped from the PTY output. */
  get flutterEndpoints(): FlutterEndpoints {
    return this.flutterSniffer.current;
  }

  hasFlutterEndpoints(): boolean {
    return this.flutterSniffer.hasAny();
  }

  /** True iff the VM-service WebSocket has been opened and is alive. */
  get flutterServiceConnected(): boolean {
    return this._flutterService?.vmClient.connected === true;
  }

  /**
   * Wait until the sniffer has detected at least the VM-service WebSocket URL,
   * or reject on timeout / session exit.
   */
  async waitForFlutterEndpoint(timeoutMs = 180_000): Promise<FlutterEndpoints> {
    if (this.flutterSniffer.current.vm_service_ws) return this.flutterSniffer.current;
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const tick = (): void => {
        if (this._status !== "running") {
          reject(new Error(`Session exited before Flutter endpoint appeared (status=${this._status})`));
          return;
        }
        if (this.flutterSniffer.current.vm_service_ws) {
          resolve(this.flutterSniffer.current);
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out after ${timeoutMs} ms waiting for Flutter debug endpoint`));
          return;
        }
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  /**
   * Connects to the Dart VM Service (lazily) and returns a FlutterService.
   * Idempotent: subsequent calls return the cached instance.
   */
  async ensureFlutterService(opts: { waitForEndpointMs?: number; subscribe?: boolean } = {}): Promise<FlutterService> {
    if (this._flutterService) return this._flutterService;
    if (this._flutterServiceConnecting) return this._flutterServiceConnecting;
    const waitMs = opts.waitForEndpointMs ?? 180_000;
    const subscribe = opts.subscribe ?? true;
    this._flutterServiceConnecting = (async () => {
      const endpoints = await this.waitForFlutterEndpoint(waitMs);
      const wsUrl = endpoints.vm_service_ws;
      if (!wsUrl) throw new Error("VM service WebSocket URL missing");
      const client = new VmServiceClient(wsUrl);
      await client.connect();
      const svc = new FlutterService(client);
      if (subscribe) await svc.ensureSubscribed();
      this._flutterService = svc;
      this._flutterServiceConnecting = null;
      return svc;
    })();
    try {
      return await this._flutterServiceConnecting;
    } catch (err) {
      this._flutterServiceConnecting = null;
      throw err;
    }
  }

  flutterServiceOrNull(): FlutterService | null {
    return this._flutterService;
  }

  info(): SessionInfo {
    return {
      id: this.id,
      name: this.name,
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      pid: this.pid,
      status: this._status,
      exit_code: this._exitCode,
      started_at: this.startedAt,
      rows: this._rows,
      cols: this._cols,
      bytes_written: this.totalBytesWritten,
      bytes_read: this.totalBytesRead,
      flutter: this.flutterSniffer.hasAny() ? this.flutterSniffer.current : null,
    };
  }
}

export function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_REGEX, "");
}
