/**
 * Wave 4 runtime bridge — thin port between OpenTUI shell and session events.
 *
 * Inbound: fixture or reactor-like events → stream rows + run state + queue drain.
 * Outbound: queue / steer / interrupt / immediate send hit SessionPort (tests record;
 * later waves can bind real agent APIs). Not the production CLI entry.
 */

import {
  cancelItem,
  createSessionQueue,
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
  type AppShell,
} from "./shell/internals.js";
import { applyShellInterrupt, surfaceSystemNotice } from "./shell/prompt.js";
import { streamRowAt, streamRowCount } from "./shell/transcript.js";
import { rampAnimating } from "./ramp.js";
import { OPERATOR_ORIGINATED_FLAG } from "../agent/message-provenance.js";
import { onTurnBoundary } from "../agent/reactor-events.js";
import {
  resolveRampPhase,
  resolveTurnLabel,
  sendFailureText,
} from "./session-chrome.js";
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
import {
  userRowText,
  type PendingImageAttachment,
} from "./image-attachments.js";
import {
  deliveryResultNotice,
  type AgentDeliveryResult,
} from "./deliver-agent-message.js";
import type { DeliverySettle } from "./queued-delivery.js";
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
} from "./agent-progress.js";
import {
  pendingAskWakeText,
  type PendingAskWake,
} from "../subagent/fleet-report.js";

/** Tool name a sub-agent dispatch call carries — its row gets live progress. */
const SPAWN_AGENT_TOOL_NAME = "spawn_agent";

/**
 * Tool name the task checklist is written through. Its calls paint no
 * transcript row: the list they write is live state owned by the task panel,
 * and a row per call renders the same work twice on one screen — once as a
 * panel that updates in place, and again as scrollback that never does.
 */
const MANAGE_TASKS_TOOL_NAME = "manage_tasks";

/** A sub-agent session as `syncAgentProgress` needs it: identified, and live-readable. */
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
   * Drop mid-run queue items, pending echoes, and fleet hold so a session
   * rotation cannot drain old input into the new reactor. Leaves the run idle
   * so the next Enter is a send, not a steer.
   */
  clearQueuedDelivery: () => void;
  /**
   * True only while draining steers at a live parent tool.boundary (or
   * inference.done with tools still outstanding). Last-hop routing reads this
   * when the deliver op runs: leftover / fleet-hold / post-interrupt drains
   * are false and must send().
   */
  readonly parentCycleLive: boolean;
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
   * Refresh outstanding `spawn_agent` rows with each worker's live progress for
   * the worker lifetime — not only while the spawn_agent tool call is in
   * flight. The immediate `{status:running}` result must not drop tracking.
   * The caller supplies the sessions (from `SubAgentSessionStore.listForStrip()`
   * or similar) on whatever cadence it already polls at.
   */
  syncAgentProgress: (sessions: readonly TaskProgressSession[]) => void;
  /**
   * Paint the live output tail of each in-flight `run_shell` from that call's
   * bounded feed, frame-coalesced. Undefined lookup (or no wired feed at the
   * host) leaves pending rows untouched.
   */
  syncShellOutputs: (
    feedFor: ((callId: string) => ShellOutputFeed | undefined) | undefined,
  ) => void;
  /**
   * Stamp the live catalog provider id onto the stream map context so
   * `inference.error` transcript lines can identify known-xAI short 429s
   * when the harness event omits `providerId`.
   */
  setInferenceProviderId: (
    id: string | undefined,
    displayLabel?: string,
  ) => void;
  /**
   * Mark the run busy for a system-originated continuation (fleet-dry open-task
   * drive). Does not echo locally — inbound `message.received` without the
   * operator flag paints as a system row. Does not send — the caller uses
   * sendWithAttemptIdentity with a system mailbox message.
   */
  beginSystemContinuation: (text: string) => void;
  /**
   * Occupancy send failed after beginSystemContinuation. Drop the continuation
   * hold and idle so follow-ups can drain. Pass rearmDry:false for mailbox
   * mail so a later subscribe can retry; fleet-dry defaults to re-arming the
   * latch for the next settle shot.
   */
  abortSystemContinuation: (opts?: { rearmDry?: boolean }) => void;
  /**
   * Occupancy owner for dry+open continuation. Called once per dry episode
   * from settleRunToIdle when the fleet is dry. Return true if a continuation
   * was sent (run stays busy).
   */
  setDryOpenTaskDriver: (driver: (() => boolean) | undefined) => void;
  /**
   * Occupancy owner for per-item mailbox mail. Called from idle-with-fleet
   * settle (like flushPendingAskWake) and from the store-subscribe driver.
   */
  setMailboxMailDriver: (driver: (() => boolean) | undefined) => void;
  /**
   * Called after flushPendingAskWake actually sendInternalText. Wiring stamps
   * the fleet mailbox so list_agents fails closed until send_input.
   */
  setOnAskWakeSent: (
    handler: ((asks: readonly PendingAskWake[]) => void) | undefined,
  ) => void;
  /**
   * Wake the session/mailbox when the operator queues a steer, so occupancy
   * can deliver it at the next parent tool.boundary. Workers are not interrupted.
   */
  setWaitYieldWake: (wake: (() => void) | undefined) => void;
  /**
   * Occupancy flush for mailbox mail. No-op while the parent is processing.
   * Skip when a fleet-dry open-task shot is about to run.
   */
  flushMailboxMail: () => void;
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

