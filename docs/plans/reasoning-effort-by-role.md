# Reasoning effort defaults by agent role (CL-5162)

## Why

`gpt-5.6-sol` (and similar) at **high** reasoning effort is a **latency cliff**: thinking tokens expand wall time before useful tool calls. Multi-agent fanout multiplies that cost when every leaf inherits the primary session's high setting.

## Product defaults

| Role | Default effort | Notes |
|---|---|---|
| Orchestrator (`profile.orchestrator: true`) | `high` | Planning / fan-out warrants deeper reasoning |
| Task leaf (generic or non-orchestrator profile) | `medium` | Keeps fleet latency off the sol+high cliff |

Clamped via `supportedEfforts(model)` when the model does not accept the preferred rung.

## Precedence

1. **Explicit pin** — profile `inference` leg `reasoningEffort`, or any future task-level pin  
2. **Role default** — table above, when the model supports it  
3. **Parent inheritance** — parent session effort, only when the role default is not in the model's supported set  
4. **Clamp** — nearest supported rung to the role default  
5. **Omit** — non-reasoning models get no effort on the wire  

Implementation: `resolveEffortForRole` / `pickEffortFromCascade` in `src/provider/reasoning-effort.ts`, applied in `src/subagent/task-tool.ts` after profile/tier provider resolution.

## Operator UI

**Deferred.** No settings or TUI control in this change. Operators who need a different leaf effort pin it on the agent profile's inference leg.

## Latency eval

PerfTrace-backed medium vs high quality/latency comparison is deferred to the CL-5174 wave (`docs/plans/core-performance-tracing.md` / package C eval). Do not block this default on that instrumentation.
