import { describe, expect, test } from "bun:test";
import { createSubAgentSessionStore } from "../subagent/session-store.js";
import { defined } from "../../testkit/defined.js";
import { expectRejectedSettle, settleOrTimeout } from "../../testkit/settle.js";
import { disposeExecRuntime, formatCaughtError } from "./dispose.js";

describe("formatCaughtError", () => {
  test("prefers Error.message and stringifies other values", () => {
    expect(formatCaughtError(new Error("disk full"))).toBe("disk full");
    expect(formatCaughtError("plain")).toBe("plain");
    expect(formatCaughtError(42)).toBe("42");
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
    expect(calls).toEqual(["toolset", "agent"]);
  });

  test("runs teardown only once when called concurrently", async () => {
    const calls: string[] = [];
    const toolset = {
      dispose: async () => {
        calls.push("toolset");
      },
    };
    const args = {
      agent: {
        close: async () => {
          calls.push("agent");
        },
      },
      toolset,
      subAgentSessions: null,
    };

    await Promise.all([disposeExecRuntime(args), disposeExecRuntime(args)]);

    expect(calls).toEqual(["toolset", "agent"]);
  });

  test("reaps the toolset before waiting on a hung agent close", async () => {
    const calls: string[] = [];
    let releaseClose: (() => void) | undefined;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const pending = disposeExecRuntime({
      agent: {
        close: async () => {
          await closeGate;
          calls.push("agent");
        },
      },
      toolset: {
        dispose: async () => {
          calls.push("toolset");
        },
      },
      subAgentSessions: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual(["toolset"]);
    defined<() => void>(releaseClose, "releaseClose")();
    await pending;
    expect(calls).toEqual(["toolset", "agent"]);
  });

  test("rejects leftover-child dispose from the toolset", async () => {
    await expect(
      disposeExecRuntime({
        agent: { close: async () => undefined },
        toolset: {
          dispose: async () => {
            throw new Error(
              "1 shell child process still live after 2000ms reap",
            );
          },
        },
        subAgentSessions: null,
      }),
    ).rejects.toThrow(/still live after 2000ms reap/);
  });

  test("surfaces leftover toolset dispose when agent.close hangs", async () => {
    let closeStarted = false;
    const pending = disposeExecRuntime({
      agent: {
        close: () => {
          closeStarted = true;
          return new Promise<void>(() => undefined);
        },
      },
      toolset: {
        dispose: async () => {
          throw new Error("1 shell child process still live after 2000ms reap");
        },
      },
      subAgentSessions: null,
    });
    const result = await settleOrTimeout(pending);
    expect(closeStarted).toBe(true);
    expectRejectedSettle(result, /still live after 2000ms reap/);
  });

  test("rejects when toolset dispose fails", async () => {
    await expect(
      disposeExecRuntime({
        agent: { close: async () => undefined },
        toolset: {
          dispose: async () => {
            throw new Error("plugin dispose failed");
          },
        },
        subAgentSessions: null,
      }),
    ).rejects.toThrow("plugin dispose failed");
  });

  test("cancels every live worker with the close reason after toolset dispose", async () => {
    const store = createSubAgentSessionStore();
    const first = store.start({ description: "a", agentId: "w1", brief: "b" });
    const second = store.start({ description: "b", agentId: "w2", brief: "b" });
    const calls: string[] = [];
    store.registerCancel(first.id, () => calls.push("cancel:first"));
    store.registerCancel(second.id, () => calls.push("cancel:second"));

    await disposeExecRuntime({
      agent: { close: async () => void calls.push("agent") },
      toolset: { dispose: async () => void calls.push("toolset") },
      subAgentSessions: store,
    });

    // Posix/toolset first so a hung close cannot skip reap; then cancel, then close.
    expect(calls).toEqual([
      "toolset",
      "cancel:first",
      "cancel:second",
      "agent",
    ]);
    expect(store.get(first.id)?.status).toBe("cancelled");
    expect(store.get(second.id)?.status).toBe("cancelled");
    expect(store.get(first.id)?.stopReason).toBe("cancelled — Session closed");
    expect(store.get(second.id)?.stopReason).toBe("cancelled — Session closed");
  });

  test("a failing agent close still disposes the toolset and rejects", async () => {
    const store = createSubAgentSessionStore();
    const worker = store.start({ description: "bg", agentId: "w", brief: "b" });
    store.registerCancel(worker.id, () => undefined);

    let disposed = 0;
    await expect(
      disposeExecRuntime({
        agent: {
          close: () => Promise.reject(new Error("close exploded")),
        },
        toolset: { dispose: async () => void (disposed += 1) },
        subAgentSessions: store,
      }),
    ).rejects.toThrow("close exploded");

    expect(store.get(worker.id)?.status).toBe("cancelled");
    expect(disposed).toBe(1);
  });
});
