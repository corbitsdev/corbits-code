/**
 * Application chords registered on `@opentui/keymap`. Each `run` calls one
 * existing function. Textarea defaults (cursor, delete, newline, submit) are
 * not in this list: `Textarea.d.ts` `TextareaAction` and the shipped
 * `defaultTextareaKeyBindings` already own them, and `PROMPT_KEY_BINDINGS`
 * already flips Enter to submit.
 */
import {
  type AppShell,
  effortCycleHandlers,
  shellInternals,
} from "./internals.js";
import { handleCtrlC } from "./keys.js";
import {
  applyFocus,
  toggleCollapsedRow,
  toggleShellFocus,
  toggleTasksPanel,
} from "./chrome.js";
import {
  abortOverlayHostReservations,
  closeInsetOverlay,
  exitOverlayAnswerMode,
  notifyOverlayClosed,
  stopDecisionGate,
} from "./overlay-host.js";
import { closeSlashPopup } from "./palette.js";
import { enterCopyMode, toggleMouseCapture } from "./copy.js";
import { leaveSubagentObserve, observeActiveSubagent } from "./observe.js";
import { canPopFocus, popFocus } from "../focus/index.js";
import {
  applyPendingCancelSelected,
  applyPendingDrop,
  applyShellCancelLast,
  clearPendingSelection,
  pendingSelectionActive,
  submitPrompt,
} from "./prompt.js";

export interface AppChord {
  readonly name: string;
  readonly keys: string;
  readonly description: string;
  readonly bindings: readonly (string | { readonly name: string })[];
  /** Inactive while an overlay holds the key, unless the chord must still run. */
  readonly active?: (shell: AppShell) => boolean;
  /**
   * Esc opts out. `@opentui/keymap` `Binding.preventDefault` also calls
   * `stopPropagation` (`types.d.ts`), which would hide Esc from the list modal.
   */
  readonly preventDefault?: boolean;
  readonly run: (shell: AppShell) => boolean;
}

const promptSurface = (shell: AppShell): boolean => shell.overlayList === null;

function isDecisionGate(shell: AppShell): boolean {
  return (
    shell.overlayKind === "permissions" || shell.overlayKind === "operator"
  );
}

/** Ctrl+C. TextareaAction has no interrupt; arming stays here. */
function runShellCtrlC(shell: AppShell): boolean {
  if (shell.overlayList) {
    if (isDecisionGate(shell)) {
      stopDecisionGate(shell);
      return true;
    }
    return false;
  }
  handleCtrlC(shell);
  return true;
}

/** Esc. Not a ScrollBox binding; arrow-scroll on a focused transcript stays off. */
function runShellDismiss(shell: AppShell): boolean {
  if (exitOverlayAnswerMode(shell)) return true;
  if (shell.overlayList) {
    abortOverlayHostReservations(shell);
    const list = shell.overlayList;
    closeSlashPopup(shell);
    if (list !== null && shell.overlayList === list) closeInsetOverlay(shell);
    return true;
  }
  if (shellInternals(shell)?.overlayHostReservations) {
    abortOverlayHostReservations(shell);
    queueMicrotask(() => notifyOverlayClosed(shell));
    return true;
  }
  if (shell.observe) {
    leaveSubagentObserve(shell);
    return true;
  }
  if (clearPendingSelection(shell)) return true;
  if (canPopFocus(shell.focus)) {
    shell.focus = popFocus(shell.focus);
    applyFocus(shell);
    return true;
  }
  return false;
}

