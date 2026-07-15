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

/**
 * Runs `execute` under a wall-clock race against `parentSignal`, matching the
 * shell-guard search-tool pattern so non-abortable work still returns on time.
 */
export async function runWithToolExecutionWatchdog(
  call: ToolCall,
  parentSignal: AbortSignal,
  timeoutMs: number,
  execute: (signal: AbortSignal) => Promise<ToolResult>,
): Promise<ToolResult> {
  const budget = withTimeout(parentSignal, timeoutMs);
  try {
    const outcome = await Promise.race([execute(budget.signal), budgetExpiry(budget.signal)]);

    if (outcome === BUDGET_EXPIRED) {
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