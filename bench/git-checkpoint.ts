// CL-3436 spike: measure `commit()` latency on the optimized git-backed context
// store as the number of tracked tool-output blobs in the working tree grows.
//
// Each commit's tree gets one new tool-output blob entry (turns/prompt/metadata
// stay small via the segmented-JSONL rolling files), so the tree write is the
// part of `commit()` that scales with session length — this isolates that cost.
// Latency is averaged over a short window ending at each sample point to smooth
// out filesystem/GC jitter from a single commit.
//
// Run: `bun run bench/git-checkpoint.ts [--json]`

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationTurn } from "@intx/types/runtime";

import { createOptimizedContextStore } from "../src/session/optimized-context-store.js";

const SAMPLE_POINTS = [10, 500, 2000] as const;
const TOTAL_ENTRIES = Math.max(...SAMPLE_POINTS);
const AVERAGING_WINDOW = 5;
const TOOL_OUTPUT_BYTES = 500;

function turn(i: number): ConversationTurn {
  return {
    role: i % 2 === 0 ? "assistant" : "user",
    content: [{ type: "text", text: `turn ${String(i)}` }],
    timestamp: Date.now(),
  };
}

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-checkpoint-bench-"));

  try {
    const store = await createOptimizedContextStore(dir);
    const turns: ConversationTurn[] = [];
    const windowByPoint = new Map<number, number[]>(SAMPLE_POINTS.map((p) => [p, []]));

    for (let i = 1; i <= TOTAL_ENTRIES; i++) {
      turns.push(turn(i));
      await store.writeTurns([...turns]);
      await store.writeBlob(
        `call-${String(i)}`,
        new TextEncoder().encode(`tool output ${String(i)} ${"x".repeat(TOOL_OUTPUT_BYTES)}`),
        "text/plain",
      );
      await store.writeMetadata({
        pendingOperations: [],
        tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      });

      const start = performance.now();
      await store.commit({ message: `turn ${String(i)}` });
      const elapsedMs = performance.now() - start;

      for (const point of SAMPLE_POINTS) {
        if (i > point - AVERAGING_WINDOW && i <= point) windowByPoint.get(point)!.push(elapsedMs);
      }
    }

    const results = SAMPLE_POINTS.map((point) => {
      const samples = windowByPoint.get(point)!;
      const avgMs = samples.reduce((sum, v) => sum + v, 0) / samples.length;
      return { trackedEntries: point, avgCommitMs: avgMs };
    });

    if (asJson) {
      process.stdout.write(JSON.stringify(results, null, 2) + "\n");
    } else {
      process.stdout.write(`commit() latency by tracked tool-output entry count (avg of last ${String(AVERAGING_WINDOW)} commits):\n`);
      for (const { trackedEntries, avgCommitMs } of results) {
        process.stdout.write(`  ${String(trackedEntries).padStart(5)} entries: ${avgCommitMs.toFixed(2)}ms\n`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await main();
