import { test, expect } from "bun:test";

import { runRg } from "./rg-run.js";
import {
  scriptedRgSpawn,
  stalledRgSpawn,
  type RgScript,
} from "./test-helpers.js";

const line = "big.txt:1:match line here\n";

function run(script: RgScript, maxOutputBytes = 200): ReturnType<typeof runRg> {
  return runRg(
    [],
    ".",
    new AbortController().signal,
    { maxOutputBytes },
    scriptedRgSpawn(script),
  );
}

test("an over-cap run is capped regardless of how stdout is chunked", async () => {
  const bulk = line.repeat(400);
  const oneChunk = await run({ stdout: [bulk], code: 0 });
  const manyChunks = await run({
    stdout: bulk.match(/.{1,7}/gs) ?? [],
    code: 0,
  });
  for (const result of [oneChunk, manyChunks]) {
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") continue;
    expect(result.stdout.length).toBeLessThanOrEqual(200);
    // No notice of its own: the final tool result gets exactly one
    // truncation notice, from result-truncation-plugin.ts.
    expect(result.notice).toBeUndefined();
  }
});

// The Linux CI failure: process close can be delivered before the last stdout
// chunk is dispatched to the data handler. Ordering is now explicit — close is
// deferred one immediate turn so queued data runs first, and the collector
// re-checks the cap at process end. Either way partial wins over complete
// output when the body is over the limit.
test("an over-cap run is capped when close is ordered before stdout data", async () => {
  const bulk = line.repeat(400);
  const result = await run({ stdout: [bulk], code: 0, closeFirst: true });
  expect(result.kind).toBe("partial");
  if (result.kind !== "partial") return;
  expect(result.stdout.length).toBeLessThanOrEqual(200);
  expect(result.stdout).toContain("match line here");
  expect(result.notice).toBeUndefined();
});

test("a run under the cap settles as complete output", async () => {
  const result = await run({ stdout: [line, line], code: 0 });
  expect(result).toMatchObject({ kind: "output", stdout: line.repeat(2) });
});

test("exit code 1 is no-match", async () => {
  expect(await run({ stdout: [], code: 1 })).toMatchObject({
    kind: "no-match",
  });
});

test("the timeout settles a slow run", async () => {
  const result = await runRg(
    [],
    ".",
    new AbortController().signal,
    { timeoutMs: 1 },
    stalledRgSpawn,
  );
  expect(result).toMatchObject({
    kind: "partial",
    notice: expect.stringContaining("timed out"),
  });
});
