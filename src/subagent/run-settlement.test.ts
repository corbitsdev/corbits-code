import { expect, test } from "bun:test";

import type { ReactorEmittedEvent } from "@intx/inference";

import type { SubAgentRunSettlement } from "./types.js";
import {
  baseRunParams,
  stubAgent,
  tmpSubAgentCwd,
  withStubbedAgent,
} from "./run-test-harness.js";

const provider = {
  providerName: "initial",
  baseURL: "http://localhost",
  model: "initial-model",
};

test("rejected workers settle prior rollups with the latest observed model", async () => {
  const cwd = await tmpSubAgentCwd("corbits-run-settlement-");
  const originalError = new Error("worker failed after prior activity");
  let settlement: Readonly<SubAgentRunSettlement> | undefined;

  const caught = await withStubbedAgent(
    stubAgent({
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
    }),
    async () => {
      const { runSubAgent } = await import("./run.js");
      try {
        await runSubAgent(
          baseRunParams(cwd, {
            provider,
            description: "settlement probe",
            prompt: "do work then fail",
            onRunSettled: (summary) => {
              settlement = summary;
            },
          }),
        );
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
  const cwd = await tmpSubAgentCwd("corbits-run-cancelled-");
  const controller = new AbortController();
  const originalError = new DOMException("operator cancelled", "AbortError");
  controller.abort(originalError);
  let settlement: Readonly<SubAgentRunSettlement> | undefined;

  const caught = await withStubbedAgent(
    stubAgent({
      send: async () => {
        throw new Error("send must not start after cancellation");
      },
    }),
    async () => {
      const { runSubAgent } = await import("./run.js");
      try {
        await runSubAgent(
          baseRunParams(cwd, {
            provider,
            description: "cancelled settlement probe",
            prompt: "do not start",
            signal: controller.signal,
            onRunSettled: (summary) => {
              settlement = summary;
            },
          }),
        );
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
