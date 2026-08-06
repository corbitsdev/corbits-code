/**
 * OpenTUI app shell — sticky transcript, prompt chrome, inset overlay.
 *
 * Wave 3 product skin on the Wave 2 platform. Functional wrappers around
 * @opentui/core class renderables. Not wired to production CLI; Ink remains production.
 */

import { homedir } from "node:os"

import {
  BoxRenderable,
  CliRenderEvents,
  MarkdownRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  TextTableRenderable,
  StyledText,
  bold as boldChunk,
  fg as fgChunk,
  type BaseRenderable,
  type CliRenderer,
  type KeyEvent,
  type TextChunk,
} from "@opentui/core"

import { isExitCommand } from "../tui/exit-command.js"
import {
  composePromptActionBarModelLabel,
  type PromptActionBarModelLabelInput,
} from "../tui/components/prompt-action-bar-label.js"
import { stringWidth } from "../tui/view/height.js"
import { listPathSuggestions } from "../tui/components/at-mention/list.js"
import { parseAtState } from "../tui/components/at-mention/parse.js"
import {
  readClipboardImage,
  type ClipboardImageResult,
  type PendingImageAttachment,
} from "../tui/image-attachments.js"
import {
  createSentHistoryBrowse,
  sentHistoryOnEdit,
  stepSentHistoryDown,
  stepSentHistoryUp,
  type SentHistoryBrowse,
} from "../tui/sent-message-history.js"
import { spliceMentionCompletion } from "./prompt-attachments.js"
import {
  createPromptInput,
  promptCaretAtFirstRow,
  promptCaretAtLastRow,
  promptRowCount,
  type PromptInput,
} from "./prompt-input.js"
import { promptBoxRows } from "./prompt-rows.js"
import { composeNoticeLine } from "./notice-line.js"
import { lockupCells, lockupText, lockupWidth } from "./lockup.js"
import {
  BORDER,
  composeRule,
  composeWorkspaceLabel,
  type RulePart,
} from "./prompt-border.js"
import {
  viewToTableContent,
  type McpStructuredView,
} from "./mcp-view.js"
import {
  createFocusState,
  focusOwner,
  focusPrompt,
  focusTranscript,
  openObserve,
  openOverlay,
  popFocus,
  type FocusState,
} from "./focus/index.js"
import {
  PROMPT_IDLE_ROWS,
  resolveBottomMarginRows,
  resolveGeometry,
  resolveTopPadRows,
  type GeometryLayout,
  type OverlayMode,
  type ZoneVisibility,
} from "./geometry/index.js"
import {
  createLandingAbove,
  createLandingBelow,
  fitLandingMark,
  landingBelowContent,
  landingSuggestionFor,
  paintLandingBelow,
  paintLandingMark,
  resolveMarkGrid,
  splitLandingRows,
  type LandingAbove,
  type LandingBelowContent,
} from "./landing.js"
import {
  createListViewport,
  moveActive,
  page as pageList,
  setHeight as setListHeight,
  visibleSlice,
  type ListViewportState,
} from "./list-viewport.js"
import {
  LONG_LOG_WINDOW,
  collapseMarker,
  mustWindow,
  windowSlice,
} from "./long-log.js"
import {
  DEFAULT_PALETTE_COMMANDS,
  filterPaletteCommands,
  formatPaletteRows,
  isResidualActionId,
  paletteDispatchOf,
  paletteLabels,
  paletteRowColumns,
  type PaletteActionId,
  type PaletteCommand,
} from "./palette.js"
import { shortcutForPaletteId } from "./keybindings.js"
import {
  filterMentionSuggestions,
  splitMentionToken,
} from "./mention-filter.js"
import {
  makeHelpItems,
  makeMentionItems,
  makeObserveFixture,
  makePluginsItems,
  makeResumeItems,
  makeSettingsItems,
  type ObserveSession,
} from "./residuals.js"
import {
  buildCopyTargets,
  createRecordingClipboard,
  streamLogMarkdown,
  type ClipboardPort,
  type CopyTarget,
} from "./copy-path.js"
import {
  badgeCount,
  clearInterruptFlash,
  createSessionQueue,
  enqueue,
  enqueueSteer,
  interrupt,
  setRunState,
  type RunState,
  type SessionQueueState,
} from "./session-queue.js"
import {
  agentVoicesIn,
  blockLabel,
  EXPAND_KEY,
  isCollapsibleRow,
  isDetailRow,
  isMarkdownRow,
  MAIN_AGENT,
  paintStreamRow,
  rowGroupGap,
  streamRowGutter,
  summaryHead,
  transcriptSyntaxStyle,
  type PaintedStreamLine,
  type RowLayout,
  type StreamRow,
  type StyledBodyLine,
} from "./stream.js"
import { UI } from "./theme.js"
import { middleEllipsis } from "./command-display.js"
import {
  composeDecisionBody,
  decisionChoiceRows,
  DECISION_CHOICE_ROWS,
  wrapOverlayText,
} from "./overlay-body.js"
import {
  beginYank,
  breakKillSequence,
  emptyKillRing,
  killedTextBackward,
  killedTextForward,
  recordKill,
  rotateYank,
  type KillRing,
} from "./prompt-kill-ring.js"

const shellExitHandlers = new WeakMap<AppShell, () => void>()

/**
 * Register the host's quit path (the same one Ctrl+D runs) so a bare `exit` /
 * `quit` typed at the prompt tears down through finalize instead of a second,
 * cleanup-skipping exit route.
 */
export function setShellExitHandler(shell: AppShell, onExit: () => void): void {
  shellExitHandlers.set(shell, onExit)
}

export function clearShellExitHandler(shell: AppShell): void {
  shellExitHandlers.delete(shell)
}

/** Optional Wave-4 bridge hooks (runtime-bridge attaches exclusively). */
export type ShellBridgeHooks = {
  onSubmit: (
    text: string,
    kind: "queue" | "steer" | "immediate",
    attachments?: readonly PendingImageAttachment[],
  ) => void
  onInterrupt: () => void
  exclusive: boolean
}

const shellBridgeHooks = new WeakMap<AppShell, ShellBridgeHooks>()

export function setShellBridgeHooks(
  shell: AppShell,
  hooks: ShellBridgeHooks,
): void {
  shellBridgeHooks.set(shell, hooks)
}

export function clearShellBridgeHooks(shell: AppShell): void {
  shellBridgeHooks.delete(shell)
}

export function getShellBridgeHooks(
  shell: AppShell,
): ShellBridgeHooks | undefined {
  return shellBridgeHooks.get(shell)
}

/**
 * Payload delivered when the operator accepts an overlay list selection.
 * Hosts map this into ApprovalOutcome / OperatorResult / model switch.
 */
export type OverlaySelection = {
  readonly kind: PrimaryOverlayKind
  readonly index: number
  readonly label: string
  /** Stable id when the host provided `itemIds`; otherwise omitted. */
  readonly id?: string
}

/**
 * Shell-level overlay accept hooks. Host binds authz / ask_operator / settings.
 * Kind-specific hooks win over `onSelect`. Per-open `onAccept` (on open opts)
 * takes precedence for that open's lifetime.
 */
export type ShellOverlayHooks = {
  readonly onPermission?: (selection: OverlaySelection) => void
  readonly onOperator?: (selection: OverlaySelection) => void
  readonly onModel?: (selection: OverlaySelection) => void
  readonly onSettings?: (selection: OverlaySelection) => void
  readonly onHelp?: (selection: OverlaySelection) => void
  readonly onPlugins?: (selection: OverlaySelection) => void
  readonly onResume?: (selection: OverlaySelection) => void
  readonly onMentions?: (selection: OverlaySelection) => void
  /** Catch-all for non-palette kinds when no kind-specific hook is set. */
  readonly onSelect?: (selection: OverlaySelection) => void
}

const shellOverlayHooks = new WeakMap<AppShell, ShellOverlayHooks>()

export function setShellOverlayHooks(
  shell: AppShell,
  hooks: ShellOverlayHooks,
): void {
  shellOverlayHooks.set(shell, hooks)
}

export function clearShellOverlayHooks(shell: AppShell): void {
  shellOverlayHooks.delete(shell)
}

export function getShellOverlayHooks(
  shell: AppShell,
): ShellOverlayHooks | undefined {
  return shellOverlayHooks.get(shell)
}

/**
 * Injectable handler for registry-backed palette selections (`dispatch: "command"`).
 * Residual openers still go through `runPaletteAction`. Host binds real handlers
 * (slash command run, overlay open, etc.) without the palette importing the registry.
 */
export type PaletteOnCommand = (name: string) => void

const shellPaletteOnCommand = new WeakMap<AppShell, PaletteOnCommand>()

export function setPaletteOnCommand(
  shell: AppShell,
  handler: PaletteOnCommand | undefined,
): void {
  if (handler) shellPaletteOnCommand.set(shell, handler)
  else shellPaletteOnCommand.delete(shell)
}

export function getPaletteOnCommand(
  shell: AppShell,
): PaletteOnCommand | undefined {
  return shellPaletteOnCommand.get(shell)
}

/**
 * Clipboard image reader behind Ctrl+P. Injectable so tests (and non-macOS
 * hosts) can supply their own source instead of shelling out to osascript.
 */
export type PromptImageSource = () => Promise<ClipboardImageResult>

const shellPromptImageSource = new WeakMap<AppShell, PromptImageSource>()

export function setPromptImageSource(
  shell: AppShell,
  source: PromptImageSource | undefined,
): void {
  if (source) shellPromptImageSource.set(shell, source)
  else shellPromptImageSource.delete(shell)
}

/** Filesystem suggestions behind the @-mention overlay. */
export type MentionSuggestionSource = (prefix: string) => Promise<readonly string[]>

const shellMentionSource = new WeakMap<AppShell, MentionSuggestionSource>()

export function setMentionSuggestionSource(
  shell: AppShell,
  source: MentionSuggestionSource | undefined,
): void {
  if (source) shellMentionSource.set(shell, source)
  else shellMentionSource.delete(shell)
}

/**
 * Injectable handler for the palette "observe" action. Host resolves a live
 * `ObserveSession` (or `null` when no subagent is running). Demo/smoke keep
 * using `makeObserveFixture()` by leaving this unset.
 */
export type PaletteOnObserveRequest = () => ObserveSession | null

const shellPaletteOnObserveRequest = new WeakMap<
  AppShell,
  PaletteOnObserveRequest
>()

export function setPaletteOnObserveRequest(
  shell: AppShell,
  handler: PaletteOnObserveRequest | undefined,
): void {
  if (handler) shellPaletteOnObserveRequest.set(shell, handler)
  else shellPaletteOnObserveRequest.delete(shell)
}

export function getPaletteOnObserveRequest(
  shell: AppShell,
): PaletteOnObserveRequest | undefined {
  return shellPaletteOnObserveRequest.get(shell)
}

/** Dispatch accept to per-open callback, then shell-level kind hooks. */
function dispatchOverlayAccept(
  shell: AppShell,
  selection: OverlaySelection,
  perOpen: ((selection: OverlaySelection) => void) | null,
): void {
  if (perOpen) {
    perOpen(selection)
    return
  }
  const hooks = getShellOverlayHooks(shell)
  if (!hooks) return
  switch (selection.kind) {
    case "permissions":
      if (hooks.onPermission) {
        hooks.onPermission(selection)
        return
      }
      break
    case "operator":
      if (hooks.onOperator) {
        hooks.onOperator(selection)
        return
      }
      break
    case "model_picker":
      if (hooks.onModel) {
        hooks.onModel(selection)
        return
      }
      break
    case "settings":
      if (hooks.onSettings) {
        hooks.onSettings(selection)
        return
      }
      break
    case "help":
      if (hooks.onHelp) {
        hooks.onHelp(selection)
        return
      }
      break
    case "plugins":
      if (hooks.onPlugins) {
        hooks.onPlugins(selection)
        return
      }
      break
    case "resume":
      if (hooks.onResume) {
        hooks.onResume(selection)
        return
      }
      break
    case "mentions":
      if (hooks.onMentions) {
        hooks.onMentions(selection)
        return
      }
      break
    default:
      break
  }
  hooks.onSelect?.(selection)
}

/** Renderer surface required by the shell (CliRenderer / createTestRenderer). */
export type ShellRenderer = Pick<
  CliRenderer,
  "root" | "width" | "height" | "keyInput" | "on" | "off"
>

export type AppShellOptions = {
  /** Session name. Default "corbits". Not painted as chrome. */
  readonly title?: string
  /** Working directory carried by the prompt box's bottom border. */
  readonly cwd?: string
  /** Zone visibility overrides for resolveGeometry. Optional strips off by default. */
  readonly visibility?: ZoneVisibility
  /** Requested prompt content rows (geometry caps at 40%). Default 3. */
  readonly promptContentRows?: number
  /** Pending queue count seed. Default 0. */
  readonly pendingQueue?: number
  /** Wire Tab + product keys (Enter/Alt+Enter/Ctrl+C/Esc/overlay). Default true. */
  readonly wireKeys?: boolean
  /** Mount shell.root on renderer.root. Default true. */
  readonly mount?: boolean
  /** Initial terminal size override (tests). Defaults to renderer.width/height. */
  readonly terminal?: { readonly columns: number; readonly rows: number }
  /** Simulated agent run state. Default "busy" (queue-default mid-run). */
  readonly run?: RunState
  /** Overlay list labels for inset demo. */
  readonly overlayItems?: readonly string[]
  /**
   * Default palette catalog when `openPalette` is called without `catalog`.
   * Host typically passes `buildPaletteCatalog({ commands: listCommands() })`.
   * Static array or lazy builder. Defaults to residual openers only.
   */
  readonly paletteCatalog?:
    | readonly PaletteCommand[]
    | (() => readonly PaletteCommand[])
  /**
   * Invoked when a registry-backed palette item is accepted (`dispatch: "command"`).
   * Residual openers never hit this path.
   */
  readonly onCommand?: PaletteOnCommand
  /**
   * Invoked when the palette "observe" action runs. Returns the live
   * `ObserveSession` to enter, or `null` when no subagent is running.
   * Unset (demo/smoke) falls back to `makeObserveFixture()`.
   */
  readonly onObserveRequest?: PaletteOnObserveRequest
  /**
   * First-run telemetry disclosure for the landing screen. Omitted once the
   * notice has been shown, so it is not permanent chrome.
   */
  readonly telemetryNotice?: string
}

