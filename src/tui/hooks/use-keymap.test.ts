import { describe, expect, test } from "bun:test";
import type { Key } from "ink";
import { handleKey, type KeymapActions, type KeymapContext } from "./use-keymap.js";

function key(partial: Partial<Key> = {}): Key {
  return { ...partial } as Key;
}

const noopActions: KeymapActions = {
  clearInput: () => undefined,
  requestExit: () => undefined,
  requestStop: () => undefined,
  toggleHookPanel: () => undefined,
  selectHook: () => undefined,
  closeHookPanel: () => undefined,
  scrollUp: () => undefined,
  scrollDown: () => undefined,
  scrollToBottom: () => undefined,
  toggleTaskPanel: () => undefined,
  toggleThinking: () => undefined,
  toggleLastTool: () => undefined,
  toggleVerbose: () => undefined,
  toggleTaskSidebar: () => undefined,
  toggleHelp: () => undefined,
  copyMcpUrl: () => undefined,
  copyLastOutput: () => undefined,
  cycleMode: () => undefined,
};

describe("handleKey quota cancel", () => {
  test("double ESC with isRunning (quota wait) calls requestStop", () => {
    let stopped = false;
    const actions: KeymapActions = { ...noopActions, requestStop: () => { stopped = true; } };
    const context: KeymapContext = {
      exitConfirmOpen: false,
      helpOpen: false,
      gateOpen: false,
      agentModalOpen: false,
      hookPanelOpen: false,
      taskFullScreenOpen: false,
      hasInput: false,
      inputFocused: true,
      isRunning: true,
      commandPaletteOpen: false,
    };
    const t0 = 1_000;
    const afterFirst = handleKey("", key({ escape: true }), context, actions, 0, t0);
    handleKey("", key({ escape: true }), context, actions, afterFirst, t0 + 100);

    expect(stopped).toBe(true);
  });
});