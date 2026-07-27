import { formatToolExecutionTimeoutMessage } from "../plugins/tool-time-budget.js";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

/** Wall-clock budget for a single tool `run()` invocation (outer guard). */
export type ToolWatchdogConfig = {
  defaultMs?: number;
  maxMs?: number;
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
  const budget = withTimeout(parentSignal, timeoutMs);
  try {
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
  } finally {
    budget.dispose();
  }
}
