/**
 * Persist close_agent must surface a leftover-child posix dispose, not treat
 * it as a successful bounded close.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReactorEmittedEvent } from "@intx/inference";

import { withMockedModuleDuring } from "../../tests/helpers/mock-module.js";
import { createPermissionGate } from "../permission/gate.js";
import type { RunSubAgentParams } from "./types.js";

const permissionGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
  reactorGated: false,
});

function stubAgent() {
  return {
    send: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        type: "reply" as const,
        reply: "done",
        turn: { role: "assistant", content: [] },
      };
    },
    stream: () => (async function* (): AsyncGenerator<ReactorEmittedEvent> {})(),
    deliver: () => {},
    close: async () => {},
    setSource: () => {},
    setSources: () => {},
    history: async () => [],
    checkpoints: async () => [],
    readAt: async () => [],
    blobReader: {},
  };
}

describe("persist close_agent leftover dispose", () => {
  test("onAgentReady close rejects when posix dispose reports leftover children", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "corbits-persist-close-"));

    await withMockedModuleDuring(
      import.meta.resolve("@intx/tools-posix"),
      (real: typeof import("@intx/tools-posix")) => ({
        ...real,
        createPosixTools: (opts: Parameters<typeof real.createPosixTools>[0]) =>
          Object.assign(real.createPosixTools(opts), {
            dispose: async () => {
              throw new Error("1 shell child process still live after 2000ms reap");
            },
          }),
      }),
      async () =>
        withMockedModuleDuring(
          import.meta.resolve("../agent/live-tool-dispatch.js"),
          (real: typeof import("../agent/live-tool-dispatch.js")) => ({
            ...real,
            createAgentWithLiveToolDispatch: async () =>
              stubAgent() as unknown as Awaited<
                ReturnType<typeof real.createAgentWithLiveToolDispatch>
              >,
          }),
          async () => {
            const { runSubAgent } = await import("./run.js");
            let handles:
              | {
                  close: (deadlineMs?: number) => Promise<void>;
                }
              | undefined;
            const params: RunSubAgentParams = {
              cwd,
              workdirBase: join(cwd, ".ctx"),
              permissionGate,
              provider: { providerName: "test", baseURL: "http://localhost", model: "test-model" },
              description: "persist close leftover probe",
              prompt: "finish the first turn",
              persist: true,
              onAgentReady: (h) => {
                handles = h;
              },
            };
            const result = await runSubAgent(params);
            expect(result.agentRetained).toBe(true);
            if (handles === undefined) throw new Error("onAgentReady never fired");
            await expect(handles.close(1000)).rejects.toThrow(/still live after 2000ms reap/);
          },
        ),
    );
  });

  test("onAgentReady close reaps posix tools before a hung agent.close and fails the deadline", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "corbits-persist-close-hung-"));
    let posixDisposed = false;

    await withMockedModuleDuring(
      import.meta.resolve("@intx/tools-posix"),
      (real: typeof import("@intx/tools-posix")) => ({
        ...real,
        createPosixTools: (opts: Parameters<typeof real.createPosixTools>[0]) =>
          Object.assign(real.createPosixTools(opts), {
            dispose: async () => {
              posixDisposed = true;
            },
          }),
      }),
      async () =>
        withMockedModuleDuring(
          import.meta.resolve("../agent/live-tool-dispatch.js"),
          (real: typeof import("../agent/live-tool-dispatch.js")) => ({
            ...real,
            createAgentWithLiveToolDispatch: async () =>
              ({
                ...stubAgent(),
                close: () => new Promise<void>(() => {}),
              }) as unknown as Awaited<ReturnType<typeof real.createAgentWithLiveToolDispatch>>,
          }),
          async () => {
            const { runSubAgent } = await import("./run.js");
            let handles:
              | {
                  close: (deadlineMs?: number) => Promise<void>;
                }
              | undefined;
            const params: RunSubAgentParams = {
              cwd,
              workdirBase: join(cwd, ".ctx"),
              permissionGate,
              provider: { providerName: "test", baseURL: "http://localhost", model: "test-model" },
              description: "persist close hung close probe",
              prompt: "finish the first turn",
              persist: true,
              onAgentReady: (h) => {
                handles = h;
              },
            };
            const result = await runSubAgent(params);
            expect(result.agentRetained).toBe(true);
            if (handles === undefined) throw new Error("onAgentReady never fired");
            await expect(handles.close(50)).rejects.toThrow(/session close exceeded 50ms/);
            expect(posixDisposed).toBe(true);
          },
        ),
    );
  });

  test("onAgentReady close surfaces leftover posix dispose when agent.close hangs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "corbits-persist-close-leftover-hang-"));
    let closeStarted = false;

    await withMockedModuleDuring(
      import.meta.resolve("@intx/tools-posix"),
      (real: typeof import("@intx/tools-posix")) => ({
        ...real,
        createPosixTools: (opts: Parameters<typeof real.createPosixTools>[0]) =>
          Object.assign(real.createPosixTools(opts), {
            dispose: async () => {
              throw new Error("1 shell child process still live after 2000ms reap");
            },
          }),
      }),
      async () =>
        withMockedModuleDuring(
          import.meta.resolve("../agent/live-tool-dispatch.js"),
          (real: typeof import("../agent/live-tool-dispatch.js")) => ({
            ...real,
            createAgentWithLiveToolDispatch: async () =>
              ({
                ...stubAgent(),
                close: () => {
                  closeStarted = true;
                  return new Promise<void>(() => {});
                },
              }) as unknown as Awaited<ReturnType<typeof real.createAgentWithLiveToolDispatch>>,
          }),
          async () => {
            const { runSubAgent } = await import("./run.js");
            let handles:
              | {
                  close: (deadlineMs?: number) => Promise<void>;
                }
              | undefined;
            const params: RunSubAgentParams = {
              cwd,
              workdirBase: join(cwd, ".ctx"),
              permissionGate,
              provider: { providerName: "test", baseURL: "http://localhost", model: "test-model" },
              description: "persist close leftover hung close probe",
              prompt: "finish the first turn",
              persist: true,
              onAgentReady: (h) => {
                handles = h;
              },
            };
            const result = await runSubAgent(params);
            expect(result.agentRetained).toBe(true);
            if (handles === undefined) throw new Error("onAgentReady never fired");
            await expect(handles.close(200)).rejects.toThrow(/still live after 2000ms reap/);
            expect(closeStarted).toBe(true);
          },
        ),
    );
  });
});
