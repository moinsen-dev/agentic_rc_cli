/**
 * High-level Flutter helpers built on top of the generic VmServiceClient.
 *
 * Methods exposed:
 *   - mainIsolateId()            — find the running Flutter app's main isolate
 *   - hotReload()                — programmatic hot reload (reload sources + reassemble)
 *   - evaluate(expression)       — run Dart in the main isolate's context
 *   - screenshot()               — base64 PNG of the rendered Flutter window
 *   - errors buffer              — Stderr + Extension/Flutter.Error events get
 *                                  pushed into a bounded ring buffer and can be
 *                                  drained on demand by the agent.
 *   - logs buffer                — Stdout events, same ring-buffer pattern.
 */
import { VmServiceClient } from "./vm_service.js";
import { WidgetInspector } from "./inspector.js";

export interface FlutterErrorEvent {
  /** ISO timestamp when this client observed the event. */
  timestamp: string;
  /** Origin stream: "Stderr" | "Extension" | "Logging" */
  stream: string;
  /** Human-readable message extracted from the event. */
  message: string;
  /** Original raw event payload — keep available for deep inspection. */
  raw: Record<string, unknown>;
}

export interface FlutterLogEvent {
  timestamp: string;
  stream: string;
  message: string;
}

interface IsolateRef {
  type?: string;
  id?: string;
  name?: string;
}

interface VmGetVMResult {
  isolates?: IsolateRef[];
}

interface IsolateResult {
  id?: string;
  name?: string;
  rootLib?: { uri?: string };
}

interface ReloadReportResult {
  type?: string;
  success?: boolean;
  notices?: Array<{ message?: string }>;
}

function decodeBytes(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object" && "bytes" in (payload as Record<string, unknown>)) {
    const b = (payload as { bytes: unknown }).bytes;
    if (typeof b === "string") {
      try {
        return Buffer.from(b, "base64").toString("utf8");
      } catch {
        return b;
      }
    }
  }
  return "";
}

const ERROR_BUFFER_LIMIT = 500;
const LOG_BUFFER_LIMIT = 500;

export class FlutterService {
  private cachedMainIsolateId: string | null = null;
  private errorBuffer: FlutterErrorEvent[] = [];
  private logBuffer: FlutterLogEvent[] = [];
  private unsubscribers: Array<() => void> = [];
  private subscribed = false;
  private _inspector: WidgetInspector | null = null;

  constructor(private readonly client: VmServiceClient) {}

  get vmClient(): VmServiceClient {
    return this.client;
  }

  /** Lazy-initialised widget inspector for this session. */
  get inspector(): WidgetInspector {
    if (!this._inspector) {
      this._inspector = new WidgetInspector(this.client, () => this.mainIsolateId());
    }
    return this._inspector;
  }

  async ensureSubscribed(): Promise<void> {
    if (this.subscribed) return;
    // Errors come via Stderr + Extension (Flutter framework errors are posted
    // as Extension events with kind "Flutter.Error" or "Flutter.Frame").
    // Stdout is logs. Debug carries pause / exception events.
    await this.client.streamListen("Stderr");
    await this.client.streamListen("Stdout");
    await this.client.streamListen("Extension");
    await this.client.streamListen("Logging");
    await this.client.streamListen("Debug");

    this.unsubscribers.push(
      this.client.onEvent("Stderr", (ev) => {
        const text = decodeBytes(ev.event["bytes"] ?? ev.event["logRecord"] ?? "");
        this.pushError({ stream: "Stderr", message: text, raw: ev.event });
      }),
    );
    this.unsubscribers.push(
      this.client.onEvent("Stdout", (ev) => {
        const text = decodeBytes(ev.event["bytes"] ?? "");
        if (text.trim().length) {
          this.pushLog({ stream: "Stdout", message: text });
        }
      }),
    );
    this.unsubscribers.push(
      this.client.onEvent("Logging", (ev) => {
        const rec = ev.event["logRecord"] as Record<string, unknown> | undefined;
        if (!rec) return;
        const message = typeof rec.message === "object" ? JSON.stringify(rec.message) : String(rec.message ?? "");
        const level = typeof rec.level === "number" ? rec.level : 0;
        const entry: FlutterLogEvent = { stream: "Logging", message, timestamp: new Date().toISOString() };
        this.logBuffer.push(entry);
        if (this.logBuffer.length > LOG_BUFFER_LIMIT) {
          this.logBuffer.shift();
        }
        // Treat WARNING (900) and above as errors as well.
        if (level >= 900) {
          this.pushError({ stream: "Logging", message, raw: rec });
        }
      }),
    );
    this.unsubscribers.push(
      this.client.onEvent("Extension", (ev) => {
        const kind = ev.event["extensionKind"];
        const data = ev.event["extensionData"] as Record<string, unknown> | undefined;
        if (kind === "Flutter.Error") {
          const summary =
            (data?.["renderedErrorText"] as string | undefined) ??
            (data?.["description"] as string | undefined) ??
            (data?.["exception"] as string | undefined) ??
            "Flutter.Error";
          this.pushError({ stream: "Extension", message: summary, raw: ev.event });
        }
      }),
    );
    this.unsubscribers.push(
      this.client.onEvent("Debug", (ev) => {
        const kind = ev.event["kind"];
        if (kind === "PauseException") {
          const exc = ev.event["exception"] as Record<string, unknown> | undefined;
          const cls = (exc?.["class"] as { name?: string } | undefined)?.name ?? "Exception";
          const msg = (exc?.["valueAsString"] as string | undefined) ?? "(unknown)";
          this.pushError({ stream: "Debug", message: `${cls}: ${msg}`, raw: ev.event });
        }
      }),
    );

    this.subscribed = true;
  }

