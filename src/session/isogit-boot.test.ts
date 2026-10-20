import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { withMockedModuleDuring } from "../../testkit/mock-module.js";

const isogitNode = import.meta.resolve("@intx/storage-isogit/node");

test("importing the session store does not construct isogit storage", async () => {
  let loads = 0;
  await withMockedModuleDuring(
    isogitNode,
    () => {
      loads += 1;
      return {
        createIsogitStore: async () => {
          throw new Error("session open reached isogit");
        },
      };
    },
    async () => {
      const before = loads;
      await import("./optimized-context-store.js");
      expect(loads).toBe(before);
    },
  );
});

test("opening a session constructs isogit storage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "isogit-boot-"));
  try {
    await withMockedModuleDuring(
      isogitNode,
      () => ({
        createIsogitStore: async () => {
          throw new Error("session open reached isogit");
        },
      }),
      async () => {
        const { createSessionStores } = await import(
          "./optimized-context-store.js"
        );
        await expect(createSessionStores(dir)).rejects.toThrow(
          "session open reached isogit",
        );
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
