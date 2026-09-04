import { describe, expect, test } from "bun:test";

import { withMockedModuleDuring } from "../../tests/helpers/mock-module.js";
import type { RunState } from "../session/state.js";

describe("createTUICrashGuard", () => {
  test("finalizeOnCrash writes live session id and provider:model after bindLiveSession", async () => {
    const captured: { cwd: string; sessionId: string; state: RunState }[] = [];

    await withMockedModuleDuring(
      import.meta.resolve("../session/state.js"),
      (real: typeof import("../session/state.js")) => ({
        ...real,
        finalizeRunState: async (cwd: string, sessionId: string, state: RunState) => {
          captured.push({ cwd, sessionId, state });
        },
      }),
      async () => {
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
      },
    );
  });
});
