/**
 * Bridge the shell to session events: inbound paint the transcript and
 * drain the queue; outbound hit SessionPort.
 */

import { canonicalToolName, isSameTool } from "../agent/canonical-tool-name.js";
import {
  cancelItem,
  createSessionQueue,
  drainOne,
  enqueue,
  enqueueSteer,
  interrupt,
  isPaused,
  badgeCount,
  resumeForSend,
  setRunState,
  type QueueItem,
  type QueueKind,
  type DeliverySettle,
} from "./delivery-queue.js";
import {
  appendStreamRow,
  paintChrome,
  paintLanding,
  replaceStreamRowAt,
  setLockupFrame,
  setStatusFlash,
  truncateStreamRows,
} from "./shell/chrome.js";
import {
  clearShellBridgeHooks,
  setShellBridgeHooks,
  shellInternals,
  type AppShell,
} from "./shell/internals.js";
import { applyShellInterrupt, surfaceSystemNotice } from "./shell/prompt.js";
import { streamRowAt, streamRowCount } from "./shell/transcript.js";
import { rampAnimating } from "./ramp.js";
import { onTurnBoundary } from "../agent/reactor-events.js";
import {
  resolveRampPhase,
  resolveTurnLabel,
  sendFailureText,
} from "./chrome-state.js";
import type { StallResumeResult } from "../session/approval-resume.js";
import { shouldAutoRetryQuota } from "./quota-retry.js";
import { RUNTIME_FLASH_MS } from "./runtime-notices.js";
import {
  applyStallRecovery,
  repetitionRecoveryMessage,
  isStalledForDisplay,
  shouldAbortForStall,
  stallLevel,
  STALL_APPROVAL_RESUME_MESSAGE,
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
  turnStallLayer,
  turnStateOnSubmit,
  type TurnState,
} from "./turn-state.js";
import {
  userRowText,
  type PendingImageAttachment,
} from "./image-attachments.js";
import {
  deliveryResultNotice,
  type AgentDeliveryResult,
} from "./delivery-queue.js";
import { toolCallRow } from "./diff.js";
import { toolResultRow } from "./mcp-view.js";
import {
  canCoalesceCall,
  coalesceCallRows,
  mergeToolRows,
  shellPreviewLines,
} from "./tool-rows.js";
import * as rowUpdates from "./row-update-queue.js";
import type { ShellOutputFeed } from "../session/shell-output-feed.js";
import type { StreamRow } from "./stream.js";
import {
  advanceRevealChars,
  flattenReasoningText,
  type Thought,
} from "./thinking.js";
import {
  agentProgress,
  clockLabel,
  fleetProgress,
  type AgentProgressSession,
} from "../subagent/agent-progress.js";
import {
  pendingAskWakeText,
  type PendingAskWake,
} from "../subagent/fleet-report.js";
import { isPromiseLike } from "../subagent/fleet-dry-drive.js";
import { mailboxMailDriveClaimed } from "../subagent/mailbox-mail-drive.js";

/** spawn_agent dispatch tool; its row gets live progress. */
const SPAWN_AGENT_TOOL_NAME = "spawn_agent";

/** manage_tasks calls paint no row — the task panel owns that state. */
const MANAGE_TASKS_TOOL_NAME = "manage_tasks";

/** `syncAgentProgress` input: a session identifiable by id. */
export type TaskProgressSession = AgentProgressSession & {
  readonly id: string;
};
import {
  PRODUCTION_REACTOR_TYPES,
  createStreamMapContext,
  mapProductionEvent,
  mapReactorLike,
  type BridgeInboundEvent,
  type ReactorLikeEvent,
  type StreamMapContext,
} from "./stream-event-map.js";

/** Re-export for existing `from "./runtime-bridge"` imports. */
export type { BridgeInboundEvent, ReactorLikeEvent, StreamMapContext };
export { mapReactorLike };

/** Outbound actions the UI asks the session runtime to perform. */
export interface SessionPort {
  /** Local-only lines skip the mid-run queue and the busy mark.
   * Default: agent. */
  classifySubmit?: (
    text: string,
    attachments?: readonly PendingImageAttachment[],
  ) => "agent" | "local" | "empty";
  /** Idle prompt submit — deliver now. */
  sendImmediate: (
    text: string,
    attachments?: readonly PendingImageAttachment[],
  ) => void;
  /** Mid-run queue or steer accepted by the shell. */
  enqueue: (text: string, kind: QueueKind) => void;
  /** Hard interrupt current run. */
  interrupt: () => void;
  /** Queue item drained at a tool boundary (or idle). */
  deliver: (item: QueueItem, settle?: DeliverySettle) => void;
}

export type SessionPortHandlers = Partial<SessionPort>;

/** Timer wiring for quota retry and the stall watchdog; injectable for
 * tests. */
export interface TurnMonitorOptions {
  readonly now?: () => number;
  /** Retry countdown and stall check poll; default 250 ms. */
  readonly tickMs?: number;
  readonly stallTimeoutMs?: number;
  /** Silence before the run reads as stuck. Default 90 s. */
  readonly stallNoticeMs?: number;
  /** Registers the periodic tick; returns an unsubscribe. */
  readonly schedule?: (tick: () => void, intervalMs: number) => () => void;
}

/** Outcome of a watchdog attempt to re-present a parked approval. */
export type SuspendedApprovalResume = (
  onPresenting: () => void,
) => Promise<StallResumeResult>;

const DEFAULT_TICK_MS = 250;

/** Poll period while animating; the idle cadence skips pulse steps. */
const ANIMATION_TICK_MS = 80;

function defaultSchedule(tick: () => void, intervalMs: number): () => void {
  const handle = setInterval(tick, intervalMs);
  // The monitor must never keep the process alive.
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
  /** Operator submits; shell keys reach this through exclusive hooks. */
  submit: (
    text: string,
    kind: "queue" | "steer" | "immediate" | "reinject",
    attachments?: readonly PendingImageAttachment[],
  ) => void;
  interrupt: () => void;
  /** Drop queued items, echoes, and fleet hold so a rotation cannot drain
   * into the new reactor. */
  clearQueuedDelivery: () => void;
  /** True only while draining steers at a live parent tool.boundary (or
   * inference.done with tools still outstanding); other drains send. */
  readonly parentCycleLive: boolean;
  /** A gate was raised: blocks the turn (exempt from the stall watchdog)
   * until `gateClosed`; gates nest. */
  gateOpened: () => void;
  /** A previously raised gate resolved. */
  gateClosed: () => void;
  /**
   * Registers the attempt to re-present one already persisted approval
   * suspension when the stall watchdog fires. It receives no agent, storage,
   * grant, or tool capability: a true result means the correlated approval
   * path owns the continuation, false falls back to the interrupt. It calls
   * `onPresenting` only once it is actually about to re-present the approval.
   */
  setSuspendedApprovalRecovery: (
    recovery: SuspendedApprovalResume | undefined,
  ) => void;
  dispose: () => void;
  /** Current derived turn phase (progress label, stall clock, quota window). */
  readonly turn: TurnState;
  readonly shell: AppShell;
  /** Refresh `spawn_agent` rows with live progress for the worker lifetime. */
  syncAgentProgress: (sessions: readonly TaskProgressSession[]) => void;
  /** Paint each in-flight `run_shell`'s live tail from its bounded feed,
   * frame-coalesced. */
  syncShellOutputs: (
    feedFor: ((callId: string) => ShellOutputFeed | undefined) | undefined,
  ) => void;
  /** Stamp the provider id into the stream map context so `inference.error`
   * can identify xAI 429s. */
  setInferenceProviderId: (
    id: string | undefined,
    displayLabel?: string,
  ) => void;
  /** Mark the run busy for a system-originated continuation (fleet-dry open
   * task drive); no echo, no send — the caller sends. */
  beginSystemContinuation: (text: string) => void;
  /** Continuation send failed: drop the hold and idle so follow-ups drain.
   * `rearmDry:false` for mailbox mail. */
  abortSystemContinuation: (opts?: { rearmDry?: boolean }) => void;
  /** Occupancy owner for a dry+open continuation; one shot per dry episode,
   * only when it sends. */
  setDryOpenTaskDriver: (
    driver: (() => boolean | Promise<boolean>) | undefined,
  ) => void;
  /** Mailbox-mail occupancy owner, from idle-with-fleet settle and the
   * store-subscribe driver. */
  setMailboxMailDriver: (driver: (() => boolean) | undefined) => void;
  /** After flushPendingAskWake sends the wake: stamp the fleet mailbox so
   * list_agents fails closed until send_input. */
  setOnAskWakeSent: (
    handler: ((asks: readonly PendingAskWake[]) => void) | undefined,
  ) => void;
  /** Wake the session/mailbox when a steer queues, so occupancy delivers at
   * the next tool.boundary. */
  setWaitYieldWake: (wake: (() => void) | undefined) => void;
  /** Occupancy flush for mailbox mail; no-op while the parent is processing. */
  flushMailboxMail: () => void;
  /**
   * Stall bound for a silent ask-wake primary turn; contract in
   * `abortStalledWakeTurn` below. True when aborted.
   */
  abortStalledWakeTurn: () => boolean;
  /**
   * Ask-deadline bound for a silent ask-wake primary turn; contract in
   * `abortExpiredWakeTurn` below. True when aborted.
   */
  abortExpiredWakeTurn: (expiredThisTick: boolean) => boolean;
  /** Phase-transition stamps, newest last. Diagnostic-only. */
  turnMarkers: () => readonly TurnMarker[];
}

