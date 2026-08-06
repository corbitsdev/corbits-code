/**
 * OpenTUI app shell — header, sticky transcript, prompt chrome, status, inset overlay.
 *
 * Wave 3 product skin on the Wave 2 platform. Functional wrappers around
 * @opentui/core class renderables. Not wired to production CLI; Ink remains production.
 */

import {
  BoxRenderable,
  CliRenderEvents,
  InputRenderable,
  InputRenderableEvents,
  MarkdownRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  TextTableRenderable,
  type CliRenderer,
  type KeyEvent,
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
import {
  promptHintWithAttachments,
  spliceMentionCompletion,
} from "./prompt-attachments.js"
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
  resolveGeometry,
  type GeometryLayout,
  type OverlayMode,
  type ZoneVisibility,
} from "./geometry/index.js"
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
  isResidualActionId,
  paletteDispatchOf,
  paletteLabels,
  type PaletteActionId,
  type PaletteCommand,
} from "./palette.js"
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
  PROMPT_HINT,
  isMarkdownRow,
  paintStreamRow,
  sessionHeaderTitle,
  streamRowGutter,
  transcriptSyntaxStyle,
  type StreamRow,
} from "./stream.js"
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
  /** Header base title. Default "corbits". */
  readonly title?: string
  /** Zone visibility overrides for resolveGeometry. model_bar off by default. */
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
}

export type AppShell = {
  readonly renderer: ShellRenderer
  readonly root: BoxRenderable
  readonly header: TextRenderable
  readonly headerBox: BoxRenderable
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
  readonly prompt: InputRenderable
  readonly modelBar: TextRenderable
  readonly promptBox: BoxRenderable
  readonly hint: TextRenderable
  readonly status: TextRenderable
  readonly statusBox: BoxRenderable
  /** Latest geometry resolution (updated on resize / relayout). */
  layout: GeometryLayout
  /** Focus tree + scroll lease (updated by shell helpers). */
  focus: FocusState
  /** Session queue / steer / interrupt bag. */
  session: SessionQueueState
  /** Pending queue count (mirrors badgeCount(session); kept for status API). */
  pendingQueue: number
  /** Transcript line count (append counter / full log length). */
  lineCount: number
  /** Full stream log (windowed paint; never unbounded render tree). */
  streamLog: StreamRow[]
  /** Base title without BUSY/IDLE tag. */
  baseTitle: string
  /** Composed `profile · model · effort` label for the model_bar zone. */
  modelLabel: string | null
  /** Overlay list viewport (null when closed). */
  overlayList: ListViewportState | null
  /** Overlay item labels currently shown. */
  overlayItems: readonly string[]
  /** Which primary overlay is open (null when closed). */
  overlayKind: PrimaryOverlayKind | null
  /** Optional long body lines painted above the list (operator question). */
  overlayBodyLines: readonly string[]
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
   * Short status-line flash (copy feedback, etc.). Cleared when replaced or
   * set to null; never appended to the stream log.
   */
  statusFlash: string | null
  /**
   * Live turn phase ("Thinking…", "Running tool…", …) or null when idle.
   * Lives on the status row rather than a chrome zone because the product host
   * owns the goal/task/agents zones and overwrites them wholesale on every
   * snapshot push, which would clobber a per-token progress line.
   */
  turnPhase: string | null
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
   * the InputRenderable itself has no concept of a kill ring (see
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
    modelBar: false,
    header: 2,
    progress: false,
    progressDivider: false,
    status: 1,
    ...visibility,
  }
}

/** Whether the transcript viewport is stuck to the bottom (FOLLOW vs PINNED). */
export function isTranscriptFollowing(shell: AppShell): boolean {
  const { transcript } = shell
  const max = Math.max(0, transcript.scrollHeight - transcript.height)
  return transcript.scrollTop >= max - 1
}

/** Status mode label from sticky state. */
export function stickyMode(shell: AppShell): "FOLLOW" | "PINNED" {
  return isTranscriptFollowing(shell) ? "FOLLOW" : "PINNED"
}

function syncPending(shell: AppShell): void {
  shell.pendingQueue = badgeCount(shell.session)
}

