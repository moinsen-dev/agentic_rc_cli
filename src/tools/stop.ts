import { z } from "zod";
import { manager } from "../manager.js";

export const stopInputSchema = {
  session_id: z.string().min(1).describe("Session ID."),
  signal: z
    .enum(["SIGTERM", "SIGINT", "SIGKILL", "SIGHUP", "SIGQUIT"])
    .optional()
    .describe("POSIX signal to send. Default: SIGTERM."),
  wait_ms: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "How long to wait for the process to exit after the signal. Default: 2000. If still alive after this, escalates to SIGKILL.",
    ),
  remove: z
    .boolean()
    .optional()
    .describe("Remove the session from the registry after it exits. Default: false."),
};

export async function stopHandler(input: {
  session_id: string;
  signal?: NodeJS.Signals;
  wait_ms?: number;
  remove?: boolean;
}) {
  const session = manager.get(input.session_id);
  const waitMs = input.wait_ms ?? 2000;
  const signal = (input.signal ?? "SIGTERM") as NodeJS.Signals;

  const exitPromise = new Promise<void>((resolve) => {
    if (session.status !== "running") {
      resolve();
      return;
    }
    session.once("exit", () => resolve());
  });

  session.kill(signal);

  let escalated = false;
  const timer = setTimeout(() => {
    if (session.status === "running" || session.status === "killed") {
      // node-pty marks status killed immediately; we only escalate if onExit
      // hasn't fired by `wait_ms`.
      try {
        session.kill("SIGKILL");
        escalated = true;
      } catch {
        // ignore
      }
    }
  }, waitMs);

  await exitPromise;
  clearTimeout(timer);

  if (input.remove) {
    manager.remove(session.id);
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            session_id: session.id,
            exit_code: session.exitCode,
            signal_sent: signal,
            escalated_to_sigkill: escalated,
            status: session.status,
            removed: input.remove === true,
          },
          null,
          2,
        ),
      },
    ],
  };
}
