/**
 * OpenTUI app shell — sticky transcript, prompt chrome, inset overlay.
 *
 * Functional wrappers around @opentui/core class renderables. This is the
 * production interactive CLI surface (Ink is no longer the live path).
 */

import { homedir } from "node:os";
import { clampBoardRows, type AgentPanelRow, type TaskPanelRow } from "./chrome-state.js";

import {
  BoxRenderable,
  CliRenderEvents,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SyntaxStyle,
  TextRenderable,
  TextTableRenderable,
  StyledText,
  bold as boldChunk,
  fg as fgChunk,
  type BaseRenderable,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
  type Selection,
  type TextChunk,
} from "@opentui/core";

import { isExitCommand } from "./exit-command.js";
import {
  composePromptActionBarModelLabel,
  type PromptActionBarModelLabelInput,
} from "./components/prompt-action-bar-label.js";
import { sliceTailToWidth, sliceToWidth, stringWidth } from "./view/height.js";
import { listPathSuggestions } from "./components/at-mention/list.js";
import { parseAtState, type AtState } from "./components/at-mention/parse.js";
import {
  formatAttachmentSummary,
  readClipboardImage,
  type ClipboardImageResult,
  type PendingImageAttachment,
} from "./image-attachments.js";
import {
  createSentHistoryBrowse,
  sentHistoryOnEdit,
  stepSentHistoryDown,
  stepSentHistoryUp,
  type SentHistoryBrowse,
} from "./sent-message-history.js";
import { spliceMentionCompletion } from "./prompt-attachments.js";
import {
  resolvePromptHighlightSpans,
  resolvePromptRecognitionMatcher,
  type PromptRecognitionSource,
} from "./prompt-recognition.js";
import {
  createPromptInput,
  promptCaretAtFirstRow,
  promptCaretAtLastRow,
  promptRowCount,
  type PromptInput,
} from "./prompt-input.js";
import { promptBoxRows } from "./prompt-rows.js";
import { composeNoticeLine, resolveWaitingOn } from "./notice-line.js";
import { lockupCells, lockupText, lockupWidth, type LockupInput } from "./lockup.js";
import type { RampPhase, StallAge } from "./ramp.js";
import { RUNTIME_FLASH_MS } from "./runtime-notices.js";
import type { ActivityState } from "./session-chrome.js";
import {
  BORDER,
  composeAttentionLabel,
  composeCostContextMeter,
  composeRule,
  composeWorkspaceLabel,
  costContextText,
  type CostContextMeter,
  type RulePart,
} from "./prompt-border.js";
import { viewToTableContent, type McpStructuredView } from "./mcp-view.js";
import {
  canPopFocus,
  createFocusState,
  focusOwner,
  focusPrompt,
  focusTranscript,
  openObserve,
  openOverlay,
  popFocus,
  type FocusState,
} from "./focus/index.js";
import {
  FLEET_FLOOR_MIN_LANES,
  FLEET_TRANSCRIPT_FLOOR,
  OVERLAY_MAX_FRACTION,
  PROMPT_BASE_ROWS,
  PROMPT_IDLE_ROWS,
  resolveBottomMarginRows,
  resolveGeometry,
  resolveTopPadRows,
  type GeometryLayout,
  type OverlayMode,
  type ZoneVisibility,
} from "./geometry/index.js";
import {
  createLandingAbove,
  createLandingBelow,
  fitLandingMark,
  LANDING_VERSION,
  landingBelowContent,
  landingSuggestionFor,
  paintLandingBelow,
  paintLandingMark,
  resolveMarkGrid,
  splitLandingRows,
  versionBadgeVisible,
  type LandingAbove,
  type LandingBelowContent,
} from "./landing.js";
import {
  createListViewport,
  moveActive,
  page as pageList,
  setCount as setListCount,
  setHeight as setListHeight,
  visibleSlice,
  type ListViewportState,
} from "./list-viewport.js";
import { retentionOverflow } from "./long-log.js";
import {
  filterPaletteCommands,
  formatPaletteRows,
  paletteLabels,
  type PaletteCommand,
} from "./command-catalog.js";
import { SHELL_SHORTCUTS } from "./keybindings.js";
import { destroySubtree } from "./teardown.js";
import { filterMentionSuggestions, splitMentionToken } from "./mention-filter.js";
import { type ObserveSession } from "./residuals.js";
import {
  buildCopyTargets,
  createRecordingClipboard,
  streamLogMarkdown,
  writeClipboard,
  type ClipboardPort,
  type CopyTarget,
} from "./copy-path.js";
import { copyFinishedSelection } from "./selection-copy.js";
import {
  badgeCount,
  cancelLast,
  clearInterruptFlash,
  createSessionQueue,
  enqueue,
  enqueueSteer,
  interrupt,
  queueCount,
  setRunState,
  steerCount,
  type RunState,
  type SessionQueueState,
} from "./session-queue.js";
import {
  agentVoicesIn,
  blockLabel,
  EXPAND_KEY,
  expandedRowLines,
  isCollapsibleRow,
  splitTrailingArrow,
  isExpansionRow,
  isMarkdownRow,
  isSentenceRow,
  MAIN_AGENT,
  paintStreamRow,
  rowGroupGap,
  streamRowGutter,
  toolRowLines,
  toolSentenceLines,
  transcriptSyntaxStyle,
  type PaintedStreamLine,
  type RowLayout,
  type StreamRow,
  type StyledBodyLine,
} from "./stream.js";
import { UI } from "./theme.js";
import { middleEllipsis } from "./command-display.js";
import {
  composeDecisionBody,
  decisionChoiceRows,
  DECISION_CHOICE_ROWS,
  wrapOverlayText,
  wrapWords,
} from "./overlay-body.js";
import {
  beginYank,
  breakKillSequence,
  emptyKillRing,
  killedTextBackward,
  killedTextForward,
  recordKill,
  rotateYank,
  type KillRing,
} from "./prompt-kill-ring.js";

const shellExitHandlers = new WeakMap<AppShell, () => void>();

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

const effortCycleHandlers = new WeakMap<AppShell, () => void>();

/** Shift+Tab host callback: cycle reasoning effort for the live session. */
export function setEffortCycleHandler(shell: AppShell, onCycle: () => void): void {
  effortCycleHandlers.set(shell, onCycle);
}

