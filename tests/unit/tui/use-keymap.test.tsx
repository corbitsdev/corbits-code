import { test, expect, mock } from "bun:test";
import type { Key } from "ink";
import { handleKey, type KeymapContext, type KeymapActions } from "../../../src/tui/hooks/use-keymap.js";

// Default Key — all false, as ink would emit for a plain character.
const NO_KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  home: false,
  end: false,
  insert: false,
  f1: false, f2: false, f3: false, f4: false,
  f5: false, f6: false, f7: false, f8: false,
  f9: false, f10: false, f11: false, f12: false,
};

const CTRL: Key = { ...NO_KEY, ctrl: true };
const ESC_KEY: Key = { ...NO_KEY, escape: true };
const UP_KEY: Key = { ...NO_KEY, upArrow: true };
const DOWN_KEY: Key = { ...NO_KEY, downArrow: true };

const DEFAULT_CTX: KeymapContext = {
  exitConfirmOpen: false,
  helpOpen: false,
  gateOpen: false,
  agentModalOpen: false,
  hookPanelOpen: false,
  taskFullScreenOpen: false,
  hasInput: false,
  inputFocused: false,
  isRunning: false,
  commandPaletteOpen: false,
};

const NOW = 1000;

function makeActions(): KeymapActions {
  return {
    clearInput: mock(() => {}),
    requestExit: mock(() => {}),
    requestStop: mock(() => {}),
    toggleHookPanel: mock(() => {}),
    selectHook: mock((_: number) => {}),
    closeHookPanel: mock(() => {}),
    scrollUp: mock(() => {}),
    scrollDown: mock(() => {}),
    scrollToBottom: mock(() => {}),
    toggleThinking: mock(() => {}),
    toggleLastTool: mock(() => {}),
    toggleVerbose: mock(() => {}),
    toggleTaskSidebar: mock(() => {}),
    toggleHelp: mock(() => {}),
    copyMcpUrl: mock(() => {}),
    copyLastOutput: mock(() => {}),
    cycleMode: mock(() => {}),
  };
}

function dispatch(
  input: string,
  key: Key,
  ctx: Partial<KeymapContext> = {},
  lastEscMs = 0,
  now = NOW,
): { actions: KeymapActions; returned: number } {
  const actions = makeActions();
  const returned = handleKey(input, key, { ...DEFAULT_CTX, ...ctx }, actions, lastEscMs, now);
  return { actions, returned };
}

// --- Blocking conditions ---

test("exitConfirmOpen blocks all actions", () => {
  const { actions } = dispatch("c", CTRL, { exitConfirmOpen: true });
  expect(actions.requestExit).not.toHaveBeenCalled();
});

test("helpOpen blocks all actions", () => {
  const { actions } = dispatch("c", CTRL, { helpOpen: true });
  expect(actions.requestExit).not.toHaveBeenCalled();
});

test("gateOpen blocks all actions", () => {
  const { actions } = dispatch("c", CTRL, { gateOpen: true });
  expect(actions.requestExit).not.toHaveBeenCalled();
});

test("agentModalOpen blocks all actions", () => {
  const { actions } = dispatch("c", CTRL, { agentModalOpen: true });
  expect(actions.requestExit).not.toHaveBeenCalled();
});

// --- Ctrl+C ---

test("Ctrl+C with hasInput calls clearInput", () => {
  const { actions } = dispatch("c", CTRL, { hasInput: true });
  expect(actions.clearInput).toHaveBeenCalledTimes(1);
  expect(actions.requestExit).not.toHaveBeenCalled();
  expect(actions.requestStop).not.toHaveBeenCalled();
});

test("Ctrl+C with isRunning calls requestStop", () => {
  const { actions } = dispatch("c", CTRL, { isRunning: true });
  expect(actions.requestStop).toHaveBeenCalledTimes(1);
  expect(actions.requestExit).not.toHaveBeenCalled();
});

