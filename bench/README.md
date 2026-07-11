# Performance & memory benchmarks

Deterministic, model-free workloads for catching performance and memory
regressions in long Intercode sessions (CL-3258). Nothing here calls a live
model: the inference workloads drive the real `@intx/inference` loop through the
`@intx/inference-testing` harness (stubbed fetch, virtual clock), and the
transcript workloads drive the TUI retention state directly.

## Run

```bash
bun run bench            # table + budget check (exits non-zero on a hard breach)
bun run bench -- --json  # machine-readable metrics
bun run test:bench       # the same workloads asserted as a bun:test suite (CI gate)
```

Run under Bun (or `node --expose-gc`) so heap-after-collection readings are
taken after a forced GC. Without a GC hook the runner prints a note and the heap
figures are live samples.

## Workloads

| Workload | Family | Stresses |
|---|---|---|
| `small-token-deltas` | inference | per-token buffering / event throughput (CL-3259, 3260) |
| `long-reasoning-output` | inference | reasoning-delta buffering |
| `large-tool-results` | transcript | tool-result byte caps (CL-3262) |
| `resumed-session` | transcript | retained-block cap on hydration (CL-3262) |
| `tool-heavy-transcript` | transcript | retention under many tool cycles (CL-3261) |
| `tool-heavy-streaming-layout` | transcript | per-token `buildLinesIncremental` layout cost staying flat as the transcript grows (CL-3264) |

## Metrics

Per workload: `elapsed`, `rss`, `heapDelta`, `events`, and `retained`. Release
budgets live in `budgets.ts`.

- `events` — hard gate for every workload. For the inference family it counts the
  events the loop actually yielded; for the transcript family it counts the blocks
  the state actually built from its events (retained tail plus trimmed count), so a
  dropped-event regression falls below the floor.
- `retained` — serialized bytes of the retained artifact. Hard gate for the
  transcript family, where it measures the serialized capped transcript and a
  broken cap trips it. For the inference family it is delivered-output size only
  (report-only, no budget): the loop retains nothing, so it is not a retention
  gate there.
- `heapDelta` — hard gate for every workload. Growth in the real JSC/V8 heap,
  measured after a forced GC while the workload's retained artifact is still
  referenced, minus a pre-run baseline. Under Bun the figure comes from
  `bun:jsc` heap stats (Bun's `heapUsed` is a coarse plateau); under
  `node --expose-gc` it comes from V8 `heapUsed`. A per-workload retention leak
  shows up here.
- `rss` — coarse process RSS sampled once after the run. Process-global, shared
  by every workload, so it is report-only, never gated.
- `elapsed` — reported; environment-dependent, so it is a soft warning only.

## Recording before/after for a change

Capture a baseline before your change and compare after:

```bash
git stash && bun run bench -- --json > /tmp/before.json
git stash pop && bun run bench -- --json > /tmp/after.json
```

Paste the `retained`/`heapDelta`/`elapsed` deltas onto the issue.

## Capturing comparable CPU and heap profiles

CPU profile of a single workload run:

```bash
bun --cpu-prof bench/run.ts        # writes a .cpuprofile, open in Chrome DevTools
```

Heap snapshot (Node with the inspector):

```bash
node --expose-gc --inspect-brk bench/run.ts
# then take an allocation/heap snapshot from chrome://inspect
```

Compare snapshots from a clean baseline and your branch at the same workload to
attribute retained growth to a specific change.
