import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ReactorEmittedEvent } from "@intx/inference";

import {
  isResolvedProviderFailureError,
  type ResolvedProviderFailureError,
} from "../inference-error-message.js";
import type { InferenceErrorLike } from "../inference-gateway-error.js";
import type { RetryPolicy } from "@intx/types/runtime";
import { MAX_BLIND_WAIT_MS } from "../agent/retry-policy.js";
import {
  createFleetMailbox,
  createSpawnAgentTool,
  createWaitAgentsTool,
} from "./agent-fleet.js";
import { unlimitedAdmissionQueue } from "./admission.js";
import { createSubAgentSessionStore } from "./session-store.js";
import type { RunSubAgentParams, RunSubAgentResult } from "./types.js";
import {
  callFleetTool,
  deferred,
  testPermissionGate,
} from "./fleet-test-harness.js";
import {
  stubAgent,
  tmpSubAgentCwd,
  withStubbedAgent,
} from "./run-test-harness.js";

const OPAQUE_SECRET = "opaque credential with spaces?!";
const RAW_DIAGNOSTIC = `\u001b[31mPOST https://provider.invalid returned\n credential ${OPAQUE_SECRET} in response body\u001b[0m`;
const NORMALIZED_DIAGNOSTIC = `POST https://provider.invalid returned credential ${OPAQUE_SECRET} in response body`;
const SCRUBBED_DIAGNOSTIC =
  "POST https://provider.invalid returned credential [redacted: configured credential] in response body";
const SAFE_MESSAGE = `test-provider Provider failed (fatal): ${SCRUBBED_DIAGNOSTIC}. Try again or switch models with "/model".`;
const provider = {
  providerName: "test-provider",
  baseURL: "http://localhost",
  apiKey: OPAQUE_SECRET,
  model: "test-model",
};

type Run = (params: RunSubAgentParams) => Promise<RunSubAgentResult>;

