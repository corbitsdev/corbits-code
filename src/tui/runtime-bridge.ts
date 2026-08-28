/**
 * Wave 4 runtime bridge — thin port between OpenTUI shell and session events.
 *
 * Inbound: fixture or reactor-like events → stream rows + run state + queue drain.
 * Outbound: queue / steer / interrupt / immediate send hit SessionPort (tests record;
 * later waves can bind real agent APIs). Not the production CLI entry.
 */

import {
  drainOne,
  enqueue,
  enqueueSteer,
  interrupt,
  setRunState,
  type QueueItem,
  type QueueKind,
} from "./session-queue.js";
import {
  appendStreamRow,
  applyShellInterrupt,
  clearShellBridgeHooks,
  paintChrome,
  paintLanding,
  replaceStreamRowAt,
  setLockupFrame,
  setShellBridgeHooks,
  setStatusFlash,
  streamRowAt,
  streamRowCount,
  truncateStreamRows,
  userRowText,
  type AppShell,
} from "./shell.js";
import { rampAnimating } from "./ramp.js";
import { onTurnBoundary } from "../agent/reactor-events.js";
import { resolveRampPhase, resolveTurnLabel, sendFailureText } from "./session-chrome.js";
import { shouldAutoRetryQuota } from "./quota-retry.js";
import { RUNTIME_FLASH_MS } from "./runtime-notices.js";
import {
  applyStallRecovery,
  repetitionRecoveryMessage,
  isStalledForDisplay,
  shouldAbortForStall,
  stallLevel,
  STALL_NOTICE_MESSAGE,
  STALL_NOTICE_MS,
  STALL_RECOVERY_MESSAGE,
  STALL_TIMEOUT_MS,
} from "./stall-watchdog.js";
import {
  clearQuotaWait,
  initialTurnState,
  turnStateFromEvent,
  turnStateGateClosed,
  turnStateGateOpened,
  turnStateOnInterrupt,
  turnStateOnSubmit,
  type TurnState,
} from "./turn-state.js";
import type { PendingImageAttachment } from "./image-attachments.js";
import { toolCallRow } from "./diff.js";
import { toolResultRow } from "./mcp-view.js";
import { canCoalesceCall, coalesceCallRows, mergeToolRows } from "./tool-rows.js";
import type { StreamRow } from "./stream.js";
import { advanceRevealChars, flattenReasoningText, type Thought } from "./thinking.js";
import {
  agentProgress,
  clockLabel,
  fleetProgress,
  type AgentProgressSession,
} from "./agent-progress.js";

/** Tool name a sub-agent dispatch call carries — its row gets live progress. */
const TASK_TOOL_NAME = "task";

/**
 * Tool name the task checklist is written through. Its calls paint no
 * transcript row: the list they write is live state owned by the task panel,
 * and a row per call renders the same work twice on one screen — once as a
 * panel that updates in place, and again as scrollback that never does.
 */
const MANAGE_TASKS_TOOL_NAME = "manage_tasks";

/** A sub-agent session as `syncAgentProgress` needs it: identified, and live-readable. */
export type TaskProgressSession = AgentProgressSession & { readonly id: string };
import {
  PRODUCTION_REACTOR_TYPES,
  createStreamMapContext,
  mapProductionEvent,
  mapReactorLike,
  type BridgeInboundEvent,
  type ReactorLikeEvent,
  type StreamMapContext,
} from "./stream-event-map.js";

/** Re-export map types/fn so existing `from "./runtime-bridge"` imports keep working. */
export type { BridgeInboundEvent, ReactorLikeEvent, StreamMapContext };
export { mapReactorLike };

/** Outbound actions the UI asks the session runtime to perform. */
export interface SessionPort {
  /**
   * Classify a composer submit without side effects. Local-only lines (slash
   * commands, armed multi-turn /feedback text) must never enter the mid-run
   * queue or mark the session busy. Default when omitted: treat as agent.
   */
  classifySubmit?: (
    text: string,
    attachments?: readonly PendingImageAttachment[],
  ) => "agent" | "local" | "empty";
  /** Idle prompt submit — deliver now. */
  sendImmediate: (text: string, attachments?: readonly PendingImageAttachment[]) => void;
  /** Mid-run queue or steer accepted by the shell. */
  enqueue: (text: string, kind: QueueKind) => void;
  /** Hard interrupt current run. */
  interrupt: () => void;
  /** Queue item drained at a tool boundary (or idle). */
  deliver: (item: QueueItem) => void;
}

export type SessionPortHandlers = Partial<SessionPort>;

/**
 * Timer wiring for the quota auto-retry and stall watchdog.
 *
 * Everything is injectable so tests drive the clock instead of waiting on it:
 * `schedule` returns its own cancel, and `now` is the only time source.
 */
export interface TurnMonitorOptions {
  readonly now?: () => number;
  /**
   * Poll period for the retry countdown and the stall check. Default 250 ms.
   * While something is animating the monitor ticks faster than this; see
   * `ANIMATION_TICK_MS`.
   */
  readonly tickMs?: number;
  readonly stallTimeoutMs?: number;
  /** Silence after which the run says it looks stuck. Default 90 s. */
  readonly stallNoticeMs?: number;
  /** Registers the periodic tick; returns an unsubscribe. */
  readonly schedule?: (tick: () => void, intervalMs: number) => () => void;
}

const DEFAULT_TICK_MS = 250;

/**
 * Poll period while something on this clock is animating.
 *
 * The status slot's pulse steps through its glyphs in `RAMP_CYCLE_MS` (1200 ms)
 * and the landing mark runs a 4.6 s timeline; at 250 ms that is 5 and 19
 * samples respectively, so the pulse skips steps and the mark strobes. ~12 fps
 * is the coarsest cadence at which both read as motion, and it costs nothing
 * when idle because the monitor stops entirely then.
 */
const ANIMATION_TICK_MS = 80;

function defaultSchedule(tick: () => void, intervalMs: number): () => void {
  const handle = setInterval(tick, intervalMs);
  // The monitor must never be the reason the process stays alive.
  handle.unref?.();
  return () => {
    clearInterval(handle);
  };
}

