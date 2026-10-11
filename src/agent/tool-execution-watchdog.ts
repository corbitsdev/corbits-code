import { isSameTool } from "./canonical-tool-name.js";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  formatMcpToolTimeoutMessage,
  formatToolExecutionTimeoutMessage,
  TIMEOUT_PREFIX,
} from "../plugins/tool-time-budget.js";
import {
  BUDGET_EXPIRED,
  budgetExpiry,
  withTimeout,
} from "../util/budget-race.js";
export { withTimeout };
import { isMcpToolName } from "../mcp/tool-name.js";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { resolveShellTimeoutMs } from "../plugins/shell-guard-plugin.js";

/** Wall-clock budget for a single tool `run()` invocation (outer guard). */
export interface ToolWatchdogConfig {
  defaultMs?: number;
  maxMs?: number;
  /**
   * Freeze the budget while a permission prompt is open (default true) so a
   * late approve still runs the tool. When false, the budget keeps ticking.
   */
  waitForApproval?: boolean;
  /**
   * Override for mcp__* tool calls (settings.mcp.timeoutMs). MCP tools stay
   * bounded (a wedged server would hang a call forever), so this only
   * changes the bound, never disarms it.
   */
  mcpTimeoutMs?: number;
  /**
   * settings.shell.timeoutMs override of the 120s foreground run_shell default.
   * Does not apply to background starts.
   */
  shellDefaultMs?: number;
  /**
   * settings.shell.maxTimeoutMs — clamps the foreground default path only;
   * a per-call run_shell timeout is not capped.
   */
  shellMaxMs?: number;
  /**
   * Post-abort salvage grace. Tests set it short so never-settling cases
   * don't pay the 5s default.
   */
  salvageGraceMs?: number;
}

// Default MCP budget when settings.mcp.timeoutMs is unset. Multi-minute
// calls are often merely slow and later complete, so stay generous
// (5 minutes) while still bounding a wedged server.
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 300_000;

// Cap applied when Settings set tools.timeoutMs without tools.maxTimeoutMs.
// Not an implicit default — omitted settings leave the watchdog unarmed.
export const MAX_TOOL_EXECUTION_TIMEOUT_MS = 1_800_000;

/**
 * Arms before shell-guard, so the budget must outlast a matching requested
 * run_shell timeout or it aborts first.
 */
export const RUN_SHELL_WATCHDOG_SLACK_MS = 1_000;

/**
 * After budget/parent abort wins, wait this long for the in-flight execute
 * to settle with a usable body (wait_agents salvage) before returning the
 * synthetic abort/timeout result.
 */
export const TOOL_EXECUTION_SALVAGE_GRACE_MS = 5_000;

/**
 * Ceiling on a frozen (paused) budget. A prompt that never becomes visible
 * never resumes; past this ceiling the clock resumes on its own so a frozen
 * budget cannot hang a run.
 */
export const MAX_TOOL_APPROVAL_PAUSE_MS = 1_800_000;

/**
 * Wall-clock budget for one tool `run()`; undefined leaves the timer unarmed
 * (parent cancel and eval `--agent-timeout-ms` still bound the run).
 *
 * Arms for Settings tools.timeoutMs / tools.maxTimeoutMs, the foreground
 * run_shell timeout (120s default or per-call, plus slack to stay behind
 * shell-guard), or mcp__* calls; requested run_shell timeouts are not
 * clamped to the max constants.
 *
 * Exempt: spawn_agent (returns immediately), wait_agents / ask_director
 * (aborting would not stop what they wait on), and run_shell background:true
 * (the process outlives the turn). mcp__* calls arm unconditionally: a
 * server could otherwise wedge a call forever.
 */
export function resolveToolExecutionTimeoutMs(
  config?: ToolWatchdogConfig,
  call?: ToolCall,
): number | undefined {
  if (
    call !== undefined &&
    (isSameTool(call.name, "spawn_agent") ||
      isSameTool(call.name, "wait_agents") ||
      isSameTool(call.name, "ask_director"))
  ) {
    return undefined;
  }
  if (call !== undefined && isSameTool(call.name, "run_shell")) {
    // Background runs return at once and finish after tool.boundary; arming
    // requested+slack on the START call would abort mid-run; the process's
    // own timeout still bounds it.
    if (call.arguments.background === true) return undefined;
    const requested = requestedRunShellTimeoutMs(call);
    const effective = resolveShellTimeoutMs({
      requested,
      background: false,
      ...(config?.shellDefaultMs !== undefined
        ? { defaultMs: config.shellDefaultMs }
        : {}),
      ...(config?.shellMaxMs !== undefined ? { maxMs: config.shellMaxMs } : {}),
    });
    if (effective !== undefined) {
      return effective + RUN_SHELL_WATCHDOG_SLACK_MS;
    }
  }
  if (call !== undefined && isMcpToolName(call.name)) {
    return resolveMcpToolTimeoutMs(config);
  }
  return resolveSettingsWatchdogTimeoutMs(config);
}

