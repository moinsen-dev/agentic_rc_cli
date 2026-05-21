import { z } from "zod";
import { manager } from "../../manager.js";

export const flutterHotReloadInputSchema = {
  session_id: z.string().min(1).describe("Session ID."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max wait for Flutter to report the result. Default: 15000."),
};

/**
 * Why send "r" over the PTY instead of calling reloadSources via the VM service?
 *
 *   The Dart VM Service's `reloadSources` RPC just tells the VM "load this
 *   kernel". For a Flutter app the kernel has to come from the
 *   `frontend_server` compiler, which is owned by `flutter run` itself.
 *   Calling reloadSources directly bypasses that pipeline and fails with
 *   "Error while starting Kernel isolate task".
 *
 *   So the architecturally clean approach is: trigger reload through Flutter's
 *   own keystroke handler (PTY "r"), and use the VM service only for
 *   structured observation (errors / logs / eval / screenshot).
 */
// Modern Flutter (3.x+) prints "Reloaded 1 of 753 libraries in 139ms". Older
// versions ("Reloaded 1 library in …") and dart-only ("Reloaded 12 libraries")
// are accepted too.
const RELOAD_OK = /Reloaded (\d+)(?: of (\d+))? librar(?:y|ies) in (\d+)ms/;
const RELOAD_REJECT = /(Compiler message:|Error:.*lib\/.*\.dart|Try again after fixing)/;

export async function flutterHotReloadHandler(input: {
  session_id: string;
  timeout_ms?: number;
}) {
  const session = manager.get(input.session_id);
  const timeoutMs = input.timeout_ms ?? 15_000;

  // Mark the current stream position so we only inspect output produced by
  // *this* reload, not anything that came before.
  const cursorMarker = session.readStream({ sinceCursor: undefined, maxBytes: 0 });
  const startCursor = cursorMarker.newCursor;

  session.write("r");

  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const chunk = session.readStream({
      sinceCursor: startCursor,
      maxBytes: 64 * 1024,
      stripAnsi: true,
    });
    lastText = chunk.text;

    const ok = lastText.match(RELOAD_OK);
    if (ok) {
      const reloaded = parseInt(ok[1], 10);
      const totalLibraries = ok[2] ? parseInt(ok[2], 10) : null;
      const durationMs = parseInt(ok[3], 10);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                libraries_reloaded: reloaded,
                libraries_total: totalLibraries,
                duration_ms: durationMs,
                notices: [],
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const rejected = lastText.match(RELOAD_REJECT);
    if (rejected) {
      // Trim the relevant slice for the agent. Keep up to 2 KiB.
      const snippet = lastText.slice(-2048).trim();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: false,
                reason: "compile_error",
                first_marker: rejected[0],
                console_excerpt: snippet,
              },
              null,
              2,
            ),
          },
        ],
      };
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: false,
            reason: "timeout",
            timeout_ms: timeoutMs,
            console_excerpt: lastText.slice(-2048).trim(),
          },
          null,
          2,
        ),
      },
    ],
  };
}
