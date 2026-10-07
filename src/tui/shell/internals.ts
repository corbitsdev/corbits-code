/**
 * Shared shell state: AppShell surface types, the ShellInternals bag, per-shell
 * WeakMap registries. Imports no sibling shell module.
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
import type { ActivityState } from "../chrome-state.js";
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
import { type RunState, type SessionQueueState } from "../delivery-queue.js";
import { type StreamRow } from "../stream.js";
import { createOverlayView } from "../overlay-view.js";
import { type KillRing } from "../prompt-kill-ring.js";

export const shellExitHandlers = new WeakMap<AppShell, () => void>();

/** Bare `exit`/`quit` quits through finalize, same path as Ctrl+C twice — not
 * the cleanup-skipping exit route. */
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
  /** Enter on a selected pending item delivers it now, skipping its wait
   * (absent where the host cannot). */
  onForceDeliver?: (itemId: string) => void;
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
 * Second-press stop affordance for CL-10149 follow-up. The shell key layer
 * stays service-free; the runner registers a live-worker-count getter and a
 * stop-workers callback so `handleCtrlC` can distinguish "stop the active
 * sub-agents, app keeps running" from a real quit without touching the service
 * layer (see SOLUTION_SCOPE D1/D2).
 */
export interface ShellStopAffordance {
  /** Live, faithful fleet count (liveFleetCount over session-store list). */
  liveWorkerCount: () => number;
  /** Stop all active sub-agents; app stays running. Idempotent. */
  onStopWorkers: () => void | Promise<void>;
}

const shellStopAffordances = new WeakMap<AppShell, ShellStopAffordance>();

export function setShellStopAffordance(
  shell: AppShell,
  affordance: ShellStopAffordance | undefined,
): void {
  if (affordance) shellStopAffordances.set(shell, affordance);
  else shellStopAffordances.delete(shell);
}

export function getShellStopAffordance(
  shell: AppShell,
): ShellStopAffordance | undefined {
  return shellStopAffordances.get(shell);
}

/** Focused overlay row: what it is and what choosing it costs. Painted under
 * overlay lists that opt in via `describe`. */
export interface ItemDescription {
  /** One-line description of the focused thing. */
  readonly what: string;
  /** One-line cost or effect of choosing it. */
  readonly impact?: string;
  /** `consequence` paints impact in UI.warning — anything that spends or extends reach (billing, trust). */
  readonly tone?: "plain" | "consequence";
}

/** Fired when the operator accepts an overlay selection; hosts map it into
 * ApprovalOutcome / OperatorResult / a model switch. */
export interface OverlaySelection {
  readonly kind: PrimaryOverlayKind;
  readonly index: number;
  readonly label: string;
  /** Stable id, when the host supplied `itemIds`. */
  readonly id?: string;
  /** Plain chosen value, when the host supplied `itemValues`. */
  readonly value?: string;
}

/** Shell-level overlay accept hooks: authz, ask_operator, settings. Kind-specific
 * hooks win over `onSelect`; a per-open `onAccept` wins for that open. */
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

/** Palette selection handler (`dispatch: "command"`); the palette never imports
 * the registry. */
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

/** Clipboard image reader behind Ctrl+P. Injectable so tests and non-macOS
 * hosts avoid osascript. */
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

/** Palette "observe" handler: the live `ObserveSession` to enter, or `null`
 * when none runs. Unset keeps demo/smoke on `makeObserveFixture()`. */
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
  /** Simulated agent run state. Default "busy". */
  readonly run?: RunState;
  /** Overlay list labels for inset demo. */
  readonly overlayItems?: readonly string[];
  /** Default palette catalog when `openPalette` has no `catalog` (array or lazy builder). */
  readonly paletteCatalog?:
    | readonly PaletteCommand[]
    | (() => readonly PaletteCommand[]);
  /** Palette item accepted (`dispatch: "command"`); residual openers never hit this path. */
  readonly onCommand?: PaletteOnCommand;
  /** "observe" ran: the `ObserveSession` to enter, or `null` when none runs. */
  readonly onObserveRequest?: PaletteOnObserveRequest;
  /** First-run telemetry disclosure for the landing. Omitted once shown. */
  readonly telemetryNotice?: string;
  /** Suppress landing snow/motion: no idle timer; still mountain, no flakes. */
  readonly reducedMotion?: boolean;
  /** Clipboard port for Alt+C and drag-select auto-copy; defaults to an
   * in-memory recorder, the product host injects the system clipboard. */
  readonly clipboard?: ClipboardPort;
  /** Mouse-reporting switch behind Alt+M (see MouseCapturePort). */
  readonly mouseCapture?: MouseCapturePort;
  /** How timed flashes arm their expiry; injectable so tests skip `RUNTIME_FLASH_MS`. */
  readonly flashSchedule?: FlashSchedule;
}

