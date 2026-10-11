import { describe, expect, test } from "bun:test";

// Pins the empirical claim behind installSignalHandlers: Bun's setRawMode
// clears ISIG, so a real Ctrl+C keypress never reaches SIGINT during a TUI
// session — only out-of-band kill(2) signals do. If a future Bun changes
// that, the double-tap-to-quit gesture would race a process-level exit.
// Tested against a real forked pty.
describe("integration — raw-mode stdin and SIGINT", () => {
  test("Ctrl+C is delivered as a stdin byte, not as SIGINT, while raw mode is active", async () => {
    const probe = new URL(
      "../fixtures/rawmode-sigint/probe.ts",
      import.meta.url,
    ).pathname;
    const driver = new URL(
      "../fixtures/rawmode-sigint/pty_probe.py",
      import.meta.url,
    ).pathname;

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
