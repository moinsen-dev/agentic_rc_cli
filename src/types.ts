import type { FlutterEndpoints } from "./flutter/endpoints.js";

export type SessionId = string;

export type SessionStatus = "running" | "exited" | "killed";

export interface SessionInfo {
  id: SessionId;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  pid: number;
  status: SessionStatus;
  exit_code: number | null;
  started_at: string;
  rows: number;
  cols: number;
  bytes_written: number;
  bytes_read: number;
  /** Present when the session detected Flutter debug endpoints. */
  flutter: FlutterEndpoints | null;
}

export interface SpawnOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  name?: string;
}
