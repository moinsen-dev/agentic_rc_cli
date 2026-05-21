import { describe, it, expect, afterEach } from "vitest";
import { Session } from "../src/session.js";

const created: Session[] = [];

function makeSession(opts: { command: string; args?: string[] }) {
  const s = new Session(opts);
  created.push(s);
  return s;
}

function waitForExit(s: Session, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (s.status !== "running") return resolve();
    const t = setTimeout(() => reject(new Error(`session ${s.id} did not exit in ${timeoutMs}ms`)), timeoutMs);
    s.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await sleep(25);
  }
  throw new Error("waitFor timed out");
}

afterEach(async () => {
  while (created.length) {
    const s = created.pop()!;
    try {
      s.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
  // Give exits a moment to propagate.
  await sleep(50);
});

describe("Session", () => {
  it("spawns a process and captures stdout in the screen buffer", async () => {
    const s = makeSession({ command: "/bin/sh", args: ["-c", "echo hello-pty; sleep 0.05"] });
    await waitForExit(s);

    const screen = s.readScreen();
    expect(screen.text).toContain("hello-pty");
    expect(s.status).toBe("exited");
    expect(s.exitCode).toBe(0);
  });

  it("captures multiple lines and tail reads them in order", async () => {
    const s = makeSession({
      command: "/bin/sh",
      args: ["-c", "for i in 1 2 3 4 5; do echo line-$i; done; sleep 0.05"],
    });
    await waitForExit(s);

    const tail = s.readTail(10);
    expect(tail).toContain("line-1");
    expect(tail).toContain("line-5");
    expect(tail.indexOf("line-1")).toBeLessThan(tail.indexOf("line-5"));
  });

  it("accepts written input and reflects it in the screen", async () => {
    const s = makeSession({ command: "/bin/sh", args: ["-i"] });
    // Wait for shell prompt to appear (any non-empty content).
    await waitFor(() => (s.readScreen().text.trim().length > 0 ? true : undefined), 3000);

    s.write("echo from-write-call\r");
    await waitFor(
      () => (s.readScrollback().includes("from-write-call") ? true : undefined),
      3000,
    );

    expect(s.readScrollback()).toContain("from-write-call");

    s.write("exit\r");
    await waitForExit(s, 3000);
  });

  it("readStream returns raw bytes with an advancing cursor", async () => {
    const s = makeSession({
      command: "/bin/sh",
      args: ["-c", "printf 'A\\nB\\nC\\n'; sleep 0.05"],
    });
    await waitForExit(s);

    const first = s.readStream({ sinceCursor: 0, stripAnsi: true });
    expect(first.text).toContain("A");
    expect(first.text).toContain("B");
    expect(first.text).toContain("C");
    expect(first.newCursor).toBeGreaterThan(0);

    // Reading from new_cursor should yield no further data.
    const second = s.readStream({ sinceCursor: first.newCursor });
    expect(second.text).toBe("");
    expect(second.newCursor).toBe(first.newCursor);
  });

  it("kill() marks the session as killed and emits exit", async () => {
    const s = makeSession({ command: "/bin/sh", args: ["-c", "sleep 30"] });
    // Give the child a moment to actually start.
    await sleep(50);
    s.kill("SIGTERM");
    await waitForExit(s, 3000);

    expect(s.status).toBe("killed");
  });

  it("resize updates cols/rows", async () => {
    const s = makeSession({ command: "/bin/sh", args: ["-i"] });
    await sleep(100);
    s.resize(80, 24);
    expect(s.cols).toBe(80);
    expect(s.rows).toBe(24);
    s.kill("SIGTERM");
    await waitForExit(s, 3000);
  });
});