export function clearEffortCycleHandler(shell: AppShell): void {
  effortCycleHandlers.delete(shell);
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

export function setShellBridgeHooks(shell: AppShell, hooks: ShellBridgeHooks): void {
  shellBridgeHooks.set(shell, hooks);
}

export function clearShellBridgeHooks(shell: AppShell): void {
  shellBridgeHooks.delete(shell);
}

export function getShellBridgeHooks(shell: AppShell): ShellBridgeHooks | undefined {
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

export function setShellOverlayHooks(shell: AppShell, hooks: ShellOverlayHooks): void {
  shellOverlayHooks.set(shell, hooks);
}

export function clearShellOverlayHooks(shell: AppShell): void {
  shellOverlayHooks.delete(shell);
}

export function getShellOverlayHooks(shell: AppShell): ShellOverlayHooks | undefined {
  return shellOverlayHooks.get(shell);
}

/**
 * Injectable handler for registry-backed palette selections (`dispatch: "command"`).
 * Residual openers still go through `runPaletteAction`. Host binds real handlers
 * (slash command run, overlay open, etc.) without the palette importing the registry.
 */
export type PaletteOnCommand = (name: string) => void;

const shellPaletteOnCommand = new WeakMap<AppShell, PaletteOnCommand>();

export function setPaletteOnCommand(shell: AppShell, handler: PaletteOnCommand | undefined): void {
  if (handler) shellPaletteOnCommand.set(shell, handler);
  else shellPaletteOnCommand.delete(shell);
}

export function getPaletteOnCommand(shell: AppShell): PaletteOnCommand | undefined {
  return shellPaletteOnCommand.get(shell);
}

/**
 * Clipboard image reader behind Ctrl+P. Injectable so tests (and non-macOS
 * hosts) can supply their own source instead of shelling out to osascript.
 */
export type PromptImageSource = () => Promise<ClipboardImageResult>;

const shellPromptImageSource = new WeakMap<AppShell, PromptImageSource>();

export function setPromptImageSource(shell: AppShell, source: PromptImageSource | undefined): void {
  if (source) shellPromptImageSource.set(shell, source);
  else shellPromptImageSource.delete(shell);
}

/** Filesystem suggestions behind the @-mention overlay. */
export type MentionSuggestionSource = (prefix: string) => Promise<readonly string[]>;

const shellMentionSource = new WeakMap<AppShell, MentionSuggestionSource>();

export function setMentionSuggestionSource(
  shell: AppShell,
  source: MentionSuggestionSource | undefined,
): void {
  if (source) shellMentionSource.set(shell, source);
  else shellMentionSource.delete(shell);
}

/** Names the prompt is allowed to highlight as leading `/command` tokens. */
const shellRecognitionSource = new WeakMap<AppShell, PromptRecognitionSource>();

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

const shellPaletteOnObserveRequest = new WeakMap<AppShell, PaletteOnObserveRequest>();

export function setPaletteOnObserveRequest(
  shell: AppShell,
  handler: PaletteOnObserveRequest | undefined,
): void {
  if (handler) shellPaletteOnObserveRequest.set(shell, handler);
  else shellPaletteOnObserveRequest.delete(shell);
}

export function getPaletteOnObserveRequest(shell: AppShell): PaletteOnObserveRequest | undefined {
  return shellPaletteOnObserveRequest.get(shell);
}

/** Dispatch accept to per-open callback, then shell-level kind hooks. */
function dispatchOverlayAccept(
  shell: AppShell,
  selection: OverlaySelection,
  perOpen: ((selection: OverlaySelection) => void) | null,
): void {
  if (perOpen) {
    perOpen(selection);
    return;
  }
  const hooks = getShellOverlayHooks(shell);
  if (!hooks) return;
  switch (selection.kind) {
    case "permissions":
      if (hooks.onPermission) {
        hooks.onPermission(selection);
        return;
      }
      break;
    case "operator":
      if (hooks.onOperator) {
        hooks.onOperator(selection);
        return;
      }
      break;
    case "model_picker":
      if (hooks.onModel) {
        hooks.onModel(selection);
        return;
      }
      break;
    case "settings":
      if (hooks.onSettings) {
        hooks.onSettings(selection);
        return;
      }
      break;
    case "help":
      if (hooks.onHelp) {
        hooks.onHelp(selection);
        return;
      }
      break;
    case "plugins":
      if (hooks.onPlugins) {
        hooks.onPlugins(selection);
        return;
      }
      break;
    case "resume":
      if (hooks.onResume) {
        hooks.onResume(selection);
        return;
      }
      break;
    case "mentions":
      if (hooks.onMentions) {
        hooks.onMentions(selection);
        return;
      }
      break;
    default:
      break;
  }
  hooks.onSelect?.(selection);
}

/** Renderer surface required by the shell (CliRenderer / createTestRenderer). */
export type ShellRenderer = Pick<
  CliRenderer,
  "root" | "width" | "height" | "keyInput" | "on" | "off" | "isDestroyed" | "clearSelection"
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
  readonly paletteCatalog?: readonly PaletteCommand[] | (() => readonly PaletteCommand[]);
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
  /** Overlay list viewport (null when closed). */
  overlayList: ListViewportState | null;
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

// Human keystrokes land tens of milliseconds apart at the fastest; a paste
// replayed onto stdin without bracketed-paste framing lands effectively all
// at once. 15ms is an empirical guess at a gap comfortably under normal
// typing and comfortably over a replayed paste, not a measured figure --
// too high false-positives on a very fast typist's real Enter (read as
// paste, so it inserts a newline instead of sending); too low misses a
// slow paste replay (read as typing, so a bare CR mid-paste still
// submits). Only matters before this terminal's first real paste event;
// see `sawBracketedPaste` below.
const PASTE_BURST_MS = 15;

/** A single unmodified character, as opposed to a control chord or named key. */
function isPrintableInsertKey(key: KeyEvent): boolean {
  return (
    !key.ctrl &&
    !key.meta &&
    !key.option &&
    typeof key.sequence === "string" &&
    key.sequence.length === 1 &&
    key.sequence >= " "
  );
}

const DEFAULT_TITLE = "corbits";
const DEFAULT_OVERLAY_ITEMS = [
  "Allow bash: ls",
  "Allow bash: cat README",
  "Deny this tool",
  "Always allow bash",
] as const;

function terminalOf(
  renderer: ShellRenderer,
  override?: { readonly columns: number; readonly rows: number },
): { columns: number; rows: number } {
  if (override) {
    return {
      columns: Math.max(1, Math.floor(override.columns)),
      rows: Math.max(1, Math.floor(override.rows)),
    };
  }
  return {
    columns: Math.max(1, Math.floor(renderer.width || 80)),
    rows: Math.max(1, Math.floor(renderer.height || 24)),
  };
}

/**
 * The version row is real chrome, not a float — it holds its own reserved
 * row at the foot of the shell rather than painting into the optical bottom
 * pad (`BOTTOM_MARGIN_ROWS`), which is blank breathing room, not a content
 * slot.
 *
 * This genuinely costs the rest of the shell a row, not just the space it
 * paints in: the geometry resolver is handed `terminal.rows - 1`, so every
 * height it derives from that — including `PROMPT_CAP_FRACTION *
 * terminal.rows`, which runs before collapse and outside `COLLAPSE_ORDER` —
 * is computed one row short of the real terminal. The badge does not sit in
 * the collapse order and does not give the row back under prompt-growth
 * pressure; it is not "free" chrome, it is chrome the operator pays a row
 * for on the landing screen, same as the task or agents panel would.
 */
function terminalForGeometry(terminal: { readonly columns: number; readonly rows: number }): {
  columns: number;
  rows: number;
} {
  if (!versionBadgeVisible(terminal.columns, terminal.rows)) return terminal;
  return { columns: terminal.columns, rows: Math.max(1, terminal.rows - 1) };
}

function defaultVisibility(visibility?: ZoneVisibility): ZoneVisibility {
  return {
    notice: false,
    progress: false,
    progressDivider: false,
    // Explicit 0 rather than left undefined: task and agents are row
    // counts, and setChromeZones compares them by ===, so an undefined
    // start forces one needless relayout the first time either is compared.
    task: 0,
    agents: 0,
    ...visibility,
  };
}

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

function syncPending(shell: AppShell): void {
  shell.pendingQueue = badgeCount(shell.session);
}

/** The transient row's text for the current state ("" when it has nothing to say). */
export function noticeText(shell: AppShell): string {
  return composeNoticeLine({
    steer: steerCount(shell.session),
    followUp: queueCount(shell.session),
    waitingOn: resolveWaitingOn(steerCount(shell.session), shell.inFlightTool, shell.lockupNowMs),
    interrupt: shell.session.interruptFlash,
    pinned: !isTranscriptFollowing(shell),
    flash: shell.statusFlash,
    attachments: shell.pendingAttachments.length,
  });
}

/** Which MCP servers are waiting on authorization. Repaints on change. */
export function setMcpNeedsAuth(shell: AppShell, names: readonly string[]): void {
  const next = [...names];
  if (
    shell.mcpNeedsAuth.length === next.length &&
    next.every((name) => shell.mcpNeedsAuth.includes(name))
  ) {
    return;
  }
  shell.mcpNeedsAuth = next;
  paintChrome(shell);
}

/** Whether plugin load warnings still need attention. Repaints on change. */
export function setPluginNeedsAttention(shell: AppShell, needs: boolean): void {
  if (shell.pluginNeedsAttention === needs) return;
  shell.pluginNeedsAttention = needs;
  paintChrome(shell);
}

/** Repaint the prompt borders and the transient notice row from live state. */
export function paintChrome(shell: AppShell): void {
  if (shell.disposed) return;
  // Headless tests often destroy the renderer without dispose
  // (`withTestRenderer` cleanup). A TTL flash armed before that teardown
  // must not write a TextBuffer the harness already freed.
  if (shell.renderer.isDestroyed || shell.notice.isDestroyed) return;
  syncPending(shell);
  const notice = noticeText(shell);
  shell.notice.content = new StyledText([
    fgChunk(UI.textDim)(notice.length > 0 ? ` ${notice}` : ""),
  ]);
  paintPromptBorder(shell);
  syncLandingSuggestions(shell);
  syncNoticeRow(shell, notice);
}

/**
 * Give the notice row a row only while it has something to say, and take it
 * back the moment it does not. The relayout re-enters paintChrome, which then
 * finds the visibility already correct and stops.
 */
function syncNoticeRow(shell: AppShell, notice: string): void {
  paintedNotice.set(shell, notice);
  const bag = internals.get(shell);
  if (bag === undefined) return;
  const wanted = notice.length > 0;
  if ((bag.visibility.notice ?? false) === wanted) return;
  relayout(shell, { visibility: { ...bag.visibility, notice: wanted } });
}

/**
 * Re-read the notice once the layout pass has run.
 *
 * `pinned` is derived from the scroll box's own numbers, and those describe the
 * *last completed* layout: chrome painted at row-mutation time can read a
 * transcript that is following its tail as pinned, for the one frame between a
 * row landing and sticky-scroll re-applying. Repaints only when the wording
 * actually changed, so a settled frame costs a string compare.
 */
function syncNoticeAfterLayout(shell: AppShell): void {
  if (noticeText(shell) !== paintedNotice.get(shell)) paintChrome(shell);
}

/** Notice wording currently on the row, for the post-layout re-read. */
const paintedNotice = new WeakMap<AppShell, string>();

/** Withdraw or restore the landing starters as the prompt fills and empties. */
function syncLandingSuggestions(shell: AppShell): void {
  const bag = internals.get(shell);
  if (!bag) return;
  const landing = bag.landing;
  const content = bag.landingBelow;
  if (landing === null || content === null) return;
  const visible = shell.prompt.value.length === 0;
  if (visible === bag.landingSuggestionsVisible) return;
  bag.landingSuggestionsVisible = visible;
  paintLandingBelow(landing.below, content, visible);
}

/**
 * Advance the status slot's clock and publish what it says. Callers own the
 * tick; the shell only repaints when the frame it would draw can actually
 * differ.
 *
 * A change of phase stamps the fade's origin, so the crossfade runs off the
 * frames the monitor is already scheduling for the live turn. Settling snaps
 * straight to the idle slot rather than fading into it: the tick stops on the
 * frame the turn ends, and a transition with no frames left to draw is worse
 * than none.
 */
export interface LockupFrame {
  readonly nowMs: number;
  readonly animating: boolean;
  /**
   * Live activity state, or null for the idle wordmark. Typed to the closed
   * set so the caller cannot hand this a raw tool identifier.
   */
  readonly phase: ActivityState | null;
  /** The turn's ramp phase, or null when idle. */
  readonly rampPhase: RampPhase | null;
  /** How long the turn has been stalled, or null when it is not stalled. */
  readonly stalledForMs: StallAge;
}

export function setLockupFrame(shell: AppShell, frame: LockupFrame): void {
  const settled = !frame.animating && !shell.lockupAnimating;
  shell.lockupNowMs = frame.nowMs;
  const phaseChanged = frame.phase !== shell.lockupPhase;
  if (phaseChanged) {
    shell.lockupPhase = frame.phase;
    shell.lockupChangedMs = frame.nowMs;
  }
  const changed =
    phaseChanged ||
    frame.rampPhase !== shell.lockupRampPhase ||
    frame.stalledForMs !== shell.lockupStalledForMs;
  shell.lockupRampPhase = frame.rampPhase;
  shell.lockupStalledForMs = frame.stalledForMs;
  if (settled && !changed && shell.lockupAnimating === frame.animating) return;
  shell.lockupAnimating = frame.animating;
  paintChrome(shell);
}

/** Queue an image for the next submit and reflect it on the notice row. */
export function addPendingAttachment(shell: AppShell, attachment: PendingImageAttachment): void {
  shell.pendingAttachments = [...shell.pendingAttachments, attachment];
  paintChrome(shell);
}

export function clearPendingAttachments(shell: AppShell): void {
  shell.pendingAttachments = [];
  paintChrome(shell);
}

/**
 * Ctrl+P: read an image off the clipboard into the pending set.
 * Resolves false (with a status flash) when nothing was attached.
 */
export async function attachClipboardImage(shell: AppShell): Promise<boolean> {
  const source = shellPromptImageSource.get(shell) ?? readClipboardImage;
  // Sticky until the read resolves — mid-async progress, not a confirmation.
  setStatusFlash(shell, "reading clipboard image…");
  const result = await source();
  // Quitting while the clipboard read is pending tears down the shell's
  // renderables; a stale continuation must not mutate them on resume.
  if (shell.disposed) return false;
  if (!result.ok) {
    setStatusFlash(shell, `image attach failed: ${result.reason}`, {
      ttlMs: RUNTIME_FLASH_MS,
    });
    return false;
  }
  const duplicate = shell.pendingAttachments.find(
    (attachment) => attachment.contentHash === result.attachment.contentHash,
  );
  if (duplicate !== undefined) {
    setStatusFlash(shell, `${duplicate.name} is already attached`, {
      ttlMs: RUNTIME_FLASH_MS,
    });
    return false;
  }
  addPendingAttachment(shell, result.attachment);
  setStatusFlash(shell, `attached ${result.attachment.name}`, {
    ttlMs: RUNTIME_FLASH_MS,
  });
  return true;
}

/** Seed the Up/Down recall list (host replays persisted session messages). */
export function setSentMessageHistory(shell: AppShell, sent: readonly string[]): void {
  shell.sentHistory = createSentHistoryBrowse(sent);
}

function recordSentMessage(shell: AppShell, text: string): void {
  shell.sentHistory = createSentHistoryBrowse([...shell.sentHistory.sent, text]);
}

/**
 * How a timed flash arms its own expiry. Injectable so tests can lapse a
 * window without waiting out its real duration; returns the cancel.
 */
export type FlashSchedule = (fn: () => void, ms: number) => () => void;

const defaultFlashSchedule: FlashSchedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  // A pending flash must never be the reason the process stays alive.
  (timer as { unref?: () => void }).unref?.();
  return () => {
    clearTimeout(timer);
  };
};

export interface FlashOptions {
  /** Lifetime of the flash; omitted means it stays until something replaces it. */
  readonly ttlMs?: number;
  readonly schedule?: FlashSchedule;
}

/** Cancel for the flash currently counting down, per shell. */
const flashTimers = new WeakMap<AppShell, () => void>();

/** Per-shell override for how timed flashes arm their expiry (tests). */
const shellFlashSchedules = new WeakMap<AppShell, FlashSchedule>();

/**
 * Set a non-destructive flash and repaint (does not touch streamLog).
 *
 * A flash with a `ttlMs` clears itself when its window lapses. Anything whose
 * wording is only true for a moment ("press ctrl+c again to exit") must say so
 * for exactly that moment: left on screen it becomes a claim about a keypress
 * the operator never made, and it holds a transcript row hostage for it.
 * Omit `ttlMs` for live conditions that stay true until something replaces them
 * (stall notice, landing hold).
 */
export function setStatusFlash(
  shell: AppShell,
  message: string | null,
  options?: FlashOptions,
): void {
  flashTimers.get(shell)?.();
  flashTimers.delete(shell);
  shell.statusFlash = message;
  paintChrome(shell);
  const ttlMs = options?.ttlMs;
  if (message === null || ttlMs === undefined || ttlMs <= 0) return;
  if (shell.disposed || shell.renderer.isDestroyed) return;
  const schedule = options?.schedule ?? shellFlashSchedules.get(shell) ?? defaultFlashSchedule;
  flashTimers.set(
    shell,
    schedule(() => {
      flashTimers.delete(shell);
      // Only this flash expires: a later one has its own window, and the row
      // it is holding is not this one's to take back.
      if (shell.statusFlash !== message) return;
      shell.statusFlash = null;
      paintChrome(shell);
    }, ttlMs),
  );
}

/** Apply focus state to OpenTUI focusables. */
export function applyFocus(shell: AppShell): void {
  const owner = focusOwner(shell.focus);
  // Observe is a read-only child view: the parent prompt must not swallow the
  // keystrokes, so it is blurred exactly as an overlay blurs it.
  if (owner === "overlay" || owner === "palette" || owner === "observe") {
    if (typeof shell.prompt.blur === "function") {
      shell.prompt.blur();
    }
  } else if (owner === "transcript") {
    shell.transcript.focus();
  } else {
    shell.prompt.focus();
  }
  paintChrome(shell);
}

export function shellFocusPrompt(shell: AppShell): void {
  shell.focus = focusPrompt(shell.focus);
  applyFocus(shell);
}

export function shellFocusTranscript(shell: AppShell): void {
  shell.focus = focusTranscript(shell.focus);
  applyFocus(shell);
}

export function toggleShellFocus(shell: AppShell): void {
  const owner = focusOwner(shell.focus);
  if (owner === "overlay" || owner === "palette") return;
  if (owner === "transcript") {
    shellFocusPrompt(shell);
  } else {
    shellFocusTranscript(shell);
  }
}

function clearOverlayBody(shell: AppShell): void {
  const body = shell.overlayBody;
  const kids = [...body.getChildren()];
  for (const child of kids) {
    body.remove(child);
    destroySubtree(child);
  }
}

/**
 * Rows the overlay host spends on itself before any list row: the bordered box
 * costs a top and bottom rule, plus the title line and the wrapped body lines.
 * Omitting the border here hands the list two rows the host cannot render, and
 * flex then stacks the surplus rows onto cells the prompt border already owns.
 */
const OVERLAY_HOST_BORDER_ROWS = 2;

/** Content lines the description zone paints below the rule (what, impact). */
const DESCRIPTION_ZONE_LINES = 2;
/** Rule row plus the fixed two content lines — charged whenever `describe` is set. */
const DESCRIPTION_ZONE_ROWS = 1 + DESCRIPTION_ZONE_LINES;

/** Rows the open overlay's description zone spends, or 0 when it has none. */
function overlayZoneRows(shell: AppShell): number {
  return internals.get(shell)?.overlayDescribe ? DESCRIPTION_ZONE_ROWS : 0;
}

/**
 * Free-text answer field an overlay can offer alongside (or instead of) its
 * choices. `active` is whether keystrokes are going into it rather than into
 * list navigation — the row is painted either way, so the affordance is on
 * screen rather than behind a chord nobody knows about.
 */
interface OverlayAnswerState {
  text: string;
  active: boolean;
  readonly onSubmit: (text: string) => void;
}

function overlayAnswerState(shell: AppShell): OverlayAnswerState | null {
  return internals.get(shell)?.overlayAnswer ?? null;
}

/** The answer field costs one row of host chrome whenever it is offered. */
function overlayAnswerRows(shell: AppShell): number {
  return overlayAnswerState(shell) === null ? 0 : 1;
}

/**
 * Every other list overlay spends a row on a title rule (`─ permission ─...`);
 * the palette drops it — the box already reads as the palette, and the filter
 * row underneath says what's typed, so the rule was a second header for the
 * same fact.
 */
function overlayTitleRows(kind: PrimaryOverlayKind | null): number {
  return kind === "palette" ? 0 : 1;
}

function overlayChromeRows(shell: AppShell, bodyLineCount: number): number {
  return (
    OVERLAY_HOST_BORDER_ROWS +
    overlayTitleRows(shell.overlayKind) +
    bodyLineCount +
    overlayZoneRows(shell) +
    overlayAnswerRows(shell)
  );
}

/**
 * Stacking order for the floated overlay host. Only the landing composition
 * sits under it, and that has no z-index of its own, so one step is enough.
 */
const OVERLAY_FLOAT_Z = 10;

/**
 * Lift the overlay host out of the root's column, or drop it back in.
 *
 * On the landing the host is a modal: the mark and the disclosure are the
 * screen, and shoving them around to open a command list would make every
 * overlay feel like a navigation. Absolute positioning takes the host out of
 * flow so the composition beneath is untouched, anchored above the chrome the
 * host used to sit on top of. With a transcript on screen the opposite is
 * true — rows there are content the operator is reading, and covering them is
 * worse than pushing them — so the host goes back into the column.
 */
function floatOverlayHost(shell: AppShell, floating: boolean, top: number): void {
  const host = shell.overlayHost;
  if (!floating) {
    host.position = "relative";
    host.zIndex = 0;
    // A previous landing float left absolute insets behind. Under relative
    // positioning those same values act as offsets from the in-flow slot, so
    // a stale top pushes the band that many rows below the prompt — clear
    // them so the band sits where the flow put it.
    host.top = 0;
    host.left = 0;
    host.width = "100%";
    return;
  }
  host.position = "absolute";
  // Absolute positioning escapes root's padding, so the same sideMargin the
  // prompt box gets for free in normal flow has to be given back explicitly.
  // width is set to the same contentWidth the prompt box resolves to via
  // "100%" of root's padded box — one source, not a second computed here —
  // rather than left+right insets, since those combine with the existing
  // width:"100%" to overshoot the right edge.
  host.left = shell.layout.sideMargin;
  host.width = shell.layout.contentWidth;
  host.top = top;
  host.zIndex = OVERLAY_FLOAT_Z;
}

/** Total host rows needed to show `listRows` list rows under `bodyLineCount` body lines. */
function overlayHostRows(shell: AppShell, bodyLineCount: number, listRows: number): number {
  return overlayChromeRows(shell, bodyLineCount) + listRows;
}

/**
 * Smallest host rows the open overlay can render into without spilling past
 * its own box: fixed chrome (border, title, body lines) plus one row of the
 * list when it has anything to show. Below this the resolver must give ground
 * elsewhere (transcript floor) rather than starve the overlay itself.
 */
function overlayMinHostRows(shell: AppShell, bodyLineCount: number, hasItems: boolean): number {
  const perItem = overlayRowsPerItem(shell.overlayKind);
  return overlayChromeRows(shell, bodyLineCount) + (hasItems ? perItem : 0);
}

function addOverlayRow(shell: AppShell, content: string, fg: string, bg?: string): void {
  shell.overlayBody.add(
    new TextRenderable(shell.renderer as CliRenderer, {
      content,
      fg,
      ...(bg !== undefined ? { bg } : {}),
      height: 1,
      // Without this, a body taller than its host makes flex shrink every row
      // toward zero and paint several of them into the same terminal cells.
      flexShrink: 0,
    }),
  );
}

/**
 * Overlays that ask a human to authorize something. They get the shaped,
 * spaced treatment from overlay-body.ts; every other list overlay stays a
 * plain one-row-per-item list.
 */
function isDecisionOverlay(kind: PrimaryOverlayKind | null): boolean {
  return kind === "permissions" || kind === "operator";
}

/** Display rows one list item occupies for the open overlay kind. */
function overlayRowsPerItem(kind: PrimaryOverlayKind | null): number {
  return isDecisionOverlay(kind) ? DECISION_CHOICE_ROWS : 1;
}

/**
 * Recompute the overlay host's row budget from the current item count and
 * relayout into it. Callers that refresh an already-open overlay's items in
 * place (rather than reopening) must call this themselves — a filter that
 * narrows a list and then widens it again would otherwise stay pinned at
 * whatever size it first opened at.
 */
function relayoutOverlayHost(shell: AppShell, itemCount: number): void {
  const perItem = overlayRowsPerItem(shell.overlayKind);
  const hostRows = overlayHostRows(shell, shell.overlayBodyLines.length, itemCount * perItem);
  const minHostRows = overlayMinHostRows(shell, shell.overlayBodyLines.length, itemCount > 0);
  relayout(shell, {
    overlayMode: "inset",
    overlayBodyRows: hostRows,
    overlayMinBodyRows: minHostRows,
  });
}

/** Columns a body/choice row may paint into, inside border and leading space. */
function overlayRowWidth(shell: AppShell): number {
  return Math.max(8, Math.max(20, shell.layout.contentWidth) - 4);
}

/**
 * Title row for the overlay host, fitted to the box interior. The title
 * renderable is one row in the host's chrome budget, so a line that wrapped at
 * a narrow width would spend a row nothing accounted for.
 */
function overlayTitleLine(
  title: string,
  interior: number,
  hints: readonly string[] = DEFAULT_OVERLAY_HINTS,
): string {
  const trimmed = title.trim();
  // Empty/blank title: paint hints alone — no leading " · " from a missing title.
  if (trimmed.length === 0) {
    for (const hint of hints) {
      const line = ` ${hint}`;
      if (line.length <= interior) return line;
    }
    return " ";
  }
  const suffixes = [...hints.map((h) => ` · ${h}`), ""];
  for (const suffix of suffixes) {
    const line = ` ${trimmed}${suffix}`;
    if (line.length <= interior) return line;
  }
  return ` ${middleEllipsis(trimmed, Math.max(1, interior - 1))}`;
}

const DEFAULT_OVERLAY_HINTS = ["Esc cancel · Enter choose", "Esc · Enter"] as const;

/**
 * Key hints for the open overlay, longest first — the title line falls back to
 * shorter ones as the terminal narrows.
 *
 * Never promises "Enter choose" when there is nothing to choose: an overlay
 * with no rows says what the operator can actually do instead.
 */
/** Model picker only: same three-tier fallback shape as DEFAULT_OVERLAY_HINTS. */
const MODEL_PICKER_HINTS = [
  "Esc cancel · Enter choose · Alt+A /connect add provider",
  "Esc · Enter · Alt+A /connect",
  "Esc · Enter",
] as const;

/** Permissions only: name `/yolo` so skip-prompts is discoverable at the ask. */
const PERMISSIONS_HINTS = [
  "Esc cancel · Enter choose · /yolo skip prompts",
  "Esc · Enter · /yolo",
  "Esc · Enter",
] as const;

/** /plugins: longest-first how-to, same fallback shape as the model picker. */
const PLUGINS_HINTS = [
  "Esc cancel · Enter toggle · Alt+A add path · Alt+X remove",
  "Esc · Enter · Alt+A add · Alt+X remove",
  "Esc · Enter · Alt+A · Alt+X",
  "Esc · Enter",
] as const;

const MCP_MANAGE_HINTS_WITH_ADD = [
  "Esc cancel · Enter choose · Alt+A add · Alt+D disable · Alt+R remove",
  "Esc · Enter · Alt+A add · Alt+D · Alt+R",
  "Esc · Enter · Alt+A · Alt+D · Alt+R",
  "Esc · Enter",
] as const;

const MCP_MANAGE_HINTS_WITHOUT_ADD = [
  "Esc cancel · Enter choose · Alt+D disable · Alt+R remove",
  "Esc · Enter · Alt+D · Alt+R",
  "Esc · Enter",
] as const;

function overlayHints(shell: AppShell): readonly string[] {
  const answer = overlayAnswerState(shell);
  const hasChoices = shell.overlayItems.length > 0;
  if (answer === null) {
    if (!hasChoices) return ["Esc dismiss"];
    if (shell.overlayKind === "model_picker") {
      const bag = internals.get(shell);
      const addProvider = bag?.overlayAddProviderHint === true;
      const setDefault = bag?.overlaySetDefaultHint === true;
      if (addProvider && setDefault) {
        return [
          "Esc cancel · Enter choose · Alt+A /connect add provider · Alt+D set default",
          "Esc · Enter · Alt+A /connect · Alt+D default",
          "Esc · Enter · Alt+A · Alt+D",
          "Esc · Enter",
        ];
      }
      if (addProvider) return MODEL_PICKER_HINTS;
      if (setDefault) {
        return [
          "Esc cancel · Enter choose · Alt+D set default",
          "Esc · Enter · Alt+D default",
          "Esc · Enter",
        ];
      }
    }
    if (shell.overlayKind === "permissions") return PERMISSIONS_HINTS;
    if (shell.overlayKind === "plugins") return PLUGINS_HINTS;
    if (shell.overlayKind === "mcp") {
      const mcpBag = internals.get(shell);
      if (mcpBag?.overlayMcpManageHint === true) {
        return mcpBag.overlayMcpAddHint === true
          ? MCP_MANAGE_HINTS_WITH_ADD
          : MCP_MANAGE_HINTS_WITHOUT_ADD;
      }
    }
    return DEFAULT_OVERLAY_HINTS;
  }
  if (answer.active) {
    return hasChoices
      ? ["Esc back to choices · Enter send", "Esc back · Enter send"]
      : ["Esc cancel · Enter send", "Esc · Enter"];
  }
  return [
    "Esc cancel · Enter choose · Tab type an answer",
    "Esc · Enter · Tab type",
    "Esc · Enter",
  ];
}

/** Re-compose the open overlay's title line for the current hints and width. */
function refreshOverlayTitle(shell: AppShell): void {
  const bag = internals.get(shell);
  if (!bag) return;
  shell.overlayTitle.visible = true;
  shell.overlayTitle.content = overlayTitleLine(
    bag.overlayTitleText,
    overlayInteriorWidth(shell),
    overlayHints(shell),
  );
}

/** Interior columns of the overlay box, inside its border. */
function overlayInteriorWidth(shell: AppShell): number {
  return overlayRowWidth(shell) + 2;
}

/**
 * Selection is a text colour, not a marker or a filled band: the highlighted
 * row already stands out by sitting under the cursor, so a leading `>` and a
 * grey block would both be saying the same thing twice.
 */
function paintPaletteList(shell: AppShell, list: ListViewportState): void {
  const interior = overlayInteriorWidth(shell);
  const lines = formatPaletteRows(
    shell.paletteCommands.map((cmd) => cmd.label),
    Math.max(4, interior - 1),
  );
  const slice = visibleSlice(list);
  for (let i = slice.start; i < slice.end; i++) {
    const line = lines[i] ?? "";
    const active = i === list.activeIndex;
    const content = ` ${line}`.padEnd(interior);
    addOverlayRow(shell, content, active ? UI.text : UI.textDim);
  }
}

/** Below this overlay width the description zone has no room to say anything legible. */
const DESCRIPTION_ZONE_MIN_WIDTH = 16;
/** Below this overlay width the zone keeps `what` only and drops `impact`. */
const DESCRIPTION_ZONE_IMPACT_MIN_WIDTH = 32;

/** Stable id for the focused row: `itemIds[index]` when supplied, else its label. */
function activeOverlayItemId(shell: AppShell, list: ListViewportState): string {
  const bag = internals.get(shell);
  return (
    bag?.overlayItemIds[list.activeIndex] ??
    shell.overlayItems[list.activeIndex] ??
    String(list.activeIndex)
  );
}

/**
 * Shape a description into its fixed two content rows.
 *
 * `what`'s wrapped lines fill the budget first; `impact` gets whatever is
 * left, so a `what` that wraps to both lines quietly drops `impact` the same
 * way a narrow overlay does — one budget, one degrade path. `null` (no
 * description for this item, or width too narrow to say anything) renders
 * two blank rows rather than collapsing the zone: the reservation is fixed
 * whenever `describe` is set, whether or not this item has anything to say.
 */
export function describeZoneLines(
  desc: ItemDescription | null,
  width: number,
): { readonly lines: readonly string[]; readonly fgs: readonly string[] } {
  const lines: string[] = [];
  const fgs: string[] = [];
  if (desc !== null && width >= DESCRIPTION_ZONE_MIN_WIDTH) {
    for (const line of wrapWords(desc.what, width)) {
      if (lines.length >= DESCRIPTION_ZONE_LINES) break;
      lines.push(line);
      fgs.push(UI.textDim);
    }
    if (desc.impact !== undefined && width >= DESCRIPTION_ZONE_IMPACT_MIN_WIDTH) {
      const impactFg = desc.tone === "consequence" ? UI.warning : UI.textFaint;

      for (const line of wrapWords(desc.impact, width)) {
        if (lines.length >= DESCRIPTION_ZONE_LINES) break;
        lines.push(line);
        fgs.push(impactFg);
      }
    }
  }
  while (lines.length < DESCRIPTION_ZONE_LINES) {
    lines.push("");
    fgs.push(UI.textFaint);
  }
  return { lines, fgs };
}

/** Paint the fixed rule + two-line description zone under the list, when `describe` is set. */
function paintDescriptionZone(shell: AppShell, list: ListViewportState): void {
  const describe = internals.get(shell)?.overlayDescribe;
  if (!describe) return;
  const width = overlayRowWidth(shell);
  const desc = describe(activeOverlayItemId(shell, list));
  addOverlayRow(shell, ` ${"─".repeat(Math.max(0, width))}`, UI.textFaint);
  const { lines, fgs } = describeZoneLines(desc, width);
  lines.forEach((line, i) => {
    addOverlayRow(shell, line.length > 0 ? ` ${line}` : "", fgs[i] ?? UI.textFaint);
  });
}

function paintOverlayList(shell: AppShell): void {
  const list = shell.overlayList;
  clearOverlayBody(shell);
  if (!list) return;

  shell.overlayBodyLines.forEach((line, i) => {
    addOverlayRow(shell, ` ${line}`, shell.overlayBodyFgs[i] ?? UI.text);
  });

  if (shell.overlayKind === "palette" && shell.paletteCommands.length > 0) {
    paintPaletteList(shell, list);
    paintDescriptionZone(shell, list);
    return;
  }

  const decision = isDecisionOverlay(shell.overlayKind);
  const width = overlayRowWidth(shell);
  const slice = visibleSlice(list);
  for (let i = slice.start; i < slice.end; i++) {
    const label = shell.overlayItems[i] ?? `item ${i}`;
    const active = i === list.activeIndex;
    if (!decision) {
      addOverlayRow(shell, ` ${active ? ">" : " "} ${label}`, active ? UI.text : UI.textDim);
      continue;
    }
    for (const row of decisionChoiceRows(label, active, width)) {
      addOverlayRow(shell, ` ${row.text}`, row.fg);
    }
  }
  paintAnswerRow(shell);
  paintDescriptionZone(shell, list);
}

/** Cursor cell shown at the end of the answer field while it has the keys. */
const ANSWER_CURSOR = "▌";

/**
 * Paint the free-text answer field, when the open overlay offers one. Always
 * on screen so "you may type instead of picking" is visible rather than folk
 * knowledge; dim and labelled with its key until it is taking keystrokes.
 */
function paintAnswerRow(shell: AppShell): void {
  const answer = overlayAnswerState(shell);
  if (answer === null) return;
  const width = overlayRowWidth(shell);
  if (!answer.active) {
    addOverlayRow(shell, ` Tab  type your own answer`, UI.textDim);
    return;
  }
  const label = "answer> ";
  const room = Math.max(1, width - label.length - ANSWER_CURSOR.length);
  const tail = answer.text.length > room ? answer.text.slice(-room) : answer.text;
  addOverlayRow(shell, ` ${label}${tail}${ANSWER_CURSOR}`, UI.text);
}

/**
 * Colour a composed rule. The frame stays faint so the labels it carries read
 * as the brighter thing on the row; the brand run is swapped for the lockup's
 * own cells, which is the only part of the border that animates.
 */
function ruleChunks(shell: AppShell, parts: readonly RulePart[]): TextChunk[] {
  const chunks: TextChunk[] = [];
  for (const part of parts) {
    if (part.role === "brand") {
      const cells = lockupCells(lockupFrameInput(shell));
      chunks.push(fgChunk(UI.textFaint)(" "));
      for (const cell of cells) chunks.push(fgChunk(cell.fg)(cell.char));
      chunks.push(fgChunk(UI.textFaint)(" "));
      continue;
    }
    if (part.role === "meter") {
      chunks.push(...meterChunks(shell, part.text));
      continue;
    }
    if (part.role === "attention") {
      chunks.push(fgChunk(UI.warning)(part.text));
      continue;
    }
    chunks.push(fgChunk(part.role === "label" ? UI.textDim : UI.textFaint)(part.text));
  }
  return chunks;
}

/**
 * Color a meter cell: the percent takes the band color (quiet `textDim`,
 * warning sand, danger red) and the optional cost suffix stays dim chrome.
 */
function meterChunks(shell: AppShell, cell: string): TextChunk[] {
  const meter = shell.costContext;
  const percentFg =
    meter?.band === "danger" ? UI.error : meter?.band === "warning" ? UI.warning : UI.textDim;
  if (meter === null) return [fgChunk(percentFg)(cell)];
  const percent = meter.percentLabel;
  const idx = cell.indexOf(percent);
  if (idx === -1) return [fgChunk(percentFg)(cell)];
  const before = cell.slice(0, idx);
  const after = cell.slice(idx + percent.length);
  const chunks: TextChunk[] = [];
  if (before.length > 0) chunks.push(fgChunk(UI.textFaint)(before));
  chunks.push(fgChunk(percentFg)(percent));
  if (after.length > 0) chunks.push(fgChunk(UI.textDim)(after));
  return chunks;
}

/** The status slot's state, as the lockup renderer wants it. */
function lockupFrameInput(shell: AppShell): LockupInput {
  return {
    nowMs: shell.lockupNowMs,
    still: !shell.lockupAnimating,
    phase: shell.lockupPhase,
    changedMs: shell.lockupChangedMs,
    rampPhase: shell.lockupRampPhase,
    stalledForMs: shell.lockupStalledForMs,
  };
}

/**
 * Repaint both border rules. Recomposed on every pass rather than cached: a
 * resize changes the column budget without changing any label, and the lockup
 * changes every animation frame without changing the geometry.
 */
export function paintPromptBorder(shell: AppShell): void {
  const width = shell.layout.contentWidth;
  const attention = composeAttentionLabel({
    mcp: shell.mcpNeedsAuth.length > 0,
    plugin: shell.pluginNeedsAttention,
  });
  const top = composeRule({
    width,
    corners: [BORDER.topLeft, BORDER.topRight],
    ...(attention !== undefined ? { attention } : {}),
    ...(shell.modelLabel !== null ? { label: shell.modelLabel } : {}),
  });
  shell.promptTopRule.content = new StyledText(ruleChunks(shell, top));

  // Corners, both rule margins, the gap and the spaces around each label are
  // what the workspace has to fit inside — with the lockup if the rule can
  // seat both, without it if it cannot. Where the row can only afford one, the
  // information wins and the mark goes.
  const withBrand = Math.max(0, width - 9 - lockupWidth(lockupFrameInput(shell)));
  const alone = Math.max(0, width - 6);
  const workspaceInput = {
    cwd: shell.workspace.cwd,
    branch: shell.workspace.branch,
    home: homedir(),
  };
  // A workspace that has lost its path is a branch floating with no context,
  // which is worth less than the mark it displaced. So the mark yields not just
  // when the label cannot fit at all, but when keeping it would starve the path.
  const roomyRaw = composeWorkspaceLabel({ ...workspaceInput, maxWidth: withBrand });
  const roomy = roomyRaw.startsWith("(") ? "" : roomyRaw;
  const workspace =
    roomy.length > 0 ? roomy : composeWorkspaceLabel({ ...workspaceInput, maxWidth: alone });
  const brand = lockupText(lockupCells(lockupFrameInput(shell)));
  const meter = shell.costContext;
  const bottom = composeRule({
    width,
    corners: [BORDER.bottomLeft, BORDER.bottomRight],
    ...(roomy.length > 0 || workspace.length === 0 ? { brand } : {}),
    ...(meter !== null
      ? { meter: costContextText(meter, true), meterCompact: costContextText(meter, false) }
      : {}),
    ...(workspace.length > 0 ? { label: workspace } : {}),
  });
  shell.promptBottomRule.content = new StyledText(ruleChunks(shell, bottom));
}

/** Publish the `profile · model · effort` label carried by the top border. */
export function setPromptModelLabel(shell: AppShell, input: PromptActionBarModelLabelInput): void {
  const label = composePromptActionBarModelLabel(input) ?? null;
  if (label === shell.modelLabel) return;
  shell.modelLabel = label;
  paintPromptBorder(shell);
}

/** Publish the working directory and git branch carried by the bottom border. */
export function setPromptWorkspace(
  shell: AppShell,
  input: { readonly cwd?: string; readonly branch?: string | null },
): void {
  const cwd = input.cwd ?? shell.workspace.cwd;
  const branch = input.branch === undefined ? shell.workspace.branch : input.branch;
  if (cwd === shell.workspace.cwd && branch === shell.workspace.branch) return;
  shell.workspace = { cwd, branch };
  paintPromptBorder(shell);
}

/**
 * Publish the cost/context meter carried by the bottom border. Driven by
 * usage changes (a completed turn), not a timer: the percentage does not move
 * between turns, so there is nothing to animate on the idle tick.
 */
export function setPromptCostContext(
  shell: AppShell,
  input: {
    readonly contextPercentUsed: number | null;
    readonly costLabel?: string | null;
    readonly contextIsEstimate: boolean;
  },
): void {
  const meter = composeCostContextMeter(input);
  if (meterEquals(meter, shell.costContext)) return;
  shell.costContext = meter;
  paintPromptBorder(shell);
}

function meterEquals(a: CostContextMeter | null, b: CostContextMeter | null): boolean {
  if (a === null || b === null) return a === b;
  return a.percentLabel === b.percentLabel && a.costLabel === b.costLabel;
}

/**
 * How the landing divides its rows around the prompt box.
 *
 * A floated overlay is clipped to the rows above the box so it never covers the
 * thing the operator types into. Losing the tail of a long body to that clip is
 * survivable; losing every choice is not, because then the surface cannot be
 * answered. So the box slides down just far enough to keep the overlay's full,
 * already fraction-capped height on screen, and the starters below it pay for
 * the move.
 */
function landingSplitFor(
  landingRows: number,
  minOverlayRows: number,
  padRows: number,
): { readonly above: number; readonly below: number } {
  const even = splitLandingRows(landingRows);
  const needed = Math.min(landingRows, minOverlayRows - padRows);
  if (minOverlayRows <= 0 || even.above >= needed) return even;
  return { above: needed, below: Math.max(0, landingRows - needed) };
}

export function applyLayout(shell: AppShell, layout: GeometryLayout): void {
  // Rows lay themselves out against the column budget (right-aligned bubbles,
  // pre-wrapped reasoning blocks), so a width change invalidates every painted
  // row rather than just reflowing it.
  const widthChanged =
    shell.layout.contentWidth !== layout.contentWidth ||
    shell.layout.chatWidth !== layout.chatWidth ||
    shell.layout.layoutMode !== layout.layoutMode;
  shell.layout = layout;
  const h = layout.heights;

  shell.root.paddingLeft = layout.sideMargin;
  shell.root.paddingRight = layout.sideMargin;

  // Raw renderer size, not `layout.terminal` — that is already net of the row
  // this badge itself reserves (see `terminalForGeometry`), which would make
  // the threshold check its own effect. Landing-only: see `relayout`.
  shell.versionRow.visible =
    isLanding(shell) && versionBadgeVisible(shell.renderer.width, shell.renderer.height);

  const taskH = Math.max(0, h.task);
  shell.taskBox.height = taskH > 0 ? taskH : 1;
  shell.taskBox.visible = taskH > 0;

  const agentsH = Math.max(0, h.agents);
  shell.agentsBox.visible = agentsH > 0;

  // Both pads are taken out of the transcript residual, never out of chrome,
  // so the resolver's row budget still sums to the terminal height.
  const transcriptH = Math.max(0, h.transcript);
  const padH = resolveTopPadRows(transcriptH);
  shell.topPad.height = padH > 0 ? padH : 1;
  shell.topPad.visible = padH > 0;

  const bottomPadH = resolveBottomMarginRows(layout.terminal.rows);
  shell.bottomPad.height = bottomPadH > 0 ? bottomPadH : 1;
  shell.bottomPad.visible = bottomPadH > 0;

  const overlayH = Math.max(0, h.overlay_host);

  // The landing splits the transcript residual around the prompt box so the box
  // sits on the terminal's middle row instead of at its foot. An open overlay
  // floats over that composition rather than displacing it, so the rows the
  // resolver took for the overlay host are handed back to the split.
  const bag = internals.get(shell);
  const landing = bag?.landing ?? null;
  const landingRows = transcriptH - padH - bottomPadH + (landing === null ? 0 : overlayH);
  // The resolver already sized overlayH to the overlay's real content (list
  // included) and capped it against the fraction/floor limits, so it is the
  // correct minimum to ask the landing split to make room for — asking for
  // less (e.g. just enough for one choice row) starves the list underneath
  // the title down to nearly nothing once floatOverlayHost pins the host to it.
  const split = landing === null ? null : landingSplitFor(landingRows, overlayH, padH);
  if (bag !== undefined && landing !== null && split !== null) {
    landing.above.box.height = Math.max(1, split.above);
    // A new zone can seat a different tier, and a tier is a different grid, so
    // the mark is redrawn rather than left showing the previous size's frame.
    fitLandingMark(landing.above, resolveMarkGrid(split.above, layout.contentWidth));
    paintLandingMark(landing.above, bag.landingNowMs, !bag.landingAnimating);
    landing.below.height = Math.max(0, split.below);
    landing.below.visible = split.below > 0;
  }

  const transcriptBody =
    split === null ? transcriptH - padH - bottomPadH : Math.max(1, split.above);
  shell.transcript.height = transcriptBody > 0 ? transcriptBody : 1;
  shell.transcript.visible = transcriptBody > 0;
  syncTranscriptSpacer(shell);

  // Agents strip: full-width flex stack under the transcript when present.
  // Live chrome keeps the zone empty (spawn_agent transcript rows instead).
  shell.agentsBox.position = "relative";
  shell.agentsBox.left = 0;
  shell.agentsBox.top = 0;
  shell.agentsBox.width = "100%";
  shell.agentsBox.height = agentsH > 0 ? agentsH : 1;
  shell.agentsBox.zIndex = 0;
  shell.transcript.width = "100%";

  const noticeH = Math.max(0, h.notice);
  shell.notice.height = noticeH > 0 ? noticeH : 1;
  shell.notice.visible = noticeH > 0;

  const promptH = Math.max(1, h.prompt);
  shell.promptBox.height = promptH;
  shell.promptBox.visible = promptH > 0;
  // The field takes whatever the box has left once both labelled rules are paid.
  const promptInnerH = Math.max(1, promptH - 2);
  shell.promptField.height = promptInnerH;
  // Sized explicitly rather than left to grow with its content: past the cap the
  // input has to scroll inside a fixed window instead of pushing the frame open.
  shell.prompt.height = promptInnerH;

  // Sized last: the float is anchored against chrome sized earlier in this
  // pass. Modal over the landing, an in-flow band once there is a transcript
  // to push.
  const floating = landing !== null && overlayH > 0;
  // Rows the flow spends before the prompt box — where a floated host's bottom
  // edge has to land, since the landing's box sits mid-screen rather than at
  // the foot and covering it would hide the thing the operator types into.
  // Stack: topPad, transcript, agents, task, then prompt (notice omitted —
  // same as before; it is transient chrome between task and prompt).
  const promptTop = padH + transcriptBody + agentsH + taskH;
  const hostH = floating ? Math.min(overlayH, Math.max(1, promptTop)) : overlayH;
  floatOverlayHost(shell, floating, Math.max(0, promptTop - hostH));
  shell.overlayHost.height = hostH > 0 ? hostH : 1;
  shell.overlayHost.visible = hostH > 0;
  if (hostH > 0 && shell.overlayList) {
    const chrome = overlayChromeRows(shell, shell.overlayBodyLines.length);
    const bodyH = Math.max(1, hostH - chrome);
    // The viewport counts items, not rows; a decision overlay spends several
    // rows per item, so the row budget has to be divided back down.
    const perItem = overlayRowsPerItem(shell.overlayKind);
    shell.overlayList = setListHeight(shell.overlayList, Math.max(1, Math.floor(bodyH / perItem)));
    paintOverlayList(shell);
  }

  paintPromptBorder(shell);

  // The landing owns the transcript's children until the first row lands, so a
  // resize there must not rebuild them out from under it.
  if (widthChanged && shell.streamLog.length > 0 && !isLanding(shell)) {
    repaintTranscriptWindow(shell);
  }

  // Width change changes the column budget the board fits to. Content may be
  // unchanged, so setChromeZones would skip the rebuild — do it here.
  if (widthChanged && bag !== undefined && bag.chrome.agents.length > 0) {
    renderAgentsRows(shell, clampBoardRows(bag.chrome.agents, agentsH), layout.contentWidth);
  }

  paintChrome(shell);
}

/**
 * Re-size the prompt box for what is now in it. Cheap enough to run on every
 * content change: it re-resolves geometry only when the row count actually
 * moves, which is once per wrapped line gained or lost.
 */
export function syncPromptRows(shell: AppShell): void {
  const rows = promptBoxRows(promptRowCount(shell.prompt), shell.renderer.height);
  if (rows === shell.layout.heights.prompt) return;
  relayout(shell, { promptContentRows: rows });
}

let cachedPromptSyntaxStyle: SyntaxStyle | null = null;
let cachedPromptRecognizedStyleId: number | null = null;

/**
 * The style registry backing the prompt's highlights, plus the one style id
 * this feature uses. Lazy for the same reason as `transcriptSyntaxStyle`:
 * construction reaches into the native render lib.
 */
function promptRecognizedStyleId(): number {
  if (cachedPromptSyntaxStyle === null) {
    cachedPromptSyntaxStyle = SyntaxStyle.fromStyles({
      recognized: { fg: UI.action },
    });
  }
  if (cachedPromptRecognizedStyleId === null) {
    cachedPromptRecognizedStyleId = cachedPromptSyntaxStyle.resolveStyleId("recognized") ?? 0;
  }
  return cachedPromptRecognizedStyleId;
}

const promptHighlightedValue = new WeakMap<AppShell, string>();

/**
 * Re-mark leading slash commands and @mentions in the prompt. Runs once per frame
 * (see `onFrame` in `createShell`), and only does anything when the prompt's
 * text actually changed since the last frame — typing that doesn't touch a
 * token, and every non-typing frame, is a no-op string comparison.
 */
export function syncPromptHighlights(shell: AppShell): void {
  const source = shellRecognitionSource.get(shell);
  if (source === undefined) return;
  const value = shell.prompt.value;
  if (promptHighlightedValue.get(shell) === value) return;
  promptHighlightedValue.set(shell, value);

  const styleId = promptRecognizedStyleId();
  shell.prompt.syntaxStyle = cachedPromptSyntaxStyle;
  shell.prompt.clearAllHighlights();
  const matcher = resolvePromptRecognitionMatcher(source);
  for (const span of resolvePromptHighlightSpans(value, matcher)) {
    shell.prompt.addHighlightByCharRange({ start: span.start, end: span.end, styleId });
  }
}

export interface RelayoutOpts {
  readonly columns?: number;
  readonly rows?: number;
  readonly visibility?: ZoneVisibility;
  readonly promptContentRows?: number;
  readonly overlayMode?: OverlayMode;
  readonly overlayBodyRows?: number;
  /**
   * Rows the open overlay cannot render without: border + title + at least
   * one content row. Below this, the box paints past whatever height it was
   * assigned instead of shrinking, so the resolver must never starve it here.
   */
  readonly overlayMinBodyRows?: number;
}

interface PriorOverlaySnapshot {
  readonly kind: PrimaryOverlayKind | null;
  readonly items: readonly string[];
  readonly bodyLines: readonly string[];
  readonly bodyFgs: readonly string[];
  readonly list: ListViewportState;
  readonly title: string;
  readonly paletteCommands: readonly PaletteCommand[];
  readonly itemIds: readonly string[];
  readonly itemValues: readonly (string | undefined)[];
  readonly onAccept: ((selection: OverlaySelection) => void) | null;
  readonly onToggleExpand: (() => void) | null;
  readonly onCycle: ((itemId: string, direction: -1 | 1) => void) | null;
  readonly describe: ((itemId: string) => ItemDescription | null) | null;
  readonly onAction: ((itemId: string, key: KeyEvent) => boolean) | null;
  readonly onPaste: ((text: string) => void) | null;
  readonly answer: OverlayAnswerState | null;
  readonly titleText: string;
  readonly onCancel: (() => void) | null;
  readonly onDispose: (() => void) | null;
  readonly isGate: boolean;
  readonly addProviderHint: boolean;
  readonly setDefaultHint: boolean;
  readonly mcpManageHint: boolean;
  readonly mcpAddHint: boolean;
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
  /** Optional stable ids aligned with overlayItems for the open primary. */
  overlayItemIds: readonly string[];
  /** Optional plain chosen values aligned with overlayItems for the open primary. */
  overlayItemValues: readonly (string | undefined)[];
  /** Per-open accept callback; cleared on close without invoke (Esc path). */
  overlayOnAccept: ((selection: OverlaySelection) => void) | null;
  /** False while an overlay that reports its own outcome is open. */
  overlayEchoChoice: boolean;
  /** Per-open expand/collapse hook for the open primary overlay. */
  overlayOnToggleExpand: (() => void) | null;
  /** Per-open ← → cycle hook for the open primary overlay (settings inline cycling). */
  overlayOnCycle: ((itemId: string, direction: -1 | 1) => void) | null;
  /** Per-open description-zone source; null keeps the zone off (no rows charged). */
  overlayDescribe: ((itemId: string) => ItemDescription | null) | null;
  /** Per-open bare-key claim for the open primary overlay. */
  overlayOnAction: ((itemId: string, key: KeyEvent) => boolean) | null;
  /** Per-open bracketed-paste owner for synthetic text panes. */
  overlayOnPaste: ((text: string) => void) | null;
  /** Whether the open primary advertises Alt+A and yields å/Å from type-to-filter. */
  overlayAddProviderHint: boolean;
  /** Whether the open primary advertises Alt+D in the footer hints. */
  overlaySetDefaultHint: boolean;
  /** Whether the open `/mcp` list advertises Alt+D / Alt+R. */
  overlayMcpManageHint: boolean;
  /** Whether the open `/mcp` list advertises Alt+A add. */
  overlayMcpAddHint: boolean;
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
  /**
   * Per-open dismiss hook for promise-backed overlays (permissions, operator).
   * Esc/closeInsetOverlay invokes this instead of silently dropping the
   * pending promise the way palette/mentions/copy overlays correctly do.
   */
  overlayOnCancel: (() => void) | null;
  /**
   * Per-open cleanup for a replaced or dismissed overlay (MCP unsubscribe).
   * closeReplaceableOverlay still runs this; it skips overlayOnCancel so
   * Esc-only navigation (add-provider back to models) does not fire.
   */
  overlayOnDispose: (() => void) | null;
  /** True while the open primary is a decision gate that must not be replaced. */
  overlayIsGate: boolean;
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
  paletteCatalog: readonly PaletteCommand[] | (() => readonly PaletteCommand[]) | null;
  /** Live filter state for the open palette, so typing can re-filter it. */
  paletteFilter: PaletteFilterState | null;
  /** Live type-to-filter state for a non-palette list overlay (model picker). */
  listFilter: ListFilterState | null;
  /**
   * Landing composition shown while the transcript has no content: the mark
   * above the prompt box, the disclosure and starters below it. Dropped (not
   * hidden) on the first row so it never occupies a transcript line later.
   */
  landing: { readonly above: LandingAbove; readonly below: BoxRenderable } | null;
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
   * Cancels the mount-scoped idle repaint timer (see `armLandingIdleTimer`
   * in `createAppShell`), or null while none is armed. Cleared by whichever
   * teardown happens first — the landing going away (`clearLandingMark`) or
   * the whole shell disposing (`dispose`) — so it can never outlive either.
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

const internals = new WeakMap<AppShell, ShellInternals>();

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
const transcriptSpacers = new WeakMap<AppShell, BoxRenderable>();

/**
 * Resize the transcript's leading filler to soak up leftover viewport space.
 * Reads `scrollHeight` (content height, filler included) net of the filler's
 * own last-applied height, so it stays correct regardless of wrapping,
 * markdown, or windowed long-log rebuilds.
 *
 * Deliberately NOT called at row-mutation time: `scrollHeight` reflects the
 * last completed layout, not the tree as it stands the instant a row lands —
 * a row whose own box needs a layout pass to size itself (structured/tool/
 * collapsible rows) reads back as shorter than it really is for one frame.
 * Growing the filler on that stale reading would claim room the row still
 * needs and bury it. Called from the render-frame hook instead, once that
 * pass has actually run.
 */
function syncTranscriptSpacer(shell: AppShell): void {
  const spacer = transcriptSpacers.get(shell);
  if (spacer === undefined) return;
  // The landing screen already bottom-anchors its own mark against the box
  // via the above/below split; a filler competing for the same content box
  // would double-count that space and squeeze the mark.
  if (isLanding(shell)) {
    if (spacer.height !== 0) spacer.height = 0;
    return;
  }
  const rowsHeight = Math.max(0, shell.transcript.scrollHeight - spacer.height);
  const nextHeight = Math.max(0, shell.transcript.height - rowsHeight);
  if (spacer.height !== nextHeight) spacer.height = nextHeight;
}

export function relayout(shell: AppShell, opts?: RelayoutOpts): GeometryLayout {
  const bag = internals.get(shell);
  const visibility = opts?.visibility ?? bag?.visibility ?? defaultVisibility();
  const promptContentRows = opts?.promptContentRows ?? bag?.promptContentRows;
  const overlayMode = opts?.overlayMode ?? bag?.overlayMode ?? "closed";
  const overlayBodyRows = opts?.overlayBodyRows ?? bag?.overlayBodyRows;
  const overlayMinBodyRows = opts?.overlayMinBodyRows ?? bag?.overlayMinBodyRows;
  if (bag) {
    bag.visibility = visibility;
    bag.promptContentRows = promptContentRows;
    bag.overlayMode = overlayMode;
    bag.overlayBodyRows = overlayBodyRows;
    bag.overlayMinBodyRows = overlayMinBodyRows;
  }

  const columns = opts?.columns ?? shell.renderer.width;
  const rows = opts?.rows ?? shell.renderer.height;
  const terminal = terminalOf(shell.renderer, { columns, rows });
  // Only the landing screen ever gives up a row for the version badge — once
  // a session has real transcript content every row is that content's, and
  // the badge simply stops showing (see `applyLayout`) rather than taking
  // space back from it.
  const versionReserved = isLanding(shell);
  const layout = resolveGeometry({
    terminal: versionReserved ? terminalForGeometry(terminal) : terminal,
    visibility,
    overlay:
      overlayMode === "closed"
        ? { mode: "closed" }
        : {
            mode: overlayMode,
            ...(overlayBodyRows !== undefined ? { bodyRows: overlayBodyRows } : {}),
            ...(overlayMinBodyRows !== undefined ? { minBodyRows: overlayMinBodyRows } : {}),
          },
    ...(promptContentRows !== undefined ? { promptContentRows } : {}),
    // The landing owns the screen until the first transcript row lands, so
    // holding rows back for a transcript that does not exist would only clip
    // whatever the operator opened over it. An open overlay is the exception:
    // it asks for exactly as many rows as it has content, and without the floor
    // a long list would claim the whole screen instead of scrolling.
    ...(isLanding(shell) && overlayMode === "closed"
      ? { transcriptFloor: 0 }
      : fleetTranscriptFloor(shell)),
  });
  applyLayout(shell, layout);
  return layout;
}

/**
 * Rows the transcript holds back once a fleet is running.
 *
 * With several lanes live the operator is managing a fleet rather than reading
 * a conversation, so the transcript gives up its idle floor to the board. It
 * keeps enough to stay a live tail — the orchestrator reporting back and asking
 * questions is still the main way the operator learns anything.
 */
function fleetTranscriptFloor(shell: AppShell): { transcriptFloor?: number } {
  const bag = internals.get(shell);
  if (!bag) return {};
  const lanes = bag.chrome.agents.filter((row) => row.kind === "lane").length;
  return lanes >= FLEET_FLOOR_MIN_LANES ? { transcriptFloor: FLEET_TRANSCRIPT_FLOOR } : {};
}

/**
 * Append a raw line to the sticky transcript ScrollBox.
 * stickyScroll + stickyStart "bottom" auto-follow until the operator scrolls up.
 */
export function appendTranscript(
  shell: AppShell,
  line: string,
  opts?: { readonly fg?: string },
): void {
  clearLandingMark(shell);
  shell.lineCount += 1;
  shell.transcript.add(
    new TextRenderable(shell.renderer as CliRenderer, {
      content: ` ${line}`,
      fg: opts?.fg ?? UI.text,
    }),
  );
  paintChrome(shell);
}

/**
 * Append a role-styled stream row to the **parent** transcript.
 * While subagent observe is active, rows go to the parent snapshot only
 * (not painted); leave restores them with the parent lease.
 */
export function appendStreamRow(shell: AppShell, row: StreamRow): void {
  if (shell.observe !== null && shell.parentStreamLog !== null) {
    shell.parentStreamLog.push(row);
    shell.parentStreamLogBase = trimRetainedLog(
      shell.parentStreamLog,
      shell.parentStreamLogBase ?? 0,
    );
    return;
  }
  paintAppendStreamRow(shell, row);
}

/**
 * Evict the oldest rows once `log` exceeds the retention cap and return the
 * new absolute base (the index `log[0]` now represents).
 *
 * Every index the bridge holds onto — tool-call rows, the open streaming
 * row, the retry boundary — is absolute (base + local position), so eviction
 * only has to bump the base; it never has to rewrite a stored index.
 */
function trimRetainedLog(log: StreamRow[], base: number): number {
  const drop = retentionOverflow(log.length);
  if (drop <= 0) return base;
  log.splice(0, drop);
  return base + drop;
}

/**
 * Append a child stream row while observing a subagent.
 * Host-pushed live events (not only fixture seed lines). No-op when not observing.
 * @returns true when the row was applied to the observe view
 */
export function appendObserveStreamRow(shell: AppShell, row: StreamRow): boolean {
  if (shell.observe === null) return false;
  shell.observe.lines.push(row);
  paintAppendStreamRow(shell, row);
  return true;
}

/**
 * Surface every row is laid out against: the transcript's own column budget
 * (rows right-align and wrap themselves) and whether writers need naming.
 * The scroll bars are hidden, so the transcript owns the whole content zone.
 */
export function transcriptRowLayout(shell: AppShell): RowLayout {
  return {
    width: Math.max(1, shell.layout.contentWidth),
    multiAgent: shell.agentVoices.size > 1,
  };
}

/**
 * Record a row's writer. Returns true when the transcript has just gained a
 * second voice — every earlier row now needs the label it was painted without.
 */
function noteAgentVoice(shell: AppShell, row: StreamRow): boolean {
  if (row.role === "user") return false;
  const before = shell.agentVoices.size;
  shell.agentVoices.add(row.agent ?? MAIN_AGENT);
  return before === 1 && shell.agentVoices.size === 2;
}

/** Row immediately before `index` in the log, or undefined at the start. */
function rowBefore(shell: AppShell, index: number): StreamRow | undefined {
  return index > 0 ? shell.streamLog[index - 1] : undefined;
}

/** Blank rows the row at `index` claims above itself. */
function gapBefore(shell: AppShell, index: number): number {
  const row = shell.streamLog[index];
  if (row === undefined) return 0;
  return rowGroupGap(rowBefore(shell, index), row);
}

/**
 * Writer label the row at `index` carries above it, or null mid-block.
 * A block is exactly a gap-free run from one writer, so this tracks
 * `gapBefore` rather than keeping its own notion of block boundaries.
 */
function labelBefore(shell: AppShell, index: number): string | null {
  const row = shell.streamLog[index];
  if (row === undefined) return null;
  return blockLabel(rowBefore(shell, index), row, transcriptRowLayout(shell));
}

/**
 * Notice painted above the oldest retained row once the cap has evicted
 * anything. Unlike the pre-CL-5551 collapse marker it replaces, scrolling
 * never reveals more — these rows are gone, not merely out of the window.
 */
function evictedRowsNotice(evicted: number): string {
  return ` … ${evicted} earlier row${evicted === 1 ? "" : "s"} dropped (past the retention limit)`;
}

/**
 * Surface a runtime/load notice without stealing the landing hero.
 *
 * MCP connection failures, hook failures and similar startup chatter used to
 * call `appendStreamRow` → `clearLandingMark`, wiping the mountain the moment
 * anything went wrong on load (CL-5618 / CL-5600). While the landing is still
 * mounted the wording rides the notice strip and the row is held for flush
 * once a real session row ends the landing; after that it is a normal system
 * row.
 *
 * Every producer of a system-class row belongs here rather than at
 * `appendStreamRow`. CL-5618 fixed the MCP and hook producers one at a time
 * and the plugin producer kept the defect, which is what per-call-site rules
 * buy you. Reaching for `appendStreamRow` directly is the bug.
 */
/**
 * Suspend or resume the shell's own key/paste/submit handling. A full-screen
 * surface that borrows this renderer (the inline provider connect) owns the
 * keyboard for its lifetime; without this, Ctrl+C during a sign-in would
 * also reach the shell and interrupt the running agent.
 */
export function setShellInputSuspended(shell: AppShell, suspended: boolean): void {
  const bag = internals.get(shell);
  if (bag !== undefined) bag.inputSuspended = suspended;
}

export function surfaceSystemNotice(shell: AppShell, text: string): void {
  if (isLanding(shell)) {
    const bag = internals.get(shell);
    if (bag !== undefined) {
      bag.landingDeferredRows.push({ role: "system", text });
    }
    setStatusFlash(shell, text);
    return;
  }
  appendStreamRow(shell, { role: "system", text });
}

/**
 * Paint + push onto the visible streamLog (child while observing, parent
 * otherwise). The paint tree stays 1:1 with the (retention-capped) log —
 * CL-5551 already bounds `streamLog` to `MAX_RETAINED_STREAM_ROWS`, so there
 * is no separate, smaller window to maintain on top of it: every retained
 * row gets a node, which is also what makes all of it reachable by
 * scrolling (CL-5553). A trim past the cap costs one node removal here, not
 * a rebuild.
 */
function paintAppendStreamRow(shell: AppShell, row: StreamRow): void {
  clearLandingMark(shell);
  const gainedVoice = noteAgentVoice(shell, row);
  shell.streamLog.push(row);
  const baseBefore = shell.streamLogBase;
  shell.streamLogBase = trimRetainedLog(shell.streamLog, shell.streamLogBase);
  shell.lineCount = shell.streamLog.length;

  if (gainedVoice) {
    repaintTranscriptWindow(shell);
    paintChrome(shell);
    return;
  }

  const dropped = shell.streamLogBase - baseBefore;
  if (dropped > 0) {
    for (const evicted of transcriptRowChildren(shell).slice(0, dropped)) {
      shell.transcript.remove(evicted);
      destroySubtree(evicted);
    }
    const marker = transcriptMarker(shell);
    if (marker instanceof TextRenderable) {
      marker.content = evictedRowsNotice(shell.streamLogBase);
    } else {
      const node = new TextRenderable(shell.renderer as CliRenderer, {
        content: evictedRowsNotice(shell.streamLogBase),
        fg: UI.textDim,
      });
      evictionMarkers.add(node);
      shell.transcript.add(node, 1);
    }
  }

  const index = shell.streamLog.length - 1;
  shell.transcript.add(
    createStreamRowRenderable(
      shell,
      row,
      gapBefore(shell, index),
      labelBefore(shell, index),
      shell.streamLogBase + index,
    ),
  );
  paintChrome(shell);
}

/** Row count of the log `appendStreamRow` currently targets (parent or observe). */
export function streamRowCount(shell: AppShell): number {
  return shell.observe !== null && shell.parentStreamLog !== null
    ? shell.parentStreamLog.length
    : shell.streamLogBase + shell.streamLog.length;
}

/**
 * Row at absolute `index` on the log `appendStreamRow` currently targets. A
 * tool result rewrites the call row it answers rather than appending its
 * own, and needs to read that row back to fold into it.
 *
 * `index` is absolute (see `streamLogBase`); a row already evicted by the
 * retention cap reads back as undefined, same as one past the end.
 */
export function streamRowAt(shell: AppShell, index: number): StreamRow | undefined {
  if (shell.observe !== null && shell.parentStreamLog !== null) {
    const local = index - (shell.parentStreamLogBase ?? 0);
    return local >= 0 && local < shell.parentStreamLog.length
      ? shell.parentStreamLog[local]
      : undefined;
  }
  const local = index - shell.streamLogBase;
  return local >= 0 && local < shell.streamLog.length ? shell.streamLog[local] : undefined;
}

/**
 * Drop every row from absolute `length` onward on the log `appendStreamRow`
 * targets.
 *
 * A committed inference attempt that fails is re-streamed from scratch, so the
 * transcript has to retract what the failed attempt already painted instead of
 * letting the replay pile up underneath it. A boundary the retention cap has
 * already evicted has nothing left to retract, so this is a no-op rather than
 * mis-truncating the tail that replaced it.
 */
export function truncateStreamRows(shell: AppShell, length: number): void {
  const observing = shell.observe !== null && shell.parentStreamLog !== null;
  const log = observing ? shell.parentStreamLog! : shell.streamLog;
  const base = observing ? (shell.parentStreamLogBase ?? 0) : shell.streamLogBase;
  const local = length - base;
  if (local < 0 || local >= log.length) return;
  log.length = local;
  if (log !== shell.streamLog) return;
  shell.lineCount = shell.streamLog.length;
  repaintTranscriptWindow(shell);
  paintChrome(shell);
}

/**
 * Empty the visible transcript for a fresh session (/clear, /new).
 *
 * Backend session rotation lives in the runner; this is only the on-screen wipe
 * the OpenTUI host must own after the Ink App path went away. Observe mode is
 * dropped first so a child view cannot keep painting into a cleared parent.
 * Retention base resets so the screen matches a brand-new session, not a window
 * over an empty retained log with a stale eviction marker.
 */
export function clearTranscript(shell: AppShell): void {
  if (shell.observe !== null) {
    // Drop observe without the "left observe" system row — the whole log is
    // about to go and a farewell row would only flash then vanish.
    shell.observe = null;
    shell.parentStreamLog = null;
    shell.parentStreamLogBase = null;
    let guard = 4;
    while (guard-- > 0 && focusOwner(shell.focus) === "observe") {
      shell.focus = popFocus(shell.focus);
    }
    const frames = shell.focus.frames.filter((f) => f.target !== "observe");
    if (frames.length !== shell.focus.frames.length) {
      shell.focus = { frames };
    }
    setChromeZones(shell, { agents: null });
    applyFocus(shell);
  }
  shell.streamLog.length = 0;
  shell.streamLogBase = 0;
  shell.lineCount = 0;
  shell.parentStreamLog = null;
  shell.parentStreamLogBase = null;
  repaintTranscriptWindow(shell);
  paintChrome(shell);
}

/**
 * Identifies a transcript child as the eviction notice rather than a row.
 * Identity, not position or state, is the source of truth: `streamLogBase`
 * flips to nonzero the instant a trim happens, one step before the notice
 * node itself exists in the paint tree, so deriving "is there a marker"
 * from state would misalign row indices for exactly that transitional call.
 */
const evictionMarkers = new WeakSet<BaseRenderable>();

/**
 * Row-index code paths (below, and the two windowed-rebuild callers) treat
 * `getChildren()` as a 1:1 array with `streamLog`. The leading bottom-anchor
 * spacer (see `transcriptSpacers`) and, once retention has evicted anything,
 * the eviction notice above the oldest retained row both break that — every
 * consumer that needs the row-only view goes through here rather than the
 * raw call.
 */
function transcriptRowChildren(shell: AppShell): readonly BaseRenderable[] {
  const children = shell.transcript.getChildren().slice(1);
  return children.length > 0 && evictionMarkers.has(children[0]!) ? children.slice(1) : children;
}

/** The eviction-notice node, if the retention cap has dropped anything. */
function transcriptMarker(shell: AppShell): BaseRenderable | undefined {
  const children = shell.transcript.getChildren().slice(1);
  return children.length > 0 && evictionMarkers.has(children[0]!) ? children[0] : undefined;
}

/** Raw child-list offset before the first row: the spacer, plus the notice if present. */
function transcriptRowOffset(shell: AppShell): number {
  return transcriptMarker(shell) === undefined ? 1 : 2;
}

/**
 * Rewrite an already-appended transcript row in place.
 *
 * Streaming assistant and thinking bodies grow token by token; the bridge keeps
 * one open row and replaces it on every delta rather than appending a row per
 * token. Repaints only the affected node while the log fits without windowing.
 *
 * `index` is absolute (see `streamLogBase`); a row the retention cap has
 * already evicted is a no-op rather than corrupting an unrelated row at the
 * same array slot.
 */
export function replaceStreamRowAt(shell: AppShell, index: number, row: StreamRow): void {
  if (shell.observe !== null && shell.parentStreamLog !== null) {
    const parentLocal = index - (shell.parentStreamLogBase ?? 0);
    if (parentLocal >= 0 && parentLocal < shell.parentStreamLog.length) {
      shell.parentStreamLog[parentLocal] = row;
    }
    return;
  }
  const local = index - shell.streamLogBase;
  if (local < 0 || local >= shell.streamLog.length) return;
  shell.streamLog[local] = row;

  const children = transcriptRowChildren(shell);
  // A raw appendTranscript line breaks the 1:1 node↔row mapping; fall back to
  // a full repaint, which derives every node from the log.
  if (children.length !== shell.streamLog.length) {
    repaintTranscriptWindow(shell);
    paintChrome(shell);
    return;
  }

  const stale = children[local];
  if (stale && retextStreamRow(shell, stale, row, labelBefore(shell, local))) {
    paintChrome(shell);
    return;
  }
  if (stale) {
    shell.transcript.remove(stale);
    destroySubtree(stale);
  }
  // Raw child list is spacer (+ eviction notice, if any) then rows; see
  // `transcriptRowOffset` (see `transcriptRowChildren` for why row 0 is not
  // simply index 1).
  shell.transcript.add(
    createStreamRowRenderable(
      shell,
      row,
      gapBefore(shell, local),
      labelBefore(shell, local),
      index,
    ),
    local + transcriptRowOffset(shell),
  );
  paintChrome(shell);
}

/**
 * Rewrite a row's body on its existing paint node.
 *
 * Streaming rows are replaced on every token, and tearing the node down each
 * time would drop the markdown parser's block state — the very thing that makes
 * incremental rendering stable. Returns false when the node shape does not
 * match the row and the caller must rebuild it — including a row whose block
 * label just appeared or disappeared, since that changes the node's shape.
 */
function retextStreamRow(
  shell: AppShell,
  node: BaseRenderable,
  row: StreamRow,
  label: string | null,
): boolean {
  if (row.diff !== undefined || row.structured !== undefined) return false;
  // A sentence-style tool row paints via styled lines (verb + coloured
  // subject, and a diff/detail tail once expanded) rather than a single-fg
  // TextRenderable, so it always rebuilds like diff/structured rows do.
  if (isSentenceRow(row)) return false;
  // Expanding swaps a text row for a styled-lines box: a different node shape
  // and a different height, so the caller must rebuild rather than re-text.
  if (isExpansionRow(row)) return false;
  const layout = transcriptRowLayout(shell);

  if (label !== null) {
    if (!(node instanceof BoxRenderable)) return false;
    const [headerNode, innerNode] = node.getChildren();
    if (!(headerNode instanceof TextRenderable) || innerNode === undefined) return false;
    if (!retextStreamRowBody(innerNode, row, layout)) return false;
    headerNode.content = label;
    return true;
  }

  return retextStreamRowBody(node, row, layout);
}

/** The shape-matching rewrite shared by labelled and unlabelled rows. */
function retextStreamRowBody(node: BaseRenderable, row: StreamRow, layout: RowLayout): boolean {
  if (node instanceof TextRenderable) {
    if (isMarkdownRow(row)) return false;
    node.content = paintStreamRow(row, layout).content;
    return true;
  }

  if (!(node instanceof BoxRenderable) || !isMarkdownRow(row)) return false;
  const [gutterNode, bodyNode] = node.getChildren();
  if (!(gutterNode instanceof TextRenderable)) return false;
  const gutter = streamRowGutter(row, layout);
  gutterNode.content = gutter.content;
  gutterNode.width = stringWidth(gutter.content);
  const width = markdownBodyColumns(gutter, layout);
  const content = markdownContent(row);
  const split = splitAtSettledHeading(content);

  // No settled heading behind the tail: a lone renderer, same as an unsplit
  // body. A shape change (a heading just closed, or one just left the window
  // a full rebuild trimmed) falls through to the caller's rebuild.
  if (split === null) {
    if (!(bodyNode instanceof MarkdownRenderable)) return false;
    bodyNode.width = width;
    bodyNode.content = content;
    bodyNode.streaming = row.streaming === true;
    return true;
  }

  if (!(bodyNode instanceof BoxRenderable)) return false;
  const [frozenNode, liveNode] = bodyNode.getChildren();
  if (!(frozenNode instanceof MarkdownRenderable) || !(liveNode instanceof MarkdownRenderable)) {
    return false;
  }
  bodyNode.width = width;
  frozenNode.width = width;
  frozenNode.content = split.frozen;
  liveNode.width = width;
  liveNode.content = split.live;
  liveNode.streaming = row.streaming === true;
  liveNode.marginTop = split.gapRows;
  return true;
}

/**
 * Rebuild the transcript paint tree from `streamLog` — every retained row,
 * not a smaller window of it. `streamLog` is already capped at
 * `MAX_RETAINED_STREAM_ROWS`, so this is O(cap), and painting all of it is
 * what makes the full retained history reachable by scrolling.
 */
export function repaintTranscriptWindow(shell: AppShell): void {
  clearLandingMark(shell);
  shell.agentVoices = new Set(agentVoicesIn(shell.streamLog));
  // The bottom-anchor spacer (index 0) stays; the eviction notice (if any)
  // and every row get torn down and rebuilt from the log.
  for (const child of shell.transcript.getChildren().slice(1)) {
    shell.transcript.remove(child);
    destroySubtree(child);
  }

  // Rows evicted by the retention cap are gone for good, not just scrolled
  // past — say so, or the boundary reads as the true start of history.
  if (shell.streamLogBase > 0) {
    const marker = new TextRenderable(shell.renderer as CliRenderer, {
      content: evictedRowsNotice(shell.streamLogBase),
      fg: UI.textDim,
    });
    evictionMarkers.add(marker);
    shell.transcript.add(marker);
  }

  shell.streamLog.forEach((row, local) => {
    shell.transcript.add(
      createStreamRowRenderable(
        shell,
        row,
        gapBefore(shell, local),
        labelBefore(shell, local),
        shell.streamLogBase + local,
      ),
    );
  });
}

/**
 * Tear the landing down on the first transcript row.
 *
 * The prompt box travels from the middle of the screen to the bottom, which is
 * a jump; it happens on the same frame as the operator's own first row so it
 * reads as the screen answering them rather than as the layout twitching.
 *
 * System/runtime notices deferred while the hero was up are flushed into the
 * transcript here so they stay durable once the session has content, without
 * ever having stolen the mountain on the way in.
 */
function clearLandingMark(shell: AppShell): void {
  const bag = internals.get(shell);
  const landing = bag?.landing;
  if (bag === undefined || landing === null || landing === undefined) return;
  bag.landing = null;
  bag.landingIdleTimerCancel?.();
  bag.landingIdleTimerCancel = null;
  shell.transcript.remove(landing.above.box);
  destroySubtree(landing.above.box);
  shell.root.remove(landing.below);
  destroySubtree(landing.below);
  relayout(shell);

  const notice = bag.landingNotice;
  if (notice !== null) {
    bag.landingNotice = null;
    appendStreamRow(shell, { role: "system", text: notice });
  }

  const deferred = bag.landingDeferredRows;
  if (deferred.length > 0) {
    bag.landingDeferredRows = [];
    // The notice strip held the latest wording while the mark was up; the
    // rows themselves are durable now, so drop the flash rather than double-paint.
    setStatusFlash(shell, null);
    for (const row of deferred) appendStreamRow(shell, row);
  }
}

/**
 * Cadence of the mount-scoped idle repaint timer (see `armLandingIdleTimer`
 * in `createAppShell`). The snow only needs to advance about half a row per
 * second, so ~8fps is comfortably enough to read as motion.
 */
const LANDING_IDLE_REPAINT_INTERVAL_MS = 125;

/**
 * Repaint the landing mark for `nowMs`. `animating` runs the mountain's
 * draw/fill/fade timeline; anything else holds its filled frame. No-op once
 * the landing is gone, so the caller can drive it unconditionally.
 *
 * Always repaints while the landing is up, even when `animating` is false:
 * the landing is idle by definition (no turn processing), and snow still
 * needs to drift across a frozen mountain. Driven by the mount-scoped timer
 * armed in `createAppShell` (see `armLandingIdleTimer`) rather than a render
 * event, so the repaint cadence is independent of however often the renderer
 * happens to paint.
 */
export function paintLanding(
  shell: AppShell,
  nowMs: number,
  animating: boolean,
  reducedMotion = false,
): void {
  const bag = internals.get(shell);
  const landing = bag?.landing;
  if (bag === undefined || landing === null || landing === undefined) return;
  bag.landingAnimating = animating;
  bag.landingNowMs = nowMs;
  paintLandingMark(landing.above, nowMs, !animating, reducedMotion);
}

/** True while the landing composition is still mounted. */
export function isLanding(shell: AppShell): boolean {
  return (internals.get(shell)?.landing ?? null) !== null;
}

/**
 * Fill the prompt from a landing starter. Returns false when the key selects
 * nothing, the landing is gone, or the operator has already typed.
 */
export function applyLandingSuggestion(shell: AppShell, key: string): boolean {
  if (!isLanding(shell) || shell.prompt.value.length > 0) return false;
  const suggestion = landingSuggestionFor(key);
  if (suggestion === null) return false;
  shell.prompt.value = suggestion.prompt;
  return true;
}

/**
 * Prefix column beside a body the renderer owns. Width is pinned to the painted
 * columns so an empty gutter — a lone agent's own prose — costs none, and the
 * answer starts on the transcript's first column.
 */
function gutterNode(ctx: CliRenderer, gutter: PaintedStreamLine): TextRenderable {
  return new TextRenderable(ctx, {
    content: gutter.content,
    fg: gutter.fg,
    flexShrink: 0,
    width: stringWidth(gutter.content),
  });
}

/**
 * Columns a markdown body may paint into: the transcript budget less the
 * row's own prefix. Pinned rather than left to `flexGrow`, which reports the
 * body's intrinsic width to yoga and lets a wide table paint past the edge.
 */
function markdownBodyColumns(gutter: PaintedStreamLine, layout: RowLayout): number {
  return Math.max(1, layout.width - stringWidth(gutter.content));
}

/**
 * Markdown tables shrink to the row's column budget rather than overflowing:
 * columns are fitted proportionally and cells wrap on word boundaries. A table
 * still too wide for its narrowest fit is clipped by the body's pinned width,
 * which keeps it inside the transcript instead of painting over the chrome.
 */
const TRANSCRIPT_TABLE_OPTIONS = {
  wrapMode: "word",
  columnFitter: "proportional",
} as const;

/**
 * Markdown source for a row, with a half-arrived heading marker withheld.
 *
 * A trailing `####` with nothing after it yet is not a heading — it is literal
 * text, and that is what the parser makes of it, so the row paints the bare
 * markers for one delta and drops them the moment the title's first character
 * lands. Holding that line back until it has content keeps a line's
 * classification from flipping under text that is already on screen.
 */
function markdownContent(row: StreamRow): string {
  if (row.streaming !== true) return row.text;
  return row.text.replace(/(^|\n)#{1,6}[ \t]*$/, "$1");
}

/**
 * An ATX heading line (`#` through `######`) with a title, not a bare marker.
 * CommonMark allows the marker up to 3 spaces in; a 4th makes it indented code
 * instead, which this line still has to reject.
 */
const HEADING_LINE_RE = /^ {0,3}#{1,6}[ \t]+\S.*$/;

/**
 * A fenced code block's opening delimiter: three or more backticks or tildes,
 * optionally indented up to three spaces (CommonMark's limit before a fence
 * counts as indented code instead), followed by anything (an info string,
 * e.g. the "bash" in ` ```bash `).
 */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * A fenced code block's closing delimiter. Unlike the opener, CommonMark
 * requires the closing line to contain nothing but the fence run and
 * trailing whitespace — "```stillcode" does not close a fence, it is more
 * fence content — so this is deliberately not just `FENCE_OPEN_RE` again.
 */
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Lines that are inside a fenced code block, where a leading `#` is a shell
 * comment or similar and never a heading. A closer needs the same character
 * as the opener and a run at least as long — a shorter run, a run of the
 * other character, or a closing-shaped line carrying trailing text is just
 * more fence content, per CommonMark.
 */
function fencedLineMask(lines: readonly string[]): boolean[] {
  const inside = new Array<boolean>(lines.length).fill(false);
  let opener: { char: string; length: number } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (opener === null) {
      const match = lines[i]!.match(FENCE_OPEN_RE);
      if (match) {
        inside[i] = true;
        opener = { char: match[1]![0]!, length: match[1]!.length };
      }
      continue;
    }
    inside[i] = true;
    const close = lines[i]!.match(FENCE_CLOSE_RE);
    if (close && close[1]![0] === opener.char && close[1]!.length >= opener.length) {
      opener = null;
    }
  }
  return inside;
}

/**
 * A markdown body split at the last heading that already has content behind
 * it: everything through that heading, and everything after it.
 *
 * The renderer's own incremental parser only reuses a block whose raw text is
 * unchanged; the default block mode merges a heading into the same raw chunk
 * as the paragraph that follows it, so every keystroke of that paragraph
 * changes the merged chunk's raw text and forces the heading's already-settled
 * markup to re-highlight too — visibly flickering while the rest of the
 * message keeps streaming in. Rendering the two halves as separate
 * `MarkdownRenderable`s keeps the heading's renderer untouched once it is no
 * longer the one growing, without changing how paragraphs, lists or tables
 * inside either half are laid out (both halves still use the library's
 * default block mode).
 */
export interface MarkdownSplit {
  readonly frozen: string;
  readonly live: string;
  /** Blank source lines between the heading and what follows it (0 or 1). */
  readonly gapRows: number;
}

export function splitAtSettledHeading(text: string): MarkdownSplit | null {
  const lines = text.split("\n");
  const insideFence = fencedLineMask(lines);
  let boundary = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!insideFence[i] && HEADING_LINE_RE.test(lines[i]!)) boundary = i;
  }
  // No heading, or the last one is still the open tail: nothing to freeze.
  if (boundary === -1 || boundary >= lines.length - 1) return null;
  const rest = lines.slice(boundary + 1);
  const firstContent = rest.findIndex((line) => line.trim().length > 0);
  // Heading closed but nothing has started under it yet.
  if (firstContent === -1) return null;
  return {
    frozen: lines.slice(0, boundary + 1).join("\n"),
    live: rest.slice(firstContent).join("\n"),
    gapRows: firstContent > 0 ? 1 : 0,
  };
}

