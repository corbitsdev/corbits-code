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
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core"

import {
  createFocusState,
  focusOwner,
  focusPrompt,
  focusTranscript,
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
  visibleSlice,
  type ListViewportState,
} from "./list-viewport.js"
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
  paintStreamRow,
  sessionHeaderTitle,
  type StreamRow,
} from "./stream.js"

/** Optional Wave-4 bridge hooks (runtime-bridge attaches exclusively). */
export type ShellBridgeHooks = {
  onSubmit: (text: string, kind: "queue" | "steer" | "immediate") => void
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
}

export type AppShell = {
  readonly renderer: ShellRenderer
  readonly root: BoxRenderable
  readonly header: TextRenderable
  readonly headerBox: BoxRenderable
  readonly transcript: ScrollBoxRenderable
  readonly overlayHost: BoxRenderable
  readonly overlayTitle: TextRenderable
  readonly overlayBody: BoxRenderable
  readonly prompt: InputRenderable
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
  /** Transcript line count (append counter). */
  lineCount: number
  /** Base title without BUSY/IDLE tag. */
  baseTitle: string
  /** Overlay list viewport (null when closed). */
  overlayList: ListViewportState | null
  /** Overlay item labels currently shown. */
  overlayItems: readonly string[]
  /** Detach key/resize listeners and unmount root. */
  dispose: () => void
}

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
  const flash = shell.session.interruptFlash ? " · INTERRUPT" : ""
  const run = shell.session.run.toUpperCase()
  shell.status.content =
    ` ${mode} · ${run} · queue ${shell.pendingQueue} · focus ${owner}${flash} · lines ${shell.lineCount}`
  shell.header.content = ` ${sessionHeaderTitle(shell.baseTitle, shell.session.run)}`
  shell.hint.content = ` ${PROMPT_HINT}`
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
export function applyLayout(shell: AppShell, layout: GeometryLayout): void {
  shell.layout = layout
  const h = layout.heights

  const headerH = Math.max(1, h.header)
  shell.headerBox.height = headerH
  shell.headerBox.visible = headerH > 0

  const transcriptH = Math.max(0, h.transcript)
  shell.transcript.height = transcriptH > 0 ? transcriptH : 1
  shell.transcript.visible = transcriptH > 0

  const overlayH = Math.max(0, h.overlay_host)
  shell.overlayHost.height = overlayH > 0 ? overlayH : 1
  shell.overlayHost.visible = overlayH > 0
  if (overlayH > 0 && shell.overlayList) {
    const bodyH = Math.max(1, overlayH - 1)
    shell.overlayList = {
      ...shell.overlayList,
      height: bodyH,
    }
    paintOverlayList(shell)
  }

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

type ShellInternals = {
  visibility: ZoneVisibility
  promptContentRows: number | undefined
  overlayMode: OverlayMode
  overlayBodyRows: number | undefined
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

/** Append a role-styled stream row (user / assistant / tool / system). */
export function appendStreamRow(shell: AppShell, row: StreamRow): void {
  const painted = paintStreamRow(row)
  shell.lineCount += 1
  const id = String(shell.lineCount).padStart(4, "0")
  shell.transcript.add(
    new TextRenderable(shell.renderer as CliRenderer, {
      content: ` ${id}${painted.content}`,
      fg: painted.fg,
    }),
  )
  paintStatus(shell)
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
  if (t.length === 0) return

  const hooks = getShellBridgeHooks(shell)
  if (hooks?.exclusive) {
    shell.prompt.value = ""
    const resolved: "queue" | "steer" | "immediate" =
      shell.session.run === "idle" ? "immediate" : kind
    hooks.onSubmit(text, resolved)
    return
  }

  if (shell.session.run === "idle") {
    appendStreamRow(shell, { role: "user", text: t })
    shell.prompt.value = ""
    return
  }

  shell.session =
    kind === "steer" ? enqueueSteer(shell.session, t) : enqueue(shell.session, t)
  shell.prompt.value = ""
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

/** Open inset permission/palette stub; focus stack owns keys; Esc closes. */
export function openInsetOverlay(
  shell: AppShell,
  items?: readonly string[],
): void {
  if (shell.overlayList) return
  const labels = items ?? shell.overlayItems
  shell.overlayItems = labels
  const bodyH = Math.max(3, Math.floor((shell.renderer.height || 24) * 0.3))
  shell.overlayList = createListViewport({
    count: labels.length,
    height: bodyH,
    activeIndex: 0,
  })
  shell.overlayTitle.content = " permission · Esc cancel · Enter choose"
  shell.focus = openOverlay(shell.focus, OVERLAY_FRAME_ID, {
    target: "overlay",
    scrollOwner: "overlay",
  })
  relayout(shell, { overlayMode: "inset", overlayBodyRows: bodyH + 1 })
  applyFocus(shell)
  paintOverlayList(shell)
}

/** Close overlay if open; restore prior focus (usually prompt). */
export function closeInsetOverlay(shell: AppShell): void {
  if (!shell.overlayList) return
  shell.overlayList = null
  clearOverlayBody(shell)
  let guard = 8
  while (guard-- > 0 && focusOwner(shell.focus) === "overlay") {
    shell.focus = popFocus(shell.focus)
  }
  relayout(shell, { overlayMode: "closed" })
  applyFocus(shell)
}

/** Move overlay selection (j/k / arrows). */
export function moveOverlaySelection(shell: AppShell, delta: number): void {
  if (!shell.overlayList) return
  shell.overlayList = moveActive(shell.overlayList, delta)
  paintOverlayList(shell)
}

/** Accept active overlay item → system line + close. */
export function acceptOverlaySelection(shell: AppShell): void {
  if (!shell.overlayList) return
  const idx = shell.overlayList.activeIndex
  const label = shell.overlayItems[idx] ?? `item ${idx}`
  appendStreamRow(shell, {
    role: "system",
    text: `chose: ${label}`,
    meta: "overlay",
  })
  closeInsetOverlay(shell)
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
  root.add(transcript)
  root.add(overlayHost)
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
      if (key.name === "return" || key.name === "enter") {
        if (!key.meta && !key.option && !key.ctrl) {
          key.preventDefault()
          acceptOverlaySelection(shell)
          return
        }
      }
      return
    }

    if (key.name === "tab" && !key.ctrl && !key.meta && !key.option) {
      key.preventDefault()
      toggleShellFocus(shell)
      return
    }

    if (key.ctrl && (key.name === "o" || key.name === "O")) {
      key.preventDefault()
      openInsetOverlay(shell)
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
    transcript,
    overlayHost,
    overlayTitle,
    overlayBody,
    prompt,
    promptBox,
    hint,
    status,
    statusBox,
    layout,
    focus: createFocusState(),
    session,
    pendingQueue: badgeCount(session),
    lineCount: 0,
    baseTitle: title,
    overlayList: null,
    overlayItems,
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
  })
  applyLayout(shell, layout)
  applyFocus(shell)
  return shell
}