export interface SessionBridge {
  /** Apply a canonical or reactor-like event to the shell. */
  handle: (event: BridgeInboundEvent | ReactorLikeEvent) => void;
  /** Replay a fixture sequence. */
  play: (events: readonly (BridgeInboundEvent | ReactorLikeEvent)[]) => void;
  /** Operator paths — shell keys go through the same logic via exclusive hooks. */
  submit: (
    text: string,
    kind: "queue" | "steer" | "immediate" | "reinject",
    attachments?: readonly PendingImageAttachment[],
  ) => void;
  interrupt: () => void;
  /**
   * A permission or operator gate was raised — queued or already displayed.
   * Blocks the turn (and exempts it from the stall watchdog) until a matching
   * `gateClosed` call. Multiple outstanding gates nest correctly.
   */
  gateOpened: () => void;
  /** A previously raised gate resolved. */
  gateClosed: () => void;
  dispose: () => void;
  /** Current derived turn phase (progress label, stall clock, quota window). */
  readonly turn: TurnState;
  readonly shell: AppShell;
  /**
   * Refresh outstanding `task` rows with each worker's live progress. The
   * caller supplies the sessions (from `SubAgentSessionStore.listForStrip()`
   * or similar) on whatever cadence it already polls at.
   */
  syncAgentProgress: (sessions: readonly TaskProgressSession[]) => void;
  /**
   * Stamp the live catalog provider id onto the stream map context so
   * `inference.error` transcript lines can identify known-xAI short 429s
   * when the harness event omits `providerId`.
   */
  setInferenceProviderId: (id: string | undefined) => void;
}

const NOOP_PORT: SessionPort = {
  sendImmediate: () => {},
  enqueue: () => {},
  interrupt: () => {},
  deliver: () => {},
};

export type PortCall =
  | { readonly op: "sendImmediate"; readonly text: string }
  | { readonly op: "enqueue"; readonly text: string; readonly kind: QueueKind }
  | { readonly op: "interrupt" }
  | { readonly op: "deliver"; readonly item: QueueItem };

export function createRecordingPort(opts?: {
  classifySubmit?: SessionPort["classifySubmit"];
}): SessionPort & {
  readonly calls: readonly PortCall[];
  clear: () => void;
} {
  const calls: PortCall[] = [];
  return {
    get calls() {
      return calls;
    },
    clear: () => {
      calls.length = 0;
    },
    ...(opts?.classifySubmit !== undefined ? { classifySubmit: opts.classifySubmit } : {}),
    sendImmediate: (text) => {
      calls.push({ op: "sendImmediate", text });
    },
    enqueue: (text, kind) => {
      calls.push({ op: "enqueue", text, kind });
    },
    interrupt: () => {
      calls.push({ op: "interrupt" });
    },
    deliver: (item) => {
      calls.push({ op: "deliver", item });
    },
  };
}

function isBridgeInbound(event: { type: string }): event is BridgeInboundEvent {
  switch (event.type) {
    case "user":
    case "assistant":
    case "assistant.delta":
    case "thinking.delta":
    case "tool_call":
    case "tool_result":
    case "system":
    case "run":
    case "fleet":
    case "tool.boundary":
    case "error":
      return true;
    default:
      return false;
  }
}

function rowFromInbound(event: BridgeInboundEvent): StreamRow | null {
  switch (event.type) {
    case "user":
      return { role: "user", text: event.text };
    case "assistant":
      return { role: "assistant", text: event.text };
    case "system":
      return { role: "system", text: event.text };
    case "error":
      return { role: "system", text: sendFailureText(event.message), meta: "error" };
    default:
      return null;
  }
}

/** Streaming row kinds the bridge grows in place, one row per message. */
type OpenRowKind = "assistant" | "thinking";

/** The transcript row deltas are currently appending to. */
interface OpenStreamRow {
  readonly kind: OpenRowKind;
  readonly index: number;
  /** Clock the row opened at, so settled reasoning can report how long it took. */
  readonly startedAt: number;
  text: string;
  /**
   * Bounded-rate reveal position for a "thinking" row's wrapped preview.
   * Unused for "assistant" rows, which paint their full markdown body as it
   * grows.
   */
  revealChars: number;
  /** Clock `revealChars` was last advanced from. */
  revealAt: number;
  /**
   * Reasoning time this row already carried before the model came back to
   * think again, so a folded row reports the turn's thinking, not the last
   * fragment's.
   */
  readonly elapsedBefore: number;
  /**
   * Reopened row: the turn already thought once here, and this row sits above
   * the tool rows that followed. It grows in its settled form rather than
   * scrolling — a line crawling in the middle of the transcript reads as
   * something moving that the operator did not touch.
   */
  readonly folded: boolean;
}

/** The one reasoning row a turn owns, once the turn has thought at all. */
interface TurnThinking {
  readonly index: number;
  readonly text: string;
  readonly ms: number;
}

/** Blank line between the fragments a turn thought at different moments. */
const THINKING_FRAGMENT_SEPARATOR = "\n\n";