/**
 * Build the row-shaped paint node: a MarkdownRenderable body next to a plain
 * gutter for markdown-bearing rows (assistant replies), a TextTableRenderable
 * for structured rows (MCP results), a coloured diff body for edit-tool rows,
 * and literal text for everything else.
 */
function buildRowNode(
  ctx: CliRenderer,
  row: StreamRow,
  layout: RowLayout,
  onToggle?: () => void,
): TextRenderable | BoxRenderable {
  if (isSentenceRow(row)) {
    // The sentence is one line: it is cut to the columns beside the marker
    // rather than wrapped, so a long URL or query cannot double the row.
    const columns = Math.max(1, layout.width - stringWidth(streamRowGutter(row, layout).content));
    if (row.structured !== undefined) {
      // The table is what the sentence hides; collapsed, the sentence is the row.
      return row.expanded === true
        ? createStructuredRowRenderable(
            ctx,
            row,
            layout,
            row.structured,
            toolSentenceLines(row, columns),
            onToggle,
          )
        : createStyledLinesRowRenderable(
            ctx,
            row,
            layout,
            toolSentenceLines(row, columns),
            onToggle,
          );
    }
    return createStyledLinesRowRenderable(ctx, row, layout, toolRowLines(row, columns), onToggle);
  }

  if (row.diff !== undefined) {
    return createStyledLinesRowRenderable(ctx, row, layout, row.diff.lines);
  }

  const expanded = expandedRowLines(row, layout);
  if (expanded !== null) {
    return createStyledLinesRowRenderable(ctx, row, layout, expanded);
  }

  if (row.structured !== undefined) {
    return createStructuredRowRenderable(ctx, row, layout, row.structured);
  }

  if (!isMarkdownRow(row)) {
    const painted = paintStreamRow(row, layout);
    return new TextRenderable(ctx, { content: painted.content, fg: painted.fg });
  }

  const gutter = streamRowGutter(row, layout);
  const wrapper = new BoxRenderable(ctx, { flexDirection: "row", width: "100%" });
  wrapper.add(gutterNode(ctx, gutter));
  wrapper.add(createMarkdownBody(ctx, row, gutter, layout));
  return wrapper;
}