/** Rebuild status + header from focus, sticky, session, overlay. */
export function paintStatus(shell: AppShell): void {
  syncPending(shell)
  const mode = stickyMode(shell)
  const owner = focusOwner(shell.focus)
  const interrupt = shell.session.interruptFlash ? " · INTERRUPT" : ""
  const statusFlash =
    shell.statusFlash && shell.statusFlash.length > 0
      ? ` · ${shell.statusFlash}`
      : ""
  const phase =
    shell.turnPhase && shell.turnPhase.length > 0 ? ` · ${shell.turnPhase}` : ""
  const run = shell.session.run.toUpperCase()
  shell.status.content =
    ` ${mode} · ${run}${phase} · queue ${shell.pendingQueue} · focus ${owner}${interrupt}${statusFlash} · lines ${shell.lineCount}`
  shell.header.content = ` ${sessionHeaderTitle(shell.baseTitle, shell.session.run)}`
  shell.hint.content = ` ${promptHintWithAttachments(PROMPT_HINT, shell.pendingAttachments)}`
}

/** Queue an image for the next submit and reflect it in the prompt hint. */
export function addPendingAttachment(
  shell: AppShell,
  attachment: PendingImageAttachment,
): void {
  shell.pendingAttachments = [...shell.pendingAttachments, attachment]
  paintStatus(shell)
}

export function clearPendingAttachments(shell: AppShell): void {
  shell.pendingAttachments = []
  paintStatus(shell)
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

/** Set a non-destructive status flash and repaint (does not touch streamLog). */
export function setStatusFlash(shell: AppShell, message: string | null): void {
  shell.statusFlash = message
  paintStatus(shell)
}

/** Set the live turn phase label (null hides it). Repaints only on change. */
export function setTurnPhase(shell: AppShell, phase: string | null): void {
  if (shell.turnPhase === phase) return
  shell.turnPhase = phase
  paintStatus(shell)
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
  paintStatus(shell)
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

function paintOverlayList(shell: AppShell): void {
  const list = shell.overlayList
  clearOverlayBody(shell)
  if (!list) return

  for (const line of shell.overlayBodyLines) {
    shell.overlayBody.add(
      new TextRenderable(shell.renderer as CliRenderer, {
        content: ` ${line}`,
        fg: "#a9b1d6",
      }),
    )
  }

  const slice = visibleSlice(list)
  for (let i = slice.start; i < slice.end; i++) {
    const label = shell.overlayItems[i] ?? `item ${i}`
    const active = i === list.activeIndex
    shell.overlayBody.add(
      new TextRenderable(shell.renderer as CliRenderer, {
        content: ` ${active ? ">" : " "} ${label}`,
        fg: active ? "#c0caf5" : "#565f89",
      }),
    )
  }
}

/** Apply geometry heights to chrome regions including overlay host. */
/**
 * Right-align the model label in the always-on model_bar zone. Padding is
 * recomputed on every layout pass because a resize changes the column budget
 * without changing the label.
 */
function paintModelBar(shell: AppShell): void {
  const label = shell.modelLabel
  const rows = Math.max(0, shell.layout.heights.model_bar)
  shell.modelBar.visible = rows > 0 && label !== null
  shell.modelBar.height = rows > 0 ? rows : 1
  if (label === null) {
    shell.modelBar.content = ""
    return
  }
  const pad = Math.max(0, shell.renderer.width - stringWidth(label) - 1)
  shell.modelBar.content = `${" ".repeat(pad)}${label}`
}

/** Publish the `profile · model · effort` line above the prompt border. */
export function setPromptModelLabel(
  shell: AppShell,
  input: PromptActionBarModelLabelInput,
): void {
  const label = composePromptActionBarModelLabel(input) ?? null
  if (label === shell.modelLabel) return
  shell.modelLabel = label
  // The zone is off by default so shells with no model state (demo, smoke)
  // don't spend a row on it; claim it only once there is something to paint.
  const bag = internals.get(shell)
  const visibility = { ...(bag?.visibility ?? defaultVisibility()), modelBar: label !== null }
  relayout(shell, { visibility })
}

export function applyLayout(shell: AppShell, layout: GeometryLayout): void {
  shell.layout = layout
  const h = layout.heights

  const headerH = Math.max(1, h.header)
  shell.headerBox.height = headerH
  shell.headerBox.visible = headerH > 0

  const goalH = Math.max(0, h.goal)
  shell.goalBox.height = goalH > 0 ? goalH : 1
  shell.goalBox.visible = goalH > 0

  const taskH = Math.max(0, h.task)
  shell.taskBox.height = taskH > 0 ? taskH : 1
  shell.taskBox.visible = taskH > 0

  const agentsH = Math.max(0, h.agents)
  shell.agentsBox.height = agentsH > 0 ? agentsH : 1
  shell.agentsBox.visible = agentsH > 0

  const transcriptH = Math.max(0, h.transcript)
  shell.transcript.height = transcriptH > 0 ? transcriptH : 1
  shell.transcript.visible = transcriptH > 0

  const overlayH = Math.max(0, h.overlay_host)
  shell.overlayHost.height = overlayH > 0 ? overlayH : 1
  shell.overlayHost.visible = overlayH > 0
  if (overlayH > 0 && shell.overlayList) {
    // Title row + optional body lines + list viewport.
    const chrome = 1 + shell.overlayBodyLines.length
    const bodyH = Math.max(1, overlayH - chrome)
    shell.overlayList = setListHeight(shell.overlayList, bodyH)
    paintOverlayList(shell)
  }

  paintModelBar(shell)

  const promptH = Math.max(1, h.prompt)
  shell.promptBox.height = promptH
  shell.promptBox.visible = promptH > 0

  const statusH = Math.max(1, h.status)
  shell.statusBox.height = statusH
  shell.statusBox.visible = statusH > 0

  paintStatus(shell)
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
  shell.lineCount += 1
  const id = String(shell.lineCount).padStart(4, "0")
  shell.transcript.add(
    new TextRenderable(shell.renderer as CliRenderer, {
      content: ` ${id}  ${line}`,
      fg: opts?.fg ?? "#a9b1d6",
    }),
  )
  paintStatus(shell)
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

/** Paint + push onto the visible streamLog (child while observing, parent otherwise). */
function paintAppendStreamRow(shell: AppShell, row: StreamRow): void {
  shell.streamLog.push(row)
  shell.lineCount = shell.streamLog.length

  // Under collapse threshold: append one paint node (cheap).
  // Over threshold: rebuild the windowed paint tree only.
  if (!mustWindow(shell.streamLog.length)) {
    shell.transcript.add(createStreamRowRenderable(shell, row, shell.lineCount))
    paintStatus(shell)
    return
  }

  repaintTranscriptWindow(shell)
  paintStatus(shell)
}

/** Rebuild transcript paint tree from the long-log window (O(window), not O(total)). */
export function repaintTranscriptWindow(shell: AppShell): void {
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
        fg: "#565f89",
      }),
    )
  }
  for (let i = 0; i < win.rows.length; i++) {
    shell.transcript.add(
      createStreamRowRenderable(shell, win.rows[i]!, win.start + i + 1),
    )
  }
}

