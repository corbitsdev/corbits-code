import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@intx/agent";
import type { ReactorEmittedEvent } from "@intx/inference";

import { withMockedModuleDuring } from "../../tests/helpers/mock-module.js";
import {
  isResolvedProviderFailureError,
  type ResolvedProviderFailureError,
} from "../inference-error-message.js";
import type { InferenceErrorLike } from "../inference-gateway-error.js";
import { MAX_BLIND_WAIT_MS } from "../agent/retry-policy.js";
import { createPermissionGate } from "../permission/gate.js";
import {
  createFleetMailbox,
  createSpawnAgentTool,
  createWaitAgentsTool,
} from "./agent-fleet.js";
import { unlimitedAdmissionQueue } from "./admission.js";
import { createSubAgentSessionStore } from "./session-store.js";
import type { RunSubAgentParams, RunSubAgentResult } from "./types.js";

const RAW_DIAGNOSTIC =
  "\u001b[31mPOST https://provider.invalid returned\n secret response body\u001b[0m";
const NORMALIZED_DIAGNOSTIC =
  "POST https://provider.invalid returned secret response body";
const SAFE_MESSAGE =
  'test-provider Provider failed (fatal). Try again or switch models with "/model".';
const provider = {
  providerName: "test-provider",
  baseURL: "http://localhost",
  model: "test-model",
};
const testPermissionGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
  reactorGated: false,
});

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
  const cwd = await mkdtemp(join(tmpdir(), "resolved-provider-failure-"));
  const observed: ReactorEmittedEvent[] = [];
  let inferenceErrorConsumed: (() => void) | undefined;
  const inferenceErrorWasConsumed = new Promise<void>((resolve) => {
    inferenceErrorConsumed = resolve;
  });
  try {
    return await withMockedModuleDuring(
      import.meta.resolve("../agent/live-tool-dispatch.js"),
      (real: typeof import("../agent/live-tool-dispatch.js")) => ({
        ...real,
        createAgentWithLiveToolDispatch: async () =>
          ({
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
            deliver: () => undefined,
            close: async () => undefined,
            setSource: () => undefined,
            setSources: () => undefined,
            history: async () => [],
            checkpoints: async () => [],
            readAt: async () => [],
            blobReader: {},
          }) as unknown as Awaited<
            ReturnType<typeof real.createAgentWithLiveToolDispatch>
          >,
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

async function callTool(
  tool: AgentTool,
  name: string,
  args: Record<string, unknown>,
) {
  if (tool.kind !== "full")
    throw new Error(`expected full tool, got ${tool.kind}`);
  return tool.handler(
    { id: `${name}-call`, name, arguments: args },
    new AbortController().signal,
  );
}

function runParams(cwd: string): RunSubAgentParams {
  return {
    cwd,
    workdirBase: join(cwd, ".ctx"),
    permissionGate: testPermissionGate,
    provider,
    description: "provider failure probe",
    prompt: "trigger the provider",
  };
}

interface RetryAttemptScript {
  error?: InferenceErrorLike;
  replyText?: string;
  toolCalls?: string[];
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withScriptedProviderRun<T>(
  scripts: RetryAttemptScript[],
  callback: (run: Run, cwd: string, sendCount: () => number) => Promise<T>,
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "outer-retry-"));
  let sendCount = 0;
  const started = scripts.map(() => deferred());
  const eventsDone = scripts.map(() => deferred());
  try {
    return await withMockedModuleDuring(
      import.meta.resolve("../agent/live-tool-dispatch.js"),
      (real: typeof import("../agent/live-tool-dispatch.js")) => ({
        ...real,
        createAgentWithLiveToolDispatch: async () =>
          ({
            send: async () => {
              const index = Math.min(sendCount, scripts.length - 1);
              sendCount += 1;
              started[index]?.resolve();
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
                  eventsDone[index]?.resolve();
                }
              })(),
            deliver: () => undefined,
            close: async () => undefined,
            setSource: () => undefined,
            setSources: () => undefined,
            history: async () => [],
            checkpoints: async () => [],
            readAt: async () => [],
            blobReader: {},
          }) as unknown as Awaited<
            ReturnType<typeof real.createAgentWithLiveToolDispatch>
          >,
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
    expect(
      observed.some(
        (event) =>
          event.type === "inference.error" &&
          event.data.error.message === RAW_DIAGNOSTIC,
      ),
    ).toBe(true);
  });

  test("split spawn_agent and wait_agents return only the safe message", async () => {
    await withResolvedProviderRun(async (run, cwd) => {
      const sessions = createSubAgentSessionStore();
      const fleetRecords = createFleetMailbox(sessions);
      const deps = {
        ...runParams(cwd),
        getWorkdirBase: () => join(cwd, ".ctx"),
        sessions,
        fleetRecords,
        admission: unlimitedAdmissionQueue(),
        run,
      };
      const spawned = await callTool(
        createSpawnAgentTool(deps),
        "spawn_agent",
        {
          description: "provider failure",
          prompt: "trigger it",
          intent: "explore",
        },
      );
      const spawnPayload = JSON.parse(String(spawned.content)) as {
        agent_id?: unknown;
      };
      if (typeof spawnPayload.agent_id !== "string")
        throw new Error("missing agent_id");
      const waited = await callTool(
        createWaitAgentsTool({ sessions, fleetRecords }),
        "wait_agents",
        { targets: [spawnPayload.agent_id], timeout_ms: 5000 },
      );
      const waitPayload = JSON.parse(String(waited.content)) as {
        results?: {
          agent_id?: string;
          status?: string;
          error?: string;
          provider_failure?: boolean;
        }[];
      };

      expect(waitPayload.results?.[0]).toEqual({
        agent_id: spawnPayload.agent_id,
        status: "failed",
        error: SAFE_MESSAGE,
        provider_failure: true,
      });
      expect(String(waited.content)).not.toContain(RAW_DIAGNOSTIC);
      expect(String(waited.content)).not.toContain(NORMALIZED_DIAGNOSTIC);
      expect(sessions.get(spawnPayload.agent_id)?.error).toBe(SAFE_MESSAGE);
      expect(sessions.get(spawnPayload.agent_id)?.error).not.toContain(
        RAW_DIAGNOSTIC,
      );
      expect(sessions.get(spawnPayload.agent_id)?.error).not.toContain(
        NORMALIZED_DIAGNOSTIC,
      );
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
        const sessions = createSubAgentSessionStore();
        const fleetRecords = createFleetMailbox(sessions);
        const deps = {
          ...runParams(cwd),
          getWorkdirBase: () => join(cwd, ".ctx"),
          sessions,
          fleetRecords,
          admission: unlimitedAdmissionQueue(),
          run,
        };
        const spawned = await callTool(
          createSpawnAgentTool(deps),
          "spawn_agent",
          {
            description: "rejected provider failure",
            prompt: "trigger it",
            intent: "explore",
          },
        );
        const spawnPayload = JSON.parse(String(spawned.content)) as {
          agent_id?: unknown;
        };
        if (typeof spawnPayload.agent_id !== "string")
          throw new Error("missing agent_id");
        const waited = await callTool(
          createWaitAgentsTool({ sessions, fleetRecords }),
          "wait_agents",
          { targets: [spawnPayload.agent_id], timeout_ms: 5000 },
        );
        const safeFailure =
          "test-provider Provider failed (retryable). Try again.";

        expect(String(waited.content)).toContain(safeFailure);
        expect(String(waited.content)).not.toContain(RAW_DIAGNOSTIC);
        expect(String(waited.content)).not.toContain(NORMALIZED_DIAGNOSTIC);
        expect(sessions.get(spawnPayload.agent_id)?.error).toBe(safeFailure);
        expect(sessions.get(spawnPayload.agent_id)?.error).not.toContain(
          RAW_DIAGNOSTIC,
        );
        expect(sessions.get(spawnPayload.agent_id)?.error).not.toContain(
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
      expected: "test-provider Provider failed (retryable). Try again.",
    },
    {
      error: { category: "protocol_mismatch", message: RAW_DIAGNOSTIC },
      expected:
        'test-provider Provider failed (protocol_mismatch). Switch models with "/model".',
    },
  ] satisfies { error: InferenceErrorLike; expected: string }[])(
    "preserves $error.category guidance without exposing its diagnostic",
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

  test("outer retry recovers when a retryable failure clears on the 2nd send", async () => {
    const progress: { description: string; toolName: string }[] = [];
    const { result, sends } = await withScriptedProviderRun(
      [
        {
          error: {
            category: "retryable",
            message: RAW_DIAGNOSTIC,
            statusCode: 502,
          },
        },
        { replyText: "## Summary\nrecovered" },
      ],
      async (run, cwd, sendCount) => ({
        result: await run({
          ...runParams(cwd),
          onProgress: (info) => {
            progress.push(info);
          },
        }),
        sends: sendCount(),
      }),
    );

    expect(sends).toBe(2);
    expect(result.report).toContain("recovered");
    const retryNotice = progress.find((info) => info.toolName === "retry");
    expect(retryNotice?.description).toContain("2/2");
  });

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
      "test-provider Provider failed (retryable). Try again.",
    );
  });

  test("outer retry does not retry after a tool already executed", async () => {
    const { caught, sends } = await withScriptedProviderRun(
      [
        {
          error: {
            category: "retryable",
            message: RAW_DIAGNOSTIC,
            statusCode: 502,
          },
          toolCalls: ["read_file"],
        },
      ],
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
    expect((caught as ResolvedProviderFailureError).category).toBe("retryable");
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
    const cwd = await mkdtemp(join(tmpdir(), "outer-retry-raw-"));
    let sends = 0;
    const rawError = new Error("raw send boom");
    try {
      await withMockedModuleDuring(
        import.meta.resolve("../agent/live-tool-dispatch.js"),
        (real: typeof import("../agent/live-tool-dispatch.js")) => ({
          ...real,
          createAgentWithLiveToolDispatch: async () =>
            ({
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
              deliver: () => undefined,
              close: async () => undefined,
              setSource: () => undefined,
              setSources: () => undefined,
              history: async () => [],
              checkpoints: async () => [],
              readAt: async () => [],
              blobReader: {},
            }) as unknown as Awaited<
              ReturnType<typeof real.createAgentWithLiveToolDispatch>
            >,
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

  test("outer retry exhaustion surfaces the second attempt's fields", async () => {
    const { caught, sends } = await withScriptedProviderRun(
      [
        {
          error: {
            category: "retryable",
            message: RAW_DIAGNOSTIC,
            statusCode: 502,
          },
        },
        {
          error: {
            category: "retryable",
            message: "still failing",
            statusCode: 504,
          },
        },
      ],
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
    expect(resolved.statusCode).toBe(504);
  });
});
