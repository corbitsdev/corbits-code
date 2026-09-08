/**
 * Headless OpenTUI test harness for Corbits shell integration tests.
 *
 * Wraps `@opentui/core/testing` `createTestRenderer` with cleanup and
 * named key chords. Functional helpers only — no new classes.
 *
 * ## Key shapes (mockInput → renderer.keyInput `keypress`)
 *
 * | Chord      | `name`   | `ctrl` | `meta` | notes |
 * |------------|----------|--------|--------|-------|
 * | Enter      | `return` | false  | false  | Canonical is **return**, not enter; keybindings alias enter→return |
 * | Alt+Enter  | `return` | false  | true   | Match `meta \|\| option` (Kitty may set option) |
 * | Ctrl+C     | `c`      | true   | false  | Default renderer `exitOnCtrlC` is true; harness defaults false |
 *
 * Alt surfaces as `meta: true` on the mock/mac path. Real Kitty terminals may
 * also set `option`.
 */

import { getTreeSitterClient } from "@opentui/core";
import type { KeyInput } from "@opentui/core/testing";
import {
  createTestRenderer,
  type MockInput,
  type MockMouse,
  type TestRenderer,
  type TestRendererSetup,
} from "@opentui/core/testing";

export interface HarnessOptions {
  readonly width?: number;
  readonly height?: number;
  /**
   * When true, Ctrl+C destroys/exits via the renderer default path.
   * Defaults to **false** so interrupt-shape tests do not kill the process.
   */
  readonly exitOnCtrlC?: boolean;
}

/** Fixture: permission choices for overlay suites (moved out of overlays.ts). */
export function makePermissionItems(count = 30): readonly string[] {
  const n = Math.max(1, Math.floor(count));
  return Array.from({ length: n }, (_, i) => {
    if (i === 0) return "Allow once";
    if (i === 1) return "Allow session";
    if (i === 2) return "Always allow this tool";
    if (i === 3) return "Deny";
    return `Allow tool call #${i - 3}`;
  });
}

/** Fixture: long operator question + many choices for overlay suites. */
export function makeOperatorQuestion(): {
  readonly body: string;
  readonly choices: readonly string[];
} {
  const body = [
    "The agent wants to run a destructive command on the working tree.",
    "Review the plan carefully — this cannot be undone from the TUI.",
    "",
    "Proposed: git reset --hard origin/main && rm -rf node_modules",
    "Files at risk: 128 modified, 12 untracked.",
    "Continue only if you accept discarding local work.",
  ].join("\n");
  const choices = [
    "Cancel — keep working tree",
    "Allow this once",
    "Allow for this session",
    "Always allow git reset",
    "Open diff first",
    "Ask again later",
    "Switch to dry-run",
    "Abort agent run",
  ];
  return { body, choices };
}

/** Fixture: model/provider picker list for overlay suites. */
export function makeModelPickerItems(): readonly string[] {
  return [
    "claude-sonnet-4 * [anthropic]",
    "claude-opus-4 * [anthropic]",
    "gpt-5 * [openai]",
    "gpt-5-mini * [openai]",
    "gemini-2.5-pro * [google]",
    "gemini-2.5-flash * [google]",
    "grok-3 * [xai]",
    "ollama-llama3.3 * [local]",
    "o3 * [codex]",
    "o4-mini * [codex]",
  ];
}

export interface KeyModifiers {
  readonly shift?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly super?: boolean;
  readonly hyper?: boolean;
}

/** Named chords used by Corbits steering / interrupt design. */
export type NamedKey = "Enter" | "Alt+Enter" | "Ctrl+C" | "Escape" | "Tab" | "Backspace";

export interface Harness {
  readonly renderer: TestRenderer;
  readonly mockInput: MockInput;
  readonly mockMouse: MockMouse;
  /** Shortcut for `renderer.root`. */
  readonly root: TestRenderer["root"];
  readonly renderOnce: () => Promise<void>;
  readonly flush: TestRendererSetup["flush"];
  readonly waitFor: TestRendererSetup["waitFor"];
  readonly waitForFrame: TestRendererSetup["waitForFrame"];
  readonly captureCharFrame: () => string;
  readonly captureSpans: TestRendererSetup["captureSpans"];
  readonly resize: (width: number, height: number) => void;
  /**
   * Press a named chord or a raw key via mock input.
   * Named: Enter | Alt+Enter | Ctrl+C | Escape | Tab | Backspace.
   * Anything else delegates to `mockInput.pressKey(name, mods)`.
   */
  readonly pressKey: (name: NamedKey | KeyInput, mods?: KeyModifiers) => void;
  /** Destroy the underlying renderer (idempotent-safe to call once from finally). */
  readonly destroy: () => void;
}

const DEFAULT_WIDTH = 60;
const DEFAULT_HEIGHT = 20;

/**
 * Create a headless test renderer + helpers. Caller must `destroy()` (prefer
 * `withTestRenderer` which always cleans up).
 */
export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  const exitOnCtrlC = opts.exitOnCtrlC ?? false;

  const setup = await createTestRenderer({
    width,
    height,
    exitOnCtrlC,
  });

  const pressKey = (name: NamedKey | KeyInput, mods?: KeyModifiers): void => {
    switch (name) {
      case "Enter":
        if (mods === undefined) setup.mockInput.pressEnter();
        else setup.mockInput.pressEnter(mods);
        return;
      case "Alt+Enter":
        // meta: true is the mock/mac Alt surface (see module comment).
        if (mods === undefined) setup.mockInput.pressEnter({ meta: true });
        else setup.mockInput.pressEnter({ ...mods, meta: true });
        return;
      case "Ctrl+C":
        setup.mockInput.pressCtrlC();
        return;
      case "Escape":
        if (mods === undefined) setup.mockInput.pressEscape();
        else setup.mockInput.pressEscape(mods);
        return;
      case "Tab":
        if (mods === undefined) setup.mockInput.pressTab();
        else setup.mockInput.pressTab(mods);
        return;
      case "Backspace":
        if (mods === undefined) setup.mockInput.pressBackspace();
        else setup.mockInput.pressBackspace(mods);
        return;
      default:
        if (mods === undefined) setup.mockInput.pressKey(name);
        else setup.mockInput.pressKey(name, mods);
    }
  };

  return {
    renderer: setup.renderer,
    mockInput: setup.mockInput,
    mockMouse: setup.mockMouse,
    root: setup.renderer.root,
    renderOnce: setup.renderOnce,
    flush: setup.flush,
    waitFor: setup.waitFor,
    waitForFrame: setup.waitForFrame,
    captureCharFrame: setup.captureCharFrame,
    captureSpans: setup.captureSpans,
    resize: setup.resize,
    pressKey,
    destroy: () => {
      setup.renderer.destroy();
      // renderer.destroy() tears down the process-global tree-sitter client
      // once no renderers remain. Eagerly recreate it so the next test file's
      // markdown/code highlighting doesn't hit the destroyed singleton.
      getTreeSitterClient();
    },
  };
}

/**
 * Run `fn` with a harness and always destroy the renderer afterward.
 */
export async function withTestRenderer<T>(
  fn: (harness: Harness) => Promise<T> | T,
  opts?: HarnessOptions,
): Promise<T> {
  const harness = await createHarness(opts);
  try {
    return await fn(harness);
  } finally {
    harness.destroy();
  }
}