/** Renderer-level DEC mouse reporting. On: drags reach OpenTUI (drag-to-copy
 * on mouse-up); Alt+M hands reporting back to the terminal's selection. */
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
  /** Build version row: the terminal's last line, right-aligned; hides on
   * narrow/short terminals. */
  readonly versionRow: BoxRenderable;
  /** Task chrome zone: one row per rendered line; rebuilt on line/status changes. */
  readonly taskBox: BoxRenderable;
  /** Agents-panel zone: one row per line; rebuilt on line-count changes. */
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
  /** Queued steer/follow-up items above the prompt box, one row each while
   * pending; hidden when empty. Geometry owns the row budget (zone `pending`). */
  readonly pendingBox: BoxRenderable;
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
  /** Stream-log tail, capped at MAX_RETAINED_STREAM_ROWS. */
  streamLog: StreamRow[];
  /** Absolute index of `streamLog[0]`; keeps bridge-held indices valid across eviction. */
  streamLogBase: number;
  /** Older history on disk not loaded into this window. Independent of
   * `streamLogBase`: a truncated resume that fits the cap splices nothing. */
  unloadedHistory: boolean;
  /** Distinct transcript writers; rows get a name/icon only once >1. */
  agentVoices: Set<string>;
  /** Session name, for hosts that rename; unnamed shows nothing (not chrome). */
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
  /** Copy targets while the copy overlay is open (null when closed); confirm
   * writes from this snapshot, not live streamLog. */
  copyTargets: readonly CopyTarget[] | null;
  /** Short transient flash (copy feedback, …); replaced or cleared, never logged. */
  statusFlash: string | null;
  /** MCP servers awaiting authorization; the top rule carries `mcp !`. */
  mcpNeedsAuth: readonly string[];
  /** Standing plugin warnings (skill misses, failed tool starts); the top rule
   * carries `plugin !` (or `mcp ! · plugin !` with MCP). */
  pluginNeedsAttention: boolean;
  /** Clock and motion state for the bottom-left status slot; the bridge pushes
   * it off its monitor tick. */
  lockupNowMs: number;
  /** Parent tool in flight, for the steer `waiting on` notice; null when idle. Not TurnState. */
  inFlightTool: { name: string; startedAt: number } | null;
  lockupAnimating: boolean;
  /** Live activity state the slot shows, or null for the idle wordmark. */
  lockupPhase: ActivityState | null;
  /** Clock reading when `lockupPhase` last changed — the fade's origin. */
  lockupChangedMs: number;
  /** Density ramp phase for the turn — drives the pulse cell and tint. */
  lockupRampPhase: RampPhase | null;
  /** Stall duration, or null when not stalled — bounds the blink. */
  lockupStalledForMs: StallAge;
  /** Cost/context meter for the bottom border, or null when nothing to report;
   * pushed by the host, not a timer. */
  costContext: CostContextMeter | null;
  /** Active subagent observe session (null when viewing parent); Esc restores
   * the parent lease. */
  observe: {
    sessionId: string;
    agentId: string;
    description: string;
    lines: StreamRow[];
  } | null;
  /** Parent stream snapshot while observe is active. */
  parentStreamLog: StreamRow[] | null;
  /** Absolute base for `parentStreamLog` (see `streamLogBase`). */
  parentStreamLogBase: number | null;
  /** Saved `unloadedHistory` for the parent snapshot while observing. */
  parentUnloadedHistory: boolean | null;
  /** Readline kill ring backing Ctrl+Y/Alt+Y; the text widget has none (see ./prompt-kill-ring.js). */
  promptKillRing: KillRing;
  /** Images attached with Ctrl+P, sent with the next prompt submit. */
  pendingAttachments: PendingImageAttachment[];
  /** Up/Down recall of messages already sent in this session. */
  sentHistory: SentHistoryBrowse;
  /** Detach key/resize listeners and unmount root. */
  dispose: () => void;
  /** True once `dispose` has run; paint paths avoid writing into freed renderables. */
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

