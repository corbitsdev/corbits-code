/**
 * Persist close_agent must surface a leftover-child posix dispose, not treat
 * it as a successful bounded close. Intern persist (no shell_collect) must
 * still disposeAll leftover registry children even though the session stays
 * retained.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReactorEmittedEvent } from "@intx/inference";

import { withMockedModuleDuring } from "../../tests/helpers/mock-module.js";
import { defined } from "../../tests/helpers/defined.js";
import { INTERN_TOOLS } from "../agent/directors/tool-sets.js";
import { createPermissionGate } from "../permission/gate.js";
import type { BackgroundShellRegistry } from "../shell/background-shell.js";
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
  };
}

/** Poll until no process carries `token`; fail instead of asserting on a pid. */
async function waitUntilGone(token: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    const probe = spawnSync("pgrep", ["-f", token], { encoding: "utf8" });
    if ((probe.stdout?.trim() ?? "").length === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`tagged child still alive after 5s: ${token}`);
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
              throw new Error(
                "1 shell child process still live after 2000ms reap",
              );
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
              provider: {
                providerName: "test",
                baseURL: "http://localhost",
                model: "test-model",
              },
              description: "persist close leftover probe",
              prompt: "finish the first turn",
              persist: true,
              onAgentReady: (h) => {
                handles = h;
              },
            };
            const result = await runSubAgent(params);
            expect(result.agentRetained).toBe(true);
            if (handles === undefined)
              throw new Error("onAgentReady never fired");
            await expect(handles.close(1000)).rejects.toThrow(
              /still live after 2000ms reap/,
            );
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
                close: () => new Promise<void>(() => undefined),
              }) as unknown as Awaited<
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
              provider: {
                providerName: "test",
                baseURL: "http://localhost",
                model: "test-model",
              },
              description: "persist close hung close probe",
              prompt: "finish the first turn",
              persist: true,
              onAgentReady: (h) => {
                handles = h;
              },
            };
            const result = await runSubAgent(params);
            expect(result.agentRetained).toBe(true);
            if (handles === undefined)
              throw new Error("onAgentReady never fired");
            await expect(handles.close(50)).rejects.toThrow(
              /session close exceeded 50ms/,
            );
            expect(posixDisposed).toBe(true);
          },
        ),
    );
  });

  test("onAgentReady close surfaces leftover posix dispose when agent.close hangs", async () => {
    const cwd = await mkdtemp(
      join(tmpdir(), "corbits-persist-close-leftover-hang-"),
    );
    let closeStarted = false;

    await withMockedModuleDuring(
      import.meta.resolve("@intx/tools-posix"),
      (real: typeof import("@intx/tools-posix")) => ({
        ...real,
        createPosixTools: (opts: Parameters<typeof real.createPosixTools>[0]) =>
          Object.assign(real.createPosixTools(opts), {
            dispose: async () => {
              throw new Error(
                "1 shell child process still live after 2000ms reap",
              );
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
                  return new Promise<void>(() => undefined);
                },
              }) as unknown as Awaited<
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
              provider: {
                providerName: "test",
                baseURL: "http://localhost",
                model: "test-model",
              },
              description: "persist close leftover hung close probe",
              prompt: "finish the first turn",
              persist: true,
              onAgentReady: (h) => {
                handles = h;
              },
            };
            const result = await runSubAgent(params);
            expect(result.agentRetained).toBe(true);
            if (handles === undefined)
              throw new Error("onAgentReady never fired");
            await expect(handles.close(200)).rejects.toThrow(
              /still live after 2000ms reap/,
            );
            expect(closeStarted).toBe(true);
          },
        ),
    );
  });
});

describe("intern persist reaps leftover registry children when collect is unmounted", () => {
  test("a leftover background child is disposeAll'd even though the intern session is retained", async () => {
    expect(INTERN_TOOLS as readonly string[]).not.toContain("shell_collect");
    const cwd = await mkdtemp(join(tmpdir(), "corbits-intern-persist-reap-"));
    const token = `ic_intern_persist_${randomUUID()}`;
    let registry: BackgroundShellRegistry | undefined;
    const disposeReasons: string[] = [];
    let leftoverId: string | undefined;

    await withMockedModuleDuring(
      import.meta.resolve("../shell/background-shell.js"),
      (real: typeof import("../shell/background-shell.js")) => ({
        ...real,
        createBackgroundShellRegistry: (
          opts: Parameters<typeof real.createBackgroundShellRegistry>[0],
        ) => {
          const inner = real.createBackgroundShellRegistry(opts);
          const wrapped: BackgroundShellRegistry = {
            ...inner,
            disposeAll: (reason: string) => {
              disposeReasons.push(reason);
              inner.disposeAll(reason);
            },
          };
          registry = wrapped;
          return wrapped;
        },
      }),
      async () =>
        withMockedModuleDuring(
          import.meta.resolve("../agent/live-tool-dispatch.js"),
          (real: typeof import("../agent/live-tool-dispatch.js")) => ({
            ...real,
            createAgentWithLiveToolDispatch: async () =>
              ({
                ...stubAgent(),
                send: async () => {
                  const captured = defined(registry);
                  const started = captured.start({
                    command: `sleep 600 # ${token}`,
                    cwd,
                  });
                  if ("error" in started) throw new Error(started.error);
                  leftoverId = started.id;
                  expect(captured.runningCount()).toBe(1);
                  await new Promise((resolve) => setTimeout(resolve, 20));
                  return {
                    type: "reply" as const,
                    reply: "done",
                    turn: { role: "assistant", content: [] },
                  };
                },
              }) as unknown as Awaited<
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
              provider: {
                providerName: "test",
                baseURL: "http://localhost",
                model: "test-model",
              },
              description: "intern persist leftover registry probe",
              prompt: "finish the first turn",
              persist: true,
              directorId: "intern",
              capabilities: { mode: "allow", tools: [...INTERN_TOOLS] },
              onAgentReady: (h) => {
                handles = h;
              },
            };
            try {
              const result = await runSubAgent(params);
              expect(result.agentRetained).toBe(true);
              expect(disposeReasons).toEqual(["sub-agent closed"]);
              const captured = defined(registry);
              expect(captured.runningCount()).toBe(0);
              const leftover = await captured.collect(defined(leftoverId), 0);
              expect(leftover.state).toBe("not-found");
              if (process.platform !== "win32") {
                await waitUntilGone(token);
              }
            } finally {
              registry?.disposeAll("test done");
              if (handles !== undefined) {
                await handles.close(1000).catch(() => undefined);
              }
            }
          },
        ),
    );
  });
});
