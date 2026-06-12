import { mkdir, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ReactorEmittedEvent } from "@intx/inference";
import type {
  ConversationTurn,
  LastCycleSource,
  TokenUsage,
  ToolCall,
  ToolResult,
} from "@intx/types/runtime";

export type HookKind = "postTurn" | "postRun";

export type LifecycleHookType = "typescript" | "shell";

export type HookExitStatus = {
  code: number | null;
  signal: string | null;
  stderr: string;
};

export type LifecycleHook = {
  id: string;
  name: string;
  type: LifecycleHookType;
  path: string;
};

export type LifecycleHookStatus = LifecycleHook & {
  enabled: boolean;
  lastFiredAt?: number;
  lastKind?: HookKind;
  lastExitStatus?: HookExitStatus;
};

export type TurnContext = {
  turnIndex: number;
  assistantTurn: ConversationTurn;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  usage: TokenUsage;
  source: LastCycleSource;
  durationMs: number;
};

export type RunSummary = {
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

export type LifecycleHookEvent =
  | { type: "hooks.loaded"; hooks: LifecycleHookStatus[] }
  | { type: "hook.updated"; hook: LifecycleHookStatus };

export type LifecycleHookManager = {
  getStatuses(): LifecycleHookStatus[];
  setEnabled(id: string, enabled: boolean): void;
  dispatchPostTurn(ctx: TurnContext): void;
  dispatchPostRun(summary: RunSummary): Promise<void>;
};

type PendingTurn = {
  startedAt: number;
  turnIndex: number;
  assistantTurn: ConversationTurn;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  usage: TokenUsage;
  source: LastCycleSource;
};

const emptyUsage: TokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
};

export function hooksDirectory(): string {
  return globalHooksDirectory();
}

export function localHooksDirectory(cwd: string = process.cwd()): string {
  return join(cwd, ".intercode", "hooks");
}

export function globalHooksDirectory(): string {
  return join(homedir(), ".intercode", "hooks");
}

export function hookDirectories(cwd: string = process.cwd()): string[] {
  return [localHooksDirectory(cwd), globalHooksDirectory()];
}

export async function discoverLifecycleHooks(
  directories: string | string[] = hookDirectories(),
): Promise<LifecycleHook[]> {
  const resolvedDirectories = Array.isArray(directories) ? directories : [directories];
  const hooksByName = new Map<string, LifecycleHook>();

  for (const directory of resolvedDirectories) {
    for (const hook of await discoverHooksInDirectory(directory)) {
      if (!hooksByName.has(hook.name)) {
        hooksByName.set(hook.name, hook);
      }
    }
  }

  return [...hooksByName.values()];
}

async function discoverHooksInDirectory(directory: string): Promise<LifecycleHook[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }

  return entries
    .filter((entry) => !entry.startsWith("."))
    .map((entry): LifecycleHook | null => {
      const path = join(directory, entry);
      const extension = extname(entry);
      if (extension === ".ts") {
        return {
          id: path,
          name: entry,
          type: "typescript",
          path,
        };
      }
      if (extension === ".sh") {
        return {
          id: path,
          name: entry,
          type: "shell",
          path,
        };
      }
      return null;
    })
    .filter((hook): hook is LifecycleHook => hook !== null)
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function createTurnContextCollector(
  onTurn: (ctx: TurnContext) => void,
  now: () => number = Date.now,
): {
  observe(event: ReactorEmittedEvent): void;
  getTurns(): TurnContext[];
  getTokenUsage(): TokenUsage;
  getToolCallCount(): number;
} {
  const turns: TurnContext[] = [];
  let pending: PendingTurn | null = null;
  let cycleStartedAt = now();
  let tokenUsage: TokenUsage = { ...emptyUsage };
  let toolCallCount = 0;

  function completePending(): void {
    if (pending === null) return;
    if (pending.toolResults.length < pending.toolCalls.length) return;
    const ctx: TurnContext = {
      turnIndex: pending.turnIndex,
      assistantTurn: pending.assistantTurn,
      toolCalls: pending.toolCalls,
      toolResults: pending.toolResults,
      usage: pending.usage,
      source: pending.source,
      durationMs: Math.max(0, now() - pending.startedAt),
    };
    turns.push(ctx);
    pending = null;
    cycleStartedAt = now();
    onTurn(ctx);
  }

  return {
    observe(event: ReactorEmittedEvent): void {
      if (event.type === "inference.start" && pending === null) {
        cycleStartedAt = now();
        return;
      }

      if (event.type === "inference.done") {
        const toolCalls = event.data.turn.content
          .filter((block): block is Extract<typeof block, { type: "tool_call" }> => block.type === "tool_call")
          .map((block): ToolCall => ({
            id: block.id,
            name: block.name,
            arguments: block.arguments,
          }));
        toolCallCount += toolCalls.length;
        tokenUsage = addUsage(tokenUsage, event.data.usage);
        pending = {
          startedAt: cycleStartedAt,
          turnIndex: turns.length,
          assistantTurn: event.data.turn,
          toolCalls,
          toolResults: [],
          usage: event.data.usage,
          source: event.data.source,
        };
        completePending();
        return;
      }

      if (event.type === "tool.done" && pending !== null) {
        pending.toolResults.push(event.data.result);
        completePending();
      }
    },
    getTurns(): TurnContext[] {
      return [...turns];
    },
    getTokenUsage(): TokenUsage {
      return { ...tokenUsage };
    },
    getToolCallCount(): number {
      return toolCallCount;
    },
  };
}