/** How a timed flash arms its expiry; injectable so tests can lapse it early.
 * Returns the cancel. */
export type FlashSchedule = (fn: () => void, ms: number) => () => void;

export interface FlashOptions {
  /** Flash lifetime; omitted means it stays until replaced. */
  readonly ttlMs?: number;
  readonly schedule?: FlashSchedule;
}

/** Cancel for the flash currently counting down, per shell. */
export const flashTimers = new WeakMap<AppShell, () => void>();

/** Per-shell override for how timed flashes arm their expiry (tests). */
export const shellFlashSchedules = new WeakMap<AppShell, FlashSchedule>();

/** Free-text answer field an overlay can offer; `active` routes keystrokes
 * into it rather than list navigation. */
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
 * The open overlay's list (SelectRenderable). OpenTUI owns selection and
 * scrolling; this wrapper exposes the item-count view the shell reads and
 * rebuilds on geometry change.
 */
export interface OverlayList {
  readonly select: SelectRenderable;
  readonly activeIndex: number;
  /** Item-row capacity reserved by layout (not the renderable's row height). */
  readonly height: number;
  readonly rowsPerItem: number;
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
  /** Per-open dismiss hook for promise-backed overlays (permissions, operator);
   * Esc/closeInsetOverlay invokes it so the pending promise resolves. */
  onCancel: (() => void) | null;
  /** Per-open cleanup on replace/dismiss (MCP unsubscribe).
   * closeReplaceableOverlay runs it but skips `onCancel`. */
  onDispose: (() => void) | null;
  /** True while the open primary is a decision gate that must not be replaced. */
  isGate: boolean;
  /** Whether the open primary advertises Alt+A and yields å/Å from type-to-filter. */
  addProviderHint: boolean;
  /** Whether the open primary advertises Alt+D in the footer hints. */
  setDefaultHint: boolean;
  /** Whether the open primary advertises Alt+R remove and yields Option+R (®)
   * from type-to-filter. */
  removeProviderHint: boolean;
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
  removeProviderHint: false,
  mcpManageHint: false,
  mcpAddHint: false,
};