const NOOP_PORT: SessionPort = {
  sendImmediate: () => undefined,
  enqueue: () => undefined,
  interrupt: () => undefined,
  deliver: () => undefined,
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
    ...(opts?.classifySubmit !== undefined
      ? { classifySubmit: opts.classifySubmit }
      : {}),
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
    case "agent-ask":
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
      return {
        role: "system",
        text: sendFailureText(event.message),
        meta: "error",
      };
    default:
      return null;
  }
}

/** Streaming row kinds the bridge grows in place. */
type OpenRowKind = "assistant" | "thinking";

/** The transcript row deltas are currently appended to. */
interface OpenStreamRow {
  readonly kind: OpenRowKind;
  readonly index: number;
  /** Clock the row opened at, so settled reasoning reports its duration. */
  readonly startedAt: number;
  text: string;
  /** Bounded-rate reveal for a "thinking" row's wrapped preview; unused for
   * "assistant" rows. */
  revealChars: number;
  /** Clock `revealChars` was last advanced from. */
  revealAt: number;
  /** Reasoning time elapsed before this row opened, so a folded row reports
   * it. */
  readonly elapsedBefore: number;
  /** Reopened row: the turn thought here before; it grows in place above the
   * tool rows. */
  readonly folded: boolean;
}

/** The one reasoning row a turn owns after it has thought. */
interface TurnThinking {
  readonly index: number;
  readonly text: string;
  readonly ms: number;
}

/** Blank line between the fragments a turn thought at different moments. */
const THINKING_FRAGMENT_SEPARATOR = "\n\n";

/** A turn-phase transition stamp: `infer-start`, `first-token`, `settle`,
 * `stall-abort:<layer>`, or `expire-abort`. */
export interface TurnMarker {
  readonly path: string;
}

const MAX_TURN_MARKERS = 50;

function recordTurnMarker(bag: BridgeBag, path: string): void {
  bag.turnMarkers.push({ path });
  if (bag.turnMarkers.length > MAX_TURN_MARKERS) {
    bag.turnMarkers.splice(0, bag.turnMarkers.length - MAX_TURN_MARKERS);
  }
}

export interface BridgeBag {
  port: SessionPort;
  openRow: OpenStreamRow | null;
  /** Prompts already echoed locally; else `message.received` replay shows
   * each twice. */
  pendingEchoes: string[];
  /** Popped for delivery but unsettled: a second boundary cannot redispatch
   * them; rejection can restore. */
  pendingDeliveries: Map<string, QueueItem>;
  /** Failed deliveries waiting for an empty composer; FIFO, cleared on
   * submit. */
  pendingPromptRecoveries: QueueItem[];
  /** callId→name / delta bookkeeping for production-shaped events. */
  mapCtx: StreamMapContext;
  disposed: boolean;
  suspendedApprovalRecovery: SuspendedApprovalResume | undefined;
  turn: TurnState;
  /** Live fleet-lane count; above zero, a settled parent turn holds the run
   * busy. */
  liveFleet: number;
  /** Worker asks parked in ask_director until the parent can act;
   * session-keyed to stop duplicates. */
  pendingAskWake: Map<string, PendingAskWake>;
  deliveredAskWake: Map<string, string>;
  /** Ask-wake stall bound: armed when a wake send starts a primary turn,
   * disarmed on settle/interrupt/queue clear. */
  askWakeTurnArmed: boolean;
  /** Per-session abort count; the next flush restates bumped questions
   * (`Re-surface N`). Pruned with `deliveredAskWake`. */
  askWakeResurface: Map<string, number>;
  /** Phase-transition stamps, newest last, capped. See `TurnMarker`. */
  turnMarkers: TurnMarker[];
  /** Set inside `attachSessionBridge` so `settleRunToIdle` and `gateClosed`
   * can re-enter through it. */
  flushPendingAskWake: (() => void) | null;
  /** Per-item mailbox mail flush; set inside `attachSessionBridge` so settle
   * and fleet share one gate. */
  flushMailboxMail: (() => void) | null;
  /** Mail first, ask-wake only if occupancy missed; shared by abort, gate
   * close, and idle settles. */
  flushOccupancyThenWake: (() => void) | null;
  /** One occupancy shot per dry episode, reset on a live lane; consumed only
   * when the driver sends. */
  droveOpenTasksThisDry: boolean;
  /** A late connector.reply must not settle the re-armed continuation turn
   * until its own inference.start arrives. */
  awaitingContinuationInference: boolean;
  /** Occupancy driver: collect+send when settle takes a dry-episode shot. */
  dryOpenTaskDriver: (() => boolean | Promise<boolean>) | undefined;
  /** Occupancy driver for per-item mailbox mail (worker terminal/fail) while
   * the parent is idle. */
  mailboxMailDriver: (() => boolean) | undefined;
  /** After a pending ask wake is sent. Independent of deliveredAskWake. */
  onAskWakeSent: ((asks: readonly PendingAskWake[]) => void) | undefined;
  /** Wake the session/mailbox when a steer queues, so occupancy can deliver. */
  waitYieldWake: (() => void) | undefined;
  /** Last prompt actually sent — replay source for the quota auto-retry. */
  lastSentMessage: string;
  lastSentOrigin: "composer" | "internal" | null;
  /** One auto-retry per rate-limit window. */
  quotaFired: boolean;
  now: () => number;
  /** Transcript row each in-flight call occupies, so its result resolves it. */
  toolRows: Map<string, number>;
  /** When each in-flight ordinary tool call started, so its row carries a
   * live clock. */
  toolCallStartedAt: Map<string, number>;
  /** Calls waiting on a decision gate; `gateClosed` re-syncs clocks to
   * time-since-grant. Results/rollbacks drop ids so the set cannot leak. */
  gatedToolCalls: Set<string>;
/** Calls the reactor reported with `tool.start`, until their `tool.done`. */
  executingToolCalls: Set<string>;
  /**
   * Calls that had not started executing when an approval gate blocked. See
   * `closeParkedCalls` for how they end.
   */
  parkedToolCalls: Set<string>;
  /** Last painted shell tail per in-flight call; unchanged snapshots apply
   * no update. */
  shellSnapshots: Map<string, string>;
  /** Row of the newest in-flight call, for results that carry no call id. */
  lastToolRow: number;
  /** `spawn_agent` callIds tracked for the worker lifetime, beyond
   * `toolRows`: progress outlives the running result. */
  taskCallIds: Set<string>;
  /** Row index for each tracked spawn_agent call, kept after tool_result. */
  spawnProgressRows: Map<string, number>;
  /** Last session list the host synced; the ticker recomputes fleet state
   * from it at paint. */
  agentSessions: readonly TaskProgressSession[];
  /** callIds whose call painted no row (`manage_tasks` panel work); tracked
   * so the matching result is dropped. */
  panelOnlyCallIds: Set<string>;
  /** Attempt start row, or null. The mapper decides mark/clear/rollback; the
   * index is the bridge's. */
  attemptRow: number | null;
  /** The turn's reasoning row, or null before it thinks; thinking folds in —
   * one row per turn. */
  turnThinking: TurnThinking | null;
  /** Set only while draining steers at a live parent tool.boundary; last-hop
   * routing reads it on deliver. */
  liveSteerInject: boolean;
  /** Open row has deltas since its last paint; retext once per frame or at
   * the next close/settle seam. */
  dirtyOpenRow: boolean;
  /** Tool-row repaints waiting for the frame flush (row-update-queue.ts). */
  pendingRowUpdates: rowUpdates.PendingRowUpdates;
}

const bridges = new WeakMap<AppShell, BridgeBag>();

function resolvePort(handlers?: SessionPortHandlers): SessionPort {
  return {
    ...(handlers?.classifySubmit !== undefined
      ? { classifySubmit: handlers.classifySubmit }
      : {}),
    sendImmediate: handlers?.sendImmediate ?? NOOP_PORT.sendImmediate,
    enqueue: handlers?.enqueue ?? NOOP_PORT.enqueue,
    interrupt: handlers?.interrupt ?? NOOP_PORT.interrupt,
    deliver: handlers?.deliver ?? NOOP_PORT.deliver,
  };
}

/** Prompt text minus the attachment note, so echoes match between the local
 * echo and `message.received`. */