export type AppShell = {
  readonly renderer: ShellRenderer
  readonly root: BoxRenderable
  /** Blank rows above the first transcript row (0 on short terminals). */
  readonly topPad: BoxRenderable
  /** Blank row below the prompt box (0 on short terminals). */
  readonly bottomPad: BoxRenderable
  /** Optional chrome zones (constitution goal/task/agents). */
  readonly goalBox: BoxRenderable
  readonly goalText: TextRenderable
  readonly taskBox: BoxRenderable
  readonly taskText: TextRenderable
  readonly agentsBox: BoxRenderable
  readonly agentsText: TextRenderable
  readonly transcript: ScrollBoxRenderable
  readonly overlayHost: BoxRenderable
  readonly overlayTitle: TextRenderable
  readonly overlayBody: BoxRenderable
  readonly prompt: PromptInput
  readonly promptBox: BoxRenderable
  /** The input's own row, bordered left and right only. */
  readonly promptField: BoxRenderable
  /** Top border of the prompt box — carries the model label. */
  readonly promptTopRule: TextRenderable
  /** Bottom border — carries the brand lockup and the workspace label. */
  readonly promptBottomRule: TextRenderable
  /** Transient state row above the prompt box (hidden when it has nothing to say). */
  readonly notice: TextRenderable
  /** Latest geometry resolution (updated on resize / relayout). */
  layout: GeometryLayout
  /** Focus tree + scroll lease (updated by shell helpers). */
  focus: FocusState
  /** Session queue / steer / interrupt bag. */
  session: SessionQueueState
  /** Pending queue count (mirrors badgeCount(session)). */
  pendingQueue: number
  /** Transcript line count (append counter / full log length). */
  lineCount: number
  /** Full stream log (windowed paint; never unbounded render tree). */
  streamLog: StreamRow[]
  /**
   * Distinct writers in the visible transcript. Rows carry a name and icon only
   * once this holds more than one, so identity appears where it disambiguates.
   */
  agentVoices: Set<string>
  /**
   * Session name. Held for hosts that rename a session; it is not chrome —
   * an unnamed session shows nothing rather than a placeholder.
   */
  baseTitle: string
  /** Composed `profile · model · effort` label carried by the top border. */
  modelLabel: string | null
  /** Working directory and git branch carried by the bottom border. */
  workspace: { cwd: string; branch: string | null }
  /** Overlay list viewport (null when closed). */
  overlayList: ListViewportState | null
  /** Overlay item labels currently shown. */
  overlayItems: readonly string[]
  /** Which primary overlay is open (null when closed). */
  overlayKind: PrimaryOverlayKind | null
  /** Optional long body lines painted above the list (operator question). */
  overlayBodyLines: readonly string[]
  /** Palette role per body line, aligned with overlayBodyLines. */
  overlayBodyFgs: readonly string[]
  /** Palette command ids aligned with overlayItems when kind is palette. */
  paletteCommands: readonly PaletteCommand[]
  /** Clipboard port for keyboard copy (tests inject recording port). */
  clipboard: ClipboardPort
  /**
   * Frozen copy targets while the copy overlay is open (null when closed).
   * Confirm writes from this snapshot, not live streamLog.
   */
  copyTargets: readonly CopyTarget[] | null
  /**
   * Short transient flash (copy feedback, etc.). Cleared when replaced or
   * set to null; never appended to the stream log.
   */
  statusFlash: string | null
  /**
   * Live turn phase ("Thinking…", "Running tool…", …) or null when idle.
   * Lives on the transient notice row rather than a chrome zone because the product host
   * owns the goal/task/agents zones and overwrites them wholesale on every
   * snapshot push, which would clobber a per-token progress line.
   */
  turnPhase: string | null
  /**
   * Clock, motion and content state for the bottom-left status slot. The bridge
   * pushes all of it off its existing monitor tick (`setLockupFrame`); the
   * shell never reads a clock of its own, so a shell without a bridge simply
   * paints the settled idle slot.
   */
  lockupNowMs: number
  lockupAnimating: boolean
  /** Live phase word the slot shows, or null for the idle wordmark. */
  lockupPhase: string | null
  /** Clock reading when `lockupPhase` last changed — the fade's origin. */
  lockupChangedMs: number
  /**
   * Active subagent observe session (null when viewing parent).
   * Independent stream window; Esc restores parent lease.
   */
  observe: {
    sessionId: string
    agentId: string
    description: string
    lines: StreamRow[]
  } | null
  /** Parent stream snapshot while observe is active. */
  parentStreamLog: StreamRow[] | null
  /**
   * Readline kill ring backing Ctrl+Y/Alt+Y. Ctrl+K/U/W and Alt+D feed it;
   * the text widget itself has no concept of a kill ring (see
   * ./prompt-kill-ring.js).
   */
  promptKillRing: KillRing
  /** Images attached with Ctrl+P, sent with the next prompt submit. */
  pendingAttachments: PendingImageAttachment[]
  /** Up/Down recall of messages already sent in this session. */
  sentHistory: SentHistoryBrowse
  /** Detach key/resize listeners and unmount root. */
  dispose: () => void
}

export type PrimaryOverlayKind =
  | "permissions"
  | "operator"
  | "model_picker"
  | "demo"
  | "palette"
  | "settings"
  | "help"
  | "plugins"
  | "resume"
  | "mentions"
  | "copy"

const DEFAULT_TITLE = "corbits"
const DEFAULT_OVERLAY_ITEMS = [
  "Allow bash: ls",
  "Allow bash: cat README",
  "Deny this tool",
  "Always allow bash",
] as const

function terminalOf(
  renderer: ShellRenderer,
  override?: { readonly columns: number; readonly rows: number },
): { columns: number; rows: number } {
  if (override) {
    return {
      columns: Math.max(1, Math.floor(override.columns)),
      rows: Math.max(1, Math.floor(override.rows)),
    }
  }
  return {
    columns: Math.max(1, Math.floor(renderer.width || 80)),
    rows: Math.max(1, Math.floor(renderer.height || 24)),
  }
}

function defaultVisibility(visibility?: ZoneVisibility): ZoneVisibility {
  return {
    notice: false,
    progress: false,
    progressDivider: false,
    ...visibility,
  }
}

/** Whether the transcript viewport is stuck to the bottom (FOLLOW vs PINNED). */
export function isTranscriptFollowing(shell: AppShell): boolean {
  const { transcript } = shell
  const max = Math.max(0, transcript.scrollHeight - transcript.height)
  return transcript.scrollTop >= max - 1
}

/** Sticky-scroll mode label (surfaced on the notice row only when PINNED). */
export function stickyMode(shell: AppShell): "FOLLOW" | "PINNED" {
  return isTranscriptFollowing(shell) ? "FOLLOW" : "PINNED"
}

function syncPending(shell: AppShell): void {
  shell.pendingQueue = badgeCount(shell.session)
}

/** The transient row's text for the current state ("" when it has nothing to say). */
export function noticeText(shell: AppShell): string {
  return composeNoticeLine({
    queue: shell.pendingQueue,
    interrupt: shell.session.interruptFlash,
    pinned: !isTranscriptFollowing(shell),
    phase: shell.turnPhase,
    flash: shell.statusFlash,
    attachments: shell.pendingAttachments.length,
  })
}

/** Repaint the prompt borders and the transient notice row from live state. */
export function paintChrome(shell: AppShell): void {
  syncPending(shell)
  const notice = noticeText(shell)
  shell.notice.content = new StyledText([
    fgChunk(UI.textDim)(notice.length > 0 ? ` ${notice}` : ""),
  ])
  paintPromptBorder(shell)
  syncLandingSuggestions(shell)
  syncNoticeRow(shell, notice)
}

/**
 * Give the notice row a row only while it has something to say, and take it
 * back the moment it does not. The relayout re-enters paintChrome, which then
 * finds the visibility already correct and stops.
 */
function syncNoticeRow(shell: AppShell, notice: string): void {
  const bag = internals.get(shell)
  if (bag === undefined) return
  const wanted = notice.length > 0
  if ((bag.visibility.notice ?? false) === wanted) return
  relayout(shell, { visibility: { ...bag.visibility, notice: wanted } })
}

/** Withdraw or restore the landing starters as the prompt fills and empties. */
function syncLandingSuggestions(shell: AppShell): void {
  const bag = internals.get(shell)
  if (!bag) return
  const landing = bag.landing
  const content = bag.landingBelow
  if (landing === null || content === null) return
  const visible = shell.prompt.value.length === 0
  if (visible === bag.landingSuggestionsVisible) return
  bag.landingSuggestionsVisible = visible
  paintLandingBelow(landing.below, content, visible)
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
export function setLockupFrame(
  shell: AppShell,
  nowMs: number,
  animating: boolean,
  phase: string | null = null,
): void {
  const settled = !animating && !shell.lockupAnimating
  shell.lockupNowMs = nowMs
  const changed = phase !== shell.lockupPhase
  if (changed) {
    shell.lockupPhase = phase
    shell.lockupChangedMs = nowMs
  }
  if (settled && !changed && shell.lockupAnimating === animating) return
  shell.lockupAnimating = animating
  paintChrome(shell)
}

/** Queue an image for the next submit and reflect it on the notice row. */
export function addPendingAttachment(
  shell: AppShell,
  attachment: PendingImageAttachment,
): void {
  shell.pendingAttachments = [...shell.pendingAttachments, attachment]
  paintChrome(shell)
}

export function clearPendingAttachments(shell: AppShell): void {
  shell.pendingAttachments = []
  paintChrome(shell)
}

/**
 * Ctrl+P: read an image off the clipboard into the pending set.
 * Resolves false (with a status flash) when nothing was attached.
 */
export async function attachClipboardImage(shell: AppShell): Promise<boolean> {
  const source = shellPromptImageSource.get(shell) ?? readClipboardImage
  setStatusFlash(shell, "reading clipboard image…")
  const result = await source()
  if (!result.ok) {
    setStatusFlash(shell, `image attach failed: ${result.reason}`)
    return false
  }
  addPendingAttachment(shell, result.attachment)
  setStatusFlash(shell, `attached ${result.attachment.name}`)
  return true
}

/** Seed the Up/Down recall list (host replays persisted session messages). */
export function setSentMessageHistory(
  shell: AppShell,
  sent: readonly string[],
): void {
  shell.sentHistory = createSentHistoryBrowse(sent)
}

function recordSentMessage(shell: AppShell, text: string): void {
  shell.sentHistory = createSentHistoryBrowse([...shell.sentHistory.sent, text])
}

/** Set a non-destructive flash and repaint (does not touch streamLog). */
export function setStatusFlash(shell: AppShell, message: string | null): void {
  shell.statusFlash = message
  paintChrome(shell)
}

/** Set the live turn phase label (null hides it). Repaints only on change. */
export function setTurnPhase(shell: AppShell, phase: string | null): void {
  if (shell.turnPhase === phase) return
  shell.turnPhase = phase
  paintChrome(shell)
}

/** Apply focus state to OpenTUI focusables. */
export function applyFocus(shell: AppShell): void {
  const owner = focusOwner(shell.focus)
  if (owner === "overlay" || owner === "palette") {
    if (typeof shell.prompt.blur === "function") {
      shell.prompt.blur()
    }
  } else if (owner === "transcript") {
    shell.transcript.focus()
  } else {
    shell.prompt.focus()
  }
  paintChrome(shell)
}

export function shellFocusPrompt(shell: AppShell): void {
  shell.focus = focusPrompt(shell.focus)
  applyFocus(shell)
}

export function shellFocusTranscript(shell: AppShell): void {
  shell.focus = focusTranscript(shell.focus)
  applyFocus(shell)
}

export function toggleShellFocus(shell: AppShell): void {
  const owner = focusOwner(shell.focus)
  if (owner === "overlay" || owner === "palette") return
  if (owner === "transcript") {
    shellFocusPrompt(shell)
  } else {
    shellFocusTranscript(shell)
  }
}

function clearOverlayBody(shell: AppShell): void {
  const body = shell.overlayBody
  const kids = [...body.getChildren()]
  for (const child of kids) {
    body.remove(child)
    child.destroy()
  }
}

/**
 * Rows the overlay host spends on itself before any list row: the bordered box
 * costs a top and bottom rule, plus the title line and the wrapped body lines.
 * Omitting the border here hands the list two rows the host cannot render, and
 * flex then stacks the surplus rows onto cells the prompt border already owns.
 */
const OVERLAY_HOST_BORDER_ROWS = 2

function overlayChromeRows(bodyLineCount: number): number {
  return OVERLAY_HOST_BORDER_ROWS + 1 + bodyLineCount
}

/**
 * Stacking order for the floated overlay host. Only the landing composition
 * sits under it, and that has no z-index of its own, so one step is enough.
 */
const OVERLAY_FLOAT_Z = 10

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
function floatOverlayHost(
  shell: AppShell,
  floating: boolean,
  top: number,
): void {
  const host = shell.overlayHost
  if (!floating) {
    host.position = "relative"
    host.zIndex = 0
    return
  }
  host.position = "absolute"
  host.left = 0
  host.right = 0
  host.top = top
  host.zIndex = OVERLAY_FLOAT_Z
}


/** Total host rows needed to show `listRows` list rows under `bodyLineCount` body lines. */
function overlayHostRows(bodyLineCount: number, listRows: number): number {
  return overlayChromeRows(bodyLineCount) + listRows
}

function addOverlayRow(
  shell: AppShell,
  content: string,
  fg: string,
  bg?: string,
): void {
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
  )
}

/**
 * Overlays that ask a human to authorize something. They get the shaped,
 * spaced treatment from overlay-body.ts; every other list overlay stays a
 * plain one-row-per-item list.
 */
function isDecisionOverlay(kind: PrimaryOverlayKind | null): boolean {
  return kind === "permissions" || kind === "operator"
}

/** Display rows one list item occupies for the open overlay kind. */
function overlayRowsPerItem(kind: PrimaryOverlayKind | null): number {
  return isDecisionOverlay(kind) ? DECISION_CHOICE_ROWS : 1
}

/** Columns a body/choice row may paint into, inside border and leading space. */
function overlayRowWidth(shell: AppShell): number {
  return Math.max(8, Math.max(20, shell.layout.contentWidth) - 4)
}

/**
 * Title row for the overlay host, fitted to the box interior. The title
 * renderable is one row in the host's chrome budget, so a line that wrapped at
 * a narrow width would spend a row nothing accounted for.
 */
function overlayTitleLine(title: string, interior: number): string {
  const keys = [" · Esc cancel · Enter choose", " · Esc · Enter", ""]
  for (const suffix of keys) {
    const line = ` ${title}${suffix}`
    if (line.length <= interior) return line
  }
  return ` ${middleEllipsis(title, Math.max(1, interior - 1))}`
}

/** Interior columns of the overlay box, inside its border. */
function overlayInteriorWidth(shell: AppShell): number {
  return overlayRowWidth(shell) + 2
}

/** Columns before the label column: leading space, selection marker, space. */
const PALETTE_MARKER_WIDTH = 3

/**
 * Palette rows are three columns wide, and the active one is a full-width band
 * rather than a recolored marker. The band is the warm faint tone, not the
 * action orange: a palette selection is a cursor position, not a decision the
 * shell is waiting on.
 */
function paintPaletteList(shell: AppShell, list: ListViewportState): void {
  const interior = overlayInteriorWidth(shell)
  const columns = shell.paletteCommands.map((cmd) =>
    paletteRowColumns(cmd, shortcutForPaletteId),
  )
  const lines = formatPaletteRows(
    columns,
    Math.max(4, interior - PALETTE_MARKER_WIDTH),
  )
  const slice = visibleSlice(list)
  for (let i = slice.start; i < slice.end; i++) {
    const line = lines[i] ?? ""
    const active = i === list.activeIndex
    const content = ` ${active ? ">" : " "} ${line}`.padEnd(interior)
    if (active) {
      addOverlayRow(shell, content, UI.text, UI.textFaint)
    } else {
      addOverlayRow(shell, content, UI.textDim)
    }
  }
}

