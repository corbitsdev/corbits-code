/**
 * Shared shell state: the AppShell surface types, the ShellInternals bag, and the per-shell WeakMap registries. Imports no sibling shell module — everything else imports this.
 */
import { type AgentPanelRow, type TaskPanelRow } from "../chrome-state.js";
import {
  BoxRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { parseAtState, type AtState } from "../components/at-mention/parse.js";
import {
  type ClipboardImageResult,
  type PendingImageAttachment,
} from "../image-attachments.js";
import { type SentHistoryBrowse } from "../sent-message-history.js";
import { type PromptRecognitionSource } from "../prompt-recognition.js";
import { type PromptInput } from "../prompt-input.js";
import type { RampPhase, StallAge } from "../ramp.js";
import type { ActivityState } from "../session-chrome.js";
import { type CostContextMeter } from "../prompt-border.js";
import { type FocusState } from "../focus/index.js";
import {
  type GeometryLayout,
  type OverlayMode,
  type ZoneVisibility,
} from "../geometry/index.js";
import { type LandingAbove, type LandingBelowContent } from "../landing.js";
import { type PaletteCommand } from "../command-catalog.js";
import { type ObserveSession } from "../residuals.js";
import { type ClipboardPort, type CopyTarget } from "../copy-path.js";
import { type RunState, type SessionQueueState } from "../session-queue.js";
import { type StreamRow } from "../stream.js";
import { createOverlayView } from "../overlay-view.js";
import { type KillRing } from "../prompt-kill-ring.js";

export const shellExitHandlers = new WeakMap<AppShell, () => void>();

/**
 * Register the host's quit path (the same one Ctrl+C twice runs) so a bare `exit` /
 * `quit` typed at the prompt tears down through finalize instead of a second,
 * cleanup-skipping exit route.
 */
export function setShellExitHandler(shell: AppShell, onExit: () => void): void {
  shellExitHandlers.set(shell, onExit);
}

export function clearShellExitHandler(shell: AppShell): void {
  shellExitHandlers.delete(shell);
}

export const effortCycleHandlers = new WeakMap<AppShell, () => void>();

/** Shift+Tab host callback: cycle reasoning effort for the live session. */
export function setEffortCycleHandler(
  shell: AppShell,
  onCycle: () => void,
): void {
  effortCycleHandlers.set(shell, onCycle);
}

/** Optional Wave-4 bridge hooks (runtime-bridge attaches exclusively). */
export interface ShellBridgeHooks {
  onSubmit: (
    text: string,
    kind: "queue" | "steer" | "immediate" | "reinject",
    attachments?: readonly PendingImageAttachment[],
  ) => void;
  onInterrupt: () => void;
  exclusive: boolean;
}

const shellBridgeHooks = new WeakMap<AppShell, ShellBridgeHooks>();

export function setShellBridgeHooks(
  shell: AppShell,
  hooks: ShellBridgeHooks,
): void {
  shellBridgeHooks.set(shell, hooks);
}

export function clearShellBridgeHooks(shell: AppShell): void {
  shellBridgeHooks.delete(shell);
}

export function getShellBridgeHooks(
  shell: AppShell,
): ShellBridgeHooks | undefined {
  return shellBridgeHooks.get(shell);
}

/**
 * What the focused overlay row is, and what choosing it costs. Painted in the
 * fixed description zone under every overlay list that opts in via `describe`.
 */
export interface ItemDescription {
  /** What the focused thing is. One line. */
  readonly what: string;
  /** What choosing it costs or changes. One line. Omit when there is nothing true to say. */
  readonly impact?: string;
  /** "consequence" paints impact in UI.warning — billing, trust, anything that spends or extends reach. */

  readonly tone?: "plain" | "consequence";
}

/**
 * Payload delivered when the operator accepts an overlay list selection.
 * Hosts map this into ApprovalOutcome / OperatorResult / model switch.
 */
export interface OverlaySelection {
  readonly kind: PrimaryOverlayKind;
  readonly index: number;
  readonly label: string;
  /** Stable id when the host provided `itemIds`; otherwise omitted. */
  readonly id?: string;
  /** Plain chosen value when the host provided `itemValues`; otherwise omitted. */
  readonly value?: string;
}

/**
 * Shell-level overlay accept hooks. Host binds authz / ask_operator / settings.
 * Kind-specific hooks win over `onSelect`. Per-open `onAccept` (on open opts)
 * takes precedence for that open's lifetime.
 */
export interface ShellOverlayHooks {
  readonly onPermission?: (selection: OverlaySelection) => void;
  readonly onOperator?: (selection: OverlaySelection) => void;
  readonly onModel?: (selection: OverlaySelection) => void;
  readonly onSettings?: (selection: OverlaySelection) => void;
  readonly onHelp?: (selection: OverlaySelection) => void;
  readonly onPlugins?: (selection: OverlaySelection) => void;
  readonly onResume?: (selection: OverlaySelection) => void;
  readonly onMentions?: (selection: OverlaySelection) => void;
  /** Catch-all for non-palette kinds when no kind-specific hook is set. */
  readonly onSelect?: (selection: OverlaySelection) => void;
}

const shellOverlayHooks = new WeakMap<AppShell, ShellOverlayHooks>();

export function setShellOverlayHooks(
  shell: AppShell,
  hooks: ShellOverlayHooks,
): void {
  shellOverlayHooks.set(shell, hooks);
}

export function clearShellOverlayHooks(shell: AppShell): void {
  shellOverlayHooks.delete(shell);
}

export function getShellOverlayHooks(
  shell: AppShell,
): ShellOverlayHooks | undefined {
  return shellOverlayHooks.get(shell);
}

/**
 * Injectable handler for registry-backed palette selections (`dispatch: "command"`).
 * Residual openers still go through `runPaletteAction`. Host binds real handlers
 * (slash command run, overlay open, etc.) without the palette importing the registry.
 */
export type PaletteOnCommand = (name: string) => void;

const shellPaletteOnCommand = new WeakMap<AppShell, PaletteOnCommand>();

export function setPaletteOnCommand(
  shell: AppShell,
  handler: PaletteOnCommand | undefined,
): void {
  if (handler) shellPaletteOnCommand.set(shell, handler);
  else shellPaletteOnCommand.delete(shell);
}

export function getPaletteOnCommand(
  shell: AppShell,
): PaletteOnCommand | undefined {
  return shellPaletteOnCommand.get(shell);
}

/**
 * Clipboard image reader behind Ctrl+P. Injectable so tests (and non-macOS
 * hosts) can supply their own source instead of shelling out to osascript.
 */
export type PromptImageSource = () => Promise<ClipboardImageResult>;

export const shellPromptImageSource = new WeakMap<
  AppShell,
  PromptImageSource
>();

export function setPromptImageSource(
  shell: AppShell,
  source: PromptImageSource | undefined,
): void {
  if (source) shellPromptImageSource.set(shell, source);
  else shellPromptImageSource.delete(shell);
}

/** Filesystem suggestions behind the @-mention overlay. */
export type MentionSuggestionSource = (
  prefix: string,
) => Promise<readonly string[]>;

export const shellMentionSource = new WeakMap<
  AppShell,
  MentionSuggestionSource
>();

export function setMentionSuggestionSource(
  shell: AppShell,
  source: MentionSuggestionSource | undefined,
): void {
  if (source) shellMentionSource.set(shell, source);
  else shellMentionSource.delete(shell);
}

/** Names the prompt is allowed to highlight as leading `/command` tokens. */
export const shellRecognitionSource = new WeakMap<
  AppShell,
  PromptRecognitionSource
>();

export function setPromptRecognitionSource(
  shell: AppShell,
  source: PromptRecognitionSource | undefined,
): void {
  if (source) shellRecognitionSource.set(shell, source);
  else shellRecognitionSource.delete(shell);
}

/**
 * Injectable handler for the palette "observe" action. Host resolves a live
 * `ObserveSession` (or `null` when no subagent is running). Demo/smoke keep
 * using `makeObserveFixture()` by leaving this unset.
 */
export type PaletteOnObserveRequest = () => ObserveSession | null;

const shellPaletteOnObserveRequest = new WeakMap<
  AppShell,
  PaletteOnObserveRequest
>();

export function setPaletteOnObserveRequest(
  shell: AppShell,
  handler: PaletteOnObserveRequest | undefined,
): void {
  if (handler) shellPaletteOnObserveRequest.set(shell, handler);
  else shellPaletteOnObserveRequest.delete(shell);
}

export function getPaletteOnObserveRequest(
  shell: AppShell,
): PaletteOnObserveRequest | undefined {
  return shellPaletteOnObserveRequest.get(shell);
}

/** Renderer surface required by the shell (CliRenderer / createTestRenderer). */
export type ShellRenderer = Pick<
  CliRenderer,
  | "root"
  | "width"
  | "height"
  | "keyInput"
  | "on"
  | "off"
  | "isDestroyed"
  | "clearSelection"
>;

export interface AppShellOptions {
  /** Session name. Default "corbits". Not painted as chrome. */
  readonly title?: string;
  /** Working directory carried by the prompt box's bottom border. */
  readonly cwd?: string;
  /** Zone visibility overrides for resolveGeometry. Optional strips off by default. */
  readonly visibility?: ZoneVisibility;
  /** Requested prompt content rows (geometry caps at 40%). Default 3. */
  readonly promptContentRows?: number;
  /** Pending queue count seed. Default 0. */
  readonly pendingQueue?: number;
  /** Wire Tab + product keys (Enter/Alt+Enter/Ctrl+C/Esc/overlay). Default true. */
  readonly wireKeys?: boolean;
  /** Mount shell.root on renderer.root. Default true. */
  readonly mount?: boolean;
  /** Initial terminal size override (tests). Defaults to renderer.width/height. */
  readonly terminal?: { readonly columns: number; readonly rows: number };
  /** Simulated agent run state. Default "busy" (queue-default mid-run). */
  readonly run?: RunState;
  /** Overlay list labels for inset demo. */
  readonly overlayItems?: readonly string[];
  /**
   * Default palette catalog when `openPalette` is called without `catalog`.
   * Host typically passes `buildPaletteCatalog({ commands: listCommands() })`.
   * Static array or lazy builder. Defaults to residual openers only.
   */
  readonly paletteCatalog?:
    | readonly PaletteCommand[]
    | (() => readonly PaletteCommand[]);
  /**
   * Invoked when a registry-backed palette item is accepted (`dispatch: "command"`).
   * Residual openers never hit this path.
   */
  readonly onCommand?: PaletteOnCommand;
  /**
   * Invoked when the palette "observe" action runs. Returns the live
   * `ObserveSession` to enter, or `null` when no subagent is running.
   * Unset (demo/smoke) falls back to `makeObserveFixture()`.
   */
  readonly onObserveRequest?: PaletteOnObserveRequest;
  /**
   * First-run telemetry disclosure for the landing screen. Omitted once the
   * notice has been shown, so it is not permanent chrome.
   */
  readonly telemetryNotice?: string;
  /**
   * Suppress landing snow and mountain motion. The idle timer is not
   * armed, and `paintLanding` holds a still mountain with no flakes.
   */
  readonly reducedMotion?: boolean;
  /**
   * Clipboard port for Alt+C and drag-select auto-copy. Defaults to an
   * in-memory recorder so tests and demos never shell out; the product host
   * injects the system clipboard.
   */
  readonly clipboard?: ClipboardPort;
  /**
   * Mouse-reporting switch behind Alt+M. Absent means the shell has no
   * renderer-level control (tests, demos) and reports the toggle unavailable.
   * While reporting is on, OpenTUI owns drag-select and auto-copies on
   * mouse-up; Alt+M hands the mouse back for native terminal selection.
   */
  readonly mouseCapture?: MouseCapturePort;
  /**
   * How timed flashes arm their expiry. Injectable so tests can lapse a
   * confirmation window without waiting out `RUNTIME_FLASH_MS`.
   */
  readonly flashSchedule?: FlashSchedule;
}

/**
 * Renderer-level DEC mouse reporting control. While reporting is on the
 * terminal hands drags to OpenTUI (drag-to-copy on mouse-up); Alt+M hands
 * reporting back so the terminal can run its own selection again.
 */
export interface MouseCapturePort {
  readonly get: () => boolean;
  readonly set: (enabled: boolean) => void;
}

export interface AppShell {
  readonly renderer: ShellRenderer;
  readonly root: BoxRenderable;
  /** Blank rows above the first transcript row (0 on short terminals). */
  readonly topPad: BoxRenderable;
  /** Blank row below the prompt box (0 on short terminals). */
  readonly bottomPad: BoxRenderable;
  /**
   * Build version's row, pinned to the terminal's last line and right-aligned
   * (persistent chrome, not part of the landing composition — visible
   * whether or not landing is showing). Hides on a narrow/short terminal,
   * ahead of anything actionable (`versionBadgeVisible`).
   */
  readonly versionRow: BoxRenderable;
  /**
   * Optional chrome zones (constitution task/agents). Distinct panels: a
   * task is a unit of work with a status, an agent is an executor.
   * One row per rendered task-panel line; rebuilt whenever the line count
   * or any row's status changes.
   */
  readonly taskBox: BoxRenderable;
  /** One row per rendered agents-panel line; rebuilt whenever the line count changes. */
  readonly agentsBox: BoxRenderable;
  readonly transcript: ScrollBoxRenderable;
  readonly overlayView: ReturnType<typeof createOverlayView>;
  readonly overlayHost: BoxRenderable;
  readonly overlayTitle: TextRenderable;
  readonly overlayBody: BoxRenderable;
  readonly prompt: PromptInput;
  readonly promptBox: BoxRenderable;
  /** The input's own row, bordered left and right only. */
  readonly promptField: BoxRenderable;
  /** Top border of the prompt box — carries the model label. */
  readonly promptTopRule: TextRenderable;
  /** Bottom border — carries the brand lockup and the workspace label. */
  readonly promptBottomRule: TextRenderable;
  /** Transient state row above the prompt box (hidden when it has nothing to say). */
  readonly notice: TextRenderable;
  /** Latest geometry resolution (updated on resize / relayout). */
  layout: GeometryLayout;
  /** Focus tree + scroll lease (updated by shell helpers). */
  focus: FocusState;
  /** Session queue / steer / interrupt bag. */
  session: SessionQueueState;
  /** Pending queue count (mirrors badgeCount(session)). */
  pendingQueue: number;
  /** Transcript line count (append counter / full log length). */
  lineCount: number;
  /**
   * Retained tail of the stream log — capped at MAX_RETAINED_STREAM_ROWS, so
   * this is never the full session history on a long run.
   */
  streamLog: StreamRow[];
  /**
   * Absolute index of `streamLog[0]`. Every index the bridge holds onto
   * across calls (tool-call rows, the open streaming row, the retry
   * boundary) is absolute, so it stays valid once eviction has shifted the
   * array itself. Bumped by the number of rows dropped on each trim.
   */
  streamLogBase: number;
  /**
   * Distinct writers in the visible transcript. Rows carry a name and icon only
   * once this holds more than one, so identity appears where it disambiguates.
   */
  agentVoices: Set<string>;
  /**
   * Session name. Held for hosts that rename a session; it is not chrome —
   * an unnamed session shows nothing rather than a placeholder.
   */
  baseTitle: string;
  /** Composed `profile · model · effort` label carried by the top border. */
  modelLabel: string | null;
  /** Working directory and git branch carried by the bottom border. */
  workspace: { cwd: string; branch: string | null };
  /** Overlay list state (null when closed). */
  overlayList: OverlayList | null;
  /** Overlay item labels currently shown. */
  overlayItems: readonly string[];
  /** Which primary overlay is open (null when closed). */
  overlayKind: PrimaryOverlayKind | null;
  /** Optional long body lines painted above the list (operator question). */
  overlayBodyLines: readonly string[];
  /** Palette role per body line, aligned with overlayBodyLines. */
  overlayBodyFgs: readonly string[];
  /** Palette command ids aligned with overlayItems when kind is palette. */
  paletteCommands: readonly PaletteCommand[];
  /** Clipboard port for keyboard copy (tests inject recording port). */
  clipboard: ClipboardPort;
  /** Mouse-reporting control for Alt+M, or null when the host has none. */
  mouseCapture: MouseCapturePort | null;
  /**
   * Frozen copy targets while the copy overlay is open (null when closed).
   * Confirm writes from this snapshot, not live streamLog.
   */
  copyTargets: readonly CopyTarget[] | null;
  /**
   * Short transient flash (copy feedback, etc.). Cleared when replaced or
   * set to null; never appended to the stream log.
   */
  statusFlash: string | null;
  /** MCP servers awaiting authorization; the top rule carries `mcp !`. */
  mcpNeedsAuth: readonly string[];
  /**
   * Plugin load left standing warnings (skill misses, failed tool starts, …).
   * The top rule carries `plugin !` (or `mcp ! · plugin !` with MCP). Cleared
   * only when the warning set is empty — not merely dismissed.
   */
  pluginNeedsAttention: boolean;
  /**
   * Clock, motion and content state for the bottom-left status slot. The bridge
   * pushes all of it off its existing monitor tick (`setLockupFrame`); the
   * shell never reads a clock of its own, so a shell without a bridge simply
   * paints the settled idle slot.
   */
  lockupNowMs: number;
  /**
   * Parent tool currently in flight, for the steer `waiting on` notice.
   * Null when no parent tools remain or the run is idle. Not TurnState.
   */
  inFlightTool: { name: string; startedAt: number } | null;
  lockupAnimating: boolean;
  /**
   * Live activity state the slot shows, or null for the idle wordmark.
   * Typed to the closed set (not `string`) so a raw tool/MCP/plugin
   * identifier reaching this field is a compile error, not just a test one.
   */
  lockupPhase: ActivityState | null;
  /** Clock reading when `lockupPhase` last changed — the fade's origin. */
  lockupChangedMs: number;
  /** Density ramp phase for the same turn — drives the slot's pulse cell and tint. */
  lockupRampPhase: RampPhase | null;
  /** How long the turn has been stalled, or null when it is not — bounds the blink. */
  lockupStalledForMs: StallAge;
  /**
   * Cost/context meter carried by the bottom border, or null when the active
   * session has nothing to report (context window unknown). Pushed by the
   * host whenever the run sink's usage changes — no timer of its own.
   */
  costContext: CostContextMeter | null;
  /**
   * Active subagent observe session (null when viewing parent).
   * Independent stream window; Esc restores parent lease.
   */
  observe: {
    sessionId: string;
    agentId: string;
    description: string;
    lines: StreamRow[];
  } | null;
  /** Parent stream snapshot while observe is active. */
  parentStreamLog: StreamRow[] | null;
  /** Absolute base for `parentStreamLog`, saved/restored across observe (see `streamLogBase`). */
  parentStreamLogBase: number | null;
  /**
   * Readline kill ring backing Ctrl+Y/Alt+Y. Ctrl+K/U/W and Alt+D feed it;
   * the text widget itself has no concept of a kill ring (see
   * ./prompt-kill-ring.js).
   */
  promptKillRing: KillRing;
  /** Images attached with Ctrl+P, sent with the next prompt submit. */
  pendingAttachments: PendingImageAttachment[];
  /** Up/Down recall of messages already sent in this session. */
  sentHistory: SentHistoryBrowse;
  /** Detach key/resize listeners and unmount root. */
  dispose: () => void;
  /**
   * True once `dispose` has run. Paint entry points read this: a caller that
   * outlives the shell — a poll timer, a resolved async continuation — would
   * otherwise write into renderables whose native buffers are already freed.
   */
  disposed: boolean;
}

export type PrimaryOverlayKind =
  | "permissions"
  | "operator"
  | "model_picker"
  | "add_provider"
  | "demo"
  | "palette"
  | "settings"
  | "help"
  | "plugins"
  | "resume"
  | "mentions"
  | "copy"
  | "hooks"
  | "mcp"
  | "plugin_credentials";

/** Whether the transcript viewport is stuck to the bottom (FOLLOW vs PINNED). */
export function isTranscriptFollowing(shell: AppShell): boolean {
  const { transcript } = shell;
  const max = Math.max(0, transcript.scrollHeight - transcript.height);
  return transcript.scrollTop >= max - 1;
}

/** Sticky-scroll mode label (surfaced on the notice row only when PINNED). */
export function stickyMode(shell: AppShell): "FOLLOW" | "PINNED" {
  return isTranscriptFollowing(shell) ? "FOLLOW" : "PINNED";
}

/**
 * How a timed flash arms its own expiry. Injectable so tests can lapse a
 * window without waiting out its real duration; returns the cancel.
 */
export type FlashSchedule = (fn: () => void, ms: number) => () => void;

export interface FlashOptions {
  /** Lifetime of the flash; omitted means it stays until something replaces it. */
  readonly ttlMs?: number;
  readonly schedule?: FlashSchedule;
}

/** Cancel for the flash currently counting down, per shell. */
export const flashTimers = new WeakMap<AppShell, () => void>();

/** Per-shell override for how timed flashes arm their expiry (tests). */
export const shellFlashSchedules = new WeakMap<AppShell, FlashSchedule>();

/**
 * Free-text answer field an overlay can offer alongside (or instead of) its
 * choices. `active` is whether keystrokes are going into it rather than into
 * list navigation — the row is painted either way, so the affordance is on
 * screen rather than behind a chord nobody knows about.
 */
export interface OverlayAnswerState {
  text: string;
  active: boolean;
  readonly onSubmit: (text: string) => void;
}

/** Item window the SelectRenderable currently shows. */
export interface OverlayListRange {
  /** Inclusive start index into the full list. */
  readonly start: number;
  /** Exclusive end index into the full list. */
  readonly end: number;
}

/**
 * The open overlay's list, backed by @opentui/core's SelectRenderable.
 * OpenTUI owns selection clamping, movement and scroll-keep-visible; this
 * wrapper exposes the item-count view the shell reads (the renderable counts
 * terminal rows, `rowsPerItem` converts) and rebuilds the renderable when its
 * geometry changes, because the renderable only recomputes its visible-item
 * capacity in its constructor and renderer resize callbacks.
 */
export interface OverlayList {
  readonly select: SelectRenderable;
  readonly activeIndex: number;
  /** Item-row capacity reserved by layout (not the renderable's row height). */
  readonly height: number;
  readonly offset: number;
  readonly count: number;
  move(delta: number): void;
  page(dir: -1 | 1): void;
  jump(index: number): void;
  setCount(count: number): void;
  setHeight(items: number, rowsPerItem?: number): void;
  visibleRange(): OverlayListRange;
}

interface PrimaryOverlayBindings {
  /** Optional stable ids aligned with overlayItems for the open primary. */
  itemIds: readonly string[];
  /** Optional plain chosen values aligned with overlayItems for the open primary. */
  itemValues: readonly (string | undefined)[];
  /** Per-open accept callback; cleared on close without invoke (Esc path). */
  onAccept: ((selection: OverlaySelection) => void) | null;
  /** Per-open expand/collapse hook for the open primary overlay. */
  onToggleExpand: (() => void) | null;
  /** Per-open ← → cycle hook for the open primary overlay (settings inline cycling). */
  onCycle: ((itemId: string, direction: -1 | 1) => void) | null;
  /** Per-open description-zone source; null keeps the zone off (no rows charged). */
  describe: ((itemId: string) => ItemDescription | null) | null;
  /** Per-open bare-key claim for the open primary overlay. */
  onAction: ((itemId: string, key: KeyEvent) => boolean) | null;
  /** Per-open bracketed-paste owner for synthetic text panes. */
  onPaste: ((text: string) => void) | null;
  /**
   * Per-open dismiss hook for promise-backed overlays (permissions, operator).
   * Esc/closeInsetOverlay invokes this instead of silently dropping the
   * pending promise the way palette/mentions/copy overlays correctly do.
   */
  onCancel: (() => void) | null;
  /**
   * Per-open cleanup for a replaced or dismissed overlay (MCP unsubscribe).
   * closeReplaceableOverlay still runs this; it skips onCancel so
   * Esc-only navigation (add-provider back to models) does not fire.
   */
  onDispose: (() => void) | null;
  /** True while the open primary is a decision gate that must not be replaced. */
  isGate: boolean;
  /** Whether the open primary advertises Alt+A and yields å/Å from type-to-filter. */
  addProviderHint: boolean;
  /** Whether the open primary advertises Alt+D in the footer hints. */
  setDefaultHint: boolean;
  /** Whether the open `/mcp` list advertises Alt+D / Alt+R. */
  mcpManageHint: boolean;
  /** Whether the open `/mcp` list advertises Alt+A add. */
  mcpAddHint: boolean;
}

export const EMPTY_PRIMARY_BINDINGS: Readonly<PrimaryOverlayBindings> = {
  itemIds: [],
  itemValues: [],
  onAccept: null,
  onToggleExpand: null,
  onCycle: null,
  describe: null,
  onAction: null,
  onPaste: null,
  onCancel: null,
  onDispose: null,
  isGate: false,
  addProviderHint: false,
  setDefaultHint: false,
  mcpManageHint: false,
  mcpAddHint: false,
};

interface PriorOverlaySnapshot {
  readonly kind: PrimaryOverlayKind | null;
  readonly items: readonly string[];
  readonly bodyLines: readonly string[];
  readonly bodyFgs: readonly string[];
  readonly list: OverlayList;
  readonly title: string;
  readonly paletteCommands: readonly PaletteCommand[];
  readonly primaryBindings: Readonly<PrimaryOverlayBindings>;
  readonly answer: OverlayAnswerState | null;
  readonly titleText: string;
}

interface ShellInternals {
  visibility: ZoneVisibility;
  promptContentRows: number | undefined;
  overlayMode: OverlayMode;
  overlayBodyRows: number | undefined;
  overlayMinBodyRows: number | undefined;
  /**
   * Raw (unwrapped) text last passed to `applyOverlayBodyText`, kept so a
   * resize can re-shape a decision overlay's body against the new height's
   * context budget instead of leaving it fixed at whatever it opened with.
   */
  overlayRawBodyText: string;
  /** Snapshot when palette stacks over another primary overlay. */
  priorOverlay: PriorOverlaySnapshot | null;
  /** Advances on a new overlay taking the host, and when the host empties. */
  overlayGeneration: number;
  primaryBindings: PrimaryOverlayBindings;
  /** False while an overlay that reports its own outcome is open. */
  overlayEchoChoice: boolean;
  /**
   * While true the shell ignores its own key/paste/submit handlers. Set for
   * the lifetime of a full-screen surface (inline provider connect) that
   * shares this renderer — two live key handlers on one stdin would both
   * act on every keystroke.
   */
  inputSuspended: boolean;
  /** Per-open free-text answer field, when the overlay opted into one. */
  overlayAnswer: OverlayAnswerState | null;
  /** Bare title of the open overlay, so its key hints can be re-composed. */
  overlayTitleText: string;
  /** Fired once the overlay host is idle, so queued gates can re-open. */
  overlayClosedListeners: Set<() => void>;
  /**
   * Command-surface open while a live overlay still holds the host. One slot;
   * a newer command replaces an older one. Flushed only after that overlay
   * has actually closed and the host is idle — never from idle-notify, which
   * would let wireGates drain a queued gate onto the same host.
   */
  deferredCommandOverlay: OpenListOverlayOpts | null;
  /** True while a microtask to flush deferredCommandOverlay is queued. */
  deferredFlushScheduled: boolean;
  /**
   * Host-owned holds that outlive overlayList being null (async /settings
   * list(), etc.). While > 0, idle-notify must not fire so a queued gate
   * cannot drain into the gap before the surface paints.
   */
  overlayHostReservations: number;
  /**
   * Advanced when Esc aborts in-flight reservations so a stale `release()`
   * cannot decrement a newer hold.
   */
  overlayReservationEpoch: number;
  /**
   * Registry-backed `/` command catalog (static or lazy), host-injected. Empty
   * when unset.
   */
  paletteCatalog:
    | readonly PaletteCommand[]
    | (() => readonly PaletteCommand[])
    | null;
  /** Live filter state for the open palette, so typing can re-filter it. */
  paletteFilter: PaletteFilterState | null;
  /** Live type-to-filter state for a non-palette list overlay (model picker). */
  listFilter: ListFilterState | null;
  /**
   * Landing composition shown while the transcript has no content: the mark
   * above the prompt box, the disclosure and starters below it. Dropped (not
   * hidden) on the first row so it never occupies a transcript line later.
   */
  landing: {
    readonly above: LandingAbove;
    readonly below: BoxRenderable;
  } | null;
  /**
   * The disclosure the landing is showing. Re-appended to the transcript when
   * the landing tears down so consent-by-proceeding leaves a durable record
   * rather than a screen the first prompt wipes.
   */
  landingNotice: string | null;
  /**
   * System/runtime notices that arrived while the landing was still up (MCP
   * load failures, width-contract warnings, hook failures). Held here and
   * painted on the notice strip so they never call `clearLandingMark`; flushed
   * into the transcript when the first real session row ends the landing.
   */
  landingDeferredRows: StreamRow[];
  /** What the rows below the box are painting, so they can be repainted. */
  landingBelow: LandingBelowContent | null;
  /** Starters are offered only while the prompt is empty. */
  landingSuggestionsVisible: boolean;
  /** Whether the last painted mark frame was a moving one. */
  landingAnimating: boolean;
  /** Clock of the last painted mark frame, so a resize can redraw in place. */
  landingNowMs: number;
  /**
   * Mount-time reduced-motion flag. When true, the idle snow timer is
   * never armed and every landing paint holds a still mountain with no
   * flakes. Set once at `createAppShell`; not a per-paint argument.
   */
  reducedMotion: boolean;
  /**
   * Cancels the mount-scoped idle repaint timer armed in `createAppShell`,
   * or null while none is armed. Cleared by whichever teardown happens
   * first — the landing going away (`clearLandingMark`) or the whole shell
   * disposing (`dispose`) — so it can never outlive either.
   */
  landingIdleTimerCancel: (() => void) | null;
  /** Chrome content (empty array = zone off). */
  chrome: {
    /**
     * Rendered task rows — empty when there is nothing to show OR the panel
     * is hidden by the operator toggle. `tasksRaw` holds the live data
     * independent of that toggle, so un-hiding shows the current list
     * without waiting on the next manage_tasks write.
     */
    task: readonly TaskPanelRow[];
    /** Last live task rows pushed via setChromeZones, regardless of hidden state. */
    tasksRaw: readonly TaskPanelRow[];
    /** Agents panel rows (empty array = zone off), one row per rendered line. */
    agents: readonly AgentPanelRow[];
  };
  /** Operator toggle for the task panel; in-memory, held for the life of the shell. */
  tasksPanelHidden: boolean;
}

export const internals = new WeakMap<AppShell, ShellInternals>();

/**
 * Leading filler row inside the transcript's scroll content. Bottom-anchors a
 * short transcript against the prompt box below: sized to the leftover
 * viewport space so few rows sit at the foot of the zone instead of stranded
 * at its top. Once rows fill the viewport the filler settles at zero and
 * sticky-scroll behaves exactly as it did before this existed.
 *
 * A real child rather than padding: the content box's `minHeight: "100%"`
 * (`@opentui/core`'s own default, so it never reads shorter than the
 * viewport) means padding cannot be measured back out of `scrollHeight` —
 * it always reads as the viewport height regardless of how little real
 * content there is. A child's own height is unaffected by that floor, so
 * `scrollHeight - spacer.height` reliably isolates the rows' real height.
 *
 * This does cost every row-index code path (`getChildren()`-based lookups
 * below, and the two external tests noted at their call sites) one constant
 * offset: index 0 is always the spacer, never a row.
 */
export const transcriptSpacers = new WeakMap<AppShell, BoxRenderable>();

/** True while the landing composition is still mounted. */
export function isLanding(shell: AppShell): boolean {
  return (internals.get(shell)?.landing ?? null) !== null;
}

export interface OpenListOverlayOpts {
  readonly kind?: PrimaryOverlayKind;
  readonly title?: string;
  readonly items?: readonly string[];
  /** Optional stable ids aligned with `items` (permission scope ids, model ids). */
  readonly itemIds?: readonly string[];
  /**
   * Optional plain chosen-value aligned with `items`, for rows whose display
   * label carries more than the value itself (a cycled field's name, padding,
   * and `‹ ›` markers around the active option). The accept echo reads this
   * instead of recovering the value by parsing the label back apart.
   */
  readonly itemValues?: readonly (string | undefined)[];
  readonly body?: string;
  readonly activeIndex?: number;
  readonly frameId?: string;
  /**
   * Per-open accept callback. Takes precedence over shell-level overlay hooks
   * for this open. Not invoked on Esc / closeInsetOverlay.
   */
  readonly onAccept?: (selection: OverlaySelection) => void;
  /**
   * Per-open expand/collapse hook. When set, the modal overlay claims a bare
   * key for it (see OVERLAY_EXPAND_KEY) — no global binding is needed because
   * the overlay owns the keyboard while it is open.
   */
  readonly onToggleExpand?: () => void;
  /**
   * Per-open ← → cycle hook. When set, the overlay claims Left/Right for it
   * instead of leaving them unbound — settings-style inline value cycling.
   * Scoped to this open only, the way `onToggleExpand` and `typeToFilter` are.
   */
  readonly onCycle?: (itemId: string, direction: -1 | 1) => void;
  /**
   * Per-open Esc/dismiss hook for promise-backed overlays (permissions,
   * operator). Invoked by closeInsetOverlay before the accept path is
   * cleared, so the caller's awaited promise resolves instead of hanging.
   */
  readonly onCancel?: () => void;
  /**
   * Per-open cleanup for replace and dismiss. closeReplaceableOverlay
   * invokes this and skips `onCancel`, which is Esc/dismiss only.
   */
  readonly onDispose?: () => void;
  /**
   * True when this open is a permission/operator decision gate. Command
   * surfaces call `closeReplaceableOverlay` to free the host; that no-ops
   * while this is set so a live gate is not torn down.
   */
  readonly isGate?: boolean;
  /**
   * Invoked only after this open actually takes the host (including a
   * deferred flush). Busy no-ops and deferred stashes do not run it.
   */
  readonly onOpened?: () => void;
  /**
   * Description-zone source. Called with the focused item's id on every move
   * (falling back to its label when no `itemIds` were supplied). Returning
   * null renders the zone blank, not collapsed — the fixed two-line zone is
   * charged to the row budget whenever this is set, whether or not the current
   * item has anything to say.
   */
  readonly describe?: (itemId: string) => ItemDescription | null;
  /**
   * Per-open bare-key claim, checked before list navigation. Returning false
   * leaves the key available to the ordinary j/k and arrow handlers. Scoped to
   * this open only, so it cannot shadow prompt typing.
   */
  readonly onAction?: (itemId: string, key: KeyEvent) => boolean;
  /** Per-open bracketed-paste target for synthetic text panes. */
  readonly onPaste?: (text: string) => void;
  /**
   * Per-open free-text answer. When set the overlay paints an answer field the
   * operator can Tab into and type into, and submitting it closes the overlay
   * through this callback instead of the selection path.
   */
  readonly onTextAnswer?: (text: string) => void;
  /**
   * Open with the answer field already taking keystrokes. Used when there is
   * nothing to choose, so the overlay is never a chooser with an empty list.
   */
  readonly textAnswerActive?: boolean;
  /**
   * Suppress the `chose (kind): label` transcript echo for this open.
   *
   * The echo exists so a choice with no other visible result still leaves a
   * trace. A surface that reports the outcome itself does not need it, and the
   * echo is worse than silent there: it quotes the row's label from *before*
   * the action, so authorizing a server leaves a permanent line saying that
   * server needs authorization.
   */
  readonly echoChoice?: boolean;
  /**
   * Claim printable keys for a `>` filter row so the list narrows as you type.
   * Opt-in per open (model picker, palette, resume). Overlays without it keep j/k
   * navigation; with it, j/k type into the filter and arrows still navigate.
   */
  readonly typeToFilter?: boolean;
  /**
   * Advertise Alt+A and /connect in the footer and yield composed Option+A
   * (å/Å) from type-to-filter. Set only when the caller actually wired an
   * add-provider handler via `onAction`, so the hint never names a dead chord.
   */
  readonly addProviderHint?: boolean;
  /**
   * Advertise the Alt+D set-default hint in the footer for this open. Set
   * only when the caller actually wired an Alt+D handler via `onAction`.
   */
  readonly setDefaultHint?: boolean;
  /**
   * Advertise Alt+D disable / Alt+R remove in the `/mcp` footer. Confirm
   * overlays leave this unset so they fall back to DEFAULT_OVERLAY_HINTS.
   */
  readonly mcpManageHint?: boolean;
  /**
   * Advertise Alt+A add in the `/mcp` footer. False while local settings
   * shadow global MCP (add is hidden and Alt+A is a dead chord).
   */
  readonly mcpAddHint?: boolean;
  /**
   * When the host is already showing a non-palette overlay, stash this open
   * in the one deferred slot and print a system line. Off by default: a
   * busy open is a silent no-op (demo, mentions, same-kind re-open of
   * surfaces that do not call `closeReplaceableOverlay` first).
   */
  readonly deferIfBusy?: boolean;
}

/** Palette open state that survives a re-filter. */
interface PaletteFilterState {
  query: string;
  readonly title: string;
  readonly catalog: readonly PaletteCommand[] | null;
  readonly typeToFilter: boolean;
}

/**
 * Live type-to-filter state for a non-palette list overlay (model picker).
 * Holds the full unfiltered row set so each keystroke can re-narrow in place
 * without reopening the overlay (a busy open is a silent no-op unless
 * `deferIfBusy` is set).
 */
interface ListFilterState {
  query: string;
  readonly allItems: readonly string[];
  readonly allItemIds: readonly string[];
  readonly allItemValues: readonly (string | undefined)[];
}

export interface MentionAcceptState {
  readonly suggestions: readonly string[];
  readonly generation: number;
  readonly atStart: number;
}

export const mentionPopups = new WeakSet<AppShell>();

export const mentionGenerations = new WeakMap<AppShell, number>();

export const mentionAcceptState = new WeakMap<AppShell, MentionAcceptState>();

/** Drop accept state and invalidate in-flight lookups on operator dismiss. */
export function clearMentionAccept(shell: AppShell): void {
  mentionAcceptState.delete(shell);
  mentionGenerations.set(shell, (mentionGenerations.get(shell) ?? 0) + 1);
}

/** Live accept snapshot, or null when there is no state, generation is stale, or the cursor left this @. */
export function liveMentionAccept(
  shell: AppShell,
): { state: MentionAcceptState; live: AtState } | null {
  const state = mentionAcceptState.get(shell);
  if (state === undefined) return null;
  if (mentionGenerations.get(shell) !== state.generation) return null;
  const live = parseAtState(shell.prompt.value, shell.prompt.cursorOffset);
  if (live === null || live.atStart !== state.atStart) return null;
  return { state, live };
}

export const slashPopups = new WeakSet<AppShell>();

/** True while the `/` command popup owns typed characters. */
export function isSlashPopupOpen(shell: AppShell): boolean {
  return slashPopups.has(shell) && shell.overlayList !== null;
}

/**
 * Popup query = prompt text after the leading `/`. Null once the operator has
 * typed whitespace: at that point the name is settled and the rest is arguments.
 */
export function slashPopupQuery(shell: AppShell): string | null {
  const value = shell.prompt.value;
  if (!value.startsWith("/")) return null;
  const head = value.slice(1);
  return /\s/.test(head) ? null : head;
}

export function shellInternals(shell: AppShell): ShellInternals | undefined {
  return internals.get(shell);
}

export function initShellInternals(shell: AppShell, bag: ShellInternals): void {
  internals.set(shell, bag);
}

export function setTranscriptSpacer(
  shell: AppShell,
  spacer: BoxRenderable,
): void {
  transcriptSpacers.set(shell, spacer);
}
