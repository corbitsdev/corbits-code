# Lifecycle Hooks

Interchange Code discovers lifecycle hooks from:

```text
~/.interchange-code/hooks/
```

Supported files:

- `*.ts` files run with Bun.
- `*.sh` files run with `sh`.

Hooks are fire-and-forget. Failures are recorded in hook status and logged, but
they do not stop the agent run.

## TypeScript Hooks

TypeScript hook files can export either lifecycle function:

```ts
import type { RunSummary, TurnContext } from "../src/hooks.js";

export async function postTurn(ctx: TurnContext): Promise<void> {
  // Runs after one complete assistant turn and its tool results.
}

export async function postRun(summary: RunSummary): Promise<void> {
  // Runs after the session finishes.
}
```

If a function is not exported, that lifecycle moment is skipped for that file.

## Shell Hooks

Shell hooks receive the lifecycle name as `$1` and the JSON payload on stdin:

```sh
#!/bin/sh
kind="$1"
payload="$(cat)"

case "$kind" in
  postTurn) printf '%s\n' "$payload" >> /tmp/interchange-turns.jsonl ;;
  postRun) printf '%s\n' "$payload" >> /tmp/interchange-runs.jsonl ;;
esac
```

## Payloads

`TurnContext` contains:

```ts
type TurnContext = {
  turnIndex: number;
  assistantTurn: ConversationTurn;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  usage: TokenUsage;
  source: LastCycleSource;
  durationMs: number;
};
```

`RunSummary` contains:

```ts
type RunSummary = {
  task: string;
  status: "done" | "failed";
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  turnsUsed: number;
  tokenUsage: TokenUsage;
  turns: TurnContext[];
  toolCallCount: number;
  error?: string;
};
```
