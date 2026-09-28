import { describe, expect, test } from "bun:test";

import { withMockedModuleDuring } from "../../tests/helpers/mock-module.js";
import { setActiveRun, clearActiveRun } from "../session/active-run.js";
import type { RunStateHandle } from "../session/active-run.js";
import type { Config } from "../config/index.js";
import type { RunState } from "../session/state.js";
import type { Telemetry } from "../telemetry/index.js";

describe("createTUICrashGuard", () => {
  test("finalizeOnCrash writes live session id and provider:model after bindLiveSession", async () => {
    const captured: { cwd: string; sessionId: string; state: RunState }[] = [];

    await withMockedModuleDuring(
      import.meta.resolve("../session/state.js"),
      (real: typeof import("../session/state.js")) => ({
        ...real,
        finalizeRunState: async (
          cwd: string,
          sessionId: string,
          state: RunState,
        ) => {
          captured.push({ cwd, sessionId, state });
        },
      }),
      async () => {
        clearActiveRun();
        setActiveRun({
          sessionId: "live-session",
          cwd: "/live-cwd",
          task: "live task",
          startedAt: 99,
          turnsUsed: 4,
          model: "live-provider:live-model",
        });
        const { createTUICrashGuard } = await import("./session-start.js");
        const guard = createTUICrashGuard(() => ({
          cwd: "/boot-cwd",
          sessionId: "boot-session",
          startedAt: 1,
          runTaskTitle: "boot task",
          providerName: "boot-provider",
          model: "boot-model",
        }));

        let sessionId = "boot-session";
        let startedAt = 1;
        let runTaskTitle = "boot task";
        let providerName = "boot-provider";
        let model = "boot-model";
        const config = { cwd: "/live-cwd", providerName, model };

        sessionId = "live-session";
        startedAt = 99;
        runTaskTitle = "live task";
        providerName = "live-provider";
        model = "live-model";
        config.providerName = providerName;
        config.model = model;

        guard.bindLiveSession(() => ({
          cwd: config.cwd,
          sessionId,
          startedAt,
          runTaskTitle,
          providerName: config.providerName,
          model: config.model,
        }));

        await guard.finalizeOnCrash(new Error("boom"));

        expect(captured).toHaveLength(1);
        expect(captured[0]?.cwd).toBe("/live-cwd");
        expect(captured[0]?.sessionId).toBe("live-session");
        expect(captured[0]?.state.status).toBe("failed");
        expect(captured[0]?.state.task).toBe("live task");
        expect(captured[0]?.state.startedAt).toBe(99);
        expect(captured[0]?.state.error).toBe("boom");
        expect(captured[0]?.state.model).toBe("live-provider:live-model");
        expect(captured[0]?.state.turnsUsed).toBe(4);
        clearActiveRun();
      },
    );
  });

  test("invokeDisposeHost returns an async dispose handle", async () => {
    const { createTUICrashGuard } = await import("./session-start.js");
    const guard = createTUICrashGuard(() => ({
      cwd: "/cwd",
      sessionId: "session",
      startedAt: 1,
      runTaskTitle: "task",
      providerName: "provider",
      model: "model",
    }));
    let ran = false;
    guard.setDisposeHost(async () => {
      await Promise.resolve();
      ran = true;
    });
    await guard.invokeDisposeHost();
    expect(ran).toBe(true);
  });
});

interface CapturedSave {
  cwd: string;
  sessionId: string;
  state: RunState;
}

function storedRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    status: "running",
    turnsUsed: 7,
    task: "stored task",
    startedAt: 111,
    model: "stored-p:stored-m",
    ...overrides,
  };
}

function launchConfig(overrides: Partial<Config> = {}): Config {
  return {
    configured: true,
    apiKey: "key",
    baseURL: "https://example.test",
    model: "launch-m",
    providerName: "launch-p",
    cwd: "/cwd",
    task: "",
    dangerouslySkipPermissions: false,
    anthropicCachePrompt: false,
    skipPermissionsFromSettings: false,
    auto: true,
    command: "tui",
    globalSettingsPath: "/settings",
    providers: [],
    mcpServerEntries: [],
    sessionId: "launch-session",
    noWorkflow: false,
    ...overrides,
  } as Config;
}

