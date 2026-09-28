/**
 * Persist close_agent must surface a leftover-child posix dispose, not treat
 * it as a successful bounded close. Intern persist (no shell_collect) must
 * still disposeAll leftover registry children even though the session stays
 * retained.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { withMockedModuleDuring } from "../testkit/mock-module.js";
import { defined } from "../testkit/defined.js";
import { INTERN_TOOLS } from "../agent/directors/tool-sets.js";
import type { BackgroundShellRegistry } from "../shell/background-shell.js";
import {
  baseRunParams,
  captureRunHandles,
  stubAgent,
  tmpSubAgentCwd,
  withPosixDispose,
  withStubbedAgent,
} from "./run-test-harness.js";

const delayedReplyAgent = () =>
  stubAgent({
    send: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        type: "reply" as const,
        reply: "done",
        turn: { role: "assistant", content: [] },
      };
    },
  });

const LEFTOVER_DISPOSE = async () => {
  throw new Error("1 shell child process still live after 2000ms reap");
};

/** Poll until a process carries `token`; fail if it never becomes visible. */
async function waitUntilPresent(token: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    const probe = spawnSync("pgrep", ["-f", token], { encoding: "utf8" });
    if ((probe.stdout?.trim() ?? "").length > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`tagged child never appeared: ${token}`);
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
    const cwd = await tmpSubAgentCwd("corbits-persist-close-");

    await withPosixDispose(LEFTOVER_DISPOSE, async () =>
      withStubbedAgent(delayedReplyAgent(), async () => {
        const { runSubAgent } = await import("./run.js");
        const handles = captureRunHandles();
        const result = await runSubAgent(
          baseRunParams(cwd, {
            description: "persist close leftover probe",
            prompt: "finish the first turn",
            persist: true,
            onAgentReady: handles.onAgentReady,
          }),
        );
        expect(result.agentRetained).toBe(true);
        await expect(handles.require().close(1000)).rejects.toThrow(
          /still live after 2000ms reap/,
        );
      }),
    );
  });

  test("onAgentReady close reaps posix tools before a hung agent.close and fails the deadline", async () => {
    const cwd = await tmpSubAgentCwd("corbits-persist-close-hung-");
    let posixDisposed = false;

    await withPosixDispose(
      async () => {
        posixDisposed = true;
      },
      async () =>
        withStubbedAgent(
          {
            ...delayedReplyAgent(),
            close: () => new Promise<void>(() => undefined),
          },
          async () => {
            const { runSubAgent } = await import("./run.js");
            const handles = captureRunHandles();
            const result = await runSubAgent(
              baseRunParams(cwd, {
                description: "persist close hung close probe",
                prompt: "finish the first turn",
                persist: true,
                onAgentReady: handles.onAgentReady,
              }),
            );
            expect(result.agentRetained).toBe(true);
            await expect(handles.require().close(50)).rejects.toThrow(
              /session close exceeded 50ms/,
            );
            expect(posixDisposed).toBe(true);
          },
        ),
    );
  });

  test("onAgentReady close surfaces leftover posix dispose when agent.close hangs", async () => {
    const cwd = await tmpSubAgentCwd("corbits-persist-close-leftover-hang-");
    let closeStarted = false;

    await withPosixDispose(LEFTOVER_DISPOSE, async () =>
      withStubbedAgent(
        {
          ...delayedReplyAgent(),
          close: () => {
            closeStarted = true;
            return new Promise<void>(() => undefined);
          },
        },
        async () => {
          const { runSubAgent } = await import("./run.js");
          const handles = captureRunHandles();
          const result = await runSubAgent(
            baseRunParams(cwd, {
              description: "persist close leftover hung close probe",
              prompt: "finish the first turn",
              persist: true,
              onAgentReady: handles.onAgentReady,
            }),
          );
          expect(result.agentRetained).toBe(true);
          await expect(handles.require().close(200)).rejects.toThrow(
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
    const cwd = await tmpSubAgentCwd("corbits-intern-persist-reap-");
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
        withStubbedAgent(
          {
            ...delayedReplyAgent(),
            send: async () => {
              const captured = defined(registry);
              const started = captured.start({
                // Token must be argv/process-title, not a shell comment:
                // pgrep -f only sees the exec'd sleep, so a comment leak
                // would make waitUntilGone succeed even if kill failed.
                command: `bash -c 'exec -a ${token} sleep 600'`,
                cwd,
              });
              if ("error" in started) throw new Error(started.error);
              leftoverId = started.id;
              expect(captured.runningCount()).toBe(1);
              if (process.platform !== "win32") {
                await waitUntilPresent(token);
              }
              return {
                type: "reply" as const,
                reply: "done",
                turn: { role: "assistant", content: [] },
              };
            },
          },
          async () => {
            const { runSubAgent } = await import("./run.js");
            const handles = captureRunHandles();
            try {
              const result = await runSubAgent(
                baseRunParams(cwd, {
                  description: "intern persist leftover registry probe",
                  prompt: "finish the first turn",
                  persist: true,
                  directorId: "intern",
                  capabilities: { mode: "allow", tools: [...INTERN_TOOLS] },
                  onAgentReady: handles.onAgentReady,
                }),
              );
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
              await handles
                .peek()
                ?.close(1000)
                .catch(() => undefined);
            }
          },
        ),
    );
  });
});
