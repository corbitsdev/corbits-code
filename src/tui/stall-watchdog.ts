import { isSameTool } from "../agent/canonical-tool-name.js";
import type { TurnStatus } from "./chrome-state.js";

// Longest continuous silence before the watchdog aborts the in-flight request.
export const STALL_TIMEOUT_MS = 900_000;

// Warning before the abort: close enough that users do not quit on a
// permanent-looking hang, far enough that slow models and long tool calls
// are not flagged (above the 60–180s silence of sparse reasoning streams;
// matches DEFAULT_STALL_MS on spawn_agent rows).
export const STALL_NOTICE_MS = 300_000;

export interface ShouldAbortForStallArgs {
  readonly status: TurnStatus;
  readonly awaitingResponse: boolean;
  readonly lastActivityAt: number;
  readonly nowMs: number;
  readonly stallTimeoutMs: number;
  readonly isProcessing: boolean;
  readonly streamingType: "text" | "thinking" | "tool" | null;
  readonly currentToolName: string | null;
  readonly activeToolCalls: readonly string[];
  readonly callIdByName: Readonly<Record<string, string>>;
  /**
   * Tool name per in-flight call id; bounds the leftover once the mapping
   * owner resolves (see `isStallBoundedInFlightTool`).
   */
  readonly callNameById: Readonly<Record<string, string>>;
}

/**
 * Whether `thresholdMs` of silence counts as stuck; shared by the notice and
 * the abort.
 */
function silentPastThreshold(
  args: ShouldAbortForStallArgs,
  thresholdMs: number,
): boolean {
  if (args.status !== "running") return false;
  if (args.nowMs - args.lastActivityAt < thresholdMs) return false;
  // A fan-out sets `awaitingResponse` when any sibling finishes; outstanding
  // calls mean the run is not silent regardless of that flag.
  if (args.awaitingResponse && args.activeToolCalls.length === 0) return true;
  // Watchdog-exempt polls (collect, wait_agents, ask_director) emit no parent
  // events; with no other wall-clock bound, the stall budget is their backstop.
  if (isStallBoundedInFlightTool(args) && args.isProcessing) return true;
  // Mid-stream hang after the first token; tool runs have their own watchdog.
  return (
    args.isProcessing &&
    args.streamingType !== null &&
    args.streamingType !== "tool"
  );
}

/**
 * Whether a name is a poll the execution watchdog does not bound; the stall
 * clock must bound these or the turn can hang forever. Keys any in-flight
 * stall-bounded name — a sibling tool.done can clear the last announced one.
 */
function isStallBoundedToolName(name: string | null | undefined): boolean {
  if (name === null || name === undefined) return false;
  return isSameTool(name, "wait_agents") || isSameTool(name, "ask_director");
}

function isStallBoundedInFlightTool(args: ShouldAbortForStallArgs): boolean {
  if (isStallBoundedToolName(args.currentToolName)) return true;
  for (const [name, id] of Object.entries(args.callIdByName)) {
    if (isStallBoundedToolName(name) && args.activeToolCalls.includes(id)) {
      return true;
    }
  }
  // Same-name siblings share one slot; the leftover's own id keeps the bound
  // when the mapping owner resolves and clears the slot.
  for (const id of args.activeToolCalls) {
    if (isStallBoundedToolName(args.callNameById[id])) return true;
  }
  // Name-only announcements track the call by name until a real id arrives.
  return args.activeToolCalls.some(isStallBoundedToolName);
}

// Pure decision helper so the stall check is unit-testable without timers.
// Silence past `stallTimeoutMs` aborts a live turn: a wait for the next token
// or an unbounded poll. Tool runs have their own budget.
export function shouldAbortForStall(args: ShouldAbortForStallArgs): boolean {
  return silentPastThreshold(args, args.stallTimeoutMs);
}

export type ShouldNoticeStallArgs = ShouldAbortForStallArgs & {
  readonly stallNoticeMs: number;
  /** Whether the repetition guard currently sees a looping tail. */
  readonly repeating: boolean;
};

export type StallLevel = "quiet" | "notice" | "abort";

/**
 * How stuck the run is. Two consumers want different cuts of the same clock:
 * the status flash wants "silent but not yet handled" (no shout over the
 * abort), the phase indicator wants "silent at all" through the abort
 * threshold. One function keeps them agreeing. Repeating runs stay quiet:
 * output is flowing, just not useful.
 */
export function stallLevel(args: ShouldNoticeStallArgs): StallLevel {
  if (args.repeating) return "quiet";
  if (shouldAbortForStall(args)) return "abort";
  return silentPastThreshold(args, args.stallNoticeMs) ? "notice" : "quiet";
}

/**
 * True while silent long enough to say so but not yet long enough to abort.
 */
export function shouldNoticeStall(args: ShouldNoticeStallArgs): boolean {
  return stallLevel(args) === "notice";
}

/** Whether the phase indicator should paint the run as stalled. */
export function isStalledForDisplay(args: ShouldNoticeStallArgs): boolean {
  return stallLevel(args) !== "quiet";
}

/**
 * Shown while nothing arrives at all; a looping model produces output and is
 * reported by `repetitionRecoveryMessage`.
 */
export const STALL_NOTICE_MESSAGE =
  "no response for a while — ctrl+c to interrupt";

export const STALL_RECOVERY_MESSAGE =
  "stopped after no response — send again to retry";

/**
 * Shown while the watchdog re-presents an approval that was already parked.
 * Names the attempt only: it never claims the parked call ran.
 */
export const STALL_APPROVAL_RESUME_MESSAGE =
  "no response while waiting on approval, re-presenting the pending approval";

/**
 * Shown when a repeated line aborts the turn; worded as degeneration so a
 * retry reads as reasonable, not a cover-up of a suspected hang.
 */
export function repetitionRecoveryMessage(repeatedTokens: number): string {
  return `stopped after repeating itself — ~${repeatedTokens} tokens looped — send again to retry`;
}

export interface ApplyStallRecoveryDeps {
  /** Abort the in-flight run through the session port. */
  readonly abort: () => void;
  readonly notify: (message: string) => void;
}

export function applyStallRecovery(
  deps: ApplyStallRecoveryDeps,
  message: string = STALL_RECOVERY_MESSAGE,
): void {
  deps.abort();
  deps.notify(message);
}
