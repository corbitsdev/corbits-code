# Lifecycle Hooks

Corbits Code discovers lifecycle hooks from:

```text
.corbits/hooks/
~/.corbits/hooks/
```

Local hooks in `.corbits/hooks/` take precedence over global hooks in
`~/.corbits/hooks/` when both directories contain a hook with the same file
name.

Supported files (dotfiles skipped; anything else ignored; sorted by path):

- `*.ts` files run with Bun.
- `*.sh` files run with `sh`.

Hook outcomes are recorded in hook status (`lastExitStatus`) but they do not stop the
agent run. `postTurn` hooks run in the background. `postRun` hooks are awaited before
the process exits so they can finish their side effects and record final status.

A hook may exit without reading its payload — for example, a shell hook whose
`case "$1"` handles only one lifecycle kind. The payload write then fails with
`EPIPE`; that is treated as a hook outcome, not a crash, and the hook's status
notes `hook exited without reading its payload`.

Hooks start enabled and can be toggled in the TUI hook panel. Each hook's
status tracks `enabled`, `lastFiredAt`, `lastKind`, and `lastExitStatus`.

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

Tool results inside hook payloads are truncated to the last 4,000 characters,
with a `[N chars omitted]` marker, so large tool outputs stay bounded.

Hook stdout is ignored; hook stderr is captured into the hook's
`lastExitStatus`. The JSON payload is the hook's only structured input.

The nested types (`ConversationTurn`, `ToolCall`, `ToolResult`, `TokenUsage`,
`LastCycleSource`) are defined with the runtime types; see `src/session/hooks.ts`.
