import { z } from "zod";
import { manager } from "../manager.js";

export const startInputSchema = {
  command: z.string().min(1).describe("Executable to spawn, e.g. 'flutter' or 'bash'."),
  args: z.array(z.string()).optional().describe("Argument list, e.g. ['run', '-d', 'macos']."),
  cwd: z.string().optional().describe("Working directory. Defaults to the MCP server's cwd."),
  env: z
    .record(z.string())
    .optional()
    .describe("Extra environment variables (merged on top of the server's env)."),
  cols: z.number().int().positive().optional().describe("PTY column width (default 120)."),
  rows: z.number().int().positive().optional().describe("PTY row height (default 40)."),
  name: z
    .string()
    .optional()
    .describe("Optional friendly name for the session (auto-generated if omitted)."),
};

export async function startHandler(input: {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  name?: string;
}) {
  const session = manager.start(input);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            session_id: session.id,
            name: session.name,
            pid: session.pid,
            cols: session.cols,
            rows: session.rows,
          },
          null,
          2,
        ),
      },
    ],
  };
}
