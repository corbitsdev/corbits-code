import { test, expect } from "bun:test";

import { runRg, type RgChild, type SpawnRg } from "./rg-run.js";

const line = "big.txt:1:match line here\n";

type Script = {
  stdout: string[];
  code: number | null;
  /** When true, fire close before any stdout data (Linux-style race). */
  closeFirst?: boolean;
};

// A child whose event order is dictated by the test rather than by how the
// platform happens to schedule pipe reads.
function scriptedSpawn(script: Script): SpawnRg {
  return () => {
    let onData: ((chunk: unknown) => void) | undefined;
    let onClose: ((code: number | null) => void) | undefined;
    const child: RgChild = {
      pid: undefined,
      stdout: {
        on: (_event, listener) => {
          onData = listener;
        },
      },
      stderr: { on: () => undefined },
      on: ((event: string, listener: (arg: never) => void) => {
        if (event === "close") onClose = listener as (code: number | null) => void;
      }) as RgChild["on"],
      kill: () => undefined,
    };
    queueMicrotask(() => {
      if (script.closeFirst) {
        onClose?.(script.code);
        script.stdout.forEach((chunk) => onData?.(chunk));
      } else {
        script.stdout.forEach((chunk) => onData?.(chunk));
        onClose?.(script.code);
      }
    });
    return child;
  };
}

function run(script: Script, maxOutputBytes = 200): ReturnType<typeof runRg> {
  return runRg([], ".", new AbortController().signal, { maxOutputBytes }, scriptedSpawn(script));
}

test("an over-cap run is capped regardless of how stdout is chunked", async () => {
  const bulk = line.repeat(400);
  const oneChunk = await run({ stdout: [bulk], code: 0 });
  const manyChunks = await run({ stdout: bulk.match(/.{1,7}/gs) ?? [], code: 0 });
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
  expect(await run({ stdout: [], code: 1 })).toMatchObject({ kind: "no-match" });
});

test("the timeout settles a slow run", async () => {
  const stalled: SpawnRg = () => ({
    pid: undefined,
    stdout: { on: () => undefined },
    stderr: { on: () => undefined },
    on: (() => undefined) as RgChild["on"],
    kill: () => undefined,
  });
  const result = await runRg([], ".", new AbortController().signal, { timeoutMs: 1 }, stalled);
  expect(result).toMatchObject({ kind: "partial", notice: expect.stringContaining("timed out") });
});
