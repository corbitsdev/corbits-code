import { AsyncLocalStorage } from "node:async_hooks";
import {
  formatMcpToolTimeoutMessage,
  formatToolExecutionTimeoutMessage,
  TIMEOUT_PREFIX,
} from "../plugins/tool-time-budget.js";
import { BUDGET_EXPIRED, budgetExpiry, withTimeout } from "../util/budget-race.js";
export { withTimeout };
import { isMcpToolName } from "../mcp/tool-name.js";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

/** Wall-clock budget for a single tool `run()` invocation (outer guard). */
export interface ToolWatchdogConfig {
  defaultMs?: number;
  maxMs?: number;
  /**
   * When true (default), freeze this budget while a permission prompt is open
   * so a late approve still runs the tool. When false, the budget keeps ticking
   * during the prompt; if it expires first the tool is skipped and the prompt
   * is dismissed via the budget AbortSignal.
   */
  waitForApproval?: boolean;
  /**
   * Override for mcp__* tool calls (settings.mcp.timeoutMs). Unlike the
   * generic defaultMs/maxMs pair, MCP tools are always bounded — a wedged MCP
   * server otherwise hangs a tool call forever (CL-6895) — so this only
   * changes the bound, it never leaves it unarmed.
   */
  mcpTimeoutMs?: number;
}

// Default wall-clock budget for a single MCP tool call when settings.mcp.timeoutMs
// is unset. Live forensics (CL-6895) showed multi-minute MCP calls that were
// merely slow and later completed successfully, not deadlocked — so this stays
// generous (5 minutes) rather than the shorter default used for other tools,
// while still bounding a genuinely wedged server.
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 300_000;

// Cap applied when Settings set tools.timeoutMs without tools.maxTimeoutMs.
// Not an implicit default — omitted settings leave the watchdog unarmed.
export const MAX_TOOL_EXECUTION_TIMEOUT_MS = 1_800_000;

/**
 * Watchdog arms before shell-guard, so the outer budget must outlast a matching
 * requested run_shell timeout or this layer wins the race and aborts first.
 */
export const RUN_SHELL_WATCHDOG_SLACK_MS = 1_000;

/**
 * After budget/parent abort wins the race, wait this long for the in-flight
 * execute to settle with a usable (non-error) body — e.g. task-tool salvage —
 * before returning the synthetic abort/timeout message.
 */
export const TOOL_EXECUTION_SALVAGE_GRACE_MS = 5_000;

/**
 * Upper bound on how long a paused budget may stay frozen. A permission prompt
 * that never becomes visible (overlay open, gate listener gone) never resumes
 * the budget; after this ceiling the clock resumes on its own so a frozen
 * budget cannot hang a tool run indefinitely.
 */
export const MAX_TOOL_APPROVAL_PAUSE_MS = 1_800_000;

/**
 * Wall-clock budget for one tool `run()`, or undefined to leave the timer unarmed.
 * Parent cancel and eval `--agent-timeout-ms` still bound the run.
 *
 * Arms only when Settings pass tools.timeoutMs / tools.maxTimeoutMs, or when
 * run_shell passes a positive arguments.timeout (requested + slack so this
 * layer cannot beat shell-guard). A requested run_shell timeout is not clamped
 * to MAX_TOOL_EXECUTION_TIMEOUT_MS or tools.maxTimeoutMs.
 *
 * The spawn_agent tool is exempt: it runs an entire sub-agent that carries its own
 * bound (an opt-in deadline), so the generic per-tool budget would
 * abort healthy long-running workers mid-run.
 *
 * mcp__* tool calls are the opposite of exempt: they arm unconditionally (see
 * resolveMcpToolTimeoutMs) even when no Settings are configured, because an
 * MCP server can wedge a call forever with no other watchdog to bound it
 * (CL-6895).
 */
