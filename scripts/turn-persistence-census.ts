#!/usr/bin/env bun
/**
 * CL-10667 before/after measurement: per-turn session persistence write ops.
 *
 * Mirrors the reactor's persist sequence for one agentic turn: one inference
 * cycle (writePrompt + writeResponse) and two tool batches followed by the
 * cycle terminal. Every write-kind fs.promises call of the store stack is
 * counted (split by whether the path is under .git), so the coalescing becomes
 * an honest before/after delta on the same host and scenario.
 *
 * The flow itself changed shape with CL-10667, so the same script models both:
 * --flow=legacy replicates the pre-coalescing reactor (tool-batch commitCycle
 * per batch); --flow=coalesced replicates the post-coalescing one (writeTurns
 * per tool batch, full commitCycle only at the cycle terminal).
 *
 * Usage:
 *   bun scripts/turn-persistence-census.ts [turnCount] [--flow=legacy|coalesced] [--json]
 */

import fs from "node:fs";
import path from "node:path";
import type { ConversationTurn, TokenUsage } from "@intx/types/runtime";
import { TransformRecord } from "@intx/types/runtime";
import { createOptimizedContextStore } from "../src/session/optimized-context-store.js";

const WRITE_OPS = [
  "writeFile",
  "appendFile",
  "rename",
  "unlink",
  "truncate",
  "mkdir",
  "copyFile",
] as const;

const counts: Record<string, number> = {};
const gitPaths: Record<string, number> = {};

function bump(table: Record<string, number>, op: string): void {
  table[op] = (table[op] ?? 0) + 1;
}

function installCounters(): void {
  const target = fs.promises as unknown as Record<string, unknown>;
  for (const op of WRITE_OPS) {
    const original = target[op];
    if (typeof original !== "function") continue;
    target[op] = function counted(this: unknown, ...args: unknown[]) {
      const first = args[0];
      if (typeof first === "string" && first.includes(`/.git/`)) {
        bump(gitPaths, op);
      }
      bump(counts, op);
      return (original as (...args: unknown[]) => unknown).apply(this, args);
    };
  }
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

function toolResultTurn(name: string): ConversationTurn {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        callId: `call-${name}`,
        content: [{ type: "text", text: `${name} result` }],
      },
    ],
    timestamp: 3,
  };
}

function turnBody(index: number): string {
  return (
    `turn ${index}: ` + "census padding. ".repeat(40) + `end-of-turn ${index}`
  );
}

const EMPTY_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
};

function usageForTurn(turnCount: number): TokenUsage {
  return {
    ...EMPTY_USAGE,
    input: 1000 * turnCount,
    output: 500 * turnCount,
  };
}

