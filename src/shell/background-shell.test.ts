import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  MAX_RUNNING_BACKGROUND_SHELLS,
  createBackgroundShellRegistry,
} from "./background-shell.js";
import { createExitRecorder } from "./background-shell-test-harness.js";

const tmpCwd = process.cwd();

/** Poll until no process carries `token`; fail instead of asserting on a pid. */
async function waitUntilGone(token: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    const probe = spawnSync("pgrep", ["-f", token], { encoding: "utf8" });
    if ((probe.stdout?.trim() ?? "").length === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`tagged child still alive after 5s: ${token}`);
}

describe("background shell registry", () => {
  test("start returns a handle while the process runs, then delivers the exit", async () => {
    const recorder = createExitRecorder();
    const registry = createBackgroundShellRegistry({
      onExit: recorder.onExit,
    });
    const started = registry.start({
      command: "sleep 0.1; echo done",
      cwd: tmpCwd,
    });
    if ("error" in started) throw new Error(started.error);
    expect(registry.runningCount()).toBe(1);
    const exit = await recorder.waitFor(started.id);
    expect(exit.exitCode).toBe(0);
    expect(exit.output).toContain("done");
    expect(exit.timedOut).toBe(false);
    expect(registry.runningCount()).toBe(0);
  });

  test("timeout kills the group and reports exit 124 + timedOut", async () => {
    const recorder = createExitRecorder();
    const registry = createBackgroundShellRegistry({
      onExit: recorder.onExit,
    });
    const started = registry.start({
      command: "echo early; sleep 60",
      cwd: tmpCwd,
      timeoutMs: 150,
    });
    if ("error" in started) throw new Error(started.error);
    const exit = await recorder.waitFor(started.id);
    expect(exit.timedOut).toBe(true);
    expect(exit.exitCode).toBe(124);
    expect(exit.output).toContain("early");
  });

  test("cancel kills the whole process group", async () => {
    if (process.platform === "win32") return;
    const token = `ic_bg_cancel_${randomUUID()}`;
    const recorder = createExitRecorder();
    const registry = createBackgroundShellRegistry({
      onExit: recorder.onExit,
    });
    const started = registry.start({
      command: `bash -c 'TAG=${token} sleep 600 & TAG=${token} exec sleep 600'`,
      cwd: tmpCwd,
    });
    if ("error" in started) throw new Error(started.error);
    expect(registry.cancel(started.id)).toBe(true);
    await recorder.waitFor(started.id);
    await waitUntilGone(token);
  });

  test("cancel on an unknown id returns false", () => {
    const registry = createBackgroundShellRegistry();
    expect(registry.cancel("nope")).toBe(false);
  });

  test("running cap fails closed with an error instead of spawning", async () => {
    const registry = createBackgroundShellRegistry();
    for (let i = 0; i < MAX_RUNNING_BACKGROUND_SHELLS; i++) {
      const started = registry.start({ command: "sleep 30", cwd: tmpCwd });
      expect("error" in started).toBe(false);
    }
    const over = registry.start({ command: "sleep 30", cwd: tmpCwd });
    expect("error" in over).toBe(true);
    registry.disposeAll("test done");
  });

  test("disposeAll kills running children without delivering an exit", async () => {
    const token = `ic_bg_dispose_${randomUUID()}`;
    const exits: unknown[] = [];
    const registry = createBackgroundShellRegistry({
      onExit: (exit) => exits.push(exit),
    });
    const started = registry.start({
      command: `sleep 600 # ${token}`,
      cwd: tmpCwd,
    });
    if ("error" in started) throw new Error(started.error);
    registry.disposeAll("session closed");
    await waitUntilGone(token);
    expect(registry.runningCount()).toBe(0);
    expect(exits).toHaveLength(0);
  });

  test("the exit is delivered when the child exits even if stdio stays open", async () => {
    if (process.platform === "win32") return;
    const token = `ic_bg_stdio_hold_${randomUUID()}`;
    const recorder = createExitRecorder();
    const registry = createBackgroundShellRegistry({
      onExit: recorder.onExit,
    });
    // Grandchild inherits the piped stdout so Node's 'close' waits on it; the
    // shell exits immediately, so delivery must not require close.
    const started = registry.start({
      command: `bash -c 'exec -a ${token} sleep 600 & exit 0'`,
      cwd: tmpCwd,
    });
    if ("error" in started) throw new Error(started.error);
    try {
      const t0 = Date.now();
      const exit = await recorder.waitFor(started.id);
      expect(Date.now() - t0).toBeLessThan(2_000);
      expect(exit.exitCode).toBe(0);
    } finally {
      registry.disposeAll("test done");
      spawnSync("pkill", ["-f", token]);
      await waitUntilGone(token);
    }
  });
});
