# PerfTrace attribution guide

How to capture a slow session, dump local spans, and run the offline attribution
report. No OTEL collector, no PostHog, no network.

See also: [`PERFTRACE.md`](./PERFTRACE.md) for the span model, dump schema, and
`jq` recipes.

## Why this exists

When a session feels slow, the first question is **where the wall time went**:

| Category | Meaning |
|---|---|
| `inference` | Model call wall (`inference` spans). Nested `inference.ttft` vs `inference.stream` show wait-for-first-token vs rest of stream. |
| `tools` | Tool invocations under the turn. |
| `permission.wait` | Ask-gate / approval idle time (when instrumented). |
| `subagent` | Child agent lifetimes (fanout cost). |
| `other` | Turn wall not covered by the above — scheduling, TUI, un-instrumented work, gaps between phases. |

Shares are **exclusive** over turn wall. For **completed** turns, wall is
`end − start`. For **open** (still-running) turns — including mid-stall dumps —
wall is estimated as `max(completed-descendant endNs) − turn.startNs` so shares
stay meaningful, and the report lists **open phase names** (e.g.
`inference.stream`, `turn`) so completed-only shares are not read as a full
stall diagnosis.

Nested exclusive children under an exclusive parent (e.g. `tool` /
`inference` under `subagent`) count only toward the parent exclusive bucket —
they are not double-counted. Nested TTFT/stream and `adapter.transport` are
diagnostic splits (they are not added on top of `inference` in the exclusive
table). TTFT/stream shares use **(ttft + stream)** as the denominator, not
inference wall.


## Capture a real slow session

1. Prefer a repro that exercises the pain: high reasoning, several tools, and
   (if relevant) subagents or permission prompts.
2. Run Corbits Code normally. PerfTrace is always-on in-process; there is no
   settings toggle.
3. When the session stalls or finishes slowly, dump the ring next to session
   artifacts.

```ts
import { snapshot } from "../src/perf/index.js";
import { dumpSpans } from "../src/perf/dump.js";

const path = await dumpSpans(snapshot(), {
  dir: ".agent-state/<sessionId>",
  sessionId: "<sessionId>",
});
// → .agent-state/<sessionId>/perftrace-<sessionId>.json
```

The dump is privacy-strict (allowlisted tags only). Safe to keep offline or
share with teammates without prompts/paths.

## Run the attribution report

From a local dump file alone:

```bash
bun scripts/perf-report.ts .agent-state/<sessionId>/perftrace-<sessionId>.json
```

Machine-readable JSON:

```bash
bun scripts/perf-report.ts --json .agent-state/<sessionId>/perftrace-<sessionId>.json
```

Golden multi-tool demo (no dump file needed — uses
`src/perf/fixtures/multi-tool-turn.ts`):

```bash
bun scripts/perf-report.ts --fixture
```

Example fixture output (fixture ns values are tiny — formatter prints sub-ms):

```
PerfTrace attribution report
───────────────────────────
Session wall: 0.005ms  turns=1 (completed=1)

Exclusive phase shares (of session wall):
  inference             40.0%  0.002ms  n=1
  tools                 24.0%  0.001ms  n=2
  permission.wait        8.0%  0.000ms
  subagent               0.0%  0ms
  other                 28.0%  0.001ms
...
```


## How to read the report

1. **Session exclusive shares** — which bucket ate the turn wall. A large
   `inference` share with high `ttft` points at model queueing / cold start. A
   large `tools` share with high `n=` points at tool work. A large
   `permission.wait` share is human/ask-gate idle, not model or tool code.
2. **Open / incomplete** — if the report says `Open (incomplete)` and lists
   still-running phases, exclusive shares only cover completed descendants.
   Treat open phase names as the hang candidates; do not conclude from the
   exclusive table alone.
3. **`other` large** — either real un-instrumented cost (TUI, scheduling) or
   gaps between instrumented phases. If `other` dominates a pain session, add
   spans before optimizing transport.
4. **TTFT vs stream** — of `ttft + stream` only (not inference wall). High TTFT
   share → time-to-first-token problem. High stream share → long generation or
   slow token delivery.
5. **Transport signal** — `adapter.transport / inference`. When transport is a
   large fraction of inference wall, prioritize transport work (WebSocket /
   incremental input). When it is small, transport is not the bottleneck.
6. **Per-turn rows** — find the outlier turn when the session average looks fine
   but one turn felt stuck. Open turns print `open phases:` explicitly.
7. **Subagent count + share** — fanout cost. High subagent share means child
   agents as a whole (nested tools/inference under the subagent are inside that
   bucket, not double-counted as parent tools/inference).

### What “large transport share” looks like

| transportShareOfInference | Reading |
|---|---|
| ≈ 0 or missing | Adapter did not emit `adapter.transport`, or transport was negligible. Do not prioritize WebSocket/incremental input on this evidence alone. |
| Low (e.g. &lt; 10–15%) | Most inference wall is model/server time, not client transport. Prefer model/TTFT or tool work. |
| High (e.g. &gt; 25–30% of inference, sustained across turns) | Client transport is a meaningful slice of inference wall — candidate for WebSocket / incremental input priority. |

Always pair with absolute ms: a 40% share of a 50ms inference is noise; 40% of a
8s inference is a product decision.

## Decision note template (transport prioritization)

Copy into a Linear issue or PR when a pain dump suggests transport investment.

```markdown
## Decision: WebSocket / incremental input priority?

**Session / dump:** <path to perftrace-*.json>
**Report command:** `bun scripts/perf-report.ts <path>`

### Evidence
- Session wall: <ms>
- Exclusive shares: inference <%> · tools <%> · permission.wait <%> · subagent <%> · other <%>
- TTFT share of (ttft+stream): <%>
- Stream share of (ttft+stream): <%>
- `adapter.transport` ns: <ms> · share of inference: <%>
- Turns examined: <n>; outlier turn id: <id>

### Reading
- [ ] Transport share is **high** and absolute transport ms is user-visible
      → prioritize WebSocket / incremental input (or adapter transport work).
- [ ] Transport share is **low / missing**; inference TTFT or tools dominate
      → do **not** prioritize transport; focus on <TTFT | tools | permission | other>.
- [ ] `other` or missing instrumentation dominates
      → instrument first; decide after a second dump.

### Decision
- Priority: <raise | hold | drop> transport work this cycle
- Owner: <name>
- Follow-up: <issue link or none>
```

## API (programmatic)

```ts
import {
  attributionFromSpans,
  attributionFromDump,
  formatAttributionReport,
} from "../src/perf/attribution-report.js";
import { snapshot } from "../src/perf/index.js";

const report = attributionFromSpans(snapshot());
console.log(formatAttributionReport(report));
// or: attributionFromDump(JSON.parse(await readFile(path, "utf8")))
```

Pure functions — safe in tests and evals. The multi-tool golden fixture locks
expected ns values in `src/perf/fixtures/multi-tool-turn.ts` and
`src/perf/attribution-report.test.ts`.

## Related

- `src/perf/rollup.ts` — phase / turn / session totals
- `src/perf/dump.ts` — `dumpSpans` / `buildDump`
- `src/perf/attribution-report.ts` — exclusive shares + formatter
- `scripts/perf-report.ts` — CLI entrypoint
