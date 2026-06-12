# Lifecycle Hooks

Interchange Code discovers lifecycle hooks from:

```text
.intercode/hooks/
~/.intercode/hooks/
```

Local hooks in `.intercode/hooks/` take precedence over global hooks in
`~/.intercode/hooks/` when both directories contain a hook with the same file
name.

Supported files:

- `*.ts` files run with Bun.
- `*.sh` files run with `sh`.

Hook failures are recorded in hook status and logged, but they do not stop the
agent run. `postTurn` hooks run in the background. `postRun` hooks finish before
the process exits so they can flush their output and record final status.

## TypeScript Hooks

TypeScript hook files can export either lifecycle function:

```ts
export async function postTurn(ctx: unknown): Promise<void> {
  // Runs after one complete assistant turn and its tool results.
}

export async function postRun(summary: unknown): Promise<void> {
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
  status: "done" | "failed" | "cancelled";
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