function promptContent(text: string): string {
  const note = text.search(/\n\[\d+ images? attached:/);
  return (note === -1 ? text : text.slice(0, note)).trim();
}

/** True when this inbound user message was already painted locally. */
function consumeEcho(bag: BridgeBag, text: string): boolean {
  const index = bag.pendingEchoes.indexOf(promptContent(text));
  if (index === -1) return false;
  bag.pendingEchoes.splice(index, 1);
  return true;
}

function removeOnePendingEcho(bag: BridgeBag, text: string): void {
  const index = bag.pendingEchoes.indexOf(promptContent(text));
  if (index === -1) return;
  bag.pendingEchoes.splice(index, 1);
}

function composerIsEmpty(shell: AppShell): boolean {
  return (
    shell.prompt.value.trim().length === 0 &&
    shell.pendingAttachments.length === 0
  );
}

function restoreQueueItemToPrompt(shell: AppShell, item: QueueItem): void {
  shell.prompt.value = item.text;
  shell.pendingAttachments = [...(item.attachments ?? [])];
  paintChrome(shell);
}

function markDeliveryRows(
  shell: AppShell,
  queueItemId: string,
  deliveryStatus: "not-delivered" | "uncertain",
): void {
  for (let local = shell.streamLog.length - 1; local >= 0; local--) {
    const row = shell.streamLog[local];
    if (row?.queueItemId !== queueItemId) continue;
    const absolute = shell.streamLogBase + local;
    const knownNotDelivered = deliveryStatus === "not-delivered";
    replaceStreamRowAt(shell, absolute, {
      ...row,
      meta: knownNotDelivered ? "not-delivered" : "delivery-uncertain",
      deliveryStatus,
    });
  }
}

function settleDrainedDelivery(
  shell: AppShell,
  bag: BridgeBag,
  item: QueueItem,
  result: AgentDeliveryResult,
): void {
  if (bag.disposed) return;
  if (!bag.pendingDeliveries.has(item.id)) return;
  bag.pendingDeliveries.delete(item.id);
  if (result.status === "accepted") return;

  removeOnePendingEcho(bag, item.text);
  markDeliveryRows(
    shell,
    item.id,
    result.status === "uncertain" ? "uncertain" : "not-delivered",
  );

  let disposition: "restored" | "deferred" = "restored";
  if (composerIsEmpty(shell)) {
    restoreQueueItemToPrompt(shell, item);
  } else {
    bag.pendingPromptRecoveries.push(item);
    disposition = "deferred";
  }
  surfaceSystemNotice(shell, deliveryResultNotice(result, disposition));
  paintChrome(shell);
}

/** Deliver one queued item: paint an operator row with its queueItemId so
 * settle can mark it; the echo ledger stops replays. */
function deliverQueuedItem(
  shell: AppShell,
  bag: BridgeBag,
  item: QueueItem,
): void {
  bag.pendingDeliveries.set(item.id, item);
  appendStreamRow(shell, {
    role: "user",
    text: userRowText(item.text, item.attachments ?? []),
    queueItemId: item.id,
  });
  bag.pendingEchoes.push(item.text.trim());
  bag.port.deliver(item, (result) => {
    settleDrainedDelivery(shell, bag, item, result);
  });
}

function restoreNextPromptRecovery(shell: AppShell, bag: BridgeBag): void {
  if (bag.disposed) return;
  if (!composerIsEmpty(shell)) return;
  const next = bag.pendingPromptRecoveries.shift();
  if (next === undefined) return;
  restoreQueueItemToPrompt(shell, next);
}

function messageReceivedContent(event: {
  readonly data?: unknown;
}): string | undefined {
  const data = event.data;
  if (data === null || typeof data !== "object" || Array.isArray(data))
    return undefined;
  const message = (data as { readonly message?: unknown }).message;
  if (message === null || typeof message !== "object" || Array.isArray(message))
    return undefined;
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

/** Total reasoning an open thinking row stands for, earlier fragments too. */
function thoughtOf(bag: BridgeBag, open: OpenStreamRow): Thought {
  return { ms: open.elapsedBefore + Math.max(0, bag.now() - open.startedAt) };
}

/** Repaint a folded reasoning row: settled in shape, still growing in text. */
function paintFoldedRow(
  shell: AppShell,
  bag: BridgeBag,
  open: OpenStreamRow,
): void {
  replaceStreamRowAt(
    shell,
    open.index,
    openRowContent(open.kind, open.text, false, thoughtOf(bag, open)),
  );
}

/** Finalize the open streaming row: it stops growing and becomes stable. */
function closeOpenRow(shell: AppShell, bag: BridgeBag): void {
  const open = bag.openRow;
  if (open === null) return;
  bag.openRow = null;
  bag.dirtyOpenRow = false;
  // Thinking stops scrolling; the full thought stays on the row, behind the
  // expand key.
  const thought = open.kind === "thinking" ? thoughtOf(bag, open) : undefined;
  if (thought !== undefined) {
    bag.turnThinking = { index: open.index, text: open.text, ms: thought.ms };
  }
  replaceStreamRowAt(
    shell,
    open.index,
    openRowContent(open.kind, open.text, false, thought),
  );
}

/** Grow the open row of this kind, or start one. Deltas repaint one row,
 * never append. */
function growOpenRow(
  shell: AppShell,
  bag: BridgeBag,
  kind: OpenRowKind,
  text: string,
): void {
  const open = bag.openRow;
  if (open !== null && open.kind === kind) {
    open.text += text;
    // One repaint per renderer frame, not one per token (see flushOpenRow).
    bag.dirtyOpenRow = true;
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
    openRowContent(
      kind,
      text,
      true,
      undefined,
      kind === "thinking" ? 0 : undefined,
    ),
  );
}

/** Advance a "thinking" row's reveal at the bounded rate, repainting if it
 * moved; frame flush and animation tick call it. */
function advanceOpenReveal(
  shell: AppShell,
  bag: BridgeBag,
  open: OpenStreamRow,
  nowMs: number,
): void {
  // Folded rows sit settled above the tool rows; nothing to advance.
  if (open.folded) return;
  const available = flattenReasoningText(open.text).length;
  const revealed = advanceRevealChars(
    open.revealChars,
    available,
    nowMs - open.revealAt,
  );
  open.revealAt = nowMs;
  if (revealed === open.revealChars) return;
  open.revealChars = revealed;
  bag.dirtyOpenRow = false;
  replaceStreamRowAt(
    shell,
    open.index,
    openRowContent(open.kind, open.text, true, undefined, revealed),
  );
}

/** Apply the coalesced open-row paint once per frame or at the next
 * close/settle seam. */
function flushOpenRow(shell: AppShell, bag: BridgeBag): void {
  const open = bag.openRow;
  if (open === null || !bag.dirtyOpenRow) return;
  if (open.folded) {
    bag.dirtyOpenRow = false;
    paintFoldedRow(shell, bag, open);
    return;
  }
  if (open.kind === "thinking") {
    // Repaint only when the reveal moved; a no-op stays dirty until
    // closeOpenRow applies the tail.
    advanceOpenReveal(shell, bag, open, bag.now());
    return;
  }
  bag.dirtyOpenRow = false;
  replaceStreamRowAt(
    shell,
    open.index,
    openRowContent(open.kind, open.text, true),
  );
}

/** Flush the shell's dirty rows (open row + coalesced tool-row repaints)
 * once per frame. */
export function flushStreamRowUpdates(shell: AppShell): void {
  const bag = bridges.get(shell);
  if (bag === undefined || bag.disposed) return;
  flushOpenRow(shell, bag);
  rowUpdates.applyPendingRowUpdates(shell, bag);
}

/** Paint a tool call; a consecutive call to the same raw toolName folds
 * onto the prior row. */
function applyToolCall(
  shell: AppShell,
  bag: BridgeBag,
  raw: Extract<BridgeInboundEvent, { type: "tool_call" }>,
): void {
  const event = { ...raw, name: canonicalToolName(raw.name) };
  if (isSameTool(raw.name, MANAGE_TASKS_TOOL_NAME)) {
    // Remembered so the matching result drops; the checklist lives on the
    // task panel.
    if (event.callId !== undefined) bag.panelOnlyCallIds.add(event.callId);
    return;
  }
  const row = toolCallRow({
    name: event.name,
    ...(event.detail !== undefined ? { arguments: event.detail } : {}),
    ...(event.callId !== undefined ? { callId: event.callId } : {}),
  });
  const count = streamRowCount(shell);
  const tail = streamRowAt(shell, count - 1);
  const index = canCoalesceCall(tail, row) ? count - 1 : count;
  if (tail !== undefined && index < count) {
    // Frame-coalesced: repeat calls fold onto the pending snapshot.
    const effective = bag.pendingRowUpdates.get(index) ?? tail;
    rowUpdates.scheduleRowUpdate(bag, index, coalesceCallRows(effective, row));
  } else {
    appendStreamRow(shell, row);
  }
  if (event.callId !== undefined) {
    bag.toolRows.set(event.callId, index);
    // Diff rows carry a "+n/-n" stat, not a live clock — only ordinary
    // calls get the timer.
    if (row.stat === undefined) {
      bag.toolCallStartedAt.set(event.callId, bag.now());
      // The wait belongs to the gate; the settle re-syncs this clock.
      if (bag.turn.blockedGateCount > 0) bag.gatedToolCalls.add(event.callId);
    }
  }
  if (
    event.callId !== undefined &&
    isSameTool(raw.name, SPAWN_AGENT_TOOL_NAME)
  ) {
    bag.taskCallIds.add(event.callId);
    bag.spawnProgressRows.set(event.callId, index);
  }
  bag.lastToolRow = index;
  shell.inFlightTool = { name: event.name, startedAt: bag.now() };
}

/** Fold a tool result into the row its call opened; call-less results get
 * their own row. */
function applyToolResult(
  shell: AppShell,
  bag: BridgeBag,
  raw: Extract<BridgeInboundEvent, { type: "tool_result" }>,
): void {
  const event = { ...raw, name: canonicalToolName(raw.name) };
  if (event.callId !== undefined && bag.panelOnlyCallIds.delete(event.callId))
    return;
  const result = toolResultRow({
    name: event.name,
    content: event.detail ?? (event.isError ? "error" : "ok"),
    isError: event.isError === true,
  });
  const tracked =
    event.callId !== undefined ? bag.toolRows.get(event.callId) : undefined;
  // The elapsed clock was wait scaffolding, not a fact about the call —
  // clear it before the merge.
  const clockOwned =
    event.callId !== undefined && bag.toolCallStartedAt.has(event.callId);
  if (event.callId !== undefined) {
    bag.toolRows.delete(event.callId);
    bag.toolCallStartedAt.delete(event.callId);
    bag.gatedToolCalls.delete(event.callId);
    bag.shellSnapshots.delete(event.callId);
    // spawn_agent's running JSON is not the worker's end — keep the row
    // until the session stops running.
    if (!isSameTool(raw.name, SPAWN_AGENT_TOOL_NAME)) {
      bag.taskCallIds.delete(event.callId);
      bag.spawnProgressRows.delete(event.callId);
    }
  }
  if (bag.toolRows.size === 0) shell.inFlightTool = null;
  // An unknown id gets its own row (never misattribute); only id-less
  // history results use the newest-row fallback.
  if (tracked === undefined && event.callId !== undefined) {
    appendStreamRow(shell, result);
    return;
  }
  const index = tracked ?? bag.lastToolRow;
  // A close seam: apply any coalesced update first so the merge reads it.
  const rawCall =
    rowUpdates.takePendingRowUpdate(bag, index) ?? streamRowAt(shell, index);
  const call =
    clockOwned && rawCall !== undefined ? omitStat(rawCall) : rawCall;
  if (call === undefined || call.pending !== true) {
    appendStreamRow(shell, result);
    return;
  }
  replaceStreamRowAt(shell, index, mergeToolRows(call, result));
}

/** Refresh every tracked `spawn_agent` row with the worker's live progress,
 * frame-coalesced. */
function syncAgentProgress(
  shell: AppShell,
  bag: BridgeBag,
  sessions: readonly TaskProgressSession[],
  nowMs: number,
): void {
  if (bag.taskCallIds.size === 0) return;
  for (const callId of bag.taskCallIds) {
    const index = bag.spawnProgressRows.get(callId) ?? bag.toolRows.get(callId);
    if (index === undefined) {
      bag.taskCallIds.delete(callId);
      bag.spawnProgressRows.delete(callId);
      continue;
    }
    const row = streamRowAt(shell, index);
    if (row === undefined) {
      bag.taskCallIds.delete(callId);
      bag.spawnProgressRows.delete(callId);
      continue;
    }
    const session = sessions.find((s) => s.id === callId);
    if (session === undefined) continue;
    const progress = agentProgress(session, nowMs);
    if (progress === null) {
      bag.taskCallIds.delete(callId);
      bag.spawnProgressRows.delete(callId);
      continue;
    }
    const current = bag.pendingRowUpdates.get(index) ?? row;
    if (
      current.stat === progress.stat &&
      current.agentWorking === progress.working
    )
      continue;
    rowUpdates.scheduleRowUpdate(bag, index, {
      ...current,
      stat: progress.stat,
      agentWorking: progress.working,
    });
  }
}

/** Drop `stat` rather than set it `undefined` (exactOptionalPropertyTypes). */
function omitStat(row: StreamRow): StreamRow {
  const { stat: _stat, ...rest } = row;
  return rest;
}

/** Paint each running `run_shell`'s live tail onto its pending row,
 * frame-coalesced; unwired feeds and unchanged snapshots do nothing. */
function syncShellOutputs(
  shell: AppShell,
  bag: BridgeBag,
  feedFor: ((callId: string) => ShellOutputFeed | undefined) | undefined,
): void {
  if (bag.disposed || feedFor === undefined || bag.toolRows.size === 0) return;
  for (const [callId, index] of bag.toolRows) {
    const row = bag.pendingRowUpdates.get(index) ?? streamRowAt(shell, index);
    if (row === undefined || row.pending !== true) continue;
    if (row.toolName !== "run_shell") continue;
    const feed = feedFor(callId);
    if (feed === undefined) continue;
    const preview = shellPreviewLines(feed.snapshot()) ?? [];
    const key = preview.join("\n");
    if (bag.shellSnapshots.get(callId) === key) continue;
    bag.shellSnapshots.set(callId, key);
    // In-flight shells share a lane; an empty sibling snapshot must not
    // clear a tail another member painted.
    if (
      preview.length === 0 &&
      row.previewLines !== undefined &&
      row.previewLines.length > 0
    ) {
      continue;
    }
    rowUpdates.scheduleRowUpdate(bag, index, { ...row, previewLines: preview });
  }
}

/** Refresh each plain in-flight call's row with elapsed time,
 * frame-coalesced. `syncAgentProgress` handles `spawn_agent` rows; a hidden
 * gate freezes the clock until visible. */
function syncToolElapsed(shell: AppShell, bag: BridgeBag, nowMs: number): void {
  if (bag.toolCallStartedAt.size === 0) return;
  const gateOnScreen =
    shell.overlayList !== null &&
    shellInternals(shell)?.primaryBindings.isGate === true;
  const gateHidden = bag.turn.blockedGateCount > 0 && !gateOnScreen;
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
    if (gateHidden) continue;
    const current = bag.pendingRowUpdates.get(index) ?? row;
    const stat = clockLabel(nowMs - startedAt);
    if (current.stat === stat) continue;
    rowUpdates.scheduleRowUpdate(bag, index, { ...current, stat });
  }
}

/** Re-sync each gate-waited call's clock to the grant: ticks read
 * time-since-grant, not announcement. Nested gates rebase per settle. */
function rebaseGatedElapsed(
  shell: AppShell,
  bag: BridgeBag,
  nowMs: number,
): void {
  if (bag.gatedToolCalls.size === 0) return;
  const grant = clockLabel(0);
  for (const callId of bag.gatedToolCalls) {
    bag.gatedToolCalls.delete(callId);
    // The session clock owns spawn_agent rows; diff rows never enter the
    // gated set.
    if (bag.taskCallIds.has(callId)) continue;
    if (!bag.toolCallStartedAt.has(callId)) continue;
    bag.toolCallStartedAt.set(callId, nowMs);
    const index = bag.toolRows.get(callId);
    if (index === undefined) continue;
    const row = bag.pendingRowUpdates.get(index) ?? streamRowAt(shell, index);
    if (row === undefined || row.pending !== true) continue;
    if (row.stat === grant) continue;
    rowUpdates.scheduleRowUpdate(bag, index, { ...row, stat: grant });
  }
}

/** `clockLabel` trailer already painted on an in-flight ordinary-tool row. */
function hasPaintedElapsedClock(
  shell: AppShell,
  bag: BridgeBag,
  callId: string,
): boolean {
  const index = bag.toolRows.get(callId);
  if (index === undefined) return false;
  const row = bag.pendingRowUpdates.get(index) ?? streamRowAt(shell, index);
  const stat = row?.stat;
  return typeof stat === "string" && /^\d+:\d{2}$/.test(stat);
}

/** User rows the shell painted ahead of the runtime — reinjects and
 * boundary-delivered rows (carry queueItemId). Queued/steered items stay
 * off the log while pending. */
function isLocallyQueuedUserRow(row: StreamRow): boolean {
  return (
    row.role === "user" &&
    (row.meta === "reinject" || row.queueItemId !== undefined)
  );
}

/** Retract what the failed attempt painted, then drop the row bookkeeping
 * that pointed into it. */
function rollbackAttempt(shell: AppShell, bag: BridgeBag): void {
  const boundary = bag.attemptRow;
  bag.attemptRow = null;
  if (boundary === null || boundary >= streamRowCount(shell)) return;
  const localRows = Array.from(
    { length: streamRowCount(shell) - boundary },
    (_, i) => streamRowAt(shell, boundary + i),
  ).filter(
    (row): row is StreamRow => row !== undefined && isLocallyQueuedUserRow(row),
  );
  truncateStreamRows(shell, boundary);
  rowUpdates.dropPendingRowUpdatesFrom(bag, boundary);
  for (const row of localRows) appendStreamRow(shell, row);
  for (const [callId, index] of [...bag.toolRows]) {
    if (index >= boundary) {
      bag.toolRows.delete(callId);
      bag.toolCallStartedAt.delete(callId);
      bag.gatedToolCalls.delete(callId);
      bag.taskCallIds.delete(callId);
      bag.spawnProgressRows.delete(callId);
      bag.shellSnapshots.delete(callId);
    }
  }
  if (bag.lastToolRow >= boundary) bag.lastToolRow = -1;
  if (bag.turnThinking !== null && bag.turnThinking.index >= boundary) {
    bag.turnThinking = null;
  }
  paintChrome(shell);
}

function drainAtBoundary(shell: AppShell, bag: BridgeBag): void {
  // Pause gate (CL-10149): while the operator holds the queue, no boundary may
  // auto-drain into a rebuilt agent. Return early keeping every item pending;
  // an explicit new send clears the flag and the next boundary delivers.
  if (isPaused(shell.session)) return;
  for (;;) {
    const { state, item } = drainOne(shell.session);
    if (!item) break;
    shell.session = state;
    deliverQueuedItem(shell, bag, item);
  }
  paintChrome(shell);
}

/** Soft steer only: tool.boundary drains steers; follow-ups wait for
 * idle/interrupt. */
function drainSteersAtBoundary(shell: AppShell, bag: BridgeBag): void {
  // Pause gate (CL-10149): soft steers are also held while paused; the parent
  // that accepted them has stopped, so they must wait for an explicit new send
  // rather than auto-start on the rebuilt agent.
  if (isPaused(shell.session)) return;
  for (;;) {
    const { state, item } = drainOne(shell.session, "steer");
    if (!item) break;
    shell.session = state;
    deliverQueuedItem(shell, bag, item);
  }
  paintChrome(shell);
}

/** Live parent-cycle inject: routeQueuedDelivery reads parentCycleLive
 * during this drain; other drains send. */
function drainLiveSteersAtBoundary(shell: AppShell, bag: BridgeBag): void {
  bag.liveSteerInject = true;
  try {
    drainSteersAtBoundary(shell, bag);
  } finally {
    bag.liveSteerInject = false;
  }
}

function occupancyHold(bag: BridgeBag): boolean {
  return bag.liveFleet > 0 || bag.awaitingContinuationInference;
}

function releaseRunToIdle(shell: AppShell, bag: BridgeBag): void {
  shell.session = setRunState(shell.session, "idle");
  bag.awaitingContinuationInference = false;
  drainAtBoundary(shell, bag);
  bag.flushOccupancyThenWake?.();
}

/** Release to idle and drain only at session-idle: a live fleet holds busy
 * until its zero event re-enters; a dry fleet takes one occupancy shot per
 * episode. */
/** Row text for a parked call answered without running. Names no cause. */
export const PARKED_CALL_NOT_RUN = "not run: no approval was granted";

function recordOf(data: unknown): Record<string, unknown> | undefined {
  return data !== null && typeof data === "object"
    ? (data as Record<string, unknown>)
    : undefined;
}

function startedCallId(data: unknown): string | undefined {
  const call = recordOf(recordOf(data)?.call);
  const id = call?.id ?? call?.callId;
  return typeof id === "string" ? id : undefined;
}

function doneCallId(data: unknown): string | undefined {
  const id = recordOf(recordOf(data)?.result)?.callId;
  return typeof id === "string" ? id : undefined;
}

function isApprovalGate(data: unknown): boolean {
  return recordOf(data)?.reason === "approval";
}

function settleRunToIdle(shell: AppShell, bag: BridgeBag): void {
  if (shell.session.run !== "busy") return;
  // The turn is settling: flush the open row before the settle paints.
  flushOpenRow(shell, bag);
  bag.turnThinking = null;
  shell.inFlightTool = null;
  if (bag.liveFleet > 0) {
    // Hold: fleet live, run stays busy. Steers send now (each starts its
    // own turn); follow-ups wait.
    drainSteersAtBoundary(shell, bag);
    bag.flushOccupancyThenWake?.();
    return;
  }
  if (!bag.droveOpenTasksThisDry) {
    let driven: boolean | Promise<boolean> = false;
    try {
      driven = bag.dryOpenTaskDriver?.() ?? false;
    } catch {
      driven = false;
    }
    if (isPromiseLike(driven)) {
      bag.droveOpenTasksThisDry = true;
      const abortPendingDrive = (): void => {
        if (bag.disposed) return;
        bag.droveOpenTasksThisDry = false;
        if (shell.session.run !== "busy") return;
        bag.lastSentMessage = "";
        flushOpenRow(shell, bag);
        bag.turnThinking = null;
        shell.inFlightTool = null;
        bag.turn = turnStateOnInterrupt(bag.turn, bag.now());
        releaseRunToIdle(shell, bag);
      };
      void driven.then((ok) => {
        if (ok === true) return;
        abortPendingDrive();
      }, abortPendingDrive);
      return;
    }
    // Consume only on a real continuation; a false/no-op leaves the latch
    // open for a later settle.
    if (driven === true) {
      bag.droveOpenTasksThisDry = true;
      return;
    }
  }
  releaseRunToIdle(shell, bag);
}

function applyInbound(
  shell: AppShell,
  bag: BridgeBag,
  event: BridgeInboundEvent,
): void {
  if (bag.disposed) return;

  // Handle fleet/ask events before the open-row machinery: a lane ending
  // mid-stream must not close the row the parent still grows.
  if (event.type === "fleet" || event.type === "agent-ask") {
    // A zero transition at parent-idle is true session-idle: drain
    // follow-ups now; while the parent works, update the count.
    if (event.type === "fleet") {
      bag.liveFleet = event.running;
      if (event.running > 0) {
        bag.droveOpenTasksThisDry = false;
      }
      if (event.running === 0 && !bag.turn.isProcessing) {
        settleRunToIdle(shell, bag);
      } else if (event.running > 0 && !bag.turn.isProcessing) {
        bag.flushMailboxMail?.();
      }
      paintChrome(shell);
      return;
    }
    bag.pendingAskWake = new Map(event.asks.map((ask) => [ask.sessionId, ask]));
    for (const [sessionId, questionId] of bag.deliveredAskWake) {
      if (bag.pendingAskWake.get(sessionId)?.questionId !== questionId) {
        bag.deliveredAskWake.delete(sessionId);
        bag.askWakeResurface.delete(sessionId);
      }
    }
    // Occupancy first on the idle-parent subscribe path; an open gate defers
    // both flushes to gateClosed. A still-armed silent turn stays armed
    // until the poll aborts it.
    if (bag.turn.blockedGateCount === 0) bag.flushOccupancyThenWake?.();
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

  // A new turn gets a new reasoning row; thinking folds back only within
  // one turn.
  if (event.type === "user" || event.type === "system") bag.turnThinking = null;

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
    drainLiveSteersAtBoundary(shell, bag);
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

/** Attach a session bridge to a shell: submit/interrupt go through the
 * port; inbound events paint and drain at tool boundaries. */
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
    pendingDeliveries: new Map(),
    pendingPromptRecoveries: [],
    mapCtx: createStreamMapContext(),
    disposed: false,
    suspendedApprovalRecovery: undefined,
    turn: initialTurnState(now()),
    liveFleet: 0,
    pendingAskWake: new Map(),
    deliveredAskWake: new Map(),
    askWakeTurnArmed: false,
    askWakeResurface: new Map(),
    turnMarkers: [],
    flushPendingAskWake: null,
    flushMailboxMail: null,
    flushOccupancyThenWake: null,
    droveOpenTasksThisDry: false,
    awaitingContinuationInference: false,
    dryOpenTaskDriver: undefined,
    mailboxMailDriver: undefined,
    onAskWakeSent: undefined,
    waitYieldWake: undefined,
    lastSentMessage: "",
    lastSentOrigin: null,
    quotaFired: false,
    now,
    toolRows: new Map(),
    toolCallStartedAt: new Map(),
    gatedToolCalls: new Set(),
    executingToolCalls: new Set(),
    parkedToolCalls: new Set(),
    shellSnapshots: new Map(),
    lastToolRow: -1,
    taskCallIds: new Set(),
    spawnProgressRows: new Map(),
    agentSessions: [],
    panelOnlyCallIds: new Set(),
    attemptRow: null,
    turnThinking: null,
    liveSteerInject: false,
    dirtyOpenRow: false,
    pendingRowUpdates: new Map(),
  };
  bridges.set(shell, bag);

  const frozenTickMs = monitor?.tickMs ?? DEFAULT_TICK_MS;
  const animationTickMs = Math.min(frozenTickMs, ANIMATION_TICK_MS);

  /** Current cadence, or null while stopped. Every paint resolves it — one
   * timer, never two. */
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

  /** Watchdog inputs for the current turn, built once so the indicator and
   * abort agree. */
  const stallArgsFor = (nowMs: number) => ({
    status: bag.turn.status,
    awaitingResponse: bag.turn.awaitingResponse,
    lastActivityAt: bag.turn.lastActivityAt,
    nowMs,
    stallTimeoutMs,
    isProcessing: bag.turn.isProcessing,
    streamingType: bag.turn.streamingType,
    currentToolName: bag.turn.currentToolName,
    activeToolCalls: bag.turn.activeToolCalls,
    callIdByName: bag.turn.callIdByName,
    callNameById: bag.turn.callNameById,
    stallNoticeMs,
    repeating: bag.turn.repeating,
  });

  /** Stall duration since silence crossed the notice threshold, or null.
   * Derived from `lastActivityAt`, so stale resumed activity paints the
   * settled glyph immediately. */
  const stalledForMs = (nowMs: number, isStalled: boolean): number | null =>
    isStalled ? nowMs - bag.turn.lastActivityAt - stallNoticeMs : null;

  const paintPhaseAt = (nowMs: number, isStalled: boolean): void => {
    const turn = bag.turn;
    // The stall notice is a live diagnosis, not a sticky banner: set and
    // clear it every paint (the cadence timer cancels on settle).
    const level = stallLevel(stallArgsFor(nowMs));
    if (level === "notice") {
      setStatusFlash(shell, STALL_NOTICE_MESSAGE);
    } else if (shell.statusFlash === STALL_NOTICE_MESSAGE) {
      setStatusFlash(shell, null);
    }
    // The landing mark rides this re-entry: animates while a turn is live,
    // holds its filled frame otherwise.
    paintLanding(shell, nowMs, turn.isProcessing);
    // The reveal rides the same re-entry, crawling through already-arrived
    // text even with no new delta.
    if (bag.openRow !== null && bag.openRow.kind === "thinking") {
      advanceOpenReveal(shell, bag, bag.openRow, nowMs);
    }
    syncToolElapsed(shell, bag, nowMs);
    const input = {
      isProcessing: turn.isProcessing,
      status: turn.status,
      currentToolName: turn.currentToolName,
      streamingType: turn.streamingType,
      nowMs,
      sessionActive: occupancyHold(bag),
    };
    const fleet = fleetProgress(bag.agentSessions, nowMs);
    const label = resolveTurnLabel(input, isStalled, fleet);
    const sessionLive = label !== undefined;
    if (label === undefined) {
      // The status slot rides the same re-entry, crossfading between phases
      // without its own timer.
      setLockupFrame(shell, {
        nowMs,
        animating: false,
        phase: null,
        rampPhase: null,
        stalledForMs: null,
      });
      // Nothing animates or waits: stop the loop; the next event re-arms
      // it.
      applyCadence(bag.turn.quota !== null ? frozenTickMs : null);
      return;
    }
    const rampPhase = resolveRampPhase(input, isStalled, fleet);
    const stalledFor = stalledForMs(nowMs, rampPhase === "stalled");
    setLockupFrame(shell, {
      nowMs,
      animating: sessionLive,
      phase: label,
      rampPhase,
      stalledForMs: stalledFor,
    });
    // A frozen ramp (gate-blocked or past its blink burst) still needs the
    // stall and quota clocks, not animation.
    applyCadence(
      rampAnimating(rampPhase, stalledFor) ? animationTickMs : frozenTickMs,
    );
  };

  /** Read the clock once per frame so the pulse and cadence cannot straddle
   * a blink boundary. */
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

  /** A settled turn hands the session back unless a live fleet holds it
   * busy; chat terminators emit no `run` event, else the shell stays busy. */
  const settleRun = (): void => {
    settleRunToIdle(shell, bag);
  };

  /**
   * A call parked on an approval gate ends one of two ways. Approved, it is
   * re-dispatched and reports through its own `tool.start` and `tool.done`.
   * Rejected, timed out or dropped, the reactor answers it with a synthetic
   * error result and emits nothing naming it, so it would stay active and the
   * turn could never settle. The reactor cannot infer while a call is parked,
   * so an `inference.start` that finds a parked call still unstarted means it
   * was answered without running: close it the way a `tool.done` would.
   */
  const trackParkedCalls = (event: BridgeInboundEvent | ReactorLikeEvent) => {
    switch (event.type) {
      case "tool.start": {
        const id = startedCallId(event.data);
        if (id === undefined) return;
        bag.executingToolCalls.add(id);
        bag.parkedToolCalls.delete(id);
        return;
      }
      case "tool.done": {
        const id = doneCallId(event.data);
        if (id === undefined) return;
        bag.executingToolCalls.delete(id);
        bag.parkedToolCalls.delete(id);
        return;
      }
      case "reactor.gate.blocked": {
        if (!isApprovalGate(event.data)) return;
        bag.parkedToolCalls = new Set(
          bag.turn.activeToolCalls.filter(
            (id) =>
              bag.turn.callNameById[id] !== undefined &&
              !bag.executingToolCalls.has(id),
          ),
        );
        return;
      }
      case "inference.start":
        closeParkedCalls();
        return;
    }
  };

  const closeParkedCalls = (): void => {
    const parked = [...bag.parkedToolCalls];
    bag.parkedToolCalls.clear();
    for (const id of parked) {
      // An interrupt or reset may already have cleared it.
      if (!bag.turn.activeToolCalls.includes(id)) continue;
      const name = bag.turn.callNameById[id];
      handle({
        type: "tool.done",
        data: {
          result: {
            callId: id,
            ...(name !== undefined ? { name } : {}),
            content: PARKED_CALL_NOT_RUN,
            isError: true,
          },
        },
      });
    }
  };

  const handle = (event: BridgeInboundEvent | ReactorLikeEvent): void => {
    if (bag.disposed) return;
    trackParkedCalls(event);
    if (event.type === "inference.start") {
      // Separates "inference never started" from "stream went quiet" when a
      // turn later stalls past the bound.
      recordTurnMarker(bag, "infer-start");
      bag.awaitingContinuationInference = false;
    }
    const staleContinuationReply =
      event.type === "connector.reply" && bag.awaitingContinuationInference;
    const tokensBefore = bag.turn.streamTokenCount;
    const settled = staleContinuationReply ? false : noteEvent(event);
    if (tokensBefore === 0 && bag.turn.streamTokenCount > 0) {
      recordTurnMarker(bag, "first-token");
    }
    if (settled) {
      // Settled turn: no bound is owed; a settle-time flush that sends
      // re-arms through the flush path below.
      bag.askWakeTurnArmed = false;
      recordTurnMarker(bag, "settle");
    }
    // Reactor-shaped types always map first (avoids tool.done name collision).
    if (PRODUCTION_REACTOR_TYPES.has(event.type)) {
      if (consumePendingEchoEvent(bag, event)) {
        // The echo skips the mapper so it cannot expire a recovery handoff,
        // but still starts a new turn.
        closeOpenRow(shell, bag);
        bag.turnThinking = null;
        return;
      }
      for (const mapped of mapProductionEvent(
        event as ReactorLikeEvent,
        bag.mapCtx,
      )) {
        applyInbound(shell, bag, mapped);
      }
      // inference.done with outstanding tool calls doesn't settle the turn,
      // but the soft-steer boundary still passed.
      if (onTurnBoundary(event) && bag.turn.activeToolCalls.length > 0) {
        drainLiveSteersAtBoundary(shell, bag);
      }
      if (settled) {
        settleRun();
        paintPhase();
      }
      return;
    }
    if (isBridgeInbound(event)) {
      applyInbound(shell, bag, event);
    }
    if (settled) {
      settleRun();
      paintPhase();
    }
  };

  const recordLastSent = (
    replay: { text: string; origin: "composer" | "internal" } | null,
  ): void => {
    bag.lastSentMessage = replay === null ? "" : replay.text;
    bag.lastSentOrigin = replay === null ? null : replay.origin;
  };

  const submit = (
    text: string,
    kind: "queue" | "steer" | "immediate" | "reinject",
    attachments?: readonly PendingImageAttachment[],
  ): void => {
    // A steer delivers at a boundary only while the parent turn is in
    // flight; see `parentIdleWithFleet` below.
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

    // Local-only submits (slash commands, /feedback) are not agent turns:
    // no busy mark, no mid-run queue.
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
      // For tests and direct callers: stop the run now, then fall into the
      // immediate-send path.
      if (shell.session.run !== "busy") return;
      closeOpenRow(shell, bag);
      bag.pendingEchoes.length = 0;
      bag.mapCtx.errorRollbackArmed = false;
      bag.attemptRow = null;
      shell.session = interrupt(shell.session);
      // Reuse the first-Ctrl+C pause wording ("pending kept"/"stopped") plus the
      // arming-window flash so this reinject stop reads as a pause, not a
      // restart: queued work delivers only on the operator's next explicit send,
      // and a second Ctrl+C quits.
      appendStreamRow(shell, {
        role: "system",
        text:
          badgeCount(shell.session) > 0
            ? `${badgeCount(shell.session)} pending kept — press ctrl+c again to exit`
            : "stopped — press ctrl+c again to exit",
        meta: "stop",
      });
      bag.port.interrupt();
      recordLastSent(null);
      bag.turn = turnStateOnInterrupt(bag.turn, now());
    }

    // Idle-with-fleet: the run is only nominally busy; Enter starts a new
    // primary turn, not a steer.
    const parentIdleWithFleet =
      kind === "steer" && bag.liveFleet > 0 && !bag.turn.isProcessing;
    if (
      kind === "immediate" ||
      kind === "reinject" ||
      shell.session.run === "idle" ||
      parentIdleWithFleet
    ) {
      // An explicit operator send releases the operator pause (CL-10149): clear
      // the flag so the next drain boundary delivers the held follow-ups and
      // compaction continuations onto this fresh turn. Queued work never
      // auto-drains after a single Ctrl+C — only an explicit new send clears it.
      shell.session = resumeForSend(shell.session);
      appendStreamRow(shell, {
        role: "user",
        text: userRowText(t, attached),
        ...(kind === "reinject" ? { meta: "reinject" } : {}),
      });
      bag.pendingEchoes.push(t);
      shell.session = setRunState(shell.session, "busy");
      recordLastSent({ text: t, origin: "composer" });
      bag.turn = turnStateOnSubmit(bag.turn, now());
      paintChrome(shell);
      paintPhase();
      bag.port.sendImmediate(t, attachments);
      restoreNextPromptRecovery(shell, bag);
      return;
    }

    shell.session =
      kind === "steer"
        ? enqueueSteer(shell.session, t, undefined, attachments)
        : enqueue(shell.session, t, "queue", undefined, attachments);
    bag.port.enqueue(t, kind);
    if (kind === "steer") bag.waitYieldWake?.();
    // No echo while pending: the item lists above the prompt until it
    // delivers.
    paintChrome(shell);
    restoreNextPromptRecovery(shell, bag);
  };

  const sendInternalText = (text: string): void => {
    appendStreamRow(shell, { role: "user", text });
    bag.pendingEchoes.push(text);
    shell.session = setRunState(shell.session, "busy");
    recordLastSent({ text, origin: "internal" });
    bag.turn = turnStateOnSubmit(bag.turn, now());
    paintChrome(shell);
    paintPhase();
    // Harness turns are not composer input: /feedback must never consume them.
    bag.port.deliver({
      id: crypto.randomUUID(),
      text,
      kind: "queue",
      enqueuedAt: now(),
    });
  };
  const flushMailboxMail = (): boolean => {
    if (isPaused(shell.session)) return false;
    if (bag.disposed || bag.turn.isProcessing) return false;
    try {
      if (bag.mailboxMailDriver?.() === true) return true;
    } catch {
      // Occupancy miss is retryable on the next idle/subscribe edge.
    }
    return mailboxMailDriveClaimed(bag.mailboxMailDriver);
  };
  bag.flushMailboxMail = flushMailboxMail;

  const flushPendingAskWake = (): void => {
    if (isPaused(shell.session)) return;
    if (bag.disposed || bag.turn.isProcessing || bag.turn.blockedGateCount > 0)
      return;
    if (mailboxMailDriveClaimed(bag.mailboxMailDriver)) return;
    const asks = [...bag.pendingAskWake.values()].filter(
      (ask) => bag.deliveredAskWake.get(ask.sessionId) !== ask.questionId,
    );
    if (asks.length === 0) return;
    // Outbound delivery can synchronously re-enter through store/stream events.
    for (const ask of asks)
      bag.deliveredAskWake.set(ask.sessionId, ask.questionId);
    sendInternalText(
      asks
        .map((ask) => {
          const resurfaced = bag.askWakeResurface.get(ask.sessionId) ?? 0;
          return pendingAskWakeText(
            ask,
            resurfaced > 0 ? { resurface: resurfaced } : undefined,
          );
        })
        .join("\n\n"),
    );
    // The send started a primary turn for these questions: arm the stall
    // bound so a silent turn cannot freeze.
    bag.askWakeTurnArmed = true;
    bag.onAskWakeSent?.(asks);
  };
  bag.flushPendingAskWake = flushPendingAskWake;

  const flushOccupancyThenWake = (): void => {
    if (isPaused(shell.session)) return;
    if (flushMailboxMail() || bag.turn.isProcessing) return;
    flushPendingAskWake();
  };
  bag.flushOccupancyThenWake = flushOccupancyThenWake;

  /** A stalled armed wake never landed: drop its deliveredAskWake entries and
   * bump resurface counts for the next flush. */
  const unDedupeArmedAskWakes = (): void => {
    if (!bag.askWakeTurnArmed) return;
    for (const [sessionId, ask] of bag.pendingAskWake) {
      if (bag.deliveredAskWake.get(sessionId) !== ask.questionId) continue;
      bag.deliveredAskWake.delete(sessionId);
      bag.askWakeResurface.set(
        sessionId,
        (bag.askWakeResurface.get(sessionId) ?? 0) + 1,
      );
    }
  };

  /** Shared abort for Ctrl+C, monitor tick, and the fleet-poll stall bound:
   * interrupt the hung inference, then flush occupancy. */
  const abortInFlightAndHandoff = (): void => {
    closeOpenRow(shell, bag);
    bag.pendingEchoes.length = 0;
    // No attempt in flight: expire the error-recovery handoff so a later
    // inference.start cannot roll back the stop.
    bag.mapCtx.errorRollbackArmed = false;
    bag.attemptRow = null;
    applyShellInterrupt(shell);
    bag.port.interrupt();
    // The stop settles the turn without necessarily producing an idle event to
    // drain against. On an operator PAUSE the drain gate (drainAtBoundary's
    // isPaused check) keeps the held queue PENDING instead of handing it to a
    // rebuilt agent — a later explicit new send clears the pause and the next
    // boundary delivers it. Only non-operator drains (stall/expire aborts)
    // fall through to the current handover behavior below.
    drainAtBoundary(shell, bag);
    // Clearing the last prompt stops the quota loop from replaying a
    // stopped turn.
    recordLastSent(null);
    bag.awaitingContinuationInference = false;
    // An armed wake that dies here never landed: un-dedupe so
    // flushPendingAskWake can restate it if occupancy misses.
    unDedupeArmedAskWakes();
    bag.askWakeTurnArmed = false;
    bag.turn = turnStateOnInterrupt(bag.turn, now());
    paintPhase();
    // Operator pause holds occupancy/ask-wake: a stashed mailbox or ask must
    // not start a new primary until an explicit send. Stall/expire do not
    // set paused, so they still flush here.
    if (!isPaused(shell.session)) flushOccupancyThenWake();
  };

  /** Stall bound for a silent ask-wake turn: matches only an armed
   * (wake-sent, never settled) turn; mail first so occupancy takes the next
   * turn. */
  const abortStalledWakeTurn = (): boolean => {
    if (bag.disposed || !bag.askWakeTurnArmed) return false;
    if (!shouldAbortForStall(stallArgsFor(now()))) return false;
    const layer = turnStallLayer(bag.turn) ?? "mid-stream";
    recordTurnMarker(bag, `stall-abort:${layer}`);
    abortInFlightAndHandoff();
    return true;
  };

  /** Ask-deadline bound for a silent ask-wake turn: expired this tick, armed
   * never-settled wake, nothing pending. Shares the stall abort's handler. */
  const abortExpiredWakeTurn = (expiredThisTick: boolean): boolean => {
    if (!expiredThisTick) return false;
    if (bag.disposed || !bag.askWakeTurnArmed) return false;
    if (!bag.turn.isProcessing) return false;
    if (bag.pendingAskWake.size > 0) return false;
    recordTurnMarker(bag, "expire-abort");
    abortInFlightAndHandoff();
    return true;
  };

  const doInterrupt = (): void => {
    if (bag.disposed) return;
    abortInFlightAndHandoff();
  };
  const clearQueuedDelivery = (): void => {
    if (bag.disposed) return;
    shell.session = createSessionQueue("idle");
    recordLastSent(null);
    bag.pendingEchoes.length = 0;
    bag.pendingDeliveries.clear();
    bag.pendingPromptRecoveries.length = 0;
    bag.liveFleet = 0;
    bag.pendingAskWake.clear();
    bag.deliveredAskWake.clear();
    // Stop teardown: queue gone, no wake turn owed — disarm the bound and
    // drop escalation counts.
    bag.askWakeTurnArmed = false;
    bag.askWakeResurface.clear();
    bag.droveOpenTasksThisDry = false;
    bag.awaitingContinuationInference = false;
    bag.pendingRowUpdates.clear();
    paintChrome(shell);
  };

  /** A gate was raised; called from the gate wiring so a gate behind another
   * overlay still exempts the turn from the stall watchdog. */
  const gateOpened = (): void => {
    if (bag.disposed) return;
    bag.turn = turnStateGateOpened(bag.turn);
    // Snapshot calls waiting on this gate; an auto-allowed sibling with a
    // live clock is executing, not waiting.
    for (const callId of bag.toolCallStartedAt.keys()) {
      if (hasPaintedElapsedClock(shell, bag, callId)) continue;
      bag.gatedToolCalls.add(callId);
    }
    paintPhase();
  };

  const gateClosed = (): void => {
    if (bag.disposed) return;
    bag.turn = turnStateGateClosed(bag.turn, now());
    // The grant is execution start: waited clocks re-sync here so post-grant
    // stats read time-since-grant.
    rebaseGatedElapsed(shell, bag, now());
    paintPhase();
    flushOccupancyThenWake();
  };

  // When the in-flight approval resume began; at most one runs at a time.
  let stallResumeStartedAt: number | undefined;

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
      const replay = { text: bag.lastSentMessage, origin: bag.lastSentOrigin };
      bag.turn = clearQuotaWait(bag.turn);
      setStatusFlash(shell, "rate limit cleared — resubmitting", {
        ttlMs: RUNTIME_FLASH_MS,
      });
      if (replay.origin === "internal") sendInternalText(replay.text);
      else submit(replay.text, "immediate");
      return;
    }

    if (quota !== null) {
      // The error already lives in the transcript; do not park a countdown
      // flash that outlives it.
      return;
    }

    // Content-based: a repeating line means the model is stuck at any
    // speed, so check before the silence clock.
    if (bag.turn.status === "running" && bag.turn.repeating) {
      const repeatedTokens =
        bag.turn.streamTokenCount - (bag.turn.repeatingSinceTokenCount ?? 0);
      applyStallRecovery(
        {
          abort: doInterrupt,
          notify: (message) =>
            setStatusFlash(shell, message, { ttlMs: RUNTIME_FLASH_MS }),
        },
        repetitionRecoveryMessage(repeatedTokens),
      );
      return;
    }

    const stallArgs = stallArgsFor(nowMs);

    if (shouldAbortForStall(stallArgs)) {
      const recover = (): void =>
        applyStallRecovery(
          {
            abort: () => {
              if (abortStalledWakeTurn()) return;
              doInterrupt();
            },
            notify: (message) =>
              setStatusFlash(shell, message, { ttlMs: RUNTIME_FLASH_MS }),
          },
          STALL_RECOVERY_MESSAGE,
        );
      if (stallResumeStartedAt !== undefined) {
        // One resume attempt is already out. Give it a single stall budget,
        // then take the abort so a wedged attempt cannot hold the turn open.
        if (nowMs - stallResumeStartedAt < stallArgs.stallTimeoutMs) return;
        stallResumeStartedAt = undefined;
        recordTurnMarker(bag, "stall-resume:timeout");
        recover();
        return;
      }
      const resume = bag.suspendedApprovalRecovery;
      if (resume === undefined) {
        recover();
        return;
      }
      const startedAt = nowMs;
      stallResumeStartedAt = startedAt;
      const settle = (handled: boolean, code: string): void => {
        // A timed-out, superseded or no-longer-stalled attempt already took
        // its own outcome.
        if (bag.disposed || stallResumeStartedAt !== startedAt) return;
        stallResumeStartedAt = undefined;
        recordTurnMarker(bag, `stall-resume:${code}`);
        if (handled) return;
        // Re-evaluate: the turn may have moved on while the attempt ran.
        if (shouldAbortForStall(stallArgsFor(now()))) recover();
      };
      void resume(() =>
        setStatusFlash(shell, STALL_APPROVAL_RESUME_MESSAGE, {
          ttlMs: RUNTIME_FLASH_MS,
        }),
      ).then(
        (outcome) => settle(outcome.handled, outcome.code),
        () => settle(false, "error"),
      );
      return;
    }