export interface PriorOverlaySnapshot {
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
  /** Raw text last passed to `applyOverlayBodyText`; a resize re-shapes the
   * body against the new height's context budget. */
  overlayRawBodyText: string;
  /** Snapshot when palette stacks over another primary overlay. */
  priorOverlay: PriorOverlaySnapshot | null;
  /** Command surface suspended while a gate holds the host; one slot, restored
   * after the gate settles. Never a gate or palette. */
  suspendedCommandSurface: PriorOverlaySnapshot | null;
  /** Advances on a new overlay taking the host, and when the host empties. */
  overlayGeneration: number;
  primaryBindings: PrimaryOverlayBindings;
  /** False while an overlay that reports its own outcome is open. */
  overlayEchoChoice: boolean;
  /** While true the shell ignores its own key/paste/submit handlers: a
   * full-screen surface shares this renderer, so two live handlers on one
   * stdin would both act on every keystroke. */
  inputSuspended: boolean;
  /** Per-open free-text answer field, when the overlay opted into one. */
  overlayAnswer: OverlayAnswerState | null;
  /** Bare title of the open overlay, so its key hints can be re-composed. */
  overlayTitleText: string;
  /** Fired once the overlay host is idle, so queued gates can re-open. */
  overlayClosedListeners: Set<() => void>;
  /** Command surface opened while an overlay holds the host; one slot, newer
   * replaces older. Flushed only when the host is idle, never from idle-notify
   * (would drain a queued gate). */
  deferredCommandOverlay: OpenListOverlayOpts | null;
  /** True while a microtask to flush deferredCommandOverlay is queued. */
  deferredFlushScheduled: boolean;
  /** Host-owned holds that outlive a null overlayList (async /settings list()).
   * While > 0, idle-notify stays silent so a queued gate cannot drain into the
   * gap before the surface paints. */
  overlayHostReservations: number;
  /** Bumped when Esc aborts reservations so a stale `release()` cannot
   * decrement a newer hold. */
  overlayReservationEpoch: number;
  /** Registry-backed `/` command catalog (static or lazy), host-injected; empty when unset. */
  paletteCatalog:
    | readonly PaletteCommand[]
    | (() => readonly PaletteCommand[])
    | null;
  /** Live filter state for the open palette, so typing can re-filter it. */
  paletteFilter: PaletteFilterState | null;
  /** Live type-to-filter state for a non-palette list overlay (model picker). */
  listFilter: ListFilterState | null;
  /** Landing composition while the transcript has no content; dropped (not
   * hidden) on the first row. */
  landing: {
    readonly above: LandingAbove;
    readonly below: BoxRenderable;
  } | null;
  /** Disclosure the landing is showing; re-appended to the transcript at
   * teardown so consent-by-proceeding leaves a record. */
  landingNotice: string | null;
  /** System/runtime notices that arrived while the landing was up (MCP load
   * failures, width-contract warnings, hook failures); flushed into the
   * transcript when the first row ends the landing. */
  landingDeferredRows: StreamRow[];
  /** What the rows below the box are painting, so they can be repainted. */
  landingBelow: LandingBelowContent | null;
  /** Starters are offered only while the prompt is empty. */
  landingSuggestionsVisible: boolean;
  /** Whether the last painted mark frame was a moving one. */
  landingAnimating: boolean;
  /** Clock of the last painted mark frame, so a resize can redraw in place. */
  landingNowMs: number;
  /** Mount-time reduced-motion flag: no idle snow timer; still mountain.
   * Set once at `createAppShell`. */
  reducedMotion: boolean;
  /** Cancels the idle repaint timer armed in `createAppShell`; null while none
   * is armed. */
  landingIdleTimerCancel: (() => void) | null;
  /** Chrome content (empty array = zone off). */
  chrome: {
    /** Rendered task rows; empty when nothing to show or the panel is hidden. */
    task: readonly TaskPanelRow[];
    /** Last live task rows pushed via setChromeZones, regardless of hidden state. */
    tasksRaw: readonly TaskPanelRow[];
    /** Agents panel rows (empty array = zone off), one row per rendered line. */
    agents: readonly AgentPanelRow[];
  };
  /** Operator toggle for the task panel; held in memory for the shell's life. */
  tasksPanelHidden: boolean;
  /** Pending-column selection by queue item id (stable across drains/cancels);
   * null while the prompt holds the keys. */
  pendingSelId: string | null;
}

export const internals = new WeakMap<AppShell, ShellInternals>();