function resolveMcpToolTimeoutMs(
  config: ToolWatchdogConfig | undefined,
): number {
  const max = config?.maxMs ?? MAX_TOOL_EXECUTION_TIMEOUT_MS;
  const configured = config?.mcpTimeoutMs;
  // Non-positive or non-finite values would floor to ~0ms and fail every MCP
  // call; fall back to the default instead of clamping to 1ms.
  const raw =
    configured !== undefined && Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_MCP_TOOL_TIMEOUT_MS;
  return Math.min(max, Math.max(1, Math.floor(raw)));
}

function requestedRunShellTimeoutMs(call: ToolCall): number | undefined {
  const timeout = call.arguments.timeout;
  if (
    typeof timeout !== "number" ||
    !Number.isFinite(timeout) ||
    timeout <= 0
  ) {
    return undefined;
  }
  return Math.floor(timeout);
}

function resolveSettingsWatchdogTimeoutMs(
  config: ToolWatchdogConfig | undefined,
): number | undefined {
  if (
    config === undefined ||
    (config.defaultMs === undefined && config.maxMs === undefined)
  ) {
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

/** Generation of a pause()/resume() pair; a forced ceiling resume bumps it so
 * a late resume() reads stale (see resume()). */
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
    resume: (_token: PauseToken) => undefined,
  };
}

/**
 * Like withTimeout, but the remaining budget freezes while paused (e.g. a
 * permission prompt is open). Pause/resume refcount so nested pauses
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
  // Bumped on every forced ceiling resume so an older pause()/resume() pair
  // reads stale (see resume()) instead of decrementing a newer pause's depth.
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
    // Ceiling on the freeze: an invisible or orphaned prompt never resumes,
    // so force the clock back on after pauseCeilingMs; bumping the generation
    // makes a late resume() stale.
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
 * Composite pause token for a chained budget (wait_agents → child tool call):
 * one entry per budget in the chain, keyed to that budget's own generation.
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
 * After budget abort, prefer a late non-error execute body (wait_agents
 * salvage) settling within grace; otherwise undefined so the caller emits
 * the synthetic abort/timeout result.
 */
export async function preferExecuteSalvageAfterAbort(
  executePromise: Promise<ToolResult>,
  graceMs: number = TOOL_EXECUTION_SALVAGE_GRACE_MS,
): Promise<ToolResult | undefined> {
  try {
    const settled = await settleWithGrace(executePromise, graceMs);
    if (settled !== undefined && isUsableToolExecuteResult(settled))
      return settled;
  } catch {
    // execute rejected after abort; fall through to synthetic result
  }
  return undefined;
}

export interface ToolExecutionWatchdogOptions {
  /** Override the post-abort salvage grace (tests); defaults to TOOL_EXECUTION_SALVAGE_GRACE_MS. */
  salvageGraceMs?: number;
  /**
   * When true, the budget freezes during permission prompts; callers resolve
   * the setting (resolveWaitForApproval), no default here.
   */
  waitForApproval: boolean;
}

/**
 * Runs `execute` against `parentSignal` and, when `timeoutMs` is set, a
 * wall-clock budget. `undefined` timeout arms no timer — parent cancel and
 * the approval-budget ALS still apply, and the permission pause ceiling
 * stays a stuck-prompt guard, not a run cap.
 *
 * On budget/parent abort, the in-flight execute gets a short grace to return
 * a usable body (wait_agents salvage) before the caller synthesizes
 * "aborted"/timeout.
 */
export async function runWithToolExecutionWatchdog(
  call: ToolCall,
  parentSignal: AbortSignal,
  timeoutMs: number | undefined,
  execute: (signal: AbortSignal) => Promise<ToolResult>,
  options: ToolExecutionWatchdogOptions,
): Promise<ToolResult> {
  const salvageGraceMs =
    options.salvageGraceMs ?? TOOL_EXECUTION_SALVAGE_GRACE_MS;
  const waitForApproval = options.waitForApproval;
  const budget: PauseableTimeout =
    timeoutMs === undefined
      ? withParentAbort(parentSignal)
      : waitForApproval
        ? withPauseableTimeout(parentSignal, timeoutMs)
        : {
            ...withTimeout(parentSignal, timeoutMs),
            pause: (): PauseToken => 0,
            resume: (_token: PauseToken) => undefined,
          };
  // Nested runs (wait_agents → child tool call) shadow the parent store;
  // pause/resume must chain outward or the parent budget keeps ticking under
  // the permission modal.
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
      const outcome = await Promise.race([
        executePromise,
        budgetExpiry(budget.signal),
      ]);

      if (outcome === BUDGET_EXPIRED) {
        const salvaged = await preferExecuteSalvageAfterAbort(
          executePromise,
          salvageGraceMs,
        );
        if (salvaged !== undefined) return salvaged;
        // Avoid unhandled rejection if execute later fails after we move on.
        void executePromise.catch(() => undefined);
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
