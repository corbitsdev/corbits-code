import { AsyncLocalStorage } from "node:async_hooks";
import { formatToolExecutionTimeoutMessage } from "../plugins/tool-time-budget.js";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

/** Wall-clock budget for a single tool `run()` invocation (outer guard). */
export type ToolWatchdogConfig = {
  defaultMs?: number;
  maxMs?: number;
  /**
   * When true (default), freeze this budget while a permission prompt is open
   * so a late approve still runs the tool. When false, the budget keeps ticking
   * during the prompt; if it expires first the tool is skipped and the prompt
   * is dismissed via the budget AbortSignal.
   */
  waitForApproval?: boolean;
};

// Default exceeds shell-guard's per-command max so run_shell is not cut off by
// this layer before its own timeout fires.
export const DEFAULT_TOOL_EXECUTION_TIMEOUT_MS = 660_000;
export const MAX_TOOL_EXECUTION_TIMEOUT_MS = 1_800_000;

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

const BUDGET_EXPIRED = Symbol("tool-execution-budget-expired");

export function resolveToolExecutionTimeoutMs(config?: ToolWatchdogConfig): number {
  const max = config?.maxMs ?? MAX_TOOL_EXECUTION_TIMEOUT_MS;
  const raw = config?.defaultMs ?? DEFAULT_TOOL_EXECUTION_TIMEOUT_MS;
  return Math.min(max, Math.max(1, Math.floor(raw)));
}

/** Default true: freeze tool budget while a permission prompt is open. */
export function resolveWaitForApproval(config?: ToolWatchdogConfig): boolean {
  return config?.waitForApproval !== false;
}

export function withTimeout(
  signal: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  signal.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal.aborted) controller.abort();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onParentAbort);
    },
  };
}

/**
 * Identifies the pause generation a `pause()` call belonged to. A forced
 * ceiling resume bumps the generation, so a `resume(token)` call made after
 * the ceiling already fired for that pause can recognize itself as stale
 * instead of decrementing a newer, unrelated pause's depth.
 */
export type PauseToken = number;

export type PauseableTimeout = {
  signal: AbortSignal;
  dispose: () => void;
  pause: () => PauseToken;
  resume: (token: PauseToken) => void;
};

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
export type ChainedPauseToken = { own: PauseToken; enclosing?: ChainedPauseToken };

/** Per-tool budget handle visible to permission-gate code via ALS. */
export type ToolApprovalBudget = {
  signal: AbortSignal;
  pause: () => ChainedPauseToken;
  resume: (token: ChainedPauseToken) => void;
  waitForApproval: boolean;
};

const toolApprovalBudgetAls = new AsyncLocalStorage<ToolApprovalBudget>();

export function getToolApprovalBudget(): ToolApprovalBudget | undefined {
  return toolApprovalBudgetAls.getStore();
}

function budgetExpiry(signal: AbortSignal): Promise<typeof BUDGET_EXPIRED> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(BUDGET_EXPIRED);
      return;
    }
    signal.addEventListener("abort", () => resolve(BUDGET_EXPIRED), { once: true });
  });
}

function isAbortLikeToolError(content: string): boolean {
  return /abort/i.test(content);
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

export type ToolExecutionWatchdogOptions = {
  /** Override the post-abort salvage grace (tests); defaults to TOOL_EXECUTION_SALVAGE_GRACE_MS. */
  salvageGraceMs?: number;
  /**
   * When true, the budget freezes during permission prompts. Callers resolve
   * the setting (resolveWaitForApproval); there is no default here.
   */
  waitForApproval: boolean;
};

/**
 * Runs `execute` under a wall-clock race against `parentSignal`, matching the
 * shell-guard search-tool pattern so non-abortable work still returns on time.
 *
 * When budget/parent abort wins the race, the signal is still aborted, but we
 * give the in-flight execute a short grace to return a usable non-error body
 * (e.g. task-tool structured salvage) before synthesizing "aborted"/timeout.
 * This closes the CL-4611 race where salvage was discarded wholesale.
 */
export async function runWithToolExecutionWatchdog(
  call: ToolCall,
  parentSignal: AbortSignal,
  timeoutMs: number,
  execute: (signal: AbortSignal) => Promise<ToolResult>,
  options: ToolExecutionWatchdogOptions,
): Promise<ToolResult> {
  const salvageGraceMs = options.salvageGraceMs ?? TOOL_EXECUTION_SALVAGE_GRACE_MS;
  const waitForApproval = options.waitForApproval;
  const budget = waitForApproval
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
        const content = parentSignal.aborted
          ? `${call.name} aborted`
          : formatToolExecutionTimeoutMessage(call.name, timeoutMs);
        return { callId: call.id, content, isError: true };
      }

      if (
        outcome.isError === true &&
        typeof outcome.content === "string" &&
        outcome.content.includes("[timed out before completing]")
      ) {
        return outcome;
      }

      if (
        budget.signal.aborted &&
        !parentSignal.aborted &&
        outcome.isError === true &&
        typeof outcome.content === "string" &&
        isAbortLikeToolError(outcome.content)
      ) {
        return {
          callId: call.id,
          content: formatToolExecutionTimeoutMessage(call.name, timeoutMs),
          isError: true,
        };
      }

      return outcome;
    });
  } finally {
    budget.dispose();
  }
}