export function createRunSummary(args: {
  task: string;
  status: "done" | "failed" | "cancelled";
  startedAt: number;
  finishedAt: number;
  turnsUsed: number;
  tokenUsage: TokenUsage;
  turns: TurnContext[];
  toolCallCount: number;
  error?: string;
}): RunSummary {
  return {
    task: args.task,
    status: args.status,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    durationMs: Math.max(0, args.finishedAt - args.startedAt),
    turnsUsed: args.turnsUsed,
    tokenUsage: args.tokenUsage,
    turns: args.turns,
    toolCallCount: args.toolCallCount,
    ...(args.error !== undefined ? { error: args.error } : {}),
  };
}

export function createLifecycleHookManager(args: {
  hooks: LifecycleHook[];
  onEvent?: (event: LifecycleHookEvent) => void;
  logError?: (message: string) => void;
}): LifecycleHookManager {
  const onEvent = args.onEvent ?? (() => {});
  const logError = args.logError ?? (() => {});
  const statuses = new Map<string, LifecycleHookStatus>();
  for (const hook of args.hooks) {
    statuses.set(hook.id, { ...hook, enabled: true });
  }

  function snapshot(): LifecycleHookStatus[] {
    return [...statuses.values()].map((status) => ({ ...status }));
  }

  function updateStatus(id: string, update: Partial<LifecycleHookStatus>): void {
    const current = statuses.get(id);
    if (current === undefined) return;
    const next = { ...current, ...update };
    statuses.set(id, next);
    onEvent({ type: "hook.updated", hook: { ...next } });
  }

  function runHook(status: LifecycleHookStatus, kind: HookKind, payload: TurnContext | RunSummary): Promise<void> {
    updateStatus(status.id, { lastFiredAt: Date.now(), lastKind: kind });
    return runLifecycleHook(status, kind, payload).then(
      (exitStatus) => updateStatus(status.id, { lastExitStatus: exitStatus }),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logError(`Hook ${status.name} failed: ${message}`);
        updateStatus(status.id, {
          lastExitStatus: { code: null, signal: null, stderr: message },
        });
      },
    );
  }

  function dispatch(kind: HookKind, payload: TurnContext | RunSummary): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const status of statuses.values()) {
      if (!status.enabled) continue;
      pending.push(runHook(status, kind, payload));
    }
    return Promise.all(pending).then(() => {});
  }

  onEvent({ type: "hooks.loaded", hooks: snapshot() });

  return {
    getStatuses: snapshot,
    setEnabled(id: string, enabled: boolean): void {
      updateStatus(id, { enabled });
    },
    dispatchPostTurn(ctx: TurnContext): void {
      void dispatch("postTurn", ctx);
    },
    dispatchPostRun(summary: RunSummary): Promise<void> {
      return dispatch("postRun", summary);
    },
  };
}

async function runLifecycleHook(
  hook: LifecycleHook,
  kind: HookKind,
  payload: TurnContext | RunSummary,
): Promise<HookExitStatus> {
  const command = hook.type === "typescript"
    ? await createTypeScriptHookCommand(hook, kind)
    : hookCommand(hook, kind);
  const proc = Bun.spawn(command, {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  return {
    code: exitCode,
    signal: proc.signalCode,
    stderr,
  };
}

function hookCommand(hook: LifecycleHook, kind: HookKind): string[] {
  return ["sh", hook.path, kind];
}

async function createTypeScriptHookCommand(
  hook: LifecycleHook,
  kind: HookKind,
): Promise<string[]> {
  const runnerPath = join(
    tmpdir(),
    "interchange-code-hook-runners",
    `${hashHookRunner(hook.path, kind)}.ts`,
  );
  await mkdir(join(tmpdir(), "interchange-code-hook-runners"), { recursive: true });
  await writeFile(runnerPath, typeScriptHookRunnerSource(hook.path, kind));
  return ["bun", runnerPath];
}

function typeScriptHookRunnerSource(path: string, kind: HookKind): string {
  const hookURL = pathToFileURL(path).href;
  return [
    `import * as hook from ${JSON.stringify(hookURL)};`,
    "const chunks = [];",
    "for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);",
    "const payload = new TextDecoder().decode(Buffer.concat(chunks));",
    `const selected = hook[${JSON.stringify(kind)}];`,
    "if (typeof selected !== 'function') process.exit(0);",
    "await selected(JSON.parse(payload));",
    "",
  ].join("\n");
}

function hashHookRunner(path: string, kind: HookKind): string {
  return createHash("sha256").update(`${path}:${kind}`).digest("hex").slice(0, 24);
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    thinking: a.thinking + b.thinking,
  };
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}
