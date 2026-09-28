import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReactorEmittedEvent } from "@intx/inference";
import type {
  ContextTransform,
  ConversationTurn,
  StrategyContext,
} from "@intx/types/runtime";

import { withMockedModuleDuring } from "../../tests/helpers/mock-module.js";
import { defined } from "../../tests/helpers/defined.js";
import { createPermissionGate } from "../permission/gate.js";
import type { SubAgentRunSettlement } from "./types.js";

const permissionGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
  reactorGated: false,
});

test("rejected workers settle prior rollups with the latest observed model", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "corbits-run-settlement-"));
  const originalError = new Error("worker failed after prior activity");
  let settlement: Readonly<SubAgentRunSettlement> | undefined;

  const caught = await withMockedModuleDuring(
    import.meta.resolve("../agent/live-tool-dispatch.js"),
    (real: typeof import("../agent/live-tool-dispatch.js")) => ({
      ...real,
      createAgentWithLiveToolDispatch: async () => ({
        send: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw originalError;
        },
        stream: () =>
          (async function* (): AsyncGenerator<ReactorEmittedEvent> {
            yield {
              type: "tool.start",
              seq: 1,
              data: {
                call: { id: "call-1", name: "read_file", arguments: {} },
              },
            } as ReactorEmittedEvent;
            yield {
              type: "tool.done",
              seq: 2,
              data: {
                call: { id: "call-1", name: "read_file", arguments: {} },
                result: { callId: "call-1", content: "failed", isError: true },
              },
            } as ReactorEmittedEvent;
            yield {
              type: "inference.done",
              seq: 3,
              data: {
                turn: {
                  role: "assistant",
                  content: [],
                  model: "backup-model",
                  timestamp: 0,
                },
                usage: {
                  input: 11,
                  output: 7,
                  cacheRead: 3,
                  cacheWrite: 2,
                  thinking: 5,
                },
                source: {
                  sourceId: "backup-source",
                  provider: "backup",
                  model: "backup-model",
                },
              },
            } as ReactorEmittedEvent;
            yield {
              type: "inference.start",
              seq: 4,
              data: { model: "terminal-model" },
            };
          })(),
        deliver: () => undefined,
        close: async () => undefined,
        setSource: () => undefined,
        setSources: () => undefined,
        history: async () => [],
        checkpoints: async () => [],
        readAt: async () => [],
        blobReader: {},
      }),
    }),
    async () => {
      const { runSubAgent } = await import("./run.js");
      try {
        await runSubAgent({
          cwd,
          workdirBase: join(cwd, ".ctx"),
          permissionGate,
          provider: {
            providerName: "initial",
            baseURL: "http://localhost",
            model: "initial-model",
          },
          description: "settlement probe",
          prompt: "do work then fail",
          onRunSettled: (summary) => {
            settlement = summary;
          },
        });
      } catch (error) {
        return error;
      }
      throw new Error("expected runSubAgent to reject");
    },
  );

  expect(caught).toBe(originalError);
  expect(settlement).toMatchObject({
    turn_count: 1,
    input_tokens: 11,
    output_tokens: 7,
    cache_read_tokens: 3,
    cache_write_tokens: 2,
    reasoning_tokens: 5,
    tool_call_count: 1,
    tool_error_count: 1,
    error_count: 1,
    model: "terminal-model",
    terminal_reason: "error",
  });
  expect(Object.isFrozen(settlement)).toBe(true);
});

test("pre-progress cancellation settles as cancelled without changing rejection", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "corbits-run-cancelled-"));
  const controller = new AbortController();
  const originalError = new DOMException("operator cancelled", "AbortError");
  controller.abort(originalError);
  let settlement: Readonly<SubAgentRunSettlement> | undefined;

  const caught = await withMockedModuleDuring(
    import.meta.resolve("../agent/live-tool-dispatch.js"),
    (real: typeof import("../agent/live-tool-dispatch.js")) => ({
      ...real,
      createAgentWithLiveToolDispatch: async () => ({
        send: async () => {
          throw new Error("send must not start after cancellation");
        },
        stream: () =>
          (async function* () {
            yield* [];
          })(),
        deliver: () => undefined,
        close: async () => undefined,
        setSource: () => undefined,
        setSources: () => undefined,
        history: async () => [],
        checkpoints: async () => [],
        readAt: async () => [],
        blobReader: {},
      }),
    }),
    async () => {
      const { runSubAgent } = await import("./run.js");
      try {
        await runSubAgent({
          cwd,
          workdirBase: join(cwd, ".ctx"),
          permissionGate,
          provider: {
            providerName: "initial",
            baseURL: "http://localhost",
            model: "initial-model",
          },
          description: "cancelled settlement probe",
          prompt: "do not start",
          signal: controller.signal,
          onRunSettled: (summary) => {
            settlement = summary;
          },
        });
      } catch (error) {
        return error;
      }
      throw new Error("expected runSubAgent to reject");
    },
  );

  expect(caught).toBe(originalError);
  expect(settlement).toMatchObject({
    turn_count: 0,
    error_count: 1,
    model: "initial-model",
    terminal_reason: "cancelled",
  });
  expect(Object.isFrozen(settlement)).toBe(true);
});

