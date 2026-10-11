/**
 * Production OpenTUI host — mounts the shell with live session bridges,
 * replacing Ink `render(<App />)` on the interactive path.
 */

import { EventEmitter } from "node:events";
import { createCliRenderer, type CliRenderer } from "@opentui/core";

import { createLiveSessionPort } from "./live-session-port.js";
import { checkWidthContract, widthContractNotice } from "./width-contract.js";
import {
  attachSessionBridge,
  type SessionBridge,
  type TaskProgressSession,
  type TurnMonitorOptions,
} from "./runtime-bridge.js";
import type { ShellOutputFeed } from "../session/shell-output-feed.js";
import { openAddProviderOverlay, openModelPickerOverlay } from "./overlays.js";
import { wireGates } from "./gate-wire.js";
import { createSystemClipboard } from "./system-clipboard.js";
import {
  AGENTS_PANEL_LINGER_MS,
  agentsChromeNeedsSticky,
  formatChromeZones,
  type ChromeLiveState,
} from "./chrome-state.js";
import {
  compactionFoldInfo,
  compactionNotice,
  grantApproval,
  grantNotice,
  hookNotice,
  lifecycleHookEvent,
  mcpNotice,
  mcpServerState,
  RUNTIME_FLASH_MS,
  type RuntimeNotice,
  workflowNotice,
  workflowPayloadInfo,
} from "./runtime-notices.js";
import type { PaletteCommand } from "./command-catalog.js";
import {
  appendObserveStreamRow,
  appendStreamRow,
  clearTranscript,
  noteUnloadedHistory,
  paintChrome,
  setChromeZones,
  setHeader,
  setMcpNeedsAuth,
  setStatusFlash,
} from "./shell/chrome.js";
import { createAppShell } from "./shell/index.js";
import {
  setPaletteOnCommand,
  type AppShell,
  type ItemDescription,
  type PaletteOnObserveRequest,
} from "./shell/internals.js";
import { setOwnedOverlayItems } from "./shell/overlay-host.js";
import {
  isAddProviderShortcutKey,
  isRemoveProviderShortcutKey,
  isSetDefaultShortcutKey,
  setPaletteCatalog,
} from "./shell/palette.js";
import { surfaceSystemNotice } from "./shell/prompt.js";
import type { DeliverySettle, QueueKind } from "./delivery-queue.js";
import {
  hydrateHistoryRows,
  parseHistoryHydratePayload,
} from "./history-hydrate.js";
import type { StreamRow } from "./stream.js";

import type { PendingImageAttachment } from "./image-attachments.js";

/** Suffix the row matching `activeId` (if any) so it reads as the current pick. */
function annotateCurrent(
  rows: readonly ProductHostModelOption[],
  activeId: string | undefined,
): ProductHostModelOption[] {
  if (activeId === undefined) return [...rows];
  return rows.map((r) =>
    r.id === activeId ? { ...r, label: `${r.label} (current)` } : r,
  );
}

/**
 * Alt+R armed-confirm window. No timer: the second press checks expiry and
 * the arm flash shares the TTL.
 */
export const REMOVE_ARM_MS = 5000;

export interface RemoveArmed {
  readonly itemId: string;
  readonly armedAt: number;
}

export type RemoveKeyDecision = "inert" | "armed" | "confirmed";

/**
 * Alt+R transition for one focused picker row. Ghost rows and the
 * empty-filter sentinel are inert; a second press on the same row inside the
 * window confirms; anything else re-arms.
 */
export function decideRemoveKey(
  armed: RemoveArmed | null,
  itemId: string,
  removable: boolean,
  now: number,
): RemoveKeyDecision {
  if (!removable || itemId.length === 0) return "inert";
  if (
    armed !== null &&
    armed.itemId === itemId &&
    now - armed.armedAt < REMOVE_ARM_MS
  ) {
    return "confirmed";
  }
  return "armed";
}