export interface BridgeBag {
  port: SessionPort;
  openRow: OpenStreamRow | null;
  /**
   * Prompts already echoed locally. The runtime replays each one as
   * `message.received`; without this the transcript shows the message twice.
   */
  pendingEchoes: string[];
  /**
   * Exact queue items popped for delivery but not yet settled. Ownership moves
   * here from `SessionQueueState.items` so a second boundary cannot redispatch
   * them, and recovery can restore the original payload on rejection.
   */
  pendingDeliveries: Map<string, QueueItem>;
  /**
   * Failed deliveries waiting for an empty composer. Never merges into a draft
   * the operator is already typing; FIFO after each successful submit clears.
   */
  pendingPromptRecoveries: QueueItem[];
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
  /**
   * Worker asks parked in ask_director, keyed by session, waiting for a
   * moment the parent can act on them (idle settle or last gate closing).
   * Keying by session is what stops a repeat emitter notification from
   * stashing the same question twice.
   */
  pendingAskWake: Map<string, PendingAskWake>;
  deliveredAskWake: Map<string, string>;
  /**
   * Set inside `attachSessionBridge`; the module-scope
   * settle path (`settleRunToIdle`) and `gateClosed` re-enter through it.
   */
  flushPendingAskWake: (() => void) | null;
  /**
   * Occupancy flush for per-item mailbox mail. Set inside
   * `attachSessionBridge` so settle and fleet events share one gate.
   */
  flushMailboxMail: (() => void) | null;
  /**
   * One occupancy shot per dry episode. Reset when a live lane starts. Consumed
   * only when the driver actually sends a continuation — a no-op (no open
   * tasks) must not eat the shot, or a later missed 1→0 with leftover tasks
   * never drives. A later settle after a true drive cannot loop.
   */
  droveOpenTasksThisDry: boolean;
  /**
   * beginSystemContinuation re-armed the turn during the previous cycle's
   * settle. Late connector.reply from that cycle must not settle this one
   * until its own inference.start arrives.
   */
  awaitingContinuationInference: boolean;
  /** Occupancy driver: collect+send when settle takes a dry-episode shot. */
  dryOpenTaskDriver: (() => boolean) | undefined;
  /**
   * Occupancy driver for per-item mailbox mail (worker terminal/fail) while
   * the parent is idle, including idle-with-fleet. Not the fleet-0+open-tasks
   * edge — that stays on dryOpenTaskDriver.
   */
  mailboxMailDriver: (() => boolean) | undefined;
  /** After a pending ask wake is actually sent. Independent of deliveredAskWake. */
  onAskWakeSent: ((asks: readonly PendingAskWake[]) => void) | undefined;
  /** Wake the session/mailbox when a steer is queued, so occupancy can deliver it. */
  waitYieldWake: (() => void) | undefined;
  /** Last prompt actually sent — replay source for the quota auto-retry. */
  lastSentMessage: string;
  lastSentOrigin: "composer" | "internal" | null;
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
  /**
   * Last live shell tail painted per in-flight call, so an unchanged feed
   * snapshot applies no row update.
   */
  shellSnapshots: Map<string, string>;
  /** Row of the newest in-flight call, for results that carry no call id. */
  lastToolRow: number;
  /**
   * callIds of `spawn_agent` rows tracked for the worker lifetime. Not a subset
   * of in-flight `toolRows`: spawn_agent returns immediately with
   * `{status:running}`, and live progress must continue after that result
   * lands. Keyed by the same id as the sub-agent session (`call.id`).
   */
  taskCallIds: Set<string>;
  /** Row index for each tracked spawn_agent call, kept after the tool_result. */
  spawnProgressRows: Map<string, number>;
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
  /**
   * Set only around drainSteersAtBoundary at a live parent tool.boundary.
   * Last-hop routing (routeQueuedDelivery) reads this when deliver runs.
   */
  liveSteerInject: boolean;
  /**
   * The open row has accumulated deltas since its last paint; the retext
   * happens once per renderer frame or at the next close/settle seam.
   */
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

/**
 * Prompt text without the attachment note. The local echo and the runtime's
 * `message.received` word that note differently, so echoes match on content.
 */
function promptContent(text: string): string {
  const note = text.search(/\n\[\d+ images? attached:/);
  return (note === -1 ? text : text.slice(0, note)).trim();
}

/** True when this inbound user message is one the shell already painted. */
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

/**
 * One queued item's delivery hop. The pending column carried the item until
 * now; delivery is what earns the transcript row, painted as an ordinary
 * operator message. The queueItemId lets the settle path mark this exact row
 * not-delivered/uncertain and lets rollback keep a delivered row; the echo
 * ledger keeps the inbound `message.received` from painting a second row
 * when the runtime echoes the send back.
 */
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

/** Total reasoning an open thinking row stands for, earlier fragments included. */
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

/** Finalize the open streaming row: it stops growing and stops being unstable. */
function closeOpenRow(shell: AppShell, bag: BridgeBag): void {
  const open = bag.openRow;
  if (open === null) return;
  bag.openRow = null;
  bag.dirtyOpenRow = false;
  // Reasoning stops scrolling and keeps its opening line; the elapsed time and
  // the full chain of thought stay on the row, behind the expand key.
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

/**
 * Grow the open row of this kind, or start one. Deltas never append a row of
 * their own — the message is a single row whose body is repainted as it fills.
 */
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

/**
 * Advance a "thinking" row's reveal position at the bounded rate and repaint
 * if it moved. Called from the coalesced frame flush and the animation tick,
 * so the line both grows with new tokens and keeps crawling through buffered
 * text during a pause in arrival — capped either way by what has arrived.
 */
function advanceOpenReveal(
  shell: AppShell,
  bag: BridgeBag,
  open: OpenStreamRow,
  nowMs: number,
): void {
  // A folded row is settled text above the turn's tool rows; it has no scroll
  // line to advance.
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

/**
 * Apply the coalesced open-row paint. Deltas only accumulate text and mark the
 * row dirty; this is the single retext — once per renderer frame (via
 * `flushStreamRowUpdates` on the shell's frame hook) or at the next
 * close/settle seam, whichever comes first.
 */
function flushOpenRow(shell: AppShell, bag: BridgeBag): void {
  const open = bag.openRow;
  if (open === null || !bag.dirtyOpenRow) return;
  if (open.folded) {
    bag.dirtyOpenRow = false;
    paintFoldedRow(shell, bag, open);
    return;
  }
  if (open.kind === "thinking") {
    // Repaints iff the reveal position moved; a no-op leaves the row dirty so
    // the next tick/frame retries, and closeOpenRow always applies the tail.
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

/**
 * Flush the shell's dirty rows — the open streaming row (J1) and coalesced
 * tool-row repaints (J3) — once per renderer frame from the shell's frame
 * hook, so each coalesces to one application per frame.
 */
export function flushStreamRowUpdates(shell: AppShell): void {
  const bag = bridges.get(shell);
  if (bag === undefined || bag.disposed) return;
  flushOpenRow(shell, bag);
  rowUpdates.applyPendingRowUpdates(shell, bag);
}

/**
 * Paint a tool call. A consecutive call to the same raw toolName collapses
 * onto the previous row instead of opening a new one.
 */
function applyToolCall(
  shell: AppShell,
  bag: BridgeBag,
  event: Extract<BridgeInboundEvent, { type: "tool_call" }>,
): void {
  if (event.name === MANAGE_TASKS_TOOL_NAME) {
    // Remembered so the matching result is dropped too — suppressing only the
    // call would leave its result to land as an unpaired row. Checklist lives
    // on the task panel; spawn_agent dispatches paint live transcript rows instead.
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
    // A diff call's row already carries a "+n/-n" stat — that is the fact
    // worth keeping, not an elapsed clock, so only ordinary calls (no stat of
    // their own) pick up the live timer.
    if (row.stat === undefined) {
      bag.toolCallStartedAt.set(event.callId, bag.now());
    }
  }
  if (event.callId !== undefined && event.name === SPAWN_AGENT_TOOL_NAME) {
    bag.taskCallIds.add(event.callId);
    bag.spawnProgressRows.set(event.callId, index);
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
  if (event.callId !== undefined && bag.panelOnlyCallIds.delete(event.callId))
    return;
  const result = toolResultRow({
    name: event.name,
    content: event.detail ?? (event.isError ? "error" : "ok"),
    isError: event.isError === true,
  });
  const tracked =
    event.callId !== undefined ? bag.toolRows.get(event.callId) : undefined;
  // The elapsed clock was scaffolding for the wait, not a fact about the
  // call — clear it before the merge so it never crowds out the answer's own
  // addendum (e.g. "3 lines") the way a diff's own +/- count is allowed to.
  const clockOwned =
    event.callId !== undefined && bag.toolCallStartedAt.has(event.callId);
  if (event.callId !== undefined) {
    bag.toolRows.delete(event.callId);
    bag.toolCallStartedAt.delete(event.callId);
    bag.shellSnapshots.delete(event.callId);
    // spawn_agent's immediate running JSON is not the end of the worker —
    // keep the row in taskCallIds / spawnProgressRows until the session
    // leaves the running set (see syncAgentProgress).
    if (event.name !== SPAWN_AGENT_TOOL_NAME) {
      bag.taskCallIds.delete(event.callId);
      bag.spawnProgressRows.delete(event.callId);
    }
  }
  if (bag.toolRows.size === 0) shell.inFlightTool = null;
  // An id that matches nothing on the log answers nothing: it is appended as
  // its own row rather than folding onto whichever row happens to be last
  // (the spec's never-misattribute rule). Only id-less results — saved
  // history from before ids existed — keep the newest-row fallback.
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

/**
 * Refresh every tracked `spawn_agent` row with its worker's live progress —
 * elapsed time, current tool, and whether it has gone quiet — for the worker
 * lifetime, not just the spawn_agent tool_result. Repaints are frame-coalesced.
 */
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

/** Drop `stat` entirely rather than set it `undefined` (exactOptionalPropertyTypes). */
function omitStat(row: StreamRow): StreamRow {
  const { stat: _stat, ...rest } = row;
  return rest;
}

/**
 * Paint the live tail of each running `run_shell` onto the pending row that
 * owns that call, frame-coalesced. `feedFor` looks up the call's bounded
 * feed; when it is not wired the row renders exactly as before.
 * `shellSnapshots` dedupes so an unchanged snapshot applies nothing.
 */
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
    // Consecutive in-flight shells share a lane. An empty sibling snapshot
    // must not clear a tail another member already painted.
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

/**
 * Refresh every plain in-flight tool call's row with how long it has been
 * running, frame-coalesced. `spawn_agent` dispatches already get this (and
 * more) from `syncAgentProgress`, so they are skipped here.
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
    const current = bag.pendingRowUpdates.get(index) ?? row;
    const stat = clockLabel(nowMs - startedAt);
    if (current.stat === stat) continue;
    rowUpdates.scheduleRowUpdate(bag, index, { ...current, stat });
  }
}

/**
 * User rows the shell paints ahead of the runtime's own inbound copy: a
 * reinject, which lands before the restarted run reports it, and a row the
 * bridge delivered at a tool boundary (it carries its queueItemId). A
 * delivered row stays — the delivery already happened, so retracting it
 * would show a transcript the runtime never saw returned. Queued/steered
 * items stay off the log while pending (the column above the prompt carries
 * them), so there is nothing of theirs to preserve here.
 */
function isLocallyQueuedUserRow(row: StreamRow): boolean {
  return (
    row.role === "user" &&
    (row.meta === "reinject" || row.queueItemId !== undefined)
  );
}

/**
 * Retract everything the failed attempt painted, then forget the row
 * bookkeeping that pointed into it — a rolled-back tool call has no row left
 * to resolve, and a rolled-back reasoning row is no longer there to fold into.
 */
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
  for (;;) {
    const { state, item } = drainOne(shell.session);
    if (!item) break;
    shell.session = state;
    deliverQueuedItem(shell, bag, item);
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
    deliverQueuedItem(shell, bag, item);
  }
  paintChrome(shell);
}

/**
 * Live parent-cycle inject: routeQueuedDelivery reads parentCycleLive while
 * this drain's port.deliver runs. Idle leftover, fleet-hold, and interrupt
 * use drainSteersAtBoundary / drainAtBoundary without this flag so they send.
 */
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

/**
 * Release the run to idle and drain everything queued — but only at true
 * session-idle. A live fleet holds the run busy after the parent turn settles
 * (idle-with-fleet): Enter upgrades to a new primary turn during the hold and
 * follow-ups keep waiting; the fleet event landing at zero re-enters here to
 * release the hold. A dry fleet takes one occupancy shot here per dry episode
 * instead of idling, even if the live 1→0 edge was never observed.
 */
function settleRunToIdle(shell: AppShell, bag: BridgeBag): void {
  if (shell.session.run !== "busy") return;
  // The turn is settling: whatever the open row accumulated must be on it
  // before the settle paints, even if no renderer frame ran between the last
  // delta and here.
  flushOpenRow(shell, bag);
  bag.turnThinking = null;
  shell.inFlightTool = null;
  if (bag.liveFleet > 0) {
    // Hold: the fleet is still live, so the run stays busy. Steers left
    // pending send now — the parent they were steering has stopped, so
    // each one starts its own turn — while follow-ups keep waiting.
    drainSteersAtBoundary(shell, bag);
    bag.flushPendingAskWake?.();
    bag.flushMailboxMail?.();
    return;
  }
  if (!bag.droveOpenTasksThisDry) {
    let driven = false;
    try {
      driven = bag.dryOpenTaskDriver?.() === true;
    } catch {
      driven = false;
    }
    // Consume only on a real continuation. A false/no-op leaves the latch
    // open so a later missed-edge settle with open tasks can still fire.
    if (driven) {
      bag.droveOpenTasksThisDry = true;
      return;
    }
  }
  shell.session = setRunState(shell.session, "idle");
  bag.awaitingContinuationInference = false;
  // Full drain: soft steers first, then follow-ups (drainOrder).
  drainAtBoundary(shell, bag);
  bag.flushPendingAskWake?.();
  bag.flushMailboxMail?.();
}

function applyInbound(
  shell: AppShell,
  bag: BridgeBag,
  event: BridgeInboundEvent,
): void {
  if (bag.disposed) return;

  // Fleet liveness owns no transcript row state, so it is handled before the
  // open-row machinery — a lane terminalizing mid-parent-stream must not
  // close the assistant row the parent's own deltas are growing.
  if (event.type === "fleet" || event.type === "agent-ask") {
    // Idle-with-fleet bookkeeping. A transition to zero while the parent is
    // already idle releases the hold: that moment is true session-idle, so
    // queued follow-ups drain now. While the parent is still working the
    // count just updates — the ordinary turn settle does the draining.
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
      }
    }
    bag.flushPendingAskWake?.();
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
    pendingDeliveries: new Map(),
    pendingPromptRecoveries: [],
    mapCtx: createStreamMapContext(),
    disposed: false,
    turn: initialTurnState(now()),
    liveFleet: 0,
    pendingAskWake: new Map(),
    deliveredAskWake: new Map(),
    flushPendingAskWake: null,
    flushMailboxMail: null,
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
      // The bottom-left status slot rides the same re-entry as the landing
      // mark, so it crossfades between phases without a timer of its own.
      setLockupFrame(shell, {
        nowMs,
        animating: false,
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
      animating: sessionLive,
      phase: label,
      rampPhase,
      stalledForMs: stalledFor,
    });
    // A frozen ramp (blocked on a gate, or a stall past its blink burst) still
    // needs the stall and quota clocks, just not animation frames.
    applyCadence(
      rampAnimating(rampPhase, stalledFor) ? animationTickMs : frozenTickMs,
    );
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
    if (event.type === "inference.start") {
      bag.awaitingContinuationInference = false;
    }
    const staleContinuationReply =
      event.type === "connector.reply" && bag.awaitingContinuationInference;
    const settled = staleContinuationReply ? false : noteEvent(event);
    // Reactor-shaped types always map first (avoids tool.done name collision).
    if (PRODUCTION_REACTOR_TYPES.has(event.type)) {
      if (consumePendingEchoEvent(bag, event)) {
        // The echo skips the mapper so it cannot expire a recovery handoff,
        // but it still starts a new turn: the next reasoning gets its own row.
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
      // inference.done with tool calls still outstanding doesn't settle the
      // turn (see turn-state.ts) — the cycle continues, but a soft-steer
      // boundary still passed. Follow-ups wait for idle.
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
      bag.mapCtx.errorRollbackArmed = false;
      bag.attemptRow = null;
      shell.session = interrupt(shell.session);
      appendStreamRow(shell, {
        role: "system",
        text: "stop — restarting from your message",
        meta: "stop",
      });
      bag.port.interrupt();
      recordLastSent(null);
      bag.turn = turnStateOnInterrupt(bag.turn, now());
    }

    // Idle-with-fleet: the parent turn has settled while spawned workers are
    // still live, so the run is only nominally busy. Plain Enter is a new
    // primary turn right now — not a queued steer waiting on a parent tool
    // that no longer exists.
    const parentIdleWithFleet =
      kind === "steer" && bag.liveFleet > 0 && !bag.turn.isProcessing;
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
    const queued = shell.session.items[shell.session.items.length - 1];
    bag.port.enqueue(t, kind);
    if (kind === "steer") bag.waitYieldWake?.();
    // No transcript echo while pending: the item lists in the column stacked
    // on the prompt box and lands in the transcript as an ordinary user row
    // when it actually delivers.
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
  const flushPendingAskWake = (): void => {
    if (bag.disposed || bag.turn.isProcessing || bag.turn.blockedGateCount > 0)
      return;
    const asks = [...bag.pendingAskWake.values()].filter(
      (ask) => bag.deliveredAskWake.get(ask.sessionId) !== ask.questionId,
    );
    if (asks.length === 0) return;
    // Outbound delivery can synchronously re-enter through store/stream events.
    for (const ask of asks)
      bag.deliveredAskWake.set(ask.sessionId, ask.questionId);
    sendInternalText(asks.map((ask) => pendingAskWakeText(ask)).join("\n\n"));
    bag.onAskWakeSent?.(asks);
  };
  bag.flushPendingAskWake = flushPendingAskWake;

  const flushMailboxMail = (): void => {
    if (bag.disposed || bag.turn.isProcessing) return;
    try {
      bag.mailboxMailDriver?.();
    } catch {
      // Occupancy miss is retryable on the next idle/subscribe edge.
    }
  };
  bag.flushMailboxMail = flushMailboxMail;

  const doInterrupt = (): void => {
    if (bag.disposed) return;
    closeOpenRow(shell, bag);
    bag.pendingEchoes.length = 0;
    // The stopped attempt is no longer in flight. Expire the error-recovery
    // handoff so a later new-turn inference.start cannot roll back the
    // classified error, the stop row, or the operator's next prompt.
    bag.mapCtx.errorRollbackArmed = false;
    bag.attemptRow = null;
    applyShellInterrupt(shell);
    bag.port.interrupt();
    // The stop settles the turn without necessarily producing an idle event to
    // drain against, so anything the operator had queued would sit there
    // forever. Hand it over here instead: the host serialises it behind the
    // agent rebuild the interrupt just started.
    drainAtBoundary(shell, bag);
    // Clearing the last prompt is what stops the quota loop from replaying a
    // turn the operator (or the watchdog) deliberately stopped.
    recordLastSent(null);
    bag.awaitingContinuationInference = false;
    bag.turn = turnStateOnInterrupt(bag.turn, now());
    paintPhase();
    flushPendingAskWake();
    flushMailboxMail();
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
    bag.droveOpenTasksThisDry = false;
    bag.awaitingContinuationInference = false;
    bag.pendingRowUpdates.clear();
    paintChrome(shell);
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
    flushPendingAskWake();
    flushMailboxMail();
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
      applyStallRecovery(
        {
          abort: doInterrupt,
          notify: (message) =>
            setStatusFlash(shell, message, { ttlMs: RUNTIME_FLASH_MS }),
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
    // Enter on a selected column row: the item leaves the queue and lands on
    // the same port.deliver hop a boundary/idle drain would use. A steer
    // pushed while a turn is still in flight keeps its steer semantics —
    // liveSteerInject routes it to deliverSteer so it injects into the
    // running cycle instead of becoming the next user message.
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
    dispose: () => {
      flushOpenRow(shell, bag);
      bag.disposed = true;
      recordLastSent(null);
      bag.pendingDeliveries.clear();
      bag.pendingPromptRecoveries.length = 0;
      bag.pendingAskWake.clear();
      bag.deliveredAskWake.clear();
      bag.flushPendingAskWake = null;
      bag.flushMailboxMail = null;
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
    data: {
      message: {
        content: "list project root",
        flags: [OPERATOR_ORIGINATED_FLAG],
      },
    },
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
