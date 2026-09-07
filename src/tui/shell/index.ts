/**
 * AppShell assembly: renderable tree construction, store wiring, event registration.
 */
import {
  BoxRenderable,
  CliRenderEvents,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
  type Selection,
} from "@opentui/core";
import { createSentHistoryBrowse } from "../sent-message-history.js";
import { createPromptInput } from "../prompt-input.js";
import { RUNTIME_FLASH_MS } from "../runtime-notices.js";
import { createFocusState } from "../focus/index.js";
import { PROMPT_IDLE_ROWS, resolveGeometry } from "../geometry/index.js";
import {
  createLandingAbove,
  createLandingBelow,
  LANDING_VERSION,
  landingBelowContent,
  splitLandingRows,
  versionBadgeVisible,
} from "../landing.js";
import { destroySubtree } from "../teardown.js";
import { createRecordingClipboard } from "../copy-path.js";
import { copyFinishedSelection } from "../selection-copy.js";
import { badgeCount, createSessionQueue, enqueue } from "../session-queue.js";
import { UI } from "../theme.js";
import { createOverlayView, isDecisionOverlay } from "../overlay-view.js";
import { emptyKillRing } from "../prompt-kill-ring.js";
import { flushStreamRowUpdates } from "../runtime-bridge.js";

import {
  type AppShell,
  type AppShellOptions,
  EMPTY_PRIMARY_BINDINGS,
  flashTimers,
  initShellInternals,
  setPaletteOnCommand,
  setPaletteOnObserveRequest,
  setTranscriptSpacer,
  shellFlashSchedules,
  shellInternals,
  type ShellRenderer,
} from "./internals.js";
import { defaultVisibility, terminalForGeometry, terminalOf } from "./layout.js";
import { relayoutOverlayHost } from "./overlay-list.js";
import {
  abortOverlayHostReservations,
  applyOverlayBodyText,
  closeInsetOverlay,
  dropDeferredCommandOverlay,
} from "./overlay-host.js";
import {
  applyFocus,
  applyLayout,
  LANDING_IDLE_REPAINT_INTERVAL_MS,
  paintLanding,
  relayout,
  setStatusFlash,
  syncNoticeAfterLayout,
  syncPromptRows,
  syncTranscriptSpacer,
} from "./chrome.js";
import { clearPendingAttachments, submitPrompt, syncPromptHighlights } from "./prompt.js";
import { createShellKeyHandlers, routePromptWheelToTranscript } from "./keys.js";

const DEFAULT_TITLE = "corbits";

const DEFAULT_OVERLAY_ITEMS = [
  "Allow bash: ls",
  "Allow bash: cat README",
  "Deny this tool",
  "Always allow bash",
] as const;

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
  const reducedMotion = options?.reducedMotion === true;

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

  const landingAbove = createLandingAbove(ctx, reducedMotion);
  const landingBelowState = landingBelowContent({
    rows: splitLandingRows(layout.heights.transcript).below,
    columns: layout.contentWidth,
    telemetryNotice: options?.telemetryNotice,
  });
  const landingBelow = createLandingBelow(ctx, landingBelowState);

  const overlayView = createOverlayView(ctx);
  const { host: overlayHost, title: overlayTitle, body: overlayBody } = overlayView;

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

  const onEnter = (): void => {
    if (disposed || shell.overlayList) return;
    if (shellInternals(shell)?.inputSuspended === true) return;
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
    // Streaming row retexts coalesce here: deltas only mark the open row
    // dirty, and this frame hook applies the accumulated text once — the
    // row's markdown body is reparsed whole per retext, so per-delta
    // replacement is quadratic across a message.
    flushStreamRowUpdates(shell);
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
    const bag = shellInternals(shell);
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
    overlayView,
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
      // Quit paths that skip idle Ctrl+C still drop Corbits-created files.
      clearPendingAttachments(shell);
      if (wireKeys) {
        renderer.keyInput.off("keypress", onKey);
        renderer.keyInput.off("paste", onPaste);
        prompt.onSubmit = undefined;
      }
      renderer.off(CliRenderEvents.FRAME, onFrame);
      renderer.off(CliRenderEvents.RESIZE, onResize);
      renderer.off(CliRenderEvents.SELECTION, onSelection);
      shellInternals(shell)?.landingIdleTimerCancel?.();
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

  initShellInternals(shell, {
    visibility,
    promptContentRows,
    overlayMode: "closed",
    overlayBodyRows: undefined,
    overlayMinBodyRows: undefined,
    overlayRawBodyText: "",
    priorOverlay: null,
    overlayGeneration: 0,
    primaryBindings: { ...EMPTY_PRIMARY_BINDINGS },
    overlayEchoChoice: true,
    inputSuspended: false,
    overlayAnswer: null,
    overlayTitleText: "",
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
    reducedMotion,
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
  // renderer's FRAME event does: FRAME follows dirty rows, not a clock.
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
  //
  // Reduced motion never starts the timer: there is no snow to advance
  // and the mountain stays on its filled frame.
  if (!reducedMotion) {
    const landingIdleHandle = setInterval(() => {
      if (renderer.isDestroyed) {
        clearInterval(landingIdleHandle);
        return;
      }
      const bag = shellInternals(shell);
      if (bag?.landing == null || bag.landingAnimating) return;
      paintLanding(shell, Date.now(), false);
    }, LANDING_IDLE_REPAINT_INTERVAL_MS);
    landingIdleHandle.unref?.();
    {
      const bag = shellInternals(shell);
      if (bag !== undefined) {
        bag.landingIdleTimerCancel = () => clearInterval(landingIdleHandle);
      } else {
        clearInterval(landingIdleHandle);
      }
    }
  }
  setTranscriptSpacer(shell, transcriptSpacer);
  if (onCommandOpt) setPaletteOnCommand(shell, onCommandOpt);
  if (onObserveRequestOpt) {
    setPaletteOnObserveRequest(shell, onObserveRequestOpt);
  }
  const { onKey, onPaste } = createShellKeyHandlers(shell, { isDisposed: () => disposed });
  if (wireKeys) {
    renderer.keyInput.on("keypress", onKey);
    renderer.keyInput.on("paste", onPaste);
    prompt.onSubmit = onEnter;
  }

  applyLayout(shell, layout);
  // Added after the first layout pass so the scroll box sizes it against the
  // resolved transcript height rather than the pre-layout placeholder.
  transcript.add(landingAbove.box);
  applyFocus(shell);
  return shell;
}
