import { describe, expect, test } from "bun:test";
import type { Config } from "../../../src/config/index.js";
import {
  disposeExecRuntime,
  formatCaughtError,
  resolveExecDirectorOverlay,
  runExec,
} from "../../../src/exec/runner.js";
import { BUILD_TOOLS } from "../../../src/agent/directors/tool-sets.js";
import { createSubAgentSessionStore } from "../../../src/subagent/session-store.js";

function bareConfig(task: string): Config {
  // Minimal unconfigured-shaped object is not enough — runExec only needs
  // `task` for the empty-prompt early return before any bootstrap.
  return {
    command: "exec",
    task,
    cwd: process.cwd(),
    configured: true,
    providerName: "test",
    model: "test",
    providers: {},
    force: false,
    dangerouslySkipPermissions: true,
    autoMode: false,
    sessionId: "test-session",
  } as unknown as Config;
}

describe("formatCaughtError", () => {
  test("prefers Error.message and stringifies other values", () => {
    expect(formatCaughtError(new Error("disk full"))).toBe("disk full");
    expect(formatCaughtError("plain")).toBe("plain");
    expect(formatCaughtError(42)).toBe("42");
  });
});

describe("runExec", () => {
  test("empty prompt exits 2 with stderr message without bootstrapping", async () => {
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return origWrite(chunk as never, ...(rest as never[]));
    }) as typeof process.stderr.write;

    try {
      const result = await runExec(bareConfig("   "));
      expect(result.exitCode).toBe(2);
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/missing prompt|empty prompt/i);
      expect(stderrChunks.join("")).toMatch(/missing prompt|empty prompt|Usage: corbits exec/i);
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

describe("disposeExecRuntime", () => {
  test("cancels fire-and-forget workers when exec finishes", async () => {
    const store = createSubAgentSessionStore();
    const worker = store.start({ description: "bg", agentId: "w", brief: "b" });
    let aborted = 0;
    store.registerCancel(worker.id, () => {
      aborted += 1;
    });

    const calls: string[] = [];
    await disposeExecRuntime({
      agent: {
        close: async () => {
          calls.push("agent");
        },
      },
      toolset: {
        dispose: async () => {
          calls.push("toolset");
        },
      },
      subAgentSessions: store,
    });

    expect(aborted).toBe(1);
    expect(store.get(worker.id)?.status).toBe("cancelled");
    expect(calls).toEqual(["agent", "toolset"]);
  });
});

describe("resolveExecDirectorOverlay", () => {
  test("builder exec primary does not mount task", () => {
    const overlay = resolveExecDirectorOverlay("builder");
    expect(overlay.mountTask).toBe(false);
    expect(overlay.advertisedAllow).toBeDefined();
    expect(overlay.advertisedAllow).not.toContain("task");
    expect(overlay.advertisedAllow).toEqual([...BUILD_TOOLS]);
    expect(overlay.systemPrompt).toContain("BuilderDirector");
  });

  test("skywalker default still can mount task", () => {
    expect(resolveExecDirectorOverlay(undefined).mountTask).toBe(true);
    expect(resolveExecDirectorOverlay(undefined).systemPrompt).toBeUndefined();
    expect(resolveExecDirectorOverlay(undefined).advertisedAllow).toBeUndefined();
    expect(resolveExecDirectorOverlay("skywalker").mountTask).toBe(true);
    expect(resolveExecDirectorOverlay("skywalker").systemPrompt).toBeUndefined();
  });
});
