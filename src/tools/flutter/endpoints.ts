import { z } from "zod";
import { manager } from "../../manager.js";

export const flutterEndpointsInputSchema = {
  session_id: z.string().min(1).describe("Session ID (typically a `flutter run` session)."),
  wait_ms: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "If the VM-service WS URL hasn't been printed yet, wait up to this many ms for it. Default: 0 (return immediately with whatever has been detected).",
    ),
};

export async function flutterEndpointsHandler(input: { session_id: string; wait_ms?: number }) {
  const session = manager.get(input.session_id);
  const waitMs = input.wait_ms ?? 0;
  if (waitMs > 0 && !session.flutterEndpoints.vm_service_ws) {
    try {
      await session.waitForFlutterEndpoint(waitMs);
    } catch {
      // Fall through — return whatever we have (likely null URLs).
    }
  }
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            ...session.flutterEndpoints,
            vm_service_connected: session.flutterServiceConnected,
          },
          null,
          2,
        ),
      },
    ],
  };
}
