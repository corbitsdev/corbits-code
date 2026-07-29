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

export type PauseableTimeout = {
  signal: AbortSignal;
  dispose: () => void;
  pause: () => void;
  resume: () => void;
};

/**
 * Like withTimeout, but the remaining budget freezes while paused (e.g. while
 * a permission prompt is open). Pause/resume are refcounted so nested pauses
 * (multi-segment shell approvals) stay correct.
 */
export function withPauseableTimeout(signal: AbortSignal, timeoutMs: number): PauseableTimeout {
  const controller = new AbortController();
  let remaining = Math.max(1, Math.floor(timeoutMs));
  let startedAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pauseDepth = 0;
  let disposed = false;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
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
    startedAt = Date.now();
    timer = setTimeout(fire, remaining);
  };

  const pause = (): void => {
    if (disposed || controller.signal.aborted) return;
    pauseDepth += 1;
    if (pauseDepth !== 1) return;
    if (startedAt !== null) {
      remaining = Math.max(0, remaining - (Date.now() - startedAt));
      startedAt = null;
    }
    clearTimer();
  };

  const resume = (): void => {
    if (disposed || controller.signal.aborted) return;
    if (pauseDepth === 0) return;
    pauseDepth -= 1;
    if (pauseDepth === 0) arm();
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
      signal.removeEventListener("abort", onParentAbort);
    },
    pause,
    resume,
  };
}

/** Per-tool budget handle visible to permission-gate code via ALS. */
export type ToolApprovalBudget = {
  signal: AbortSignal;
  pause: () => void;
  resume: () => void;
  waitForApproval: boolean;
};

const toolApprovalBudgetAls = new AsyncLocalStorage<ToolApprovalBudget>();

export function getToolApprovalBudget(): ToolApprovalBudget | undefined {
  return toolApprovalBudgetAls.getStore();
}

/** Freeze the active tool budget (no-op when waitForApproval is off or no budget). */
export function pauseToolApprovalBudget(): void {
  const budget = toolApprovalBudgetAls.getStore();
  if (budget === undefined || !budget.waitForApproval) return;
  budget.pause();
}

/** Resume the active tool budget after a permission prompt settles. */
export function resumeToolApprovalBudget(): void {
  const budget = toolApprovalBudgetAls.getStore();
  if (budget === undefined || !budget.waitForApproval) return;
  budget.resume();
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
   * When true (default), the budget freezes during permission prompts via
   * pauseToolApprovalBudget / resumeToolApprovalBudget.
   */
  waitForApproval?: boolean;
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
  options?: ToolExecutionWatchdogOptions,
): Promise<ToolResult> {
  const salvageGraceMs = options?.salvageGraceMs ?? TOOL_EXECUTION_SALVAGE_GRACE_MS;
  const waitForApproval = options?.waitForApproval !== false;
  const budget = waitForApproval
    ? withPauseableTimeout(parentSignal, timeoutMs)
    : {
        ...withTimeout(parentSignal, timeoutMs),
        pause: () => {},
        resume: () => {},
      };
  const approvalBudget: ToolApprovalBudget = {
    signal: budget.signal,
    pause: budget.pause,
    resume: budget.resume,
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
