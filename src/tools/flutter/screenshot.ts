import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { manager } from "../../manager.js";

export const flutterScreenshotInputSchema = {
  session_id: z.string().min(1).describe("Session ID."),
  save_to: z
    .string()
    .optional()
    .describe(
      "Optional filesystem path (PNG) where the screenshot should be written. If relative, resolved against the session's cwd. If omitted, the base64 PNG is returned inline.",
    ),
};

export async function flutterScreenshotHandler(input: { session_id: string; save_to?: string }) {
  const session = manager.get(input.session_id);
  const svc = await session.ensureFlutterService();
  try {
    const shot = await svc.screenshot();

    let savedTo: string | null = null;
    if (input.save_to) {
      const target = isAbsolute(input.save_to)
        ? input.save_to
        : resolve(session.cwd, input.save_to);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(shot.base64, "base64"));
      savedTo = target;
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: true,
              format: shot.format,
              saved_to: savedTo,
              base64: savedTo ? null : shot.base64,
              base64_bytes: shot.base64.length,
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (err) {
    // ext.flutter.screenshot isn't always available — e.g. macOS desktop
    // (which has its own SkImageScene path) or web. Return a structured
    // failure so the agent can fall back to Peekaboo / chrome-devtools.
    const message = err instanceof Error ? err.message : String(err);
    const isNotRegistered = /method not found|-32601|extension does not exist/i.test(message);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: false,
              reason: isNotRegistered ? "extension_not_registered" : "vm_service_error",
              message,
              hint: isNotRegistered
                ? "ext.flutter.screenshot is not registered on this device. Use Peekaboo or chrome-devtools-mcp to capture the window instead."
                : null,
            },
            null,
            2,
          ),
        },
      ],
    };
  }
}
