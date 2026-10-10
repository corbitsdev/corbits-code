import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  callFleetTool,
  createFleetDeps,
  fleetTools,
  spawnAgentId,
} from "./fleet-test-harness.js";
import {
  stubAgent,
  tmpSubAgentCwd,
  withPosixDispose,
  withStubbedAgent,
} from "./run-test-harness.js";

describe("terminal failure cleanup outcome", () => {
  test.each([
    ["a clean teardown", async (): Promise<void> => undefined, "released"],
    [
      "a teardown that leaves children behind",
      async (): Promise<void> => {
        throw new Error("1 shell child process still live after 2000ms reap");
      },
      "partial",
    ],
  ] as const)("%s records cleanup %s", async (_label, dispose, expected) => {
    const cwd = await tmpSubAgentCwd("terminal-cleanup-");
    try {
      await withPosixDispose(dispose, () =>
        withStubbedAgent(
          stubAgent({
            send: async () => {
              throw new Error("send exploded");
            },
          }),
          async () => {
            const { runSubAgent } = await import("./run.js");
            const deps = createFleetDeps(runSubAgent, { cwd });
            deps.getWorkdirBase = () => join(cwd, ".ctx");
            const tools = fleetTools(deps);
            const id = await spawnAgentId(tools.spawn, {
              description: "cleanup probe",
              prompt: "fail",
              intent: "explore",
            });
            const waited = await callFleetTool(tools.wait, {
              targets: [id],
              timeout_ms: 5_000,
            });
            const row = (waited.results as Record<string, unknown>[])[0];
            expect(row?.status).toBe("failed");
            expect(
              (row?.failure as { cleanup?: string } | undefined)?.cleanup,
            ).toBe(expected);
          },
        ),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
