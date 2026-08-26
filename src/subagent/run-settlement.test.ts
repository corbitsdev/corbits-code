import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReactorEmittedEvent } from "@intx/inference";

import { withMockedModuleDuring } from "../../tests/helpers/mock-module.js";
import { createPermissionGate } from "../permission/gate.js";
import type { SubAgentRunSettlement } from "./types.js";

const permissionGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
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
              data: { call: { id: "call-1", name: "read_file", arguments: {} } },
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
                turn: { role: "assistant", content: [], model: "backup-model", timestamp: 0 },
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
        deliver: () => {},
        close: async () => {},
        setSource: () => {},
        setSources: () => {},
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
