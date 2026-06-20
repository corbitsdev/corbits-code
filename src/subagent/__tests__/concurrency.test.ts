import { afterEach, expect, test } from "bun:test";

import {
  setMaxConcurrentSubAgentsForTests,
  SUB_AGENTS_DISABLED_MESSAGE,
  withSubAgentSlot,
} from "../concurrency.js";

afterEach(() => {
  setMaxConcurrentSubAgentsForTests(2);
});

test("withSubAgentSlot limits concurrent executions", async () => {
  setMaxConcurrentSubAgentsForTests(2);
  let active = 0;
  let maxActive = 0;

  const job = async (ms: number) =>
    withSubAgentSlot(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, ms));
      active--;
    });

  await Promise.all([job(30), job(30), job(30), job(30)]);

  expect(maxActive).toBe(2);
  expect(active).toBe(0);
});

test("withSubAgentSlot rejects immediately when limit is 0", async () => {
  setMaxConcurrentSubAgentsForTests(0);
  await expect(withSubAgentSlot(async () => "nope")).rejects.toThrow(SUB_AGENTS_DISABLED_MESSAGE);
});