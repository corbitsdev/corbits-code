/**
 * Key routing: paste guard, kill-ring chords, the onKey dispatcher body, Ctrl+C arming.
 */
import {
  ScrollBoxRenderable,
  type BaseRenderable,
  type KeyEvent,
  type MouseEvent,
} from "@opentui/core";
import { badgeCount } from "../session-queue.js";

import {
  type AppShell,
  type FlashOptions,
  effortCycleHandlers,
  isSlashPopupOpen,
  type PrimaryOverlayKind,
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
  applyShellCancelLast,
  attachClipboardImage,
  clearPendingAttachments,
  interruptShell,
  submitPrompt,
} from "./prompt.js";
import {
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
import { promptCaretAtFirstRow, promptCaretAtLastRow } from "../prompt-input.js";
import {
  sentHistoryOnEdit,
  stepSentHistoryDown,
  stepSentHistoryUp,
} from "../sent-message-history.js";
import { EXPAND_KEY } from "../stream.js";

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
export function isPrintableInsertKey(key: KeyEvent): boolean {
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
export function toggleCloseOpenSurface(shell: AppShell, key: KeyEvent): boolean {
  if (shell.overlayList === null) return false;
  const kind = toggledSurfaceFor(key);
  if (kind === null || kind !== shell.overlayKind) return false;
  // The `/` popup borrows the palette overlay; there the chord is still a
  // character the operator may be typing into the filter.
  if (kind === "palette" && isSlashPopupOpen(shell)) return false;
  closeInsetOverlay(shell);
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

  ctrlCArmedAt.set(shell, now);

  if (shell.session.run === "busy" || badgeCount(shell.session) > 0) {
    interruptShell(shell);
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
export function routePromptWheelToTranscript(
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

export interface ShellKeyHandlers {
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
    if (opts.isDisposed()) return;
    const bag = shellInternals(shell);
    if (bag?.inputSuspended === true) return;
    sawBracketedPaste = true;
    if (shell.overlayList !== null && bag?.primaryBindings.onPaste) {
      event.preventDefault();
      bag.primaryBindings.onPaste(new TextDecoder().decode(event.bytes));
    }
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
  return { onKey, onPaste };
}
