/**
 * Key routing: paste guard, kill-ring chords, the onKey dispatcher body, Ctrl+C arming.
 */
import { getLogger } from "@intx/log";
import {
  ScrollBoxRenderable,
  type BaseRenderable,
  type KeyEvent,
  type MouseEvent,
} from "@opentui/core";
import { LOG_NAMESPACE_ROOT } from "../../branding.js";
import { badgeCount, pause } from "../delivery-queue.js";

import {
  type AppShell,
  type FlashOptions,
  effortCycleHandlers,
  isSlashPopupOpen,
  type PrimaryOverlayKind,
  getShellStopAffordance,
  shellExitHandlers,
  shellInternals,
} from "./internals.js";
import {
  acceptOverlaySelection,
  abortOverlayHostReservations,
  closeInsetOverlay,
  confirmCopySelection,
  copyAllTargets,
  exitOverlayAnswerMode,
  handleOverlayAnswerKey,
  notifyOverlayClosed,
} from "./overlay-host.js";
import {
  applyFocus,
  applyLandingSuggestion,
  setStatusFlash,
  toggleShellFocus,
  toggleTasksPanel,
} from "./chrome.js";
import {
  applyPendingCancelSelected,
  applyPendingDrop,
  applyPendingForcePush,
  applyPendingNav,
  applyShellCancelLast,
  attachClipboardImage,
  clearPendingAttachments,
  clearPendingSelection,
  interruptShell,
  pendingSelectionActive,
  submitPrompt,
} from "./prompt.js";
import {
  closeSlashPopup,
  handleListFilterKey,
  handleMentionPopupKey,
  handlePaletteFilterKey,
  handleSlashPopupKey,
  MOTION_KEYS,
  openAtMentionSuggestions,
  openSlashCommands,
  setPromptText,
} from "./palette.js";
import {
  cycleOverlaySelection,
  moveOverlaySelection,
  pageOverlaySelection,
  runOverlayAction,
  toggleOverlayExpand,
} from "./overlay-list.js";
import { OVERLAY_EXPAND_KEY } from "./transcript.js";
import { toggleCollapsedRow } from "./chrome.js";
import { leaveSubagentObserve, observeActiveSubagent } from "./observe.js";
import { enterCopyMode, toggleMouseCapture } from "./copy.js";
import { canPopFocus, focusOwner, popFocus } from "../focus/index.js";
import {
  beginYank,
  breakKillSequence,
  killedTextBackward,
  killedTextForward,
  recordKill,
  rotateYank,
} from "../prompt-kill-ring.js";
import {
  promptCaretAtFirstRow,
  promptCaretAtLastRow,
} from "../prompt-input.js";
import {
  sentHistoryOnEdit,
  stepSentHistoryDown,
  stepSentHistoryUp,
} from "../sent-message-history.js";
import { EXPAND_KEY } from "../stream.js";

const tuiLogger = getLogger([LOG_NAMESPACE_ROOT, "tui"]);

function logStopWorkersFailure(error: unknown): void {
  tuiLogger.warn("stop workers failed: {error}", {
    error: error instanceof Error ? error.message : String(error),
  });
}

// Human keystrokes land tens of milliseconds apart at the fastest; a paste
// replayed onto stdin without bracketed-paste framing lands all at once.
// 15ms is an empirical guess at a gap under normal typing and over a replayed
// paste — too high reads a fast typist's real Enter as paste; too low misses
// a slow paste replay. Only matters before this terminal's first real paste
// event; see `sawBracketedPaste` below.
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

/**
 * Which open surface a chord toggles shut, or null when the chord is not a
 * toggling opener.
 *
 * Only pickers appear here: an opener that performs an action (Ctrl+P,
 * Ctrl+C, the expand key) has nothing to toggle, and a decision surface is
 * deliberately absent — re-pressing the chord underneath it must not count as
 * an answer (those leave via a choice or Esc). `@` and `/` are openers too,
 * but they are also characters being typed, so re-pressing them inserts
 * rather than closes.
 */