/** Shared construction options for a transcript markdown body's renderer. */
function markdownBodyOptions(gutter: PaintedStreamLine, width: number) {
  return {
    syntaxStyle: transcriptSyntaxStyle(),
    fg: gutter.fg,
    width,
    flexShrink: 0,
    tableOptions: TRANSCRIPT_TABLE_OPTIONS,
  } as const;
}

/**
 * A markdown row's body. Most rows have no settled heading yet (no heading at
 * all, or the only one is still the open tail), and paint through a single
 * renderer, same as before this fix existed. Once a heading closes, the body
 * becomes a settled `frozen` renderer — everything through that heading,
 * never streaming, never handed new content while the tail keeps growing, so
 * it is never asked to re-highlight once written — stacked above the still
 * `live` one, which carries the row's own streaming flag. Both halves use the
 * library's default block mode, so paragraphs, lists and tables inside either
 * one lay out exactly as a single unsplit body would.
 */
function createMarkdownBody(
  ctx: CliRenderer,
  row: StreamRow,
  gutter: PaintedStreamLine,
  layout: RowLayout,
): MarkdownRenderable | BoxRenderable {
  const width = markdownBodyColumns(gutter, layout);
  const content = markdownContent(row);
  const split = splitAtSettledHeading(content);
  if (split === null) {
    return new MarkdownRenderable(ctx, {
      ...markdownBodyOptions(gutter, width),
      content,
      // Native incremental block stability: only the trailing block is unstable.
      streaming: row.streaming === true,
    });
  }
  const column = new BoxRenderable(ctx, { flexDirection: "column", width });
  column.add(
    new MarkdownRenderable(ctx, {
      ...markdownBodyOptions(gutter, width),
      content: split.frozen,
      streaming: false,
    }),
  );
  column.add(
    new MarkdownRenderable(ctx, {
      ...markdownBodyOptions(gutter, width),
      content: split.live,
      streaming: row.streaming === true,
      marginTop: split.gapRows,
    }),
  );
  return column;
}

/**
 * Build the paint node for one transcript row, including its writer label
 * when this row opens a new block (see `blockLabel`). The label is one text
 * child stacked above the row's own node in a column wrapper — never a
 * separate transcript child — so the 1:1 log-index-to-child mapping holds.
 */
export function createStreamRowRenderable(
  shell: AppShell,
  row: StreamRow,
  marginTop = 0,
  label: string | null = null,
  index?: number,
): TextRenderable | BoxRenderable {
  const ctx = shell.renderer as CliRenderer;
  const layout = transcriptRowLayout(shell);
  // `index` is absolute (see `streamLogBase`), so it stays the row's index
  // for as long as its node lives even if the retention cap trims the array
  // out from underneath it later. `toggleRowExpandedAt` converts it back to
  // a local array position at click time, not here.
  const onToggle =
    index === undefined || !isCollapsibleRow(row)
      ? undefined
      : () => {
          toggleRowExpandedAt(shell, index);
        };
  const node = buildRowNode(ctx, row, layout, onToggle);

  if (label === null) {
    node.marginTop = marginTop;
    return node;
  }

  const wrapper = new BoxRenderable(ctx, { flexDirection: "column", width: "100%", marginTop });
  wrapper.add(new TextRenderable(ctx, { content: label, fg: UI.textDim }));
  wrapper.add(node);
  return wrapper;
}

/** Map one styled body line's segments to native text chunks. */
function diffLineChunks(line: StyledBodyLine): TextChunk[] {
  return line.map((segment) => {
    const chunk = fgChunk(segment.fg)(segment.text);
    return segment.bold === true ? boldChunk(chunk) : chunk;
  });
}

/**
 * Gutter + one text line per body row, for bodies that arrive already coloured
 * and already laid out (a diff, an expanded tool call's structured arguments).
 * Each line paints inside the body column, so a wrapped line lands under the
 * body rather than in the shell's gutter.
 */
function createStyledLinesRowRenderable(
  ctx: CliRenderer,
  row: StreamRow,
  layout: RowLayout,
  lines: readonly StyledBodyLine[],
  onToggle?: () => void,
): BoxRenderable {
  const gutter = streamRowGutter(row, layout);
  const wrapper = new BoxRenderable(ctx, {
    flexDirection: "row",
    width: "100%",
  });
  wrapper.add(gutterNode(ctx, gutter));
  const body = new BoxRenderable(ctx, {
    flexDirection: "column",
    flexGrow: 1,
  });
  for (const line of lines) {
    body.add(bodyLineNode(ctx, line, onToggle));
  }
  wrapper.add(body);
  return wrapper;
}

/**
 * One painted body line. A line ending in an expand arrow is split so the
 * arrow is its own renderable and can answer a click; every other line is a
 * single text node, as before.
 */
function bodyLineNode(
  ctx: CliRenderer,
  line: StyledBodyLine,
  onToggle?: () => void,
): TextRenderable | BoxRenderable {
  const split = onToggle === undefined ? null : splitTrailingArrow(line);
  if (split === null || onToggle === undefined) {
    return new TextRenderable(ctx, { content: new StyledText(diffLineChunks(line)) });
  }
  const wrapper = new BoxRenderable(ctx, { flexDirection: "row", flexGrow: 1 });
  wrapper.add(
    new TextRenderable(ctx, {
      content: new StyledText(diffLineChunks(split.body)),
      flexShrink: 0,
    }),
  );
  wrapper.add(
    new TextRenderable(ctx, {
      content: new StyledText(diffLineChunks([split.arrow])),
      flexShrink: 0,
      width: stringWidth(split.arrow.text),
      onMouseDown: (event) => {
        // The transcript scroll box drags on the same press; a toggle is not a
        // scroll gesture, so the arrow keeps the event.
        event.stopPropagation();
        onToggle();
      },
    }),
  );
  return wrapper;
}

/**
 * Gutter + native table body for a structured (MCP result) row, under the head
 * lines the row collapses to. The head and the table share one body column so
 * the table stays inside the shell's gutter.
 */
function createStructuredRowRenderable(
  ctx: CliRenderer,
  row: StreamRow,
  layout: RowLayout,
  view: McpStructuredView,
  head: readonly StyledBodyLine[] = [],
  onToggle?: () => void,
): BoxRenderable {
  const gutter = streamRowGutter(row, layout);
  const wrapper = new BoxRenderable(ctx, {
    flexDirection: "row",
    width: "100%",
  });
  wrapper.add(gutterNode(ctx, gutter));
  const body = new BoxRenderable(ctx, { flexDirection: "column", flexGrow: 1 });
  for (const line of head) {
    body.add(bodyLineNode(ctx, line, onToggle));
  }
  body.add(
    new TextTableRenderable(ctx, {
      content: viewToTableContent(view),
      columnWidthMode: "content",
      columnGap: 2,
      showBorders: false,
      wrapMode: "none",
      flexGrow: 1,
    }),
  );
  wrapper.add(body);
  return wrapper;
}

export function setHeader(shell: AppShell, text: string): void {
  shell.baseTitle = text;
  paintChrome(shell);
}

export function setPendingQueue(shell: AppShell, count: number): void {
  let s = shell.session;
  const target = Math.max(0, Math.floor(count));
  while (badgeCount(s) > target) {
    s = { ...s, items: s.items.slice(0, -1) };
  }
  while (badgeCount(s) < target) {
    s = enqueue(s, `pad-${badgeCount(s) + 1}`);
  }
  shell.session = s;
  paintChrome(shell);
}

export function setShellRunState(shell: AppShell, run: RunState): void {
  shell.session = setRunState(shell.session, run);
  paintChrome(shell);
}

/** Transcript echo for a user message, annotated with its attachments. */
export function userRowText(text: string, attachments: readonly PendingImageAttachment[]): string {
  const summary = formatAttachmentSummary(attachments);
  if (summary.length === 0) return text;
  return text.length === 0 ? `[${summary}]` : `${text}\n[${summary}]`;
}

/**
 * Submit the prompt. Product chords (CL-6290):
 *  - "steer": mid-run Enter — soft steer at the next tool.boundary.
 *  - "queue": mid-run Alt+Enter — follow-up; deliver only when the run goes
 *    idle. Idle Alt+Enter is a no-op at the key handler (never reaches here
 *    with kind "queue" while idle from the product chord).
 *  - "reinject": hard-stop and restart from this message. No product chord
 *    wires this anymore; kept for tests / direct API callers. No-op when the
 *    run isn't busy, or the prompt is empty.
 *  - Idle Enter (either queue or steer kind) goes straight through; "kind"
 *    only matters while a run is in flight.
 */
export function submitPrompt(
  shell: AppShell,
  kind: "queue" | "steer" | "reinject" = "queue",
): void {
  const text = shell.prompt.value;
  const t = text.trim();
  const attachments = shell.pendingAttachments;
  if (t.length === 0 && attachments.length === 0) {
    // Empty Enter still reaches the exclusive host so multi-turn /feedback
    // can cancel; non-exclusive shells have nothing to do with a blank line.
    const hooks = getShellBridgeHooks(shell);
    if (hooks?.exclusive) {
      hooks.onSubmit(text, "immediate", attachments);
    }
    return;
  }
  // Reinject is unwired from product chords; still guard idle for API callers.
  if (kind === "reinject" && shell.session.run !== "busy") return;
  // Follow-up idle no-op lives on the Alt+Enter key handler (kind "queue" is
  // also the default for submitPrompt and must still send when idle).

  // Shell/REPL muscle memory: a bare `exit` or `quit` quits rather than being
  // sent to the model. Attachments mean the operator meant it as a message.
  if (attachments.length === 0 && isExitCommand(t)) {
    const onExit = shellExitHandlers.get(shell);
    if (onExit !== undefined) {
      shell.prompt.value = "";
      onExit();
      return;
    }
  }

  if (t.length > 0) recordSentMessage(shell, t);
  const hooks = getShellBridgeHooks(shell);
  if (hooks?.exclusive) {
    shell.prompt.value = "";
    clearPendingAttachments(shell);
    const resolved: "queue" | "steer" | "immediate" | "reinject" =
      kind === "reinject" ? "reinject" : shell.session.run === "idle" ? "immediate" : kind;
    hooks.onSubmit(text, resolved, attachments);
    return;
  }

  if (kind === "reinject") {
    // Unwired from product chords (CL-6290); kept for tests / direct callers.
    shell.session = interrupt(shell.session);
    shell.prompt.value = "";
    clearPendingAttachments(shell);
    appendStreamRow(shell, {
      role: "system",
      text: "stop — restarting from your message",
      meta: "stop",
    });
    appendStreamRow(shell, {
      role: "user",
      text: userRowText(t, attachments),
      meta: "reinject",
    });
    paintChrome(shell);
    return;
  }

  if (shell.session.run === "idle") {
    appendStreamRow(shell, { role: "user", text: t });
    shell.prompt.value = "";
    clearPendingAttachments(shell);
    return;
  }

  shell.session =
    kind === "steer"
      ? enqueueSteer(shell.session, t, undefined, attachments)
      : enqueue(shell.session, t, "queue", undefined, attachments);
  const queued = shell.session.items[shell.session.items.length - 1];
  shell.prompt.value = "";
  clearPendingAttachments(shell);
  // Show the message itself, not the internal transition ("queue +1 →
  // pending N") — the notice row already carries the depth once, in plain
  // language, so this row's job is making the pending item identifiable.
  appendStreamRow(shell, {
    role: "user",
    text: userRowText(t, attachments),
    meta: kind === "steer" ? "steer" : "queue",
    ...(queued !== undefined ? { queueItemId: queued.id } : {}),
  });
  paintChrome(shell);
}

/**
 * Find the transcript row a still-pending queue/steer item echoed, so a
 * cancel can retract it instead of leaving a message tagged "queue" that will
 * never dispatch. Absolute index, matching `replaceStreamRowAt`.
 */
function findQueueRowIndex(shell: AppShell, queueItemId: string): number | undefined {
  for (let local = shell.streamLog.length - 1; local >= 0; local--) {
    if (shell.streamLog[local]?.queueItemId === queueItemId) {
      return shell.streamLogBase + local;
    }
  }
  return undefined;
}

/**
 * Cancel the most recently queued or steered message (last-only: see
 * `cancelLast`'s doc comment for why picking an earlier item is out of
 * scope). Retracts it from the queue and rewrites its transcript row so the
 * readout never shows a message tagged "queue"/"steer" that will not send.
 */
export function applyShellCancelLast(shell: AppShell): void {
  const { state, item } = cancelLast(shell.session);
  if (item === null) return;
  shell.session = state;
  const index = findQueueRowIndex(shell, item.id);
  if (index !== undefined) {
    const row = streamRowAt(shell, index);
    if (row !== undefined) {
      // `cancelled` stays a flag, not a `text` rewrite — `paintStreamRow`
      // owns turning it into the "[cancelled]" prefix, so `row.text` still
      // holds what the operator actually typed for anything else that reads
      // it (copy mode, a resumed transcript).
      replaceStreamRowAt(shell, index, { ...row, meta: "cancelled", cancelled: true });
    }
  }
  paintChrome(shell);
}

/** Local interrupt mutation (no bridge re-entry). */
export function applyShellInterrupt(shell: AppShell): void {
  const had = badgeCount(shell.session);
  shell.session = interrupt(shell.session);
  shell.prompt.value = "";
  appendStreamRow(shell, {
    role: "system",
    text: had > 0 ? `${had} pending kept` : "stopped",
    meta: "stop",
  });
  paintChrome(shell);
}

/** Ctrl+C interrupt path: keep pending, flash, idle. */
export function interruptShell(shell: AppShell): void {
  const hooks = getShellBridgeHooks(shell);
  if (hooks?.exclusive) {
    hooks.onInterrupt();
    return;
  }
  applyShellInterrupt(shell);
}

export function clearShellInterruptFlash(shell: AppShell): void {
  shell.session = clearInterruptFlash(shell.session);
  paintChrome(shell);
}

const OVERLAY_FRAME_ID = "inset-demo";

/** Wrap body text for the overlay host (shared with overlays.ts). */
export function wrapShellOverlayBody(text: string, width: number, maxLines = 8): readonly string[] {
  return wrapOverlayText(text, Math.max(8, Math.floor(width)), maxLines);
}

/**
 * Context rows a decision overlay's body may occupy on a terminal with room
 * to spare. The shaped body charges its header and its two rows of air on
 * top of this, so the spacing never costs the operator a row of the command
 * they are being asked to approve.
 */
const DECISION_CONTEXT_ROWS = 8;

/**
 * Rows the shaped body always spends, budget or not: one header line plus
 * the trailing blank row. Approximate (a header long enough to wrap costs
 * one more), but an underestimate here only makes `decisionContextBudget`
 * more generous than it should be, which the fraction cap downstream still
 * catches — the failure mode this guards against is starving the choices,
 * never overshooting the frame.
 */
const DECISION_HEADER_AND_TRAILER_ROWS = 2;

/**
 * Extra rows a non-zero context budget costs on top of the header/trailer:
 * the blank row of air between the header and the context lines themselves.
 */
const DECISION_CONTEXT_BLANK_ROWS = 1;

/**
 * Shrink the decision body's context budget so its own chrome never crowds
 * out the one thing this fix guarantees down to a 10-row terminal: at least
 * one choice row, with the prompt box still seated at its floor below it. A
 * generous, fixed context budget reads fine on a tall terminal, but on a
 * short one it can consume the entire overlay host, leaving no room to paint
 * a single option — the operator is then asked to decide between choices
 * they cannot see. Shrinking the context first, down to dropping it entirely
 * on the shortest terminals, is the deliberate trade: the header (which tool,
 * which question) and the choices are the two things an approval cannot
 * render without; the surrounding detail can give way first.
 *
 * Below 10 rows this budget alone cannot save the frame: the resolver's own
 * collapse fallback (`resolveGeometry` in geometry/resolve.ts) can still hand
 * the overlay host fewer rows than its render minimum once every other zone
 * is already at floor, which is a pre-existing gap in the resolver, not
 * something this budget controls.
 */