export const APP_CHORDS: readonly AppChord[] = [
  {
    name: "shell.queue",
    keys: "Alt+Enter",
    description:
      "queue a follow-up delivered only when the run goes idle; does nothing unless a run is busy",
    bindings: ["alt+return"],
    active: promptSurface,
    run: (shell) => {
      if (shell.session.run !== "busy") return true;
      submitPrompt(shell, "queue");
      return true;
    },
  },
  {
    name: "shell.held.drop",
    keys: "Up / Down / Enter / Ctrl+X",
    description:
      "on held items above the prompt: select, send now, drop (Esc backs out)",
    bindings: ["ctrl+x"],
    active: (shell) => promptSurface(shell) && pendingSelectionActive(shell),
    run: (shell) => {
      applyPendingDrop(shell);
      return true;
    },
  },
  {
    name: "shell.interrupt",
    keys: "Ctrl+C",
    description:
      "pause a busy run and hold the queue, or clear the prompt and attachments when idle; Ctrl+C again to exit — with live sub-agents, a 2nd press stops them, a 3rd quits",
    bindings: ["ctrl+c"],
    run: runShellCtrlC,
  },
  {
    name: "shell.cancel",
    keys: "Ctrl+G",
    description:
      "pop the most recently queued or steered message back into the prompt for editing",
    bindings: ["ctrl+g"],
    active: promptSurface,
    run: (shell) => {
      if (pendingSelectionActive(shell)) {
        applyPendingCancelSelected(shell);
        return true;
      }
      applyShellCancelLast(shell);
      return true;
    },
  },
  {
    name: "shell.copy",
    keys: "Alt+C",
    description:
      "copy mode: pick a message, tool output, or diff; press again to close it",
    bindings: ["alt+c"],
    active: (shell) =>
      shell.overlayList === null || shell.overlayKind === "copy",
    run: (shell) => {
      if (shell.overlayKind === "copy" && shell.overlayList !== null) {
        closeInsetOverlay(shell);
        return true;
      }
      enterCopyMode(shell);
      return true;
    },
  },
  {
    name: "shell.mouse",
    keys: "Alt+M",
    description:
      "toggle DEC mouse capture (on by default: wheel scroll, click-to-expand, drag-to-copy); off restores native terminal drag-select",
    bindings: ["alt+m"],
    active: promptSurface,
    run: (shell) => {
      toggleMouseCapture(shell);
      return true;
    },
  },
  {
    name: "shell.expand",
    keys: "Alt+E",
    description:
      "expand or collapse every collapsible row (tool call, diff, skill, reasoning)",
    bindings: ["alt+e"],
    active: promptSurface,
    run: (shell) => toggleCollapsedRow(shell),
  },
  {
    name: "shell.tasks",
    keys: "Alt+T",
    description:
      "show or hide the task list above the prompt (hidden by default)",
    bindings: ["alt+t"],
    active: promptSurface,
    run: (shell) => {
      toggleTasksPanel(shell);
      return true;
    },
  },
  {
    name: "shell.observe",
    keys: "Alt+O",
    description:
      "observe a live subagent session; a system row says so when there is none",
    bindings: ["alt+o"],
    active: promptSurface,
    run: (shell) => {
      observeActiveSubagent(shell);
      return true;
    },
  },
  {
    name: "shell.focus",
    keys: "Tab",
    description: "move focus between the prompt and the transcript",
    bindings: ["tab"],
    active: promptSurface,
    run: (shell) => {
      toggleShellFocus(shell);
      return true;
    },
  },
  {
    name: "shell.effort",
    keys: "Shift+Tab",
    description: "cycle reasoning effort for the current model",
    bindings: ["shift+tab", { name: "backtab" }],
    active: promptSurface,
    run: (shell) => {
      effortCycleHandlers.get(shell)?.();
      return true;
    },
  },
  {
    name: "shell.dismiss",
    keys: "Esc",
    description: "close the open overlay, or leave subagent observe",
    bindings: ["escape"],
    preventDefault: false,
    run: runShellDismiss,
  },
];

export function appHelpLines(): readonly string[] {
  return APP_CHORDS.map((row) => `${row.keys} — ${row.description}`);
}

export function shellIsLive(shell: AppShell): boolean {
  return !shell.disposed && shellInternals(shell)?.inputSuspended !== true;
}