interface BridgeBag {
  port: SessionPort;
  openRow: OpenStreamRow | null;
  /**
   * Prompts already echoed locally. The runtime replays each one as
   * `message.received`; without this the transcript shows the message twice.
   */
  pendingEchoes: string[];
  /** callId→name / delta bookkeeping for production-shaped events. */
  mapCtx: StreamMapContext;
  disposed: boolean;
  turn: TurnState;
  /**
   * Live fleet-lane count from the last `fleet` event (idle-with-fleet).
   * While this is above zero a settled parent turn holds the run busy —
   * Enter upgrades to a new primary turn, follow-ups keep waiting for true
   * session-idle — and the hold releases when the count lands back at zero.
   */
  liveFleet: number;
  /** Last prompt actually sent — replay source for the quota auto-retry. */
  lastSentMessage: string;
  /** One auto-retry per rate-limit window. */
  quotaFired: boolean;
  now: () => number;
  /** Transcript row each in-flight call occupies, so its result can resolve it. */
  toolRows: Map<string, number>;
  /**
   * When each in-flight ordinary tool call started, so its row can carry a
   * live elapsed clock instead of sitting on a static pending mark for the
   * length of a slow call — the one case a healthy turn reads as dead.
   */
  toolCallStartedAt: Map<string, number>;
  /** Row of the newest in-flight call, for results that carry no call id. */
  lastToolRow: number;
  /**
   * callIds of outstanding `task` calls — a subset of `toolRows`' keys. Kept
   * separate so `syncAgentProgress` never has to walk every in-flight tool to
   * find the handful that are sub-agent dispatches.
   */
  taskCallIds: Set<string>;
  /**
   * Last sub-agent session list the host synced. Retained rather than consumed
   * and dropped because the status ticker recomputes fleet state at paint time
   * on the animation tick, not only when a worker happens to emit an event.
   */
  agentSessions: readonly TaskProgressSession[];
  /**
   * callIds whose call painted no row because the work belongs to a panel
   * (`manage_tasks`). Tracked so the matching result is dropped rather than
   * landing unpaired.
   */
  panelOnlyCallIds: Set<string>;
  /**
   * Row index where the inference attempt in progress began, or null when no
   * boundary is armed. The mapper decides when to mark, clear and roll back;
   * the row index is the bridge's to keep.
   */
  attemptRow: number | null;
  /**
   * Reasoning row of the turn in progress, or null before it thinks. Mid-turn
   * thinking folds back into it instead of opening a row between tool calls:
   * a turn is one run of work, and reasoning that interleaves breaks the run
   * into fragments that each read as half a sentence.
   */
  turnThinking: TurnThinking | null;
}

const bridges = new WeakMap<AppShell, BridgeBag>();

function resolvePort(handlers?: SessionPortHandlers): SessionPort {
  return {
    ...(handlers?.classifySubmit !== undefined ? { classifySubmit: handlers.classifySubmit } : {}),
    sendImmediate: handlers?.sendImmediate ?? NOOP_PORT.sendImmediate,
    enqueue: handlers?.enqueue ?? NOOP_PORT.enqueue,
    interrupt: handlers?.interrupt ?? NOOP_PORT.interrupt,
    deliver: handlers?.deliver ?? NOOP_PORT.deliver,
  };
}

/**
 * Prompt text without the attachment note. The local echo and the runtime's
 * `message.received` word that note differently, so echoes match on content.
 */
function promptContent(text: string): string {
  const note = text.indexOf("\n[");
  return (note === -1 ? text : text.slice(0, note)).trim();
}

/** True when this inbound user message is one the shell already painted. */
function consumeEcho(bag: BridgeBag, text: string): boolean {
  const index = bag.pendingEchoes.indexOf(promptContent(text));
  if (index === -1) return false;
  bag.pendingEchoes.splice(index, 1);
  return true;
}

