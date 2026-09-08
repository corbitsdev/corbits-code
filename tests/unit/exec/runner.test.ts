import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import type { InferenceSource } from "@intx/types/runtime";
import type { Config } from "../../../src/config/index.js";
import {
  disposeExecRuntime,
  execUserFailureMessage,
  formatCaughtError,
  refreshSelectedProviderCredential,
  resolveExecDirectorOverlay,
  runExec,
} from "../../../src/exec/runner.js";
import { BUILD_TOOLS, SKYWALKER_TOOLS } from "../../../src/agent/directors/tool-sets.js";
import { clearActiveRun, getActiveRun, setActiveRun } from "../../../src/session/active-run.js";
import { getActiveDisposeHost } from "../../../src/session/active-host.js";
import { loadState, type RunState } from "../../../src/session/state.js";
import type { AgentToolset } from "../../../src/agent/tools.js";
import { createSubAgentSessionStore } from "../../../src/subagent/session-store.js";
import { withMockedModuleDuring } from "../../helpers/mock-module.js";

function bareConfig(task: string): Config {
  // Minimal unconfigured-shaped object is not enough — runExec only needs
  // `task` for the empty-prompt early return before any bootstrap.
  return {
    command: "exec",
    task,
    cwd: process.cwd(),
    configured: true,
    providerName: "test",
    model: "test",
    providers: {},
    force: false,
    dangerouslySkipPermissions: true,
    autoMode: false,
    sessionId: "test-session",
  } as unknown as Config;
}

describe("formatCaughtError", () => {
  test("prefers Error.message and stringifies other values", () => {
    expect(formatCaughtError(new Error("disk full"))).toBe("disk full");
    expect(formatCaughtError("plain")).toBe("plain");
    expect(formatCaughtError(42)).toBe("42");
  });
});

describe("selected provider refresh failures", () => {
  test("a non-provider failure remains distinct after inference has run", () => {
    expect(execUserFailureMessage(bareConfig("hello"), new Error("disk full"), false)).toBe(
      "disk full",
    );
  });

  test("pre-inference OAuth failure keeps diagnostics internal and returns safe copy", async () => {
    const config = {
      ...bareConfig("hello"),
      providerName: "codex/work",
      settings: { providers: { "codex/work": { name: "Codex" } } },
    } as unknown as Config;
    const rawDiagnostic = '401 {"error":"refresh token rejected"}';

    try {
      await refreshSelectedProviderCredential(() => Promise.reject(new Error(rawDiagnostic)));
      throw new Error("expected refresh to fail");
    } catch (err) {
      expect(formatCaughtError(err)).toBe(rawDiagnostic);
      const userMessage = execUserFailureMessage(config, err, false);
      expect(userMessage).toBe("Authentication failed — log in again.");
      expect(userMessage).not.toContain(rawDiagnostic);
    }
  });

  test("terminal provider failures use the shared classified diagnostic", () => {
    const config = {
      ...bareConfig("hello"),
      providerName: "codex/work",
      settings: { providers: { "codex/work": { name: "Codex" } } },
    } as unknown as Config;

    expect(
      execUserFailureMessage(config, new Error("send failed"), true, {
        category: "protocol_mismatch",
        message: "\u001b[31mresponse\n shape changed\u001b[0m",
      }),
    ).toBe(
      'Codex Provider failed (protocol_mismatch): response shape changed. Switch models with "/model".',
    );
  });

  test("terminal provider failures prefer an explicit failing provider", () => {
    const config = {
      ...bareConfig("hello"),
      providerName: "openai",
      settings: { providers: { openai: { name: "OpenAI" } } },
    } as unknown as Config;

    expect(
      execUserFailureMessage(config, new Error("send failed"), true, {
        providerId: "xai/work",
        category: "credential_failure",
        message: "HTTP 401",
      }),
    ).toBe(
      "xai/work Provider failed (credential_failure): HTTP 401. Authentication failed — log in again.",
    );
  });
});