/**
 * Build the paint node for one transcript row.
 * Markdown-bearing rows (assistant replies) get a MarkdownRenderable body next
 * to a plain gutter; structured rows (MCP results) get a TextTableRenderable;
 * every other role stays literal text.
 */
export function createStreamRowRenderable(
  shell: AppShell,
  row: StreamRow,
  lineNumber: number,
): TextRenderable | BoxRenderable {
  const ctx = shell.renderer as CliRenderer
  const id = String(lineNumber).padStart(4, "0")

  if (row.structured !== undefined) {
    return createStructuredRowRenderable(ctx, row, row.structured, id)
  }

  if (!isMarkdownRow(row)) {
    const painted = paintStreamRow(row)
    return new TextRenderable(ctx, {
      content: ` ${id}${painted.content}`,
      fg: painted.fg,
    })
  }

  const gutter = streamRowGutter(row)
  const wrapper = new BoxRenderable(ctx, {
    flexDirection: "row",
    width: "100%",
  })
  wrapper.add(
    new TextRenderable(ctx, {
      content: ` ${id}${gutter.content}`,
      fg: gutter.fg,
      flexShrink: 0,
    }),
  )
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

/** Gutter + native table body for a structured (MCP result) row. */
function createStructuredRowRenderable(
  ctx: CliRenderer,
  row: StreamRow,
  view: McpStructuredView,
  id: string,
): BoxRenderable {
  const gutter = streamRowGutter(row)
  const wrapper = new BoxRenderable(ctx, {
    flexDirection: "row",
    width: "100%",
  })
  wrapper.add(
    new TextRenderable(ctx, {
      content: ` ${id}${gutter.content}`,
      fg: gutter.fg,
      flexShrink: 0,
    }),
  )
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
  paintStatus(shell)
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
  paintStatus(shell)
}

export function setShellRunState(shell: AppShell, run: RunState): void {
  shell.session = setRunState(shell.session, run)
  paintStatus(shell)
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
  paintStatus(shell)
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
  paintStatus(shell)
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
  paintStatus(shell)
}

const OVERLAY_FRAME_ID = "inset-demo"

/** Wrap body text for the overlay host (shared with overlays.ts). */
export function wrapShellOverlayBody(
  text: string,
  width: number,
  maxLines = 8,
): readonly string[] {
  const w = Math.max(8, Math.floor(width))
  const cap = Math.max(1, Math.floor(maxLines))
  const lines: string[] = []
  for (const raw of text.split("\n")) {
    if (raw.length === 0) {
      lines.push("")
      if (lines.length >= cap) break
      continue
    }
    let rest = raw
    while (rest.length > 0 && lines.length < cap) {
      lines.push(rest.slice(0, w))
      rest = rest.slice(w)
    }
    if (lines.length >= cap) break
  }
  return lines.slice(0, cap)
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

  const cols = Math.max(20, shell.renderer.width || 80)
  const bodyText = opts?.body ?? ""
  // Operator question and permission approval context get body lines; other
  // list-only overlays keep the body empty.
  const maxBody =
    shell.overlayKind === "operator" || shell.overlayKind === "permissions" ? 8 : 0
  shell.overlayBodyLines =
    bodyText.length > 0
      ? wrapShellOverlayBody(bodyText, cols - 4, maxBody)
      : []

  const rows = shell.renderer.height || 24
  // Request ~30% of terminal for list rows; geometry will cap against floor.
  const listH = Math.max(3, Math.floor(rows * 0.3))
  const hostRows = 1 + shell.overlayBodyLines.length + listH

  shell.overlayList = createListViewport({
    count: labels.length,
    height: listH,
    activeIndex: opts?.activeIndex ?? 0,
  })

  const title = opts?.title ?? "permission"
  shell.overlayTitle.content = ` ${title} · Esc cancel · Enter choose`

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
  opts?: { readonly query?: string; readonly catalog?: readonly PaletteCommand[] },
): void {
  const catalog = opts?.catalog ?? resolvePaletteCatalog(shell)
  const filtered = filterPaletteCommands(opts?.query ?? "", catalog)
  const commands = filtered.length > 0 ? filtered : []
  const labels =
    commands.length > 0 ? paletteLabels(commands) : ["(no matches)"]
  shell.paletteCommands = commands
  openListOverlay(shell, {
    kind: "palette",
    title: "palette · Ctrl+O",
    items: labels,
    frameId: "command-palette",
  })
}

/** Close overlay/palette if open; restore prior focus (or prior overlay under palette). */
export function closeInsetOverlay(shell: AppShell): void {
  if (!shell.overlayList) return

  const wasPalette = shell.overlayKind === "palette"
  const bag = internals.get(shell)
  const prior = wasPalette ? bag?.priorOverlay ?? null : null

  shell.overlayList = null
  shell.overlayKind = null
  shell.overlayBodyLines = []
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
    const hostRows = 1 + prior.bodyLines.length + listH
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
export const OVERLAY_EXPAND_KEY = "e"

/** Replace the open overlay's body text in place (re-wrap + relayout). */
export function setOverlayBody(
  shell: AppShell,
  text: string,
  maxLines = 8,
): void {
  if (!shell.overlayList) return
  const cols = Math.max(20, shell.renderer.width || 80)
  shell.overlayBodyLines =
    text.length > 0 ? wrapShellOverlayBody(text, cols - 4, maxLines) : []
  const hostRows =
    1 + shell.overlayBodyLines.length + shell.overlayList.height
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
    setStatusFlash(shell, "Nothing to copy")
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
    setStatusFlash(shell, "Nothing to copy")
    closeInsetOverlay(shell)
    return false
  }
  const idx = Math.max(
    0,
    Math.min(targets.length - 1, shell.overlayList.activeIndex),
  )
  const target = targets[idx]
  if (!target) {
    setStatusFlash(shell, "Nothing to copy")
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
    setStatusFlash(shell, "Nothing to copy")
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
  paintStatus(shell)
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
  paintStatus(shell)
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
  if (at === null) return false

  const cursor = shell.prompt.cursorOffset
  const source = shellMentionSource.get(shell) ?? defaultMentionSource
  const suggestions = await source(at.prefix)
  if (suggestions.length === 0) {
    setStatusFlash(shell, `no matches for @${at.prefix}`)
    return false
  }

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
  return true
}

/**
 * Build the app shell frame on an OpenTUI renderer.
 * Mounts header / sticky transcript / overlay host / prompt+hint / status.
 */
export function createAppShell(
  renderer: ShellRenderer,
  options?: AppShellOptions,
): AppShell {
  const title = options?.title ?? DEFAULT_TITLE
  const visibility = defaultVisibility(options?.visibility)
  // Bordered input (3) + hint row (1) — request 4 so geometry keeps status on-screen.
  const promptContentRows = options?.promptContentRows ?? 4
  const wireKeys = options?.wireKeys !== false
  const mount = options?.mount !== false
  const run = options?.run ?? "busy"
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
    backgroundColor: "#1a1b26",
  })

  const headerBox = new BoxRenderable(ctx, {
    id: "shell-header",
    width: "100%",
    height: Math.max(1, layout.heights.header),
    flexShrink: 0,
    backgroundColor: "#3d59a1",
    paddingLeft: 0,
  })
  const header = new TextRenderable(ctx, {
    id: "shell-header-text",
    content: ` ${sessionHeaderTitle(title, run)}`,
    fg: "#c0caf5",
  })
  headerBox.add(header)

  // Optional chrome zones (off by default; setChromeZones turns them on).
  const goalBox = new BoxRenderable(ctx, {
    id: "shell-goal",
    width: "100%",
    height: 1,
    flexShrink: 0,
    backgroundColor: "#292e42",
    visible: false,
  })
  const goalText = new TextRenderable(ctx, {
    id: "shell-goal-text",
    content: "",
    fg: "#bb9af7",
  })
  goalBox.add(goalText)

  const taskBox = new BoxRenderable(ctx, {
    id: "shell-task",
    width: "100%",
    height: 1,
    flexShrink: 0,
    backgroundColor: "#292e42",
    visible: false,
  })
  const taskText = new TextRenderable(ctx, {
    id: "shell-task-text",
    content: "",
    fg: "#7dcfff",
  })
  taskBox.add(taskText)

  const agentsBox = new BoxRenderable(ctx, {
    id: "shell-agents",
    width: "100%",
    height: 1,
    flexShrink: 0,
    backgroundColor: "#292e42",
    visible: false,
  })
  const agentsText = new TextRenderable(ctx, {
    id: "shell-agents-text",
    content: "",
    fg: "#9ece6a",
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
    rootOptions: { backgroundColor: "#1a1b26" },
    contentOptions: { backgroundColor: "#1a1b26" },
    viewportOptions: { backgroundColor: "#1a1b26" },
  })

  const overlayHost = new BoxRenderable(ctx, {
    id: "shell-overlay-host",
    width: "100%",
    height: 1,
    flexShrink: 0,
    flexDirection: "column",
    border: true,
    borderColor: "#e0af68",
    backgroundColor: "#1f2335",
    visible: false,
  })
  const overlayTitle = new TextRenderable(ctx, {
    id: "shell-overlay-title",
    content: " overlay",
    fg: "#e0af68",
  })
  const overlayBody = new BoxRenderable(ctx, {
    id: "shell-overlay-body",
    width: "100%",
    flexGrow: 1,
    flexDirection: "column",
    backgroundColor: "#1f2335",
  })
  overlayHost.add(overlayTitle)
  overlayHost.add(overlayBody)

  const modelBar = new TextRenderable(ctx, {
    id: "shell-model-bar",
    height: 1,
    content: "",
    fg: "#565f89",
    visible: false,
  })

  const promptBox = new BoxRenderable(ctx, {
    id: "shell-prompt-region",
    width: "100%",
    height: Math.max(1, layout.heights.prompt),
    flexShrink: 0,
    flexDirection: "column",
    backgroundColor: "#1a1b26",
  })
  // Bordered input: top border + field + bottom border = 3 rows.
  const promptFrame = new BoxRenderable(ctx, {
    id: "shell-prompt-frame",
    width: "100%",
    height: 3,
    flexShrink: 0,
    border: true,
    borderColor: "#414868",
    focusedBorderColor: "#7aa2f7",
    backgroundColor: "#24283b",
    paddingLeft: 1,
    paddingRight: 1,
  })
  const prompt = new InputRenderable(ctx, {
    id: "shell-prompt",
    width: "100%",
    placeholder: "message…",
    backgroundColor: "#24283b",
    focusedBackgroundColor: "#414868",
    textColor: "#c0caf5",
    cursorColor: "#7aa2f7",
    placeholderColor: "#565f89",
  })
  const hint = new TextRenderable(ctx, {
    id: "shell-prompt-hint",
    height: 1,
    content: ` ${PROMPT_HINT}`,
    fg: "#565f89",
  })
  promptFrame.add(prompt)
  promptBox.add(promptFrame)
  promptBox.add(hint)

  const statusBox = new BoxRenderable(ctx, {
    id: "shell-status",
    width: "100%",
    height: Math.max(1, layout.heights.status),
    flexShrink: 0,
    backgroundColor: "#9ece6a",
  })
  const status = new TextRenderable(ctx, {
    id: "shell-status-text",
    content: " FOLLOW · BUSY · queue 0 · focus prompt · lines 0",
    fg: "#1a1b26",
  })
  statusBox.add(status)

  root.add(headerBox)
  root.add(goalBox)
  root.add(taskBox)
  root.add(agentsBox)
  root.add(transcript)
  root.add(overlayHost)
  root.add(modelBar)
  root.add(promptBox)
  root.add(statusBox)

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

    if (shell.overlayList) {
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

    if (
      !key.ctrl &&
      !key.meta &&
      !key.option &&
      (key.name === "up" || key.name === "down") &&
      focusOwner(shell.focus) === "prompt"
    ) {
      const stepped =
        key.name === "up"
          ? shell.prompt.cursorOffset === 0
            ? stepSentHistoryUp(shell.sentHistory, shell.prompt.value)
            : null
          : stepSentHistoryDown(
              shell.sentHistory,
              shell.prompt.value,
              shell.prompt.cursorOffset,
            )
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

    if (key.ctrl && (key.name === "o" || key.name === "O")) {
      // Ctrl+O reclaimed from tool-expand → command palette (Wave 6).
      key.preventDefault()
      openPalette(shell)
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
      if (shell.session.run === "busy" || badgeCount(shell.session) > 0) {
        interruptShell(shell)
      } else if (shell.prompt.value.length > 0) {
        shell.prompt.value = ""
        paintStatus(shell)
      }
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

  const onEnter = (_value: string): void => {
    if (disposed || shell.overlayList) return
    submitPrompt(shell, "queue")
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
    prompt.on(InputRenderableEvents.ENTER, onEnter)
  }
  renderer.on(CliRenderEvents.RESIZE, onResize)

  const shell: AppShell = {
    renderer,
    root,
    header,
    headerBox,
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
    modelBar,
    promptBox,
    hint,
    status,
    statusBox,
    layout,
    focus: createFocusState(),
    session,
    pendingQueue: badgeCount(session),
    lineCount: 0,
    streamLog: [],
    baseTitle: title,
    modelLabel: null,
    overlayList: null,
    overlayItems,
    overlayKind: null,
    overlayBodyLines: [],
    paletteCommands: [],
    clipboard: createRecordingClipboard(),
    copyTargets: null,
    statusFlash: null,
    turnPhase: null,
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
        prompt.off(InputRenderableEvents.ENTER, onEnter)
      }
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
    chrome: { goal: "", task: "", agents: "" },
  })
  if (onCommandOpt) setPaletteOnCommand(shell, onCommandOpt)
  if (onObserveRequestOpt) {
    setPaletteOnObserveRequest(shell, onObserveRequestOpt)
  }
  applyLayout(shell, layout)
  applyFocus(shell)
  return shell
}