function paintOverlayList(shell: AppShell): void {
  const list = shell.overlayList
  clearOverlayBody(shell)
  if (!list) return

  shell.overlayBodyLines.forEach((line, i) => {
    addOverlayRow(shell, ` ${line}`, shell.overlayBodyFgs[i] ?? UI.text)
  })

  if (shell.overlayKind === "palette" && shell.paletteCommands.length > 0) {
    paintPaletteList(shell, list)
    return
  }

  const decision = isDecisionOverlay(shell.overlayKind)
  const width = overlayRowWidth(shell)
  const slice = visibleSlice(list)
  for (let i = slice.start; i < slice.end; i++) {
    const label = shell.overlayItems[i] ?? `item ${i}`
    const active = i === list.activeIndex
    if (!decision) {
      addOverlayRow(
        shell,
        ` ${active ? ">" : " "} ${label}`,
        active ? UI.text : UI.textDim,
      )
      continue
    }
    for (const row of decisionChoiceRows(label, active, width)) {
      addOverlayRow(shell, ` ${row.text}`, row.fg)
    }
  }
}

/**
 * Colour a composed rule. The frame stays faint so the labels it carries read
 * as the brighter thing on the row; the brand run is swapped for the lockup's
 * own cells, which is the only part of the border that animates.
 */
function ruleChunks(shell: AppShell, parts: readonly RulePart[]): TextChunk[] {
  const chunks: TextChunk[] = []
  for (const part of parts) {
    if (part.role !== "brand") {
      chunks.push(
        fgChunk(part.role === "label" ? UI.textDim : UI.textFaint)(part.text),
      )
      continue
    }
    const cells = lockupCells(lockupFrameInput(shell))
    chunks.push(fgChunk(UI.textFaint)(" "))
    for (const cell of cells) chunks.push(fgChunk(cell.fg)(cell.char))
    chunks.push(fgChunk(UI.textFaint)(" "))
  }
  return chunks
}

/** The status slot's state, as the lockup renderer wants it. */
function lockupFrameInput(shell: AppShell) {
  return {
    nowMs: shell.lockupNowMs,
    still: !shell.lockupAnimating,
    phase: shell.lockupPhase,
    changedMs: shell.lockupChangedMs,
  }
}

/**
 * Repaint both border rules. Recomposed on every pass rather than cached: a
 * resize changes the column budget without changing any label, and the lockup
 * changes every animation frame without changing the geometry.
 */
export function paintPromptBorder(shell: AppShell): void {
  const width = shell.layout.contentWidth
  const top = composeRule({
    width,
    corners: [BORDER.topLeft, BORDER.topRight],
    ...(shell.modelLabel !== null ? { label: shell.modelLabel } : {}),
  })
  shell.promptTopRule.content = new StyledText(ruleChunks(shell, top))

  // Corners, both rule margins, the gap and the spaces around each label are
  // what the workspace has to fit inside — with the lockup if the rule can
  // seat both, without it if it cannot. Where the row can only afford one, the
  // information wins and the mark goes.
  const withBrand = Math.max(0, width - 9 - lockupWidth(shell.lockupPhase))
  const alone = Math.max(0, width - 6)
  const workspaceInput = {
    cwd: shell.workspace.cwd,
    branch: shell.workspace.branch,
    home: homedir(),
  }
  // A workspace that has lost its path is a branch floating with no context,
  // which is worth less than the mark it displaced. So the mark yields not just
  // when the label cannot fit at all, but when keeping it would starve the path.
  const roomyRaw = composeWorkspaceLabel({ ...workspaceInput, maxWidth: withBrand })
  const roomy = roomyRaw.startsWith("(") ? "" : roomyRaw
  const workspace =
    roomy.length > 0
      ? roomy
      : composeWorkspaceLabel({ ...workspaceInput, maxWidth: alone })
  const brand = lockupText(lockupCells(lockupFrameInput(shell)))
  const bottom = composeRule({
    width,
    corners: [BORDER.bottomLeft, BORDER.bottomRight],
    ...(roomy.length > 0 || workspace.length === 0 ? { brand } : {}),
    ...(workspace.length > 0 ? { label: workspace } : {}),
  })
  shell.promptBottomRule.content = new StyledText(ruleChunks(shell, bottom))
}

/** Publish the `profile · model · effort` label carried by the top border. */
export function setPromptModelLabel(
  shell: AppShell,
  input: PromptActionBarModelLabelInput,
): void {
  const label = composePromptActionBarModelLabel(input) ?? null
  if (label === shell.modelLabel) return
  shell.modelLabel = label
  paintPromptBorder(shell)
}

/** Publish the working directory and git branch carried by the bottom border. */
export function setPromptWorkspace(
  shell: AppShell,
  input: { readonly cwd?: string; readonly branch?: string | null },
): void {
  const cwd = input.cwd ?? shell.workspace.cwd
  const branch = input.branch === undefined ? shell.workspace.branch : input.branch
  if (cwd === shell.workspace.cwd && branch === shell.workspace.branch) return
  shell.workspace = { cwd, branch }
  paintPromptBorder(shell)
}

/**
 * How the landing divides its rows around the prompt box.
 *
 * A floated overlay is clipped to the rows above the box so it never covers the
 * thing the operator types into. Losing the tail of a long body to that clip is
 * survivable; losing every choice is not, because then the surface cannot be
 * answered. So the box slides down just far enough to keep the overlay's chrome
 * and one choice on screen, and the starters below it pay for the move.
 */
function landingSplitFor(
  landingRows: number,
  minOverlayRows: number,
  padRows: number,
): { readonly above: number; readonly below: number } {
  const even = splitLandingRows(landingRows)
  const needed = Math.min(landingRows, minOverlayRows - padRows)
  if (minOverlayRows <= 0 || even.above >= needed) return even
  return { above: needed, below: Math.max(0, landingRows - needed) }
}

export function applyLayout(shell: AppShell, layout: GeometryLayout): void {
  // Rows lay themselves out against the column budget (right-aligned bubbles,
  // pre-wrapped reasoning blocks), so a width change invalidates every painted
  // row rather than just reflowing it.
  const widthChanged = shell.layout.contentWidth !== layout.contentWidth
  shell.layout = layout
  const h = layout.heights

  shell.root.paddingLeft = layout.sideMargin
  shell.root.paddingRight = layout.sideMargin

  const goalH = Math.max(0, h.goal)
  shell.goalBox.height = goalH > 0 ? goalH : 1
  shell.goalBox.visible = goalH > 0

  const taskH = Math.max(0, h.task)
  shell.taskBox.height = taskH > 0 ? taskH : 1
  shell.taskBox.visible = taskH > 0

  const agentsH = Math.max(0, h.agents)
  shell.agentsBox.height = agentsH > 0 ? agentsH : 1
  shell.agentsBox.visible = agentsH > 0

  // Both pads are taken out of the transcript residual, never out of chrome,
  // so the resolver's row budget still sums to the terminal height.
  const transcriptH = Math.max(0, h.transcript)
  const padH = resolveTopPadRows(transcriptH)
  shell.topPad.height = padH > 0 ? padH : 1
  shell.topPad.visible = padH > 0

  const bottomPadH = resolveBottomMarginRows(layout.terminal.rows)
  shell.bottomPad.height = bottomPadH > 0 ? bottomPadH : 1
  shell.bottomPad.visible = bottomPadH > 0

  const overlayH = Math.max(0, h.overlay_host)

  // The landing splits the transcript residual around the prompt box so the box
  // sits on the terminal's middle row instead of at its foot. An open overlay
  // floats over that composition rather than displacing it, so the rows the
  // resolver took for the overlay host are handed back to the split.
  const bag = internals.get(shell)
  const landing = bag?.landing ?? null
  const landingRows = transcriptH - padH - bottomPadH + (landing === null ? 0 : overlayH)
  const split =
    landing === null
      ? null
      : landingSplitFor(
          landingRows,
          overlayH > 0 ? overlayHostRows(shell.overlayBodyLines.length, 1) : 0,
          padH,
        )
  if (bag !== undefined && landing !== null && split !== null) {
    landing.above.box.height = Math.max(1, split.above)
    // A new zone can seat a different tier, and a tier is a different grid, so
    // the mark is redrawn rather than left showing the previous size's frame.
    fitLandingMark(
      landing.above,
      resolveMarkGrid(split.above, layout.contentWidth),
    )
    paintLandingMark(landing.above, bag.landingNowMs, !bag.landingAnimating)
    landing.below.height = Math.max(0, split.below)
    landing.below.visible = split.below > 0
  }

  const transcriptBody =
    split === null ? transcriptH - padH - bottomPadH : Math.max(1, split.above)
  shell.transcript.height = transcriptBody > 0 ? transcriptBody : 1
  shell.transcript.visible = transcriptBody > 0

  const noticeH = Math.max(0, h.notice)
  shell.notice.height = noticeH > 0 ? noticeH : 1
  shell.notice.visible = noticeH > 0

  const promptH = Math.max(1, h.prompt)
  shell.promptBox.height = promptH
  shell.promptBox.visible = promptH > 0
  // The field takes whatever the box has left once both labelled rules are paid.
  const promptInnerH = Math.max(1, promptH - 2)
  shell.promptField.height = promptInnerH
  // Sized explicitly rather than left to grow with its content: past the cap the
  // input has to scroll inside a fixed window instead of pushing the frame open.
  shell.prompt.height = promptInnerH

  // Sized last: the float is anchored against chrome sized earlier in this
  // pass. Modal over the landing, an in-flow band once there is a transcript
  // to push.
  const floating = landing !== null && overlayH > 0
  // Rows the flow spends before the prompt box — where a floated host's bottom
  // edge has to land, since the landing's box sits mid-screen rather than at
  // the foot and covering it would hide the thing the operator types into.
  const promptTop = padH + goalH + taskH + agentsH + transcriptBody
  const hostH = floating ? Math.min(overlayH, Math.max(1, promptTop)) : overlayH
  floatOverlayHost(shell, floating, Math.max(0, promptTop - hostH))
  shell.overlayHost.height = hostH > 0 ? hostH : 1
  shell.overlayHost.visible = hostH > 0
  if (hostH > 0 && shell.overlayList) {
    const chrome = overlayChromeRows(shell.overlayBodyLines.length)
    const bodyH = Math.max(1, hostH - chrome)
    // The viewport counts items, not rows; a decision overlay spends several
    // rows per item, so the row budget has to be divided back down.
    const perItem = overlayRowsPerItem(shell.overlayKind)
    shell.overlayList = setListHeight(
      shell.overlayList,
      Math.max(1, Math.floor(bodyH / perItem)),
    )
    paintOverlayList(shell)
  }

  paintPromptBorder(shell)

  // The landing owns the transcript's children until the first row lands, so a
  // resize there must not rebuild them out from under it.
  if (widthChanged && shell.streamLog.length > 0 && !isLanding(shell)) {
    repaintTranscriptWindow(shell)
  }

  paintChrome(shell)
}

/**
 * Re-size the prompt box for what is now in it. Cheap enough to run on every
 * content change: it re-resolves geometry only when the row count actually
 * moves, which is once per wrapped line gained or lost.
 */
export function syncPromptRows(shell: AppShell): void {
  const rows = promptBoxRows(promptRowCount(shell.prompt), shell.renderer.height)
  if (rows === shell.layout.heights.prompt) return
  relayout(shell, { promptContentRows: rows })
}

export type RelayoutOpts = {
  readonly columns?: number
  readonly rows?: number
  readonly visibility?: ZoneVisibility
  readonly promptContentRows?: number
  readonly overlayMode?: OverlayMode
  readonly overlayBodyRows?: number
}

type PriorOverlaySnapshot = {
  readonly kind: PrimaryOverlayKind | null
  readonly items: readonly string[]
  readonly bodyLines: readonly string[]
  readonly bodyFgs: readonly string[]
  readonly list: ListViewportState
  readonly title: string
  readonly paletteCommands: readonly PaletteCommand[]
  readonly itemIds: readonly string[]
  readonly onAccept: ((selection: OverlaySelection) => void) | null
  readonly onToggleExpand: (() => void) | null
}

type ShellInternals = {
  visibility: ZoneVisibility
  promptContentRows: number | undefined
  overlayMode: OverlayMode
  overlayBodyRows: number | undefined
  /** Snapshot when palette stacks over another primary overlay. */
  priorOverlay: PriorOverlaySnapshot | null
  /** Optional stable ids aligned with overlayItems for the open primary. */
  overlayItemIds: readonly string[]
  /** Per-open accept callback; cleared on close without invoke (Esc path). */
  overlayOnAccept: ((selection: OverlaySelection) => void) | null
  /** Per-open expand/collapse hook for the open primary overlay. */
  overlayOnToggleExpand: (() => void) | null
  /**
   * Default palette catalog (static or lazy). Used when openPalette omits catalog.
   * Residual DEFAULT_PALETTE_COMMANDS when unset.
   */
  paletteCatalog:
    | readonly PaletteCommand[]
    | (() => readonly PaletteCommand[])
    | null
  /** Live filter state for the open palette, so typing can re-filter it. */
  paletteFilter: PaletteFilterState | null
  /**
   * Landing composition shown while the transcript has no content: the mark
   * above the prompt box, the disclosure and starters below it. Dropped (not
   * hidden) on the first row so it never occupies a transcript line later.
   */
  landing: { readonly above: LandingAbove; readonly below: BoxRenderable } | null
  /**
   * The disclosure the landing is showing. Re-appended to the transcript when
   * the landing tears down so consent-by-proceeding leaves a durable record
   * rather than a screen the first prompt wipes.
   */
  landingNotice: string | null
  /** What the rows below the box are painting, so they can be repainted. */
  landingBelow: LandingBelowContent | null
  /** Starters are offered only while the prompt is empty. */
  landingSuggestionsVisible: boolean
  /** Whether the last painted mark frame was a moving one. */
  landingAnimating: boolean
  /** Clock of the last painted mark frame, so a resize can redraw in place. */
  landingNowMs: number
  /** Chrome text content (empty = zone off). */
  chrome: {
    goal: string
    task: string
    agents: string
  }
}

const internals = new WeakMap<AppShell, ShellInternals>()