describe("runExec", () => {
  test("empty prompt exits 2 with stderr message without bootstrapping", async () => {
    const previous = getActiveRun();
    clearActiveRun();
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return origWrite(chunk as never, ...(rest as never[]));
    }) as typeof process.stderr.write;

    try {
      const result = await runExec(bareConfig("   "));
      expect(result.exitCode).toBe(2);
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/missing prompt|empty prompt/i);
      expect(stderrChunks.join("")).toMatch(/missing prompt|empty prompt|Usage: corbits exec/i);
      expect(getActiveRun()).toBeNull();
    } finally {
      process.stderr.write = origWrite;
      if (previous !== null) setActiveRun(previous);
      else clearActiveRun();
    }
  });

  test("bootstrap throw after running write leaves terminal run.json and no active run", async () => {
    const previous = getActiveRun();
    clearActiveRun();
    const cwd = mkdtempSync(join(tmpdir(), "corbits-exec-boot-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "corbits-exec-boot-home-"));
    const sessionId = "exec-bootstrap-fail";
    try {
      await withMockedModuleDuring(
        import.meta.resolve("node:os"),
        (real: typeof import("node:os")) => ({ ...real, homedir: () => home }),
        async () => {
          await withMockedModuleDuring(
            import.meta.resolve("../../../src/session/assemble-runtime.js"),
            (real: typeof import("../../../src/session/assemble-runtime.js")) => ({
              ...real,
              assembleInferenceBase: () => Promise.reject(new Error("bootstrap failed")),
            }),
            async () => {
              const { runExec: runExecUnderMock } = await import("../../../src/exec/runner.js");
              const result = await runExecUnderMock({
                ...bareConfig("do the thing"),
                cwd,
                sessionId,
              });
              expect(result.exitCode).toBe(1);
              expect(result.status).toBe("failed");
              const persisted = await loadState(cwd, sessionId, home);
              expect(persisted.kind).toBe("ok");
              if (persisted.kind !== "ok") return;
              expect(persisted.state.status).toBe("failed");
              expect(persisted.state.status).not.toBe("running");
              expect(persisted.state.finishedAt).toBeGreaterThan(0);
              expect(persisted.state.task).toBe("do the thing");
              expect(persisted.state.error).toBe("bootstrap failed");
              expect(getActiveRun()).toBeNull();
            },
          );
        },
      );
    } finally {
      if (previous !== null) setActiveRun(previous);
      else clearActiveRun();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an in-flight persist(running) overlapping a terminal persist does not resurrect the handle", async () => {
    const previous = getActiveRun();
    clearActiveRun();
    const cwd = mkdtempSync(join(tmpdir(), "corbits-exec-resurrect-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "corbits-exec-resurrect-home-"));
    const sessionId = "exec-running-overlap";
    const held = Promise.withResolvers<undefined>();
    let runningSaves = 0;
    let heldRunningSave: Promise<void> | undefined;
    const dummySource = { id: "test", provider: "test", model: "test" } as InferenceSource;
    try {
      await withMockedModuleDuring(
        import.meta.resolve("node:os"),
        (real: typeof import("node:os")) => ({ ...real, homedir: () => home }),
        async () => {
          await withMockedModuleDuring(
            import.meta.resolve("../../../src/session/state.js"),
            (real: typeof import("../../../src/session/state.js")) => ({
              ...real,
              saveState: (
                saveCwd: string,
                saveSessionId: string,
                snapshot: RunState,
                saveHome?: string,
              ) => {
                if (snapshot.status === "running") {
                  runningSaves += 1;
                  if (runningSaves === 1) {
                    return real.saveState(saveCwd, saveSessionId, snapshot, saveHome);
                  }
                  const issued = real.saveState(saveCwd, saveSessionId, snapshot, saveHome);
                  heldRunningSave = issued.then(() => held.promise);
                  return heldRunningSave;
                }
                return real.saveState(saveCwd, saveSessionId, snapshot, saveHome);
              },
            }),
            async () => {
              await withMockedModuleDuring(
                import.meta.resolve("../../../src/agent/tools.js"),
                (real: typeof import("../../../src/agent/tools.js")) => ({
                  ...real,
                  createAgentToolset: async (): Promise<AgentToolset> =>
                    ({
                      dispose: () => Promise.resolve(),
                    }) as AgentToolset,
                }),
                async () => {
                  await withMockedModuleDuring(
                    import.meta.resolve("../../../src/session/assemble-runtime.js"),
                    (real: typeof import("../../../src/session/assemble-runtime.js")) => ({
                      ...real,
                      resolveLiveSessionSources: () => ({
                        sources: [dummySource],
                        defaultSource: dummySource.id,
                        selected: dummySource,
                      }),
                      assembleChatAgent: () => ({
                        directorHolder: {},
                        buildAgent: async () => {
                          throw new Error("buildAgent should not run");
                        },
                      }),
                      assembleSessionLifecycle: async (wiring: {
                        onTurnBoundarySnapshot: () => void;
                      }) => {
                        wiring.onTurnBoundarySnapshot();
                        throw new Error("overlap-terminal");
                      },
                    }),
                    async () => {
                      const { runExec: runExecUnderMock } =
                        await import("../../../src/exec/runner.js");
                      const result = await runExecUnderMock({
                        ...bareConfig("do the thing"),
                        cwd,
                        sessionId,
                        director: "builder",
                        globalSettingsPath: join(home, "settings.json"),
                        providers: [],
                      });
                      expect(result.status).toBe("failed");
                      expect(heldRunningSave).toBeDefined();
                      held.resolve(undefined);
                      await heldRunningSave;
                      await Promise.resolve();
                      await Promise.resolve();
                      expect(getActiveRun()).toBeNull();
                      const persisted = await loadState(cwd, sessionId, home);
                      expect(persisted.kind).toBe("ok");
                      if (persisted.kind !== "ok") return;
                      expect(persisted.state.status).toBe("failed");
                      expect(persisted.state.status).not.toBe("running");
                    },
                  );
                },
              );
            },
          );
        },
      );
    } finally {
      if (previous !== null) setActiveRun(previous);
      else clearActiveRun();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("dispose failure after toolset exists is once-only and forces a nonzero exit", async () => {
    const previous = getActiveRun();
    clearActiveRun();
    const cwd = mkdtempSync(join(tmpdir(), "corbits-exec-dispose-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "corbits-exec-dispose-home-"));
    const sessionId = "exec-dispose-fail";
    let disposeCalls = 0;
    const dummySource = { id: "test", provider: "test", model: "test" } as InferenceSource;
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return origWrite(chunk as never, ...(rest as never[]));
    }) as typeof process.stderr.write;
    try {
      await withMockedModuleDuring(
        import.meta.resolve("node:os"),
        (real: typeof import("node:os")) => ({ ...real, homedir: () => home }),
        async () => {
          await withMockedModuleDuring(
            import.meta.resolve("../../../src/agent/tools.js"),
            (real: typeof import("../../../src/agent/tools.js")) => ({
              ...real,
              createAgentToolset: async (): Promise<AgentToolset> =>
                ({
                  dispose: () => {
                    disposeCalls += 1;
                    return Promise.reject(new Error("plugin dispose failed"));
                  },
                }) as AgentToolset,
            }),
            async () => {
              await withMockedModuleDuring(
                import.meta.resolve("../../../src/session/assemble-runtime.js"),
                (real: typeof import("../../../src/session/assemble-runtime.js")) => ({
                  ...real,
                  resolveLiveSessionSources: () => ({
                    sources: [dummySource],
                    defaultSource: dummySource.id,
                    selected: dummySource,
                  }),
                  assembleChatAgent: () => ({
                    directorHolder: {},
                    buildAgent: async () => {
                      throw new Error("buildAgent should not run");
                    },
                  }),
                  assembleSessionLifecycle: async () => {
                    expect(getActiveDisposeHost()).not.toBeNull();
                    throw new Error("stop-after-toolset");
                  },
                }),
                async () => {
                  const { runExec: runExecUnderMock } = await import("../../../src/exec/runner.js");
                  const result = await runExecUnderMock({
                    ...bareConfig("do the thing"),
                    cwd,
                    sessionId,
                    director: "builder",
                    globalSettingsPath: join(home, "settings.json"),
                    providers: [],
                  });
                  expect(result.exitCode).toBe(1);
                  expect(result.status).toBe("failed");
                  expect(result.error).toMatch(/plugin dispose failed|runtime dispose failed/i);
                  expect(stderrChunks.join("")).toMatch(/runtime dispose failed/i);
                  expect(disposeCalls).toBe(1);
                  expect(getActiveDisposeHost()).toBeNull();
                },
              );
            },
          );
        },
      );
    } finally {
      process.stderr.write = origWrite;
      if (previous !== null) setActiveRun(previous);
      else clearActiveRun();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("disposeExecRuntime", () => {
  test("cancels fire-and-forget workers when exec finishes", async () => {
    const store = createSubAgentSessionStore();
    const worker = store.start({ description: "bg", agentId: "w", brief: "b" });
    let aborted = 0;
    store.registerCancel(worker.id, () => {
      aborted += 1;
    });

    const calls: string[] = [];
    await disposeExecRuntime({
      agent: {
        close: async () => {
          calls.push("agent");
        },
      },
      toolset: {
        dispose: async () => {
          calls.push("toolset");
        },
      },
      subAgentSessions: store,
    });

    expect(aborted).toBe(1);
    expect(store.get(worker.id)?.status).toBe("cancelled");
    expect(calls).toEqual(["toolset", "agent"]);
  });

  test("runs teardown only once when called concurrently", async () => {
    const calls: string[] = [];
    const toolset = {
      dispose: async () => {
        calls.push("toolset");
      },
    };
    const args = {
      agent: {
        close: async () => {
          calls.push("agent");
        },
      },
      toolset,
      subAgentSessions: null,
    };

    await Promise.all([disposeExecRuntime(args), disposeExecRuntime(args)]);

    expect(calls).toEqual(["toolset", "agent"]);
  });

  test("reaps the toolset before waiting on a hung agent close", async () => {
    const calls: string[] = [];
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const pending = disposeExecRuntime({
      agent: {
        close: async () => {
          await closeGate;
          calls.push("agent");
        },
      },
      toolset: {
        dispose: async () => {
          calls.push("toolset");
        },
      },
      subAgentSessions: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual(["toolset"]);
    releaseClose();
    await pending;
    expect(calls).toEqual(["toolset", "agent"]);
  });

  test("rejects leftover-child dispose from the toolset", async () => {
    await expect(
      disposeExecRuntime({
        agent: { close: async () => undefined },
        toolset: {
          dispose: async () => {
            throw new Error("1 shell child process still live after 2000ms reap");
          },
        },
        subAgentSessions: null,
      }),
    ).rejects.toThrow(/still live after 2000ms reap/);
  });

  test("surfaces leftover toolset dispose when agent.close hangs", async () => {
    let closeStarted = false;
    const pending = disposeExecRuntime({
      agent: {
        close: () => {
          closeStarted = true;
          return new Promise<void>(() => {});
        },
      },
      toolset: {
        dispose: async () => {
          throw new Error("1 shell child process still live after 2000ms reap");
        },
      },
      subAgentSessions: null,
    });
    const result = await Promise.race([
      pending.then(
        () => ({ kind: "resolved" as const }),
        (err: unknown) => ({ kind: "rejected" as const, err }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) => {
        setTimeout(() => resolve({ kind: "timeout" }), 200);
      }),
    ]);
    expect(closeStarted).toBe(true);
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("expected leftover reject");
    expect(result.err).toBeInstanceOf(Error);
    expect((result.err as Error).message).toMatch(/still live after 2000ms reap/);
  });

  test("rejects when toolset dispose fails", async () => {
    await expect(
      disposeExecRuntime({
        agent: { close: async () => undefined },
        toolset: {
          dispose: async () => {
            throw new Error("plugin dispose failed");
          },
        },
        subAgentSessions: null,
      }),
    ).rejects.toThrow("plugin dispose failed");
  });

  test("cancels every live worker with the close reason before the agent closes", async () => {
    const store = createSubAgentSessionStore();
    const first = store.start({ description: "a", agentId: "w1", brief: "b" });
    const second = store.start({ description: "b", agentId: "w2", brief: "b" });
    const calls: string[] = [];
    store.registerCancel(first.id, () => calls.push("cancel:first"));
    store.registerCancel(second.id, () => calls.push("cancel:second"));

    await disposeExecRuntime({
      agent: { close: async () => void calls.push("agent") },
      toolset: { dispose: async () => void calls.push("toolset") },
      subAgentSessions: store,
    });

    // Cancellation must precede teardown so no worker outlives the runtime.
    expect(calls).toEqual(["cancel:first", "cancel:second", "agent", "toolset"]);
    expect(store.get(first.id)?.status).toBe("cancelled");
    expect(store.get(second.id)?.status).toBe("cancelled");
    expect(store.get(first.id)?.stopReason).toBe("cancelled — Session closed");
    expect(store.get(second.id)?.stopReason).toBe("cancelled — Session closed");
  });

  test("a failing agent close still disposes the toolset and resolves", async () => {
    const store = createSubAgentSessionStore();
    const worker = store.start({ description: "bg", agentId: "w", brief: "b" });
    store.registerCancel(worker.id, () => undefined);

    let disposed = 0;
    await disposeExecRuntime({
      agent: {
        close: () => Promise.reject(new Error("close exploded")),
      },
      toolset: { dispose: async () => void (disposed += 1) },
      subAgentSessions: store,
    });

    expect(store.get(worker.id)?.status).toBe("cancelled");
    expect(disposed).toBe(1);
  });
});

describe("resolveExecDirectorOverlay", () => {
  test("builder exec primary does not mount fleet", () => {
    const overlay = resolveExecDirectorOverlay("builder");
    expect(overlay.mountFleet).toBe(false);
    expect(overlay.advertisedAllow).toBeDefined();
    expect(overlay.advertisedAllow).toEqual([...BUILD_TOOLS]);
    const buildToolSet = new Set<string>(BUILD_TOOLS);
    const fleetVerbs = SKYWALKER_TOOLS.filter((name) => !buildToolSet.has(name));
    expect(fleetVerbs.length).toBeGreaterThan(0);
    for (const verb of fleetVerbs) {
      expect(overlay.advertisedAllow).not.toContain(verb);
    }
    expect(overlay.systemPrompt).toContain("BuilderDirector");
  });

  test("skywalker default still can mount fleet", () => {
    expect(resolveExecDirectorOverlay(undefined).mountFleet).toBe(true);
    expect(resolveExecDirectorOverlay(undefined).systemPrompt).toBeUndefined();
    expect(resolveExecDirectorOverlay(undefined).advertisedAllow).toBeUndefined();
    expect(resolveExecDirectorOverlay("skywalker").mountFleet).toBe(true);
    expect(resolveExecDirectorOverlay("skywalker").systemPrompt).toBeUndefined();
  });
});
