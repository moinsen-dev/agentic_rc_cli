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
  private cachedEvalLibraryId: string | null = null;
  private cachedEvalLibraryUri: string | null = null;
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

  /**
   * Pick the library to use as `targetId` for `evaluate(...)` calls.
   *
   * The naive default (isolate's rootLib) works for `flutter run` on
   * macOS / iOS / Android — the rootLib is usually the user's main.dart
   * which imports material.dart, so framework types like `Element`,
   * `WidgetsBinding`, `FloatingActionButton` are all in scope.
   *
   * BUT Flutter Web sets the rootLib to a generated bootstrap
   * (`web_entrypoint.dart`) that does NOT import the framework directly.
   * The user's main.dart is only imported with a prefix, so framework
   * type identifiers don't resolve from that scope. Eval comes back with
   * RPC 113 "Expression compilation error" for every reference.
   *
   * We can't predict which library will work from outside, so we PROBE:
   * for each candidate library, try compiling the bare identifier
   * `Element`. First one that compiles wins. Cached for the session.
   *
   * Candidate order (most-likely-to-work first):
   *   rootLib                          — works on macOS/iOS/Android desktop
   *   package:flutter/material.dart    — works whenever a Material app
   *   package:flutter/widgets.dart     — pure-Widgets apps
   *   package:flutter/cupertino.dart   — Cupertino-only apps
   *
   * Compiles+caches in one round-trip on macOS, up to 4 on Web.
   */
  async evalTargetLibraryId(): Promise<string> {
    if (this.cachedEvalLibraryId) return this.cachedEvalLibraryId;
    const isolateId = await this.mainIsolateId();
    const iso = (await this.client.call("getIsolate", { isolateId })) as IsolateResult & {
      rootLib?: { id?: string };
      libraries?: Array<{ id?: string; uri?: string }>;
    };
    const candidates: Array<{ id: string; uri: string }> = [];
    if (iso.rootLib?.id) {
      candidates.push({ id: iso.rootLib.id, uri: "<rootLib>" });
    }
    const wantedUris = [
      "package:flutter/material.dart",
      "package:flutter/widgets.dart",
      "package:flutter/cupertino.dart",
    ];
    for (const uri of wantedUris) {
      const lib = iso.libraries?.find((l) => l.uri === uri);
      if (lib?.id) candidates.push({ id: lib.id, uri });
    }
    // Probe with `Element` — the lowest-common-denominator framework
    // identifier that every gesture / inspector tool references. If
    // Element resolves, all our other identifiers (Widget, WidgetsBinding,
    // *Button, GestureDetector, …) resolve too because they live in the
    // same library tree.
    const probeErrors: string[] = [];
    for (const cand of candidates) {
      try {
        // Important: the VM-service `evaluate` RPC does NOT throw on
        // compilation failures — it returns a regular response of shape
        // `{ type: "@Error", kind: "error", message: "..." }`. So we
        // must inspect the response, not rely on try/catch alone. Pre-
        // v0.6.2 we only had the catch, which meant the first candidate
        // (typically rootLib) always "won" silently and got cached even
        // when its scope couldn't resolve `Element` — and every gesture
        // tool then used the broken target.
        const r = (await this.client.call("evaluate", {
          isolateId,
          targetId: cand.id,
          expression: "Element",
        })) as Record<string, unknown>;
        const rType = r["type"];
        const rKind = r["kind"];
        if (rType === "@Error" || rType === "Error" || rKind === "error") {
          const msg = (r["message"] ?? r["valueAsString"] ?? "@Error")
            .toString()
            .replace(/\n/g, " ")
            .slice(0, 160);
          probeErrors.push(`${cand.uri}: ${msg}`);
          continue;
        }
        this.cachedEvalLibraryId = cand.id;
        this.cachedEvalLibraryUri = cand.uri;
        return cand.id;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        probeErrors.push(`${cand.uri}: ${msg}`);
      }
    }
    throw new Error(
      `No library in the running isolate has \`Element\` in scope. Probed: ${candidates
        .map((c) => c.uri)
        .join(", ")}. Errors: ${probeErrors.join(" | ")}`,
    );
  }

  /** Which library URI evaluate() is currently targeting — surface in diagnostics. */
  get evalTargetLibraryUri(): string | null {
    return this.cachedEvalLibraryUri;
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

  /**
   * Evaluate an expression. The targetId is `package:flutter/material.dart`
   * by default (or widgets / cupertino / rootLib as fallback chain) so
   * framework types resolve regardless of the host bootstrap library.
   * See `evalTargetLibraryId()` for the rationale.
   */
  async evaluate(
    expression: string,
  ): Promise<{ kind: string; valueAsString: string | null; raw: Record<string, unknown> }> {
    const isolateId = await this.mainIsolateId();
    const targetId = await this.evalTargetLibraryId();
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