function toggledSurfaceFor(key: KeyEvent): PrimaryOverlayKind | null {
  if (
    (key.meta || key.option) &&
    !key.ctrl &&
    (key.name === "c" || key.name === "C")
  ) {
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

/** Permission and operator gates: the overlays that hold every key. */
function isDecisionGate(shell: AppShell): boolean {
  return (
    shell.overlayKind === "permissions" || shell.overlayKind === "operator"
  );
}

/** Window in which a second Ctrl+C is read as "yes, quit". */
export const CTRL_C_EXIT_WINDOW_MS = 2000;

/**
 * Prefix of the count-aware 1st-press note (Phase 5) shown when sub-agents are
 * live, inserted after the resolved live-worker count. Imported from keys.ts
 * by callers that build the flash so the wording has exactly one home.
 */
export const N_SUBAGENT_RUNNING_NOTE_PREFIX = "sub-agent(s) running — ";

/**
 * Per-shell Ctrl+C arming slot. `at` is the window anchor; `state` extends the
 * base two-state (unarmed/armed) machine with a third reachable state,
 * STOPPED, recorded on the press that stops live sub-agents so the next press
 * quits instead of double-stopping (see handleCtrlC).
 */
type CtrlCArmed = { at: number; state: "armed" | "stopped" };

const ctrlCArmedAt = new WeakMap<AppShell, CtrlCArmed>();

/**
 * Ctrl+C: interrupt / clear, and quit on a second press inside the window.
 * The double press replaces the old y/n exit confirm — same intent, no modal.
 * Quitting routes through the registered exit handler so host finalize runs.
 */
export function handleCtrlC(
  shell: AppShell,
  now = Date.now(),
  options?: FlashOptions,
): void {
  const armedAt = ctrlCArmedAt.get(shell);
  if (armedAt !== undefined && now - armedAt.at <= CTRL_C_EXIT_WINDOW_MS) {
    ctrlCArmedAt.delete(shell);
    const onExit = shellExitHandlers.get(shell);
    if (onExit !== undefined) {
      // Three-press machine: a press that would previously exit (in-window)
      // first asks whether live sub-agents exist to stop. An already-stopped
      // shell, or one with no live workers, quits (two-press preserved); a
      // shell with live workers is the STOP press -- stop the fleet, stay
      // running, and quits only on the next press.
      const { count, onStop } = readStopAffordance(shell);
      const wasStopped = armedAt.state === "stopped";
      if (!wasStopped && count > 0) {
        // Stop press: do NOT quit. Record STOPPED at press time so a second
        // simultaneous press cannot double-fire an async stop before it resolves.
        ctrlCArmedAt.set(shell, { at: now, state: "stopped" });
        setStatusFlash(shell, "press ctrl+c again to exit", {
          ttlMs: CTRL_C_EXIT_WINDOW_MS,
          ...(options?.schedule !== undefined
            ? { schedule: options.schedule }
            : {}),
        });
        try {
          void Promise.resolve(onStop()).catch(logStopWorkersFailure);
        } catch (error: unknown) {
          logStopWorkersFailure(error);
        }
        return;
      }
      // Real quit (2nd press with no live workers, or 3rd press after stop).
      // Host teardown usually disposes; unlink here too so a stub/delayed
      // onExit cannot leave Corbits-created clipboard files behind.
      clearPendingAttachments(shell);
      onExit();
      return;
    }
  }

  const idle = shell.session.run !== "busy" && badgeCount(shell.session) === 0;
  const hasPromptText = shell.prompt.value.length > 0;
  const hasAttachments = shell.pendingAttachments.length > 0;
  if (idle && (hasPromptText || hasAttachments)) {
    shell.prompt.value = "";
    clearPendingAttachments(shell);
    if (!hasPromptText) return;
  }

  ctrlCArmedAt.set(shell, { at: now, state: "armed" });

  // First Ctrl+C is the operator PAUSE gesture (CL-10149): hold the queue so
  // queued follow-ups / compaction continuations do not auto-drain onto a
  // rebuilt agent. Set before interruptShell so the exclusive bridge path
  // already observes the paused flag; an explicit new send later clears it.
  shell.session = pause(shell.session);

  if (shell.session.run === "busy" || badgeCount(shell.session) > 0) {
    interruptShell(shell);
  }
  // The notice is exactly as true as the arming window is open, so it expires
  // with it rather than waiting for some later flash to overwrite it. When
  // live sub-agents exist the note is count-aware (Phase 5) so the operator
  // knows the next press stops them rather than quitting; otherwise the plain
  // two-press exit string is kept. Read fresh at press time so a fleet that
  // drained before arming falls back to the plain string.
  const { count } = readStopAffordance(shell);
  const note =
    count > 0
      ? `${count} ${N_SUBAGENT_RUNNING_NOTE_PREFIX}press ctrl+c to stop, again to exit`
      : "press ctrl+c again to exit";
  setStatusFlash(shell, note, {
    ttlMs: CTRL_C_EXIT_WINDOW_MS,
    ...(options?.schedule !== undefined ? { schedule: options.schedule } : {}),
  });
}

/**
 * Pure read of the registered stop affordance scalars backing the Ctrl+C
 * three-press machine. This is the live source for both the stop-press branch
 * and the count-aware note in `handleCtrlC`: an in-window press that finds
 * live workers becomes a "stop the fleet, stay up" press (`state: "stopped"`),
 * routing the quit off to a third press; the note's count also comes straight
 * from here, so the operator sees that the next press stops the sub-agents
 * rather than exiting. The shell stays service-free: it never constructs a
 * worker-count itself, only mirrors what the runner registered. Defaults keep
 * an unregistered shell on the plain two-press contract (count 0, no-op stop)
 * so a runner that has not wired the affordance still quits on the second
 * press.
 */
export function readStopAffordance(shell: AppShell): {
  count: number;
  onStop: () => void | Promise<void>;
} {
  const affordance = getShellStopAffordance(shell);
  return {
    count: affordance?.liveWorkerCount() ?? 0,
    // Expression-bodied no-op (not an empty block) so oxlint's
    // no-empty-function rule stays satisfied; still a pure identity no-op.
    onStop: affordance?.onStopWorkers ?? (() => undefined),
  };
}

/**
 * Wheel/trackpad scroll landing on the prompt scrolls the chat instead.
 * The prompt has its own scrollY (usually nothing to scroll) and holds focus
 * all session, so OpenTUI routes wheel events to it. Overriding the scroll
 * case here keeps the fix to where wheel input actually arrives.
 */
export function routePromptWheelToTranscript(
  prompt: BaseRenderable,
  transcript: ScrollBoxRenderable,
): void {
  (
    prompt as unknown as { onMouseEvent: (event: MouseEvent) => void }
  ).onMouseEvent = (event: MouseEvent) => {
    if (event.type !== "scroll") return;
    (
      transcript as unknown as { onMouseEvent: (event: MouseEvent) => void }
    ).onMouseEvent(event);
  };
}

interface ShellKeyHandlers {
  onKey: (key: KeyEvent) => void;
  onPaste: (event: { bytes: Uint8Array; preventDefault: () => void }) => void;
}

/**
 * The onKey/onPaste dispatcher bodies, extracted from createAppShell. The
 * un-bracketed-paste guard state is only read by these handlers, so it lives
 * in this closure rather than on the shared AppShell.
 */
export function createShellKeyHandlers(
  shell: AppShell,
  opts: { isDisposed: () => boolean },
): ShellKeyHandlers {
  // A real bracketed-paste event proves DEC 2004: every paste from here on
  // arrives as one `paste` event, so the CRLF-submit fallback below turns
  // itself off for the rest of the session. Only these handlers read the
  // flag, so it lives in this closure rather than on the shared AppShell.
  let sawBracketedPaste = false;
  let lastKeyAt = 0;
  let lastKeyWasPrintable = false;
  let suppressNextLinefeed = false;
  const onPaste = (event: {
    bytes: Uint8Array;
    preventDefault: () => void;
  }): void => {
    if (opts.isDisposed()) return;
    const bag = shellInternals(shell);
    if (bag?.inputSuspended === true) return;
    sawBracketedPaste = true;
    if (shell.overlayList !== null) {
      if (bag?.primaryBindings.onPaste) {
        event.preventDefault();
        bag.primaryBindings.onPaste(new TextDecoder().decode(event.bytes));
      }
      return;
    }
    // A paste is composer input like any other key: it ends a pending-column
    // selection instead of editing under it.
    clearPendingSelection(shell);
  };

  const onKey = (key: KeyEvent): void => {
    if (opts.isDisposed()) return;
    if (shellInternals(shell)?.inputSuspended === true) return;

    if (key.name === "escape") {
      if (exitOverlayAnswerMode(shell)) {
        key.preventDefault();
        return;
      }
      if (shell.overlayList) {
        key.preventDefault();
        abortOverlayHostReservations(shell);
        // closeSlashPopup closes the inset overlay itself; a second
        // closeInsetOverlay would idle-notify twice and kill a gate the first
        // notify drains. Non-slash overlays carry no entry, so it no-ops and
        // the shared close handles those.
        const list = shell.overlayList;
        closeSlashPopup(shell);
        if (list !== null && shell.overlayList === list)
          closeInsetOverlay(shell);
        return;
      }
      if (shellInternals(shell)?.overlayHostReservations) {
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
      // A pending-column selection is the shallowest dismiss: Esc backs out
      // of it before touching transcript focus.
      if (clearPendingSelection(shell)) {
        key.preventDefault();
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
      // A decision gate keeps every key until it is answered, and a run that
      // keeps raising gates (each rejection re-infers into more calls) would
      // then leave the stop key unreachable. Ctrl+C declines the open gate the
      // way Esc does, then interrupts the turn, which drops queued gates too.
      if (key.ctrl && key.name === "c" && isDecisionGate(shell)) {
        key.preventDefault();
        abortOverlayHostReservations(shell);
        closeInsetOverlay(shell);
        interruptShell(shell);
        return;
      }
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
      // Unclaimed printables fall through to the prompt, which does not hold
      // focus while the overlay is open. Decision surfaces are the modal
      // exception: a gate keeps every key until answered or dismissed, and
      // the overlay stays open (no idle-notify) so a queued gate cannot
      // drain mid-list.
      if (
        shell.overlayKind !== "permissions" &&
        shell.overlayKind !== "operator" &&
        isPrintableInsertKey(key)
      ) {
        key.preventDefault();
        shell.prompt.insertText(key.sequence as string);
        shell.sentHistory = sentHistoryOnEdit(shell.sentHistory);
        return;
      }
      return;
    }

    // Emacs-style prompt editing: Ctrl+K/U/W and Alt+D delete natively but
    // discard the text, and Ctrl+Y/Alt+Y need somewhere to yank it back from
    // — the kill ring, implemented below.
    const keyName = typeof key.name === "string" ? key.name.toLowerCase() : "";

    // Everything below this line is the un-bracketed-paste fallback: a
    // terminal that has ever fired a real `paste` event has proven it never
    // needs this again.
    if (!sawBracketedPaste) {
      // The LF half of a CRLF pair the block below just turned into a
      // newline: without this, "line one\r\nline two" would insert two
      // newlines, one for the converted CR and one for the LF right behind it.
      const suppressLinefeed = suppressNextLinefeed;
      suppressNextLinefeed = false;
      if (
        suppressLinefeed &&
        keyName === "linefeed" &&
        !key.ctrl &&
        !key.meta &&
        !key.option
      ) {
        key.preventDefault();
        return;
      }

      // A bare CR is the same "return" that submits; pasting three lines
      // would otherwise send three messages instead of composing one. Two
      // signals detect it — a printable character landing, then Enter, both
      // inside a keystroke burst — which is unique to a paste replay.
      // Gating on both keeps a deliberate Ctrl+J-then-Enter safe, since
      // Ctrl+J is not a printable character.
      const now = Date.now();
      const sincePreviousKey = now - lastKeyAt;
      const previousKeyWasPrintable = lastKeyWasPrintable;
      lastKeyAt = now;
      lastKeyWasPrintable = isPrintableInsertKey(key);
      const isBareReturn =
        !key.ctrl &&
        !key.meta &&
        !key.option &&
        (keyName === "return" || keyName === "kpenter");
      if (
        isBareReturn &&
        previousKeyWasPrintable &&
        sincePreviousKey < PASTE_BURST_MS
      ) {
        key.preventDefault();
        shell.prompt.insertText("\n");
        suppressNextLinefeed = true;
        return;
      }
    }

    // A pending-column selection owns Enter (kill and send now), ^X (drop)
    // and ^G (pop back for editing); every other key ends the selection and
    // falls through. ↑/↓ stay with the column (nav block below).
    if (pendingSelectionActive(shell)) {
      if (
        (keyName === "return" || keyName === "kpenter") &&
        !key.ctrl &&
        !key.meta &&
        !key.option
      ) {
        key.preventDefault();
        applyPendingForcePush(shell);
        return;
      }
      if (key.ctrl && !key.meta && !key.option && keyName === "x") {
        key.preventDefault();
        applyPendingDrop(shell);
        return;
      }
      if (key.ctrl && !key.meta && !key.option && keyName === "g") {
        key.preventDefault();
        applyPendingCancelSelected(shell);
        return;
      }
      if (keyName !== "up" && keyName !== "down") {
        clearPendingSelection(shell);
      }
    }

    const isCtrlKillYank =
      key.ctrl &&
      !key.meta &&
      !key.option &&
      (keyName === "k" ||
        keyName === "u" ||
        keyName === "w" ||
        keyName === "y");
    const isAltKillYank =
      (key.meta || key.option) &&
      !key.ctrl &&
      (keyName === "d" || keyName === "y");
    if (!isCtrlKillYank && !isAltKillYank) {
      shell.promptKillRing = breakKillSequence(shell.promptKillRing);
    }

    if (key.ctrl && !key.meta && !key.option && keyName === "k") {
      key.preventDefault();
      const before = shell.prompt.value;
      const beforeCursor = shell.prompt.cursorOffset;
      shell.prompt.deleteToLineEnd();
      const killed = killedTextForward(
        before,
        beforeCursor,
        shell.prompt.value,
      );
      shell.promptKillRing = recordKill(
        shell.promptKillRing,
        killed,
        "forward",
      );
      return;
    }

    if (key.ctrl && !key.meta && !key.option && keyName === "u") {
      key.preventDefault();
      const before = shell.prompt.value;
      const beforeCursor = shell.prompt.cursorOffset;
      shell.prompt.deleteToLineStart();
      const killed = killedTextBackward(
        before,
        beforeCursor,
        shell.prompt.cursorOffset,
      );
      shell.promptKillRing = recordKill(
        shell.promptKillRing,
        killed,
        "backward",
      );
      return;
    }

    if (key.ctrl && !key.meta && !key.option && keyName === "w") {
      key.preventDefault();
      const before = shell.prompt.value;
      const beforeCursor = shell.prompt.cursorOffset;
      shell.prompt.deleteWordBackward();
      const killed = killedTextBackward(
        before,
        beforeCursor,
        shell.prompt.cursorOffset,
      );
      shell.promptKillRing = recordKill(
        shell.promptKillRing,
        killed,
        "backward",
      );
      return;
    }

    if ((key.meta || key.option) && !key.ctrl && keyName === "d") {
      key.preventDefault();
      const before = shell.prompt.value;
      const beforeCursor = shell.prompt.cursorOffset;
      shell.prompt.deleteWordForward();
      const killed = killedTextForward(
        before,
        beforeCursor,
        shell.prompt.value,
      );
      shell.promptKillRing = recordKill(
        shell.promptKillRing,
        killed,
        "forward",
      );
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

    // Ctrl+V is a real keypress (0x16), not the system paste: CMD+V arrives
    // as a bracketed `paste` event the InputRenderable inserts as text, so
    // binding Ctrl+V here cannot swallow an ordinary text paste.
    if (
      key.ctrl &&
      !key.meta &&
      !key.option &&
      (keyName === "p" || keyName === "v")
    ) {
      key.preventDefault();
      void attachClipboardImage(shell);
      return;
    }

    // Typing @ at a token boundary opens path suggestions. The overlay owns
    // focus while open, so the @ is inserted here rather than racing the
    // focus change.
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
      // A live pending column takes ↑/↓ first: ↑ at the buffer's top edge
      // selects the newest held item, ↓ past the last row hands the key back.
      if (applyPendingNav(shell, key.name === "up" ? -1 : 1)) {
        key.preventDefault();
        return;
      }
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

    if (
      key.name === "tab" &&
      !key.ctrl &&
      !key.meta &&
      !key.option &&
      !key.shift
    ) {
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

    if (
      (key.meta || key.option) &&
      (key.name === "c" || key.name === "C") &&
      !key.ctrl
    ) {
      // Alt+C: keyboard copy path (no mouse drag-select).
      key.preventDefault();
      enterCopyMode(shell);
      return;
    }

    if (
      (key.meta || key.option) &&
      (key.name === "m" || key.name === "M") &&
      !key.ctrl
    ) {
      // Alt+M: release mouse reporting so the terminal can drag-select.
      key.preventDefault();
      toggleMouseCapture(shell);
      return;
    }

    if (
      (key.meta || key.option) &&
      (key.name === "t" || key.name === "T") &&
      !key.ctrl
    ) {
      // Alt+T: the task panel toggle (the palette that used to own it is gone).
      key.preventDefault();
      toggleTasksPanel(shell);
      return;
    }

    if (
      (key.meta || key.option) &&
      (key.name === "o" || key.name === "O") &&
      !key.ctrl
    ) {
      // Alt+O: observe a live subagent, same rationale as Alt+T.
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

    if (
      (key.name === "return" || key.name === "enter") &&
      (key.meta || key.option) &&
      !key.ctrl
    ) {
      // Alt+Enter: follow-up — enqueue kind "queue"; deliver only when the
      // run goes idle. Does not interrupt or reinject; idle/empty is a no-op.
      key.preventDefault();
      if (shell.session.run !== "busy") return;
      submitPrompt(shell, "queue");
      return;
    }
  };
  return { onKey, onPaste };
}