  private pushError(partial: Omit<FlutterErrorEvent, "timestamp">): void {
    this.errorBuffer.push({ ...partial, timestamp: new Date().toISOString() });
    if (this.errorBuffer.length > ERROR_BUFFER_LIMIT) {
      this.errorBuffer.shift();
    }
  }

  private pushLog(partial: Omit<FlutterLogEvent, "timestamp">): void {
    this.logBuffer.push({ ...partial, timestamp: new Date().toISOString() });
    if (this.logBuffer.length > LOG_BUFFER_LIMIT) {
      this.logBuffer.shift();
    }
  }

  /**
   * Return + clear the buffered errors. Use this as the agent's "did anything
   * go wrong since I last looked?" loop step.
   */
  drainErrors(): FlutterErrorEvent[] {
    const out = this.errorBuffer;
    this.errorBuffer = [];
    return out;
  }

  drainLogs(): FlutterLogEvent[] {
    const out = this.logBuffer;
    this.logBuffer = [];
    return out;
  }

  /** Cached after first lookup. */
  async mainIsolateId(): Promise<string> {
    if (this.cachedMainIsolateId) return this.cachedMainIsolateId;
    const vm = (await this.client.call("getVM")) as VmGetVMResult;
    const main = vm.isolates?.find((i) => /^main$/i.test(i.name ?? "")) ?? vm.isolates?.[0];
    if (!main?.id) throw new Error("No isolates running on the VM");
    this.cachedMainIsolateId = main.id;
    return main.id;
  }

  async hotReload(): Promise<{ success: boolean; notices: string[] }> {
    const isolateId = await this.mainIsolateId();
    const report = (await this.client.call("reloadSources", { isolateId, force: false })) as ReloadReportResult;
    // Flutter framework hook to rebuild the widget tree after sources change.
    if (report.success !== false) {
      try {
        await this.client.call("ext.flutter.reassemble", { isolateId });
      } catch {
        // Some non-Flutter dart apps don't have the extension — ignore.
      }
    }
    return {
      success: report.success !== false,
      notices: (report.notices ?? []).map((n) => n.message ?? "").filter(Boolean),
    };
  }

  /** Evaluate an expression in the main isolate's root library scope. */
  async evaluate(expression: string): Promise<{ kind: string; valueAsString: string | null; raw: Record<string, unknown> }> {
    const isolateId = await this.mainIsolateId();
    const iso = (await this.client.call("getIsolate", { isolateId })) as IsolateResult & { rootLib?: { id?: string } };
    const targetId = iso.rootLib?.id;
    if (!targetId) throw new Error("Cannot find isolate rootLib");
    const result = (await this.client.call("evaluate", {
      isolateId,
      targetId,
      expression,
    })) as Record<string, unknown>;
    return {
      kind: String(result["type"] ?? result["kind"] ?? ""),
      valueAsString: typeof result["valueAsString"] === "string" ? (result["valueAsString"] as string) : null,
      raw: result,
    };
  }

  async screenshot(): Promise<{ format: string; base64: string }> {
    const isolateId = await this.mainIsolateId();
    const result = (await this.client.call("ext.flutter.screenshot", { isolateId })) as {
      screenshot?: string;
      type?: string;
    };
    if (!result.screenshot) {
      throw new Error("ext.flutter.screenshot returned no data — is the Flutter framework attached?");
    }
    return { format: "png", base64: result.screenshot };
  }

  async dispose(): Promise<void> {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    if (this._inspector) await this._inspector.dispose();
    await this.client.close();
  }
}
