/**
 * First-run welcome gate shown before provider setup.
 *
 * Fresh installs see the animated orange mountain and the product line, then
 * continue into model/provider setup. Returning users who already completed
 * this gate (`settings.onboarded`) skip straight to setup.
 *
 * The mark art is the same silhouette the idle landing uses (`renderMark` /
 * mark grids); this surface only owns the standalone full-screen composition
 * and the advance/cancel contract.
 */

import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  createCliRenderer,
  fg as fgChunk,
  type CliRenderer,
  type KeyEvent,
  type TextChunk,
} from "@opentui/core";

import { PRODUCT_NAME } from "../branding.js";
import { MARK_PERIOD_SECONDS, renderMark } from "./mark-anim.js";
import { MARK_LARGE, MARK_MID, MARK_SMALL, type MarkGrid } from "./mark-shape.js";
import { resolveSideMargin } from "./geometry/margins.js";
import { destroySubtree } from "./teardown.js";
import { UI } from "./theme.js";
import { stringWidth } from "./view/height.js";

/** Exact first-run line under the mountain. */
export const WELCOME_LINE = `${PRODUCT_NAME}, your local software factory`;

const MARK_TIERS: readonly MarkGrid[] = [MARK_LARGE, MARK_MID, MARK_SMALL];

/** Rows reserved under the mark for the product line, hint, and breathing room. */
const BELOW_MARK_ROWS = 5;

/** Hold after one full mark period before auto-advancing. */
const HOLD_AFTER_PERIOD_MS = 900;

/** Paint cadence while the mountain draws. */
const PAINT_TICK_MS = 80;

export interface WelcomeConfig {
  /** Renderer factory override for headless mounting in tests. */
  readonly createRenderer?: () => Promise<CliRenderer>;
  /**
   * Auto-advance delay after mount. Defaults to one mark period plus a short
   * hold so the silhouette finishes drawing before setup opens.
   */
  readonly autoAdvanceMs?: number;
  /** Injected clock for mark animation (and tests). */
  readonly now?: () => number;
}

/**
 * Largest mark that leaves room for the product line below it, or null when
 * even the compact grid cannot seat.
 */
export function resolveWelcomeMarkGrid(rows: number, columns: number): MarkGrid | null {
  const width = Math.max(0, columns);
  const height = Math.max(0, rows);
  for (const grid of MARK_TIERS) {
    if (grid.rows + BELOW_MARK_ROWS > height) continue;
    if (grid.cols > width) continue;
    return grid;
  }
  return null;
}

/**
 * Mount the welcome surface. Resolves true once the operator continues (any
 * key, or auto-advance), false when they cancel with Ctrl+C / Ctrl+D.
 */
