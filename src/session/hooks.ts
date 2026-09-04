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
import { onTurnBoundary } from "../agent/reactor-events.js";

import { COMMAND_NAME, SETTINGS_DIR_NAME } from "../branding.js";

export type HookKind = "postTurn" | "postRun";

export type LifecycleHookType = "typescript" | "shell";

export interface HookExitStatus {
  code: number | null;
  signal: string | null;
  stderr: string;
}

export interface LifecycleHook {
  id: string;
  name: string;
  type: LifecycleHookType;
  path: string;
}

export type LifecycleHookStatus = LifecycleHook & {
  enabled: boolean;
  lastFiredAt?: number;
  lastKind?: HookKind;
  lastExitStatus?: HookExitStatus;
};

export interface TurnContext {
  turnIndex: number;
  assistantTurn: ConversationTurn;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  usage: TokenUsage;
  source: LastCycleSource;
  durationMs: number;
}

export interface RunSummary {
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
}

export type LifecycleHookEvent =
  | { type: "hooks.loaded"; hooks: LifecycleHookStatus[] }
  | { type: "hook.updated"; hook: LifecycleHookStatus };

export interface LifecycleHookManager {
  getStatuses(): LifecycleHookStatus[];
  setEnabled(id: string, enabled: boolean): void;
  dispatchPostTurn(ctx: TurnContext): void;
  dispatchPostRun(summary: RunSummary): Promise<void>;
}

interface PendingTurn {
  startedAt: number;
  turnIndex: number;
  assistantTurn: ConversationTurn;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  usage: TokenUsage;
  source: LastCycleSource;
}

const emptyUsage: TokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
};

export const RETAINED_TURN_CONTEXT_LIMIT = 200;

// Retained turns are only built when a hook consumes them (over stdin, not
// the model), so a tail-anchored budget well below any model context limit
// keeps up to 200 turns of tool output from becoming a second full copy of
// recent history in memory.
export const HOOK_PAYLOAD_TOOL_RESULT_CHARS = 4_000;

export function hooksDirectory(): string {
  return globalHooksDirectory();
}

export function localHooksDirectory(cwd: string = process.cwd()): string {
  return join(cwd, SETTINGS_DIR_NAME, "hooks");
}

export function globalHooksDirectory(): string {
  return join(homedir(), SETTINGS_DIR_NAME, "hooks");
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

export interface TurnContextCollectorOptions {
  // Turn/token/tool-call counts are cheap scalars needed regardless of
  // consumers. The turns array (with truncated tool results) is the actual
  // standing copy of recent history, so callers with nothing to hand it to
  // (no lifecycle hook) can opt out of retaining it.
  retainHistory?: boolean;
  // Resuming a session should continue the persisted run.json turn count
  // rather than restart it at zero.
  initialTurnCount?: number;
}

export function createTurnContextCollector(
  onTurn: (ctx: TurnContext) => void,
  now: () => number = Date.now,
  options: TurnContextCollectorOptions = {},
): {
  observe(event: ReactorEmittedEvent): void;
  getTurns(): TurnContext[];
  getTurnCount(): number;
  getTokenUsage(): TokenUsage;
  // Usage reported for the most recent turn alone (not summed across turns),
  // since a provider's per-turn `input` already reflects the whole resent
  // conversation — the right basis for "how full is the context window now."
  getLastTurnUsage(): TokenUsage;
  getToolCallCount(): number;
} {
  const retainHistory = options.retainHistory ?? true;
  const turns: TurnContext[] = [];
  let turnCount = options.initialTurnCount ?? 0;
  let pending: PendingTurn | null = null;
  let cycleStartedAt = now();
  let tokenUsage: TokenUsage = { ...emptyUsage };
  let lastTurnUsage: TokenUsage = { ...emptyUsage };
  let toolCallCount = 0;

  function completePending(): void {
    if (pending === null) return;
    if (pending.toolResults.length < pending.toolCalls.length) return;
    const ctx: TurnContext = {
      turnIndex: pending.turnIndex,
      assistantTurn: pending.assistantTurn,
      toolCalls: pending.toolCalls,
      toolResults: retainHistory
        ? pending.toolResults.map(truncateToolResultForHookPayload)
        : pending.toolResults,
      usage: pending.usage,
      source: pending.source,
      durationMs: Math.max(0, now() - pending.startedAt),
    };
    turnCount++;
    if (retainHistory) {
      turns.push(ctx);
      if (turns.length > RETAINED_TURN_CONTEXT_LIMIT) {
        turns.splice(0, turns.length - RETAINED_TURN_CONTEXT_LIMIT);
      }
    }
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

      if (onTurnBoundary(event)) {
        const toolCalls = event.data.turn.content
          .filter(
            (block): block is Extract<typeof block, { type: "tool_call" }> =>
              block.type === "tool_call",
          )
          .map((block): ToolCall => ({
            id: block.id,
            name: block.name,
            arguments: block.arguments,
          }));
        toolCallCount += toolCalls.length;
        tokenUsage = addUsage(tokenUsage, event.data.usage);
        lastTurnUsage = event.data.usage;
        pending = {
          startedAt: cycleStartedAt,
          turnIndex: turnCount,
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
    getTurnCount(): number {
      return turnCount;
    },
    getTokenUsage(): TokenUsage {
      return { ...tokenUsage };
    },
    getLastTurnUsage(): TokenUsage {
      return { ...lastTurnUsage };
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
  onEvent?: ((event: LifecycleHookEvent) => void) | undefined;
  logError?: ((message: string) => void) | undefined;
  // Persisted enable/disable state, keyed by hook id. A hook absent here starts
  // enabled, matching discovery's default before any state was ever saved.
  initialEnabled?: Record<string, boolean> | undefined;
}): LifecycleHookManager {
  const onEvent = args.onEvent ?? (() => {});
  const logError = args.logError ?? (() => {});
  const initialEnabled = args.initialEnabled ?? {};
  const statuses = new Map<string, LifecycleHookStatus>();
  for (const hook of args.hooks) {
    statuses.set(hook.id, { ...hook, enabled: initialEnabled[hook.id] ?? true });
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

  function runHook(
    status: LifecycleHookStatus,
    kind: HookKind,
    payload: TurnContext | RunSummary,
  ): Promise<void> {
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
  const command =
    hook.type === "typescript"
      ? await createTypeScriptHookCommand(hook, kind)
      : hookCommand(hook, kind);
  const proc = Bun.spawn(command, {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return {
    code: exitCode,
    signal: proc.signalCode,
    stderr,
  };
}

function hookCommand(hook: LifecycleHook, kind: HookKind): string[] {
  return ["sh", hook.path, kind];
}

async function createTypeScriptHookCommand(hook: LifecycleHook, kind: HookKind): Promise<string[]> {
  const runnerDir = join(tmpdir(), `${COMMAND_NAME}-hook-runners`);
  const runnerPath = join(runnerDir, `${hashHookRunner(hook.path, kind)}.ts`);
  await mkdir(runnerDir, { recursive: true });
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

function truncateToolResultForHookPayload(result: ToolResult): ToolResult {
  const raw = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
  const content =
    raw.length <= HOOK_PAYLOAD_TOOL_RESULT_CHARS
      ? raw
      : `…[${raw.length - HOOK_PAYLOAD_TOOL_RESULT_CHARS} chars omitted]${raw.slice(raw.length - HOOK_PAYLOAD_TOOL_RESULT_CHARS)}`;
  return {
    callId: result.callId,
    content,
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
    ...(result.pendingMarker !== undefined ? { pendingMarker: result.pendingMarker } : {}),
  };
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