export function relayout(shell: AppShell, opts?: RelayoutOpts): GeometryLayout {
  const bag = internals.get(shell)
  const visibility = opts?.visibility ?? bag?.visibility ?? defaultVisibility()
  const promptContentRows = opts?.promptContentRows ?? bag?.promptContentRows
  const overlayMode = opts?.overlayMode ?? bag?.overlayMode ?? "closed"
  const overlayBodyRows = opts?.overlayBodyRows ?? bag?.overlayBodyRows
  if (bag) {
    bag.visibility = visibility
    bag.promptContentRows = promptContentRows
    bag.overlayMode = overlayMode
    bag.overlayBodyRows = overlayBodyRows
  }

  const columns = opts?.columns ?? shell.renderer.width
  const rows = opts?.rows ?? shell.renderer.height
  const layout = resolveGeometry({
    terminal: terminalOf(shell.renderer, { columns, rows }),
    visibility,
    overlay:
      overlayMode === "closed"
        ? { mode: "closed" }
        : {
            mode: overlayMode,
            ...(overlayBodyRows !== undefined
              ? { bodyRows: overlayBodyRows }
              : {}),
          },
    ...(promptContentRows !== undefined ? { promptContentRows } : {}),
    // The landing owns the screen until the first transcript row lands, so
    // holding rows back for a transcript that does not exist would only clip
    // whatever the operator opened over it.
    ...(isLanding(shell) ? { transcriptFloor: 0 } : {}),
  })
  applyLayout(shell, layout)
  return layout
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
  clearLandingMark(shell)
  shell.lineCount += 1
  shell.transcript.add(
    new TextRenderable(shell.renderer as CliRenderer, {
      content: ` ${line}`,
      fg: opts?.fg ?? UI.text,
    }),
  )
  paintChrome(shell)
}

/**
 * Append a role-styled stream row to the **parent** transcript.
 * While subagent observe is active, rows go to the parent snapshot only
 * (not painted); leave restores them with the parent lease.
 */
export function appendStreamRow(shell: AppShell, row: StreamRow): void {
  if (shell.observe !== null && shell.parentStreamLog !== null) {
    shell.parentStreamLog.push(row)
    return
  }
  paintAppendStreamRow(shell, row)
}

/**
 * Append a child stream row while observing a subagent.
 * Host-pushed live events (not only fixture seed lines). No-op when not observing.
 * @returns true when the row was applied to the observe view
 */
export function appendObserveStreamRow(shell: AppShell, row: StreamRow): boolean {
  if (shell.observe === null) return false
  shell.observe.lines.push(row)
  paintAppendStreamRow(shell, row)
  return true
}

/**
 * The scroll box keeps a column for its bar, so the transcript is one column
 * narrower than the content zone. Taken off the row budget rather than read off
 * the viewport, which is only resolved on the next frame.
 */
const TRANSCRIPT_SCROLLBAR_COLUMNS = 1

/**
 * Surface every row is laid out against: the transcript's own column budget
 * (rows right-align and wrap themselves) and whether writers need naming.
 */
export function transcriptRowLayout(shell: AppShell): RowLayout {
  return {
    width: Math.max(1, shell.layout.contentWidth - TRANSCRIPT_SCROLLBAR_COLUMNS),
    multiAgent: shell.agentVoices.size > 1,
  }
}

/**
 * Record a row's writer. Returns true when the transcript has just gained a
 * second voice — every earlier row now needs the label it was painted without.
 */
function noteAgentVoice(shell: AppShell, row: StreamRow): boolean {
  if (row.role === "user") return false
  const before = shell.agentVoices.size
  shell.agentVoices.add(row.agent ?? MAIN_AGENT)
  return before === 1 && shell.agentVoices.size === 2
}

/** Row immediately before `index` in the log, or undefined at the start. */
function rowBefore(shell: AppShell, index: number): StreamRow | undefined {
  return index > 0 ? shell.streamLog[index - 1] : undefined
}

/** Blank rows the row at `index` claims above itself. */
function gapBefore(shell: AppShell, index: number): number {
  const row = shell.streamLog[index]
  if (row === undefined) return 0
  return rowGroupGap(rowBefore(shell, index), row)
}

/**
 * Writer label the row at `index` carries above it, or null mid-block.
 * A block is exactly a gap-free run from one writer, so this tracks
 * `gapBefore` rather than keeping its own notion of block boundaries.
 */
function labelBefore(shell: AppShell, index: number): string | null {
  const row = shell.streamLog[index]
  if (row === undefined) return null
  return blockLabel(rowBefore(shell, index), row, transcriptRowLayout(shell))
}

/** Paint + push onto the visible streamLog (child while observing, parent otherwise). */
function paintAppendStreamRow(shell: AppShell, row: StreamRow): void {
  clearLandingMark(shell)
  const gainedVoice = noteAgentVoice(shell, row)
  shell.streamLog.push(row)
  shell.lineCount = shell.streamLog.length

  // Under collapse threshold: append one paint node (cheap).
  // Over threshold: rebuild the windowed paint tree only.
  if (!gainedVoice && !mustWindow(shell.streamLog.length)) {
    const index = shell.streamLog.length - 1
    shell.transcript.add(
      createStreamRowRenderable(shell, row, gapBefore(shell, index), labelBefore(shell, index)),
    )
    paintChrome(shell)
    return
  }

  repaintTranscriptWindow(shell)
  paintChrome(shell)
}

/** Row count of the log `appendStreamRow` currently targets (parent or observe). */
export function streamRowCount(shell: AppShell): number {
  return shell.observe !== null && shell.parentStreamLog !== null
    ? shell.parentStreamLog.length
    : shell.streamLog.length
}

/**
 * Rewrite an already-appended transcript row in place.
 *
 * Streaming assistant and thinking bodies grow token by token; the bridge keeps
 * one open row and replaces it on every delta rather than appending a row per
 * token. Repaints only the affected node while the log fits without windowing.
 */
export function replaceStreamRowAt(
  shell: AppShell,
  index: number,
  row: StreamRow,
): void {
  if (shell.observe !== null && shell.parentStreamLog !== null) {
    if (index >= 0 && index < shell.parentStreamLog.length) {
      shell.parentStreamLog[index] = row
    }
    return
  }
  if (index < 0 || index >= shell.streamLog.length) return
  shell.streamLog[index] = row

  const children = shell.transcript.getChildren()
  // A raw appendTranscript line breaks the 1:1 node↔row mapping; fall back to
  // the windowed rebuild, which derives every node from the log.
  if (mustWindow(shell.streamLog.length) || children.length !== shell.streamLog.length) {
    repaintTranscriptWindow(shell)
    paintChrome(shell)
    return
  }

  const stale = children[index]
  if (stale && retextStreamRow(shell, stale, row, labelBefore(shell, index))) {
    paintChrome(shell)
    return
  }
  if (stale) {
    shell.transcript.remove(stale)
    if (typeof (stale as { destroy?: () => void }).destroy === "function") {
      ;(stale as { destroy: () => void }).destroy()
    }
  }
  shell.transcript.add(
    createStreamRowRenderable(shell, row, gapBefore(shell, index), labelBefore(shell, index)),
    index,
  )
  paintChrome(shell)
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
  if (row.diff !== undefined || row.structured !== undefined) return false
  // Expanding swaps a text row for a styled-lines box: a different node shape
  // and a different height, so the caller must rebuild rather than re-text.
  if (isDetailRow(row)) return false
  const layout = transcriptRowLayout(shell)

  if (label !== null) {
    if (!(node instanceof BoxRenderable)) return false
    const [headerNode, innerNode] = node.getChildren()
    if (!(headerNode instanceof TextRenderable) || innerNode === undefined) return false
    if (!retextStreamRowBody(innerNode, row, layout)) return false
    headerNode.content = label
    return true
  }

  return retextStreamRowBody(node, row, layout)
}

/** The shape-matching rewrite shared by labelled and unlabelled rows. */
function retextStreamRowBody(
  node: BaseRenderable,
  row: StreamRow,
  layout: RowLayout,
): boolean {
  if (node instanceof TextRenderable) {
    if (isMarkdownRow(row)) return false
    node.content = paintStreamRow(row, layout).content
    return true
  }

  if (!(node instanceof BoxRenderable) || !isMarkdownRow(row)) return false
  const [gutterNode, bodyNode] = node.getChildren()
  if (
    !(gutterNode instanceof TextRenderable) ||
    !(bodyNode instanceof MarkdownRenderable)
  ) {
    return false
  }
  const gutter = streamRowGutter(row, layout)
  gutterNode.content = gutter.content
  gutterNode.width = stringWidth(gutter.content)
  bodyNode.content = row.text
  bodyNode.streaming = row.streaming === true
  return true
}

/** Rebuild transcript paint tree from the long-log window (O(window), not O(total)). */
export function repaintTranscriptWindow(shell: AppShell): void {
  clearLandingMark(shell)
  shell.agentVoices = new Set(agentVoicesIn(shell.streamLog))
  const children = shell.transcript.getChildren()
  for (const child of [...children]) {
    shell.transcript.remove(child)
    if (typeof (child as { destroy?: () => void }).destroy === "function") {
      ;(child as { destroy: () => void }).destroy()
    }
  }

  const win = windowSlice(shell.streamLog, { windowSize: LONG_LOG_WINDOW })
  if (win.truncatedAbove) {
    shell.transcript.add(
      new TextRenderable(shell.renderer as CliRenderer, {
        content: ` ${collapseMarker(win.start)}`,
        fg: UI.textDim,
      }),
    )
  }
  win.rows.forEach((row, offset) => {
    const index = win.start + offset
    shell.transcript.add(
      createStreamRowRenderable(shell, row, gapBefore(shell, index), labelBefore(shell, index)),
    )
  })
}

/**
 * Tear the landing down on the first transcript row.
 *
 * The prompt box travels from the middle of the screen to the bottom, which is
 * a jump; it happens on the same frame as the operator's own first row so it
 * reads as the screen answering them rather than as the layout twitching.
 */
function clearLandingMark(shell: AppShell): void {
  const bag = internals.get(shell)
  const landing = bag?.landing
  if (bag === undefined || landing === null || landing === undefined) return
  bag.landing = null
  shell.transcript.remove(landing.above.box)
  landing.above.box.destroy()
  shell.root.remove(landing.below)
  landing.below.destroy()
  relayout(shell)

  const notice = bag.landingNotice
  if (notice !== null) {
    bag.landingNotice = null
    appendStreamRow(shell, { role: "system", text: notice })
  }
}

/**
 * Repaint the landing mark for `nowMs`. `animating` runs the draw/fill/fade
 * timeline; anything else holds the filled frame. No-op once the landing is
 * gone, so the caller can drive it unconditionally.
 *
 * A still mark draws the same frame for every clock value, so repainting it
 * only dirties renderables; the guard mirrors `setLockupFrame` and lets an idle
 * session sit without touching the paint tree.
 */
export function paintLanding(
  shell: AppShell,
  nowMs: number,
  animating: boolean,
): void {
  const bag = internals.get(shell)
  const landing = bag?.landing
  if (bag === undefined || landing === null || landing === undefined) return
  if (!animating && !bag.landingAnimating) return
  bag.landingAnimating = animating
  bag.landingNowMs = nowMs
  paintLandingMark(landing.above, nowMs, !animating)
}

/** True while the landing composition is still mounted. */
export function isLanding(shell: AppShell): boolean {
  return (internals.get(shell)?.landing ?? null) !== null
}

/**
 * Fill the prompt from a landing starter. Returns false when the key selects
 * nothing, the landing is gone, or the operator has already typed.
 */
export function applyLandingSuggestion(shell: AppShell, key: string): boolean {
  if (!isLanding(shell) || shell.prompt.value.length > 0) return false
  const suggestion = landingSuggestionFor(key)
  if (suggestion === null) return false
  shell.prompt.value = suggestion.prompt
  return true
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
  })
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
): TextRenderable | BoxRenderable {
  if (row.diff !== undefined) {
    return createStyledLinesRowRenderable(ctx, row, layout, row.diff.lines)
  }

  if (isDetailRow(row) && row.detail !== undefined) {
    return createStyledLinesRowRenderable(ctx, row, layout, [
      [{ text: summaryHead(row, row.summary ?? ""), fg: UI.text }],
      ...row.detail,
    ])
  }

  if (row.structured !== undefined) {
    return createStructuredRowRenderable(ctx, row, layout, row.structured)
  }

  if (!isMarkdownRow(row)) {
    const painted = paintStreamRow(row, layout)
    return new TextRenderable(ctx, { content: painted.content, fg: painted.fg })
  }

  const gutter = streamRowGutter(row, layout)
  const wrapper = new BoxRenderable(ctx, { flexDirection: "row", width: "100%" })
  wrapper.add(gutterNode(ctx, gutter))
  wrapper.add(
    new MarkdownRenderable(ctx, {
      content: row.text,
      syntaxStyle: transcriptSyntaxStyle(),
      fg: gutter.fg,
      flexGrow: 1,
      // Native incremental block stability: only the trailing block is unstable.
      streaming: row.streaming === true,
    }),
  )
  return wrapper
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
): TextRenderable | BoxRenderable {
  const ctx = shell.renderer as CliRenderer
  const layout = transcriptRowLayout(shell)
  const node = buildRowNode(ctx, row, layout)

  if (label === null) {
    node.marginTop = marginTop
    return node
  }

  const wrapper = new BoxRenderable(ctx, { flexDirection: "column", width: "100%", marginTop })
  wrapper.add(new TextRenderable(ctx, { content: label, fg: UI.textDim }))
  wrapper.add(node)
  return wrapper
}

/** Map one styled body line's segments to native text chunks. */
function diffLineChunks(line: StyledBodyLine): TextChunk[] {
  return line.map((segment) => {
    const chunk = fgChunk(segment.fg)(segment.text)
    return segment.bold === true ? boldChunk(chunk) : chunk
  })
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
): BoxRenderable {
  const gutter = streamRowGutter(row, layout)
  const wrapper = new BoxRenderable(ctx, {
    flexDirection: "row",
    width: "100%",
  })
  wrapper.add(gutterNode(ctx, gutter))
  const body = new BoxRenderable(ctx, {
    flexDirection: "column",
    flexGrow: 1,
  })
  for (const line of lines) {
    body.add(
      new TextRenderable(ctx, {
        content: new StyledText(diffLineChunks(line)),
      }),
    )
  }
  wrapper.add(body)
  return wrapper
}

/** Gutter + native table body for a structured (MCP result) row. */
function createStructuredRowRenderable(
  ctx: CliRenderer,
  row: StreamRow,
  layout: RowLayout,
  view: McpStructuredView,
): BoxRenderable {
  const gutter = streamRowGutter(row, layout)
  const wrapper = new BoxRenderable(ctx, {
    flexDirection: "row",
    width: "100%",
  })
  wrapper.add(gutterNode(ctx, gutter))
  wrapper.add(
    new TextTableRenderable(ctx, {
      content: viewToTableContent(view),
      columnWidthMode: "content",
      columnGap: 2,
      showBorders: false,
      wrapMode: "none",
      flexGrow: 1,
    }),
  )
  return wrapper
}

export function setHeader(shell: AppShell, text: string): void {
  shell.baseTitle = text
  paintChrome(shell)
}

export function setPendingQueue(shell: AppShell, count: number): void {
  let s = shell.session
  const target = Math.max(0, Math.floor(count))
  while (badgeCount(s) > target) {
    s = { ...s, items: s.items.slice(0, -1) }
  }
  while (badgeCount(s) < target) {
    s = enqueue(s, `pad-${badgeCount(s) + 1}`)
  }
  shell.session = s
  paintChrome(shell)
}

export function setShellRunState(shell: AppShell, run: RunState): void {
  shell.session = setRunState(shell.session, run)
  paintChrome(shell)
}