test("Ctrl+C idle calls requestExit", () => {
  const { actions } = dispatch("c", CTRL);
  expect(actions.requestExit).toHaveBeenCalledTimes(1);
});

// --- Ctrl+H ---

test("Ctrl+H calls toggleHookPanel", () => {
  const { actions } = dispatch("h", CTRL);
  expect(actions.toggleHookPanel).toHaveBeenCalledTimes(1);
});

// --- Number keys while hookPanelOpen ---

test("key '1' while hookPanelOpen calls selectHook(0)", () => {
  const { actions } = dispatch("1", NO_KEY, { hookPanelOpen: true });
  expect(actions.selectHook).toHaveBeenCalledWith(0);
});

test("key '9' while hookPanelOpen calls selectHook(8)", () => {
  const { actions } = dispatch("9", NO_KEY, { hookPanelOpen: true });
  expect(actions.selectHook).toHaveBeenCalledWith(8);
});

test("number key ignored when hookPanelOpen is false", () => {
  const { actions } = dispatch("3", NO_KEY, { hookPanelOpen: false });
  expect(actions.selectHook).not.toHaveBeenCalled();
});

// --- Escape — fullscreen and panel ---

test("Escape while taskFullScreenOpen calls toggleTaskSidebar and resets lastEsc", () => {
  const { actions, returned } = dispatch("", ESC_KEY, { taskFullScreenOpen: true });
  expect(actions.toggleTaskSidebar).toHaveBeenCalledTimes(1);
  expect(returned).toBe(0);
});

test("Escape while hookPanelOpen calls closeHookPanel", () => {
  const { actions } = dispatch("", ESC_KEY, { hookPanelOpen: true });
  expect(actions.closeHookPanel).toHaveBeenCalledTimes(1);
});

// --- Double-ESC (using injected timestamps) ---

test("double-ESC within 500ms with hasInput calls clearInput", () => {
  // First ESC at t=1000, second at t=1400 (400ms later — within window)
  const { returned: lastEsc } = dispatch("", ESC_KEY, { hasInput: true }, 0, 1000);
  expect(lastEsc).toBe(1000);
  const { actions } = dispatch("", ESC_KEY, { hasInput: true }, lastEsc, 1400);
  expect(actions.clearInput).toHaveBeenCalledTimes(1);
});

test("double-ESC within 500ms with isRunning calls requestStop", () => {
  const { returned: lastEsc } = dispatch("", ESC_KEY, { isRunning: true }, 0, 1000);
  const { actions } = dispatch("", ESC_KEY, { isRunning: true }, lastEsc, 1300);
  expect(actions.requestStop).toHaveBeenCalledTimes(1);
});

test("ESC then >500ms gap: second ESC does NOT trigger double-ESC", () => {
  const { returned: lastEsc } = dispatch("", ESC_KEY, { hasInput: true }, 0, 1000);
  // Second ESC at t=1600 — 600ms later, outside window
  const { actions } = dispatch("", ESC_KEY, { hasInput: true }, lastEsc, 1600);
  expect(actions.clearInput).not.toHaveBeenCalled();
});

// --- Arrow keys ---

test("up arrow does not scroll the log when input is focused", () => {
  const { actions } = dispatch("", UP_KEY, { inputFocused: true });
  expect(actions.scrollUp).not.toHaveBeenCalled();
});

test("down arrow does not scroll the log when input is focused", () => {
  const { actions } = dispatch("", DOWN_KEY, { inputFocused: true });
  expect(actions.scrollDown).not.toHaveBeenCalled();
});

test("up arrow does not scroll when input is unfocused either (arrows belong to prompt)", () => {
  const { actions } = dispatch("", UP_KEY, { inputFocused: false });
  expect(actions.scrollUp).not.toHaveBeenCalled();
});

test("down arrow does not scroll when input is unfocused", () => {
  const { actions } = dispatch("", DOWN_KEY, { inputFocused: false });
  expect(actions.scrollDown).not.toHaveBeenCalled();
});

