import { describe, expect, test } from "bun:test";

// src/index.ts's installSignalHandlers relies on an empirical claim: Bun's
// stdin.setRawMode(true) clears ISIG on this platform, so a real Ctrl+C
// keypress never reaches process.on("SIGINT") during an interactive TUI
// session -- only out-of-band kill(2) signals do. If a future Bun upgrade
// changes that, the in-session exit path would race the process-level exit.
// This test pins the assumption against a real
// forked pty rather than trusting it to hold forever.
describe("integration — raw-mode stdin and SIGINT", () => {
  test("Ctrl+C is delivered as a stdin byte, not as SIGINT, while raw mode is active", async () => {
    const probe = new URL("../fixtures/rawmode-sigint/probe.ts", import.meta.url).pathname;
    const driver = new URL("../fixtures/rawmode-sigint/pty_probe.py", import.meta.url).pathname;

    const proc = Bun.spawn(["python3", driver, probe], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("GOT_CTRL_C_BYTE");
    expect(stdout).toContain("NO_SIGINT_ON_CTRL_C");
    expect(stdout).not.toContain("GOT_SIGINT");
  }, 15000);
});