// Not stalled: any earlier resume attempt belongs to a stall that ended,
    // so a later stall starts clean instead of waiting out its budget.
    stallResumeStartedAt = undefined;

    // Same stall question `paintPhase` asks — one definition, never two.
    paintPhaseAt(nowMs, isStalledForDisplay(stallArgs));
  };

  setShellBridgeHooks(shell, {
    onSubmit: (text, kind, attachments) => {
      submit(text, kind, attachments);
    },
    onInterrupt: () => {
      doInterrupt();
    },
    // Enter on a selected row: the item leaves the queue on the same
    // port.deliver hop a drain would use; mid-turn steers keep steer
    // semantics via liveSteerInject.
    onForceDeliver: (itemId) => {
      const { state, item } = cancelItem(shell.session, itemId);
      if (item === null) return;
      shell.session = state;
      const inject = item.kind === "steer" && bag.turn.isProcessing;
      if (inject) bag.liveSteerInject = true;
      try {
        deliverQueuedItem(shell, bag, item);
      } finally {
        if (inject) bag.liveSteerInject = false;
      }
      paintChrome(shell);
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
    clearQueuedDelivery,
    setSuspendedApprovalRecovery: (recovery) => {
      bag.suspendedApprovalRecovery = recovery;
    },
    get parentCycleLive() {
      return bag.liveSteerInject;
    },
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
    syncShellOutputs: (feedFor) => {
      syncShellOutputs(shell, bag, feedFor);
    },
    setInferenceProviderId: (id, displayLabel) => {
      if (bag.disposed) return;
      if (id === undefined) {
        delete bag.mapCtx.providerId;
        delete bag.mapCtx.providerLabel;
      } else {
        bag.mapCtx.providerId = id;
        if (displayLabel === undefined) {
          delete bag.mapCtx.providerLabel;
        } else {
          bag.mapCtx.providerLabel = displayLabel;
        }
      }
    },
    beginSystemContinuation: (text) => {
      if (bag.disposed) return;
      // Occupancy that already claimed a latch can still call begin after an
      // awaited collect. Operator pause must not start a primary; stall/expire
      // do not set paused, so they still begin.
      if (isPaused(shell.session)) return;
      const t = text.trim();
      if (t.length === 0) return;
      bag.lastSentMessage = t;
      bag.awaitingContinuationInference = true;
      shell.session = setRunState(shell.session, "busy");
      bag.turn = turnStateOnSubmit(bag.turn, now());
      paintChrome(shell);
      paintPhase();
    },
    abortSystemContinuation: (opts) => {
      if (bag.disposed) return;
      bag.awaitingContinuationInference = false;
      // The continuation turn is over without settling: no bound is owed.
      bag.askWakeTurnArmed = false;
      if (opts?.rearmDry !== false) {
        bag.droveOpenTasksThisDry = false;
      }
      bag.lastSentMessage = "";
      flushOpenRow(shell, bag);
      bag.turnThinking = null;
      shell.inFlightTool = null;
      shell.session = setRunState(shell.session, "idle");
      drainAtBoundary(shell, bag);
      bag.turn = turnStateOnInterrupt(bag.turn, now());
      paintPhase();
    },
    setDryOpenTaskDriver: (driver) => {
      bag.dryOpenTaskDriver = driver;
    },
    setMailboxMailDriver: (driver) => {
      bag.mailboxMailDriver = driver;
    },
    setOnAskWakeSent: (handler) => {
      bag.onAskWakeSent = handler;
    },
    setWaitYieldWake: (wake) => {
      bag.waitYieldWake = wake;
    },
    flushMailboxMail: () => {
      flushMailboxMail();
    },
    abortStalledWakeTurn: () => abortStalledWakeTurn(),
    abortExpiredWakeTurn: (expiredThisTick) =>
      abortExpiredWakeTurn(expiredThisTick),
    turnMarkers: () => bag.turnMarkers,
    dispose: () => {
      flushOpenRow(shell, bag);
      bag.disposed = true;
      recordLastSent(null);
      bag.pendingDeliveries.clear();
      bag.pendingPromptRecoveries.length = 0;
      bag.pendingAskWake.clear();
      bag.deliveredAskWake.clear();
      bag.askWakeTurnArmed = false;
      bag.askWakeResurface.clear();
      bag.flushPendingAskWake = null;
      bag.flushMailboxMail = null;
      bag.flushOccupancyThenWake = null;
      applyCadence(null);
      clearShellBridgeHooks(shell);
      bridges.delete(shell);
    },
  };
}
