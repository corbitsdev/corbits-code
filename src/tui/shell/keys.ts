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
  getShellStopAffordance,
  shellExitHandlers,
  shellInternals,
} from "./internals.js";
import {
  acceptOverlaySelection,
  confirmCopySelection,
  copyAllTargets,
  handleOverlayAnswerKey,
} from "./overlay-host.js";
import { applyLandingSuggestion, setStatusFlash } from "./chrome.js";
import {
  applyPendingForcePush,
  applyPendingNav,
  attachClipboardImage,
  clearPendingAttachments,
  clearPendingSelection,
  interruptShell,
  pendingSelectionActive,
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
import { focusOwner } from "../focus/index.js";
import {
  beginYank,
  breakKillSequence,
  recordKill,
  removedByDelete,
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

const tuiLogger = getLogger([LOG_NAMESPACE_ROOT, "tui"]);

function logStopWorkersFailure(error: unknown): void {
  tuiLogger.warn("stop workers failed: {error}", {
    error: error instanceof Error ? error.message : String(error),
  });
}

// Paste replays land as one burst, fast typing tens of ms apart. The 15ms
// cutoff is empirical — too high eats a fast typist's Enter, too low misses
// a slow replay. Only matters before the first real paste event.
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
 * Ctrl+C interrupts or clears; a second press inside the window quits,
 * replacing the old y/n confirm. Quitting routes through the registered
 * exit handler so host finalize runs.
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
      // Unlink so a delayed onExit cannot leave clipboard files behind.
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
 * The prompt holds focus all session and has no scrollable content, so
 * wheel events land on it; forward its scrolls to the transcript.
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
 * Textarea already deletes on Ctrl+K/U/W and Alt+D (`Textarea.d.ts`
 * `TextareaAction`, shipped `defaultTextareaKeyBindings`). Record the diff
 * those methods remove so yank has a ring. Do not re-bind the chords.
 */
function capturePromptKills(shell: AppShell): void {
  const prompt = shell.prompt;
  const wrap = (
    method:
      | "deleteToLineEnd"
      | "deleteToLineStart"
      | "deleteWordBackward"
      | "deleteWordForward",
    direction: "forward" | "backward",
  ): void => {
    const original = prompt[method].bind(prompt) as () => boolean;
    const wrapped = (): boolean => {
      const before = prompt.value;
      const result = original();
      const after = prompt.value;
      const measure = (prefix: string): number =>
        prompt.editBuffer.measureText(prefix);
      const removal = removedByDelete(before, after, {
        caret: prompt.cursorOffset,
        measure,
      });
      // A snapped wide cell leaves the caret off the grapheme it dropped. Yank
      // inserts at the caret, so park it where the lost span splices back in.
      // When the native caret already sits on that hole, this is a no-op and
      // does not slide it onto the other copy of a repeated prefix.
      if (removal.text.length > 0) {
        prompt.cursorOffset = measure(after.slice(0, removal.at));
      }
      shell.promptKillRing = recordKill(
        shell.promptKillRing,
        removal.text,
        direction,
      );
      return result;
    };
    (prompt as unknown as Record<typeof method, () => boolean>)[method] =
      wrapped;
  };
  wrap("deleteToLineEnd", "forward");
  wrap("deleteToLineStart", "backward");
  wrap("deleteWordBackward", "backward");
  wrap("deleteWordForward", "forward");
}

/**
 * The onKey/onPaste dispatcher bodies, extracted from createAppShell.
 * Paste-guard state stays in this closure: only these handlers read it.
 */
export function createShellKeyHandlers(
  shell: AppShell,
  opts: { isDisposed: () => boolean },
): ShellKeyHandlers {
  capturePromptKills(shell);
  // A real bracketed paste proves DEC 2004; the CRLF-submit fallback below
  // then disables itself for the session.
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
    // Paste is composer input like any key: it ends a pending-column selection.
    clearPendingSelection(shell);
  };

  const token = (key: KeyEvent): string =>
    typeof key.name === "string" ? key.name.toLowerCase() : "";

  /**
   * Un-bracketed paste replay. Returns true when this key was consumed
   * (suppressed LF, or a burst Enter turned into a newline). Callers
   * preventDefault.
   */
  const trackPasteBurst = (key: KeyEvent): boolean => {
    if (sawBracketedPaste) return false;
    const keyName = token(key);
    const suppressLinefeed = suppressNextLinefeed;
    suppressNextLinefeed = false;
    if (
      suppressLinefeed &&
      keyName === "linefeed" &&
      !key.ctrl &&
      !key.meta &&
      !key.option
    ) {
      return true;
    }
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
      shell.prompt.insertText("\n");
      suppressNextLinefeed = true;
      return true;
    }
    return false;
  };

  const onKey = (key: KeyEvent): void => {
    if (opts.isDisposed()) return;
    if (shellInternals(shell)?.inputSuspended === true) return;

    // Landing starters; only while the prompt is untouched, so the key is a
    // plain character once typing starts.
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
      // The `/` popup filters as you type, claiming printable keys ahead of
      // j/k navigation.
      if (handleSlashPopupKey(shell, key)) {
        key.preventDefault();
        return;
      }
      // The `@` popup narrows as you type, same claim on printable keys.
      if (handleMentionPopupKey(shell, key)) {
        key.preventDefault();
        return;
      }
      // A live answer field owns every printable key, so typing an answer
      // does not navigate the choice list.
      if (handleOverlayAnswerKey(shell, key)) {
        key.preventDefault();
        return;
      }
      // Type-to-filter overlays (palette, model picker) claim printables,
      // j/k included, which non-filter overlays still use to navigate.
      if (handlePaletteFilterKey(shell, key)) {
        key.preventDefault();
        return;
      }
      // List overlays opt in the same way, so a long flat catalog narrows
      // without a nested pane.
      if (handleListFilterKey(shell, key)) {
        key.preventDefault();
        return;
      }
      // Per-overlay bare-key owners get first refusal; ordinary lists return
      // false, preserving j/k navigation below.
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
      // Left/Right only matter to overlays that opted into cycling
      // (settings); elsewhere they fall through unclaimed.
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
      // Unclaimed printables fall through to the prompt, which has no focus
      // while the overlay is open. Decision surfaces are the modal exception:
      // the gate keeps every key until answered and the overlay never
      // idle-notifies, so a queued gate cannot drain mid-list.
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

    // Emacs-style editing: Ctrl+K/U/W and Alt+D delete but discard text, and
    // Ctrl+Y/Alt+Y need a place to yank it back from — the kill ring below.
    const keyName = typeof key.name === "string" ? key.name.toLowerCase() : "";

    if (trackPasteBurst(key)) {
      key.preventDefault();
      return;
    }

    // A pending-column selection owns Enter (send now). Ctrl+X, Ctrl+G, and
    // Esc are keymap commands and must still see the selection. ↑/↓ stay.
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
      const keymapOwnsKey =
        keyName === "escape" ||
        (key.ctrl &&
          !key.meta &&
          !key.option &&
          (keyName === "x" || keyName === "g"));
      if (keyName !== "up" && keyName !== "down" && !keymapOwnsKey) {
        clearPendingSelection(shell);
      }
    }

    // Ctrl+K/U/W and Alt+D are Textarea defaults (`defaultTextareaKeyBindings`).
    // The wrapped delete methods record the kill. Only yank is still ours.
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

    // Ctrl+V is a real keypress (0x16), not system paste — that arrives as a
    // bracketed `paste` event — so binding it cannot swallow text paste.
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

    // Typing @ at a token boundary opens path suggestions; the @ is inserted
    // here because the overlay owns focus once open.
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
    // command list only on an empty prompt — mid-line it is a path separator.
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
      // Multi-row prompt: Up/Down are caret motion first. Recall only fires
      // at the buffer's edges, where the caret has nowhere left to go.
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
  };
  return { onKey, onPaste };
}
