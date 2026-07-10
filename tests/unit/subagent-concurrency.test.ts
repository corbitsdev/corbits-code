import { afterEach, expect, test } from "bun:test";

import {
  setMaxConcurrentSubAgentsForTests,
  withSubAgentSlot,
} from "../../src/subagent/concurrency.js";
import { DEFAULT_MAX_CONCURRENT_SUB_AGENTS } from "../../src/config/settings.js";

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  setMaxConcurrentSubAgentsForTests(DEFAULT_MAX_CONCURRENT_SUB_AGENTS);
});

test("a full pool blocks a fresh acquire until a slot frees", async () => {
  setMaxConcurrentSubAgentsForTests(1);
  let releaseParent: () => void = () => {};
  const parent = withSubAgentSlot(
    () => new Promise<void>((resolve) => (releaseParent = resolve)),
  );
  await flush();

  let ran = false;
  const waiting = withSubAgentSlot(async () => {
    ran = true;
  });
  await flush();
  expect(ran).toBe(false);

  releaseParent();
  await parent;
  await waiting;
  expect(ran).toBe(true);
});

test("a reentrant run reuses the held slot instead of deadlocking", async () => {
  setMaxConcurrentSubAgentsForTests(1);
  let releaseParent: () => void = () => {};
  const parent = withSubAgentSlot(
    () => new Promise<void>((resolve) => (releaseParent = resolve)),
  );
  await flush();

  // The parent holds the only slot. A nested worker that acquired its own slot
  // would wait forever; a reentrant run completes under the parent's slot.
  const nested = await withSubAgentSlot(async () => "nested", { reentrant: true });
  expect(nested).toBe("nested");

  releaseParent();
  await parent;
});
