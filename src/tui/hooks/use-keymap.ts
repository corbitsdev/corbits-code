import { useInput } from "ink";
import { useRef } from "react";

// Double-ESC window: a second ESC press within this many ms (with nothing
// active to cancel and an empty input) clears the prompt box.
const DOUBLE_ESC_MS = 500;

export type KeymapContext = {
  exitConfirmOpen: boolean;
  helpOpen: boolean;
  gateOpen: boolean;
  hookPanelOpen: boolean;
  hasInput: boolean;
};

export type KeymapActions = {
  clearInput: () => void;
  requestExit: () => void;
  toggleHookPanel: () => void;
  selectHook: (index: number) => void;
  closeHookPanel: () => void;
  scrollUp: () => void;
  scrollDown: () => void;
  toggleThinking: () => void;
  toggleLastTool: () => void;
  toggleMode: () => void;
  toggleContextView: () => void;
  toggleHelp: () => void;
};

export function useKeymap(context: KeymapContext, actions: KeymapActions): void {
  const lastEscRef = useRef<number>(0);

  useInput((input, key) => {
    // The exit-confirm and help overlays own input entirely while open.
    if (context.exitConfirmOpen) return;
    if (context.helpOpen) return;

    if (key.ctrl && input === "c") {
      if (context.gateOpen) return;
      if (context.hasInput) {
        actions.clearInput();
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
      if (context.gateOpen) return;
      // ESC is a back/cancel key. Close the topmost active overlay first.
      // The slash-suggestion list lives in ChatInput and handles its own ESC.
      if (context.hookPanelOpen) {
        actions.closeHookPanel();
        lastEscRef.current = 0;
        return;
      }
      // Nothing active: a double-ESC within the window clears the prompt.
      const now = Date.now();
      if (context.hasInput && now - lastEscRef.current <= DOUBLE_ESC_MS) {
        actions.clearInput();
        lastEscRef.current = 0;
        return;
      }
      lastEscRef.current = now;
      return;
    }
    if (key.upArrow) {
      actions.scrollUp();
      return;
    }
    if (key.downArrow) {
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
    if (key.ctrl && input === "d") {
      actions.toggleContextView();
      return;
    }
    if (key.ctrl && input === "g") {
      actions.toggleHelp();
      return;
    }
    if (key.tab && key.shift) {
      actions.toggleMode();
    }
  });
}