/** Submit prompt as queue (busy) or immediate user send (idle). */
export function submitPrompt(
  shell: AppShell,
  kind: "queue" | "steer" = "queue",
): void {
  const text = shell.prompt.value
  const t = text.trim()
  const attachments = shell.pendingAttachments
  if (t.length === 0 && attachments.length === 0) return

  // Shell/REPL muscle memory: a bare `exit` or `quit` quits rather than being
  // sent to the model. Attachments mean the operator meant it as a message.
  if (attachments.length === 0 && isExitCommand(t)) {
    const onExit = shellExitHandlers.get(shell)
    if (onExit !== undefined) {
      shell.prompt.value = ""
      onExit()
      return
    }
  }

  if (t.length > 0) recordSentMessage(shell, t)
  const hooks = getShellBridgeHooks(shell)
  if (hooks?.exclusive) {
    shell.prompt.value = ""
    clearPendingAttachments(shell)
    const resolved: "queue" | "steer" | "immediate" =
      shell.session.run === "idle" ? "immediate" : kind
    hooks.onSubmit(text, resolved, attachments)
    return
  }

  if (shell.session.run === "idle") {
    appendStreamRow(shell, { role: "user", text: t })
    shell.prompt.value = ""
    clearPendingAttachments(shell)
    return
  }

  shell.session =
    kind === "steer" ? enqueueSteer(shell.session, t) : enqueue(shell.session, t)
  shell.prompt.value = ""
  clearPendingAttachments(shell)
  const tag = kind === "steer" ? "steer" : "queue"
  appendStreamRow(shell, {
    role: "system",
    text: `${tag} +1 → pending ${badgeCount(shell.session)}`,
    meta: "queue",
  })
  paintChrome(shell)
}

/** Local interrupt mutation (no bridge re-entry). */
export function applyShellInterrupt(shell: AppShell): void {
  const had = badgeCount(shell.session)
  shell.session = interrupt(shell.session)
  shell.prompt.value = ""
  appendStreamRow(shell, {
    role: "system",
    text: `interrupt — discarded ${had} pending`,
    meta: "stop",
  })
  paintChrome(shell)
}

/** Ctrl+C interrupt path: clear pending, flash, idle. */
export function interruptShell(shell: AppShell): void {
  const hooks = getShellBridgeHooks(shell)
  if (hooks?.exclusive) {
    hooks.onInterrupt()
    return
  }
  applyShellInterrupt(shell)
}

export function clearShellInterruptFlash(shell: AppShell): void {
  shell.session = clearInterruptFlash(shell.session)
  paintChrome(shell)
}

const OVERLAY_FRAME_ID = "inset-demo"

/** Wrap body text for the overlay host (shared with overlays.ts). */
export function wrapShellOverlayBody(
  text: string,
  width: number,
  maxLines = 8,
): readonly string[] {
  return wrapOverlayText(text, Math.max(8, Math.floor(width)), maxLines)
}

/**
 * Context rows a decision overlay's body may occupy. The shaped body charges
 * its header and its two rows of air on top of this, so the spacing never
 * costs the operator a row of the command they are being asked to approve.
 */
const DECISION_CONTEXT_ROWS = 8

/** Re-shape and store the open overlay's body rows for the current width. */
function applyOverlayBodyText(
  shell: AppShell,
  text: string,
  maxLines: number,
): void {
  const width = overlayRowWidth(shell)
  if (text.length === 0) {
    shell.overlayBodyLines = []
    shell.overlayBodyFgs = []
    return
  }
  if (isDecisionOverlay(shell.overlayKind)) {
    const rows = composeDecisionBody(text, width, DECISION_CONTEXT_ROWS)
    shell.overlayBodyLines = rows.map((r) => r.text)
    shell.overlayBodyFgs = rows.map((r) => r.fg)
    return
  }
  const lines = wrapOverlayText(text, width, maxLines)
  shell.overlayBodyLines = lines
  shell.overlayBodyFgs = lines.map(() => UI.text)
}

export type OpenListOverlayOpts = {
  readonly kind?: PrimaryOverlayKind
  readonly title?: string
  readonly items?: readonly string[]
  /** Optional stable ids aligned with `items` (permission scope ids, model ids). */
  readonly itemIds?: readonly string[]
  readonly body?: string
  readonly activeIndex?: number
  readonly frameId?: string
  /**
   * Per-open accept callback. Takes precedence over shell-level overlay hooks
   * for this open. Not invoked on Esc / closeInsetOverlay.
   */
  readonly onAccept?: (selection: OverlaySelection) => void
  /**
   * Per-open expand/collapse hook. When set, the modal overlay claims a bare
   * key for it (see OVERLAY_EXPAND_KEY) — no global binding is needed because
   * the overlay owns the keyboard while it is open.
   */
  readonly onToggleExpand?: () => void
}

/**
 * Open an inset list overlay on the shared host (permissions / operator / picker / palette).
 * Measures body + list into geometry — no guessed absolute paint.
 */
export function openListOverlay(
  shell: AppShell,
  opts?: OpenListOverlayOpts,
): void {
  const kind = opts?.kind ?? "demo"
  const isPalette = kind === "palette"

  // Single host: non-palette open is a no-op while anything is open.
  // Palette may stack over a prior primary (snapshot paint; focus stacks).
  if (shell.overlayList) {
    if (!isPalette) return
    if (shell.overlayKind !== "palette") {
      const bag = internals.get(shell)
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
          onAccept: bag.overlayOnAccept,
          onToggleExpand: bag.overlayOnToggleExpand,
        }
      }
      // Leave prior overlay focus frame; palette will stack above it.
    } else {
      // Already palette — pop palette frame only so we re-push cleanly.
      let guard = 4
      while (guard-- > 0 && focusOwner(shell.focus) === "palette") {
        shell.focus = popFocus(shell.focus)
      }
    }
  }

  const labels = opts?.items ?? shell.overlayItems
  shell.overlayItems = labels
  shell.overlayKind = kind
  if (!isPalette) shell.paletteCommands = []

  const bag = internals.get(shell)
  if (bag) {
    // Palette open does not own primary accept; leave prior snapshot's callback.
    if (!isPalette) {
      bag.overlayItemIds = opts?.itemIds ? [...opts.itemIds] : []
      bag.overlayOnAccept = opts?.onAccept ?? null
      bag.overlayOnToggleExpand = opts?.onToggleExpand ?? null
    } else if (!bag.priorOverlay) {
      // Bare palette (no primary under it): no accept payload.
      bag.overlayItemIds = opts?.itemIds ? [...opts.itemIds] : []
      bag.overlayOnAccept = opts?.onAccept ?? null
      bag.overlayOnToggleExpand = opts?.onToggleExpand ?? null
    }
  }

  const bodyText = opts?.body ?? ""
  // Operator question and permission approval context get body lines; other
  // list-only overlays keep the body empty.
  applyOverlayBodyText(shell, bodyText, 0)

  const rows = shell.renderer.height || 24
  // Request ~30% of terminal for list rows; geometry will cap against floor.
  const listRows = Math.max(3, Math.floor(rows * 0.3))
  const perItem = overlayRowsPerItem(shell.overlayKind)
  const listItems = Math.max(2, Math.floor(listRows / perItem))
  const hostRows = overlayHostRows(
    shell.overlayBodyLines.length,
    listItems * perItem,
  )

  shell.overlayList = createListViewport({
    count: labels.length,
    height: listItems,
    activeIndex: opts?.activeIndex ?? 0,
  })

  const title = opts?.title ?? "permission"
  shell.overlayTitle.content = overlayTitleLine(title, overlayRowWidth(shell) + 2)

  const frameId = opts?.frameId ?? OVERLAY_FRAME_ID
  const focusTarget = isPalette ? "palette" : "overlay"
  shell.focus = openOverlay(shell.focus, frameId, {
    target: focusTarget,
    scrollOwner: isPalette ? "palette" : "overlay",
  })
  relayout(shell, { overlayMode: "inset", overlayBodyRows: hostRows })
  applyFocus(shell)
  paintOverlayList(shell)
}

/** Open inset permission/palette stub; focus stack owns keys; Esc closes. */
export function openInsetOverlay(
  shell: AppShell,
  items?: readonly string[],
): void {
  openListOverlay(shell, {
    kind: "demo",
    title: "permission",
    items: items ?? shell.overlayItems,
    frameId: OVERLAY_FRAME_ID,
  })
}

/** Resolve the shell's default palette catalog (injected or residual-only). */
export function resolvePaletteCatalog(shell: AppShell): readonly PaletteCommand[] {
  const bag = internals.get(shell)
  const raw = bag?.paletteCatalog
  if (raw === null || raw === undefined) return DEFAULT_PALETTE_COMMANDS
  return typeof raw === "function" ? raw() : raw
}

/**
 * Replace the shell default palette catalog (host rebinds after registry load).
 * Pass null to restore residual-only DEFAULT_PALETTE_COMMANDS.
 */
export function setPaletteCatalog(
  shell: AppShell,
  catalog:
    | readonly PaletteCommand[]
    | (() => readonly PaletteCommand[])
    | null,
): void {
  const bag = internals.get(shell)
  if (bag) bag.paletteCatalog = catalog
}

/**
 * Open Amp-class command palette (Ctrl+O).
 * Chord reclaimed from tool-expand — document in interaction contract.
 * Catalog: opts.catalog → shell default (injected registry build) → residuals.
 */
export function openPalette(
  shell: AppShell,
  opts?: {
    readonly query?: string
    readonly catalog?: readonly PaletteCommand[]
    readonly title?: string
    /** Claim printable keys for the `>` filter row. Off for the `/` popup. */
    readonly typeToFilter?: boolean
  },
): void {
  const title = opts?.title ?? "command palette"
  const bag = internals.get(shell)
  if (bag) {
    bag.paletteFilter = {
      query: opts?.query ?? "",
      title,
      // Slash and other callers pass a pre-narrowed catalog; a bare Ctrl+O open
      // re-resolves the shell default so a registry loaded later is picked up.
      catalog: opts?.catalog ?? null,
      // The `/` popup keeps its query in the prompt and drives its own reopen.
      typeToFilter: opts?.typeToFilter ?? false,
    }
  }
  repaintPalette(shell)
}

/** Palette open state that survives a re-filter. */
type PaletteFilterState = {
  query: string
  readonly title: string
  readonly catalog: readonly PaletteCommand[] | null
  readonly typeToFilter: boolean
}

/** Re-open the palette against the current filter state (used on every keystroke). */
function repaintPalette(shell: AppShell): void {
  const state = internals.get(shell)?.paletteFilter
  if (!state) return
  const catalog = state.catalog ?? resolvePaletteCatalog(shell)
  const commands = filterPaletteCommands(state.query, catalog)
  const labels =
    commands.length > 0 ? paletteLabels(commands) : ["(no matches)"]
  shell.paletteCommands = commands
  openListOverlay(shell, {
    kind: "palette",
    title: state.title,
    items: labels,
    // Filter query row, Amp-style: the palette always shows what it filtered on.
    body: `> ${state.query}`,
    frameId: "command-palette",
  })
  shell.overlayTitle.content = paletteTitleLine(
    state.title,
    overlayInteriorWidth(shell),
  )
  paintOverlayList(shell)
}

/**
 * Keys the palette claims while it is open, so the `>` row filters as you type.
 *
 * Opt-in per open rather than a property of the shared list overlay: every other
 * picker (permissions, model, resume, workers, copy) keeps j/k navigation, which
 * only the palette has to give up to get its printable keys back. Arrow and page
 * keys are never claimed here, so they keep working in every overlay including
 * this one.
 */
export function handlePaletteFilterKey(
  shell: AppShell,
  key: KeyEvent,
): boolean {
  const state = internals.get(shell)?.paletteFilter
  if (!state?.typeToFilter) return false
  if (shell.overlayKind !== "palette" || shell.overlayList === null) return false
  if (key.ctrl || key.meta || key.option) return false

  if (key.name === "backspace") {
    if (state.query.length === 0) return true
    state.query = state.query.slice(0, -1)
    repaintPalette(shell)
    return true
  }

  const seq = typeof key.sequence === "string" ? key.sequence : ""
  if (seq.length !== 1 || seq < " ") return false

  state.query += seq
  repaintPalette(shell)
  return true
}

/**
 * Palette title as a rule broken by the title, left-ish. The overlay host's own
 * border is asserted elsewhere to be unbroken box-drawing, so the titled rule is
 * a row inside the box rather than text written into the border itself.
 */
function paletteTitleLine(title: string, interior: number): string {
  const head = `─ ${title} `
  if (head.length >= interior) return head.slice(0, Math.max(0, interior))
  return head + "─".repeat(interior - head.length)
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
  if (key.ctrl && !key.meta && !key.option && (key.name === "o" || key.name === "O")) {
    return "palette"
  }
  if ((key.meta || key.option) && !key.ctrl && (key.name === "c" || key.name === "C")) {
    return "copy"
  }
  if (!key.ctrl && !key.meta && !key.option && key.sequence === "?") {
    return "help"
  }
  return null
}

/**
 * Re-pressing the chord that opened a picker closes it, through the same path
 * Esc uses so key claims and focus are unwound identically.
 */
function toggleCloseOpenSurface(shell: AppShell, key: KeyEvent): boolean {
  if (shell.overlayList === null) return false
  const kind = toggledSurfaceFor(key)
  if (kind === null || kind !== shell.overlayKind) return false
  // The `/` popup borrows the palette overlay; there the chord is still a
  // character the operator may be typing into the filter.
  if (kind === "palette" && isSlashPopupOpen(shell)) return false
  closeInsetOverlay(shell)
  return true
}

/** Close overlay/palette if open; restore prior focus (or prior overlay under palette). */
export function closeInsetOverlay(shell: AppShell): void {
  if (!shell.overlayList) return
  // Esc (or any other dismiss) must also drop the `/` and `@` popups' key claim.
  slashPopups.delete(shell)
  mentionPopups.delete(shell)

  const wasPalette = shell.overlayKind === "palette"
  if (wasPalette) {
    const filterBag = internals.get(shell)
    if (filterBag) filterBag.paletteFilter = null
  }
  const bag = internals.get(shell)
  const prior = wasPalette ? bag?.priorOverlay ?? null : null

  shell.overlayList = null
  shell.overlayKind = null
  shell.overlayBodyLines = []
  shell.overlayBodyFgs = []
  shell.paletteCommands = []
  shell.copyTargets = null
  clearOverlayBody(shell)
  // Esc / dismiss: drop accept path without invoking callbacks.
  if (bag && !prior) {
    bag.overlayItemIds = []
    bag.overlayOnAccept = null
    bag.overlayOnToggleExpand = null
  }

  // Pop exactly one frame (palette or overlay).
  if (
    focusOwner(shell.focus) === "overlay" ||
    focusOwner(shell.focus) === "palette"
  ) {
    shell.focus = popFocus(shell.focus)
  }

  if (prior && bag) {
    bag.priorOverlay = null
    // Restore prior primary overlay paint; focus should already be overlay.
    shell.overlayItems = prior.items
    shell.overlayKind = prior.kind
    shell.overlayBodyLines = prior.bodyLines
    shell.overlayBodyFgs = prior.bodyFgs
    shell.overlayList = prior.list
    shell.paletteCommands = prior.paletteCommands
    shell.overlayTitle.content = prior.title
    bag.overlayItemIds = prior.itemIds
    bag.overlayOnAccept = prior.onAccept
    bag.overlayOnToggleExpand = prior.onToggleExpand
    // If focus was not stacked (edge case), re-open overlay frame.
    if (focusOwner(shell.focus) !== "overlay") {
      shell.focus = openOverlay(shell.focus, OVERLAY_FRAME_ID, {
        target: "overlay",
        scrollOwner: "overlay",
      })
    }
    const listH = prior.list.height
    const hostRows = overlayHostRows(prior.bodyLines.length, listH)
    relayout(shell, { overlayMode: "inset", overlayBodyRows: hostRows })
    applyFocus(shell)
    paintOverlayList(shell)
    return
  }

  // Ensure no leftover overlay/palette frames.
  let guard = 4
  while (
    guard-- > 0 &&
    (focusOwner(shell.focus) === "overlay" ||
      focusOwner(shell.focus) === "palette")
  ) {
    shell.focus = popFocus(shell.focus)
  }

  relayout(shell, { overlayMode: "closed" })
  applyFocus(shell)
}