export type ProductHostSend = (
  text: string,
  attachments?: readonly PendingImageAttachment[],
) => void;
/** Classify a composer submit without side effects (see SessionPort.classifySubmit). */
export type ProductHostClassifySubmit = (
  text: string,
  attachments?: readonly PendingImageAttachment[],
) => "agent" | "local" | "empty";
export type ProductHostInterrupt = () => void;
export type ProductHostDeliver = (
  text: string,
  kind: QueueKind,
  attachments?: readonly PendingImageAttachment[],
  settle?: DeliverySettle,
) => void;

/**
 * Catalog grouping for `buildModelsFirstCatalog` (recent/favorites first,
 * then provider models); the live picker is flat.
 */
export interface ProductHostModelOption {
  readonly id: string;
  readonly label: string;
  readonly section?: "recent" | "favorites" | "provider";
}

/** A first-class provider kind offered by the Alt+A add-provider selector. */
export interface ProductHostAddProviderChoice {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  /** Live count of connected accounts for this provider kind (0 or more). */
  readonly accountCount: number;
}

/**
 * Reconnect context (`/connect <kind> [profile]`, or the idle one-action
 * offer). `profile` is the slug being re-keyed: the flow prefills it, never
 * skips the re-key confirm.
 */
export interface ProductHostConnectRequest {
  readonly kind?: string;
  readonly profile?: string;
  /** Reports whether the interactive connect flow completed successfully. */
  readonly onComplete?: (connected: boolean) => void;
}

export interface ProductHostConfig {
  readonly title: string;
  /** Working directory carried by the prompt box's bottom border. */
  readonly cwd?: string;
  readonly eventEmitter: EventEmitter;
  readonly send: ProductHostSend;
  /** Classify a submit without side effects: slash commands and multi-turn
   * /feedback never mark the session busy or queue mid-run. */
  readonly classifySubmit?: ProductHostClassifySubmit;
  readonly interrupt: ProductHostInterrupt;
  readonly deliver: ProductHostDeliver;
  /** Model/provider rows for the picker (id applied on select). */
  readonly models?: readonly ProductHostModelOption[];
  /** Id of the running model, read on every picker open so outside
   * selections (e.g. `defaultProvider` at startup) mark that row
   * "(current)" instead of guessing from recents. */
  readonly activeModelId?: () => string | undefined;
  readonly onModelSelect?: (id: string) => void;
  /** Description-zone source for the model picker, keyed by row id. */
  readonly describeModel?: (itemId: string) => ItemDescription | null;
  /** Called when a provider is picked in the Alt+A selector. Caller runs the
   * connect flow, then updates `models`/`describeModel` via `setModels` and
   * reopens the picker. `req.profile` pre-scopes a reconnect, prefilling
   * the account-name step with the existing slug and keeping the re-key
   * confirm. */
  readonly onConnectProvider?: (
    providerName: string,
    req?: ProductHostConnectRequest,
  ) => void;
  /** Alt+F on a focused model row. Bare `f` is claimed by type-to-filter. */
  readonly onFavoriteToggle?: (itemId: string) => void;
  /** Alt+D on a focused model row. Bare `d` is claimed by type-to-filter. */
  readonly onSetDefault?: (itemId: string) => void;
  /** Alt+R on a focused model row (bare `r` types to filter). Two-press
   * armed confirm: the first press arms the row and flashes the
   * `describeRemoveProvider` line; the second on the same row calls this.
   * Esc, focus moves, and the arm timeout disarm without calling; without
   * `describeRemoveProvider` the chord stays inert. */
  readonly onRemoveProvider?: (itemId: string) => void;
  /** Line flashed for the Alt+R arm step. Null means the row is not
   * removable (ghost/residual rows, the "(no matches)" sentinel), so Alt+R
   * stays inert; only read when `onRemoveProvider` is wired. */
  readonly describeRemoveProvider?: (itemId: string) => string | null;
  /** First-class provider kinds, read fresh on each Alt+A open so a
   * just-connected account's count is current. Omitted hosts get no hint. */
  readonly addProviderChoices?: () => readonly ProductHostAddProviderChoice[];
  /** Command palette catalog (registry-backed). */
  readonly commands?:
    | readonly PaletteCommand[]
    | (() => readonly PaletteCommand[]);
  readonly onCommand?: (name: string) => void;
  /** Optional initial chrome snapshot. */
  readonly chrome?: ChromeLiveState | null;
  /** Agents-strip post-finish linger window. Production keeps the 4s default;
   * tests set it short so the sticky-poll linger test doesn't wait the full
   * window (same pattern as the watchdog's salvageGraceMs). */
  readonly agentsPanelLingerMs?: number;
  /** Resolves the live subagent session for the palette "observe" action;
   * unset falls back to the shell's demo fixture; production must supply
   * this to view real sessions. */
  readonly onObserveRequest?: PaletteOnObserveRequest;
  /** Live sub-agent sessions read on the chrome poll cadence to refresh
   * outstanding `spawn_agent` rows (elapsed time, tool, stall state);
   * omitted hosts paint bare pending rows. */
  readonly subAgentSessions?: () => readonly TaskProgressSession[];
  /** Per-call bounded shell-output feeds, polled on the sticky tick to
   * paint a running command's live output tail onto its pending row.
   * Omitted hosts paint pending rows without a tail. */
  readonly shellOutputFeed?: (callId: string) => ShellOutputFeed | undefined;
  /** Renderer factory override for headless mounting in tests; defaults to
   * the real `createCliRenderer`. */
  readonly createRenderer?: () => Promise<CliRenderer>;
  /** Clock/timer overrides for the quota-retry and stall watchdog (tests). */
  readonly turnMonitor?: TurnMonitorOptions;
  /** First-run telemetry disclosure, shown on the landing screen. */
  readonly telemetryNotice?: string;
  /** Suppress landing snow and mountain motion. Forwarded at mount; the
   * idle timer is never armed. */
  readonly reducedMotion?: boolean;
  /** Take DEC mouse reporting. Default true: without it, alternate-scroll
   * resends wheel input as arrow keys; with it, drag-select is OpenTUI-owned
   * and auto-copies on mouse-up (Alt+M returns to native selection). */
  readonly useMouse?: boolean;
}