async function runPrepareTUISession(
  config: Config,
  opts: { pickSessionId?: string; stored?: RunState | null },
): Promise<{
  prepared: Awaited<
    ReturnType<typeof import("./session-start.js").prepareTUISession>
  >;
  saves: CapturedSave[];
  activeRuns: RunStateHandle[];
}> {
  const saves: CapturedSave[] = [];
  const activeRuns: RunStateHandle[] = [];
  const stored = opts.stored === undefined ? storedRunState() : opts.stored;
  const prepared = await withMockedModuleDuring(
    import.meta.resolve("../session/assemble-runtime.js"),
    (real: typeof import("../session/assemble-runtime.js")) => ({
      ...real,
      assembleInferenceBase: async () => ({}),
      assembleSessionTrust: async () => ({}),
    }),
    async () =>
      withMockedModuleDuring(
        import.meta.resolve("./pick-session.js"),
        (real: typeof import("./pick-session.js")) => ({
          ...real,
          pickSession: async () =>
            opts.pickSessionId === undefined
              ? null
              : {
                  sessionId: opts.pickSessionId,
                  task: "picked task",
                  startedAt: 1,
                  updatedAt: 2,
                  status: "running" as const,
                },
        }),
        async () =>
          withMockedModuleDuring(
            import.meta.resolve("../session/state.js"),
            (real: typeof import("../session/state.js")) => ({
              ...real,
              loadState: async () =>
                stored === null
                  ? { kind: "missing" as const }
                  : { kind: "ok" as const, state: stored },
              saveState: async (
                cwd: string,
                sessionId: string,
                state: RunState,
              ) => {
                saves.push({ cwd, sessionId, state });
              },
            }),
            async () =>
              withMockedModuleDuring(
                import.meta.resolve("../session/index.js"),
                (real: typeof import("../session/index.js")) => ({
                  ...real,
                  initSessionDir: async () => "/dir",
                  sessionContextDir: () => "/workdir",
                }),
                async () =>
                  withMockedModuleDuring(
                    import.meta.resolve("../session/active-run.js"),
                    (real: typeof import("../session/active-run.js")) => ({
                      ...real,
                      setActiveRun: (handle: RunStateHandle) => {
                        activeRuns.push(handle);
                      },
                    }),
                    async () => {
                      const { prepareTUISession } =
                        await import("./session-start.js");
                      return prepareTUISession(config, {} as Telemetry);
                    },
                  ),
              ),
          ),
      ),
  );
  return { prepared, saves, activeRuns };
}

describe("prepareTUISession resume model", () => {
  test("picker resume without flags restores the stored provider:model", async () => {
    const { prepared, saves } = await runPrepareTUISession(
      launchConfig({ resumePicker: true }),
      { pickSessionId: "picked-session" },
    );

    expect(prepared?.config.providerName).toBe("stored-p");
    expect(prepared?.config.model).toBe("stored-m");
    expect(saves).toHaveLength(1);
    expect(saves[0]?.state.model).toBe("stored-p:stored-m");
  });

  test("id resume without flags restores the stored provider:model", async () => {
    const { prepared, saves, activeRuns } = await runPrepareTUISession(
      launchConfig({ resumeMode: "id", sessionId: "resume-id" }),
      {},
    );

    expect(prepared?.config.providerName).toBe("stored-p");
    expect(prepared?.config.model).toBe("stored-m");
    expect(prepared?.resumeSeed.storedModel).toEqual({
      providerName: "stored-p",
      model: "stored-m",
    });
    expect(saves).toHaveLength(1);
    expect(saves[0]?.sessionId).toBe("resume-id");
    expect(saves[0]?.state.model).toBe("stored-p:stored-m");
    expect(activeRuns).toHaveLength(1);
    expect(activeRuns[0]?.model).toBe("stored-p:stored-m");
  });

  test("explicit flags win over the stored model on both resume branches", async () => {
    for (const config of [
      launchConfig({ resumePicker: true, modelOverride: true }),
      launchConfig({
        resumeMode: "id",
        sessionId: "resume-id",
        modelOverride: true,
      }),
    ]) {
      const { prepared, saves } = await runPrepareTUISession(config, {
        pickSessionId: "picked-session",
      });

      expect(prepared?.config.providerName).toBe("launch-p");
      expect(prepared?.config.model).toBe("launch-m");
      expect(saves).toHaveLength(1);
      expect(saves[0]?.state.model).toBe("launch-p:launch-m");
    }
  });

  test("legacy model-less records keep the launch default", async () => {
    const { model: _dropped, ...legacy } = storedRunState();
    const { prepared, saves } = await runPrepareTUISession(
      launchConfig({ resumePicker: true }),
      { pickSessionId: "picked-session", stored: legacy },
    );

    expect(prepared?.config.providerName).toBe("launch-p");
    expect(prepared?.config.model).toBe("launch-m");
    expect(prepared?.resumeSeed.storedModel).toBeUndefined();
    expect(saves).toHaveLength(1);
    expect(saves[0]?.state.model).toBe("launch-p:launch-m");
  });

  test("resolveResumeSeed carries the stored model and tolerates malformed values", async () => {
    const { resolveResumeSeed } = await import("./session-start.js");

    expect(resolveResumeSeed(null)).toEqual({
      turnsUsed: 0,
      mcpServers: [],
      activatedTools: [],
    });
    expect(resolveResumeSeed(storedRunState()).storedModel).toEqual({
      providerName: "stored-p",
      model: "stored-m",
    });
    expect(
      resolveResumeSeed(storedRunState({ model: "stored-p:org:model-v2" }))
        .storedModel,
    ).toEqual({ providerName: "stored-p", model: "org:model-v2" });
    for (const model of ["nocolon", ":empty-provider", "provider:", ""]) {
      expect(
        resolveResumeSeed(storedRunState({ model })).storedModel,
      ).toBeUndefined();
    }
    const { model: _dropped, ...legacy } = storedRunState();
    expect(resolveResumeSeed(legacy).storedModel).toBeUndefined();
  });
});