/**
 * Bare key the modal overlay claims for its expand/collapse hook. Deliberately
 * not in SHELL_SHORTCUTS: it is live only while an overlay that supplied
 * `onToggleExpand` is open, so it never shadows a prompt binding.
 */
export const OVERLAY_EXPAND_KEY = EXPAND_KEY

/**
 * Expand or collapse the newest transcript row that hides a body behind a
 * summary: a loaded skill, a summarised tool call, settled reasoning. Same key
 * as the overlay's collapsed payloads, so the product has one expand idiom.
 * False when there is nothing to expand.
 */
export function toggleCollapsedRow(shell: AppShell): boolean {
  for (let i = shell.streamLog.length - 1; i >= 0; i--) {
    const row = shell.streamLog[i]
    if (row === undefined || !isCollapsibleRow(row)) continue
    replaceStreamRowAt(shell, i, { ...row, expanded: row.expanded !== true })
    return true
  }
  return false
}

/** Replace the open overlay's body text in place (re-wrap + relayout). */
export function setOverlayBody(
  shell: AppShell,
  text: string,
  maxLines = 8,
): void {
  if (!shell.overlayList) return
  applyOverlayBodyText(shell, text, maxLines)
  const hostRows = overlayHostRows(
    shell.overlayBodyLines.length,
    shell.overlayList.height * overlayRowsPerItem(shell.overlayKind),
  )
  relayout(shell, { overlayMode: "inset", overlayBodyRows: hostRows })
  paintOverlayList(shell)
}

/** Run the open overlay's expand/collapse hook; true when one was bound. */
export function toggleOverlayExpand(shell: AppShell): boolean {
  if (!shell.overlayList) return false
  const hook = internals.get(shell)?.overlayOnToggleExpand ?? null
  if (!hook) return false
  hook()
  return true
}

/** Move overlay selection (j/k / arrows). */
export function moveOverlaySelection(shell: AppShell, delta: number): void {
  if (!shell.overlayList) return
  shell.overlayList = moveActive(shell.overlayList, delta)
  paintOverlayList(shell)
}

/** Page overlay selection (PgUp/PgDn). */
export function pageOverlaySelection(shell: AppShell, dir: -1 | 1): void {
  if (!shell.overlayList) return
  shell.overlayList = pageList(shell.overlayList, dir)
  paintOverlayList(shell)
}

/** Accept active overlay item → callback + system line + close (palette dispatches action). */
export function acceptOverlaySelection(shell: AppShell): void {
  if (!shell.overlayList) return

  if (shell.overlayKind === "copy") {
    confirmCopySelection(shell)
    return
  }

  const idx = shell.overlayList.activeIndex
  const label = shell.overlayItems[idx] ?? `item ${idx}`
  const kind = shell.overlayKind ?? "demo"

  if (kind === "palette") {
    const cmd = shell.paletteCommands[idx]
    closeInsetOverlay(shell)
    if (cmd) dispatchPaletteSelection(shell, cmd)
    else {
      appendStreamRow(shell, {
        role: "system",
        text: `palette: no action for ${label}`,
        meta: "palette",
      })
    }
    return
  }

  const bag = internals.get(shell)
  const id = bag?.overlayItemIds[idx]
  const selection: OverlaySelection = {
    kind,
    index: idx,
    label,
    ...(id !== undefined ? { id } : {}),
  }
  // Capture before close clears per-open state.
  const perOpen = bag?.overlayOnAccept ?? null

  appendStreamRow(shell, {
    role: "system",
    text: `chose (${kind}): ${label}`,
    meta: "overlay",
  })
  closeInsetOverlay(shell)
  dispatchOverlayAccept(shell, selection, perOpen)
}

/**
 * Dispatch a selected palette item after the palette has closed.
 * - residual → `runPaletteAction` (overlays / chrome)
 * - command → injectable `onCommand(name)` (registry slash path)
 */
export function dispatchPaletteSelection(
  shell: AppShell,
  cmd: PaletteCommand,
): void {
  const dispatch = paletteDispatchOf(cmd)
  if (dispatch === "command") {
    const onCommand = getPaletteOnCommand(shell)
    if (onCommand) {
      onCommand(cmd.id)
      return
    }
    appendStreamRow(shell, {
      role: "system",
      text: `palette: /${cmd.id} (no onCommand handler)`,
      meta: "palette",
    })
    return
  }
  if (isResidualActionId(cmd.id)) {
    runPaletteAction(shell, cmd.id)
    return
  }
  appendStreamRow(shell, {
    role: "system",
    text: `palette: unknown residual ${cmd.id}`,
    meta: "palette",
  })
}

/** Run a residual palette action after the palette has closed. */
export function runPaletteAction(
  shell: AppShell,
  id: PaletteActionId,
): void {
  switch (id) {
    case "permissions": {
      // Lazy import surface — open via openListOverlay to avoid overlays circular init.
      openListOverlay(shell, {
        kind: "permissions",
        title: "permissions",
        items: [
          "Allow once",
          "Allow session",
          "Always allow this tool",
          "Deny",
          ...Array.from({ length: 26 }, (_, i) => `Allow tool call #${i + 2}`),
        ],
        frameId: "permissions",
      })
      return
    }
    case "operator": {
      openListOverlay(shell, {
        kind: "operator",
        title: "operator",
        body:
          "The agent wants to run a destructive command that may modify your working tree.\n\nProceed with git reset --hard HEAD~1?",
        items: [
          "Cancel",
          "Allow this once",
          "Allow for session",
          "Deny and tell agent",
          "Open diff first",
          "Always ask",
          "Skip remaining questions",
          "Abort run",
        ],
        frameId: "operator-question",
      })
      return
    }
    case "model_picker": {
      openListOverlay(shell, {
        kind: "model_picker",
        title: "model / provider",
        items: [
          "anthropic / claude-sonnet-4",
          "anthropic / claude-opus-4",
          "openai / gpt-4.1",
          "openai / o3",
          "google / gemini-2.5-pro",
          "local / ollama",
        ],
        frameId: "model-picker",
      })
      return
    }
    case "toggle_goal": {
      const bag = internals.get(shell)
      const on = (bag?.chrome.goal.length ?? 0) > 0
      setChromeZones(shell, {
        goal: on ? null : "goal: Wave 6 palette + long-log + chrome",
      })
      appendStreamRow(shell, {
        role: "system",
        text: on ? "goal chrome off" : "goal chrome on",
        meta: "chrome",
      })
      return
    }
    case "toggle_task": {
      const bag = internals.get(shell)
      const on = (bag?.chrome.task.length ?? 0) > 0
      setChromeZones(shell, {
        task: on ? null : "task: implement Wave 6 acceptance",
      })
      appendStreamRow(shell, {
        role: "system",
        text: on ? "task chrome off" : "task chrome on",
        meta: "chrome",
      })
      return
    }
    case "toggle_agents": {
      const bag = internals.get(shell)
      const on = (bag?.chrome.agents.length ?? 0) > 0
      setChromeZones(shell, {
        agents: on ? null : "agents: 0 running",
      })
      appendStreamRow(shell, {
        role: "system",
        text: on ? "agents strip off" : "agents strip on",
        meta: "chrome",
      })
      return
    }
    case "copy_active": {
      enterCopyMode(shell)
      return
    }
    case "help": {
      openHelpOverlay(shell)
      return
    }
    case "settings": {
      openSettingsOverlay(shell)
      return
    }
    case "plugins": {
      openPluginsOverlay(shell)
      return
    }
    case "resume": {
      openResumeOverlay(shell)
      return
    }
    case "mentions": {
      openMentionsOverlay(shell)
      return
    }
    case "observe": {
      const onObserveRequest = getPaletteOnObserveRequest(shell)
      const session = onObserveRequest
        ? onObserveRequest()
        : makeObserveFixture()
      if (session) enterSubagentObserve(shell, session)
      else {
        appendStreamRow(shell, {
          role: "system",
          text: "no subagent session to observe",
          meta: "observe",
        })
      }
      return
    }
  }
}

export type ChromeZoneContent = {
  readonly goal?: string | null
  readonly task?: string | null
  readonly agents?: string | null
}

/**
 * Set agents/goal/task chrome zone content (null/empty = hide zone).
 * Heights come from geometry resolve — never guessed.
 */
export function setChromeZones(
  shell: AppShell,
  content: ChromeZoneContent,
): void {
  const bag = internals.get(shell)
  if (!bag) return

  if (content.goal !== undefined) {
    bag.chrome.goal = content.goal ?? ""
  }
  if (content.task !== undefined) {
    bag.chrome.task = content.task ?? ""
  }
  if (content.agents !== undefined) {
    bag.chrome.agents = content.agents ?? ""
  }

  const goalOn = bag.chrome.goal.length > 0
  const taskOn = bag.chrome.task.length > 0
  const agentsOn = bag.chrome.agents.length > 0

  shell.goalText.content = goalOn ? ` ${bag.chrome.goal}` : ""
  shell.taskText.content = taskOn ? ` ${bag.chrome.task}` : ""
  shell.agentsText.content = agentsOn ? ` ${bag.chrome.agents}` : ""

  // Only a zone appearing or disappearing changes the row budget; retitling a
  // zone that is already on must not re-resolve and re-apply the whole layout.
  if (
    goalOn === bag.visibility.goal &&
    taskOn === bag.visibility.task &&
    agentsOn === bag.visibility.agents
  ) {
    paintChrome(shell)
    return
  }

  relayout(shell, {
    visibility: {
      ...bag.visibility,
      goal: goalOn,
      task: taskOn,
      agents: agentsOn,
    },
    overlayMode: bag.overlayMode,
    ...(bag.overlayBodyRows !== undefined
      ? { overlayBodyRows: bag.overlayBodyRows }
      : {}),
  })
}

/**
 * Enter copy mode (Alt+C / palette copy_active): freeze targets from the
 * active streamLog, open inset overlay with the last target selected.
 * Empty log → status flash only; no stream mutation.
 */
export function enterCopyMode(shell: AppShell): boolean {
  // Single host: do not stack copy over another primary overlay.
  if (shell.overlayList) return false

  const targets = buildCopyTargets(shell.streamLog)
  if (targets.length === 0) {
    setStatusFlash(shell, "nothing to copy")
    return false
  }

  shell.copyTargets = targets
  const labels = targets.map((t) => `${t.label}: ${t.preview}`)
  openListOverlay(shell, {
    kind: "copy",
    title: "copy · Alt+C",
    items: labels,
    activeIndex: targets.length - 1,
    frameId: "copy-mode",
  })
  return true
}

/** Write the frozen target at the active list index; status flash only. */
export function confirmCopySelection(shell: AppShell): boolean {
  const targets = shell.copyTargets
  if (!targets || targets.length === 0 || !shell.overlayList) {
    setStatusFlash(shell, "nothing to copy")
    closeInsetOverlay(shell)
    return false
  }
  const idx = Math.max(
    0,
    Math.min(targets.length - 1, shell.overlayList.activeIndex),
  )
  const target = targets[idx]
  if (!target) {
    setStatusFlash(shell, "nothing to copy")
    closeInsetOverlay(shell)
    return false
  }
  void shell.clipboard.writeText(target.text)
  const preview =
    target.text.length > 48
      ? `${target.text.slice(0, 45).replace(/\s+/g, " ")}…`
      : target.text
  setStatusFlash(
    shell,
    `Copied ${target.label} (${target.text.length} chars): ${preview}`,
  )
  closeInsetOverlay(shell)
  return true
}

/** Copy all frozen targets as markdown; status flash only. */
export function copyAllTargets(shell: AppShell): boolean {
  const targets = shell.copyTargets
  if (!targets || targets.length === 0) {
    setStatusFlash(shell, "nothing to copy")
    if (shell.overlayKind === "copy") closeInsetOverlay(shell)
    return false
  }
  const text = streamLogMarkdown(targets)
  void shell.clipboard.writeText(text)
  setStatusFlash(
    shell,
    `Copied all (${targets.length} items, ${text.length} chars)`,
  )
  closeInsetOverlay(shell)
  return true
}

/**
 * Keyboard copy path (Alt+C): open the copy overlay (Ink parity).
 * `activeIndex` is ignored — selection lives in the overlay list.
 */
export function copyActiveMessage(
  shell: AppShell,
  _activeIndex?: number,
): boolean {
  return enterCopyMode(shell)
}

/**
 * Enter a child subagent session view.
 * Host passes live rows + agent label (`ObserveSession`); fixture via
 * `makeObserveFixture()` is only for demo/tests. Esc restores parent lease.
 */
export function enterSubagentObserve(
  shell: AppShell,
  session: ObserveSession,
): void {
  if (shell.observe) {
    leaveSubagentObserve(shell)
  }

  const seedLines = session.lines.slice()
  shell.parentStreamLog = shell.streamLog.slice()
  shell.observe = {
    sessionId: session.sessionId,
    agentId: session.agentId,
    description: session.description,
    lines: seedLines.slice(),
  }

  shell.streamLog = seedLines
  shell.lineCount = shell.streamLog.length
  repaintTranscriptWindow(shell)

  shell.focus = openObserve(shell.focus, `observe-${session.sessionId}`)
  setChromeZones(shell, {
    agents: `observe: ${session.agentId} — ${session.description}`,
  })
  // Child chrome toast — must not route to parent snapshot.
  appendObserveStreamRow(shell, {
    role: "system",
    text: `Viewing ${session.agentId}: ${session.description}`,
    meta: "observe",
  })
  paintChrome(shell)
}

