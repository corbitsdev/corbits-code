/**
 * CL-7990: a session holding a live shell child must still settle.
 *
 * Teardown path (run.ts finally → disposeSubAgentSession under a 30s
 * awaitBoundedTeardown): posixTools.dispose() runs the shell-guard
 * reapLiveChildren (SIGKILL the child process groups, 2s reap wait), then
 * agent.close() and the session-stream drain are awaited — voided, not hung
 * on, when the reap reports leftovers. Interrupt additionally releases
 * parked shell_collect waiters so a worker blocked in shell output
 * collection comes back as still-running instead of wedging the run.
 *
 * These tests drive the real `runSubAgent` with a stub agent whose `send`
 * holds a REAL live `sleep` child (killed on abort, like runGuardedShell's
 * onAbort) and whose `stream()` stays open until the session closes — the
 * production shape of a worker parked in shell collection.
 */
import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withMockedModuleDuring } from "../../tests/helpers/mock-module.js";
import { defined } from "../../tests/helpers/defined.js";
import { createPermissionGate } from "../permission/gate.js";
import type { RunSubAgentParams, RunSubAgentResult } from "./types.js";

const testPermissionGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
  reactorGated: false,
});

async function tmpCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cl7990-shell-child-"));
}

async function waitForChildExit(
  child: ChildProcess,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  while (child.exitCode === null && child.signalCode === null) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `shell child pid=${child.pid} still live after ${timeoutMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Stub agent modeling a worker parked behind a live shell child: `send`
 * spawns a real `sleep` descendant and pends (like shell collection output);
 * the abort listener kills the child first, mirroring runGuardedShell's
 * onAbort. `stream()` stays open until `releaseStream` — the session cannot
 * drain while the descendant is wedged. `leakOnAbort` models a stub that
 * never kills: send-abort rejects and close() releases the stream, both
 * without killAll (and close stays non-wedged). The descendant is spawned
 * outside the shell guard, so production teardown never sees it — the run
 * must settle with the child still live, and the test reaps its own orphan
 * via the exposed killAll.
 */
function createShellChildAgent(opts?: {
  wedgeClose?: boolean;
  leakOnAbort?: boolean;
}) {
  const children: ChildProcess[] = [];
  let releaseStream: () => void = () => {
    // Replaced by the streamGate resolver below; the initializer only
    // satisfies definite assignment before the executor runs.
  };
  const streamGate = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  const killAll = (): void => {
    for (const child of children) {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already dead — the kill is best-effort.
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // Already dead — the kill is best-effort.
      }
    }
  };
  return {
    children,
    releaseStream,
    killAll,
    async send(_content: string, optsSend?: { signal?: AbortSignal }) {
      const child = spawn("sleep", ["60"], {
        stdio: "ignore",
        detached: true,
      });
      child.unref();
      children.push(child);
      return await new Promise<never>((_resolve, reject) => {
        const abort = (reason: unknown): void => {
          // leakOnAbort rejects without killing: the descendant stays live
          // through teardown (production only reaps shell-guard-tracked
          // children, and this stub-spawned sleep is not one).
          if (opts?.leakOnAbort !== true) killAll();
          reject(reason instanceof Error ? reason : new Error("aborted"));
        };
        if (optsSend?.signal?.aborted === true) {
          abort(optsSend.signal.reason);
          return;
        }
        optsSend?.signal?.addEventListener(
          "abort",
          () => {
            abort(defined(optsSend.signal).reason);
          },
          { once: true },
        );
      });
    },
    stream: () =>
      (async function* () {
        await streamGate;
        yield* [];
      })(),
    deliver: () => undefined,
    close: async () => {
      // close() initiates the kill, but a wedged descendant holds the stream
      // open and the close itself never completes. leakOnAbort instead
      // releases the stream without killing, and stays non-wedged.
      if (opts?.leakOnAbort !== true) killAll();
      releaseStream();
      if (opts?.wedgeClose === true) {
        await new Promise<never>(() => {
          // Wedged: the close never completes while the descendant holds on.
        });
      }
    },
    setSource: () => undefined,
    setSources: () => undefined,
    history: async () => [],
    checkpoints: async () => [],
    readAt: async () => [],
    blobReader: {},
  };
}

type Handles = {
  close: (ms?: number) => Promise<void>;
  interrupt: () => void;
  followup: (message: string) => Promise<string>;
};

async function runWithShellChildAgent(
  agent: ReturnType<typeof createShellChildAgent>,
  params?: Partial<RunSubAgentParams>,
): Promise<{ runPromise: Promise<unknown>; handles: Handles }> {
  const { runSubAgent } = await import("./run.js");
  const cwd = await tmpCwd();
  let handles: Handles | undefined;
  const runParams: RunSubAgentParams = {
    cwd,
    workdirBase: join(cwd, ".ctx"),
    permissionGate: testPermissionGate,
    provider: {
      providerName: "test",
      baseURL: "http://localhost",
      model: "test-model",
    },
    description: "shell-child reap probe",
    prompt: "run the thing that hangs in shell collection",
    persist: true,
    onAgentReady: (h) => {
      handles = h;
    },
    ...params,
  };
  const runPromise = runSubAgent(runParams);
  for (let i = 0; i < 500 && handles === undefined; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  if (handles === undefined) throw new Error("onAgentReady never fired");
  // Wait until the stub send has spawned its live shell child.
  for (let i = 0; i < 500 && agent.children.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  if (agent.children.length === 0) {
    throw new Error("stub send never spawned its shell child");
  }
  return { runPromise, handles };
}

/**
 * Drive a body with the live-tool-dispatch module mocked to hand out `agent`.
 * Extracts the mock boilerplate shared by every test below; the body is
 * invoked unchanged.
 */
async function runWithStubAgent<T>(
  agent: ReturnType<typeof createShellChildAgent>,
  body: () => Promise<T>,
): Promise<T> {
  return withMockedModuleDuring(
    import.meta.resolve("../agent/live-tool-dispatch.js"),
    (real: typeof import("../agent/live-tool-dispatch.js")) => ({
      ...real,
      createAgentWithLiveToolDispatch: async () =>
        agent as unknown as Awaited<
          ReturnType<typeof real.createAgentWithLiveToolDispatch>
        >,
    }),
    body,
  );
}

describe("CL-7990 shell-child reap: sessions holding a live shell child settle", () => {
  test("interrupt settles a session parked behind a live shell child", async () => {
    const agent = createShellChildAgent();
    const outcome = await runWithStubAgent(agent, async () => {
      const { runPromise, handles } = await runWithShellChildAgent(agent, {
        persist: true,
      });
      handles.interrupt();
      const result = (await runPromise) as { interrupted?: boolean };
      return result;
    });
    expect(outcome.interrupted).toBe(true);
    for (const child of agent.children) {
      await waitForChildExit(child);
    }
  });

  test("interrupt mid-wedge with a queued steer settles the run and launches the stash", async () => {
    const agent = createShellChildAgent();
    const { createSubAgentSessionStore } = await import("./session-store.js");
    const store = createSubAgentSessionStore();
    const session = store.start({
      description: "d",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    const followupCalls: string[] = [];
    const outcome = await runWithStubAgent(agent, async () => {
      const { runPromise, handles } = await runWithShellChildAgent(agent, {
        persist: true,
      });
      // Wire the live run's handles like agent-fleet's onAgentReady.
      store.registerInterrupt(session.id, handles.interrupt);
      store.registerFollowup(session.id, async (message: string) => {
        followupCalls.push(message);
        return "steer reply";
      });
      store.markRunning(session.id);
      // The steer arrives while the worker is wedged: it stashes and fires
      // the interrupt; the bounded teardown must still settle the run.
      expect(
        store.sendInputOne(session.id, "steer mid-wedge", {
          interrupt: true,
        }),
      ).toEqual({ ok: true, status: "interrupted" });
      const result = (await runPromise) as RunSubAgentResult;
      // agent-fleet settlement: attach the salvage so the stashed steer
      // launches instead of stranding on a phantom turn.
      store.attachReport(
        session.id,
        result.report,
        result.stopReason !== undefined
          ? { stopReason: result.stopReason }
          : undefined,
      );
      return result;
    });
    expect(outcome.interrupted).toBe(true);
    // The stash launched synchronously from attachReport: the queued steer
    // was delivered, not dropped, and the shell child was reaped.
    expect(followupCalls).toEqual(["steer mid-wedge"]);
    for (const child of agent.children) {
      await waitForChildExit(child);
    }
  });

  test(
    "close settles a session whose stream is wedged by a shell descendant",
    async () => {
      const agent = createShellChildAgent({ wedgeClose: true });
      const outcome = await runWithStubAgent(agent, async () => {
        const { runPromise, handles } = await runWithShellChildAgent(agent, {
          persist: false,
        });
        const closeError = await handles.close(500).then(
          () => undefined,
          (err: unknown) => err,
        );
        expect(String(defined(closeError))).toMatch(/session close exceeded/);
        const settled = await Promise.race([
          runPromise.then(
            (result) => ({ state: "resolved" as const, result }),
            (error: unknown) => ({ state: "rejected" as const, error }),
          ),
          new Promise<{ state: "timeout" }>((resolve) => {
            setTimeout(() => resolve({ state: "timeout" }), 45_000);
          }),
        ]);
        expect(settled.state).not.toBe("timeout");
        return settled;
      });
      expect(outcome.state).not.toBe("timeout");
      for (const child of agent.children) {
        await waitForChildExit(child);
      }
    },
    { timeout: 60_000 },
  );

  test(
    "interrupt with a leaky stub settles while the descendant is still live",
    async () => {
      // The stub never kills: send-abort rejects and close() releases the
      // stream, both without killAll (and close stays non-wedged). The run
      // must still settle — teardown never waits on a descendant it cannot
      // see. The stub-spawned sleep is outside the shell guard's tracked
      // set, so production cannot reap it: the test reaps its own orphan in
      // the finally, and waitForChildExit proves the collection.
      const agent = createShellChildAgent({ leakOnAbort: true });
      try {
        const outcome = await runWithStubAgent(agent, async () => {
          const { runPromise, handles } = await runWithShellChildAgent(agent, {
            persist: true,
          });
          handles.interrupt();
          const result = (await runPromise) as { interrupted?: boolean };
          return result;
        });
        expect(outcome.interrupted).toBe(true);
        // The wedged-descendant shape, for real this time: the child is
        // still live at settle time — no stub kill and no production reap
        // collected it behind the scenes.
        expect(agent.children.length).toBeGreaterThan(0);
        for (const child of agent.children) {
          expect(child.exitCode).toBeNull();
          expect(child.signalCode).toBeNull();
        }
      } finally {
        agent.killAll();
        for (const child of agent.children) {
          await waitForChildExit(child);
        }
      }
    },
    { timeout: 60_000 },
  );
});

/**
 * CL-7997 kill proof: the tests above prove the run settles under a wedged
 * child, but none proves a shell-guard-tracked child is actually KILLED on
 * close/dispose. This drives a real `sleep` through `runGuardedShell` (the
 * shell-guard tracking primitive) and the exact `reapLiveChildren` call the
 * plugin dispose runs, then asserts on the ChildProcess handle itself that
 * the process is dead — not just that the run settled.
 */
describe("CL-7997 shell-guard kill proof: dispose leaves the tracked child dead", () => {
  test(
    "reapLiveChildren kills a shell-guard-tracked sleep child",
    async () => {
      if (process.platform === "win32") return;
      const { runGuardedShell, reapLiveChildren } =
        await import("../plugins/shell-guard-plugin.js");
      const liveChildren = new Set<ChildProcess>();
      const controller = new AbortController();
      const running = runGuardedShell(
        { command: "sleep 60" },
        controller.signal,
        liveChildren,
      );
      let child: ChildProcess | undefined;
      try {
        const started = Date.now();
        while (liveChildren.size === 0 && Date.now() - started < 5_000) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(liveChildren.size).toBe(1);
        child = defined([...liveChildren][0]);
        // Live before the reap, so the death assertion below is not vacuous.
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
        await reapLiveChildren(liveChildren);
        await waitForChildExit(child);
        await running;
      } finally {
        controller.abort();
        if (child !== undefined) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already dead — best-effort orphan guard.
          }
        }
      }
    },
    { timeout: 30_000 },
  );
});
