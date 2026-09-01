import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@intx/agent";
import type { ReactorEmittedEvent } from "@intx/inference";

import { withMockedModuleDuring } from "../../tests/helpers/mock-module.js";
import {
  isResolvedProviderFailureError,
  type ResolvedProviderFailureError,
} from "../inference-error-message.js";
import { createPermissionGate } from "../permission/gate.js";
import { createFleetRecords, createSpawnAgentTool, createWaitAgentsTool } from "./agent-fleet.js";
import { createSubAgentSessionStore } from "./session-store.js";
import { createTaskTool } from "./task-tool.js";
import type { RunSubAgentParams, RunSubAgentResult } from "./types.js";

const RAW_DIAGNOSTIC = "POST https://provider.invalid returned secret response body";
const SAFE_MESSAGE =
  'test-provider Provider failed. Try again or switch with "/model" and select another.';
const provider = {
  providerName: "test-provider",
  baseURL: "http://localhost",
  model: "test-model",
};
const testPermissionGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
});

type Run = (params: RunSubAgentParams) => Promise<RunSubAgentResult>;

async function withResolvedProviderRun<T>(
  callback: (run: Run, cwd: string, observed: ReactorEmittedEvent[]) => Promise<T>,
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "resolved-provider-failure-"));
  const observed: ReactorEmittedEvent[] = [];
  return withMockedModuleDuring(
    import.meta.resolve("../agent/live-tool-dispatch.js"),
    (real: typeof import("../agent/live-tool-dispatch.js")) => ({
      ...real,
      createAgentWithLiveToolDispatch: async () =>
        ({
          send: async () => {
            await Bun.sleep(10);
            return { reply: RAW_DIAGNOSTIC, turn: { role: "assistant", content: [] } };
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
                  error: { category: "fatal", message: RAW_DIAGNOSTIC },
                  partial: { text: "" },
                },
              } as unknown as ReactorEmittedEvent;
              yield {
                type: "connector.reply",
                seq: 3,
                data: { content: RAW_DIAGNOSTIC },
              } as unknown as ReactorEmittedEvent;
            })(),
          deliver: () => {},
          close: async () => {},
          setSource: () => {},
          setSources: () => {},
          history: async () => [],
          checkpoints: async () => [],
          readAt: async () => [],
          blobReader: {},
        }) as unknown as Awaited<ReturnType<typeof real.createAgentWithLiveToolDispatch>>,
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
}

async function callTool(tool: AgentTool, name: string, args: Record<string, unknown>) {
  if (tool.kind !== "full") throw new Error(`expected full tool, got ${tool.kind}`);
  return tool.handler({ id: `${name}-call`, name, arguments: args }, new AbortController().signal);
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

describe("resolved sub-agent provider failures", () => {
  test("runSubAgent rejects a raw director reply after inference.error", async () => {
    const { caught, observed } = await withResolvedProviderRun(async (run, cwd, observed) => {
      try {
        await run(runParams(cwd));
      } catch (error) {
        return { caught: error, observed };
      }
      throw new Error("expected runSubAgent to reject");
    });

    expect(isResolvedProviderFailureError(caught)).toBe(true);
    expect((caught as ResolvedProviderFailureError).message).toBe(SAFE_MESSAGE);
    expect((caught as ResolvedProviderFailureError).diagnosticMessage).toBe(RAW_DIAGNOSTIC);
    expect(observed.some((event) => JSON.stringify(event).includes(RAW_DIAGNOSTIC))).toBe(true);
  });

  test("fused task returns only the safe message for the resolved reply sequence", async () => {
    await withResolvedProviderRun(async (run, cwd) => {
      const sessions = createSubAgentSessionStore();
      const task = createTaskTool({
        ...runParams(cwd),
        getWorkdirBase: () => join(cwd, ".ctx"),
        sessions,
        fleetRecords: createFleetRecords(),
        run,
      });
      const result = await callTool(task, "task", {
        description: "provider failure",
        prompt: "trigger it",
        intent: "explore",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toBe(SAFE_MESSAGE);
      expect(String(result.content)).not.toContain(RAW_DIAGNOSTIC);
      expect(sessions.list()[0]?.error).toBe(RAW_DIAGNOSTIC);
    });
  });

  test("split spawn_agent and wait_agents return only the safe message", async () => {
    await withResolvedProviderRun(async (run, cwd) => {
      const sessions = createSubAgentSessionStore();
      const fleetRecords = createFleetRecords();
      const deps = {
        ...runParams(cwd),
        getWorkdirBase: () => join(cwd, ".ctx"),
        sessions,
        fleetRecords,
        run,
      };
      const spawned = await callTool(createSpawnAgentTool(deps), "spawn_agent", {
        description: "provider failure",
        prompt: "trigger it",
        intent: "explore",
      });
      const spawnPayload = JSON.parse(String(spawned.content)) as { agent_id?: unknown };
      if (typeof spawnPayload.agent_id !== "string") throw new Error("missing agent_id");
      const waited = await callTool(
        createWaitAgentsTool({ sessions, fleetRecords }),
        "wait_agents",
        { targets: [spawnPayload.agent_id], timeout_ms: 5000 },
      );
      const waitPayload = JSON.parse(String(waited.content)) as {
        results?: { agent_id?: string; status?: string; error?: string }[];
      };

      expect(waitPayload.results?.[0]).toEqual({
        agent_id: spawnPayload.agent_id,
        status: "failed",
        error: SAFE_MESSAGE,
      });
      expect(String(waited.content)).not.toContain(RAW_DIAGNOSTIC);
      expect(sessions.get(spawnPayload.agent_id)?.error).toBe(RAW_DIAGNOSTIC);
    });
  });
});
