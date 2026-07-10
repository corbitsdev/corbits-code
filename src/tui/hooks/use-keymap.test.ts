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
  enterCopyMode: () => undefined,
  copyModeNext: () => undefined,
  copyModePrev: () => undefined,
  copyModeConfirm: () => undefined,
  copyModeCopyAll: () => undefined,
  copyModeCancel: () => undefined,
  cycleMode: () => undefined,
  enterAgentsNav: () => undefined,
  agentsNavNext: () => undefined,
  agentsNavPrev: () => undefined,
  agentsNavConfirm: () => undefined,
  agentsNavCancel: () => undefined,
  exitEnteredSession: () => undefined,
};

const baseContext: KeymapContext = {
  exitConfirmOpen: false,
  helpOpen: false,
  gateOpen: false,
  agentModalOpen: false,
  hookPanelOpen: false,
  taskFullScreenOpen: false,
  hasInput: false,
  inputFocused: true,
  isRunning: false,
  commandPaletteOpen: false,
  copyModeOpen: false,
  agentsNavOpen: false,
  enteredSession: false,
};

describe("handleKey quota cancel", () => {
  test("double ESC with isRunning (quota wait) calls requestStop", () => {
    let stopped = false;
    const actions: KeymapActions = { ...noopActions, requestStop: () => { stopped = true; } };
    const context: KeymapContext = { ...baseContext, isRunning: true };
    const t0 = 1_000;
    const afterFirst = handleKey("", key({ escape: true }), context, actions, 0, t0);
    handleKey("", key({ escape: true }), context, actions, afterFirst, t0 + 100);

    expect(stopped).toBe(true);
  });
});

describe("copy mode", () => {
  test("Ctrl+Y enters copy mode", () => {
    let entered = false;
    const actions: KeymapActions = { ...noopActions, enterCopyMode: () => { entered = true; } };
    handleKey("y", key({ ctrl: true }), baseContext, actions, 0, 0);
    expect(entered).toBe(true);
  });

  test("while open, arrows move the selection and y copies", () => {
    const calls: string[] = [];
    const actions: KeymapActions = {
      ...noopActions,
      copyModeNext: () => calls.push("next"),
      copyModePrev: () => calls.push("prev"),
      copyModeConfirm: () => calls.push("confirm"),
      copyModeCopyAll: () => calls.push("all"),
      copyModeCancel: () => calls.push("cancel"),
    };
    const ctx: KeymapContext = { ...baseContext, copyModeOpen: true };
    handleKey("", key({ downArrow: true }), ctx, actions, 0, 0);
    handleKey("", key({ upArrow: true }), ctx, actions, 0, 0);
    handleKey("y", key(), ctx, actions, 0, 0);
    handleKey("a", key(), ctx, actions, 0, 0);
    handleKey("", key({ escape: true }), ctx, actions, 0, 0);
    expect(calls).toEqual(["next", "prev", "confirm", "all", "cancel"]);
  });
});

describe("agents nav and enter-session", () => {
  test("Ctrl+E opens agents navigation", () => {
    let opened = false;
    const actions: KeymapActions = {
      ...noopActions,
      enterAgentsNav: () => {
        opened = true;
      },
    };
    handleKey("e", key({ ctrl: true }), baseContext, actions, 0, 0);
    expect(opened).toBe(true);
  });

  test("while agents nav is open, arrows and enter select a session", () => {
    const calls: string[] = [];
    const actions: KeymapActions = {
      ...noopActions,
      agentsNavNext: () => calls.push("next"),
      agentsNavPrev: () => calls.push("prev"),
      agentsNavConfirm: () => calls.push("confirm"),
      agentsNavCancel: () => calls.push("cancel"),
    };
    const ctx: KeymapContext = { ...baseContext, agentsNavOpen: true };
    handleKey("", key({ downArrow: true }), ctx, actions, 0, 0);
    handleKey("", key({ upArrow: true }), ctx, actions, 0, 0);
    handleKey("", key({ return: true }), ctx, actions, 0, 0);
    handleKey("", key({ escape: true }), ctx, actions, 0, 0);
    expect(calls).toEqual(["next", "prev", "confirm", "cancel"]);
  });

  test("while viewing a sub-agent, Esc returns to the parent", () => {
    let exited = false;
    const actions: KeymapActions = {
      ...noopActions,
      exitEnteredSession: () => {
        exited = true;
      },
    };
    const ctx: KeymapContext = { ...baseContext, enteredSession: true };
    handleKey("", key({ escape: true }), ctx, actions, 0, 0);
    expect(exited).toBe(true);
  });
});