/** Leave observe; restore parent stream + focus lease. */
export function leaveSubagentObserve(shell: AppShell): void {
  if (!shell.observe) return

  const agentId = shell.observe.agentId
  shell.observe = null

  if (shell.parentStreamLog) {
    shell.streamLog = shell.parentStreamLog
    shell.parentStreamLog = null
  }
  shell.lineCount = shell.streamLog.length
  repaintTranscriptWindow(shell)

  let guard = 4
  while (guard-- > 0 && focusOwner(shell.focus) === "observe") {
    shell.focus = popFocus(shell.focus)
  }
  // Drop any observe frames that weren't top.
  const frames = shell.focus.frames.filter((f) => f.target !== "observe")
  if (frames.length > 0) shell.focus = { frames }

  setChromeZones(shell, { agents: null })
  appendStreamRow(shell, {
    role: "system",
    text: `left observe (${agentId})`,
    meta: "observe",
  })
  paintChrome(shell)
}

/**
 * Host-injected residual list open. Fixtures apply only when `items` is omitted.
 * Per-open `onAccept` wins over shell-level residual hooks for that open.
 */
export type OpenResidualListOpts = {
  readonly items?: readonly string[]
  /** Stable ids aligned with `items` (setting keys, session ids, paths). */
  readonly itemIds?: readonly string[]
  readonly activeIndex?: number
  /** Per-open accept; host binds toggle / resume / mention insert. */
  readonly onAccept?: (selection: OverlaySelection) => void
}

export function openSettingsOverlay(
  shell: AppShell,
  opts?: OpenResidualListOpts,
): void {
  openListOverlay(shell, {
    kind: "settings",
    title: "settings",
    items: opts?.items ?? makeSettingsItems(),
    activeIndex: opts?.activeIndex ?? 0,
    frameId: "overlay-settings",
    ...(opts?.itemIds !== undefined ? { itemIds: opts.itemIds } : {}),
    ...(opts?.onAccept !== undefined ? { onAccept: opts.onAccept } : {}),
  })
}

export function openHelpOverlay(
  shell: AppShell,
  opts?: OpenResidualListOpts,
): void {
  openListOverlay(shell, {
    kind: "help",
    title: "help · keymap",
    items: opts?.items ?? makeHelpItems(),
    activeIndex: opts?.activeIndex ?? 0,
    frameId: "overlay-help",
    ...(opts?.itemIds !== undefined ? { itemIds: opts.itemIds } : {}),
    ...(opts?.onAccept !== undefined ? { onAccept: opts.onAccept } : {}),
  })
}

export function openPluginsOverlay(
  shell: AppShell,
  opts?: OpenResidualListOpts,
): void {
  openListOverlay(shell, {
    kind: "plugins",
    title: "plugins",
    items: opts?.items ?? makePluginsItems(),
    activeIndex: opts?.activeIndex ?? 0,
    frameId: "overlay-plugins",
    ...(opts?.itemIds !== undefined ? { itemIds: opts.itemIds } : {}),
    ...(opts?.onAccept !== undefined ? { onAccept: opts.onAccept } : {}),
  })
}

export function openResumeOverlay(
  shell: AppShell,
  opts?: OpenResidualListOpts,
): void {
  openListOverlay(shell, {
    kind: "resume",
    title: "resume session",
    items: opts?.items ?? makeResumeItems(),
    activeIndex: opts?.activeIndex ?? 0,
    frameId: "overlay-resume",
    ...(opts?.itemIds !== undefined ? { itemIds: opts.itemIds } : {}),
    ...(opts?.onAccept !== undefined ? { onAccept: opts.onAccept } : {}),
  })
}

export function openMentionsOverlay(
  shell: AppShell,
  opts?: OpenResidualListOpts,
): void {
  openListOverlay(shell, {
    kind: "mentions",
    title: "mentions",
    items: opts?.items ?? makeMentionItems(),
    activeIndex: opts?.activeIndex ?? 0,
    frameId: "overlay-mentions",
    ...(opts?.itemIds !== undefined ? { itemIds: opts.itemIds } : {}),
    ...(opts?.onAccept !== undefined ? { onAccept: opts.onAccept } : {}),
  })
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
])

const defaultMentionSource: MentionSuggestionSource = (prefix) =>
  listPathSuggestions(prefix, process.cwd())

/**
 * Open path suggestions for the @token under the cursor and splice the
 * accepted entry back into the prompt. Directory picks re-open one level
 * down so the operator can drill in without typing the path.
 * Returns false when the cursor is not inside an @token or nothing matched.
 */
export async function openAtMentionSuggestions(shell: AppShell): Promise<boolean> {
  const at = parseAtState(shell.prompt.value, shell.prompt.cursorOffset)
  if (at === null) {
    closeMentionPopup(shell)
    return false
  }

  // Every keystroke re-queries; a slower earlier query must not overwrite the
  // list a later one already produced.
  const generation = (mentionGenerations.get(shell) ?? 0) + 1
  mentionGenerations.set(shell, generation)

  const cursor = shell.prompt.cursorOffset
  const source = shellMentionSource.get(shell) ?? defaultMentionSource
  const token = splitMentionToken(at.prefix)
  let suggestions = filterMentionSuggestions(
    await source(token.dir),
    token.fragment,
  )
  // The source caps how many entries it returns per directory, so a large
  // directory can cap out before the interior match appears. Asking it to do
  // its own prefix filter puts that cap after the narrowing instead of before.
  if (suggestions.length === 0 && token.fragment.length > 0) {
    suggestions = await source(at.prefix)
  }
  if (mentionGenerations.get(shell) !== generation) return false

  if (suggestions.length === 0) {
    closeMentionPopup(shell)
    setStatusFlash(shell, `no matches for @${at.prefix}`)
    return false
  }

  closeMentionPopup(shell)
  openMentionsOverlay(shell, {
    items: [...suggestions],
    onAccept: (selection) => {
      const completion = suggestions[selection.index]
      if (completion === undefined) return
      const spliced = spliceMentionCompletion(
        shell.prompt.value,
        at.atStart,
        cursor,
        completion,
      )
      shell.prompt.value = spliced.value
      shell.prompt.cursorOffset = spliced.cursor
      shell.sentHistory = sentHistoryOnEdit(shell.sentHistory)
      if (completion.endsWith("/")) void openAtMentionSuggestions(shell)
    },
  })
  mentionPopups.add(shell)
  return true
}

const mentionPopups = new WeakSet<AppShell>()
const mentionGenerations = new WeakMap<AppShell, number>()

/** True while the `@` path popup owns typed characters. */
export function isMentionPopupOpen(shell: AppShell): boolean {
  return mentionPopups.has(shell) && shell.overlayKind === "mentions"
}

export function closeMentionPopup(shell: AppShell): void {
  if (!mentionPopups.has(shell)) return
  mentionPopups.delete(shell)
  if (shell.overlayList) closeInsetOverlay(shell)
}

function editPromptAt(shell: AppShell, value: string, cursor: number): void {
  shell.prompt.value = value
  shell.prompt.cursorOffset = cursor
  shell.sentHistory = sentHistoryOnEdit(shell.sentHistory)
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
  if (!isMentionPopupOpen(shell) || shell.overlayList === null) return false
  if (key.ctrl || key.meta || key.option) return false

  const value = shell.prompt.value
  const cursor = shell.prompt.cursorOffset

  if (key.name === "backspace") {
    if (cursor === 0) {
      closeMentionPopup(shell)
      return true
    }
    editPromptAt(shell, value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1)
    // Deleting the `@` itself ends the mention; there is nothing left to filter.
    if (value[cursor - 1] === "@") closeMentionPopup(shell)
    else void openAtMentionSuggestions(shell)
    return true
  }

  const seq = typeof key.sequence === "string" ? key.sequence : ""
  if (seq.length !== 1 || seq < " ") return false

  editPromptAt(shell, value.slice(0, cursor) + seq + value.slice(cursor), cursor + 1)
  // Whitespace terminates the @token, so the popup has nothing left to narrow.
  if (/\s/.test(seq)) closeMentionPopup(shell)
  else void openAtMentionSuggestions(shell)
  return true
}

const slashPopups = new WeakSet<AppShell>()

/** True while the `/` command popup owns typed characters. */
export function isSlashPopupOpen(shell: AppShell): boolean {
  return slashPopups.has(shell) && shell.overlayList !== null
}

/**
 * Popup query = prompt text after the leading `/`. Null once the operator has
 * typed whitespace: at that point the name is settled and the rest is arguments.
 */
function slashPopupQuery(shell: AppShell): string | null {
  const value = shell.prompt.value
  if (!value.startsWith("/")) return null
  const head = value.slice(1)
  return /\s/.test(head) ? null : head
}

/** Registry-backed slash entries only — residual openers stay on Ctrl+O. */
function slashCatalog(shell: AppShell): readonly PaletteCommand[] {
  return resolvePaletteCatalog(shell).filter(
    (cmd) => paletteDispatchOf(cmd) === "command",
  )
}

export function closeSlashPopup(shell: AppShell): void {
  if (!slashPopups.has(shell)) return
  slashPopups.delete(shell)
  if (shell.overlayList) closeInsetOverlay(shell)
}

/**
 * Open (or refresh) the `/` command popup for the name being typed. Reuses the
 * palette overlay so accept dispatches through the same registry path as a
 * typed `/name`. Returns false when nothing matches — the typed text stays.
 */
export function openSlashCommands(shell: AppShell): boolean {
  const query = slashPopupQuery(shell)
  if (query === null) {
    closeSlashPopup(shell)
    return false
  }
  // Name-prefix, not the palette's fuzzy label match: at the prompt the
  // operator is typing the command they already mean.
  const q = query.toLowerCase()
  const matches = slashCatalog(shell).filter((cmd) =>
    cmd.id.toLowerCase().startsWith(q),
  )
  if (matches.length === 0) {
    closeSlashPopup(shell)
    return false
  }
  closeSlashPopup(shell)
  openPalette(shell, { catalog: matches, title: "commands · /" })
  slashPopups.add(shell)
  return true
}

function setPromptText(shell: AppShell, value: string): void {
  shell.prompt.value = value
  shell.prompt.cursorOffset = value.length
  shell.sentHistory = sentHistoryOnEdit(shell.sentHistory)
}

/**
 * Keys the `/` popup claims while open. Returns true when handled.
 *
 * Enter runs the highlighted command with no arguments; Tab instead completes
 * the name and leaves the popup so arguments can be typed — a command that
 * needs arguments should not fire bare just because its name matched.
 */
export function handleSlashPopupKey(shell: AppShell, key: KeyEvent): boolean {
  if (!isSlashPopupOpen(shell) || shell.overlayList === null) return false

  if (key.name === "backspace" && !key.ctrl && !key.meta && !key.option) {
    setPromptText(shell, shell.prompt.value.slice(0, -1))
    openSlashCommands(shell)
    return true
  }

  const active = shell.paletteCommands[shell.overlayList.activeIndex]

  if (key.name === "tab" && !key.ctrl && !key.meta && !key.option) {
    if (active) setPromptText(shell, `/${active.id} `)
    closeSlashPopup(shell)
    return true
  }

  if (
    (key.name === "return" || key.name === "enter") &&
    !key.ctrl &&
    !key.meta &&
    !key.option
  ) {
    closeSlashPopup(shell)
    setPromptText(shell, "")
    if (active) dispatchPaletteSelection(shell, active)
    return true
  }

  const seq = typeof key.sequence === "string" ? key.sequence : ""
  const printable =
    seq.length === 1 &&
    seq >= " " &&
    seq !== "" &&
    !key.ctrl &&
    !key.meta &&
    !key.option
  if (!printable) return false

  setPromptText(shell, shell.prompt.value + seq)
  // Whitespace ends the name; keep the popup out of the way while args are typed.
  if (/\s/.test(seq)) closeSlashPopup(shell)
  else openSlashCommands(shell)
  return true
}

/** Window in which a second Ctrl+C is read as "yes, quit". */
export const CTRL_C_EXIT_WINDOW_MS = 2000

const ctrlCArmedAt = new WeakMap<AppShell, number>()

/**
 * Ctrl+C: interrupt / clear, and quit on a second press inside the window.
 * The double press replaces the old Ink y/n exit confirm — same intent (an
 * explicit second confirmation), no modal. Quitting routes through the
 * registered exit handler so host finalize still runs.
 */
export function handleCtrlC(shell: AppShell, now = Date.now()): void {
  const armedAt = ctrlCArmedAt.get(shell)
  if (armedAt !== undefined && now - armedAt <= CTRL_C_EXIT_WINDOW_MS) {
    ctrlCArmedAt.delete(shell)
    const onExit = shellExitHandlers.get(shell)
    if (onExit !== undefined) {
      onExit()
      return
    }
  }
  ctrlCArmedAt.set(shell, now)

  if (shell.session.run === "busy" || badgeCount(shell.session) > 0) {
    interruptShell(shell)
  } else if (shell.prompt.value.length > 0) {
    shell.prompt.value = ""
  }
  setStatusFlash(shell, "press ctrl+c again to exit")
}

/**
 * Build the app shell frame on an OpenTUI renderer.
 * Mounts sticky transcript / overlay host / transient notice / prompt box.
 */
