import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditStore, ContextStore } from "@intx/types/runtime";

import { withMockedModuleDuring } from "../../tests/helpers/mock-module.js";
import { defined } from "../../tests/helpers/defined.js";
import { createPermissionGate } from "../permission/gate.js";

const permissionGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
  reactorGated: false,
});

test("runSubAgent threads the isogit audit store and session id into createAgent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "corbits-run-audit-"));
  const fakeStore = {
    readBlob: async () => new Uint8Array(),
  } as unknown as ContextStore & AuditStore;
  let seen:
    | { audit: AuditStore; sessionId?: string; storage: ContextStore }
    | undefined;

  await withMockedModuleDuring(
    import.meta.resolve("../session/optimized-context-store.js"),
    (real: typeof import("../session/optimized-context-store.js")) => ({
      ...real,
      createSessionStores: async () => ({
        storage: fakeStore,
        audit: fakeStore,
      }),
    }),
    async () => {
      await withMockedModuleDuring(
        import.meta.resolve("../agent/live-tool-dispatch.js"),
        (real: typeof import("../agent/live-tool-dispatch.js")) => ({
          ...real,
          createAgentWithLiveToolDispatch: async (
            _def: unknown,
            env: {
              storage: ContextStore;
              audit: AuditStore;
              sessionId?: string;
            },
          ) => {
            seen = env;
            return {
              send: async () => ({
                type: "reply" as const,
                reply: "ok",
                turn: { role: "assistant" as const, content: [] },
              }),
              stream: () =>
                (async function* () {
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
          },
        }),
        async () => {
          const { runSubAgent } = await import("./run.js");
          await runSubAgent({
            cwd,
            workdirBase: join(cwd, ".ctx"),
            permissionGate,
            provider: {
              providerName: "test",
              baseURL: "http://localhost",
              model: "test-model",
            },
            description: "audit wiring",
            prompt: "noop",
            id: "child-session-1",
          });
        },
      );
    },
  );

  const seenStores = defined(seen);
  expect(seenStores.storage).toBe(fakeStore);
  expect(seenStores.audit).toBe(fakeStore);
  expect(seenStores.sessionId).toBe("child-session-1");
});
