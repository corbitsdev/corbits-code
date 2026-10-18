import fs from "node:fs";
import { afterEach, expect, test } from "bun:test";
import type { ConversationTurn } from "@intx/types/runtime";
import { createOptimizedContextStore } from "../src/session/optimized-context-store.js";
import { createTempDir } from "../testkit/temporary-dirs.js";

/**
 * Pins the per-turn slope of fs.promises.access, counted the same way
 * scripts/context-store-perf.ts installCounters counts it (every call, and a
 * separate tally when the path is under .git). Synchronous fs is invisible
 * here, same as that script. Two turn counts keep a fixed overhead from hiding
 * a probe that runs once per turn.
 */
const LOW_TURNS = 4;
const HIGH_TURNS = 12;

const totals = { access: 0, gitAccess: 0 };
let restoreAccess: (() => void) | undefined;

function bump(
  table: { access: number; gitAccess: number },
  git: boolean,
): void {
  if (git) table.gitAccess += 1;
  table.access += 1;
}

function installCounters(): void {
  const target = fs.promises as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const original = target.access;
  if (typeof original !== "function") {
    throw new Error("fs.promises.access is not a function");
  }
  target.access = function counted(this: unknown, ...args: unknown[]) {
    const first = args[0];
    const git = typeof first === "string" && first.includes("/.git/");
    bump(totals, git);
    return original.apply(this, args);
  };
  restoreAccess = () => {
    target.access = original;
  };
}

function turn(text: string): ConversationTurn {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function assistantTurn(text: string): ConversationTurn {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 2,
  };
}

function turnBody(index: number): string {
  return (
    `turn ${index}: ` +
    "boundary-check padding. ".repeat(60) +
    `end-of-turn ${index}`
  );
}

async function runScenario(turnCount: number): Promise<void> {
  const temp = createTempDir("context-store-perf-slope-");
  try {
    const store = await createOptimizedContextStore(temp.dir);
    const history: ConversationTurn[] = [];
    for (let index = 0; index < turnCount; index++) {
      history.push(turn(turnBody(index)));
      if (index % 4 === 1) history.push(assistantTurn(`reply to ${index}`));
      await store.load();
      await store.writePrompt(history);
      await store.writeTurns(history);
      await store.commit({ message: `checkpoint ${index}` });
    }
    const fresh = await createOptimizedContextStore(temp.dir);
    await fresh.load();
  } finally {
    temp.cleanup();
  }
}

afterEach(() => {
  restoreAccess?.();
  restoreAccess = undefined;
  totals.access = 0;
  totals.gitAccess = 0;
});

test("fs.promises.access grows by a fixed per-turn slope", async () => {
  installCounters();
  await runScenario(LOW_TURNS);
  const low = { access: totals.access, gitAccess: totals.gitAccess };
  totals.access = 0;
  totals.gitAccess = 0;
  await runScenario(HIGH_TURNS);
  const high = { access: totals.access, gitAccess: totals.gitAccess };
  const span = HIGH_TURNS - LOW_TURNS;
  expect((high.access - low.access) / span).toBe(1);
  expect((high.gitAccess - low.gitAccess) / span).toBe(0);
});