export function resolveToolExecutionTimeoutMs(
  config?: ToolWatchdogConfig,
  call?: ToolCall,
): number | undefined {
  if (call?.name === "spawn_agent") return undefined;
  if (call?.name === "run_shell") {
    const requested = requestedRunShellTimeoutMs(call);
    if (requested !== undefined) {
      return requested + RUN_SHELL_WATCHDOG_SLACK_MS;
    }
  }
  if (call !== undefined && isMcpToolName(call.name)) {
    return resolveMcpToolTimeoutMs(config);
  }
  return resolveSettingsWatchdogTimeoutMs(config);
}

function resolveMcpToolTimeoutMs(config: ToolWatchdogConfig | undefined): number {
  const max = config?.maxMs ?? MAX_TOOL_EXECUTION_TIMEOUT_MS;
  const configured = config?.mcpTimeoutMs;
  // A non-positive or non-finite configured value is not a valid budget (it
  // would floor to a ~0ms timeout and instantly fail every MCP call, which is
  // unconditionally armed) — fall back to the default instead of clamping to 1ms.
  const raw =
    configured !== undefined && Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_MCP_TOOL_TIMEOUT_MS;
  return Math.min(max, Math.max(1, Math.floor(raw)));
}

function requestedRunShellTimeoutMs(call: ToolCall): number | undefined {
  const timeout = call.arguments.timeout;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    return undefined;
  }
  return Math.floor(timeout);
}

function resolveSettingsWatchdogTimeoutMs(
  config: ToolWatchdogConfig | undefined,
): number | undefined {
  if (config === undefined || (config.defaultMs === undefined && config.maxMs === undefined)) {
    return undefined;
  }
  const max = config.maxMs ?? MAX_TOOL_EXECUTION_TIMEOUT_MS;
  const raw = config.defaultMs ?? max;
  return Math.min(max, Math.max(1, Math.floor(raw)));
}

/** Default true: freeze tool budget while a permission prompt is open. */
export function resolveWaitForApproval(config?: ToolWatchdogConfig): boolean {
  return config?.waitForApproval !== false;
}

/**
 * Identifies the pause generation a `pause()` call belonged to. A forced
 * ceiling resume bumps the generation, so a `resume(token)` call made after
 * the ceiling already fired for that pause can recognize itself as stale
 * instead of decrementing a newer, unrelated pause's depth.
 */
export type PauseToken = number;

export interface PauseableTimeout {
  signal: AbortSignal;
  dispose: () => void;
  pause: () => PauseToken;
  resume: (token: PauseToken) => void;
}

/** Chain parent cancel without arming a run-duration timer. */
function withParentAbort(signal: AbortSignal): PauseableTimeout {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  signal.addEventListener("abort", onParentAbort, { once: true });
  if (signal.aborted) controller.abort();
  return {
    signal: controller.signal,
    dispose: () => {
      signal.removeEventListener("abort", onParentAbort);
    },
    pause: (): PauseToken => 0,
    resume: (_token: PauseToken) => {},
  };
}

/**
 * Like withTimeout, but the remaining budget freezes while paused (e.g. while
 * a permission prompt is open). Pause/resume are refcounted so nested pauses
 * (multi-segment shell approvals) stay correct.
 */