export function createAppShell(
  renderer: ShellRenderer,
  options?: AppShellOptions,
): AppShell {
  const title = options?.title ?? DEFAULT_TITLE
  const visibility = defaultVisibility(options?.visibility)
  const promptContentRows = options?.promptContentRows ?? PROMPT_IDLE_ROWS
  const wireKeys = options?.wireKeys !== false
  const mount = options?.mount !== false
  // A freshly mounted shell has nothing in flight; the runner sets busy when a
  // turn starts. Defaulting to busy made the landing screen offer "^C stop".
  const run = options?.run ?? "idle"
  const overlayItems = options?.overlayItems ?? [...DEFAULT_OVERLAY_ITEMS]
  const paletteCatalogOpt = options?.paletteCatalog ?? null
  const onCommandOpt = options?.onCommand
  const onObserveRequestOpt = options?.onObserveRequest

  const terminal = terminalOf(renderer, options?.terminal)
  const layout = resolveGeometry({
    terminal,
    visibility,
    overlay: { mode: "closed" },
    promptContentRows,
  })

  const ctx = renderer as CliRenderer

  const root = new BoxRenderable(ctx, {
    id: "app-shell",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: UI.ground,
    paddingLeft: layout.sideMargin,
    paddingRight: layout.sideMargin,
  })

  // One optical gutter for the whole shell: every zone is a child of the padded
  // root, so nothing can drift out of alignment with the rest.
  const topPad = new BoxRenderable(ctx, {
    id: "shell-top-pad",
    width: "100%",
    height: 1,
    flexShrink: 0,
    backgroundColor: UI.ground,
  })

  // Same gutter, other end: keeps the prompt box off the terminal's last row.
  const bottomPad = new BoxRenderable(ctx, {
    id: "shell-bottom-pad",
    width: "100%",
    height: 1,
    flexShrink: 0,
    backgroundColor: UI.ground,
  })

  // Optional chrome zones (off by default; setChromeZones turns them on).
  const goalBox = new BoxRenderable(ctx, {
    id: "shell-goal",
    width: "100%",
    height: 1,
    flexShrink: 0,
    backgroundColor: UI.ground,
    visible: false,
  })
  const goalText = new TextRenderable(ctx, {
    id: "shell-goal-text",
    content: "",
    fg: UI.text,
  })
  goalBox.add(goalText)

  const taskBox = new BoxRenderable(ctx, {
    id: "shell-task",
    width: "100%",
    height: 1,
    flexShrink: 0,
    backgroundColor: UI.ground,
    visible: false,
  })
  const taskText = new TextRenderable(ctx, {
    id: "shell-task-text",
    content: "",
    fg: UI.inFlight,
  })
  taskBox.add(taskText)

  const agentsBox = new BoxRenderable(ctx, {
    id: "shell-agents",
    width: "100%",
    height: 1,
    flexShrink: 0,
    backgroundColor: UI.ground,
    visible: false,
  })
  const agentsText = new TextRenderable(ctx, {
    id: "shell-agents-text",
    content: "",
    fg: UI.done,
  })
  agentsBox.add(agentsText)

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
  })

  const landingAbove = createLandingAbove(ctx)
  const landingBelowState = landingBelowContent({
    rows: splitLandingRows(layout.heights.transcript).below,
    columns: layout.contentWidth,
    telemetryNotice: options?.telemetryNotice,
  })
  const landingBelow = createLandingBelow(ctx, landingBelowState)

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
    borderColor: UI.action,
    backgroundColor: UI.ground,
    visible: false,
  })
  const overlayTitle = new TextRenderable(ctx, {
    id: "shell-overlay-title",
    content: " overlay",
    fg: UI.action,
  })
  const overlayBody = new BoxRenderable(ctx, {
    id: "shell-overlay-body",
    width: "100%",
    flexGrow: 1,
    flexDirection: "column",
    backgroundColor: UI.ground,
  })
  overlayHost.add(overlayTitle)
  overlayHost.add(overlayBody)

  // Transient only: the resolver gives it a row when paintChrome asks for one.
  const notice = new TextRenderable(ctx, {
    id: "shell-notice",
    height: Math.max(1, layout.heights.notice),
    content: "",
    fg: UI.textDim,
    visible: layout.heights.notice > 0,
  })

  const promptBox = new BoxRenderable(ctx, {
    id: "shell-prompt-region",
    width: "100%",
    height: Math.max(1, layout.heights.prompt),
    flexShrink: 0,
    flexDirection: "column",
    backgroundColor: UI.ground,
  })
  // The box is drawn in three pieces rather than as one bordered Box because
  // both horizontal rules carry content the frame's own border cannot: a
  // right-aligned label that the rule breaks around, and an animated lockup
  // whose cells are individually coloured.
  const promptTopRule = new TextRenderable(ctx, {
    id: "shell-prompt-top-rule",
    height: 1,
    content: "",
    fg: UI.textFaint,
  })
  const promptBottomRule = new TextRenderable(ctx, {
    id: "shell-prompt-bottom-rule",
    height: 1,
    content: "",
    fg: UI.textFaint,
  })
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
  })
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
  })
  promptField.add(prompt)
  promptBox.add(promptTopRule)
  promptBox.add(promptField)
  promptBox.add(promptBottomRule)

  root.add(topPad)
  root.add(goalBox)
  root.add(taskBox)
  root.add(agentsBox)
  root.add(transcript)
  root.add(overlayHost)
  root.add(notice)
  root.add(promptBox)
  root.add(landingBelow)
  root.add(bottomPad)

  if (mount) {
    renderer.root.add(root)
  }

  let disposed = false
  let session = createSessionQueue(run)
  const seedPending = Math.max(0, Math.floor(options?.pendingQueue ?? 0))
  for (let i = 0; i < seedPending; i++) {
    session = enqueue(session, `seed-${i + 1}`)
  }

  const onKey = (key: KeyEvent): void => {
    if (disposed) return

    if (key.name === "escape") {
      if (shell.overlayList) {
        key.preventDefault()
        closeInsetOverlay(shell)
        return
      }
      if (shell.observe) {
        key.preventDefault()
        leaveSubagentObserve(shell)
        return
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
      key.preventDefault()
      return
    }

    if (shell.overlayList) {
      // Checked ahead of the filter handlers: an opener chord pressed again is
      // a request to close, not a character to narrow the list with.
      if (toggleCloseOpenSurface(shell, key)) {
        key.preventDefault()
        return
      }
      // The `/` popup filters as you type, so it claims printable keys before
      // the overlay's j/k navigation can swallow them.
      if (handleSlashPopupKey(shell, key)) {
        key.preventDefault()
        return
      }
      // Same reason as the `/` popup: the `@` popup narrows as you type, so it
      // claims printable keys ahead of the overlay's j/k navigation.
      if (handleMentionPopupKey(shell, key)) {
        key.preventDefault()
        return
      }
      // The palette filters as you type, so it claims printable keys — including
      // the j/k every other overlay still uses to navigate.
      if (handlePaletteFilterKey(shell, key)) {
        key.preventDefault()
        return
      }
      if (key.name === "up" || key.name === "k") {
        key.preventDefault()
        moveOverlaySelection(shell, -1)
        return
      }
      if (key.name === "down" || key.name === "j") {
        key.preventDefault()
        moveOverlaySelection(shell, 1)
        return
      }
      if (key.name === "pageup") {
        key.preventDefault()
        pageOverlaySelection(shell, -1)
        return
      }
      if (key.name === "pagedown") {
        key.preventDefault()
        pageOverlaySelection(shell, 1)
        return
      }
      if (
        key.name === OVERLAY_EXPAND_KEY &&
        !key.ctrl &&
        !key.meta &&
        !key.option &&
        toggleOverlayExpand(shell)
      ) {
        key.preventDefault()
        return
      }
      if (shell.overlayKind === "copy") {
        if (key.name === "y" && !key.ctrl && !key.meta && !key.option) {
          key.preventDefault()
          confirmCopySelection(shell)
          return
        }
        if (key.name === "a" && !key.ctrl && !key.meta && !key.option) {
          key.preventDefault()
          copyAllTargets(shell)
          return
        }
      }
      if (key.name === "return" || key.name === "enter") {
        if (!key.meta && !key.option && !key.ctrl) {
          key.preventDefault()
          acceptOverlaySelection(shell)
          return
        }
      }
      return
    }

    // Emacs-style prompt editing: Ctrl+B/F/D, arrow motion, and Alt+B/F word
    // motion are already native InputRenderable bindings (see
    // defaultTextareaKeyBindings in @opentui/core). What's missing is the
    // kill ring — Ctrl+K/U/W and Alt+D delete natively but discard the text;
    // Ctrl+Y/Alt+Y need somewhere to yank it back from.
    const keyName = typeof key.name === "string" ? key.name.toLowerCase() : ""
    const isCtrlKillYank =
      key.ctrl &&
      !key.meta &&
      !key.option &&
      (keyName === "k" || keyName === "u" || keyName === "w" || keyName === "y")
    const isAltKillYank =
      (key.meta || key.option) && !key.ctrl && (keyName === "d" || keyName === "y")
    if (!isCtrlKillYank && !isAltKillYank) {
      shell.promptKillRing = breakKillSequence(shell.promptKillRing)
    }

    if (key.ctrl && !key.meta && !key.option && keyName === "k") {
      key.preventDefault()
      const before = shell.prompt.value
      const beforeCursor = shell.prompt.cursorOffset
      shell.prompt.deleteToLineEnd()
      const killed = killedTextForward(before, beforeCursor, shell.prompt.value)
      shell.promptKillRing = recordKill(shell.promptKillRing, killed, "forward")
      return
    }

    if (key.ctrl && !key.meta && !key.option && keyName === "u") {
      key.preventDefault()
      const before = shell.prompt.value
      const beforeCursor = shell.prompt.cursorOffset
      shell.prompt.deleteToLineStart()
      const killed = killedTextBackward(before, beforeCursor, shell.prompt.cursorOffset)
      shell.promptKillRing = recordKill(shell.promptKillRing, killed, "backward")
      return
    }

    if (key.ctrl && !key.meta && !key.option && keyName === "w") {
      key.preventDefault()
      const before = shell.prompt.value
      const beforeCursor = shell.prompt.cursorOffset
      shell.prompt.deleteWordBackward()
      const killed = killedTextBackward(before, beforeCursor, shell.prompt.cursorOffset)
      shell.promptKillRing = recordKill(shell.promptKillRing, killed, "backward")
      return
    }

    if ((key.meta || key.option) && !key.ctrl && keyName === "d") {
      key.preventDefault()
      const before = shell.prompt.value
      const beforeCursor = shell.prompt.cursorOffset
      shell.prompt.deleteWordForward()
      const killed = killedTextForward(before, beforeCursor, shell.prompt.value)
      shell.promptKillRing = recordKill(shell.promptKillRing, killed, "forward")
      return
    }

    if (key.ctrl && !key.meta && !key.option && keyName === "y") {
      key.preventDefault()
      const yank = beginYank(shell.promptKillRing, shell.prompt.cursorOffset)
      if (yank !== null) {
        shell.promptKillRing = yank.ring
        shell.prompt.insertText(yank.text)
      }
      return
    }

    if ((key.meta || key.option) && !key.ctrl && keyName === "y") {
      key.preventDefault()
      const rotated = rotateYank(shell.promptKillRing)
      if (rotated !== null && rotated.span.end <= shell.prompt.value.length) {
        shell.promptKillRing = rotated.ring
        shell.prompt.setSelection(rotated.span.start, rotated.span.end)
        shell.prompt.deleteSelection()
        shell.prompt.cursorOffset = rotated.span.start
        shell.prompt.insertText(rotated.text)
      }
      return
    }

    if (key.ctrl && !key.meta && !key.option && keyName === "p") {
      key.preventDefault()
      void attachClipboardImage(shell)
      return
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
      const before = shell.prompt.value.slice(0, shell.prompt.cursorOffset)
      if (before.length === 0 || /\s$/.test(before)) {
        key.preventDefault()
        shell.prompt.insertText("@")
        void openAtMentionSuggestions(shell)
        return
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
      key.preventDefault()
      setPromptText(shell, "/")
      openSlashCommands(shell)
      return
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
            ? stepSentHistoryDown(
                shell.sentHistory,
                shell.prompt.value,
                shell.prompt.value.length,
              )
            : null
      if (stepped !== null) {
        key.preventDefault()
        shell.sentHistory = stepped.browse
        shell.prompt.value = stepped.value
        shell.prompt.cursorOffset = stepped.cursor
        return
      }
    } else if (!MOTION_KEYS.has(keyName)) {
      shell.sentHistory = sentHistoryOnEdit(shell.sentHistory)
    }

    if (key.name === "tab" && !key.ctrl && !key.meta && !key.option) {
      key.preventDefault()
      toggleShellFocus(shell)
      return
    }

    // Bare key, so it is live only while the transcript holds focus and can
    // never shadow typing into the prompt.
    if (
      !key.ctrl &&
      !key.meta &&
      !key.option &&
      key.name === EXPAND_KEY &&
      focusOwner(shell.focus) === "transcript"
    ) {
      if (toggleCollapsedRow(shell)) {
        key.preventDefault()
        return
      }
    }

    // Bare key, so it is live only while the transcript holds focus and can
    // never shadow a `?` typed into the prompt.
    if (
      !key.ctrl &&
      !key.meta &&
      !key.option &&
      key.sequence === "?" &&
      focusOwner(shell.focus) === "transcript"
    ) {
      key.preventDefault()
      openHelpOverlay(shell)
      return
    }

    if (key.ctrl && (key.name === "o" || key.name === "O")) {
      // Ctrl+O reclaimed from tool-expand → command palette (Wave 6).
      key.preventDefault()
      openPalette(shell, { typeToFilter: true })
      return
    }

    if ((key.meta || key.option) && (key.name === "c" || key.name === "C") && !key.ctrl) {
      // Alt+C: keyboard copy path (no mouse drag-select).
      key.preventDefault()
      enterCopyMode(shell)
      return
    }

    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      handleCtrlC(shell)
      return
    }

    if (
      (key.name === "return" || key.name === "enter") &&
      (key.meta || key.option) &&
      !key.ctrl
    ) {
      key.preventDefault()
      if (shell.session.run === "busy") {
        submitPrompt(shell, "steer")
      }
      return
    }
  }

  const onEnter = (): void => {
    if (disposed || shell.overlayList) return
    submitPrompt(shell, "queue")
  }

  // Per frame rather than per keystroke: the editor view's wrapped-line table is
  // rebuilt during layout, so on the content-changed callback it still describes
  // the text before the edit and the box would size itself one keystroke behind.
  const onFrame = (): void => {
    if (disposed) return
    syncPromptRows(shell)
  }

  const onResize = (width: number, height: number): void => {
    if (disposed) return
    const bag = internals.get(shell)
    relayout(shell, {
      columns: width,
      rows: height,
      overlayMode: bag?.overlayMode ?? "closed",
      ...(bag?.overlayBodyRows !== undefined
        ? { overlayBodyRows: bag.overlayBodyRows }
        : {}),
    })
  }

  if (wireKeys) {
    renderer.keyInput.on("keypress", onKey)
    prompt.onSubmit = onEnter
  }
  renderer.on(CliRenderEvents.FRAME, onFrame)
  renderer.on(CliRenderEvents.RESIZE, onResize)

  const shell: AppShell = {
    renderer,
    root,
    topPad,
    bottomPad,
    goalBox,
    goalText,
    taskBox,
    taskText,
    agentsBox,
    agentsText,
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
    clipboard: createRecordingClipboard(),
    copyTargets: null,
    statusFlash: null,
    turnPhase: null,
    lockupNowMs: 0,
    lockupAnimating: false,
    lockupPhase: null,
    lockupChangedMs: 0,
    observe: null,
    parentStreamLog: null,
    promptKillRing: emptyKillRing,
    pendingAttachments: [],
    sentHistory: createSentHistoryBrowse([]),
    dispose: () => {
      if (disposed) return
      disposed = true
      if (wireKeys) {
        renderer.keyInput.off("keypress", onKey)
        prompt.onSubmit = undefined
      }
      renderer.off(CliRenderEvents.FRAME, onFrame)
      renderer.off(CliRenderEvents.RESIZE, onResize)
      try {
        renderer.root.remove(root)
      } catch {
        // Root may already be torn down in tests.
      }
      root.destroy()
    },
  }

  internals.set(shell, {
    visibility,
    promptContentRows,
    overlayMode: "closed",
    overlayBodyRows: undefined,
    priorOverlay: null,
    overlayItemIds: [],
    overlayOnAccept: null,
    overlayOnToggleExpand: null,
    paletteCatalog: paletteCatalogOpt,
    paletteFilter: null,
    landing: { above: landingAbove, below: landingBelow },
    landingNotice: options?.telemetryNotice ?? null,
    landingBelow: landingBelowState,
    landingSuggestionsVisible: true,
    landingAnimating: false,
    landingNowMs: 0,
    chrome: { goal: "", task: "", agents: "" },
  })
  if (onCommandOpt) setPaletteOnCommand(shell, onCommandOpt)
  if (onObserveRequestOpt) {
    setPaletteOnObserveRequest(shell, onObserveRequestOpt)
  }
  applyLayout(shell, layout)
  // Added after the first layout pass so the scroll box sizes it against the
  // resolved transcript height rather than the pre-layout placeholder.
  transcript.add(landingAbove.box)
  applyFocus(shell)
  return shell
}