async function runScenario(
  dir: string,
  turnCount: number,
  flow: string,
): Promise<{ turns: number; persistCalls: Record<string, number> }> {
  const base = await createOptimizedContextStore(dir);
  const PERSIST_METHODS = [
    "writePrompt",
    "writeResponse",
    "writeTurns",
    "writeManifest",
    "writeMetadata",
    "commit",
  ] as const;
  const persistCalls: Record<string, number> = {};
  const store = Object.assign(Object.create(base), base) as typeof base;
  for (const method of PERSIST_METHODS) {
    const original = base[method] as (
      ...callArgs: unknown[]
    ) => Promise<unknown>;
    (store as never as Record<string, unknown>)[method] = (
      ...callArgs: unknown[]
    ) => {
      bump(persistCalls, method);
      return original.apply(base, callArgs);
    };
  }
  const history: ConversationTurn[] = [];
  const record: () => TransformRecord = () => ({
    strategy: "test.transform",
    version: "1",
    parameters: {},
    reason: "census",
    decisions: {},
  });
  for (let t = 0; t < turnCount; t++) {
    // Inference cycle: prompt + assistant turn.
    history.push(turn(turnBody(t)));
    history.push(assistantTurn(`reply to ${t}`));
    await store.writePrompt(history);

    if (flow === "legacy") {
      const last = history[history.length - 1];
      if (last !== undefined && last.role === "assistant") {
        await store.writeResponse({
          ...last,
          role: "assistant",
          model: last.model ?? "census-model",
        });
      }
    }

    for (let batch = 0; batch < 2; batch++) {
      history.push(toolResultTurn(`tool-${t}-${batch}`));
      if (flow === "legacy") {
        // Old tool-batch path: a full commitCycle per batch.
        await store.writeTurns(history);
        await store.writeManifest([record()]);
        await store.writeMetadata({
          pendingOperations: [],
          tokenUsage: usageForTurn(t + 1),
        });
        await store.commit({ message: "checkpoint: tool-execution" });
      } else {
        // Coalesced tool-batch path: segments on disk only.
        await store.writeTurns(history);
      }
    }

    // Cycle terminal (reply/wait/done): the remaining cycle persists.
    if (flow !== "legacy") {
      await store.writeTurns(history);
      // Two transforms happened; the terminal commit carries them.
      await store.writeManifest([record(), record()]);
      await store.writeMetadata({
        pendingOperations: [],
        tokenUsage: usageForTurn(t),
      });
      await store.commit({ message: "Cycle: done" });
    }
  }
  const fresh = await createOptimizedContextStore(dir);
  const turns = (await fresh.load()).turns.length;
  return { turns, persistCalls };
}

function sortedEntries(table: Record<string, number>): [string, number][] {
  return Object.entries(table).sort((a, b) => b[1] - a[1]);
}

async function main(argv: string[]): Promise<number> {
  const arg = argv[2];
  const flow = argv.find((a) => a.startsWith("--flow="))?.split("=")[1];
  if (flow !== "legacy" && flow !== "coalesced") {
    console.error(
      "usage: bun scripts/turn-persistence-census.ts [turnCount] --flow=legacy|coalesced [--json]",
    );
    return 1;
  }
  const turnCount =
    arg !== undefined && !arg.startsWith("-") ? Number(arg) : 40;
  if (!Number.isFinite(turnCount) || turnCount < 1) {
    console.error(`invalid turnCount: ${arg}`);
    return 1;
  }
  installCounters();

  const prefix = `census-${flow}-`;
  const dir = await fs.promises.mkdtemp(path.join(process.cwd(), prefix));
  const started = performance.now();
  const { turns: loadedTurns, persistCalls } = await runScenario(
    dir,
    turnCount,
    flow,
  );
  const wallMs = Math.round(performance.now() - started);

  const totalOps = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const gitOps = Object.values(gitPaths).reduce((sum, n) => sum + n, 0);

  const asJson = argv.includes("--json");
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          flow,
          turnCount,
          wallMs,
          loadedTurns,
          totalWriteOps: totalOps,
          gitPathWriteOps: gitOps,
          byName: counts,
          gitByPath: gitPaths,
          perTurn: {
            wallMs: +(wallMs / turnCount).toFixed(2),
            writeOps: +(totalOps / turnCount).toFixed(2),
          },
          persistCalls,
          persistCallsPerTurn: Object.fromEntries(
            Object.entries(persistCalls).map(([k, v]) => [
              k,
              +(v / turnCount).toFixed(3),
            ]),
          ),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `flow=${flow} ${turnCount} turns; verified ${loadedTurns} turns at the end`,
    );
    console.log(
      `wall: ${wallMs} ms (${(wallMs / turnCount).toFixed(2)} ms/turn)`,
    );
    console.log(
      `write ops: ${totalOps} total (${(totalOps / turnCount).toFixed(2)}/turn), of which ${gitOps} under .git`,
    );
    for (const [op, n] of sortedEntries(counts)) {
      console.log(`  ${op}: ${n}`);
    }
    for (const [op, n] of sortedEntries(gitPaths)) {
      console.log(`  (.git) ${op}: ${n}`);
    }
  }
  await fs.promises.rm(dir, { recursive: true, force: true });
  return 0;
}

process.exit(await main(process.argv));
