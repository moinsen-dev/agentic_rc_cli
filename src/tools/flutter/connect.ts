import { z } from "zod";
import { manager } from "../../manager.js";

export const flutterConnectInputSchema = {
  session_id: z.string().min(1).describe("Session ID."),
  wait_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum time to wait for the VM-service URL to be printed. Default: 180000."),
  subscribe: z
    .boolean()
    .optional()
    .describe(
      "Whether to immediately subscribe to Stdout / Stderr / Logging / Extension / Debug streams (so rc_flutter_drain_errors and rc_flutter_drain_logs return events). Default: true.",
    ),
};

export async function flutterConnectHandler(input: {
  session_id: string;
  wait_ms?: number;
  subscribe?: boolean;
}) {
  const session = manager.get(input.session_id);
  const svc = await session.ensureFlutterService({
    waitForEndpointMs: input.wait_ms,
    subscribe: input.subscribe,
  });
  const mainIsolateId = await svc.mainIsolateId().catch(() => null);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            connected: true,
            ws_url: svc.vmClient.url,
            main_isolate_id: mainIsolateId,
          },
          null,
          2,
        ),
      },
    ],
  };
}
