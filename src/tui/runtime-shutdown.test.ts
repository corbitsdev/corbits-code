import { describe, expect, test } from "bun:test";

import { createRuntimeShutdown } from "./runner/shutdown.js";

describe("runtime shutdown", () => {
  test("restores the terminal, disposes the toolset, then closes the primary agent", async () => {
    const calls: string[] = [];
    const shutdown = createRuntimeShutdown({
      disposeHost: () => calls.push("host"),
      cancelWorkers: () => {
        calls.push("workers");
      },
      closeAgent: async () => {
        calls.push("agent");
      },
      disposeToolset: async () => {
        calls.push("toolset");
      },
    });

    await shutdown();

    expect(calls).toEqual(["host", "toolset", "workers", "agent"]);
  });

  test("runs teardown only once when exit and a signal race", async () => {
    const calls: string[] = [];
    const shutdown = createRuntimeShutdown({
      disposeHost: () => calls.push("host"),
      cancelWorkers: () => {
        calls.push("workers");
      },
      closeAgent: async () => {
        calls.push("agent");
      },
      disposeToolset: async () => {
        calls.push("toolset");
      },
    });

    await Promise.all([shutdown(), shutdown()]);

    expect(calls).toEqual(["host", "toolset", "workers", "agent"]);
  });

  test("still runs remaining legs and rejects when host disposal fails", async () => {
    const calls: string[] = [];
    const shutdown = createRuntimeShutdown({
      disposeHost: () => {
        calls.push("host");
        throw new Error("renderer failure");
      },
      cancelWorkers: () => {
        calls.push("workers");
      },
      closeAgent: async () => {
        calls.push("agent");
      },
      disposeToolset: async () => {
        calls.push("toolset");
      },
    });

    await expect(shutdown()).rejects.toThrow("renderer failure");
    expect(calls).toEqual(["host", "toolset", "workers", "agent"]);
  });

  test("rejects when toolset dispose throws after other legs ran", async () => {
    const calls: string[] = [];
    const shutdown = createRuntimeShutdown({
      disposeHost: () => calls.push("host"),
      cancelWorkers: () => {
        calls.push("workers");
      },
      closeAgent: async () => {
        calls.push("agent");
      },
      disposeToolset: async () => {
        calls.push("toolset");
        throw new Error("plugin dispose failed");
      },
    });

    await expect(shutdown()).rejects.toThrow("plugin dispose failed");
    expect(calls).toEqual(["host", "toolset", "workers", "agent"]);
  });

  test("rejects when async cancelWorkers throws leftover children", async () => {
    const calls: string[] = [];
    const shutdown = createRuntimeShutdown({
      disposeHost: () => calls.push("host"),
      cancelWorkers: async () => {
        calls.push("workers");
        throw new Error("1 shell child process still live after 2000ms reap");
      },
      closeAgent: async () => {
        calls.push("agent");
      },
      disposeToolset: async () => {
        calls.push("toolset");
      },
    });

    await expect(shutdown()).rejects.toThrow(/still live after 2000ms reap/);
    expect(calls).toEqual(["host", "toolset", "workers", "agent"]);
  });

  test("awaits an async toolset dispose before resolving", async () => {
    const calls: string[] = [];
    let resolveToolset!: () => void;
    const toolsetGate = new Promise<void>((resolve) => {
      resolveToolset = resolve;
    });
    const shutdown = createRuntimeShutdown({
      disposeHost: () => calls.push("host"),
      cancelWorkers: () => {
        calls.push("workers");
      },
      closeAgent: async () => {
        calls.push("agent");
      },
      disposeToolset: async () => {
        await toolsetGate;
        calls.push("toolset");
      },
    });

    const pending = shutdown();
    await Promise.resolve();
    expect(calls).toEqual(["host"]);
    resolveToolset();
    await pending;
    expect(calls).toEqual(["host", "toolset", "workers", "agent"]);
  });

  test("reaps the toolset before waiting on a hung agent close", async () => {
    const calls: string[] = [];
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const shutdown = createRuntimeShutdown({
      disposeHost: () => calls.push("host"),
      cancelWorkers: () => {
        calls.push("workers");
      },
      closeAgent: async () => {
        await closeGate;
        calls.push("agent");
      },
      disposeToolset: async () => {
        calls.push("toolset");
      },
    });

    const pending = shutdown();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual(["host", "toolset", "workers"]);
    releaseClose();
    await pending;
    expect(calls).toEqual(["host", "toolset", "workers", "agent"]);
  });
});
