import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

function fakeStore(): ContextStore & AuditStore {
  return {
    readBlob: async () => new Uint8Array(),
  } as unknown as ContextStore & AuditStore;
}

function stubAgent() {
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
}

function runParams(cwd: string, id: string) {
  return {
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
    id,
  };
}

test("runSubAgent threads the isogit audit store and session id into createAgent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "corbits-run-audit-"));
  const store = fakeStore();
  let seen:
    | { audit: AuditStore; sessionId?: string; storage: ContextStore }
    | undefined;

  try {
    await withMockedModuleDuring(
      import.meta.resolve("../session/optimized-context-store.js"),
      (real: typeof import("../session/optimized-context-store.js")) => ({
        ...real,
        createSessionStores: async () => ({ storage: store, audit: store }),
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
              return stubAgent() as unknown as Awaited<
                ReturnType<typeof real.createAgentWithLiveToolDispatch>
              >;
            },
          }),
          async () => {
            const { runSubAgent } = await import("./run.js");
            await runSubAgent(runParams(cwd, "child-session-1"));
          },
        );
      },
    );

    const seenStores = defined(seen);
    expect(seenStores.storage).toBe(store);
    expect(seenStores.audit).toBe(store);
    expect(seenStores.sessionId).toBe("child-session-1");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runSubAgent overlaps store creation with workdir setup", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "corbits-run-store-overlap-"));
  const store = fakeStore();
  let releaseMkdir: (() => void) | undefined;
  let signalMkdirStarted: (() => void) | undefined;
  let signalMkdirFinished: (() => void) | undefined;
  const pendingMkdir = new Promise<void>((resolve) => {
    releaseMkdir = resolve;
  });
  const mkdirStarted = new Promise<void>((resolve) => {
    signalMkdirStarted = resolve;
  });
  const mkdirFinished = new Promise<void>((resolve) => {
    signalMkdirFinished = resolve;
  });
  let resolveStores:
    | ((stores: { storage: ContextStore; audit: AuditStore }) => void)
    | undefined;
  const pendingStores = new Promise<{
    storage: ContextStore;
    audit: AuditStore;
  }>((resolve) => {
    resolveStores = resolve;
  });
  let storeStarted = false;
  let agentConstructed = false;

  try {
    await withMockedModuleDuring(
      import.meta.resolve("node:fs/promises"),
      (real: typeof import("node:fs/promises")) => ({
        ...real,
        mkdir: () => {
          defined(signalMkdirStarted, "mkdir start signal")();
          return pendingMkdir.then(() => {
            defined(signalMkdirFinished, "mkdir finish signal")();
            return undefined;
          });
        },
      }),
      async () => {
        await withMockedModuleDuring(
          import.meta.resolve("../session/optimized-context-store.js"),
          (real: typeof import("../session/optimized-context-store.js")) => ({
            ...real,
            createSessionStores: () => {
              storeStarted = true;
              return pendingStores;
            },
          }),
          async () => {
            await withMockedModuleDuring(
              import.meta.resolve("../agent/live-tool-dispatch.js"),
              (real: typeof import("../agent/live-tool-dispatch.js")) => ({
                ...real,
                createAgentWithLiveToolDispatch: async () => {
                  agentConstructed = true;
                  return stubAgent() as unknown as Awaited<
                    ReturnType<typeof real.createAgentWithLiveToolDispatch>
                  >;
                },
              }),
              async () => {
                const { runSubAgent } = await import("./run.js");
                const run = runSubAgent(runParams(cwd, "overlap-child"));
                await mkdirStarted;

                expect(storeStarted).toBe(true);
                expect(agentConstructed).toBe(false);

                defined(releaseMkdir, "mkdir resolver")();
                await mkdirFinished;
                expect(agentConstructed).toBe(false);

                defined(
                  resolveStores,
                  "store resolver",
                )({
                  storage: store,
                  audit: store,
                });
                await run;
                expect(agentConstructed).toBe(true);
              },
            );
          },
        );
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runSubAgent keeps session stores isolated between workers", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "corbits-run-store-isolation-"));
  const storesBySession = new Map<string, ContextStore & AuditStore>();
  const seenBySession = new Map<string, ContextStore>();

  try {
    await withMockedModuleDuring(
      import.meta.resolve("../session/optimized-context-store.js"),
      (real: typeof import("../session/optimized-context-store.js")) => ({
        ...real,
        createSessionStores: async (dir: string) => {
          const store = fakeStore();
          storesBySession.set(basename(dir), store);
          return { storage: store, audit: store };
        },
      }),
      async () => {
        await withMockedModuleDuring(
          import.meta.resolve("../agent/live-tool-dispatch.js"),
          (real: typeof import("../agent/live-tool-dispatch.js")) => ({
            ...real,
            createAgentWithLiveToolDispatch: async (
              _def: unknown,
              env: { storage: ContextStore; workdir: string },
            ) => {
              seenBySession.set(basename(env.workdir), env.storage);
              return stubAgent() as unknown as Awaited<
                ReturnType<typeof real.createAgentWithLiveToolDispatch>
              >;
            },
          }),
          async () => {
            const { runSubAgent } = await import("./run.js");
            await Promise.all([
              runSubAgent(runParams(cwd, "isolated-a")),
              runSubAgent(runParams(cwd, "isolated-b")),
            ]);
          },
        );
      },
    );

    const storeA = defined(storesBySession.get("isolated-a"), "worker A store");
    const storeB = defined(storesBySession.get("isolated-b"), "worker B store");
    expect(storeA).not.toBe(storeB);
    expect(seenBySession.get("isolated-a")).toBe(storeA);
    expect(seenBySession.get("isolated-b")).toBe(storeB);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
