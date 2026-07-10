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

## Metrics

`elapsed`, `peakRSS`, `heapAfterGC`, `events`, and `retained` (retained
transcript bytes) per workload. Release budgets live in `budgets.ts`; the
retained-byte, heap, and minimum-event gates are hard (they sit far below the
uncapped size, so a broken cap or a leak trips them), while elapsed is a soft
warning.

## Recording before/after for a change

Capture a baseline before your change and compare after:

```bash
git stash && bun run bench -- --json > /tmp/before.json
git stash pop && bun run bench -- --json > /tmp/after.json
```

Paste the `retained`/`heapAfterGC`/`elapsed` deltas onto the issue.

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