function messageReceivedContent(event: { readonly data?: unknown }): string | undefined {
  const data = event.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const message = (data as { readonly message?: unknown }).message;
  if (message === null || typeof message !== "object" || Array.isArray(message)) return undefined;
  const content = (message as { readonly content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

function consumePendingEchoEvent(
  bag: BridgeBag,
  event: { readonly type: string; readonly data?: unknown },
): boolean {
  if (event.type !== "message.received") return false;
  const content = messageReceivedContent(event);
  return content !== undefined && consumeEcho(bag, content);
}

function openRowContent(
  kind: OpenRowKind,
  text: string,
  streaming: boolean,
  thought?: Thought,
  revealChars?: number,
): StreamRow {
  if (kind === "assistant") return { role: "assistant", text, streaming };
  return {
    role: "system",
    text,
    meta: "thinking",
    streaming,
    ...(thought !== undefined ? { thought } : {}),
    ...(revealChars !== undefined ? { revealChars } : {}),
  };
}

/** Total reasoning an open thinking row stands for, earlier fragments included. */
function thoughtOf(bag: BridgeBag, open: OpenStreamRow): Thought {
  return { ms: open.elapsedBefore + Math.max(0, bag.now() - open.startedAt) };
}

/** Repaint a folded reasoning row: settled in shape, still growing in text. */
function paintFoldedRow(shell: AppShell, bag: BridgeBag, open: OpenStreamRow): void {
  replaceStreamRowAt(
    shell,
    open.index,
    openRowContent(open.kind, open.text, false, thoughtOf(bag, open)),
  );
}

/** Finalize the open streaming row: it stops growing and stops being unstable. */
function closeOpenRow(shell: AppShell, bag: BridgeBag): void {
  const open = bag.openRow;
  if (open === null) return;
  bag.openRow = null;
  // Reasoning stops scrolling and keeps its opening line; the elapsed time and
  // the full chain of thought stay on the row, behind the expand key.
  const thought = open.kind === "thinking" ? thoughtOf(bag, open) : undefined;
  if (thought !== undefined) {
    bag.turnThinking = { index: open.index, text: open.text, ms: thought.ms };
  }
  replaceStreamRowAt(shell, open.index, openRowContent(open.kind, open.text, false, thought));
}

/**
 * Grow the open row of this kind, or start one. Deltas never append a row of
 * their own — the message is a single row whose body is repainted as it fills.
 */
function growOpenRow(shell: AppShell, bag: BridgeBag, kind: OpenRowKind, text: string): void {
  const open = bag.openRow;
  if (open !== null && open.kind === kind) {
    open.text += text;
    if (open.folded) paintFoldedRow(shell, bag, open);
    else if (kind === "thinking") advanceOpenReveal(shell, open, bag.now());
    else replaceStreamRowAt(shell, open.index, openRowContent(kind, open.text, true));
    return;
  }
  closeOpenRow(shell, bag);
  const now = bag.now();
  const folded = kind === "thinking" ? bag.turnThinking : null;
  if (folded !== null) {
    bag.openRow = {
      kind,
      index: folded.index,
      text: `${folded.text}${THINKING_FRAGMENT_SEPARATOR}${text}`,
      startedAt: now,
      revealChars: 0,
      revealAt: now,
      elapsedBefore: folded.ms,
      folded: true,
    };
    paintFoldedRow(shell, bag, bag.openRow);
    return;
  }
  const index = streamRowCount(shell);
  bag.openRow = {
    kind,
    index,
    text,
    startedAt: now,
    revealChars: 0,
    revealAt: now,
    elapsedBefore: 0,
    folded: false,
  };
  appendStreamRow(
    shell,
    openRowContent(kind, text, true, undefined, kind === "thinking" ? 0 : undefined),
  );
}

/**
 * Advance a "thinking" row's reveal position at the bounded rate and repaint
 * if it moved. Called on every delta and on the animation tick, so the line
 * both grows with new tokens and keeps crawling through buffered text during
 * a pause in arrival — capped either way by what has actually arrived.
 */
function advanceOpenReveal(shell: AppShell, open: OpenStreamRow, nowMs: number): void {
  // A folded row is settled text above the turn's tool rows; it has no scroll
  // line to advance.
  if (open.folded) return;
  const available = flattenReasoningText(open.text).length;
  const revealed = advanceRevealChars(open.revealChars, available, nowMs - open.revealAt);
  open.revealAt = nowMs;
  if (revealed === open.revealChars) return;
  open.revealChars = revealed;
  replaceStreamRowAt(
    shell,
    open.index,
    openRowContent(open.kind, open.text, true, undefined, revealed),
  );
}

/**
 * Paint a tool call. A repeat of the call the previous row already painted
 * collapses onto that row instead of opening a new one — a model that asks the
 * same question sixteen times should cost the transcript one line, not sixteen.
 */
function applyToolCall(
  shell: AppShell,
  bag: BridgeBag,
  event: Extract<BridgeInboundEvent, { type: "tool_call" }>,
): void {
  if (event.name === MANAGE_TASKS_TOOL_NAME) {
    // Remembered so the matching result is dropped too — suppressing only the
    // call would leave its result to land as an unpaired row. Checklist lives
    // on the task panel; Task dispatches paint live transcript rows instead.
    if (event.callId !== undefined) bag.panelOnlyCallIds.add(event.callId);
    return;
  }
  const row = toolCallRow({
    name: event.name,
    ...(event.detail !== undefined ? { arguments: event.detail } : {}),
  });
  const count = streamRowCount(shell);
  const tail = streamRowAt(shell, count - 1);
  const index = canCoalesceCall(tail, row) ? count - 1 : count;
  if (tail !== undefined && index < count) {
    replaceStreamRowAt(shell, index, coalesceCallRows(tail, row));
  } else {
    appendStreamRow(shell, row);
  }
  if (event.callId !== undefined) {
    bag.toolRows.set(event.callId, index);
    // A diff call's row already carries a "+n/-n" stat — that is the fact
    // worth keeping, not an elapsed clock, so only ordinary calls (no stat of
    // their own) pick up the live timer.
    if (row.stat === undefined) {
      bag.toolCallStartedAt.set(event.callId, bag.now());
    }
  }
  if (event.callId !== undefined && event.name === TASK_TOOL_NAME) {
    bag.taskCallIds.add(event.callId);
  }
  bag.lastToolRow = index;
  shell.inFlightTool = { name: event.name, startedAt: bag.now() };
}

/**
 * Fold a tool result into the row its call opened. A result whose call is not
 * on the log (a bridge that saw only the answer) still gets a row of its own —
 * losing it would be worse than an unpaired line.
 */
function applyToolResult(
  shell: AppShell,
  bag: BridgeBag,
  event: Extract<BridgeInboundEvent, { type: "tool_result" }>,
): void {
  if (event.callId !== undefined && bag.panelOnlyCallIds.delete(event.callId)) return;
  const result = toolResultRow({
    name: event.name,
    content: event.detail ?? (event.isError ? "error" : "ok"),
    isError: event.isError === true,
  });
  const tracked = event.callId !== undefined ? bag.toolRows.get(event.callId) : undefined;
  // The elapsed clock was scaffolding for the wait, not a fact about the
  // call — clear it before the merge so it never crowds out the answer's own
  // addendum (e.g. "3 lines") the way a diff's own +/- count is allowed to.
  const clockOwned = event.callId !== undefined && bag.toolCallStartedAt.has(event.callId);
  if (event.callId !== undefined) {
    bag.toolRows.delete(event.callId);
    bag.toolCallStartedAt.delete(event.callId);
    bag.taskCallIds.delete(event.callId);
  }
  if (bag.toolRows.size === 0) shell.inFlightTool = null;
  const index = tracked ?? bag.lastToolRow;
  const rawCall = streamRowAt(shell, index);
  const call = clockOwned && rawCall !== undefined ? omitStat(rawCall) : rawCall;
  if (call === undefined || call.pending !== true) {
    appendStreamRow(shell, result);
    return;
  }
  replaceStreamRowAt(shell, index, mergeToolRows(call, result));
}

/**
 * Refresh every outstanding `task` call's row with its worker's live progress —
 * elapsed time, current tool, and whether it has gone quiet. Rewrites each row
 * in place through `replaceStreamRowAt`; a session that finished, or is missing
 * from `sessions`, leaves its row untouched rather than reverting to a bare
 * pending mark.
 */
function syncAgentProgress(
  shell: AppShell,
  bag: BridgeBag,
  sessions: readonly TaskProgressSession[],
  nowMs: number,
): void {
  if (bag.taskCallIds.size === 0) return;
  for (const callId of bag.taskCallIds) {
    const index = bag.toolRows.get(callId);
    if (index === undefined) {
      bag.taskCallIds.delete(callId);
      continue;
    }
    const row = streamRowAt(shell, index);
    if (row === undefined || row.pending !== true) {
      bag.taskCallIds.delete(callId);
      continue;
    }
    const session = sessions.find((s) => s.id === callId);
    if (session === undefined) continue;
    const progress = agentProgress(session, nowMs);
    if (progress === null) continue;
    if (row.stat === progress.stat && row.agentWorking === progress.working) continue;
    replaceStreamRowAt(shell, index, {
      ...row,
      stat: progress.stat,
      agentWorking: progress.working,
    });
  }
}

/** Drop `stat` entirely rather than set it `undefined` (exactOptionalPropertyTypes). */
function omitStat(row: StreamRow): StreamRow {
  const { stat: _stat, ...rest } = row;
  return rest;
}

/**
 * Refresh every plain in-flight tool call's row with how long it has been
 * running. A `task` dispatch already gets this (and more) from
 * `syncAgentProgress`, so those calls are skipped here rather than double
 * painted. Without a live clock an ordinary call's row sits on a static
 * pending mark for however long the tool takes — indistinguishable from a
 * hung turn once that stretches past a few seconds.
 */
function syncToolElapsed(shell: AppShell, bag: BridgeBag, nowMs: number): void {
  if (bag.toolCallStartedAt.size === 0) return;
  for (const [callId, startedAt] of bag.toolCallStartedAt) {
    if (bag.taskCallIds.has(callId)) continue;
    const index = bag.toolRows.get(callId);
    if (index === undefined) {
      bag.toolCallStartedAt.delete(callId);
      continue;
    }
    const row = streamRowAt(shell, index);
    if (row === undefined || row.pending !== true) {
      bag.toolCallStartedAt.delete(callId);
      continue;
    }
    const stat = clockLabel(nowMs - startedAt);
    if (row.stat === stat) continue;
    replaceStreamRowAt(shell, index, { ...row, stat });
  }
}

/**
 * Retract everything the failed attempt painted, then forget the row
 * bookkeeping that pointed into it — a rolled-back tool call has no row left
 * to resolve, and a rolled-back reasoning row is no longer there to fold into.
 */
function isLocallyQueuedUserRow(row: StreamRow): boolean {
  return (
    row.role === "user" &&
    (row.meta === "queue" ||
      row.meta === "steer" ||
      row.meta === "steering" ||
      row.meta === "following-up")
  );
}

function rollbackAttempt(shell: AppShell, bag: BridgeBag): void {
  const boundary = bag.attemptRow;
  bag.attemptRow = null;
  if (boundary === null || boundary >= streamRowCount(shell)) return;
  const localRows = Array.from({ length: streamRowCount(shell) - boundary }, (_, i) =>
    streamRowAt(shell, boundary + i),
  ).filter((row): row is StreamRow => row !== undefined && isLocallyQueuedUserRow(row));
  truncateStreamRows(shell, boundary);
  for (const row of localRows) appendStreamRow(shell, row);
  for (const [callId, index] of [...bag.toolRows]) {
    if (index >= boundary) {
      bag.toolRows.delete(callId);
      bag.toolCallStartedAt.delete(callId);
      bag.taskCallIds.delete(callId);
    }
  }
  if (bag.lastToolRow >= boundary) bag.lastToolRow = -1;
  if (bag.turnThinking !== null && bag.turnThinking.index >= boundary) {
    bag.turnThinking = null;
  }
  paintChrome(shell);
}

function drainAtBoundary(shell: AppShell, bag: BridgeBag): void {
  for (;;) {
    const { state, item } = drainOne(shell.session);
    if (!item) break;
    shell.session = state;
    appendStreamRow(shell, {
      role: "user",
      text: userRowText(item.text, item.attachments ?? []),
      // Distinct from the still-pending "steer"/"queue" tag — this row is
      // being handed to the run right now. Follow-ups must not say steering.
      meta: item.kind === "steer" ? "steering" : "following-up",
    });
    bag.pendingEchoes.push(item.text.trim());
    bag.port.deliver(item);
  }
  paintChrome(shell);
}

/**
 * Soft steer only (CL-6290): tool.boundary drains steers; follow-ups wait
 * for idle / interrupt. Full drain uses drainOrder via drainOne without a
 * kind filter.
 */
function drainSteersAtBoundary(shell: AppShell, bag: BridgeBag): void {
  for (;;) {
    const { state, item } = drainOne(shell.session, "steer");
    if (!item) break;
    shell.session = state;
    appendStreamRow(shell, {
      role: "user",
      text: userRowText(item.text, item.attachments ?? []),
      meta: "steering",
    });
    bag.pendingEchoes.push(item.text.trim());
    bag.port.deliver(item);
  }
  paintChrome(shell);
}

/**
 * Release the run to idle and drain everything queued — but only at true
 * session-idle. A live fleet holds the run busy after the parent turn settles
 * (idle-with-fleet): Enter upgrades to a new primary turn during the hold and
 * follow-ups keep waiting; the fleet event landing at zero re-enters here to
 * release the hold.
 */
function settleRunToIdle(shell: AppShell, bag: BridgeBag): void {
  if (shell.session.run !== "busy") return;
  bag.turnThinking = null;
  shell.inFlightTool = null;
  if (bag.liveFleet > 0) {
    // Hold: the fleet is still live, so the run stays busy. Steers left
    // pending deliver now — the parent they were steering has stopped, so
    // each one just starts its own turn — while follow-ups keep waiting.
    drainSteersAtBoundary(shell, bag);
    return;
  }
  shell.session = setRunState(shell.session, "idle");
  // Full drain: soft steers first, then follow-ups (drainOrder).
  drainAtBoundary(shell, bag);
}

function applyInbound(shell: AppShell, bag: BridgeBag, event: BridgeInboundEvent): void {
  if (bag.disposed) return;

  // Fleet liveness owns no transcript row state, so it is handled before the
  // open-row machinery — a lane terminalizing mid-parent-stream must not
  // close the assistant row the parent's own deltas are growing.
  if (event.type === "fleet") {
    // Idle-with-fleet bookkeeping. A transition to zero while the parent is
    // already idle releases the hold: that moment is true session-idle, so
    // queued follow-ups drain now. While the parent is still working the
    // count just updates — the ordinary turn settle does the draining.
    bag.liveFleet = event.running;
    if (event.running === 0 && !bag.turn.isProcessing) {
      settleRunToIdle(shell, bag);
    }
    paintChrome(shell);
    return;
  }

  if (event.type === "assistant.delta") {
    growOpenRow(shell, bag, "assistant", event.text);
    return;
  }

  if (event.type === "thinking.delta") {
    growOpenRow(shell, bag, "thinking", event.text);
    return;
  }

  closeOpenRow(shell, bag);

  if (event.type === "attempt") {
    if (event.action === "mark") bag.attemptRow = streamRowCount(shell);
    else if (event.action === "clear") bag.attemptRow = null;
    else rollbackAttempt(shell, bag);
    return;
  }

  // A new turn gets a new reasoning row; only within one turn does thinking
  // fold back into the row it already owns.
  if (event.type === "user") bag.turnThinking = null;

  if (event.type === "user" && consumeEcho(bag, event.text)) return;

  if (event.type === "run") {
    if (event.state === "busy") {
      shell.session = setRunState(shell.session, "busy");
      paintChrome(shell);
      return;
    }
    settleRunToIdle(shell, bag);
    paintChrome(shell);
    return;
  }

  if (event.type === "tool.boundary") {
    // Soft steer only — follow-ups wait until the run goes idle.
    drainSteersAtBoundary(shell, bag);
    return;
  }

  if (event.type === "tool_call") {
    applyToolCall(shell, bag, event);
    paintChrome(shell);
    return;
  }

  if (event.type === "tool_result") {
    applyToolResult(shell, bag, event);
    paintChrome(shell);
    return;
  }

  const row = rowFromInbound(event);
  if (row) appendStreamRow(shell, row);
  paintChrome(shell);
}

/**
 * Attach a session bridge to a shell. Operator submit/interrupt go through
 * the port; inbound events paint the transcript and drain at tool boundaries.
 */
export function attachSessionBridge(
  shell: AppShell,
  handlers?: SessionPortHandlers,
  monitor?: TurnMonitorOptions,
): SessionBridge {
  const existing = bridges.get(shell);
  if (existing) {
    existing.disposed = true;
  }

  const now = monitor?.now ?? (() => Date.now());
  const stallTimeoutMs = monitor?.stallTimeoutMs ?? STALL_TIMEOUT_MS;
  const stallNoticeMs = monitor?.stallNoticeMs ?? STALL_NOTICE_MS;

  const bag: BridgeBag = {
    port: resolvePort(handlers),
    openRow: null,
    pendingEchoes: [],
    mapCtx: createStreamMapContext(),
    disposed: false,
    turn: initialTurnState(now()),
    liveFleet: 0,
    lastSentMessage: "",
    quotaFired: false,
    now,
    toolRows: new Map(),
    toolCallStartedAt: new Map(),
    lastToolRow: -1,
    taskCallIds: new Set(),
    agentSessions: [],
    panelOnlyCallIds: new Set(),
    attemptRow: null,
    turnThinking: null,
  };
  bridges.set(shell, bag);

  const frozenTickMs = monitor?.tickMs ?? DEFAULT_TICK_MS;
  const animationTickMs = Math.min(frozenTickMs, ANIMATION_TICK_MS);

  /**
   * Current cadence, or null while the monitor is stopped. Every paint resolves
   * this, so the loop speeds up on the frame a turn starts animating and stops
   * on the frame it settles — one timer, never two.
   */
  let cadenceMs: number | null = null;
  let stopTick: (() => void) | undefined;
  const schedule = monitor?.schedule ?? defaultSchedule;

  const applyCadence = (next: number | null): void => {
    if (monitor === undefined || cadenceMs === next) return;
    stopTick?.();
    stopTick = undefined;
    cadenceMs = next;
    if (next !== null) {
      stopTick = schedule(() => {
        tick();
      }, next);
    }
  };

  /**
   * The watchdog's inputs for the current turn. Built here rather than at each
   * call site so the indicator and the abort can never be judging different
   * facts about the same turn.
   */
  const stallArgsFor = (nowMs: number) => ({
    status: bag.turn.status,
    awaitingResponse: bag.turn.awaitingResponse,
    lastActivityAt: bag.turn.lastActivityAt,
    nowMs,
    stallTimeoutMs,
    isProcessing: bag.turn.isProcessing,
    streamingType: bag.turn.streamingType,
    activeToolCalls: bag.turn.activeToolCalls,
    stallNoticeMs,
    repeating: bag.turn.repeating,
  });

  /**
   * How long the turn has been stalled, measured from the moment silence
   * crossed the notice threshold, or null when it is not stalled.
   *
   * Derived from `lastActivityAt` rather than stamped when the stall is first
   * seen, which gets two cases right for free: a session resumed with already
   * stale activity reports a stall older than the blink burst and so paints the
   * settled glyph immediately instead of alarming about an event the operator
   * was not present for, and a stall that breaks and re-arms is measured from
   * the new silence, so a second stall in a long session bursts again.
   */
  const stalledForMs = (nowMs: number, isStalled: boolean): number | null =>
    isStalled ? nowMs - bag.turn.lastActivityAt - stallNoticeMs : null;

  const paintPhaseAt = (nowMs: number, isStalled: boolean): void => {
    const turn = bag.turn;
    // The stall notice is a live diagnosis, not a sticky banner: it has to
    // set *and* clear on every paint — including handle() — because the
    // cadence timer is cancelled the moment the turn settles. If we only
    // touched it from tick(), a tool.done → inference.done burst that lands
    // before the next tick would leave the banner up forever.
    const level = stallLevel(stallArgsFor(nowMs));
    if (level === "notice") {
      setStatusFlash(shell, STALL_NOTICE_MESSAGE);
    } else if (shell.statusFlash === STALL_NOTICE_MESSAGE) {
      setStatusFlash(shell, null);
    }
    // The landing mark rides this same re-entry: it animates through the
    // draw/fill loop while a turn is live and holds its filled frame otherwise.
    paintLanding(shell, nowMs, turn.isProcessing);
    // The reveal position rides the same re-entry as the ramp and landing
    // mark: it needs to keep crawling through already-arrived text even when
    // no new delta has landed this tick.
    if (bag.openRow !== null && bag.openRow.kind === "thinking") {
      advanceOpenReveal(shell, bag.openRow, nowMs);
    }
    syncToolElapsed(shell, bag, nowMs);
    const input = {
      isProcessing: turn.isProcessing,
      status: turn.status,
      currentToolName: turn.currentToolName,
      streamingType: turn.streamingType,
    };
    const fleet = fleetProgress(bag.agentSessions, nowMs);
    const label = resolveTurnLabel(input, isStalled, fleet);
    if (label === undefined) {
      // The bottom-left status slot rides the same re-entry as the landing
      // mark, so it crossfades between phases without a timer of its own.
      setLockupFrame(shell, {
        nowMs,
        animating: turn.isProcessing,
        phase: null,
        rampPhase: null,
        stalledForMs: null,
      });
      // Nothing animates and nothing is being waited on, so the loop stops
      // rather than repainting an unchanging frame forever. The next event
      // re-enters here and re-arms it.
      applyCadence(bag.turn.quota !== null ? frozenTickMs : null);
      return;
    }
    const rampPhase = resolveRampPhase(input, isStalled, fleet);
    const stalledFor = stalledForMs(nowMs, rampPhase === "stalled");
    setLockupFrame(shell, {
      nowMs,
      animating: turn.isProcessing,
      phase: label,
      rampPhase,
      stalledForMs: stalledFor,
    });
    // A frozen ramp (blocked on a gate, or a stall past its blink burst) still
    // needs the stall and quota clocks, just not animation frames.
    applyCadence(rampAnimating(rampPhase, stalledFor) ? animationTickMs : frozenTickMs);
  };

  /**
   * The clock is read once here and threaded through everything the frame
   * draws. Reading it per-consumer let the pulse and the cadence land on
   * opposite sides of a blink boundary and disagree about the same frame.
   */
  const paintPhase = (): void => {
    const nowMs = now();
    paintPhaseAt(nowMs, isStalledForDisplay(stallArgsFor(nowMs)));
  };

  /** True when this event is what ended the turn. */
  const noteEvent = (event: { type: string; data?: unknown }): boolean => {
    const before = bag.turn;
    bag.turn = turnStateFromEvent(bag.turn, event, now());
    // A fresh rate-limit window re-arms the single auto-retry.
    if (bag.turn.quota !== null && bag.turn.quota !== before.quota) {
      bag.quotaFired = false;
    }
    paintPhase();
    return before.isProcessing && !bag.turn.isProcessing;
  };

  /**
   * A settled turn hands the session back to the operator — unless a live
   * fleet holds it busy (idle-with-fleet, see `settleRunToIdle`). A chat
   * session's terminator is `connector.reply`, which maps to no `run` event,
   * so without this the shell would stay busy — offering the stop key and
   * holding queued prompts — for the rest of the session.
   */
  const settleRun = (): void => {
    settleRunToIdle(shell, bag);
  };

  const handle = (event: BridgeInboundEvent | ReactorLikeEvent): void => {
    if (bag.disposed) return;
    const settled = noteEvent(event);
    // Reactor-shaped types always map first (avoids tool.done name collision).
    if (PRODUCTION_REACTOR_TYPES.has(event.type)) {
      if (consumePendingEchoEvent(bag, event)) return;
      for (const mapped of mapProductionEvent(event as ReactorLikeEvent, bag.mapCtx)) {
        applyInbound(shell, bag, mapped);
      }
      // inference.done with tool calls still outstanding doesn't settle the
      // turn (see turn-state.ts) — the cycle continues, but a soft-steer
      // boundary still passed. Follow-ups wait for idle.
      if (onTurnBoundary(event) && bag.turn.activeToolCalls.length > 0) {
        drainSteersAtBoundary(shell, bag);
      }
      if (settled) settleRun();
      return;
    }
    if (isBridgeInbound(event)) {
      applyInbound(shell, bag, event);
    }
    if (settled) settleRun();
  };

  const submit = (
    text: string,
    kind: "queue" | "steer" | "immediate" | "reinject",
    attachments?: readonly PendingImageAttachment[],
  ): void => {
    // A steer is a queued boundary delivery only while the parent turn is
    // actually in flight; see `parentIdleWithFleet` below for the exception.
    if (bag.disposed) return;
    const t = text.trim();
    const attached = attachments ?? [];
    if (t.length === 0 && attached.length === 0) {
      // Still run host empty handling (e.g. cancel armed /feedback).
      if (bag.port.classifySubmit?.(t, attachments) === "empty") {
        bag.port.sendImmediate(t, attachments);
      }
      return;
    }

    // Local-only submits (slash commands, multi-turn /feedback) never mark the
    // session busy and never enter the mid-run queue — they are not agent turns.
    const classification = bag.port.classifySubmit?.(t, attachments) ?? "agent";
    if (classification === "empty") {
      bag.port.sendImmediate(t, attachments);
      return;
    }
    if (classification === "local") {
      appendStreamRow(shell, {
        role: "user",
        text: userRowText(t, attached),
      });
      bag.port.sendImmediate(t, attachments);
      paintChrome(shell);
      return;
    }

    if (kind === "reinject") {
      // No product chord wires reinject anymore (CL-6290: Alt+Enter is
      // follow-up / kind "queue"). Kept for tests and any direct API callers:
      // stop the run right now, then fall into the immediate-send branch.
      if (shell.session.run !== "busy") return;
      closeOpenRow(shell, bag);
      bag.pendingEchoes.length = 0;
      shell.session = interrupt(shell.session);
      appendStreamRow(shell, {
        role: "system",
        text: "stop — restarting from your message",
        meta: "stop",
      });
      bag.port.interrupt();
      bag.lastSentMessage = "";
      bag.turn = turnStateOnInterrupt(bag.turn, now());
    }

    // Idle-with-fleet: the parent turn has settled while spawned workers are
    // still live, so the run is only nominally busy. Plain Enter is a new
    // primary turn right now — not a queued steer waiting on a parent tool
    // that no longer exists.
    const parentIdleWithFleet = kind === "steer" && bag.liveFleet > 0 && !bag.turn.isProcessing;
    if (
      kind === "immediate" ||
      kind === "reinject" ||
      shell.session.run === "idle" ||
      parentIdleWithFleet
    ) {
      appendStreamRow(shell, {
        role: "user",
        text: userRowText(t, attached),
        ...(kind === "reinject" ? { meta: "reinject" } : {}),
      });
      bag.pendingEchoes.push(t);
      bag.port.sendImmediate(t, attachments);
      shell.session = setRunState(shell.session, "busy");
      bag.lastSentMessage = t;
      bag.turn = turnStateOnSubmit(bag.turn, now());
      paintChrome(shell);
      paintPhase();
      return;
    }

    shell.session =
      kind === "steer"
        ? enqueueSteer(shell.session, t, undefined, attachments)
        : enqueue(shell.session, t, "queue", undefined, attachments);
    bag.port.enqueue(t, kind);
    // Show the message itself, not the internal transition ("queue +1 →
    // pending N") — the notice row already carries the depth once, in plain
    // language, so this row's job is making the pending item identifiable.
    appendStreamRow(shell, {
      role: "user",
      text: userRowText(t, attached),
      meta: kind === "steer" ? "steer" : "queue",
    });
    paintChrome(shell);
  };

  const doInterrupt = (): void => {
    if (bag.disposed) return;
    closeOpenRow(shell, bag);
    bag.pendingEchoes.length = 0;
    applyShellInterrupt(shell);
    bag.port.interrupt();
    // The stop settles the turn without necessarily producing an idle event to
    // drain against, so anything the operator had queued would sit there
    // forever. Hand it over here instead: the host serialises it behind the
    // agent rebuild the interrupt just started.
    drainAtBoundary(shell, bag);
    // Clearing the last prompt is what stops the quota loop from replaying a
    // turn the operator (or the watchdog) deliberately stopped.
    bag.lastSentMessage = "";
    bag.turn = turnStateOnInterrupt(bag.turn, now());
    paintPhase();
  };

  /**
   * A permission or operator gate was raised — queued or already on screen,
   * the turn does not distinguish. Called from the gate wiring itself, not
   * derived from `shell.overlayKind`, so a gate still waiting behind another
   * overlay exempts the turn from the stall watchdog just as an open one does.
   */
  const gateOpened = (): void => {
    if (bag.disposed) return;
    bag.turn = turnStateGateOpened(bag.turn);
    paintPhase();
  };

  const gateClosed = (): void => {
    if (bag.disposed) return;
    bag.turn = turnStateGateClosed(bag.turn, now());
    paintPhase();
  };

  const tick = (): void => {
    if (bag.disposed) return;
    const nowMs = now();

    const quota = bag.turn.quota;
    if (
      shouldAutoRetryQuota({
        quotaError: quota,
        alreadyFired: bag.quotaFired,
        nowMs,
        lastSentMessage: bag.lastSentMessage,
      })
    ) {
      bag.quotaFired = true;
      const replay = bag.lastSentMessage;
      bag.turn = clearQuotaWait(bag.turn);
      setStatusFlash(shell, "rate limit cleared — resubmitting", {
        ttlMs: RUNTIME_FLASH_MS,
      });
      submit(replay, "immediate");
      return;
    }

    if (quota !== null) {
      // Durable error already lives in the transcript; do not park a sticky
      // countdown flash that outlives every other confirmation.
      return;
    }

    // Content-based, not time-based: a repeating line means the model is
    // stuck regardless of how fast it is producing it, so this is checked
    // before the silence clock rather than folded into it.
    //
    // Gated on `status === "running"` because every turn-ending transition
    // (interrupt, connector.reply with no tools outstanding, reactor.done /
    // reactor.error) routes through `initialTurnState`, which clears
    // `repeating`. If a future settle path changes `isProcessing` without
    // also resetting `status` and `repeating` through that same reset, this
    // guard would no longer mean "the turn is actually live" and could fire
    // on an already-settled turn — recheck this alongside any such change.
    if (bag.turn.status === "running" && bag.turn.repeating) {
      const repeatedTokens = bag.turn.streamTokenCount - (bag.turn.repeatingSinceTokenCount ?? 0);
      applyStallRecovery(
        {
          abort: doInterrupt,
          notify: (message) => setStatusFlash(shell, message, { ttlMs: RUNTIME_FLASH_MS }),
        },
        repetitionRecoveryMessage(repeatedTokens),
      );
      return;
    }

    const stallArgs = stallArgsFor(nowMs);

    if (shouldAbortForStall(stallArgs)) {
      applyStallRecovery(
        {
          abort: doInterrupt,
          notify: (message) => setStatusFlash(shell, message, { ttlMs: RUNTIME_FLASH_MS }),
        },
        STALL_RECOVERY_MESSAGE,
      );
      return;
    }

    // Same "is this stalled at all" question `paintPhase` asks above — call
    // the one definition (`isStalledForDisplay`) rather than re-deriving it
    // from `stallLevel`'s result, so the two call sites can never disagree.
    paintPhaseAt(nowMs, isStalledForDisplay(stallArgs));
  };

  setShellBridgeHooks(shell, {
    onSubmit: (text, kind, attachments) => {
      submit(text, kind, attachments);
    },
    onInterrupt: () => {
      doInterrupt();
    },
    exclusive: true,
  });

  return {
    shell,
    handle,
    play: (events) => {
      for (const e of events) handle(e);
    },
    submit,
    interrupt: doInterrupt,
    gateOpened,
    gateClosed,
    get turn() {
      return bag.turn;
    },
    syncAgentProgress: (sessions) => {
      if (bag.disposed) return;
      bag.agentSessions = sessions;
      syncAgentProgress(shell, bag, sessions, now());
    },
    setInferenceProviderId: (id) => {
      if (bag.disposed) return;
      if (id === undefined) {
        delete bag.mapCtx.providerId;
      } else {
        bag.mapCtx.providerId = id;
      }
    },
    dispose: () => {
      bag.disposed = true;
      applyCadence(null);
      clearShellBridgeHooks(shell);
      bridges.delete(shell);
    },
  };
}

/** Sample fixture: busy run with tools, queue drain at boundary. */
export const FIXTURE_BUSY_SESSION: readonly ReactorLikeEvent[] = [
  { type: "inference.start", data: {} },
  {
    type: "message.received",
    data: { message: { content: "list project root" } },
  },
  { type: "inference.text.delta", data: { token: "I'll " } },
  { type: "inference.text.delta", data: { token: "list the directory." } },
  {
    type: "inference.tool_call.end",
    data: { name: "bash", callId: "c1", arguments: "ls -la" },
  },
  {
    type: "tool.done",
    data: {
      result: {
        callId: "c1",
        name: "bash",
        content: "AGENTS.md\nREADME.md",
        isError: false,
      },
    },
  },
  {
    type: "inference.text.delta",
    data: { token: "Done — two top-level docs." },
  },
  { type: "reactor.done", data: {} },
];