export interface ProductHost {
  readonly shell: AppShell;
  readonly bridge: SessionBridge;
  readonly renderer: CliRenderer;
  readonly waitUntilExit: () => Promise<void>;
  readonly dispose: () => void;
  readonly setChrome: (state: ChromeLiveState | null) => void;
  readonly setTitle: (title: string) => void;
  /** Push a live row into the open observe view; no-op when not active. */
  readonly pushObserveRow: (row: StreamRow) => boolean;
  /**
   * Opens the model/provider picker; absent when no models were supplied.
   * `focusId` selects an initial row (e.g. a just-connected account's
   * default model) instead of the top.
   */
  readonly openModels?: (focusId?: string) => void;
  /** Opens the add-provider selector; absent when connect choices are not
   * wired. `returnToModels: true` (opening from the model picker, Alt+A)
   * makes Esc return there; `/connect` and closed-prompt callers omit it so
   * Esc dismisses. `initialKind`/`initialProfile` pre-scope a reconnect
   * (see ProductHostConnectRequest). */
  readonly openAddProvider?: (opts?: {
    returnToModels?: boolean;
    initialKind?: string;
    initialProfile?: string;
    onComplete?: (connected: boolean) => void;
  }) => void;
  /** Swap the picker's rows/descriptions in place (e.g. after a provider connects). */
  readonly setModels?: (
    models: readonly ProductHostModelOption[],
    describeModel?: (itemId: string) => ItemDescription | null,
  ) => void;
}

