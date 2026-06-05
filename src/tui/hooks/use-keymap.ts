import { useInput } from "ink";
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
  hasInput: boolean;
  inputFocused: boolean;
  isRunning: boolean;
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
  toggleThinking: () => void;
  toggleLastTool: () => void;
  cycleSidebar: () => void;
  toggleHelp: () => void;
};

export function useKeymap(context: KeymapContext, actions: KeymapActions): void {
  const lastEscRef = useRef<number>(0);

  useInput((input, key) => {
    // The exit-confirm and help overlays, and any open gate/modal, own input
    // entirely while shown — the global keymap stays out of their way.
    if (context.exitConfirmOpen) return;
    if (context.helpOpen) return;
    if (context.gateOpen) return;
    if (context.agentModalOpen) return;

    if (key.ctrl && input === "c") {
      // Typing? Clear the prompt. Agent working? Stop the run (not the app).
      // Idle with an empty prompt? Then Ctrl+C asks to exit.
      if (context.hasInput) {
        actions.clearInput();
        return;
      }
      if (context.isRunning) {
        actions.requestStop();
        return;
      }
      actions.requestExit();
      return;
    }
    if (key.ctrl && input === "h") {
      actions.toggleHookPanel();
      return;
    }
    if (context.hookPanelOpen && /^[1-9]$/.test(input)) {
      actions.selectHook(Number(input) - 1);
      return;
    }
    if (key.escape) {
      // ESC is a back/cancel key. Close the topmost active overlay first.
      // The slash-suggestion list lives in ChatInput and handles its own ESC.
      if (context.hookPanelOpen) {
        actions.closeHookPanel();
        lastEscRef.current = 0;
        return;
      }
      // Nothing active: a double-ESC within the window clears the prompt when
      // typing, or stops the run when the agent is working.
      const now = Date.now();
      if (now - lastEscRef.current <= DOUBLE_ESC_MS) {
        if (context.hasInput) {
          actions.clearInput();
          lastEscRef.current = 0;
          return;
        }
        if (context.isRunning) {
          actions.requestStop();
          lastEscRef.current = 0;
          return;
        }
      }
      lastEscRef.current = now;
      return;
    }
    // Up/down scroll the event log when the prompt is empty. While the user is
    // typing, the input owns those arrows for command-suggestion navigation.
    if (key.upArrow && !context.hasInput) {
      actions.scrollUp();
      return;
    }
    if (key.downArrow && !context.hasInput) {
      actions.scrollDown();
      return;
    }
    if (key.ctrl && input === "t") {
      actions.toggleThinking();
      return;
    }
    if (key.ctrl && input === "r") {
      actions.toggleLastTool();
      return;
    }
    if (key.ctrl && input === "o") {
      actions.toggleLastTool();
      return;
    }
    if (key.ctrl && input === "d") {
      actions.cycleSidebar();
      return;
    }
    if (key.ctrl && input === "g") {
      actions.toggleHelp();
      return;
    }
  });
}
