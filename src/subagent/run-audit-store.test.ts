import { expect, test } from "bun:test";
import type { AuditStore, ContextStore } from "@intx/types/runtime";

import { withMockedModuleDuring } from "../testkit/mock-module.js";
import { defined } from "../testkit/defined.js";
import {
  baseRunParams,
  stubAgent,
  tmpSubAgentCwd,
  withStubbedAgent,
} from "./run-test-harness.js";

test("runSubAgent threads the isogit audit store and session id into createAgent", async () => {
  const cwd = await tmpSubAgentCwd("corbits-run-audit-");
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
      await withStubbedAgent(
        (_def: unknown, env: unknown) => {
          seen = env as typeof seen;
          return stubAgent({
            send: async () => ({
              type: "reply" as const,
              reply: "ok",
              turn: { role: "assistant" as const, content: [] },
            }),
          });
        },
        async () => {
          const { runSubAgent } = await import("./run.js");
          await runSubAgent(
            baseRunParams(cwd, {
              description: "audit wiring",
              prompt: "noop",
              id: "child-session-1",
            }),
          );
        },
      );
    },
  );

  const seenStores = defined(seen);
  expect(seenStores.storage).toBe(fakeStore);
  expect(seenStores.audit).toBe(fakeStore);
  expect(seenStores.sessionId).toBe("child-session-1");
});