export async function runWelcome(config: WelcomeConfig = {}): Promise<boolean> {
  const externalRenderer = config.createRenderer !== undefined;
  const renderer = config.createRenderer
    ? await config.createRenderer()
    : await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 30,
        useMouse: false,
        enableMouseMovement: false,
      });

  const now = config.now ?? Date.now;
  const startedAt = now();
  const autoAdvanceMs =
    config.autoAdvanceMs ?? Math.round(MARK_PERIOD_SECONDS * 1000) + HOLD_AFTER_PERIOD_MS;

  const margin = resolveSideMargin(renderer.width || 80);

  const root = new BoxRenderable(renderer, {
    id: "welcome",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: UI.ground,
    paddingLeft: margin,
    paddingRight: margin,
  });

  const topPad = new BoxRenderable(renderer, {
    id: "welcome-top-pad",
    width: "100%",
    flexGrow: 1,
    flexShrink: 1,
    backgroundColor: UI.ground,
  });
  const bottomPad = new BoxRenderable(renderer, {
    id: "welcome-bottom-pad",
    width: "100%",
    flexGrow: 1,
    flexShrink: 1,
    backgroundColor: UI.ground,
  });

  const markBox = new BoxRenderable(renderer, {
    id: "welcome-mark",
    flexDirection: "column",
    flexShrink: 0,
    backgroundColor: UI.ground,
  });
  const markRows: TextRenderable[] = [];
  for (let row = 0; row < MARK_LARGE.rows; row++) {
    const markLine = new TextRenderable(renderer, {
      id: `welcome-mark-${row}`,
      height: 1,
      content: "",
      fg: UI.action,
      flexShrink: 0,
    });
    markRows.push(markLine);
    markBox.add(markLine);
  }

  const gap = new TextRenderable(renderer, {
    id: "welcome-gap",
    height: 1,
    content: "",
    fg: UI.ground,
    flexShrink: 0,
  });

  const line = new TextRenderable(renderer, {
    id: "welcome-line",
    height: 1,
    content: WELCOME_LINE,
    fg: UI.text,
    flexShrink: 0,
  });

  const hintGap = new TextRenderable(renderer, {
    id: "welcome-hint-gap",
    height: 1,
    content: "",
    fg: UI.ground,
    flexShrink: 0,
  });

  const hint = new TextRenderable(renderer, {
    id: "welcome-hint",
    height: 1,
    content: "press any key to continue",
    fg: UI.textFaint,
    flexShrink: 0,
  });

  root.add(topPad);
  root.add(markBox);
  root.add(gap);
  root.add(line);
  root.add(hintGap);
  root.add(hint);
  root.add(bottomPad);
  renderer.root.add(root);

  let settled = false;
  let grid: MarkGrid | null = null;

  const fit = (): void => {
    if (settled) return;
    const columns = Math.max(1, (renderer.width || 80) - margin * 2);
    const rows = renderer.height || 24;
    grid = resolveWelcomeMarkGrid(rows, columns);
    markBox.visible = grid !== null;
    markBox.width = grid?.cols ?? 0;
    markBox.height = grid?.rows ?? 0;
    const offset = grid === null ? MARK_LARGE.rows : MARK_LARGE.rows - grid.rows;
    markRows.forEach((row, index) => {
      row.visible = grid !== null && index >= offset;
    });
    line.content =
      stringWidth(WELCOME_LINE) > columns
        ? WELCOME_LINE.slice(0, Math.max(0, columns - 1))
        : WELCOME_LINE;
  };

  const paint = (): void => {
    if (settled || grid === null) return;
    try {
      const chunks = markChunks(grid, now() - startedAt, false);
      const offset = MARK_LARGE.rows - grid.rows;
      markRows.forEach((row, index) => {
        if (!row.visible) return;
        const cells = chunks[index - offset];
        if (cells !== undefined) row.content = new StyledText([...cells]);
      });
    } catch {
      // Renderer or text buffers already torn down.
    }
  };

  fit();
  paint();

  let resolveDone: (value: boolean) => void = () => {};
  const done = new Promise<boolean>((resolve) => {
    resolveDone = resolve;
  });

  let paintTimer: ReturnType<typeof setInterval> | null = null;
  let advanceTimer: ReturnType<typeof setTimeout> | null = null;

  const teardown = (): void => {
    if (paintTimer !== null) {
      clearInterval(paintTimer);
      paintTimer = null;
    }
    if (advanceTimer !== null) {
      clearTimeout(advanceTimer);
      advanceTimer = null;
    }
    renderer.keyInput.off("keypress", onKey);
    try {
      renderer.root.remove(root);
      destroySubtree(root);
    } catch {
      // already unmounted
    }
    if (!externalRenderer) {
      try {
        renderer.destroy();
      } catch {
        // already destroyed
      }
    }
  };

  const settle = (continued: boolean): void => {
    if (settled) return;
    settled = true;
    teardown();
    resolveDone(continued);
  };

  function onKey(key: KeyEvent): void {
    if (settled) return;
    const cancel = key.ctrl === true && (key.name === "c" || key.name === "d");
    if (cancel) {
      key.preventDefault();
      settle(false);
      return;
    }
    key.preventDefault();
    settle(true);
  }

  renderer.keyInput.on("keypress", onKey);
  paintTimer = setInterval(paint, PAINT_TICK_MS);
  advanceTimer = setTimeout(() => settle(true), autoAdvanceMs);

  return done;
}

function markChunks(grid: MarkGrid, nowMs: number, still: boolean): readonly TextChunk[][] {
  return renderMark({ nowMs, still, grid }).map((row) =>
    row.map((cell) => fgChunk(cell.fg)(cell.char)),
  );
}
