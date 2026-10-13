import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ReactorEmittedEvent } from "@intx/inference";

import {
  callFleetTool,
  createFleetDeps,
  deferred,
  fleetTools,
  spawnAgentId,
} from "./fleet-test-harness.js";
import {
  baseRunParams,
  stubAgent,
  tmpSubAgentCwd,
  withStubbedAgent,
} from "./run-test-harness.js";
import { isSubAgentLoopGuardError } from "./terminal-failure.js";
import type {
  RunSubAgentParams,
  RunSubAgentResult,
  SubAgentRunSettlement,
} from "./types.js";

const DOOM_MESSAGE =
  "Doom loop detected: an identical tool batch (grep, glob) executed 3 times consecutively";

type Run = (params: RunSubAgentParams) => Promise<RunSubAgentResult>;

/**
 * Replays the vendored reactor's doom-loop shutdown as a worker sees it: the
 * fatal reactor.error rejects the send first, and the `doom_loop` run end
 * only reaches the stream after that rejection.
 */
async function withRunEndingIn<T>(
  kind: string,
  body: (run: Run, cwd: string) => Promise<T>,
): Promise<T> {
  const cwd = await tmpSubAgentCwd("loop-guard-");
  const sendRejected = deferred<undefined>();
  try {
    return await withStubbedAgent(
      stubAgent({
        send: async () => {
          setTimeout(() => sendRejected.resolve(undefined), 0);
          throw new Error(`reactor error: ${DOOM_MESSAGE}`);
        },
        stream: () =>
          (async function* (): AsyncGenerator<ReactorEmittedEvent> {
            yield {
              type: "inference.start",
              seq: 1,
              data: { sourceId: "test", model: "test-model", input: [] },
            } as unknown as ReactorEmittedEvent;
            await sendRejected.promise;
            yield {
              type: "reactor.error",
              seq: 2,
              data: { error: DOOM_MESSAGE, fatal: true },
            } as unknown as ReactorEmittedEvent;
            yield {
              type: "message.run.ended",
              seq: 3,
              data: {
                messageRunId: "run-1",
                messageId: "msg-1",
                status: "failed",
                error: { message: DOOM_MESSAGE, kind },
              },
            } as unknown as ReactorEmittedEvent;
          })(),
      }),
      async () => {
        const { runSubAgent } = await import("./run.js");
        return body(runSubAgent, cwd);
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function spawnAndCollect(
  run: Run,
  cwd: string,
): Promise<Record<string, unknown>> {
  const deps = createFleetDeps(run, { cwd });
  deps.getWorkdirBase = () => join(cwd, ".ctx");
  const tools = fleetTools(deps);
  const id = await spawnAgentId(tools.spawn, {
    description: "discovery",
    prompt: "find it",
    intent: "explore",
  });
  const waited = await callFleetTool(tools.wait, {
    targets: [id],
    timeout_ms: 5_000,
  });
  const rows = waited.results as Record<string, unknown>[];
  return rows[0] ?? {};
}

describe("loop-guard termination", () => {
  test("runSubAgent rethrows a doom-loop stop as a typed loop-guard error", async () => {
    await withRunEndingIn("doom_loop", async (run, cwd) => {
      let settled: SubAgentRunSettlement | undefined;
      let caught: unknown;
      try {
        await run(
          baseRunParams(cwd, {
            onRunSettled: (summary) => {
              settled = summary;
            },
          }),
        );
      } catch (error) {
        caught = error;
      }
      expect(isSubAgentLoopGuardError(caught)).toBe(true);
      expect((caught as Error).message).toBe(`reactor error: ${DOOM_MESSAGE}`);
      // Telemetry stop_reason is unchanged: the run still ends as "error".
      expect(settled?.terminal_reason).toBe("error");
    });
  });

  test("the parent sees loop_guard, distinct from a provider failure", async () => {
    await withRunEndingIn("doom_loop", async (run, cwd) => {
      const row = await spawnAndCollect(run, cwd);
      expect(row.status).toBe("failed");
      expect(row.error).toBe(`reactor error: ${DOOM_MESSAGE}`);
      expect(row.failure).toMatchObject({
        failure_class: "loop_guard",
        recovery: { available: false, reason: "not_retryable" },
      });
      expect(row.provider_failure).toBeUndefined();
      expect(row.continuable).toBeUndefined();
    });
  });

  test("a failed run end of another kind is not a loop guard", async () => {
    await withRunEndingIn("reactor_fatal", async (run, cwd) => {
      const row = await spawnAndCollect(run, cwd);
      expect(row.status).toBe("failed");
      expect((row.failure as { failure_class?: string }).failure_class).toBe(
        "error",
      );
    });
  });
});