export function withPauseableTimeout(
  signal: AbortSignal,
  timeoutMs: number,
  pauseCeilingMs: number = MAX_TOOL_APPROVAL_PAUSE_MS,
): PauseableTimeout {
  const controller = new AbortController();
  let remaining = Math.max(1, Math.floor(timeoutMs));
  let startedAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ceilingTimer: ReturnType<typeof setTimeout> | null = null;
  let pauseDepth = 0;
  let disposed = false;
  // Bumped on every forced ceiling resume. Lets a pause()/resume() pair from
  // before the forced resume recognize itself as stale (see resume() below)
  // instead of decrementing a newer, unrelated pause's depth.
  let pauseGeneration = 0;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const clearCeilingTimer = (): void => {
    if (ceilingTimer !== null) {
      clearTimeout(ceilingTimer);
      ceilingTimer = null;
    }
  };

  const fire = (): void => {
    remaining = 0;
    startedAt = null;
    clearTimer();
    controller.abort();
  };

  const arm = (): void => {
    clearTimer();
    if (disposed || pauseDepth > 0 || controller.signal.aborted) return;
    if (remaining <= 0) {
      fire();
      return;
    }
    startedAt = performance.now();
    timer = setTimeout(fire, remaining);
  };

  const pause = (): PauseToken => {
    if (disposed || controller.signal.aborted) return pauseGeneration;
    pauseDepth += 1;
    if (pauseDepth !== 1) return pauseGeneration;
    if (startedAt !== null) {
      remaining = Math.max(0, remaining - (performance.now() - startedAt));
      startedAt = null;
    }
    clearTimer();
    // Ceiling on the freeze: an invisible or orphaned prompt never calls
    // resume, so force the clock back on after pauseCeilingMs. That bumps the
    // generation, so a resume() for this pause arriving afterward is stale
    // and recognized as such by its token (see resume() below) rather than
    // decrementing whatever pause is active by then.
    ceilingTimer = setTimeout(() => {
      ceilingTimer = null;
      pauseDepth = 0;
      pauseGeneration += 1;
      arm();
    }, pauseCeilingMs);
    return pauseGeneration;
  };

  const resume = (token: PauseToken): void => {
    if (disposed || controller.signal.aborted) return;
    if (token !== pauseGeneration) return; // stale: its ceiling already fired
    if (pauseDepth === 0) return;
    pauseDepth -= 1;
    if (pauseDepth === 0) {
      clearCeilingTimer();
      arm();
    }
  };

  const onParentAbort = () => controller.abort();
  signal.addEventListener("abort", onParentAbort, { once: true });
  if (signal.aborted) controller.abort();
  else arm();

  return {
    signal: controller.signal,
    dispose: () => {
      disposed = true;
      clearTimer();
      clearCeilingTimer();
      signal.removeEventListener("abort", onParentAbort);
    },
    pause,
    resume,
  };
}

/**
 * Composite pause token for a chained budget (task tool → child tool call):
 * one entry per budget in the enclosing chain, each keyed to that budget's
 * own generation.
 */
export interface ChainedPauseToken {
  own: PauseToken;
  enclosing?: ChainedPauseToken;
}

/** Per-tool budget handle visible to permission-gate code via ALS. */
export interface ToolApprovalBudget {
  signal: AbortSignal;
  pause: () => ChainedPauseToken;
  resume: (token: ChainedPauseToken) => void;
  waitForApproval: boolean;
}

const toolApprovalBudgetAls = new AsyncLocalStorage<ToolApprovalBudget>();

export function getToolApprovalBudget(): ToolApprovalBudget | undefined {
  return toolApprovalBudgetAls.getStore();
}

function isAbortLikeToolError(content: string): boolean {
  return /abort/i.test(content);
}

function formatTimeoutMessage(toolName: string, timeoutMs: number): string {
  return isMcpToolName(toolName)
    ? formatMcpToolTimeoutMessage(toolName, timeoutMs)
    : formatToolExecutionTimeoutMessage(toolName, timeoutMs);
}

/** True when execute produced a body the parent should prefer over synthetic abort/timeout. */
export function isUsableToolExecuteResult(result: ToolResult): boolean {
  return (
    result.isError !== true &&
    typeof result.content === "string" &&
    result.content.trim().length > 0
  );
}

/**
 * Await `promise` up to `graceMs`. Returns the settled value, or undefined on
 * grace expiry. Rejections propagate to the caller.
 */
export async function settleWithGrace<T>(
  promise: Promise<T>,
  graceMs: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), graceMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * After budget abort, prefer a late non-error execute body (task salvage) when
 * it settles within grace. Errors / empty bodies / grace expiry → undefined so
 * the caller can emit the synthetic abort/timeout result.
 */
export async function preferExecuteSalvageAfterAbort(
  executePromise: Promise<ToolResult>,
  graceMs: number = TOOL_EXECUTION_SALVAGE_GRACE_MS,
): Promise<ToolResult | undefined> {
  try {
    const settled = await settleWithGrace(executePromise, graceMs);
    if (settled !== undefined && isUsableToolExecuteResult(settled)) return settled;
  } catch {
    // execute rejected after abort; fall through to synthetic result
  }
  return undefined;
}