/**
 * Filler row sized to leftover viewport space so a short transcript
 * bottom-anchors against the prompt box; settles at zero once rows fill it.
 * A real child, not padding: the content box's `minHeight: "100%"` floor makes
 * padding read back as viewport height, so `scrollHeight - spacer.height`
 * isolates the rows' real height. Index 0 is always the spacer, never a row.
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
  /** Plain chosen value aligned with `items`, for rows whose label carries
   * more than the value (a cycled field's name, padding, `‹ ›`). */
  readonly itemValues?: readonly (string | undefined)[];
  readonly body?: string;
  readonly activeIndex?: number;
  readonly frameId?: string;
  /** Per-open accept callback; beats shell-level overlay hooks; not invoked on
   * Esc / closeInsetOverlay. */
  readonly onAccept?: (selection: OverlaySelection) => void;
  /** Per-open expand/collapse hook. When set, the overlay claims
   * OVERLAY_EXPAND_KEY — no global binding, since it owns the keyboard while
   * open. */
  readonly onToggleExpand?: () => void;
  /** Per-open ← → cycle hook for settings-style inline value cycling; claims
   * Left/Right while open. */
  readonly onCycle?: (itemId: string, direction: -1 | 1) => void;
  /** Per-open Esc/dismiss hook for promise-backed overlays (permissions,
   * operator); invoked before the accept path is cleared so the caller's
   * promise resolves instead of hanging. */
  readonly onCancel?: () => void;
  /** Per-open cleanup on replace/dismiss. closeReplaceableOverlay invokes this
   * and skips `onCancel` (Esc/dismiss only). */
  readonly onDispose?: () => void;
  /** True when this open is a permission/operator decision gate;
   * `closeReplaceableOverlay` no-ops while set. */
  readonly isGate?: boolean;
  /** Invoked after this open takes the host (including a deferred flush). */
  readonly onOpened?: () => void;
  /** Description-zone source, called with the focused item's id on every move
   * (its label when no `itemIds`). Returning null leaves the zone blank, not
   * collapsed. */
  readonly describe?: (itemId: string) => ItemDescription | null;
  /** Per-open bare-key claim, checked before list navigation; returning false
   * leaves the key to j/k and arrows. */
  readonly onAction?: (itemId: string, key: KeyEvent) => boolean;
  /** Per-open bracketed-paste target for synthetic text panes. */
  readonly onPaste?: (text: string) => void;
  /** Per-open free-text answer. When set, the overlay paints a field the
   * operator can Tab into; submitting closes the overlay through this callback
   * instead of the selection path. */
  readonly onTextAnswer?: (text: string) => void;
  /** Open with the answer field already active; used when there is nothing to
   * choose. */
  readonly textAnswerActive?: boolean;
  /** Suppress the `chose (kind): label` echo: it quotes the label from
   * *before* the action (e.g. a server just authorized would be echoed as
   * needing authorization). */
  readonly echoChoice?: boolean;
  /** Claim printable keys for a `>` filter row so the list narrows as you
   * type; opt-in per open, else j/k navigate. */
  readonly typeToFilter?: boolean;
  /** Advertise Alt+A and /connect in the footer and yield Option+A (å/Å) from
   * type-to-filter. */
  readonly addProviderHint?: boolean;
  /** Advertise the Alt+D set-default hint in the footer. */
  readonly setDefaultHint?: boolean;
  /** Advertise the Alt+R remove-provider hint and yield Option+R (®) from
   * type-to-filter. */
  readonly removeProviderHint?: boolean;
  /** Advertise Alt+D disable / Alt+R remove in the `/mcp` footer; confirm
   * overlays leave it unset (DEFAULT_OVERLAY_HINTS). */
  readonly mcpManageHint?: boolean;
  /** Advertise Alt+A add in the `/mcp` footer; false while local settings
   * shadow global MCP. */
  readonly mcpAddHint?: boolean;
  /** When the host shows a non-palette overlay, stash this open in the one
   * deferred slot and print a system line. Off by default: a busy open is a
   * silent no-op. */
  readonly deferIfBusy?: boolean;
}

/** Palette open state that survives a re-filter. */
interface PaletteFilterState {
  query: string;
  readonly title: string;
  readonly catalog: readonly PaletteCommand[] | null;
  readonly typeToFilter: boolean;
}

/** Live type-to-filter state for a non-palette list overlay (model picker);
 * holds the full unfiltered row set so each keystroke re-narrows in place. */
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

/** Popup query = prompt text after the leading `/`. Null after whitespace (the
 * name is settled, the rest is args) or a second `/` (a path). */
export function slashPopupQuery(shell: AppShell): string | null {
  const value = shell.prompt.value;
  if (!value.startsWith("/")) return null;
  const head = value.slice(1);
  if (/\s/.test(head)) return null;
  if (head.includes("/")) return null;
  return head;
}

/** Second-stage arg parse: `/name` + whitespace + typed arg tail. */
export interface SlashArgQuery {
  /** Command name after the leading `/` (before the first whitespace). */
  readonly name: string;
  /** Typed argument tail after the first whitespace run (may be empty). */
  readonly arg: string;
}

/** Arg-stage parse: `/name` + whitespace + arg tail. Null when the prompt has
 * no whitespace after the name. */
export function slashArgQuery(shell: AppShell): SlashArgQuery | null {
  const value = shell.prompt.value;
  if (!value.startsWith("/")) return null;
  const head = value.slice(1);
  const gap = /\s/.exec(head);
  if (gap === null) return null;
  const name = head.slice(0, gap.index);
  // Path heads (`/Users/you notes`) are prompts, never arg-stage commands.
  if (name.includes("/")) return null;
  return {
    name,
    arg: head.slice(gap.index + gap[0].length),
  };
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