test("Ctrl+Down jumps to the bottom when input is focused", () => {
  const { actions } = dispatch("", { ...NO_KEY, ctrl: true, downArrow: true }, { inputFocused: true });
  expect(actions.scrollToBottom).toHaveBeenCalledTimes(1);
  expect(actions.scrollDown).not.toHaveBeenCalled();
});

test("Ctrl+Down jumps to the bottom when input is unfocused", () => {
  const { actions } = dispatch("", { ...NO_KEY, ctrl: true, downArrow: true }, { inputFocused: false });
  expect(actions.scrollToBottom).toHaveBeenCalledTimes(1);
  expect(actions.scrollDown).not.toHaveBeenCalled();
});

test("PageUp scrolls up while input is focused", () => {
  const { actions } = dispatch("", { ...NO_KEY, pageUp: true }, { inputFocused: true });
  expect(actions.scrollUp).toHaveBeenCalledTimes(1);
});

test("PageDown scrolls down while input is focused", () => {
  const { actions } = dispatch("", { ...NO_KEY, pageDown: true }, { inputFocused: true });
  expect(actions.scrollDown).toHaveBeenCalledTimes(1);
});

test("PageUp scrolls up while input is unfocused", () => {
  const { actions } = dispatch("", { ...NO_KEY, pageUp: true }, { inputFocused: false });
  expect(actions.scrollUp).toHaveBeenCalledTimes(1);
});

test("Ctrl+Up scrolls up while input is focused", () => {
  const { actions } = dispatch("", { ...NO_KEY, ctrl: true, upArrow: true }, { inputFocused: true });
  expect(actions.scrollUp).toHaveBeenCalledTimes(1);
});

test("plain Up does not scroll when input is focused", () => {
  const { actions } = dispatch("", UP_KEY, { inputFocused: true });
  expect(actions.scrollUp).not.toHaveBeenCalled();
});

test("plain Down does not scroll when input is focused", () => {
  const { actions } = dispatch("", DOWN_KEY, { inputFocused: true });
  expect(actions.scrollDown).not.toHaveBeenCalled();
});

test("arrows do not scroll while the command palette is open", () => {
  const up = dispatch("", UP_KEY, { commandPaletteOpen: true });
  expect(up.actions.scrollUp).not.toHaveBeenCalled();
  const down = dispatch("", DOWN_KEY, { commandPaletteOpen: true });
  expect(down.actions.scrollDown).not.toHaveBeenCalled();
});

test("Ctrl+Down still scrolls to bottom while command palette is open (Ctrl is not an arrow-only key)", () => {
  const ctrlDown = dispatch("", { ...NO_KEY, ctrl: true, downArrow: true }, { commandPaletteOpen: true });
  expect(ctrlDown.actions.scrollToBottom).toHaveBeenCalledTimes(1);
});

// --- Other Ctrl shortcuts ---

test("Ctrl+T calls toggleThinking", () => {
  const { actions } = dispatch("t", CTRL);
  expect(actions.toggleThinking).toHaveBeenCalledTimes(1);
});

test("Ctrl+R calls toggleLastTool", () => {
  const { actions } = dispatch("r", CTRL);
  expect(actions.toggleLastTool).toHaveBeenCalledTimes(1);
});

test("Ctrl+O calls toggleVerbose", () => {
  const { actions } = dispatch("o", CTRL);
  expect(actions.toggleVerbose).toHaveBeenCalledTimes(1);
});

test("Ctrl+P calls toggleTaskSidebar", () => {
  const { actions } = dispatch("p", CTRL);
  expect(actions.toggleTaskSidebar).toHaveBeenCalledTimes(1);
});

test("Ctrl+G calls toggleHelp", () => {
  const { actions } = dispatch("g", CTRL);
  expect(actions.toggleHelp).toHaveBeenCalledTimes(1);
});