function decisionContextBudget(
  shell: AppShell,
  kind: PrimaryOverlayKind | null,
  terminalHeight = shell.renderer.height,
): number {
  const fixedChrome =
    OVERLAY_HOST_BORDER_ROWS + overlayTitleRows(kind) + DECISION_HEADER_AND_TRAILER_ROWS;
  // The resolver never lets the overlay host past the fraction cap even when
  // the transcript floor and every other zone have already given up their
  // rows, so that cap — not just the prompt floor — bounds how much context
  // this budget can safely ask for.
  const fracCap = Math.floor(terminalHeight * OVERLAY_MAX_FRACTION);
  const maxOverlayRows = Math.min(terminalHeight - PROMPT_BASE_ROWS, fracCap);
  const baseline =
    maxOverlayRows - DECISION_CHOICE_ROWS - fixedChrome - DECISION_CONTEXT_BLANK_ROWS;
  return Math.max(0, Math.min(DECISION_CONTEXT_ROWS, baseline));
}

/** Re-shape and store the open overlay's body rows for the current width. */
function applyOverlayBodyText(
  shell: AppShell,
  text: string,
  maxLines: number,
  terminalHeight = shell.renderer.height,
): void {
  const width = overlayRowWidth(shell);
  const bag = internals.get(shell);
  // Scoped to decision overlays: a palette stacked over an open approval
  // calls this too, with its own (usually empty) body text. Caching that
  // would overwrite the approval's cached raw text with the palette's, and
  // popping the palette restores the approval's `overlayBodyLines` but not
  // this cache (`PriorOverlaySnapshot` never carried it) — so a resize right
  // after would re-shape the approval's body from the palette's stale empty
  // string instead of its own, blanking it. The palette itself never reads
  // this cache (not a decision overlay), so it never needs to be cached.
  if (bag && isDecisionOverlay(shell.overlayKind)) bag.overlayRawBodyText = text;
  if (text.length === 0) {
    shell.overlayBodyLines = [];
    shell.overlayBodyFgs = [];
    return;
  }
  if (isDecisionOverlay(shell.overlayKind)) {
    const rows = composeDecisionBody(
      text,
      width,
      decisionContextBudget(shell, shell.overlayKind, terminalHeight),
    );
    shell.overlayBodyLines = rows.map((r) => r.text);
    shell.overlayBodyFgs = rows.map((r) => r.fg);
    return;
  }
  const lines = wrapOverlayText(text, width, maxLines);
  shell.overlayBodyLines = lines;
  shell.overlayBodyFgs = lines.map(() => UI.text);
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

/**
 * Open an inset list overlay on the shared host (permissions / operator / picker / palette).
 * Measures body + list into geometry — no guessed absolute paint.
 *
 * Single host: a non-palette open while anything is showing is a silent no-op
 * unless `deferIfBusy` is set, in which case it waits in one deferred slot
 * with a system line. Callers that replace a non-gate list close it first.
 * Palette may stack over a prior primary.
 */
export function openListOverlay(shell: AppShell, opts?: OpenListOverlayOpts): void {
  const kind = opts?.kind ?? "demo";
  const isPalette = kind === "palette";

  // Single host: non-palette open is a silent no-op while anything is open,
  // unless the caller opted into the one deferred command-surface slot.
  // Command surfaces that should replace a non-gate list call
  // closeReplaceableOverlay first. Palette may stack over a prior primary.
  if (shell.overlayList) {
    if (!isPalette) {
      if (opts?.deferIfBusy === true) deferBusyCommandOpen(shell, opts);
      return;
    }
    if (shell.overlayKind !== "palette") {
      const bag = internals.get(shell);
      if (bag) {
        bag.priorOverlay = {
          kind: shell.overlayKind,
          items: shell.overlayItems,
          bodyLines: shell.overlayBodyLines,
          bodyFgs: shell.overlayBodyFgs,
          list: shell.overlayList,
          title: String(shell.overlayTitle.content),
          paletteCommands: shell.paletteCommands,
          itemIds: bag.overlayItemIds,
          itemValues: bag.overlayItemValues,
          onAccept: bag.overlayOnAccept,
          onToggleExpand: bag.overlayOnToggleExpand,
          onCycle: bag.overlayOnCycle,
          describe: bag.overlayDescribe,
          onAction: bag.overlayOnAction,
          onPaste: bag.overlayOnPaste,
          answer: bag.overlayAnswer,
          titleText: bag.overlayTitleText,
          onCancel: bag.overlayOnCancel,
          onDispose: bag.overlayOnDispose,
          isGate: bag.overlayIsGate,
          addProviderHint: bag.overlayAddProviderHint,
          setDefaultHint: bag.overlaySetDefaultHint,
          mcpManageHint: bag.overlayMcpManageHint,
          mcpAddHint: bag.overlayMcpAddHint,
        };
      }
      // Leave prior overlay focus frame; palette will stack above it.
    } else {
      // Already palette — pop palette frame only so we re-push cleanly.
      let guard = 4;
      while (guard-- > 0 && focusOwner(shell.focus) === "palette") {
        shell.focus = popFocus(shell.focus);
      }
    }
  }

  const labels = opts?.items ?? shell.overlayItems;
  shell.overlayItems = labels;
  shell.overlayKind = kind;
  if (!isPalette) shell.paletteCommands = [];

  const bag = internals.get(shell);
  if (bag) {
    bag.overlayGeneration += 1;
    // Palette open does not own primary accept; leave prior snapshot's callback.
    if (!isPalette) {
      bag.overlayItemIds = opts?.itemIds ? [...opts.itemIds] : [];
      bag.overlayItemValues = opts?.itemValues ? [...opts.itemValues] : [];
      bag.overlayOnAccept = opts?.onAccept ?? null;
      bag.overlayEchoChoice = opts?.echoChoice ?? true;
      bag.overlayOnToggleExpand = opts?.onToggleExpand ?? null;
      bag.overlayOnCycle = opts?.onCycle ?? null;
      bag.overlayDescribe = opts?.describe ?? null;
      bag.overlayOnAction = opts?.onAction ?? null;
      bag.overlayOnPaste = opts?.onPaste ?? null;
      bag.overlayOnCancel = opts?.onCancel ?? null;
      bag.overlayOnDispose = opts?.onDispose ?? null;
      bag.overlayIsGate = opts?.isGate === true;
      bag.overlayAddProviderHint = opts?.addProviderHint ?? false;
      bag.overlaySetDefaultHint = opts?.setDefaultHint ?? false;
      bag.overlayMcpManageHint = opts?.mcpManageHint ?? false;
      bag.overlayMcpAddHint = opts?.mcpAddHint ?? false;
      // Capture the full unfiltered set so typing can re-narrow in place.
      bag.listFilter =
        opts?.typeToFilter === true
          ? {
              query: "",
              allItems: [...labels],
              allItemIds: opts?.itemIds ? [...opts.itemIds] : [],
              allItemValues: opts?.itemValues ? [...opts.itemValues] : [],
            }
          : null;
    } else if (!bag.priorOverlay) {
      // Bare palette (no primary under it): no accept payload.
      bag.overlayItemIds = opts?.itemIds ? [...opts.itemIds] : [];
      bag.overlayItemValues = opts?.itemValues ? [...opts.itemValues] : [];
      bag.overlayOnAccept = opts?.onAccept ?? null;
      bag.overlayEchoChoice = opts?.echoChoice ?? true;
      bag.overlayOnToggleExpand = opts?.onToggleExpand ?? null;
      bag.overlayOnCycle = opts?.onCycle ?? null;
      bag.overlayDescribe = opts?.describe ?? null;
      bag.overlayOnAction = opts?.onAction ?? null;
      bag.overlayOnPaste = opts?.onPaste ?? null;
      bag.overlayOnCancel = opts?.onCancel ?? null;
      bag.overlayOnDispose = opts?.onDispose ?? null;
      bag.overlayIsGate = opts?.isGate === true;
      bag.overlayAddProviderHint = opts?.addProviderHint ?? false;
      bag.overlaySetDefaultHint = opts?.setDefaultHint ?? false;
      bag.overlayMcpManageHint = opts?.mcpManageHint ?? false;
      bag.overlayMcpAddHint = opts?.mcpAddHint ?? false;
      bag.listFilter = null;
    }
    if (!isPalette) {
      bag.overlayAnswer =
        opts?.onTextAnswer === undefined
          ? null
          : {
              text: "",
              // With nothing to choose, typing is the only way to answer, so
              // the field takes the keys immediately.
              active: opts.textAnswerActive ?? labels.length === 0,
              onSubmit: opts.onTextAnswer,
            };
    }
  }

  // Type-to-filter list overlays paint a `>` query row; everything else uses
  // the caller's body text (or empty).
  const bodyText =
    !isPalette && opts?.typeToFilter === true
      ? `> ${bag?.listFilter?.query ?? ""}`
      : (opts?.body ?? "");
  // Operator question and permission approval context get body lines; other
  // list-only overlays keep the body empty.
  applyOverlayBodyText(shell, bodyText, 0);

  // Ask for exactly what the content needs. The resolver caps the request
  // against OVERLAY_MAX_FRACTION and the transcript floor, and applyLayout
  // shrinks the viewport to whatever survived — so a longer list scrolls
  // instead of growing, and a short one leaves no dead rows below it.
  // An empty list charges no rows: a chooser with nothing to choose must not
  // reserve a blank band the operator can neither read nor act on.
  const listItems = labels.length;

  shell.overlayList = createListViewport({
    count: labels.length,
    height: Math.max(1, listItems),
    activeIndex: opts?.activeIndex ?? 0,
  });

  if (bag) bag.overlayTitleText = opts?.title ?? "permission";
  refreshOverlayTitle(shell);

  const frameId = opts?.frameId ?? OVERLAY_FRAME_ID;
  const focusTarget = isPalette ? "palette" : "overlay";
  shell.focus = openOverlay(shell.focus, frameId, {
    target: focusTarget,
    scrollOwner: isPalette ? "palette" : "overlay",
  });
  relayoutOverlayHost(shell, listItems);
  applyFocus(shell);
  paintOverlayList(shell);
  opts?.onOpened?.();
}

/** Open inset permission/palette stub; focus stack owns keys; Esc closes. */
export function openInsetOverlay(shell: AppShell, items?: readonly string[]): void {
  openListOverlay(shell, {
    kind: "demo",
    title: "permission",
    items: items ?? shell.overlayItems,
    frameId: OVERLAY_FRAME_ID,
  });
}

/** Resolve the shell's registry-backed command catalog (host-injected). */
export function resolvePaletteCatalog(shell: AppShell): readonly PaletteCommand[] {
  const bag = internals.get(shell);
  const raw = bag?.paletteCatalog;
  if (raw === null || raw === undefined) return [];
  return typeof raw === "function" ? raw() : raw;
}

/**
 * Replace the shell's `/` command catalog (host rebinds after registry load).
 * Pass null to clear it.
 */
export function setPaletteCatalog(
  shell: AppShell,
  catalog: readonly PaletteCommand[] | (() => readonly PaletteCommand[]) | null,
): void {
  const bag = internals.get(shell);
  if (bag) bag.paletteCatalog = catalog;
}

/**
 * Open the `/` command list overlay. Catalog: opts.catalog when given, else
 * the shell's registry-backed default (see `resolvePaletteCatalog`).
 */
export function openPalette(
  shell: AppShell,
  opts?: {
    readonly query?: string;
    readonly catalog?: readonly PaletteCommand[];
    readonly title?: string;
    /** Claim printable keys for the `>` filter row. Off for the `/` popup. */
    readonly typeToFilter?: boolean;
  },
): void {
  const title = opts?.title ?? "command palette";
  const bag = internals.get(shell);
  if (bag) {
    bag.paletteFilter = {
      query: opts?.query ?? "",
      title,
      // `/` passes a pre-narrowed catalog; omitting it re-resolves the shell
      // default so a registry loaded later is picked up.
      catalog: opts?.catalog ?? null,
      // The `/` popup keeps its query in the prompt and drives its own reopen.
      typeToFilter: opts?.typeToFilter ?? false,
    };
  }
  repaintPalette(shell);
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

/** Re-open the palette against the current filter state (used on every keystroke). */
function repaintPalette(shell: AppShell): void {
  const state = internals.get(shell)?.paletteFilter;
  if (!state) return;
  const catalog = state.catalog ?? resolvePaletteCatalog(shell);
  const commands = filterPaletteCommands(state.query, catalog);
  const labels = commands.length > 0 ? paletteLabels(commands) : ["(no matches)"];
  shell.paletteCommands = commands;
  openListOverlay(shell, {
    kind: "palette",
    title: state.title,
    items: labels,
    itemIds: commands.map((c) => c.id),
    describe: (id) => {
      const cmd = commands.find((c) => c.id === id);
      const what = cmd?.description?.trim();
      return what ? { what } : null;
    },
    // Typed filter row only when the overlay owns keystrokes. The `/` popup
    // keeps its query in the prompt, so a body of `>` would be orphan chrome.
    ...(state.typeToFilter ? { body: `> ${state.query}` } : {}),
    frameId: "command-palette",
  });
  // No title rule row: the box is only ever the palette, and when a filter
  // row is present it already shows what's typed.
  shell.overlayTitle.visible = false;
  shell.overlayTitle.content = "";
  paintOverlayList(shell);
}

/**
 * Keys a type-to-filter list claims while it is open, so the `>` row filters
 * as you type.
 *
 * Opt-in per open (`typeToFilter`): palette, the flat model picker, and the
 * resume picker give up j/k navigation so printable keys feed the filter.
 * Overlays without type-to-filter (permissions, workers, copy, …) keep j/k. Arrow and
 * page keys are never claimed here, so they keep working in every overlay
 * including type-to-filter ones.
 */
export function handlePaletteFilterKey(shell: AppShell, key: KeyEvent): boolean {
  const state = internals.get(shell)?.paletteFilter;
  if (!state?.typeToFilter) return false;
  if (shell.overlayKind !== "palette" || shell.overlayList === null) return false;
  if (key.ctrl || key.meta || key.option) return false;

  if (key.name === "backspace") {
    if (state.query.length === 0) return true;
    state.query = state.query.slice(0, -1);
    repaintPalette(shell);
    return true;
  }

  const seq = typeof key.sequence === "string" ? key.sequence : "";
  if (seq.length !== 1 || seq < " ") return false;

  state.query += seq;
  repaintPalette(shell);
  return true;
}

/**
 * Glyphs some terminals emit for Option+A without setting meta/option.
 */
const OPTION_A_COMPOSED_CHARS = new Set(["å", "Å"]);

/**
 * True when a key event is the model-picker Alt+A add-provider chord.
 * Terminals may deliver Option+A as å/Å without meta/option.
 */
export function isAddProviderShortcutKey(key: KeyEvent): boolean {
  if (key.ctrl) return false;
  const name = typeof key.name === "string" ? key.name : "";
  const seq = typeof key.sequence === "string" ? key.sequence : "";
  if ((key.meta || key.option) && name.toLowerCase() === "a") return true;
  if (OPTION_A_COMPOSED_CHARS.has(name) || OPTION_A_COMPOSED_CHARS.has(seq)) return true;
  return false;
}

/**
 * Keys a type-to-filter list overlay claims while open, so the `>` row
 * narrows as you type. Mirrors the palette filter, but updates the open
 * list in place via setOverlayItems (a busy openListOverlay is a silent
 * no-op unless `deferIfBusy` is set).
 */
export function handleListFilterKey(shell: AppShell, key: KeyEvent): boolean {
  const bag = internals.get(shell);
  const state = bag?.listFilter;
  if (!state || shell.overlayList === null) return false;
  if (shell.overlayKind === "palette") return false;
  if (key.ctrl || key.meta || key.option) return false;

  // overlayAddProviderHint also gates this filter-bypass so composed Option+A
  // (å/Å) reaches runOverlayAction instead of type-to-filter.
  if (
    bag?.overlayAddProviderHint === true &&
    shell.overlayKind === "model_picker" &&
    isAddProviderShortcutKey(key)
  ) {
    return false;
  }

  if (key.name === "backspace") {
    if (state.query.length === 0) return true;
    state.query = state.query.slice(0, -1);
    repaintListFilter(shell);
    return true;
  }

  const seq = typeof key.sequence === "string" ? key.sequence : "";
  if (seq.length !== 1 || seq < " ") return false;

  state.query += seq;
  repaintListFilter(shell);
  return true;
}

function repaintListFilter(shell: AppShell): void {
  const bag = internals.get(shell);
  const state = bag?.listFilter;
  if (!state) return;
  const q = state.query.trim().toLowerCase();
  const matched: { label: string; id: string; value: string | undefined }[] = [];
  for (let i = 0; i < state.allItems.length; i++) {
    const label = state.allItems[i] ?? "";
    const id = state.allItemIds[i] ?? label;
    if (q.length > 0) {
      const hay = `${label} ${id}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    matched.push({
      label,
      id,
      value: state.allItemValues[i],
    });
  }
  const labels = matched.length > 0 ? matched.map((m) => m.label) : ["(no matches)"];
  const ids = matched.length > 0 ? matched.map((m) => m.id) : [""];
  const values =
    state.allItemValues.length > 0
      ? matched.length > 0
        ? matched.map((m) => m.value)
        : [undefined]
      : undefined;
  setOverlayItems(shell, labels, ids, values);
  setOverlayBody(shell, `> ${state.query}`);
}

/**
 * Move the open overlay's free-text field in or out of taking keystrokes.
 * Returns false when the overlay offers no such field.
 */
export function setOverlayAnswerActive(shell: AppShell, active: boolean): boolean {
  const answer = overlayAnswerState(shell);
  if (answer === null || shell.overlayList === null) return false;
  if (answer.active === active) return false;
  answer.active = active;
  refreshOverlayTitle(shell);
  paintOverlayList(shell);
  return true;
}

/**
 * Esc inside a live answer field means "back to the choices", not "abandon the
 * question" — but only when there are choices to go back to.
 */
export function exitOverlayAnswerMode(shell: AppShell): boolean {
  const answer = overlayAnswerState(shell);
  if (answer === null || !answer.active) return false;
  if (shell.overlayItems.length === 0) return false;
  return setOverlayAnswerActive(shell, false);
}

/**
 * Keys the free-text answer field claims while it is taking input. Printable
 * characters and backspace edit the answer; Enter submits it and closes the
 * overlay through the per-open `onTextAnswer` callback.
 */
export function handleOverlayAnswerKey(shell: AppShell, key: KeyEvent): boolean {
  const answer = overlayAnswerState(shell);
  if (answer === null || shell.overlayList === null) return false;

  if (key.name === "tab" && !key.shift && !key.ctrl && !key.meta && !key.option && !answer.active) {
    return setOverlayAnswerActive(shell, true);
  }
  if (!answer.active) return false;
  if (key.ctrl || key.meta || key.option) return false;

  if (key.name === "return" || key.name === "enter") {
    if (answer.text.length === 0) return true;
    const text = answer.text;
    const submit = answer.onSubmit;
    const bag = internals.get(shell);
    if (bag?.overlayEchoChoice !== false) {
      appendStreamRow(shell, {
        role: "system",
        text: `answered: ${text}`,
        meta: overlayKindWord(shell.overlayKind ?? "operator"),
      });
    }
    // Deliberate submit, not a dismiss — closeInsetOverlay must not also fire
    // the Esc/cancel path.
    if (bag) bag.overlayOnCancel = null;
    closeInsetOverlay(shell);
    submit(text);
    return true;
  }
  if (key.name === "backspace") {
    if (answer.text.length > 0) {
      answer.text = answer.text.slice(0, -1);
      paintOverlayList(shell);
    }
    return true;
  }

  const seq = typeof key.sequence === "string" ? key.sequence : "";
  if (seq.length !== 1 || seq < " ") return false;
  answer.text += seq;
  paintOverlayList(shell);
  return true;
}

/**
 * Which open surface a chord toggles shut, or null when the chord is not a
 * toggling opener.
 *
 * Only pickers appear here. An opener that performs an action (Ctrl+P attaches
 * an image, Ctrl+C interrupts, the expand key expands a row) has nothing to
 * toggle, and a decision surface — a permission or operator question — is
 * deliberately absent: re-pressing whatever chord happened to be underneath it
 * must not count as an answer. Those leave via a choice or Esc.
 *
 * `@` and `/` are openers too, but they are also characters being typed, so
 * pressing them again inserts them rather than closing the popup.
 */
function toggledSurfaceFor(key: KeyEvent): PrimaryOverlayKind | null {
  if ((key.meta || key.option) && !key.ctrl && (key.name === "c" || key.name === "C")) {
    return "copy";
  }
  return null;
}

/**
 * Re-pressing the chord that opened a picker closes it, through the same path
 * Esc uses so key claims and focus are unwound identically.
 */
function toggleCloseOpenSurface(shell: AppShell, key: KeyEvent): boolean {
  if (shell.overlayList === null) return false;
  const kind = toggledSurfaceFor(key);
  if (kind === null || kind !== shell.overlayKind) return false;
  // The `/` popup borrows the palette overlay; there the chord is still a
  // character the operator may be typing into the filter.
  if (kind === "palette" && isSlashPopupOpen(shell)) return false;
  closeInsetOverlay(shell);
  return true;
}

/** Close overlay/palette if open; restore prior focus (or prior overlay under palette). */
export function closeInsetOverlay(shell: AppShell): void {
  if (!shell.overlayList) return;
  // Esc (or any other dismiss) must also drop the `/` and `@` popups' key claim.
  slashPopups.delete(shell);
  if (mentionPopups.has(shell)) clearMentionAccept(shell);
  mentionPopups.delete(shell);

  const wasPalette = shell.overlayKind === "palette";
  if (wasPalette) {
    const filterBag = internals.get(shell);
    if (filterBag) filterBag.paletteFilter = null;
  }
  const bag = internals.get(shell);
  if (bag) bag.listFilter = null;
  const prior = wasPalette ? (bag?.priorOverlay ?? null) : null;
  // A primary overlay that registers onCancel owns cleanup for every dismiss
  // path. A palette stacked over another overlay restores that prior frame
  // instead, so its callback must remain untouched.
  const onCancel = !prior ? (bag?.overlayOnCancel ?? null) : null;
  const onDispose = !prior ? (bag?.overlayOnDispose ?? null) : null;

  shell.overlayList = null;
  shell.overlayKind = null;
  shell.overlayBodyLines = [];
  shell.overlayBodyFgs = [];
  shell.paletteCommands = [];
  shell.copyTargets = null;
  clearOverlayBody(shell);
  // Esc / dismiss: drop accept path without invoking it (onCancel above is
  // captured before this clears, and is invoked separately once state settles).
  if (bag && !prior) {
    bag.overlayItemIds = [];
    bag.overlayItemValues = [];
    bag.overlayOnAccept = null;
    bag.overlayOnToggleExpand = null;
    bag.overlayOnCycle = null;
    bag.overlayDescribe = null;
    bag.overlayOnAction = null;
    bag.overlayOnPaste = null;
    bag.overlayAddProviderHint = false;
    bag.overlaySetDefaultHint = false;
    bag.overlayMcpManageHint = false;
    bag.overlayMcpAddHint = false;
    bag.overlayAnswer = null;
    bag.overlayOnCancel = null;
    bag.overlayOnDispose = null;
    bag.overlayIsGate = false;
  }

  // Pop exactly one frame (palette or overlay).
  if (focusOwner(shell.focus) === "overlay" || focusOwner(shell.focus) === "palette") {
    shell.focus = popFocus(shell.focus);
  }

  if (prior && bag) {
    bag.priorOverlay = null;
    // Restore prior primary overlay paint; focus should already be overlay.
    shell.overlayItems = prior.items;
    shell.overlayKind = prior.kind;
    shell.overlayBodyLines = prior.bodyLines;
    shell.overlayBodyFgs = prior.bodyFgs;
    shell.overlayList = prior.list;
    shell.paletteCommands = prior.paletteCommands;
    shell.overlayTitle.visible = true;
    shell.overlayTitle.content = prior.title;
    bag.overlayItemIds = prior.itemIds;
    bag.overlayItemValues = prior.itemValues;
    bag.overlayOnAccept = prior.onAccept;
    bag.overlayOnToggleExpand = prior.onToggleExpand;
    bag.overlayOnCycle = prior.onCycle;
    bag.overlayDescribe = prior.describe;
    bag.overlayOnAction = prior.onAction;
    bag.overlayOnPaste = prior.onPaste;
    bag.overlayAnswer = prior.answer;
    bag.overlayTitleText = prior.titleText;
    bag.overlayOnCancel = prior.onCancel;
    bag.overlayOnDispose = prior.onDispose;
    bag.overlayIsGate = prior.isGate;
    bag.overlayAddProviderHint = prior.addProviderHint;
    bag.overlaySetDefaultHint = prior.setDefaultHint;
    bag.overlayMcpManageHint = prior.mcpManageHint;
    bag.overlayMcpAddHint = prior.mcpAddHint;
    // If focus was not stacked (edge case), re-open overlay frame.
    if (focusOwner(shell.focus) !== "overlay") {
      shell.focus = openOverlay(shell.focus, OVERLAY_FRAME_ID, {
        target: "overlay",
        scrollOwner: "overlay",
      });
    }
    const listH = prior.list.height;
    const hostRows = overlayHostRows(shell, prior.bodyLines.length, listH);
    const minHostRows = overlayMinHostRows(shell, prior.bodyLines.length, prior.list.count > 0);
    relayout(shell, {
      overlayMode: "inset",
      overlayBodyRows: hostRows,
      overlayMinBodyRows: minHostRows,
    });
    applyFocus(shell);
    paintOverlayList(shell);
    return;
  }

  // Ensure no leftover overlay/palette frames.
  let guard = 4;
  while (
    guard-- > 0 &&
    (focusOwner(shell.focus) === "overlay" || focusOwner(shell.focus) === "palette")
  ) {
    shell.focus = popFocus(shell.focus);
  }

  relayout(shell, { overlayMode: "closed" });
  applyFocus(shell);
  if (bag) bag.overlayGeneration += 1;
  if (isOverlayHostIdle(shell)) notifyOverlayClosed(shell);
  try {
    onDispose?.();
    onCancel?.();
  } finally {
    scheduleDeferredCommandFlush(shell);
  }
}

/**
 * Close the current overlay only when dismissing it does not settle a
 * decision gate (`isGate`). Command surfaces that need a fresh host
 * (settings cycle, plugins, mcp) call this instead of `closeInsetOverlay`
 * so a live gate is left in place and `openListOverlay` can defer.
 * Overlays that bind `onDispose` for cleanup (mcp unsubscribe) still
 * run that hook; `onCancel` is Esc/dismiss only and is skipped here.
 */
export function closeReplaceableOverlay(shell: AppShell): void {
  const bag = internals.get(shell);
  if (bag?.overlayIsGate === true) return;
  if (bag) bag.overlayOnCancel = null;
  closeInsetOverlay(shell);
}

/**
 * Subscribe to "the overlay host is idle". Idle means no live list, no
 * deferred command surface, and no host reservations. Callers that must not
 * lose an open (gate wiring) queue on this instead of racing a busy host.
 */
export function onOverlayClosed(shell: AppShell, listener: () => void): () => void {
  const bag = internals.get(shell);
  if (!bag) return () => undefined;
  bag.overlayClosedListeners.add(listener);
  return () => {
    bag.overlayClosedListeners.delete(listener);
  };
}

/**
 * True when the shared overlay host can accept a new primary open: the shell
 * is live, no list is showing, no deferred command is waiting, and nothing
 * holds a reservation.
 */
export function isOverlayHostIdle(shell: AppShell): boolean {
  if (shell.disposed) return false;
  const bag = internals.get(shell);
  return (
    shell.overlayList === null &&
    (bag?.deferredCommandOverlay ?? null) === null &&
    (bag?.overlayHostReservations ?? 0) === 0
  );
}

function notifyOverlayClosed(shell: AppShell): void {
  if (!isOverlayHostIdle(shell)) return;
  const bag = internals.get(shell);
  if (!bag) return;
  // Copied: a listener may re-open an overlay and unsubscribe mid-iteration.
  for (const listener of [...bag.overlayClosedListeners]) listener();
}

/**
 * Hold the overlay host idle-notify while an async command surface is still
 * claiming it (permissions.list() before settings/permissions paint). Release
 * clears the hold, flushes a deferred surface if one is waiting, and notifies
 * if the host is actually idle.
 */
export function reserveOverlayHost(shell: AppShell): () => void {
  const bag = internals.get(shell);
  if (!bag) return () => undefined;
  bag.overlayHostReservations += 1;
  const epoch = bag.overlayReservationEpoch;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = internals.get(shell);
    if (!current || current.overlayReservationEpoch !== epoch) return;
    if (current.overlayHostReservations > 0) current.overlayHostReservations -= 1;
    scheduleDeferredCommandFlush(shell);
    notifyOverlayClosed(shell);
  };
}

/** Drop in-flight host holds. Stale `release()` callbacks become no-ops. */
function abortOverlayHostReservations(shell: AppShell): void {
  const bag = internals.get(shell);
  if (!bag || bag.overlayHostReservations === 0) return;
  bag.overlayReservationEpoch += 1;
  bag.overlayHostReservations = 0;
  bag.overlayGeneration += 1;
  scheduleDeferredCommandFlush(shell);
}

/** One deferred command-surface slot while the host is busy. */
function deferBusyCommandOpen(shell: AppShell, opts: OpenListOverlayOpts): void {
  const bag = internals.get(shell);
  if (!bag) return;
  bag.deferredCommandOverlay = opts.kind === undefined ? { ...opts, kind: "demo" } : opts;
  const kind = overlayKindWord(opts.kind ?? "demo");
  appendStreamRow(shell, {
    role: "system",
    text: `${kind} will open when the current list closes.`,
  });
  scheduleDeferredCommandFlush(shell);
}

function scheduleDeferredCommandFlush(shell: AppShell): void {
  const bag = internals.get(shell);
  if (!bag || bag.deferredCommandOverlay === null || bag.deferredFlushScheduled) return;
  bag.deferredFlushScheduled = true;
  queueMicrotask(() => {
    bag.deferredFlushScheduled = false;
    if (shell.disposed) {
      bag.deferredCommandOverlay = null;
      return;
    }
    flushDeferredCommandOverlay(shell);
  });
}

function flushDeferredCommandOverlay(shell: AppShell): void {
  const bag = internals.get(shell);
  if (!bag) return;
  // Live list still occupies the host — keep the slot.
  if (shell.overlayList !== null) return;
  const opts = bag.deferredCommandOverlay;
  if (opts === null) {
    notifyOverlayClosed(shell);
    return;
  }
  bag.deferredCommandOverlay = null;
  // Reservations/disposed still occupy the host; restore the slot.
  if (!isOverlayHostIdle(shell)) {
    bag.deferredCommandOverlay = opts;
    return;
  }
  openListOverlay(shell, opts);
}

function dropDeferredCommandOverlay(shell: AppShell): void {
  const bag = internals.get(shell);
  if (!bag) return;
  bag.deferredCommandOverlay = null;
  bag.deferredFlushScheduled = false;
}

/**
 * Bare key the modal overlay claims for its expand/collapse hook. Deliberately
 * not in SHELL_SHORTCUTS: it is live only while an overlay that supplied
 * `onToggleExpand` is open, so it never shadows a prompt binding.
 */
export const OVERLAY_EXPAND_KEY = EXPAND_KEY;

/**
 * Expand or collapse every transcript row that hides a body behind a summary:
 * loaded skills, summarised tool calls, settled reasoning. Same key as the
 * overlay's collapsed payloads, so the product has one expand idiom.
 *
 * All-or-nothing rather than one row at a time: with several collapsed rows on
 * screen, expanding the newest and leaving the rest reads as the key having
 * missed. Any row still collapsed means the whole set opens; only once nothing
 * is left to open does the key close them again.
 *
 * False when no row on the log can expand at all.
 */
/**
 * Expand or collapse exactly one transcript row — what a click on its arrow
 * means. The key stays bulk (see `toggleCollapsedRow`): a pointer says *this
 * one*, a key with nothing under it can only mean all of them.
 *
 * False when that row hides nothing.
 */
/** `index` is absolute (see `streamLogBase`), matching the index closures built off `createStreamRowRenderable` carry. */
export function toggleRowExpandedAt(shell: AppShell, index: number): boolean {
  const row = shell.streamLog[index - shell.streamLogBase];
  if (row === undefined || !isCollapsibleRow(row)) return false;
  replaceStreamRowAt(shell, index, { ...row, expanded: row.expanded !== true });
  return true;
}

export function toggleCollapsedRow(shell: AppShell): boolean {
  const collapsible = shell.streamLog.flatMap((row, local) =>
    row !== undefined && isCollapsibleRow(row) ? [{ row, index: shell.streamLogBase + local }] : [],
  );
  if (collapsible.length === 0) return false;
  const expand = collapsible.some(({ row }) => row.expanded !== true);
  for (const { row, index } of collapsible) {
    if ((row.expanded === true) === expand) continue;
    replaceStreamRowAt(shell, index, { ...row, expanded: expand });
  }
  return true;
}

/** Replace the open overlay's body text in place (re-wrap + relayout). */
export function setOverlayBody(shell: AppShell, text: string, maxLines = 8): void {
  if (!shell.overlayList) return;
  applyOverlayBodyText(shell, text, maxLines);
  // Ask for the whole list again, not the height it currently has: a body that
  // shrank should hand its rows back to the choices rather than leave the
  // viewport stuck at the size an earlier, taller body forced it to.
  const hostRows = overlayHostRows(
    shell,
    shell.overlayBodyLines.length,
    Math.max(1, shell.overlayItems.length) * overlayRowsPerItem(shell.overlayKind),
  );
  const minHostRows = overlayMinHostRows(
    shell,
    shell.overlayBodyLines.length,
    shell.overlayItems.length > 0,
  );
  relayout(shell, {
    overlayMode: "inset",
    overlayBodyRows: hostRows,
    overlayMinBodyRows: minHostRows,
  });
  paintOverlayList(shell);
}

export interface OverlayContinuationToken {
  readonly generation: number;
}

/** Capture overlay generation for an async continuation. Stale after a newer open, a full close, or Esc abort. */
export function captureOverlayContinuation(shell: AppShell): OverlayContinuationToken {
  return { generation: internals.get(shell)?.overlayGeneration ?? -1 };
}

/** True only while no newer overlay has taken ownership of the shared host. */
export function isOverlayContinuationCurrent(
  shell: AppShell,
  token: OverlayContinuationToken,
): boolean {
  return isOverlayGenerationCurrent(shell, token) && shell.overlayList === null;
}

/** True while the shell is live and generation has not advanced. */
export function isOverlayGenerationCurrent(
  shell: AppShell,
  token: OverlayContinuationToken,
): boolean {
  return !shell.disposed && internals.get(shell)?.overlayGeneration === token.generation;
}

/**
 * Refresh an overlay owned by either the foreground or the frame beneath a
 * stacked palette. Returns false once that overlay no longer owns either slot.
 */
export function setOwnedOverlayItems(
  shell: AppShell,
  kind: PrimaryOverlayKind,
  items: readonly string[],
  itemIds: readonly string[],
): boolean {
  const bag = internals.get(shell);
  if (!bag) return false;

  if (shell.overlayKind === kind && shell.overlayList !== null) {
    const activeId = bag.overlayItemIds[shell.overlayList.activeIndex];
    setOverlayItems(shell, items, itemIds);
    const activeIndex = activeId === undefined ? -1 : itemIds.indexOf(activeId);
    if (activeIndex >= 0 && shell.overlayList.activeIndex !== activeIndex) {
      shell.overlayList = createListViewport({
        count: items.length,
        height: shell.overlayList.height,
        activeIndex,
      });
      paintOverlayList(shell);
    }
    return true;
  }

  const prior = bag.priorOverlay;
  if (prior?.kind !== kind) return false;
  const activeId = prior.itemIds[prior.list.activeIndex];
  const activeIndex = activeId === undefined ? -1 : itemIds.indexOf(activeId);
  bag.priorOverlay = {
    ...prior,
    items: [...items],
    itemIds: [...itemIds],
    list: createListViewport({
      count: items.length,
      height: prior.list.height,
      activeIndex: activeIndex >= 0 ? activeIndex : prior.list.activeIndex,
    }),
  };
  return true;
}

/**
 * Replace the open overlay's item labels (and optionally ids) in place,
 * keeping the active row's position. Cycling a value redraws the row it
 * changed rather than closing and reopening the overlay, which would lose
 * the cursor and retrigger the open animation for a one-key edit.
 */
export function setOverlayItems(
  shell: AppShell,
  items: readonly string[],
  itemIds?: readonly string[],
  itemValues?: readonly (string | undefined)[],
  opts?: { readonly resetActive?: boolean },
): void {
  if (!shell.overlayList) return;
  shell.overlayItems = items;
  const bag = internals.get(shell);
  if (bag && itemIds) bag.overlayItemIds = [...itemIds];
  if (bag && itemValues) bag.overlayItemValues = [...itemValues];
  // Most callers (mention/model-picker filtering) keep the operator's current
  // selection as the list narrows. The `/` popup instead resets to the top
  // row on every keystroke, matching pre-refresh behavior where each filter
  // reopened the overlay fresh.
  shell.overlayList = opts?.resetActive
    ? createListViewport({
        count: items.length,
        height: shell.overlayList.height,
        activeIndex: 0,
      })
    : setListCount(shell.overlayList, items.length);
  paintOverlayList(shell);
}

/** Run the open overlay's expand/collapse hook; true when one was bound. */
export function toggleOverlayExpand(shell: AppShell): boolean {
  if (!shell.overlayList) return false;
  const hook = internals.get(shell)?.overlayOnToggleExpand ?? null;
  if (!hook) return false;
  hook();
  return true;
}

/** Move overlay selection (j/k / arrows). */
export function moveOverlaySelection(shell: AppShell, delta: number): void {
  if (!shell.overlayList) return;
  shell.overlayList = moveActive(shell.overlayList, delta);
  paintOverlayList(shell);
}

/**
 * Cycle the focused row's value in place, for overlays that opted in via
 * `onCycle` (settings inline cycling). No-op when the open overlay did not
 * supply a cycle hook, so Left/Right stay unclaimed everywhere else.
 */
export function cycleOverlaySelection(shell: AppShell, direction: -1 | 1): boolean {
  const list = shell.overlayList;
  if (!list) return false;
  const onCycle = internals.get(shell)?.overlayOnCycle;
  if (!onCycle) return false;
  onCycle(activeOverlayItemId(shell, list), direction);
  return true;
}

/**
 * Run the open overlay's bare-key claim, for overlays that opted in via
 * `onAction`. No-op when the open overlay did not supply one, so the key
 * falls through unclaimed everywhere else.
 */
export function runOverlayAction(shell: AppShell, key: KeyEvent): boolean {
  const list = shell.overlayList;
  if (!list) return false;
  const onAction = internals.get(shell)?.overlayOnAction;
  if (!onAction) return false;
  return onAction(activeOverlayItemId(shell, list), key);
}

/** Page overlay selection (PgUp/PgDn). */
export function pageOverlaySelection(shell: AppShell, dir: -1 | 1): void {
  if (!shell.overlayList) return;
  shell.overlayList = pageList(shell.overlayList, dir);
  paintOverlayList(shell);
}

/** Accept active overlay item → callback + system line + close (palette dispatches action).
 * Mention Enter that is not live (stale generation or cursor off that `@`) dismisses. */
export function acceptOverlaySelection(shell: AppShell): void {
  if (!shell.overlayList) return;

  if (shell.overlayKind === "copy") {
    confirmCopySelection(shell);
    return;
  }
  // Nothing to choose: Enter must not synthesize a phantom row and resolve the
  // gate with it. The answer field (when offered) already claimed Enter.
  if (shell.overlayItems.length === 0) return;

  const idx = shell.overlayList.activeIndex;
  const label = shell.overlayItems[idx] ?? `item ${idx}`;
  const kind = shell.overlayKind ?? "demo";
  const bag = internals.get(shell);

  if (kind === "palette") {
    const cmd = shell.paletteCommands[idx];
    if (!cmd) {
      // Type-to-filter plants a "(no matches)" row with no command. Stay open.
      // Slash popup (`typeToFilter: false`) still closes — intentional dismiss.
      if (bag?.paletteFilter?.typeToFilter === true && !isSlashPopupOpen(shell)) return;
      closeInsetOverlay(shell);
      return;
    }
    const release = reserveOverlayHost(shell);
    closeInsetOverlay(shell);
    try {
      dispatchPaletteSelection(shell, cmd);
    } finally {
      release();
    }
    return;
  }

  if (kind === "mentions" && mentionPopups.has(shell) && liveMentionAccept(shell) === null) {
    // Stale generation or cursor off the @token: operator dismiss, not accept.
    closeInsetOverlay(shell);
    return;
  }

  const id = bag?.overlayItemIds[idx];
  // Type-to-filter plants "(no matches)" with an empty-id sentinel. Stay open.
  if (id === "") return;
  const value = bag?.overlayItemValues[idx];
  const selection: OverlaySelection = {
    kind,
    index: idx,
    label,
    ...(id !== undefined ? { id } : {}),
    ...(value !== undefined ? { value } : {}),
  };
  // Capture before close clears per-open state.
  const perOpen = bag?.overlayOnAccept ?? null;
  // This is a deliberate accept, not a dismiss — closeInsetOverlay must not
  // also fire the Esc/cancel path below.
  if (bag) bag.overlayOnCancel = null;

  if (bag?.overlayEchoChoice !== false) {
    appendStreamRow(shell, {
      role: "system",
      text: overlayChoiceText(label, id, value),
      meta: overlayKindWord(kind),
    });
  }
  // Accept is not operator dismiss: keep mention accept state for onAccept
  // after this close (closeInsetOverlay would otherwise bump the generation).
  if (kind === "mentions") mentionPopups.delete(shell);
  const release = reserveOverlayHost(shell);
  closeInsetOverlay(shell);
  try {
    dispatchOverlayAccept(shell, selection, perOpen);
  } finally {
    release();
  }
}

/**
 * Plain-English echo of an accepted choice. A cycled settings field's label
 * carries every option with `‹ ›` around the active one (list-painting detail,
 * not something an operator asked for), so the caller passes the value that
 * actually won structurally via `itemValues` rather than leaving it to be
 * recovered from the rendered label — a marker or spacing change, or a label
 * that legitimately contains `‹`/`›`, would otherwise corrupt the echo
 * silently. A plain list item has no separate value, so it is quoted as-is.
 */
function overlayChoiceText(
  label: string,
  id: string | undefined,
  value: string | undefined,
): string {
  if (value === undefined) return `Chose ${label.trim()}.`;
  const field = id === undefined ? "setting" : id.replace(/[-_]/g, " ");
  return `Set ${field} to ${value}.`;
}

/** Internal overlay kinds read as words in the transcript, not identifiers. */
function overlayKindWord(kind: PrimaryOverlayKind): string {
  return kind.replace(/_/g, " ");
}

/**
 * Dispatch a selected `/` command list item after the popup has closed.
 * Every entry is registry-backed — the host's `onCommand(name)` runs it.
 */
export function dispatchPaletteSelection(shell: AppShell, cmd: PaletteCommand): void {
  const onCommand = getPaletteOnCommand(shell);
  if (onCommand) {
    onCommand(cmd.id);
    return;
  }
  appendStreamRow(shell, {
    role: "system",
    text: `palette: /${cmd.id} (no onCommand handler)`,
  });
}

export interface ChromeZoneContent {
  /** One row per task-panel line. Null/empty = hide the zone. */
  readonly task?: readonly TaskPanelRow[] | null;
  /** One row per agents-panel line. Null/empty = hide the zone. */
  readonly agents?: readonly AgentPanelRow[] | null;
}

/** Bracket marker per task status; a trailer row (status null) gets none. */
function taskStatusMarker(status: TaskPanelRow["status"]): string {
  switch (status) {
    case "todo":
      return "[ ] ";
    case "doing":
      return "[~] ";
    case "done":
      return "[x] ";
    case "cancelled":
      return "[-] ";
    case null:
      return "";
  }
}

/**
 * Fit a row's label + tail into `maxWidth` terminal columns, ellipsizing the
 * label (agentId + description — free-form, model-authored, routinely long,
 * and not guaranteed narrow: CJK and emoji run two columns per code point)
 * before ever touching the tail (elapsed/tool/stalled). The tail carries
 * the fact an operator glances at the panel to see, so it is preserved
 * whole or not shown at all. Measured and sliced in columns via
 * `stringWidth`/`sliceToWidth` (`src/tui/view/height.ts`) rather than UTF-16
 * code units — `.length` undercounts wide glyphs, which is exactly the class
 * of bug that would make a row overflow its zone and wrap.
 */
function fitAgentRow(row: AgentPanelRow, maxWidth: number): string {
  const full = ` ${row.label}${row.tail}`;
  if (stringWidth(full) <= maxWidth) {
    // Push every lane's tail to the right edge so the clocks line up as a
    // column. A lane that has been silent far longer than its neighbours then
    // stands out of that column by its shape, before any of it is read — which
    // is the one thing the board has to get right at a glance.
    if (row.kind === "lane") {
      const pad = maxWidth - stringWidth(full);
      return ` ${row.label}${" ".repeat(Math.max(0, pad))}${row.tail}`;
    }
    return full;
  }

  const leadingSpace = 1;
  const ellipsis = 1;
  const budget = maxWidth - leadingSpace - stringWidth(row.tail) - ellipsis;
  if (budget <= 0) {
    // Not even the tail fits at full width — keep as much of the tail's
    // trailing end (where the "stalled" marker lives) as there is room for,
    // rather than an unreadable sliver of the label.
    return ` ${sliceTailToWidth(row.tail, maxWidth - leadingSpace)}`;
  }
  return ` ${sliceToWidth(row.label, budget)}…${row.tail}`;
}

/**
 * Fit a task row's status marker + label into `maxWidth` columns, same
 * ellipsis discipline as `fitAgentRow`: the marker (what says done vs.
 * pending) is preserved whole, the free-form title is what gives way.
 */
function fitTaskRow(row: TaskPanelRow, maxWidth: number): string {
  const marker = taskStatusMarker(row.status);
  const full = ` ${marker}${row.label}`;
  if (stringWidth(full) <= maxWidth) return full;

  const leadingSpace = 1;
  const ellipsis = 1;
  const budget = maxWidth - leadingSpace - stringWidth(marker) - ellipsis;
  if (budget <= 0) return ` ${sliceToWidth(marker, maxWidth - leadingSpace)}`;
  return ` ${marker}${sliceToWidth(row.label, budget)}…`;
}

/** Rebuild taskBox's row children to match the requested rows exactly. */
function renderTasksRows(shell: AppShell, rows: readonly TaskPanelRow[], maxWidth: number): void {
  for (const child of [...shell.taskBox.getChildren()]) {
    shell.taskBox.remove(child);
    destroySubtree(child);
  }
  for (const row of rows) {
    const text = new TextRenderable(shell.renderer as CliRenderer, {
      content: fitTaskRow(row, maxWidth),
      fg: row.status === "done" ? UI.done : row.status === "doing" ? UI.text : UI.textDim,
    });
    shell.taskBox.add(text);
  }
}

/** Paint tone for one agents-strip row (cream live / orange trouble / green done). */
function agentRowFg(row: AgentPanelRow): string {
  if (row.kind === "more" || row.kind === "header") return UI.textDim;
  if (row.stalled || row.status === "failed") return UI.action;
  if (row.status === "done") return UI.done;
  if (row.status === "cancelled" || row.status === "interrupted") return UI.textDim;
  return UI.text;
}

/** Rebuild agentsBox's row children to match the requested rows exactly. */
function renderAgentsRows(shell: AppShell, rows: readonly AgentPanelRow[], maxWidth: number): void {
  for (const child of [...shell.agentsBox.getChildren()]) {
    shell.agentsBox.remove(child);
    destroySubtree(child);
  }
  for (const row of rows) {
    // Live lanes use primary cream (`UI.text`) — the Amp/Codex strip is body
    // text, not bronze in-flight chrome. Stalled / failed keep the decision
    // orange; done linger is green; cancelled / "+N more" sit back in dim.
    const text = new TextRenderable(shell.renderer as CliRenderer, {
      content: fitAgentRow(row, maxWidth),
      fg: agentRowFg(row),
    });
    shell.agentsBox.add(text);
  }
}

/**
 * Set agents/task chrome zone content (null/empty = hide zone).
 * Heights come from geometry resolve — never guessed.
 */
function taskRowsEqual(a: readonly TaskPanelRow[], b: readonly TaskPanelRow[]): boolean {
  return (
    a.length === b.length &&
    a.every((row, i) => {
      const other = b[i];
      return other !== undefined && row.label === other.label && row.status === other.status;
    })
  );
}

export function setChromeZones(shell: AppShell, content: ChromeZoneContent): void {
  const bag = internals.get(shell);
  if (!bag) return;

  let taskChanged = false;
  if (content.task !== undefined) {
    bag.chrome.tasksRaw = content.task ?? [];
    const rendered = bag.tasksPanelHidden ? [] : bag.chrome.tasksRaw;
    taskChanged = !taskRowsEqual(rendered, bag.chrome.task);
    bag.chrome.task = rendered;
  }
  let agentsChanged = false;
  if (content.agents !== undefined) {
    const next = content.agents ?? [];
    agentsChanged =
      next.length !== bag.chrome.agents.length ||
      next.some((row, i) => {
        const prev = bag.chrome.agents[i];
        return (
          prev === undefined ||
          row.label !== prev.label ||
          row.tail !== prev.tail ||
          row.stalled !== prev.stalled ||
          row.status !== prev.status ||
          row.kind !== prev.kind
        );
      });
    bag.chrome.agents = next;
  }

  const taskRowCount = bag.chrome.task.length;
  const agentsRowCount = bag.chrome.agents.length;

  // Rebuilding N TextRenderable children is real node churn; skip it unless
  // the panel's actual lines changed (not every push carries new data).
  if (taskChanged) {
    renderTasksRows(shell, bag.chrome.task, shell.layout.contentWidth);
  }
  // Only a zone appearing/disappearing or its row count changing alters the
  // row budget; retitling a zone whose row count is unchanged must not
  // re-resolve and re-apply the whole layout.
  const budgetUnchanged =
    taskRowCount === bag.visibility.task && agentsRowCount === bag.visibility.agents;
  if (!budgetUnchanged) {
    relayout(shell, {
      visibility: {
        ...bag.visibility,
        task: taskRowCount,
        agents: agentsRowCount,
      },
      overlayMode: bag.overlayMode,
      ...(bag.overlayBodyRows !== undefined ? { overlayBodyRows: bag.overlayBodyRows } : {}),
    });
  }

  // Painted after the resolver has spoken, and only ever as many rows as it
  // granted: a board that paints past its box lands on top of the transcript
  // and tears down the renderables underneath it. Full content width (stack).
  if (agentsChanged || !budgetUnchanged) {
    renderAgentsRows(
      shell,
      clampBoardRows(bag.chrome.agents, shell.layout.heights.agents),
      shell.layout.contentWidth,
    );
  }
  if (budgetUnchanged) paintChrome(shell);
}

/** How long a panel-visibility flash holds the notice row. */
const PANEL_TOGGLE_FLASH_MS = 3000;

/**
 * Toggle the task-list panel visible/hidden without touching the live task
 * data underneath it — un-hiding shows whatever manage_tasks last wrote,
 * not a stale snapshot from before the hide. The flag lives on the shell's
 * internals in memory for the shell's lifetime; nothing is written to
 * storage, so it does not survive a restart.
 */
export function toggleTasksPanel(shell: AppShell): void {
  const bag = internals.get(shell);
  if (!bag) return;
  bag.tasksPanelHidden = !bag.tasksPanelHidden;
  const hiding = bag.tasksPanelHidden;
  setChromeZones(shell, { task: bag.chrome.tasksRaw });
  // A flash, not a transcript row: which panels are showing is a property of
  // the current screen, not something that happened in the conversation.
  setStatusFlash(shell, hiding ? "task list hidden · alt+t to show" : "task list shown", {
    ttlMs: PANEL_TOGGLE_FLASH_MS,
  });
}

/**
 * Enter copy mode (Alt+C / palette copy_active): freeze targets from the
 * active streamLog, open inset overlay with the last target selected.
 * Empty log → status flash only; no stream mutation.
 */
export function enterCopyMode(shell: AppShell): boolean {
  // Single host: do not stack copy over another primary overlay.
  if (shell.overlayList) return false;

  const targets = buildCopyTargets(shell.streamLog);
  if (targets.length === 0) {
    setStatusFlash(shell, "nothing to copy", { ttlMs: RUNTIME_FLASH_MS });
    return false;
  }

  shell.copyTargets = targets;
  const labels = targets.map((t) => `${t.label}: ${t.preview}`);
  openListOverlay(shell, {
    kind: "copy",
    title: "copy · Enter copies the selected item",
    items: labels,
    activeIndex: targets.length - 1,
    frameId: "copy-mode",
  });
  return true;
}

/** Write the frozen target at the active list index; status flash only. */
export function confirmCopySelection(shell: AppShell): boolean {
  const targets = shell.copyTargets;
  if (!targets || targets.length === 0 || !shell.overlayList) {
    setStatusFlash(shell, "nothing to copy", { ttlMs: RUNTIME_FLASH_MS });
    closeInsetOverlay(shell);
    return false;
  }
  const idx = Math.max(0, Math.min(targets.length - 1, shell.overlayList.activeIndex));
  const target = targets[idx];
  if (!target) {
    setStatusFlash(shell, "nothing to copy", { ttlMs: RUNTIME_FLASH_MS });
    closeInsetOverlay(shell);
    return false;
  }
  const preview =
    target.text.length > 48 ? `${target.text.slice(0, 45).replace(/\s+/g, " ")}…` : target.text;
  writeClipboard(shell.clipboard, target.text, {
    onSuccess: () => {
      setStatusFlash(shell, `Copied ${target.label} (${target.text.length} chars): ${preview}`, {
        ttlMs: RUNTIME_FLASH_MS,
      });
    },
    onFailure: () => {
      setStatusFlash(shell, "Copy failed", { ttlMs: RUNTIME_FLASH_MS });
    },
  });
  closeInsetOverlay(shell);
  return true;
}

/** Copy all frozen targets as markdown; status flash only. */
export function copyAllTargets(shell: AppShell): boolean {
  const targets = shell.copyTargets;
  if (!targets || targets.length === 0) {
    setStatusFlash(shell, "nothing to copy", { ttlMs: RUNTIME_FLASH_MS });
    if (shell.overlayKind === "copy") closeInsetOverlay(shell);
    return false;
  }
  const text = streamLogMarkdown(targets);
  writeClipboard(shell.clipboard, text, {
    onSuccess: () => {
      setStatusFlash(shell, `Copied all (${targets.length} items, ${text.length} chars)`, {
        ttlMs: RUNTIME_FLASH_MS,
      });
    },
    onFailure: () => {
      setStatusFlash(shell, "Copy failed", { ttlMs: RUNTIME_FLASH_MS });
    },
  });
  closeInsetOverlay(shell);
  return true;
}

/**
 * Alt+M: take DEC mouse reporting, or hand it back to the terminal.
 * Reporting is on by default so wheel scroll and click-to-expand work;
 * releasing it restores the terminal's own drag-select and copy.
 * Returns the new enabled state, or null when the host exposes no control.
 */
export function toggleMouseCapture(shell: AppShell): boolean | null {
  const port = shell.mouseCapture;
  if (!port) {
    setStatusFlash(shell, "mouse reporting is not controllable here", {
      ttlMs: RUNTIME_FLASH_MS,
    });
    return null;
  }
  const next = !port.get();
  port.set(next);
  setStatusFlash(
    shell,
    next
      ? "Mouse captured · drag text to copy · click to expand · Alt+M for native select"
      : "Mouse released · drag to select and copy as usual · Alt+M to click rows",
    { ttlMs: RUNTIME_FLASH_MS },
  );
  return next;
}

/**
 * Keyboard copy path (Alt+C): open the copy overlay (Ink parity).
 * `activeIndex` is ignored — selection lives in the overlay list.
 */
export function copyActiveMessage(shell: AppShell, _activeIndex?: number): boolean {
  return enterCopyMode(shell);
}

/**
 * Enter a child subagent session view.
 * Host passes live rows + agent label (`ObserveSession`); fixture via
 * `makeObserveFixture()` is only for demo/tests. Esc restores parent lease.
 */
export function enterSubagentObserve(shell: AppShell, session: ObserveSession): void {
  if (shell.observe) {
    leaveSubagentObserve(shell);
  }

  const seedLines = session.lines.slice();
  shell.parentStreamLog = shell.streamLog.slice();
  shell.parentStreamLogBase = shell.streamLogBase;
  shell.observe = {
    sessionId: session.sessionId,
    agentId: session.agentId,
    description: session.description,
    lines: seedLines.slice(),
  };

  // A fresh log for the child view; its own indices start at zero regardless
  // of how far the parent's retention cap has already trimmed.
  shell.streamLog = seedLines;
  shell.streamLogBase = 0;
  shell.lineCount = shell.streamLog.length;
  repaintTranscriptWindow(shell);

  shell.focus = openObserve(shell.focus, `observe-${session.sessionId}`);
  setChromeZones(shell, {
    agents: [
      {
        label: `observe: ${session.agentId} — ${session.description}`,
        tail: "",
        stalled: false,
      },
    ],
  });
  // Child chrome toast — must not route to parent snapshot.
  appendObserveStreamRow(shell, {
    role: "system",
    text: `Viewing ${session.agentId}: ${session.description}`,
    meta: "observe",
  });
  applyFocus(shell);
}

/** Leave observe; restore parent stream + focus lease. */
export function leaveSubagentObserve(shell: AppShell): void {
  if (!shell.observe) return;

  const agentId = shell.observe.agentId;
  shell.observe = null;

  if (shell.parentStreamLog) {
    shell.streamLog = shell.parentStreamLog;
    shell.streamLogBase = shell.parentStreamLogBase ?? 0;
    shell.parentStreamLog = null;
    shell.parentStreamLogBase = null;
  }
  shell.lineCount = shell.streamLog.length;
  repaintTranscriptWindow(shell);

  let guard = 4;
  while (guard-- > 0 && focusOwner(shell.focus) === "observe") {
    shell.focus = popFocus(shell.focus);
  }
  // Drop any observe frames that weren't top.
  const frames = shell.focus.frames.filter((f) => f.target !== "observe");
  if (frames.length > 0) shell.focus = { frames };

  setChromeZones(shell, { agents: null });
  appendStreamRow(shell, {
    role: "system",
    text: `left observe (${agentId})`,
    meta: "observe",
  });
  applyFocus(shell);
}

/**
 * Alt+O: observe a live subagent (its only entry point now that the palette
 * is gone — the palette's "observe" action used to call this same
 * `onObserveRequest` host hook). An honest "nothing to observe" flash rather
 * than doing nothing when there is no live session, so the chord is
 * discoverable as working even when it currently has nothing to show.
 */
export function observeActiveSubagent(shell: AppShell): void {
  const onObserveRequest = getPaletteOnObserveRequest(shell);
  const session = onObserveRequest ? onObserveRequest() : null;
  if (session) {
    enterSubagentObserve(shell, session);
    return;
  }
  appendStreamRow(shell, {
    role: "system",
    text: "no subagent session to observe",
    meta: "observe",
  });
}

/**
 * Host-injected residual list open. `items` is owned by the caller — there is
 * no fallback, so a missing dependency must produce an honest empty state or
 * a surfaced error upstream rather than reach this with nothing to show.
 * Per-open `onAccept` wins over shell-level residual hooks for that open.
 */
export interface OpenResidualListOpts {
  readonly items: readonly string[];
  /** Stable ids aligned with `items` (setting keys, session ids, paths). */
  readonly itemIds?: readonly string[];
  /** Plain chosen value aligned with `items`, for the accept echo (see `OpenListOverlayOpts.itemValues`). */
  readonly itemValues?: readonly (string | undefined)[];
  readonly activeIndex?: number;
  /** Per-open accept; host binds toggle / resume / mention insert. */
  readonly onAccept?: (selection: OverlaySelection) => void;
  /** Per-open ← → cycle hook (settings inline value cycling). */
  readonly onCycle?: (itemId: string, direction: -1 | 1) => void;
  /** Per-open description-zone source. */
  readonly describe?: (itemId: string) => ItemDescription | null;
}

export function openSettingsOverlay(shell: AppShell, opts: OpenResidualListOpts): void {
  openListOverlay(shell, {
    kind: "settings",
    title: "settings",
    items: opts.items,
    activeIndex: opts.activeIndex ?? 0,
    frameId: "overlay-settings",
    deferIfBusy: true,
    ...(opts.itemIds !== undefined ? { itemIds: opts.itemIds } : {}),
    ...(opts.itemValues !== undefined ? { itemValues: opts.itemValues } : {}),
    ...(opts.onAccept !== undefined ? { onAccept: opts.onAccept } : {}),
    ...(opts.onCycle !== undefined ? { onCycle: opts.onCycle } : {}),
    ...(opts.describe !== undefined ? { describe: opts.describe } : {}),
  });
}

/** Help rows derived from the shell's own keybinding catalog, so they cannot
 * drift from what the shell actually implements — there is no host dependency
 * to omit, so this never takes user-supplied items. */
function helpItems(): readonly string[] {
  return [...SHELL_SHORTCUTS.map((s) => `${s.keys} — ${s.description}`), "Close help"];
}

export function openHelpOverlay(shell: AppShell): void {
  const release = reserveOverlayHost(shell);
  try {
    closeReplaceableOverlay(shell);
    openListOverlay(shell, {
      kind: "help",
      title: "help · keymap",
      items: helpItems(),
      activeIndex: 0,
      frameId: "overlay-help",
      deferIfBusy: true,
    });
  } finally {
    release();
  }
}

export function openMentionsOverlay(shell: AppShell, opts: OpenResidualListOpts): void {
  openListOverlay(shell, {
    kind: "mentions",
    title: "mentions",
    items: opts.items,
    activeIndex: opts.activeIndex ?? 0,
    frameId: "overlay-mentions",
    ...(opts.itemIds !== undefined ? { itemIds: opts.itemIds } : {}),
    ...(opts.onAccept !== undefined ? { onAccept: opts.onAccept } : {}),
  });
}

/** Keys that only move the caret — they must not cancel history browsing. */
const MOTION_KEYS: ReadonlySet<string> = new Set([
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "tab",
  "escape",
]);

const defaultMentionSource: MentionSuggestionSource = (prefix) =>
  listPathSuggestions(prefix, process.cwd());

interface MentionAcceptState {
  readonly suggestions: readonly string[];
  readonly generation: number;
  readonly atStart: number;
}

/**
 * Open path suggestions for the @token under the cursor and splice the
 * accepted entry back into the prompt. Directory picks re-open one level
 * down so the operator can drill in without typing the path.
 * Returns false when the cursor is not inside an @token, nothing matched,
 * a newer lookup superseded this one, or the overlay host was taken.
 *
 * Accept requires a current generation and a live `@` token under the cursor.
 * A lookup that finishes after the cursor has left this token does not open.
 */
export async function openAtMentionSuggestions(shell: AppShell): Promise<boolean> {
  const at = parseAtState(shell.prompt.value, shell.prompt.cursorOffset);
  if (at === null) {
    closeMentionPopup(shell);
    return false;
  }

  // Every keystroke re-queries; a slower earlier query must not overwrite the
  // list a later one already produced.
  const generation = (mentionGenerations.get(shell) ?? 0) + 1;
  mentionGenerations.set(shell, generation);

  const source = shellMentionSource.get(shell) ?? defaultMentionSource;
  const token = splitMentionToken(at.prefix);
  let suggestions = filterMentionSuggestions(await source(token.dir), token.fragment);
  // Quitting mid-lookup tears down the renderer/TextBuffer this function
  // writes into below; a resolved-but-stale lookup must not touch them.
  if (shell.disposed) return false;
  // The source caps how many entries it returns per directory, so a large
  // directory can cap out before the interior match appears. Asking it to do
  // its own prefix filter puts that cap after the narrowing instead of before.
  if (suggestions.length === 0 && token.fragment.length > 0) {
    suggestions = await source(at.prefix);
    if (shell.disposed) return false;
  }
  if (mentionGenerations.get(shell) !== generation) return false;

  if (suggestions.length === 0) {
    // Mirrors `/`'s no-match contract: close the popup and leave the typed
    // text standing, with no empty-state message.
    closeMentionPopup(shell);
    return false;
  }

  // The operator may have left this token while the lookup was in flight.
  // Do not open, and do not arm accept, unless the cursor is still on this @
  // (same atStart). A different live @token is not this lookup.
  const liveAt = parseAtState(shell.prompt.value, shell.prompt.cursorOffset);
  if (liveAt === null || liveAt.atStart !== at.atStart) {
    closeMentionPopup(shell);
    return false;
  }

  // The onAccept closure reads mentionAcceptState rather than closing over
  // `suggestions` directly, so a same-session refresh can update what accept
  // splices without re-binding the callback. atStart is the @ this lookup
  // started on; the splice end is the live cursor.
  const acceptState: MentionAcceptState = {
    suggestions,
    generation,
    atStart: at.atStart,
  };

  // Every keystroke lands here while the popup is already open. Closing and
  // reopening the overlay released the host between the two calls — long
  // enough for a queued permission/operator gate to open on it — and left the
  // gate's overlay on screen while `mentionPopups` still claimed ownership.
  // Refreshing the open list in place never releases the host, so a queued
  // gate has nothing to drain into.
  if (isMentionPopupOpen(shell)) {
    mentionAcceptState.set(shell, acceptState);
    setOverlayItems(shell, [...suggestions]);
    return true;
  }

  closeMentionPopup(shell);
  openMentionsOverlay(shell, {
    items: [...suggestions],
    onAccept: (selection) => {
      const ready = liveMentionAccept(shell);
      if (ready === null) return;
      const completion = ready.state.suggestions[selection.index];
      if (completion === undefined) return;
      const spliced = spliceMentionCompletion(
        shell.prompt.value,
        ready.live.atStart,
        shell.prompt.cursorOffset,
        completion,
      );
      editPromptAt(shell, spliced.value, spliced.cursor);
      if (completion.endsWith("/")) void openAtMentionSuggestions(shell);
    },
  });
  if (shell.overlayKind !== "mentions") return false;
  mentionAcceptState.set(shell, acceptState);
  mentionPopups.add(shell);
  return true;
}

const mentionPopups = new WeakSet<AppShell>();
const mentionGenerations = new WeakMap<AppShell, number>();
const mentionAcceptState = new WeakMap<AppShell, MentionAcceptState>();

/** Drop accept state and invalidate in-flight lookups on operator dismiss. */
function clearMentionAccept(shell: AppShell): void {
  mentionAcceptState.delete(shell);
  mentionGenerations.set(shell, (mentionGenerations.get(shell) ?? 0) + 1);
}

/** Live accept snapshot, or null when there is no state, generation is stale, or the cursor left this @. */
function liveMentionAccept(shell: AppShell): { state: MentionAcceptState; live: AtState } | null {
  const state = mentionAcceptState.get(shell);
  if (state === undefined) return null;
  if (mentionGenerations.get(shell) !== state.generation) return null;
  const live = parseAtState(shell.prompt.value, shell.prompt.cursorOffset);
  if (live === null || live.atStart !== state.atStart) return null;
  return { state, live };
}

/** True while the `@` path popup owns typed characters. */
export function isMentionPopupOpen(shell: AppShell): boolean {
  return mentionPopups.has(shell) && shell.overlayKind === "mentions";
}

export function closeMentionPopup(shell: AppShell): void {
  if (!mentionPopups.has(shell)) return;
  clearMentionAccept(shell);
  mentionPopups.delete(shell);
  if (shell.overlayList) closeInsetOverlay(shell);
}

function editPromptAt(shell: AppShell, value: string, cursor: number): void {
  shell.prompt.value = value;
  shell.prompt.cursorOffset = cursor;
  shell.sentHistory = sentHistoryOnEdit(shell.sentHistory);
}

/**
 * Keys the `@` popup claims while open — the same contract as the `/` popup:
 * printable characters narrow the list, Backspace widens it, and a query that
 * matches nothing closes the popup with the typed text left in place.
 *
 * The prompt does not hold focus while the overlay is open, so this inserts and
 * deletes the characters itself rather than letting the InputRenderable do it.
 */
export function handleMentionPopupKey(shell: AppShell, key: KeyEvent): boolean {
  if (!isMentionPopupOpen(shell) || shell.overlayList === null) return false;
  if (key.ctrl || key.meta || key.option) return false;

  const value = shell.prompt.value;
  const cursor = shell.prompt.cursorOffset;

  if (key.name === "backspace") {
    if (cursor === 0) {
      closeMentionPopup(shell);
      return true;
    }
    editPromptAt(shell, value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
    // Deleting the `@` itself ends the mention; there is nothing left to filter.
    if (value[cursor - 1] === "@") closeMentionPopup(shell);
    else void openAtMentionSuggestions(shell);
    return true;
  }

  const seq = typeof key.sequence === "string" ? key.sequence : "";
  if (seq.length !== 1 || seq < " ") return false;

  editPromptAt(shell, value.slice(0, cursor) + seq + value.slice(cursor), cursor + 1);
  // Whitespace terminates the @token, so the popup has nothing left to narrow.
  if (/\s/.test(seq)) closeMentionPopup(shell);
  else void openAtMentionSuggestions(shell);
  return true;
}

const slashPopups = new WeakSet<AppShell>();

/** True while the `/` command popup owns typed characters. */
export function isSlashPopupOpen(shell: AppShell): boolean {
  return slashPopups.has(shell) && shell.overlayList !== null;
}

/**
 * Popup query = prompt text after the leading `/`. Null once the operator has
 * typed whitespace: at that point the name is settled and the rest is arguments.
 */
function slashPopupQuery(shell: AppShell): string | null {
  const value = shell.prompt.value;
  if (!value.startsWith("/")) return null;
  const head = value.slice(1);
  return /\s/.test(head) ? null : head;
}

export function closeSlashPopup(shell: AppShell): void {
  if (!slashPopups.has(shell)) return;
  slashPopups.delete(shell);
  if (shell.overlayList) closeInsetOverlay(shell);
}

/**
 * Open (or refresh) the `/` command popup for the name being typed. Reuses the
 * palette overlay so accept dispatches through the same registry path as a
 * typed `/name`. Returns false when nothing matches — the typed text stays.
 */
export function openSlashCommands(shell: AppShell): boolean {
  const query = slashPopupQuery(shell);
  if (query === null) {
    closeSlashPopup(shell);
    return false;
  }
  // Name-prefix, not the palette's fuzzy label match: at the prompt the
  // operator is typing the command they already mean.
  const q = query.toLowerCase();
  const matches = resolvePaletteCatalog(shell).filter((cmd) => cmd.id.toLowerCase().startsWith(q));

  // Every keystroke lands here while the popup is already open. Closing and
  // reopening released the overlay host between the two calls (closeSlashPopup
  // routes through closeInsetOverlay, which idle-notifies) — long enough for a
  // queued permission/operator gate to drain onto it. Refreshing the open
  // palette in place never releases the host, so a queued gate has nothing to
  // drain into. priorOverlay stacking is untouched here (it is only ever
  // written by openListOverlay's stack-on-open path), so a palette stacked
  // over a prior overlay keeps that snapshot across the refresh.
  //
  // A typo that zeroes the matches must not fall through to closeSlashPopup
  // while the popup is already open — that closes through the same idle-notify
  // path and drains a queued gate mid-filter. Instead this refreshes in place
  // to a "(no matches)" row, same as the general palette does, and holds the
  // host until a real dismiss (deleting the `/`, Esc, accept) or a backspace
  // that restores matches.
  if (isSlashPopupOpen(shell) && shell.overlayKind === "palette") {
    refreshSlashPopupInPlace(shell, matches);
    return true;
  }

  if (matches.length === 0) {
    closeSlashPopup(shell);
    return false;
  }

  closeSlashPopup(shell);
  openPalette(shell, { catalog: matches, title: "commands · /" });
  slashPopups.add(shell);
  return true;
}

/** Refresh the already-open `/` popup's rows in place for the given matches. */
function refreshSlashPopupInPlace(shell: AppShell, matches: readonly PaletteCommand[]): void {
  const labels = matches.length > 0 ? paletteLabels(matches) : ["(no matches)"];
  shell.paletteCommands = matches;
  const bag = internals.get(shell);
  if (bag) {
    bag.paletteFilter = {
      query: bag.paletteFilter?.query ?? "",
      title: "commands · /",
      catalog: matches,
      typeToFilter: false,
    };
    bag.overlayDescribe = (id) => {
      const cmd = matches.find((c) => c.id === id);
      const what = cmd?.description?.trim();
      return what ? { what } : null;
    };
  }
  setOverlayItems(
    shell,
    labels,
    matches.map((c) => c.id),
    undefined,
    {
      resetActive: true,
    },
  );
  relayoutOverlayHost(shell, labels.length);
}

function setPromptText(shell: AppShell, value: string): void {
  shell.prompt.value = value;
  shell.prompt.cursorOffset = value.length;
  shell.sentHistory = sentHistoryOnEdit(shell.sentHistory);
}

/**
 * Keys the `/` popup claims while open. Returns true when handled.
 *
 * Enter runs the highlighted command with no arguments; Tab instead completes
 * the name and leaves the popup so arguments can be typed — a command that
 * needs arguments should not fire bare just because its name matched.
 */
export function handleSlashPopupKey(shell: AppShell, key: KeyEvent): boolean {
  if (!isSlashPopupOpen(shell) || shell.overlayList === null) return false;

  if (key.name === "backspace" && !key.ctrl && !key.meta && !key.option) {
    setPromptText(shell, shell.prompt.value.slice(0, -1));
    openSlashCommands(shell);
    return true;
  }

  const active = shell.paletteCommands[shell.overlayList.activeIndex];

  if (key.name === "tab" && !key.shift && !key.ctrl && !key.meta && !key.option) {
    if (active) setPromptText(shell, `/${active.id} `);
    closeSlashPopup(shell);
    return true;
  }

  if ((key.name === "return" || key.name === "enter") && !key.ctrl && !key.meta && !key.option) {
    // Genuine dismiss (zero matches) still notifies immediately so a queued
    // gate can drain. Accept-with-match keeps the host until dispatch settles.
    if (!active) {
      closeSlashPopup(shell);
      return true;
    }
    setPromptText(shell, "");
    slashPopups.delete(shell);
    const release = reserveOverlayHost(shell);
    closeInsetOverlay(shell);
    try {
      dispatchPaletteSelection(shell, active);
    } finally {
      release();
    }
    return true;
  }

  const seq = typeof key.sequence === "string" ? key.sequence : "";
  const printable =
    seq.length === 1 && seq >= " " && seq !== "" && !key.ctrl && !key.meta && !key.option;
  if (!printable) return false;

  setPromptText(shell, shell.prompt.value + seq);
  // Whitespace ends the name; keep the popup out of the way while args are typed.
  if (/\s/.test(seq)) closeSlashPopup(shell);
  else openSlashCommands(shell);
  return true;
}

/** Window in which a second Ctrl+C is read as "yes, quit". */
export const CTRL_C_EXIT_WINDOW_MS = 2000;

const ctrlCArmedAt = new WeakMap<AppShell, number>();

/**
 * Ctrl+C: interrupt / clear, and quit on a second press inside the window.
 * The double press replaces the old Ink y/n exit confirm — same intent (an
 * explicit second confirmation), no modal. Quitting routes through the
 * registered exit handler so host finalize still runs.
 */
export function handleCtrlC(shell: AppShell, now = Date.now(), options?: FlashOptions): void {
  const armedAt = ctrlCArmedAt.get(shell);
  if (armedAt !== undefined && now - armedAt <= CTRL_C_EXIT_WINDOW_MS) {
    ctrlCArmedAt.delete(shell);
    const onExit = shellExitHandlers.get(shell);
    if (onExit !== undefined) {
      onExit();
      return;
    }
  }
  ctrlCArmedAt.set(shell, now);

  if (shell.session.run === "busy" || badgeCount(shell.session) > 0) {
    interruptShell(shell);
  } else if (shell.prompt.value.length > 0) {
    shell.prompt.value = "";
  }
  // The notice is exactly as true as the arming window is open, so it expires
  // with it rather than waiting for some later flash to overwrite it.
  setStatusFlash(shell, "press ctrl+c again to exit", {
    ttlMs: CTRL_C_EXIT_WINDOW_MS,
    ...(options?.schedule !== undefined ? { schedule: options.schedule } : {}),
  });
}

/**
 * Wheel/trackpad scroll landing on the prompt scrolls the chat instead.
 *
 * The prompt textarea is an editable buffer with its own `scrollY`, so
 * OpenTUI's default routing — whichever renderable the wheel event hits, or
 * the focused renderable when the hit misses — happily scrolls the prompt's
 * own (usually one-screen, nothing-to-scroll) content. The prompt also holds
 * keyboard focus for the whole session, so it is the fallback target for any
 * wheel event that lands off the transcript's hit-tested rows. Overriding the
 * scroll case here — rather than teaching the transcript's own scroll lease
 * about wheel events — keeps the fix to exactly where wheel input actually
 * arrives, without touching transcript viewport internals.
 */
function routePromptWheelToTranscript(
  prompt: BaseRenderable,
  transcript: ScrollBoxRenderable,
): void {
  (prompt as unknown as { onMouseEvent: (event: MouseEvent) => void }).onMouseEvent = (
    event: MouseEvent,
  ) => {
    if (event.type !== "scroll") return;
    (transcript as unknown as { onMouseEvent: (event: MouseEvent) => void }).onMouseEvent(event);
  };
}

/**
 * Build the app shell frame on an OpenTUI renderer.
 * Mounts sticky transcript / overlay host / transient notice / prompt box.
 */
export function createAppShell(renderer: ShellRenderer, options?: AppShellOptions): AppShell {
  const title = options?.title ?? DEFAULT_TITLE;
  const visibility = defaultVisibility(options?.visibility);
  const promptContentRows = options?.promptContentRows ?? PROMPT_IDLE_ROWS;
  const wireKeys = options?.wireKeys !== false;
  const mount = options?.mount !== false;
  // A freshly mounted shell has nothing in flight; the runner sets busy when a
  // turn starts. Defaulting to busy made the landing screen offer "^C stop".
  const run = options?.run ?? "idle";
  const overlayItems = options?.overlayItems ?? [...DEFAULT_OVERLAY_ITEMS];
  const paletteCatalogOpt = options?.paletteCatalog ?? null;
  const onCommandOpt = options?.onCommand;
  const onObserveRequestOpt = options?.onObserveRequest;

  const terminal = terminalOf(renderer, options?.terminal);
  const layout = resolveGeometry({
    terminal: terminalForGeometry(terminal),
    visibility,
    overlay: { mode: "closed" },
    promptContentRows,
  });

  const ctx = renderer as CliRenderer;

  const root = new BoxRenderable(ctx, {
    id: "app-shell",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: UI.ground,
    paddingLeft: layout.sideMargin,
    paddingRight: layout.sideMargin,
  });

  // One optical gutter for the whole shell: every zone is a child of the padded
  // root, so nothing can drift out of alignment with the rest.
  const topPad = new BoxRenderable(ctx, {
    id: "shell-top-pad",
    width: "100%",
    height: 1,
    flexShrink: 0,
    backgroundColor: UI.ground,
  });

  // Same gutter, other end: keeps the prompt box off the terminal's last row.
  const bottomPad = new BoxRenderable(ctx, {
    id: "shell-bottom-pad",
    width: "100%",
    height: 1,
    flexShrink: 0,
    backgroundColor: UI.ground,
  });

  // Persistent chrome, not part of the landing composition (`landing.ts`
  // never renders it, unlike the old in-hero version line): its own row at
  // the very foot of root's column, after everything else, right-aligned.
  // Every other zone here already toggles a reserved row on/off by terminal
  // size (taskBox, agentsBox, bottomPad) rather than floating over content,
  // so this follows the same pattern — the row only exists (and can only
  // move the prompt box up by exactly one line) at the size threshold where
  // `versionBadgeVisible` already says the badge itself should degrade away,
  // well before anything else in the shell would need to.
  const versionRow = new BoxRenderable(ctx, {
    id: "shell-version-row",
    width: "100%",
    height: 1,
    flexShrink: 0,
    flexDirection: "row",
    justifyContent: "flex-end",
    backgroundColor: UI.ground,
    visible: versionBadgeVisible(terminal.columns, terminal.rows),
  });
  const versionBadge = new TextRenderable(ctx, {
    id: "shell-version-badge",
    content: LANDING_VERSION,
    fg: UI.textFaint,
  });
  versionRow.add(versionBadge);

  // Optional chrome zones (off by default; setChromeZones turns them on).
  const taskBox = new BoxRenderable(ctx, {
    id: "shell-task",
    width: "100%",
    height: 1,
    flexShrink: 0,
    flexDirection: "column",
    backgroundColor: UI.ground,
    visible: false,
  });

  const agentsBox = new BoxRenderable(ctx, {
    id: "shell-agents",
    width: "100%",
    height: 1,
    flexShrink: 0,
    flexDirection: "column",
    backgroundColor: UI.ground,
    visible: false,
  });

  const transcript = new ScrollBoxRenderable(ctx, {
    id: "shell-transcript",
    width: "100%",
    height: Math.max(1, layout.heights.transcript),
    flexShrink: 0,
    stickyScroll: true,
    stickyStart: "bottom",
    scrollY: true,
    focusable: true,
    rootOptions: { backgroundColor: UI.ground },
    contentOptions: { backgroundColor: UI.ground },
    viewportOptions: { backgroundColor: UI.ground },
  });
  // The transcript scrolls with the keyboard, and the bar spent a column on
  // every row to say so. Position is legible from the content itself.
  transcript.verticalScrollBar.visible = false;
  transcript.horizontalScrollBar.visible = false;

  // Leading filler that bottom-anchors a short transcript; see
  // `syncTranscriptSpacer`. Zero height until the first sync call.
  const transcriptSpacer = new BoxRenderable(ctx, {
    id: "shell-transcript-spacer",
    width: "100%",
    height: 0,
    flexShrink: 0,
    backgroundColor: UI.ground,
  });
  transcript.add(transcriptSpacer);

  const landingAbove = createLandingAbove(ctx);
  const landingBelowState = landingBelowContent({
    rows: splitLandingRows(layout.heights.transcript).below,
    columns: layout.contentWidth,
    telemetryNotice: options?.telemetryNotice,
  });
  const landingBelow = createLandingBelow(ctx, landingBelowState);

  const overlayHost = new BoxRenderable(ctx, {
    id: "shell-overlay-host",
    width: "100%",
    height: 1,
    flexShrink: 0,
    flexDirection: "column",
    // A short terminal can leave the host fewer rows than its body wants. Rows
    // that do not fit are clipped rather than painted over the chrome below,
    // which would leave a half-overlay the operator cannot dismiss.
    overflow: "hidden",
    border: true,
    borderColor: UI.textDim,
    backgroundColor: UI.ground,
    visible: false,
  });
  const overlayTitle = new TextRenderable(ctx, {
    id: "shell-overlay-title",
    content: " overlay",
    fg: UI.textDim,
  });
  const overlayBody = new BoxRenderable(ctx, {
    id: "shell-overlay-body",
    width: "100%",
    flexGrow: 1,
    flexDirection: "column",
    backgroundColor: UI.ground,
  });
  overlayHost.add(overlayTitle);
  overlayHost.add(overlayBody);

  // Transient only: the resolver gives it a row when paintChrome asks for one.
  const notice = new TextRenderable(ctx, {
    id: "shell-notice",
    height: Math.max(1, layout.heights.notice),
    content: "",
    fg: UI.textDim,
    visible: layout.heights.notice > 0,
  });

  const promptBox = new BoxRenderable(ctx, {
    id: "shell-prompt-region",
    width: "100%",
    height: Math.max(1, layout.heights.prompt),
    flexShrink: 0,
    flexDirection: "column",
    backgroundColor: UI.ground,
  });
  // The box is drawn in three pieces rather than as one bordered Box because
  // both horizontal rules carry content the frame's own border cannot: a
  // right-aligned label that the rule breaks around, and an animated lockup
  // whose cells are individually coloured.
  const promptTopRule = new TextRenderable(ctx, {
    id: "shell-prompt-top-rule",
    height: 1,
    content: "",
    fg: UI.textFaint,
  });
  const promptBottomRule = new TextRenderable(ctx, {
    id: "shell-prompt-bottom-rule",
    height: 1,
    content: "",
    fg: UI.textFaint,
  });
  const promptField = new BoxRenderable(ctx, {
    id: "shell-prompt-frame",
    width: "100%",
    height: Math.max(1, layout.heights.prompt - 2),
    flexShrink: 0,
    border: ["left", "right"],
    borderStyle: "rounded",
    borderColor: UI.textFaint,
    focusedBorderColor: UI.textDim,
    backgroundColor: UI.ground,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const prompt = createPromptInput(ctx, {
    id: "shell-prompt",
    width: "100%",
    height: Math.max(1, layout.heights.prompt - 2),
    placeholder: "message…",
    backgroundColor: UI.ground,
    focusedBackgroundColor: UI.ground,
    textColor: UI.text,
    cursorColor: UI.text,
    placeholderColor: UI.textFaint,
  });
  routePromptWheelToTranscript(prompt, transcript);
  promptField.add(prompt);
  promptBox.add(promptTopRule);
  promptBox.add(promptField);
  promptBox.add(promptBottomRule);

  root.add(topPad);
  root.add(transcript);
  root.add(overlayHost);
  root.add(agentsBox);
  root.add(taskBox);
  root.add(notice);
  root.add(promptBox);
  root.add(landingBelow);
  root.add(bottomPad);
  root.add(versionRow);

  if (mount) {
    renderer.root.add(root);
  }

  let disposed = false;
  let session = createSessionQueue(run);
  const seedPending = Math.max(0, Math.floor(options?.pendingQueue ?? 0));
  for (let i = 0; i < seedPending; i++) {
    session = enqueue(session, `seed-${i + 1}`);
  }

  // A real bracketed-paste event proves this terminal negotiates DEC 2004:
  // every paste from here on arrives as one `paste` event, never as raw
  // keystrokes, so the CRLF-submit fallback below has nothing left to guard
  // against and turns itself off for the rest of the session. Terminals that
  // never send one keep the guard, since they've never shown they can do
  // better. Un-bracketed-paste bookkeeping only this key handler reads, so it
  // lives in this closure rather than on the shared AppShell.
  let sawBracketedPaste = false;
  let lastKeyAt = 0;
  let lastKeyWasPrintable = false;
  let suppressNextLinefeed = false;
  const onPaste = (event: { bytes: Uint8Array; preventDefault: () => void }): void => {
    if (disposed) return;
    const bag = internals.get(shell);
    if (bag?.inputSuspended === true) return;
    sawBracketedPaste = true;
    if (shell.overlayList !== null && bag?.overlayOnPaste) {
      event.preventDefault();
      bag.overlayOnPaste(new TextDecoder().decode(event.bytes));
    }
  };

  const onKey = (key: KeyEvent): void => {
    if (disposed) return;
    if (internals.get(shell)?.inputSuspended === true) return;

    if (key.name === "escape") {
      if (exitOverlayAnswerMode(shell)) {
        key.preventDefault();
        return;
      }
      if (shell.overlayList) {
        key.preventDefault();
        abortOverlayHostReservations(shell);
        closeInsetOverlay(shell);
        return;
      }
      if (internals.get(shell)?.overlayHostReservations) {
        abortOverlayHostReservations(shell);
        key.preventDefault();
        // Next tick so the same Esc cannot also dismiss a gate this abort drains.
        queueMicrotask(() => notifyOverlayClosed(shell));
        return;
      }
      if (shell.observe) {
        key.preventDefault();
        leaveSubagentObserve(shell);
        return;
      }
      // Transcript browse (entered with Tab) is the remaining poppable frame:
      // Esc hands typing back to the prompt.
      if (canPopFocus(shell.focus)) {
        key.preventDefault();
        shell.focus = popFocus(shell.focus);
        applyFocus(shell);
        return;
      }
    }

    // Landing starters. Only while the prompt is untouched, so the digit goes
    // back to being a digit the moment the operator starts typing.
    if (
      shell.overlayList === null &&
      !key.ctrl &&
      !key.meta &&
      !key.option &&
      typeof key.name === "string" &&
      applyLandingSuggestion(shell, key.name)
    ) {
      key.preventDefault();
      return;
    }

    if (shell.overlayList) {
      // Checked ahead of the filter handlers: an opener chord pressed again is
      // a request to close, not a character to narrow the list with.
      if (toggleCloseOpenSurface(shell, key)) {
        key.preventDefault();
        return;
      }
      // The `/` popup filters as you type, so it claims printable keys before
      // the overlay's j/k navigation can swallow them.
      if (handleSlashPopupKey(shell, key)) {
        key.preventDefault();
        return;
      }
      // Same reason as the `/` popup: the `@` popup narrows as you type, so it
      // claims printable keys ahead of the overlay's j/k navigation.
      if (handleMentionPopupKey(shell, key)) {
        key.preventDefault();
        return;
      }
      // A live answer field owns every printable key, so an operator typing a
      // free-form answer is not navigating the choice list instead.
      if (handleOverlayAnswerKey(shell, key)) {
        key.preventDefault();
        return;
      }
      // Type-to-filter overlays (palette, model picker) claim printables —
      // including j/k that non-filter overlays still use to navigate.
      if (handlePaletteFilterKey(shell, key)) {
        key.preventDefault();
        return;
      }
      // Same opt-in for list overlays (model picker): type-to-filter claims
      // printables so a long flat catalog narrows without a nested pane.
      if (handleListFilterKey(shell, key)) {
        key.preventDefault();
        return;
      }
      // Per-overlay bare-key owners (including text panes) get first refusal.
      // Ordinary lists return false here, preserving j/k navigation below.
      if (runOverlayAction(shell, key)) {
        key.preventDefault();
        return;
      }
      if (key.name === "up" || key.name === "k") {
        key.preventDefault();
        moveOverlaySelection(shell, -1);
        return;
      }
      if (key.name === "down" || key.name === "j") {
        key.preventDefault();
        moveOverlaySelection(shell, 1);
        return;
      }
      // Left/Right only mean something to an overlay that opted into cycling
      // (settings). Everywhere else they fall through unclaimed.
      if (
        (key.name === "left" || key.name === "right") &&
        !key.ctrl &&
        !key.meta &&
        !key.option &&
        cycleOverlaySelection(shell, key.name === "left" ? -1 : 1)
      ) {
        key.preventDefault();
        return;
      }
      if (key.name === "pageup") {
        key.preventDefault();
        pageOverlaySelection(shell, -1);
        return;
      }
      if (key.name === "pagedown") {
        key.preventDefault();
        pageOverlaySelection(shell, 1);
        return;
      }
      if (
        key.name === OVERLAY_EXPAND_KEY &&
        !key.ctrl &&
        !key.meta &&
        !key.option &&
        toggleOverlayExpand(shell)
      ) {
        key.preventDefault();
        return;
      }
      if (shell.overlayKind === "copy") {
        if (key.name === "y" && !key.ctrl && !key.meta && !key.option) {
          key.preventDefault();
          confirmCopySelection(shell);
          return;
        }
        if (key.name === "a" && !key.ctrl && !key.meta && !key.option) {
          key.preventDefault();
          copyAllTargets(shell);
          return;
        }
      }
      if (key.name === "return" || key.name === "enter") {
        if (!key.meta && !key.option && !key.ctrl) {
          key.preventDefault();
          acceptOverlaySelection(shell);
          return;
        }
      }
      return;
    }

    // Emacs-style prompt editing: Ctrl+B/F/D, arrow motion, and Alt+B/F word
    // motion are already native InputRenderable bindings (see
    // defaultTextareaKeyBindings in @opentui/core). What's missing is the
    // kill ring — Ctrl+K/U/W and Alt+D delete natively but discard the text;
    // Ctrl+Y/Alt+Y need somewhere to yank it back from.
    const keyName = typeof key.name === "string" ? key.name.toLowerCase() : "";

    // Everything below this line is the un-bracketed-paste fallback, and a
    // terminal that has ever fired a real `paste` event has proven it never
    // needs it: every future paste arrives as one `paste` event, not raw
    // keystrokes, so re-running these checks on it would only risk a false
    // positive for no benefit.
    if (!sawBracketedPaste) {
      // The LF half of a CRLF pair the block below just turned into a
      // newline: without this, "line one\r\nline two" would insert two
      // newlines, one for the converted CR and one for the LF right behind it.
      const suppressLinefeed = suppressNextLinefeed;
      suppressNextLinefeed = false;
      if (suppressLinefeed && keyName === "linefeed" && !key.ctrl && !key.meta && !key.option) {
        key.preventDefault();
        return;
      }

      // A bare CR is the same "return" that submits. Left alone, pasting
      // three lines here sends three separate messages instead of composing
      // one. Detecting it needs two signals, not one: a lone fast Enter can
      // happen (key rollover, a scripted "send keys"), and a lone printable
      // character right before Enter is just typing. What never happens from
      // a human is a printable character landing, then Enter, both inside a
      // keystroke burst -- that shape is unique to a paste being replayed
      // byte-for-byte. Gating on both keeps a deliberate Ctrl+J-then-Enter
      // (newline, then send) safe, since Ctrl+J is not "a printable
      // character," while still catching "...line one<CR><LF>line two...".
      const now = Date.now();
      const sincePreviousKey = now - lastKeyAt;
      const previousKeyWasPrintable = lastKeyWasPrintable;
      lastKeyAt = now;
      lastKeyWasPrintable = isPrintableInsertKey(key);
      const isBareReturn =
        !key.ctrl && !key.meta && !key.option && (keyName === "return" || keyName === "kpenter");
      if (isBareReturn && previousKeyWasPrintable && sincePreviousKey < PASTE_BURST_MS) {
        key.preventDefault();
        shell.prompt.insertText("\n");
        suppressNextLinefeed = true;
        return;
      }
    }

    const isCtrlKillYank =
      key.ctrl &&
      !key.meta &&
      !key.option &&
      (keyName === "k" || keyName === "u" || keyName === "w" || keyName === "y");
    const isAltKillYank =
      (key.meta || key.option) && !key.ctrl && (keyName === "d" || keyName === "y");
    if (!isCtrlKillYank && !isAltKillYank) {
      shell.promptKillRing = breakKillSequence(shell.promptKillRing);
    }

    if (key.ctrl && !key.meta && !key.option && keyName === "k") {
      key.preventDefault();
      const before = shell.prompt.value;
      const beforeCursor = shell.prompt.cursorOffset;
      shell.prompt.deleteToLineEnd();
      const killed = killedTextForward(before, beforeCursor, shell.prompt.value);
      shell.promptKillRing = recordKill(shell.promptKillRing, killed, "forward");
      return;
    }

    if (key.ctrl && !key.meta && !key.option && keyName === "u") {
      key.preventDefault();
      const before = shell.prompt.value;
      const beforeCursor = shell.prompt.cursorOffset;
      shell.prompt.deleteToLineStart();
      const killed = killedTextBackward(before, beforeCursor, shell.prompt.cursorOffset);
      shell.promptKillRing = recordKill(shell.promptKillRing, killed, "backward");
      return;
    }

    if (key.ctrl && !key.meta && !key.option && keyName === "w") {
      key.preventDefault();
      const before = shell.prompt.value;
      const beforeCursor = shell.prompt.cursorOffset;
      shell.prompt.deleteWordBackward();
      const killed = killedTextBackward(before, beforeCursor, shell.prompt.cursorOffset);
      shell.promptKillRing = recordKill(shell.promptKillRing, killed, "backward");
      return;
    }

    if ((key.meta || key.option) && !key.ctrl && keyName === "d") {
      key.preventDefault();
      const before = shell.prompt.value;
      const beforeCursor = shell.prompt.cursorOffset;
      shell.prompt.deleteWordForward();
      const killed = killedTextForward(before, beforeCursor, shell.prompt.value);
      shell.promptKillRing = recordKill(shell.promptKillRing, killed, "forward");
      return;
    }

    if (key.ctrl && !key.meta && !key.option && keyName === "y") {
      key.preventDefault();
      const yank = beginYank(shell.promptKillRing, shell.prompt.cursorOffset);
      if (yank !== null) {
        shell.promptKillRing = yank.ring;
        shell.prompt.insertText(yank.text);
      }
      return;
    }

    if ((key.meta || key.option) && !key.ctrl && keyName === "y") {
      key.preventDefault();
      const rotated = rotateYank(shell.promptKillRing);
      if (rotated !== null && rotated.span.end <= shell.prompt.value.length) {
        shell.promptKillRing = rotated.ring;
        shell.prompt.setSelection(rotated.span.start, rotated.span.end);
        shell.prompt.deleteSelection();
        shell.prompt.cursorOffset = rotated.span.start;
        shell.prompt.insertText(rotated.text);
      }
      return;
    }

    // Ctrl+V is a real keypress (0x16), not the system paste: the terminal
    // turns CMD+V into bracketed paste, which OpenTUI delivers as its own
    // `paste` event and the InputRenderable inserts as text. Binding Ctrl+V
    // here therefore cannot swallow an ordinary text paste.
    if (key.ctrl && !key.meta && !key.option && (keyName === "p" || keyName === "v")) {
      key.preventDefault();
      void attachClipboardImage(shell);
      return;
    }

    // Typing @ at a token boundary opens path suggestions. The overlay owns
    // focus while open, so the @ is inserted here rather than left to the
    // InputRenderable, which would race the focus change.
    if (
      !key.ctrl &&
      !key.meta &&
      !key.option &&
      key.sequence === "@" &&
      focusOwner(shell.focus) === "prompt"
    ) {
      const before = shell.prompt.value.slice(0, shell.prompt.cursorOffset);
      if (before.length === 0 || /\s$/.test(before)) {
        key.preventDefault();
        shell.prompt.insertText("@");
        void openAtMentionSuggestions(shell);
        return;
      }
    }

    // A slash command is only valid as the whole prompt, so `/` pops the
    // command list at the start of an empty prompt and nowhere else — mid-line
    // it is just a path separator.
    if (
      !key.ctrl &&
      !key.meta &&
      !key.option &&
      key.sequence === "/" &&
      focusOwner(shell.focus) === "prompt" &&
      shell.prompt.cursorOffset === 0 &&
      shell.prompt.value.trim().length === 0
    ) {
      key.preventDefault();
      setPromptText(shell, "/");
      openSlashCommands(shell);
      return;
    }

    if (
      !key.ctrl &&
      !key.meta &&
      !key.option &&
      (key.name === "up" || key.name === "down") &&
      focusOwner(shell.focus) === "prompt"
    ) {
      // Multi-row prompt: Up/Down are caret motion first. Recall only fires at
      // the buffer's edges, which is where a shell history is conventionally
      // reachable and where the caret has nowhere left to go.
      const stepped =
        key.name === "up"
          ? promptCaretAtFirstRow(shell.prompt)
            ? stepSentHistoryUp(shell.sentHistory, shell.prompt.value)
            : null
          : promptCaretAtLastRow(shell.prompt)
            ? stepSentHistoryDown(shell.sentHistory, shell.prompt.value, shell.prompt.value.length)
            : null;
      if (stepped !== null) {
        key.preventDefault();
        shell.sentHistory = stepped.browse;
        shell.prompt.value = stepped.value;
        shell.prompt.cursorOffset = stepped.cursor;
        return;
      }
    } else if (!MOTION_KEYS.has(keyName)) {
      shell.sentHistory = sentHistoryOnEdit(shell.sentHistory);
    }

    if (
      ((key.name === "tab" && key.shift) || key.name === "backtab") &&
      !key.ctrl &&
      !key.meta &&
      !key.option
    ) {
      key.preventDefault();
      effortCycleHandlers.get(shell)?.();
      return;
    }

    if (key.name === "tab" && !key.ctrl && !key.meta && !key.option && !key.shift) {
      key.preventDefault();
      toggleShellFocus(shell);
      return;
    }

    // Alt+E, never bare: the prompt almost always holds focus, and a bare
    // `e` would just type a letter into it instead of expanding a row.
    if ((key.meta || key.option) && !key.ctrl && key.name === EXPAND_KEY) {
      if (toggleCollapsedRow(shell)) {
        key.preventDefault();
        return;
      }
    }

    if ((key.meta || key.option) && (key.name === "c" || key.name === "C") && !key.ctrl) {
      // Alt+C: keyboard copy path (no mouse drag-select).
      key.preventDefault();
      enterCopyMode(shell);
      return;
    }

    if ((key.meta || key.option) && (key.name === "m" || key.name === "M") && !key.ctrl) {
      // Alt+M: release mouse reporting so the terminal can drag-select.
      key.preventDefault();
      toggleMouseCapture(shell);
      return;
    }

    if ((key.meta || key.option) && (key.name === "t" || key.name === "T") && !key.ctrl) {
      // Alt+T: the task panel's only entry point now that the palette is gone.
      // Losing the palette must not lose the toggle with it.
      key.preventDefault();
      toggleTasksPanel(shell);
      return;
    }

    if ((key.meta || key.option) && (key.name === "o" || key.name === "O") && !key.ctrl) {
      // Alt+O: observe a live subagent, same rationale as Alt+T — this was
      // the palette's "observe" action and needs a real chord now the
      // palette is gone, not a silently orphaned feature.
      key.preventDefault();
      observeActiveSubagent(shell);
      return;
    }

    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      handleCtrlC(shell);
      return;
    }

    if (key.ctrl && key.name === "g") {
      // Readline/Emacs "abort" chord — unclaimed by both the textarea's
      // default bindings and this shell's other chords, and already means
      // "cancel the pending thing" to muscle memory, unlike Ctrl+X (cut).
      key.preventDefault();
      applyShellCancelLast(shell);
      return;
    }

    if ((key.name === "return" || key.name === "enter") && (key.meta || key.option) && !key.ctrl) {
      // Alt+Enter: follow-up — enqueue kind "queue"; deliver only when the
      // run goes idle. Does not interrupt or reinject. Idle / empty: no-op
      // (nothing to wait for). Soft steer is plain Enter below; reinject is
      // not wired to any product chord.
      key.preventDefault();
      if (shell.session.run !== "busy") return;
      submitPrompt(shell, "queue");
      return;
    }
  };

  const onEnter = (): void => {
    if (disposed || shell.overlayList) return;
    if (internals.get(shell)?.inputSuspended === true) return;
    // Mid-run Enter soft-steers (deliver at next tool.boundary); the bridge
    // upgrades it to an immediate new turn while the parent is idle with a
    // live fleet (idle-with-fleet, CL-7057). Alt+Enter is follow-up (quiet
    // wait until idle). Idle sends ignore "kind".
    submitPrompt(shell, "steer");
  };

  // Per frame rather than per keystroke: the editor view's wrapped-line table is
  // rebuilt during layout, so on the content-changed callback it still describes
  // the text before the edit and the box would size itself one keystroke behind.
  const onFrame = (): void => {
    if (disposed) return;
    syncPromptRows(shell);
    syncPromptHighlights(shell);
    // Applied after a natural render, not at mutation time: a row's own box
    // needs a layout pass to size itself, and claiming the padding first
    // starves that pass of room to lay the row out in.
    syncTranscriptSpacer(shell);
    syncNoticeAfterLayout(shell);
  };

  const onResize = (width: number, height: number): void => {
    if (disposed) return;
    const bag = internals.get(shell);
    // A decision overlay's body was shaped against the old height's context
    // budget; a shorter terminal can no longer afford as much of it without
    // crowding out the choices, so it is re-shaped before asking for rows.
    if (shell.overlayList && isDecisionOverlay(shell.overlayKind) && bag) {
      applyOverlayBodyText(shell, bag.overlayRawBodyText, 0, height);
      relayoutOverlayHost(shell, shell.overlayItems.length);
    }
    relayout(shell, {
      columns: width,
      rows: height,
      overlayMode: bag?.overlayMode ?? "closed",
      ...(bag?.overlayBodyRows !== undefined ? { overlayBodyRows: bag.overlayBodyRows } : {}),
    });
  };

  if (wireKeys) {
    renderer.keyInput.on("keypress", onKey);
    renderer.keyInput.on("paste", onPaste);
    prompt.onSubmit = onEnter;
  }
  renderer.on(CliRenderEvents.FRAME, onFrame);
  renderer.on(CliRenderEvents.RESIZE, onResize);

  // Declared before shell so dispose can off() the same function reference;
  // body closes over shell after createAppShell finishes assigning it.
  const onSelection = (selection: Selection): void => {
    if (disposed) return;
    copyFinishedSelection(
      {
        clipboard: shell.clipboard,
        flash: (text) => setStatusFlash(shell, text, { ttlMs: RUNTIME_FLASH_MS }),
        clearSelection: () => {
          renderer.clearSelection();
        },
      },
      selection,
    );
  };
  renderer.on(CliRenderEvents.SELECTION, onSelection);

  const shell: AppShell = {
    renderer,
    root,
    topPad,
    bottomPad,
    versionRow,
    taskBox,
    agentsBox,
    transcript,
    overlayHost,
    overlayTitle,
    overlayBody,
    prompt,
    promptBox,
    promptField,
    promptTopRule,
    promptBottomRule,
    notice,
    layout,
    focus: createFocusState(),
    session,
    pendingQueue: badgeCount(session),
    lineCount: 0,
    streamLog: [],
    streamLogBase: 0,
    agentVoices: new Set<string>(),
    baseTitle: title,
    modelLabel: null,
    workspace: { cwd: options?.cwd ?? process.cwd(), branch: null },
    overlayList: null,
    overlayItems,
    overlayKind: null,
    overlayBodyLines: [],
    overlayBodyFgs: [],
    paletteCommands: [],
    clipboard: options?.clipboard ?? createRecordingClipboard(),
    mouseCapture: options?.mouseCapture ?? null,
    copyTargets: null,
    statusFlash: null,
    mcpNeedsAuth: [],
    pluginNeedsAttention: false,
    lockupNowMs: 0,
    inFlightTool: null,
    lockupAnimating: false,
    lockupPhase: null,
    lockupChangedMs: 0,
    lockupRampPhase: null,
    lockupStalledForMs: null,
    costContext: null,
    observe: null,
    parentStreamLog: null,
    parentStreamLogBase: null,
    promptKillRing: emptyKillRing,
    pendingAttachments: [],
    sentHistory: createSentHistoryBrowse([]),
    disposed: false,
    dispose: () => {
      if (disposed) return;
      dropDeferredCommandOverlay(shell);
      // Unwind a stacked palette first, then let the primary overlay's owner
      // release subscriptions or settle awaited cancellation exactly once.
      let overlayGuard = 4;
      while (shell.overlayList !== null && overlayGuard-- > 0) closeInsetOverlay(shell);
      abortOverlayHostReservations(shell);
      disposed = true;
      shell.disposed = true;
      if (wireKeys) {
        renderer.keyInput.off("keypress", onKey);
        renderer.keyInput.off("paste", onPaste);
        prompt.onSubmit = undefined;
      }
      renderer.off(CliRenderEvents.FRAME, onFrame);
      renderer.off(CliRenderEvents.RESIZE, onResize);
      renderer.off(CliRenderEvents.SELECTION, onSelection);
      internals.get(shell)?.landingIdleTimerCancel?.();
      flashTimers.get(shell)?.();
      flashTimers.delete(shell);
      try {
        renderer.root.remove(root);
      } catch {
        // Root may already be torn down in tests.
      }
      destroySubtree(root);
    },
  };

  if (options?.flashSchedule) {
    shellFlashSchedules.set(shell, options.flashSchedule);
  }

  internals.set(shell, {
    visibility,
    promptContentRows,
    overlayMode: "closed",
    overlayBodyRows: undefined,
    overlayMinBodyRows: undefined,
    overlayRawBodyText: "",
    priorOverlay: null,
    overlayGeneration: 0,
    overlayItemIds: [],
    overlayItemValues: [],
    overlayOnAccept: null,
    overlayEchoChoice: true,
    overlayOnToggleExpand: null,
    overlayOnCycle: null,
    overlayDescribe: null,
    overlayOnAction: null,
    overlayOnPaste: null,
    overlayAddProviderHint: false,
    overlaySetDefaultHint: false,
    overlayMcpManageHint: false,
    overlayMcpAddHint: false,
    inputSuspended: false,
    overlayAnswer: null,
    overlayTitleText: "",
    overlayOnCancel: null,
    overlayOnDispose: null,
    overlayIsGate: false,
    overlayClosedListeners: new Set(),
    deferredCommandOverlay: null,
    deferredFlushScheduled: false,
    overlayHostReservations: 0,
    overlayReservationEpoch: 0,
    paletteCatalog: paletteCatalogOpt,
    paletteFilter: null,
    listFilter: null,
    landing: { above: landingAbove, below: landingBelow },
    landingNotice: options?.telemetryNotice ?? null,
    landingDeferredRows: [],
    landingBelow: landingBelowState,
    landingSuggestionsVisible: true,
    landingAnimating: false,
    landingNowMs: 0,
    landingIdleTimerCancel: null,
    chrome: { task: [], tasksRaw: [], agents: [] },
    // CL-5847: the manage_tasks checklist panel is hidden by default. The
    // panel owns too much of the screen for the operator to want it forced
    // into view on a fresh shell; Alt+T (toggleTasksPanel) opts in for the
    // shell's lifetime. Live task data still lands in tasksRaw while hidden,
    // so the first toggle shows current data rather than a stale snapshot.
    tasksPanelHidden: true,
  });
  // The landing's snow needs a frame source that keeps running while the
  // turn monitor is deliberately quiet (idle, no session yet). A plain timer
  // armed at mount is that source: it does not depend on the renderer
  // scheduling further frames, so it cannot stall the way riding the
  // renderer's own FRAME event did (see CL-5737 history in the PR).
  //
  // Only repaints while idle (`landingAnimating` false): while a turn is
  // processing, `paintPhaseAt` in runtime-bridge.ts drives the mountain's
  // own draw/fill/fade loop off the turn monitor's clock, and this timer
  // must not stomp that with an unrelated real-clock value.
  //
  // Cleared on whichever teardown happens first: the landing going away
  // (`clearLandingMark`, first transcript row) or the whole shell disposing
  // (`dispose` below, e.g. tests that never grow a transcript).
  //
  // Also self-cancels on `renderer.isDestroyed`: a real terminal session
  // always disposes the shell, but headless test harnesses commonly destroy
  // the renderer directly (`withTestRenderer`'s cleanup) without ever
  // calling `shell.dispose()`. Without this check the timer would keep
  // firing against renderables the harness already tore down.
  const landingIdleHandle = setInterval(() => {
    if (renderer.isDestroyed) {
      clearInterval(landingIdleHandle);
      return;
    }
    const bag = internals.get(shell);
    if (bag?.landing == null || bag.landingAnimating) return;
    paintLanding(shell, Date.now(), false);
  }, LANDING_IDLE_REPAINT_INTERVAL_MS);
  landingIdleHandle.unref?.();
  {
    const bag = internals.get(shell);
    if (bag !== undefined) {
      bag.landingIdleTimerCancel = () => clearInterval(landingIdleHandle);
    } else {
      clearInterval(landingIdleHandle);
    }
  }
  transcriptSpacers.set(shell, transcriptSpacer);
  if (onCommandOpt) setPaletteOnCommand(shell, onCommandOpt);
  if (onObserveRequestOpt) {
    setPaletteOnObserveRequest(shell, onObserveRequestOpt);
  }
  applyLayout(shell, layout);
  // Added after the first layout pass so the scroll box sizes it against the
  // resolved transcript height rather than the pre-layout placeholder.
  transcript.add(landingAbove.box);
  applyFocus(shell);
  return shell;
}