/**
 * Mount the OpenTUI shell as the production interactive UI.
 * Caller owns session lifecycle (agent, MCP, hooks); host owns paint + input.
 */
export async function mountProductHost(
  config: ProductHostConfig,
): Promise<ProductHost> {
  const renderer = config.createRenderer
    ? await config.createRenderer()
    : await createCliRenderer({
        // Ctrl+C stays with shell.ts's double-tap-to-quit
        // (CTRL_C_EXIT_WINDOW_MS): SIGINT reaches the handler only when
        // nothing consumed it.
        exitOnCtrlC: false,
        targetFps: 30,
        // Mouse reporting on by default (see `useMouse`): without it,
        // alternate-scroll resends wheel as arrow keys and the prompt reads
        // history instead of scrolling the transcript; cost: native
        // drag-select is suppressed.
        // enableMouseMovement stays on (?1003): URL hover needs pointer
        // motion with the modifier held; clicks and wheel never report an
        // unpressed pointer.
        useMouse: config.useMouse ?? true,
        enableMouseMovement: true,
        // A plain terminal sends bare CR for Enter and Shift+Enter alike; the
        // modifier arrives only once the kitty keyboard protocol negotiates.
        // Empty object, not explicit flags: matches OpenCode's config and is
        // what Shift+Enter works under on the same renderer.
        useKittyKeyboard: {},
      });

  const shell = createAppShell(renderer, {
    title: config.title,
    clipboard: createSystemClipboard(renderer),
    mouseCapture: {
      get: () => renderer.useMouse,
      set: (enabled: boolean) => {
        renderer.useMouse = enabled;
      },
    },
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    run: "idle",
    ...(config.commands !== undefined
      ? { paletteCatalog: config.commands }
      : {}),
    ...(config.onCommand !== undefined ? { onCommand: config.onCommand } : {}),
    ...(config.onObserveRequest !== undefined
      ? { onObserveRequest: config.onObserveRequest }
      : {}),
    ...(config.telemetryNotice !== undefined
      ? { telemetryNotice: config.telemetryNotice }
      : {}),
    ...(config.reducedMotion === true ? { reducedMotion: true } : {}),
  });

  // Notice strip (or transcript once there is content), not a log: a log is
  // invisible behind the full-screen shell, and only the operator can fix a
  // terminal setting. The startup path keeps the landing painted when this
  // fires before the first turn.
  const widthReport = checkWidthContract(renderer.widthMethod);
  if (!widthReport.agrees) {
    surfaceSystemNotice(shell, widthContractNotice(widthReport));
  }

  const port = createLiveSessionPort({
    send: config.send,
    interrupt: config.interrupt,
    deliver: config.deliver,
    ...(config.classifySubmit !== undefined
      ? { classifySubmit: config.classifySubmit }
      : {}),
  });
  // Empty options accept the defaults (real clock, 250 ms tick, 15 min stall)
  // while still opting the host into the quota-retry / stall timers.
  const bridge = attachSessionBridge(shell, port, config.turnMonitor ?? {});

  if (config.commands !== undefined) {
    setPaletteCatalog(shell, config.commands);
  }
  if (config.onCommand) {
    setPaletteOnCommand(shell, config.onCommand);
  }

  // Live chrome is pushed by the caller; the subagent store owns per-agent
  // tool state (name + clock), so the host paints zones straight from it.
  const agentsPanelLingerMs =
    config.agentsPanelLingerMs ?? AGENTS_PANEL_LINGER_MS;
  let chromeState: ChromeLiveState | null = config.chrome ?? null;
  const paintChromeZones = (): void => {
    if (chromeState === null) {
      setChromeZones(shell, { task: null, agents: null });
      return;
    }
    setChromeZones(
      shell,
      formatChromeZones(chromeState, Date.now(), agentsPanelLingerMs),
    );
  };
  if (chromeState !== null) paintChromeZones();

  let disposed = false;
  let resolveExit: (() => void) | undefined;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  // The poll outlives the renderer when a caller tears down without
  // disposing the host; painting into freed buffers throws, so it stands
  // down. Sticky is tracked so a true→false edge still paints once —
  // otherwise the strip never clears when linger expires without a notify.
  let stickyWasNeeded =
    chromeState !== null &&
    agentsChromeNeedsSticky(
      chromeState.agents,
      Date.now(),
      agentsPanelLingerMs,
    );
  const stickyPoll = setInterval(() => {
    if (disposed) return;
    try {
      // The poll paints the strip, not the chrome; both edges go through
      // the stickyWasNeeded latch below.
      const stickyNeeded =
        chromeState !== null &&
        agentsChromeNeedsSticky(
          chromeState.agents,
          Date.now(),
          agentsPanelLingerMs,
        );
      if (stickyNeeded || stickyWasNeeded) {
        paintChrome(shell);
      }
      // While the strip owns live clocks/linger, skip syncAgentProgress
      // rewrites — anchors still arrive via events; only the sticky clock
      // tick is frozen.
      if (config.subAgentSessions !== undefined && !stickyNeeded) {
        bridge.syncAgentProgress(config.subAgentSessions());
      }
      // Live shell tail: deduped in the bridge, so an unchanged snapshot is
      // a no-op; this poll cadence (200 ms) is the paint cadence.
      bridge.syncShellOutputs(config.shellOutputFeed);
      // Elapsed clock, stall flip, and linger are wall-time, so repaint while
      // sticky is needed; paintChromeZones re-enters setChromeZones, so gate
      // on sticky, not every tick. The falling edge clears the zone when
      // formatAgentsPanel returns null after linger.
      if (stickyNeeded || stickyWasNeeded) {
        paintChromeZones();
      }
      stickyWasNeeded = stickyNeeded;
    } catch {
      clearInterval(stickyPoll);
    }
  }, 200);
  if (typeof stickyPoll.unref === "function") stickyPoll.unref();

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    clearInterval(stickyPoll);
    config.eventEmitter.off("event", onEvent);
    disposeGates();
    config.eventEmitter.off("history.hydrate", onHistory);
    config.eventEmitter.off("session.title", onTitle);
    config.eventEmitter.off("session.clear", onSessionClear);
    config.eventEmitter.off("hook", onHook);
    config.eventEmitter.off("mcp.status", onMcpStatus);
    config.eventEmitter.off("permission.grant", onPermissionGrant);
    config.eventEmitter.off("compaction", onCompaction);
    config.eventEmitter.off("workflow", onWorkflow);
    bridge.dispose();
    // Cancels any flash still counting down: its expiry repaints into a
    // destroyed text buffer after teardown.
    setStatusFlash(shell, null);
    try {
      shell.dispose();
    } catch {
      // already torn down
    }
    try {
      renderer.destroy();
    } catch {
      // already destroyed
    }
    resolveExit?.();
  }

  // Servers that announced an authorization URL and have not connected since.
  const mcpUnauthorized = new Set<string>();

  function onEvent(event: unknown): void {
    if (disposed) return;
    if (
      event !== null &&
      typeof event === "object" &&
      "type" in event &&
      typeof (event as { type: unknown }).type === "string"
    ) {
      bridge.handle(event as { type: string; data?: unknown });
    }
  }

  function show(notice: RuntimeNotice | null): void {
    if (notice === null) return;
    if (notice.kind === "row") {
      // MCP/hook failures must not wipe the landing mark: surfaceSystemNotice
      // keeps the mountain, then flushes a durable row once the session starts.
      surfaceSystemNotice(shell, notice.text);
      return;
    }
    setStatusFlash(shell, notice.text, { ttlMs: RUNTIME_FLASH_MS });
  }

  function onHook(event: unknown): void {
    if (disposed) return;
    const parsed = lifecycleHookEvent(event);
    if (parsed !== null) show(hookNotice(parsed));
  }

  function onMcpStatus(state: unknown): void {
    if (disposed) return;
    const parsed = mcpServerState(state);
    if (parsed === null) return;
    // A timed-out auth wait is still waiting on the operator — keep the
    // marker until the server connects, leaves config, or fails for a
    // non-auth reason.
    if (
      parsed.state === "needs-auth" ||
      (parsed.state === "failed" && parsed.authPending === true)
    ) {
      mcpUnauthorized.add(parsed.name);
    } else mcpUnauthorized.delete(parsed.name);
    setMcpNeedsAuth(shell, [...mcpUnauthorized]);
    show(mcpNotice(parsed));
  }

  function onPermissionGrant(payload: unknown): void {
    if (disposed) return;
    const approval = grantApproval(payload);
    if (approval !== null) show(grantNotice(approval));
  }

  function onCompaction(payload: unknown): void {
    if (disposed) return;
    const info = compactionFoldInfo(payload);
    if (info !== null) show(compactionNotice(info));
  }

  let workflowWasActive = false;

  function onWorkflow(payload: unknown): void {
    if (disposed) return;
    const info = workflowPayloadInfo(payload);
    if (info === null) return;
    show(workflowNotice(info, { wasActive: workflowWasActive }));
    workflowWasActive = info.current.active;
  }

  // The renderer owns the alternate screen and raw mode, and `dispose` has
  // not reached a caller yet — a throw here would wedge the terminal.
  let disposeGates: () => void;
  try {
    disposeGates = wireGates(config.eventEmitter, shell, {
      onGateOpened: () => bridge.gateOpened(),
      onGateClosed: () => bridge.gateClosed(),
    });
  } catch (err: unknown) {
    try {
      renderer.destroy();
    } catch {
      // already destroyed
    }
    throw err;
  }

  function onHistory(payload: unknown): void {
    if (disposed) return;
    const { blocks, truncated } = parseHistoryHydratePayload(payload);
    for (const row of hydrateHistoryRows(blocks)) {
      appendStreamRow(shell, row);
    }
    if (truncated) noteUnloadedHistory(shell);
  }

  function onTitle(title: unknown): void {
    if (typeof title === "string" && title.length > 0) {
      setHeader(shell, title);
    }
  }

  // /clear and /new rotate the backend session; wipe the painted transcript
  // so the screen matches a brand-new session (the Ink App used to own this;
  // OpenTUI regressed it).
  function onSessionClear(): void {
    if (disposed) return;
    clearTranscript(shell);
    bridge.clearQueuedDelivery();
  }

  let currentModels = config.models ?? [];
  let currentDescribeModel = config.describeModel;
  let openModels: ((focusId?: string) => void) | undefined;
  let openAddProvider:
    | ((opts?: {
        returnToModels?: boolean;
        initialKind?: string;
        initialProfile?: string;
        onComplete?: (connected: boolean) => void;
      }) => void)
    | undefined;
  if (config.onModelSelect) {
    const onSelect = config.onModelSelect;
    const onConnect = config.onConnectProvider;
    const onFavoriteToggle = config.onFavoriteToggle;
    const onSetDefault = config.onSetDefault;
    const onRemoveProvider = config.onRemoveProvider;
    const describeRemoveProvider = config.describeRemoveProvider;
    const addProviderChoices = config.addProviderChoices;
    const removeEnabled =
      onRemoveProvider !== undefined && describeRemoveProvider !== undefined;

    // Alt+R armed-confirm state, per picker mount. Only the latest arm can
    // confirm; every exit clears it (Esc/dismiss, Enter, Alt+A, fresh open).
    // Focus moves disarm via the describe wrapper below.
    let armedRemove: RemoveArmed | null = null;
    let armedRemoveFlash: string | null = null;
    const disarmRemove = (): void => {
      armedRemove = null;
      if (armedRemoveFlash !== null && shell.statusFlash === armedRemoveFlash) {
        setStatusFlash(shell, null);
      }
      armedRemoveFlash = null;
    };

    // Alt+A from the model picker: close it and open a fresh selector over
    // every provider kind, no already-connected filtering. Uses the same
    // reserved close-then-open path as openModels, not the palette's
    // priorOverlay stack (which floats over a question without dropping its
    // awaited promise).
    openAddProvider =
      addProviderChoices !== undefined && onConnect !== undefined
        ? (opts?: {
            returnToModels?: boolean;
            initialKind?: string;
            initialProfile?: string;
            onComplete?: (connected: boolean) => void;
          }): void => {
            const rows = addProviderChoices();
            const scopedIndex =
              opts?.initialKind !== undefined
                ? rows.findIndex((r) => r.id === opts.initialKind)
                : -1;
            openAddProviderOverlay(shell, {
              items: rows.map(
                (r) =>
                  `${r.label} — ${r.accountCount} account${r.accountCount === 1 ? "" : "s"}`,
              ),
              itemIds: rows.map((r) => r.id),
              ...(scopedIndex >= 0 ? { activeIndex: scopedIndex } : {}),
              onAccept: (sel) => {
                const id = sel.id;
                if (id === undefined || id.length === 0) return;
                // A pre-scoped reconnect carries the profile to the connect
                // flow (account-name prefill); anything else connects bare.
                // Unknown kinds fall back to the full list, as the overlay
                // opened unscoped.
                if (
                  opts?.initialProfile !== undefined &&
                  (opts.initialKind === undefined || opts.initialKind === id)
                ) {
                  onConnect(id, {
                    kind: id,
                    profile: opts.initialProfile,
                    ...(opts.onComplete !== undefined
                      ? { onComplete: opts.onComplete }
                      : {}),
                  });
                  return;
                }
                onConnect(id);
              },
              describe: (itemId) => {
                const row = rows.find((r) => r.id === itemId);
                if (row === undefined) return null;
                return {
                  what:
                    row.hint.length > 0
                      ? row.hint
                      : "Opens the connect flow for this provider.",
                  impact: `${row.accountCount} account${row.accountCount === 1 ? "" : "s"} connected today.`,
                  tone: "plain",
                };
              },
              // Esc returns through the same entry Alt+A, /model, and a
              // completed connect use; /connect omits it so Esc dismisses.
              ...(opts?.returnToModels === true
                ? { onCancel: () => openModels?.() }
                : {}),
            });
          }
        : undefined;

    openModels = (focusId?: string): void => {
      // A fresh open is never armed: a stale arm belongs to a closed picker.
      disarmRemove();
      const activeId = config.activeModelId?.();
      const items = annotateCurrent(currentModels, activeId);
      const focusIndex =
        focusId !== undefined ? items.findIndex((m) => m.id === focusId) : -1;
      openModelPickerOverlay(shell, {
        items: items.map((m) => m.label),
        itemIds: items.map((m) => m.id),
        // Flat list: type to narrow rather than drill into a provider pane.
        typeToFilter: true,
        addProviderHint: openAddProvider !== undefined,
        setDefaultHint: onSetDefault !== undefined,
        removeProviderHint: removeEnabled,
        ...(focusIndex >= 0 ? { activeIndex: focusIndex } : {}),
        onAccept: (sel) => {
          disarmRemove();
          // Prefer the stable id from the (possibly filtered) row; the index
          // is into the filtered list, not the catalog, and would pick wrong.
          const id = sel.id;
          if (id === undefined) return;
          onSelect(id);
        },
        describe: (itemId) => {
          if (armedRemove !== null && armedRemove.itemId !== itemId) {
            // Focus left the armed row (arrows, filter re-narrow): disarm with
            // no write — state only; the flash expires on its own TTL.
            armedRemove = null;
          }
          if (armedRemove !== null && armedRemoveFlash !== null) {
            return {
              what: armedRemoveFlash,
              impact: "Alt+R again to confirm · Esc cancels",
              tone: "consequence",
            };
          }
          return currentDescribeModel?.(itemId) ?? null;
        },
        onCancel: () => {
          disarmRemove();
        },
        ...(onFavoriteToggle !== undefined ||
        openAddProvider !== undefined ||
        onSetDefault !== undefined ||
        removeEnabled
          ? {
              onAction: (itemId, key) => {
                if (key.ctrl) return false;
                // Alt+A / composed Option+A (å/Å) — never bare `a`;
                // type-to-filter claims ordinary printables.
                if (
                  openAddProvider !== undefined &&
                  isAddProviderShortcutKey(key)
                ) {
                  disarmRemove();
                  openAddProvider({ returnToModels: true });
                  return true;
                }
                // Alt+F stays modifier-only; the default shortcut also accepts
                // the composed Option+D glyph through its scoped predicate.
                const name =
                  typeof key.name === "string" ? key.name.toLowerCase() : "";
                if (
                  !key.ctrl &&
                  (key.meta || key.option) &&
                  name === "f" &&
                  onFavoriteToggle !== undefined
                ) {
                  // Empty id is the "(no matches)" filter sentinel — not a model.
                  if (itemId.length === 0) return false;
                  onFavoriteToggle(itemId);
                  return true;
                }
                if (
                  onSetDefault !== undefined &&
                  isSetDefaultShortcutKey(key)
                ) {
                  if (itemId.length === 0) return true;
                  onSetDefault(itemId);
                  return true;
                }
                // Alt+R remove stays modifier-only (plus the composed ®
                // glyph); bare `r` is type-to-filter text and never arrives.
                if (removeEnabled && isRemoveProviderShortcutKey(key)) {
                  // Null arm line: ghost/residual row with no settings entry.
                  const armLine = describeRemoveProvider?.(itemId) ?? null;
                  if (armLine === null) return false;
                  if (
                    decideRemoveKey(armedRemove, itemId, true, Date.now()) ===
                    "confirmed"
                  ) {
                    disarmRemove();
                    onRemoveProvider?.(itemId);
                    return true;
                  }
                  armedRemove = { itemId, armedAt: Date.now() };
                  armedRemoveFlash = armLine;
                  setStatusFlash(shell, armLine, { ttlMs: REMOVE_ARM_MS });
                  return true;
                }
                return false;
              },
            }
          : {}),
      });
    };
  }
  const setModels = (
    models: readonly ProductHostModelOption[],
    describeModel?: (itemId: string) => ItemDescription | null,
  ): void => {
    currentModels = models;
    currentDescribeModel = describeModel;
    const items = annotateCurrent(currentModels, config.activeModelId?.());
    setOwnedOverlayItems(
      shell,
      "model_picker",
      items.map((m) => m.label),
      items.map((m) => m.id),
    );
  };

  config.eventEmitter.on("event", onEvent);
  config.eventEmitter.on("history.hydrate", onHistory);
  config.eventEmitter.on("session.title", onTitle);
  config.eventEmitter.on("session.clear", onSessionClear);
  config.eventEmitter.on("hook", onHook);
  config.eventEmitter.on("mcp.status", onMcpStatus);
  config.eventEmitter.on("permission.grant", onPermissionGrant);
  config.eventEmitter.on("compaction", onCompaction);
  config.eventEmitter.on("workflow", onWorkflow);

  return {
    shell,
    bridge,
    renderer,
    waitUntilExit: () => exitPromise,
    dispose,
    setChrome: (state) => {
      chromeState = state ?? null;
      paintChromeZones();
    },
    setTitle: (title) => setHeader(shell, title),
    pushObserveRow: (row) => appendObserveStreamRow(shell, row),
    ...(openModels !== undefined ? { openModels, setModels } : {}),
    ...(openAddProvider !== undefined ? { openAddProvider } : {}),
  };
}
