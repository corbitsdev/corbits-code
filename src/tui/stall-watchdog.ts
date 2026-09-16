import type { TurnStatus } from "./chrome-state.js";

// How long the run can be continuously awaiting a response with no new content
// before the watchdog fires and aborts the in-flight request.
export const STALL_TIMEOUT_MS = 900_000;

// When the run starts *saying* it looks stuck. Well short of the abort: nobody
// waits out the backstop, they conclude the product hung and quit, so silence
// has to be named long before it is acted on. Notice, not a shorter timeout —
// a slow model or a long tool call is not a stall, and killing it early would
// break working runs to fix a wording problem. Grok-4.6 on the Responses path
// streams only sparse reasoning *summaries* while billing tens of thousands of
// thinking tokens, so 60–180s of true client silence mid-think is routine;
// the notice sits above that band and matches DEFAULT_STALL_MS on spawn_agent rows.
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
   * Tool name for each in-flight real call id. Concurrent same-name siblings
   * share one `callIdByName` slot; this map keeps the leftover named after
   * the mapping owner resolves. See `isStallBoundedInFlightTool`.
   */
  readonly callNameById: Readonly<Record<string, string>>;
}

/**
 * Whether silence of `thresholdMs` counts as stuck at all. Shared by the notice
 * and the abort so they never disagree about which runs are stalled — only
 * about how long they have been.
 */
function silentPastThreshold(
  args: ShouldAbortForStallArgs,
  thresholdMs: number,
): boolean {
  if (args.status !== "running") return false;
  if (args.nowMs - args.lastActivityAt < thresholdMs) return false;
  // A parallel fan-out flips `awaitingResponse` true the moment any one
  // sub-agent's tool call finishes, even while siblings are still running.
  // Outstanding calls mean the run is not silent, regardless of that flag.
  if (args.awaitingResponse && args.activeToolCalls.length === 0) return true;
  // Execution-watchdog-exempt polls (collect, wait_agents, ask_director) emit
  // no parent stream events. That must not pin the stall clock forever: they
  // have no other wall-clock bound, so the stall budget is the backstop.
  // TUI primary does not mount wait_agents; the name is kept so a stray mount cannot pin the clock.
  if (isStallBoundedInFlightTool(args) && args.isProcessing) return true;
  // Mid-stream hang: model stream stalled after first token. Ordinary in-flight
  // tool runs still do not emit parent stream events; leave those to the
  // per-tool execution watchdog rather than this silence clock.
  return (
    args.isProcessing &&
    args.streamingType !== null &&
    args.streamingType !== "tool"
  );
}

/**
 * Polls the per-tool execution watchdog leaves unarmed. Without a stall
 * bound they hold the turn with no other wall-clock limit. A sibling
 * tool.done clears `currentToolName` / `streamingType` while the poll is
 * still in `activeToolCalls`, so the bound keys any in-flight stall-bounded
 * name, not only the last announced tool. The name-keyed `callIdByName`
 * holds one id per tool, so concurrent same-name siblings overwrite each
 * other there; the per-id `callNameById` covers the leftover when the
 * mapping-owning sibling resolves first and clears the shared slot.
 */
function isStallBoundedToolName(name: string | null | undefined): boolean {
  return (
    name === "shell_collect" ||
    name === "wait_agents" ||
    name === "ask_director"
  );
}

function isStallBoundedInFlightTool(args: ShouldAbortForStallArgs): boolean {
  if (isStallBoundedToolName(args.currentToolName)) return true;
  for (const [name, id] of Object.entries(args.callIdByName)) {
    if (isStallBoundedToolName(name) && args.activeToolCalls.includes(id)) {
      return true;
    }
  }
  // Concurrent same-name siblings share one callIdByName slot, so the
  // mapping-owning sibling clearing it on tool.done must not release the
  // leftover earlier call: its own id still maps to the bounded name here.
  for (const id of args.activeToolCalls) {
    if (isStallBoundedToolName(args.callNameById[id])) return true;
  }
  // Name-only announcements track the call under its name until a real id
  // arrives, so the placeholder itself is the stall-bounded name.
  return args.activeToolCalls.some(isStallBoundedToolName);
}

// Pure decision helper: returns true when the run is genuinely stuck and should
// be aborted. Extracted so the timeout logic is unit-testable without timers.
//
// Silence past `stallTimeoutMs` aborts a live turn, including a wait for the
// model's next token (right after submit, after a tool batch resolves, or after
// compact continuation re-entry) and an in-flight poll the per-tool watchdog
// does not bound. Ordinary tool runs stay exempt here because they have their
// own execution budget.
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
 * How stuck the run is. Three levels, because the two consumers want different
 * cuts of the same clock: the status flash wants "silent, but not yet handled"
 * so it does not shout over the abort's own message, while the phase indicator
 * wants "silent at all" — it must keep reading as a problem right through the
 * abort threshold rather than flipping back to healthy at the worst possible
 * instant. Both read this one function so they can never disagree about which
 * runs are stalled, only about what to do at each level.
 *
 * Quiet while repeating: that run is producing output, just not useful output,
 * and "no response" would misdescribe it.
 */
export function stallLevel(args: ShouldNoticeStallArgs): StallLevel {
  if (args.repeating) return "quiet";
  if (shouldAbortForStall(args)) return "abort";
  return silentPastThreshold(args, args.stallNoticeMs) ? "notice" : "quiet";
}

/**
 * Returns true while the run has been silent long enough to say so but not yet
 * long enough to abort, so the notice and the abort never speak at once.
 */
export function shouldNoticeStall(args: ShouldNoticeStallArgs): boolean {
  return stallLevel(args) === "notice";
}

/** Whether the phase indicator should paint the run as stalled. */
export function isStalledForDisplay(args: ShouldNoticeStallArgs): boolean {
  return stallLevel(args) !== "quiet";
}

/**
 * Shown while nothing is arriving at all. Never fires while tokens are
 * flowing — a model looping on repeated content is still producing output,
 * so it is reported by `repetitionRecoveryMessage` instead, not this one.
 */
export const STALL_NOTICE_MESSAGE =
  "no response for a while — ctrl+c to interrupt";

export const STALL_RECOVERY_MESSAGE =
  "stopped after no response — send again to retry";

/**
 * Shown once a repeated line aborts the turn. Named as degeneration, not a
 * generic failure, so a retry reads as the reasonable next step rather than
 * papering over a suspected hang or network fault.
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