async function withResolvedProviderRun<T>(
  callback: (
    run: Run,
    cwd: string,
    observed: ReactorEmittedEvent[],
  ) => Promise<T>,
  providerError: InferenceErrorLike = {
    category: "fatal",
    message: RAW_DIAGNOSTIC,
  },
  sendFailure?: Error,
): Promise<T> {
  const cwd = await tmpSubAgentCwd("resolved-provider-failure-");
  const observed: ReactorEmittedEvent[] = [];
  let inferenceErrorConsumed: (() => void) | undefined;
  const inferenceErrorWasConsumed = new Promise<void>((resolve) => {
    inferenceErrorConsumed = resolve;
  });
  try {
    return await withStubbedAgent(
      stubAgent({
        send: async () => {
          if (sendFailure !== undefined) {
            await inferenceErrorWasConsumed;
            throw sendFailure;
          }
          await new Promise<void>((resolve) => queueMicrotask(resolve));
          return {
            reply: RAW_DIAGNOSTIC,
            turn: { role: "assistant", content: [] },
          };
        },
        stream: () =>
          (async function* (): AsyncGenerator<ReactorEmittedEvent> {
            yield {
              type: "inference.start",
              seq: 1,
              data: { sourceId: "test", model: "test-model", input: [] },
            } as unknown as ReactorEmittedEvent;
            yield {
              type: "inference.error",
              seq: 2,
              data: {
                error: providerError,
                partial: { text: "" },
              },
            } as unknown as ReactorEmittedEvent;
            inferenceErrorConsumed?.();
            yield {
              type: "connector.reply",
              seq: 3,
              data: { content: RAW_DIAGNOSTIC },
            } as unknown as ReactorEmittedEvent;
          })(),
      }),
      async () => {
        const { runSubAgent } = await import("./run.js");
        const run: Run = (params) =>
          runSubAgent({
            ...params,
            onEvent: (event) => {
              observed.push(event);
              params.onEvent?.(event);
            },
          });
        return callback(run, cwd, observed);
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

// Retry schedules are exercised, not timed: 1ms delays keep the suite off the production backoffs.
const fastRetryPolicy: RetryPolicy = (situation) =>
  situation.error.category === "retryable" && situation.attempt < 3
    ? { kind: "retry", delayMs: 1 }
    : { kind: "abort" };

function runParams(cwd: string): RunSubAgentParams {
  return {
    cwd,
    workdirBase: join(cwd, ".ctx"),
    permissionGate: testPermissionGate,
    provider,
    description: "provider failure probe",
    prompt: "trigger the provider",
    outerRetryDelayMs: 1,
    retryPolicy: fastRetryPolicy,
  };
}

interface RetryAttemptScript {
  error?: InferenceErrorLike;
  replyText?: string;
  toolCalls?: string[];
}

async function withScriptedProviderRun<T>(
  scripts: RetryAttemptScript[],
  callback: (run: Run, cwd: string, sendCount: () => number) => Promise<T>,
): Promise<T> {
  const cwd = await tmpSubAgentCwd("outer-retry-");
  let sendCount = 0;
  const started = scripts.map(() => deferred<undefined>());
  const eventsDone = scripts.map(() => deferred<undefined>());
  try {
    return await withStubbedAgent(
      stubAgent({
        send: async () => {
          const index = Math.min(sendCount, scripts.length - 1);
          sendCount += 1;
          started[index]?.resolve(undefined);
          await eventsDone[index]?.promise;
          const script = scripts[index] ?? {};
          return {
            type: "reply",
            reply: script.replyText ?? "recovered",
            turn: { role: "assistant", content: [] },
          };
        },
        stream: () =>
          (async function* (): AsyncGenerator<ReactorEmittedEvent> {
            let seq = 1;
            for (const [index, script] of scripts.entries()) {
              await started[index]?.promise;
              for (const name of script.toolCalls ?? []) {
                yield {
                  type: "tool.start",
                  seq: seq++,
                  data: { call: { name, arguments: {} } },
                } as unknown as ReactorEmittedEvent;
              }
              if (script.error !== undefined) {
                yield {
                  type: "inference.error",
                  seq: seq++,
                  data: {
                    error: script.error,
                    partial: { text: "" },
                  },
                } as unknown as ReactorEmittedEvent;
              } else {
                yield {
                  type: "inference.start",
                  seq: seq++,
                  data: {
                    sourceId: "test",
                    model: "test-model",
                    input: [],
                  },
                } as unknown as ReactorEmittedEvent;
              }
              yield {
                type: "connector.reply",
                seq: seq++,
                data: { content: script.replyText ?? "" },
              } as unknown as ReactorEmittedEvent;
              eventsDone[index]?.resolve(undefined);
            }
          })(),
      }),
      async () => {
        const { runSubAgent } = await import("./run.js");
        return callback(runSubAgent, cwd, () => sendCount);
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

interface SpawnAndWaitOutcome {
  sessions: ReturnType<typeof createSubAgentSessionStore>;
  agentId: string;
  waitResult: Record<string, unknown>;
}

async function spawnAndWait(
  run: Run,
  cwd: string,
  description: string,
): Promise<SpawnAndWaitOutcome> {
  const sessions = createSubAgentSessionStore();
  const fleetRecords = createFleetMailbox(sessions);
  const spawned = await callFleetTool(
    createSpawnAgentTool({
      ...runParams(cwd),
      getWorkdirBase: () => join(cwd, ".ctx"),
      sessions,
      fleetRecords,
      admission: unlimitedAdmissionQueue(),
      run,
    }),
    { description, prompt: "trigger it", intent: "explore" },
  );
  const agentId = spawned.agent_id;
  if (typeof agentId !== "string") throw new Error("missing agent_id");
  const waitResult = await callFleetTool(
    createWaitAgentsTool({ sessions, fleetRecords }),
    { targets: [agentId], timeout_ms: 5000 },
  );
  return { sessions, agentId, waitResult };
}

describe("resolved sub-agent provider failures", () => {
  test("runSubAgent rejects a raw director reply after inference.error", async () => {
    const { caught, observed } = await withResolvedProviderRun(
      async (run, cwd, observed) => {
        try {
          await run(runParams(cwd));
        } catch (error) {
          return { caught: error, observed };
        }
        throw new Error("expected runSubAgent to reject");
      },
    );

    expect(isResolvedProviderFailureError(caught)).toBe(true);
    expect((caught as ResolvedProviderFailureError).message).toBe(SAFE_MESSAGE);
    expect((caught as ResolvedProviderFailureError).category).toBe("fatal");
    expect(JSON.stringify(caught)).not.toContain(RAW_DIAGNOSTIC);
    expect(JSON.stringify(caught)).not.toContain(NORMALIZED_DIAGNOSTIC);
    const observedError = observed.find(
      (event) => event.type === "inference.error",
    );
    if (observedError?.type !== "inference.error")
      throw new Error("expected sanitized inference.error");
    expect(observedError.data.error.message).toContain(
      "POST https://provider.invalid returned",
    );
    expect(observedError.data.error.message).toContain("in response body");
    expect(observedError.data.error.message).not.toContain(OPAQUE_SECRET);
    expect(observedError.data.error.message).not.toContain("\u001b");
    expect(JSON.stringify(observed)).not.toContain(RAW_DIAGNOSTIC);
  });

  test("xAI 400 mailbox line lifts the nested diagnostic from raw", async () => {
    const caught = await withResolvedProviderRun(
      async (run, cwd) => {
        try {
          await run({
            ...runParams(cwd),
            provider: { ...provider, providerName: "xai/default-2" },
          });
        } catch (error) {
          return error;
        }
        throw new Error("expected runSubAgent to reject");
      },
      {
        category: "fatal",
        message: "Bad Request",
        statusCode: 400,
        raw: { error: { message: "Invalid request: recursive JSON schema" } },
      },
    );
    expect(isResolvedProviderFailureError(caught)).toBe(true);
    expect((caught as ResolvedProviderFailureError).message).toContain(
      "Invalid request: recursive JSON schema",
    );
    expect((caught as ResolvedProviderFailureError).message).not.toContain(
      "Bad Request",
    );
  });

  test("split spawn_agent and wait_agents return only the safe message", async () => {
    await withResolvedProviderRun(async (run, cwd) => {
      const { sessions, agentId, waitResult } = await spawnAndWait(
        run,
        cwd,
        "provider failure",
      );
      const waitPayload = waitResult as {
        results?: {
          agent_id?: string;
          status?: string;
          error?: string;
          provider_failure?: boolean;
        }[];
      };

      expect(waitPayload.results?.[0]).toEqual({
        agent_id: agentId,
        status: "failed",
        error: SAFE_MESSAGE,
        provider_failure: true,
      });
      const serialized = JSON.stringify(waitResult);
      expect(serialized).not.toContain(RAW_DIAGNOSTIC);
      expect(serialized).not.toContain(NORMALIZED_DIAGNOSTIC);
      expect(sessions.get(agentId)?.error).toBe(SAFE_MESSAGE);
      expect(sessions.get(agentId)?.error).not.toContain(RAW_DIAGNOSTIC);
      expect(sessions.get(agentId)?.error).not.toContain(NORMALIZED_DIAGNOSTIC);
    });
  });

  test("a rejected send after inference.error stores only safe classified failure text", async () => {
    const providerError = {
      category: "retryable",
      message: RAW_DIAGNOSTIC,
      statusCode: 502,
    } satisfies InferenceErrorLike;
    await withResolvedProviderRun(
      async (run, cwd) => {
        const { sessions, agentId, waitResult } = await spawnAndWait(
          run,
          cwd,
          "rejected provider failure",
        );
        const safeFailure = `test-provider Provider failed (retryable): ${SCRUBBED_DIAGNOSTIC}. Try again.`;

        const serialized = JSON.stringify(waitResult);
        expect(serialized).toContain(safeFailure);
        expect(serialized).not.toContain(RAW_DIAGNOSTIC);
        expect(serialized).not.toContain(NORMALIZED_DIAGNOSTIC);
        expect(sessions.get(agentId)?.error).toBe(safeFailure);
        expect(sessions.get(agentId)?.error).not.toContain(RAW_DIAGNOSTIC);
        expect(sessions.get(agentId)?.error).not.toContain(
          NORMALIZED_DIAGNOSTIC,
        );
      },
      providerError,
      new Error(RAW_DIAGNOSTIC),
    );
  });

  test.each([
    {
      error: {
        category: "retryable",
        message: RAW_DIAGNOSTIC,
        statusCode: 500,
      },
      expected: `test-provider Provider failed (retryable): ${SCRUBBED_DIAGNOSTIC}. Try again.`,
    },
    {
      error: { category: "protocol_mismatch", message: RAW_DIAGNOSTIC },
      expected: `test-provider Provider failed (protocol_mismatch): ${SCRUBBED_DIAGNOSTIC}. Switch models with "/model".`,
    },
  ] satisfies { error: InferenceErrorLike; expected: string }[])(
    "preserves $error.category guidance and the scrubbed diagnostic",
    async ({ error, expected }) => {
      const caught = await withResolvedProviderRun(async (run, cwd) => {
        try {
          await run(runParams(cwd));
        } catch (failure) {
          return failure;
        }
        throw new Error("expected runSubAgent to reject");
      }, error);

      expect(isResolvedProviderFailureError(caught)).toBe(true);
      expect((caught as ResolvedProviderFailureError).category).toBe(
        error.category,
      );
      expect((caught as ResolvedProviderFailureError).statusCode).toBe(
        error.statusCode,
      );
      expect((caught as ResolvedProviderFailureError).message).toBe(expected);
      expect((caught as ResolvedProviderFailureError).message).not.toContain(
        RAW_DIAGNOSTIC,
      );
      expect((caught as ResolvedProviderFailureError).message).not.toContain(
        NORMALIZED_DIAGNOSTIC,
      );
    },
  );

  test("outer retry does not retry a fatal failure", async () => {
    const { caught, sends } = await withScriptedProviderRun(
      [{ error: { category: "fatal", message: RAW_DIAGNOSTIC } }],
      async (run, cwd, sendCount) => {
        try {
          await run(runParams(cwd));
        } catch (error) {
          return { caught: error, sends: sendCount() };
        }
        throw new Error("expected runSubAgent to reject");
      },
    );

    expect(sends).toBe(1);
    expect(isResolvedProviderFailureError(caught)).toBe(true);
    expect((caught as ResolvedProviderFailureError).category).toBe("fatal");
  });

  test("outer retry rethrows the last error unchanged once exhausted", async () => {
    const first = {
      category: "retryable",
      message: RAW_DIAGNOSTIC,
      statusCode: 503,
    } satisfies InferenceErrorLike;
    const second = {
      category: "retryable",
      message: "still failing",
      statusCode: 503,
    } satisfies InferenceErrorLike;
    const { caught, sends } = await withScriptedProviderRun(
      [{ error: first }, { error: second }],
      async (run, cwd, sendCount) => {
        try {
          await run(runParams(cwd));
        } catch (error) {
          return { caught: error, sends: sendCount() };
        }
        throw new Error("expected runSubAgent to reject");
      },
    );

    expect(sends).toBe(2);
    expect(isResolvedProviderFailureError(caught)).toBe(true);
    const resolved = caught as ResolvedProviderFailureError;
    expect(resolved.category).toBe("retryable");
    expect(resolved.statusCode).toBe(503);
    expect(resolved.message).toBe(
      `test-provider Provider failed (retryable): still failing. Try again.`,
    );
  });

  test("interrupt during backoff sleep salvages as interrupted, not a provider failure", async () => {
    let interrupt: (() => void) | undefined;
    let sawRetryNotice = false;
    const { result, sends } = await withScriptedProviderRun(
      [
        {
          error: {
            category: "retryable",
            message: RAW_DIAGNOSTIC,
            statusCode: 502,
          },
        },
      ],
      async (run, cwd, sendCount) => ({
        result: await run({
          ...runParams(cwd),
          onAgentReady: (handles) => {
            interrupt = handles.interrupt;
          },
          onProgress: (info) => {
            if (info.toolName !== "retry") return;
            sawRetryNotice = true;
            interrupt?.();
          },
        }),
        sends: sendCount(),
      }),
    );

    expect(sawRetryNotice).toBe(true);
    expect(sends).toBe(1);
    expect(result.stopReason).toBe("interrupted");
    expect(result.interrupted).toBe(true);
  });

  test("outer retry honors a short 429 retryAfterMs on the 2nd send", async () => {
    let retryDelayMs: number | undefined;
    const { result, sends } = await withScriptedProviderRun(
      [
        {
          error: {
            category: "retryable",
            message: RAW_DIAGNOSTIC,
            statusCode: 429,
            retryAfterMs: 10,
          },
        },
        { replyText: "## Summary\nrecovered" },
      ],
      async (run, cwd, sendCount) => ({
        result: await run({
          ...runParams(cwd),
          onProgress: (info) => {
            if (info.toolName !== "retry") return;
            const match = info.description.match(/in (\d+)ms/);
            if (match !== null) retryDelayMs = Number(match[1]);
          },
        }),
        sends: sendCount(),
      }),
    );

    expect(retryDelayMs).toBe(10);
    expect(sends).toBe(2);
    expect(result.report).toContain("recovered");
  });

  test("outer retry caps a long 429 retryAfterMs at MAX_BLIND_WAIT_MS", async () => {
    let interrupt: (() => void) | undefined;
    let retryDelayMs: number | undefined;
    const { result, sends } = await withScriptedProviderRun(
      [
        {
          error: {
            category: "retryable",
            message: RAW_DIAGNOSTIC,
            statusCode: 429,
            retryAfterMs: 120_000,
          },
        },
      ],
      async (run, cwd, sendCount) => ({
        result: await run({
          ...runParams(cwd),
          onAgentReady: (handles) => {
            interrupt = handles.interrupt;
          },
          onProgress: (info) => {
            if (info.toolName !== "retry") return;
            const match = info.description.match(/in (\d+)ms/);
            if (match !== null) retryDelayMs = Number(match[1]);
            interrupt?.();
          },
        }),
        sends: sendCount(),
      }),
    );

    expect(retryDelayMs).toBeDefined();
    expect(retryDelayMs as number).toBeLessThanOrEqual(MAX_BLIND_WAIT_MS);
    expect(sends).toBe(1);
    expect(result.stopReason).toBe("interrupted");
  });

  test("outer retry does not retry a raw send rejection without inference.error", async () => {
    const cwd = await tmpSubAgentCwd("outer-retry-raw-");
    let sends = 0;
    const rawError = new Error("raw send boom");
    try {
      await withStubbedAgent(
        stubAgent({
          send: async () => {
            sends += 1;
            throw rawError;
          },
          stream: () =>
            (async function* (): AsyncGenerator<ReactorEmittedEvent> {
              yield {
                type: "inference.start",
                seq: 1,
                data: { sourceId: "test", model: "test-model", input: [] },
              } as unknown as ReactorEmittedEvent;
              yield {
                type: "connector.reply",
                seq: 2,
                data: { content: "" },
              } as unknown as ReactorEmittedEvent;
            })(),
        }),
        async () => {
          const { runSubAgent } = await import("./run.js");
          try {
            await runSubAgent(runParams(cwd));
          } catch (error) {
            expect(sends).toBe(1);
            expect(error).toBe(rawError);
            expect(isResolvedProviderFailureError(error)).toBe(false);
            return;
          }
          throw new Error("expected runSubAgent to reject");
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
