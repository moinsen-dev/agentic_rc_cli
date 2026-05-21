import { Session } from "./session.js";
import type { SpawnOptions } from "./types.js";

export class SessionManager {
  private sessions = new Map<string, Session>();
  private shutdownHandlersRegistered = false;

  start(opts: SpawnOptions): Session {
    this.ensureShutdownHandlers();
    const session = new Session(opts);
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`No such session: ${id}`);
    return s;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  killAll(): void {
    for (const s of this.sessions.values()) {
      try {
        s.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }

  private ensureShutdownHandlers(): void {
    if (this.shutdownHandlersRegistered) return;
    this.shutdownHandlersRegistered = true;

    const cleanup = (): void => {
      this.killAll();
    };

    process.once("exit", cleanup);
    process.once("SIGINT", () => {
      cleanup();
      process.exit(130);
    });
    process.once("SIGTERM", () => {
      cleanup();
      process.exit(143);
    });
  }
}

export const manager = new SessionManager();
