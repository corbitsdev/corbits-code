import { describe, expect, spyOn, test } from "bun:test";
import { getLogger } from "@intx/log";

import { LOG_NAMESPACE_ROOT } from "../../branding.js";
import { defined } from "../../../tests/helpers/defined.js";
import { finalizeTUIRun } from "./exit.js";
import type { RunnerServices, RunnerState } from "./state.js";

function stubQuit(args: { awaitTail: () => Promise<void>; shutdownRuntime: () => Promise<void> }): {
  state: RunnerState;
  services: RunnerServices;
} {
  const state = {
    host: {
      waitUntilExit: async () => undefined,
    },
    shutdownRuntime: args.shutdownRuntime,
    runError: undefined,
    streamPromise: Promise.resolve(),
    config: { cwd: "/tmp", task: "t" },
    sessionId: "s",
    startedAt: 1,
    runTaskTitle: "t",
    connectedMcpServers: [],
    liveSource: { id: "p", model: "m" },
  } as unknown as RunnerState;
  const services = {
    sessionOps: {
      enqueue: async () => undefined,
      awaitTail: args.awaitTail,
    },
    cycleRecorder: { dispose: async () => "" },
    mcpConnectController: new AbortController(),
    runSink: {
      getTurnCollector: () => null,
      getRunError: () => undefined,
      getStatus: () => "done",
      getTurnCount: () => 0,
      getTokenUsage: () => ({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        thinking: 0,
      }),
      getToolCallCount: () => 0,
    },
    crashGuard: { markFinalized: () => undefined, isFinalized: () => false },
    activeRunHandle: { task: "", startedAt: 0, model: "" },
    hookManager: { dispatchPostRun: async () => undefined },
    liveSessionMode: "orchestrator",
  } as unknown as RunnerServices;
  return { state, services };
}

describe("finalizeTUIRun quit order", () => {
  test("starts runtime shutdown without waiting on a hung session-op tail", async () => {
    const order: string[] = [];
    let settleTail: ((err: Error) => void) | undefined;
    const hungTail = new Promise<void>((_, reject) => {
      settleTail = reject;
    });
    const { state, services } = stubQuit({
      awaitTail: async () => {
        order.push("tail");
        await hungTail;
      },
      shutdownRuntime: async () => {
        order.push("shutdown");
      },
    });

    const pending = finalizeTUIRun(state, services);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(order[0]).toBe("shutdown");
    } finally {
      defined(settleTail, "settleTail")(new Error("stop"));
    }
    await expect(pending).rejects.toThrow("stop");
  });

  test("logs a runtime shutdown failure instead of swallowing it", async () => {
    const logger = getLogger([LOG_NAMESPACE_ROOT, "tui"]);
    const errorSpy = spyOn(logger, "error");
    let settleTail: ((err: Error) => void) | undefined;
    const hungTail = new Promise<void>((_, reject) => {
      settleTail = reject;
    });
    const { state, services } = stubQuit({
      awaitTail: () => hungTail,
      shutdownRuntime: async () => {
        throw new Error("plugin dispose failed");
      },
    });

    const pending = finalizeTUIRun(state, services);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(errorSpy).toHaveBeenCalled();
      const logged = errorSpy.mock.calls as unknown as readonly (readonly unknown[])[];
      const first = logged[0];
      expect(first).toBeDefined();
      expect(String(first?.[0])).toMatch(/shutdown/i);
      expect(first?.[1]).toEqual({ error: "plugin dispose failed" });
    } finally {
      errorSpy.mockRestore();
      defined(settleTail, "settleTail")(new Error("stop"));
    }
    await expect(pending).rejects.toThrow("stop");
  });
});