export interface ToolExecutionWatchdogOptions {
  /** Override the post-abort salvage grace (tests); defaults to TOOL_EXECUTION_SALVAGE_GRACE_MS. */
  salvageGraceMs?: number;
  /**
   * When true, the budget freezes during permission prompts. Callers resolve
   * the setting (resolveWaitForApproval); there is no default here.
   */
  waitForApproval: boolean;
}

/**
 * Runs `execute` under a race against `parentSignal` and, when `timeoutMs` is
 * set, a wall-clock budget. `undefined` timeout does not arm a timer — parent
 * cancel and the approval-budget ALS still apply. Permission pause ceiling
 * (`MAX_TOOL_APPROVAL_PAUSE_MS`) stays a stuck-prompt guard, not a run cap.
 *
 * When budget/parent abort wins the race, the signal is still aborted, but we
 * give the in-flight execute a short grace to return a usable non-error body
 * (e.g. task-tool structured salvage) before synthesizing "aborted"/timeout.
 * This closes the CL-4611 race where salvage was discarded wholesale.
 */
export async function runWithToolExecutionWatchdog(
  call: ToolCall,
  parentSignal: AbortSignal,
  timeoutMs: number | undefined,
  execute: (signal: AbortSignal) => Promise<ToolResult>,
  options: ToolExecutionWatchdogOptions,
): Promise<ToolResult> {
  const salvageGraceMs = options.salvageGraceMs ?? TOOL_EXECUTION_SALVAGE_GRACE_MS;
  const waitForApproval = options.waitForApproval;
  const budget: PauseableTimeout =
    timeoutMs === undefined
      ? withParentAbort(parentSignal)
      : waitForApproval
        ? withPauseableTimeout(parentSignal, timeoutMs)
        : {
            ...withTimeout(parentSignal, timeoutMs),
            pause: (): PauseToken => 0,
            resume: (_token: PauseToken) => {},
          };
  // Nested runs (task tool → child tool call) shadow the parent store: the
  // gate captures the innermost budget, so pause/resume must chain outward or
  // the parent `task` budget keeps ticking under the permission modal.
  const enclosing = toolApprovalBudgetAls.getStore();
  const approvalBudget: ToolApprovalBudget = {
    signal: budget.signal,
    pause: (): ChainedPauseToken => ({
      own: budget.pause(),
      ...(enclosing !== undefined ? { enclosing: enclosing.pause() } : {}),
    }),
    resume: (token: ChainedPauseToken) => {
      budget.resume(token.own);
      if (enclosing !== undefined && token.enclosing !== undefined) {
        enclosing.resume(token.enclosing);
      }
    },
    waitForApproval,
  };

  try {
    return await toolApprovalBudgetAls.run(approvalBudget, async () => {
      const executePromise = execute(budget.signal);
      const outcome = await Promise.race([executePromise, budgetExpiry(budget.signal)]);

      if (outcome === BUDGET_EXPIRED) {
        const salvaged = await preferExecuteSalvageAfterAbort(executePromise, salvageGraceMs);
        if (salvaged !== undefined) return salvaged;
        // Avoid unhandled rejection if execute later fails after we move on.
        void executePromise.catch(() => {});
        const content =
          timeoutMs !== undefined && !parentSignal.aborted
            ? formatTimeoutMessage(call.name, timeoutMs)
            : `${call.name} aborted`;
        return { callId: call.id, content, isError: true };
      }

      if (
        outcome.isError === true &&
        typeof outcome.content === "string" &&
        outcome.content.includes(TIMEOUT_PREFIX)
      ) {
        return outcome;
      }

      if (
        budget.signal.aborted &&
        !parentSignal.aborted &&
        timeoutMs !== undefined &&
        outcome.isError === true &&
        typeof outcome.content === "string" &&
        isAbortLikeToolError(outcome.content)
      ) {
        return {
          callId: call.id,
          content: formatTimeoutMessage(call.name, timeoutMs),
          isError: true,
        };
      }

      return outcome;
    });
  } finally {
    budget.dispose();
  }
}
