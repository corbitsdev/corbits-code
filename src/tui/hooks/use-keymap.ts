import { useInput } from "ink";
import type { Key } from "ink";
import { useRef } from "react";

// Double-ESC window: a second ESC press within this many ms (with nothing
// active to cancel and an empty input) clears the prompt box.
const DOUBLE_ESC_MS = 500;

export type KeymapContext = {
  exitConfirmOpen: boolean;
  helpOpen: boolean;
  gateOpen: boolean;
  agentModalOpen: boolean;
  hookPanelOpen: boolean;
  taskFullScreenOpen: boolean;
  hasInput: boolean;
  inputFocused: boolean;
  isRunning: boolean;
  commandPaletteOpen: boolean;
};

export type KeymapActions = {
  clearInput: () => void;
  requestExit: () => void;
  requestStop: () => void;
  toggleHookPanel: () => void;
  selectHook: (index: number) => void;
  closeHookPanel: () => void;
  scrollUp: () => void;
  scrollDown: () => void;
  scrollToBottom: () => void;
  toggleTaskPanel: () => void;
  toggleThinking: () => void;
  toggleLastTool: () => void;
  toggleVerbose: () => void;
  toggleTaskSidebar: () => void;
  toggleHelp: () => void;
  copyMcpUrl: () => void;
  copyLastOutput: () => void;
  cycleMode: () => void;
};

// Pure dispatch function — separated from the hook so it can be unit tested
// without mounting a React component or relying on stdin byte simulation.
// `lastEscMs` is the timestamp of the previous ESC press (0 if none); returns
// the new value that the caller should store for the next invocation.
export function handleKey(
  input: string,
  key: Key,
  context: KeymapContext,
  actions: KeymapActions,
  lastEscMs: number,
  now: number,
): number {
  // Scroll keys work unconditionally — the user must always be able to read
  // the log, including while a gate modal is blocking other input.
  if (key.ctrl && key.downArrow) {
    actions.scrollToBottom();
    return lastEscMs;
  }
  if (key.pageUp || (key.ctrl && key.upArrow)) {
    actions.scrollUp();
    return lastEscMs;
  }
  if (key.pageDown) {
    actions.scrollDown();
    return lastEscMs;
  }

  // Exit-confirm, help, and any open gate/modal own all remaining input.
  if (context.exitConfirmOpen) return lastEscMs;
  if (context.helpOpen) return lastEscMs;
  if (context.gateOpen) return lastEscMs;
  if (context.agentModalOpen) return lastEscMs;
  if (key.ctrl && input === "c") {
    if (context.hasInput) {
      actions.clearInput();
      return lastEscMs;
    }
    if (context.isRunning) {
      actions.requestStop();
      return lastEscMs;
    }
    actions.requestExit();
    return lastEscMs;
  }
  if (key.ctrl && input === "h") {
    actions.toggleHookPanel();
    return lastEscMs;
  }
  if (context.hookPanelOpen && /^[1-9]$/.test(input)) {
    actions.selectHook(Number(input) - 1);
    return lastEscMs;
  }
  if (key.escape) {
    if (context.taskFullScreenOpen) {
      actions.toggleTaskSidebar();
      return 0;
    }
    if (context.hookPanelOpen) {
      actions.closeHookPanel();
      return 0;
    }
    if (now - lastEscMs <= DOUBLE_ESC_MS) {
      if (context.hasInput) {
        actions.clearInput();
        return 0;
      }
      if (context.isRunning) {
        actions.requestStop();
        return 0;
      }
    }
    return now;
  }
  // Plain arrow keys belong to the prompt box. When the input is focused or the
  // command palette is open, ChatInput's useInput handler owns them.
  if ((context.inputFocused || context.commandPaletteOpen) && (key.upArrow || key.downArrow)) {
    return lastEscMs;
  }
  if (key.ctrl && input === "t") {
    actions.toggleTaskPanel();
    return lastEscMs;
  }
  if (key.ctrl && input === "o") {
    actions.toggleVerbose();
    return lastEscMs;
  }
  if (key.ctrl && input === "r") {
    actions.toggleLastTool();
    return lastEscMs;
  }
  if (key.ctrl && input === "p") {
    actions.toggleTaskSidebar();
    return lastEscMs;
  }
  if (key.ctrl && input === "g") {
    actions.toggleHelp();
    return lastEscMs;
  }
  if (key.ctrl && input === "y") {
    actions.copyLastOutput();
    return lastEscMs;
  }
  if (key.tab && key.shift) {
    actions.cycleMode();
    return lastEscMs;
  }
  return lastEscMs;
}

export function useKeymap(context: KeymapContext, actions: KeymapActions): void {
  const lastEscRef = useRef<number>(0);

  useInput((input, key) => {
    lastEscRef.current = handleKey(input, key, context, actions, lastEscRef.current, Date.now());
  });
}