test("tool calls accumulate into family buckets whose sum equals tool_call_count", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "corbits-run-buckets-"));
  const originalError = new Error("bucket probe done");
  let settlement: Readonly<SubAgentRunSettlement> | undefined;
  const toolNames = [
    "read_file",
    "read_file",
    "write_file",
    "run_shell",
    "grep",
    "spawn_agent",
    "manage_tasks",
    "mystery_tool",
  ];

  const caught = await withMockedModuleDuring(
    import.meta.resolve("../agent/live-tool-dispatch.js"),
    (real: typeof import("../agent/live-tool-dispatch.js")) => ({
      ...real,
      createAgentWithLiveToolDispatch: async () => ({
        send: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw originalError;
        },
        stream: () =>
          (async function* (): AsyncGenerator<ReactorEmittedEvent> {
            for (const [index, name] of toolNames.entries()) {
              yield {
                type: "tool.start",
                seq: index + 1,
                data: {
                  call: { id: `call-${index}`, name, arguments: {} },
                },
              } as ReactorEmittedEvent;
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
      }),
    }),
    async () => {
      const { runSubAgent } = await import("./run.js");
      try {
        await runSubAgent({
          cwd,
          workdirBase: join(cwd, ".ctx"),
          permissionGate,
          provider: {
            providerName: "initial",
            baseURL: "http://localhost",
            model: "initial-model",
          },
          description: "bucket probe",
          prompt: "use tools across families",
          onRunSettled: (summary) => {
            settlement = summary;
          },
        });
      } catch (error) {
        return error;
      }
      throw new Error("expected runSubAgent to reject");
    },
  );

  expect(caught).toBe(originalError);
  expect(settlement).toMatchObject({
    tool_call_count: 8,
    tool_read_count: 2,
    tool_write_count: 1,
    tool_shell_count: 1,
    tool_search_count: 1,
    tool_agent_count: 1,
    tool_other_count: 2,
    hydrate_ms: 0,
  });
  const settled = defined(settlement);
  expect(settled.tool_call_count).toBe(
    settled.tool_read_count +
      settled.tool_write_count +
      settled.tool_shell_count +
      settled.tool_search_count +
      settled.tool_agent_count +
      settled.tool_other_count,
  );
});

async function runWithRehydrateDelay(
  delayMs: number,
): Promise<Readonly<SubAgentRunSettlement> | undefined> {
  const cwd = await mkdtemp(join(tmpdir(), "corbits-run-hydrate-"));
  const originalError = new Error("hydrate probe done");
  let settlement: Readonly<SubAgentRunSettlement> | undefined;
  let captured: ContextTransform[] | undefined;
  const testCtx = {} as StrategyContext;

  await withMockedModuleDuring(
    import.meta.resolve("../session/attachment-store.js"),
    (real: typeof import("../session/attachment-store.js")) => ({
      ...real,
      createAttachmentRehydrateTransform: () => ({
        name: "attachment-rehydrate",
        version: "1",
        apply: async (turns: ConversationTurn[]) => {
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          return {
            output: turns,
            record: {
              strategy: "attachment-rehydrate",
              version: "1",
              parameters: {},
              reason: "noop",
              decisions: {},
            },
          };
        },
      }),
    }),
    async () =>
      withMockedModuleDuring(
        import.meta.resolve("../agent/live-tool-dispatch.js"),
        (real: typeof import("../agent/live-tool-dispatch.js")) => ({
          ...real,
          createAgentWithLiveToolDispatch: async (...args: unknown[]) => {
            const env = args[1] as
              | { deps?: { contextTransforms?: ContextTransform[] } }
              | undefined;
            captured = env?.deps?.contextTransforms;
            return {
              send: async () => {
                const rehydrate = captured?.find(
                  (transform) => transform.name === "attachment-rehydrate",
                );
                await rehydrate?.apply([], testCtx);
                throw originalError;
              },
              stream: () =>
                (async function* (): AsyncGenerator<ReactorEmittedEvent> {
                  yield* [];
                })(),
              deliver: () => undefined,
              close: async () => undefined,
              setSource: () => undefined,
              setSources: () => undefined,
              history: async () => [],
              checkpoints: async () => [],
              readAt: async () => [],
              blobReader: {},
            } as unknown as Awaited<
              ReturnType<typeof real.createAgentWithLiveToolDispatch>
            >;
          },
        }),
        async () => {
          const { runSubAgent } = await import("./run.js");
          try {
            await runSubAgent({
              cwd,
              workdirBase: join(cwd, ".ctx"),
              permissionGate,
              provider: {
                providerName: "initial",
                baseURL: "http://localhost",
                model: "initial-model",
              },
              description: "hydrate probe",
              prompt: "rehydrate attachments",
              onRunSettled: (summary) => {
                settlement = summary;
              },
            });
          } catch {
            return;
          }
          throw new Error("expected runSubAgent to reject");
        },
      ),
  );
  return settlement;
}

test("a slow attachment rehydrate accumulates into hydrate_ms", async () => {
  const settlement = await runWithRehydrateDelay(60);
  expect(defined(settlement).hydrate_ms).toBeGreaterThanOrEqual(50);
});

test("a noop attachment rehydrate reports hydrate_ms zero", async () => {
  const settlement = await runWithRehydrateDelay(0);
  expect(defined(settlement).hydrate_ms).toBe(0);
});
