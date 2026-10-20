import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, mock, test } from "bun:test";

let nodeEvaluated = false;

mock.module("@intx/storage-isogit/node", () => {
  nodeEvaluated = true;
  return {
    createIsogitStore: async () => {
      throw new Error("session open reached isogit");
    },
  };
});

test("importing the session store does not construct isogit storage", async () => {
  await import("./optimized-context-store.js");
  expect(nodeEvaluated).toBe(false);
});

test("opening a session constructs isogit storage", async () => {
  const { createSessionStores } = await import("./optimized-context-store.js");
  const dir = await mkdtemp(join(tmpdir(), "isogit-boot-"));
  try {
    await expect(createSessionStores(dir)).rejects.toThrow(
      "session open reached isogit",
    );
    expect(nodeEvaluated).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
