import { defined } from "../../tests/helpers/defined.js";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  MAX_COMPLETED_BACKGROUND_SHELLS,
  MAX_RUNNING_BACKGROUND_SHELLS,
  createBackgroundShellRegistry,
} from "./background-shell.js";

const tmpCwd = process.cwd();

describe("background shell registry", () => {
  test("start returns a handle immediately while the process runs", async () => {
    const registry = createBackgroundShellRegistry();
    const started = registry.start({ command: "sleep 1; echo done", cwd: tmpCwd });
    if ("error" in started) throw new Error(started.error);
    const snapshot = await registry.collect(started.id, 0);
    expect(snapshot.state).toBe("running");
    const exited = await registry.collect(started.id, 5_000);
    expect(exited.state).toBe("completed");
    if (exited.state !== "completed") return;
    expect(exited.exit.exitCode).toBe(0);
    expect(exited.exit.output).toContain("done");
    expect(exited.exit.timedOut).toBe(false);
  });

  test("onExit fires with exit status and output", async () => {
    const exits: unknown[] = [];
    const registry = createBackgroundShellRegistry({ onExit: (exit) => exits.push(exit) });
    const started = registry.start({ command: "echo hi", cwd: tmpCwd });
    if ("error" in started) throw new Error(started.error);
    await registry.collect(started.id, 5_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(exits).toHaveLength(1);
  });

  test("timeout kills the group and reports exit 124 + timedOut", async () => {
    const registry = createBackgroundShellRegistry();
    const started = registry.start({
      command: "echo early; sleep 60",
      cwd: tmpCwd,
      timeoutMs: 150,
    });
    if ("error" in started) throw new Error(started.error);
    const exited = await registry.collect(started.id, 5_000);
    expect(exited.state).toBe("completed");
    if (exited.state !== "completed") return;
    expect(exited.exit.timedOut).toBe(true);
    expect(exited.exit.exitCode).toBe(124);
    expect(exited.exit.output).toContain("early");
  });

  test("cancel kills the whole process group", async () => {
    if (process.platform === "win32") return;
    const token = `ic_bg_cancel_${randomUUID()}`;
    const registry = createBackgroundShellRegistry();
    const started = registry.start({
      command: `bash -c 'TAG=${token} sleep 600 & TAG=${token} exec sleep 600'`,
      cwd: tmpCwd,
    });
    if ("error" in started) throw new Error(started.error);
    expect(registry.cancel(started.id)).toBe(true);
    const exited = await registry.collect(started.id, 5_000);
    expect(exited.state).toBe("completed");
    await new Promise((r) => setTimeout(r, 300));
    const probe = spawnSync("pgrep", ["-f", token], { encoding: "utf8" });
    expect(probe.stdout?.trim() ?? "").toBe("");
    expect(probe.status).not.toBe(0);
  });

  test("cancel on an unknown id returns false", () => {
    const registry = createBackgroundShellRegistry();
    expect(registry.cancel("nope")).toBe(false);
  });

  test("completed ring evicts the oldest entry (collect reports not-found)", async () => {
    const registry = createBackgroundShellRegistry();
    const ids: string[] = [];
    for (let i = 0; i <= MAX_COMPLETED_BACKGROUND_SHELLS; i++) {
      const started = registry.start({ command: "true", cwd: tmpCwd });
      if ("error" in started) throw new Error(started.error);
      ids.push(started.id);
      await registry.collect(started.id, 5_000);
    }
    expect(ids).toHaveLength(MAX_COMPLETED_BACKGROUND_SHELLS + 1);
    const evicted = await registry.collect(defined(ids[0]), 0);
    expect(evicted.state).toBe("not-found");
    const retained = await registry.collect(defined(ids[ids.length - 1]), 0);
    expect(retained.state).toBe("completed");
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

  test("disposeAll kills running children", async () => {
    const token = `ic_bg_dispose_${randomUUID()}`;
    const registry = createBackgroundShellRegistry();
    const started = registry.start({ command: `sleep 600 # ${token}`, cwd: tmpCwd });
    if ("error" in started) throw new Error(started.error);
    registry.disposeAll("session closed");
    await new Promise((r) => setTimeout(r, 300));
    const probe = spawnSync("pgrep", ["-f", token], { encoding: "utf8" });
    expect(probe.stdout?.trim() ?? "").toBe("");
    expect(probe.status).not.toBe(0);
    const after = await registry.collect(started.id, 0);
    expect(after.state).toBe("not-found");
  });
});
