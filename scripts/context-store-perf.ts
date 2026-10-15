#!/usr/bin/env bun
/**
 * CL-10666 before/after measurement: session-store per-turn I/O.
 *
 * One machine, one scenario: a fresh session dir plus N simulated reactor
 * cycles (load, writePrompt, writeTurns, commit) through the optimized
 * context store. Every node fs.promises call the store stack makes is
 * counted (split by whether the path is under .git), along with wall time,
 * so the per-turn walks, re-parses, and re-stringified comparisons become an
 * honest delta between two builds on the same host.
 *
 * Usage:
 *   bun scripts/context-store-perf.ts [turnCount]
 *   bun scripts/context-store-perf.ts [turnCount] --json
 */

import fs from "node:fs";
import path from "node:path";
import type { ConversationTurn } from "@intx/types/runtime";
import { createOptimizedContextStore } from "../src/session/optimized-context-store.js";

const COUNTED_OPS = [
  "access",
  "copyFile",
  "lstat",
  "mkdir",
  "open",
  "opendir",
  "readFile",
  "readdir",
  "readlink",
  "rename",
  "rmdir",
  "stat",
  "truncate",
  "unlink",
  "writeFile",
] as const;

const counts: Record<string, number> = {};
const gitPaths: Record<string, number> = {};

function bump(table: Record<string, number>, op: string): void {
  table[op] = (table[op] ?? 0) + 1;
}

function installCounters(): void {
  const target = fs.promises as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  for (const op of COUNTED_OPS) {
    const original = target[op];
    if (typeof original !== "function") continue;
    target[op] = function counted(this: unknown, ...args: unknown[]) {
      const first = args[0];
      if (typeof first === "string" && first.includes(`/.git/`)) {
        bump(gitPaths, op);
      }
      bump(counts, op);
      return original.apply(this, args);
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

function turnBody(index: number): string {
  // ~1.5 KB of filler plus a marker line, close to a small unit of context.
  return (
    `turn ${index}: ` +
    "boundary-check padding. ".repeat(60) +
    `end-of-turn ${index}`
  );
}

async function runScenario(dir: string, turnCount: number): Promise<number> {
  const store = await createOptimizedContextStore(dir);
  const history: ConversationTurn[] = [];
  for (let index = 0; index < turnCount; index++) {
    history.push(turn(turnBody(index)));
    if (index % 4 === 1) history.push(assistantTurn(`reply to ${index}`));
    await store.load();
    await store.writePrompt(history);
    await store.writeTurns(history);
    await store.commit({ message: `checkpoint ${index}` });
  }
  const fresh = await createOptimizedContextStore(dir);
  return (await fresh.load()).turns.length;
}

function sortedEntries(table: Record<string, number>): [string, number][] {
  return Object.entries(table).sort((a, b) => b[1] - a[1]);
}

async function main(argv: string[]): Promise<number> {
  const arg = argv[2];
  const turnCount =
    arg !== undefined && !arg.startsWith("-") ? Number(arg) : 40;
  if (!Number.isFinite(turnCount) || turnCount < 1) {
    console.error(
      "usage: bun scripts/context-store-perf.ts [turnCount] [--json]",
    );
    return 1;
  }
  installCounters();

  const dir = await fs.promises.mkdtemp(
    path.join(process.cwd(), "context-store-perf-"),
  );
  const started = performance.now();
  const loadedTurns = await runScenario(dir, turnCount);
  const wallMs = Math.round(performance.now() - started);

  const totalOps = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const gitOps = Object.values(gitPaths).reduce((sum, n) => sum + n, 0);

  const asJson = argv.includes("--json");
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          turnCount,
          wallMs,
          loadedTurns,
          totalFsOps: totalOps,
          gitPathFsOps: gitOps,
          fsOps: counts,
          gitPathFsOpsByName: gitPaths,
          perTurn: {
            wallMs: +(wallMs / turnCount).toFixed(2),
            fsOps: +(totalOps / turnCount).toFixed(2),
          },
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `scenario: ${turnCount} turns, one store instance (fresh dir); verified ${loadedTurns} turns at the end`,
    );
    console.log(
      `wall: ${wallMs} ms (${(wallMs / turnCount).toFixed(2)} ms/turn)`,
    );
    console.log(
      `fs ops: ${totalOps} total (${(totalOps / turnCount).toFixed(2)}/turn), of which ${gitOps} under .git`,
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
