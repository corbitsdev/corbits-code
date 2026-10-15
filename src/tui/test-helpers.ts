/**
 * Shared shell fixture for TUI tests: a headless renderer plus an AppShell
 * that is always disposed. Defaults match the 80×24 / wireKeys-off scaffold
 * the suite used to copy into every file.
 */
import type { CapturedSpan } from "@opentui/core";

import { withTestRenderer, type Harness } from "./harness.js";
import { createAppShell } from "./shell/index.js";
import type { AppShell, AppShellOptions } from "./shell/internals.js";

export interface AppShellFixtureOptions {
  /** Renderer width, also the shell's terminal columns. Default 80. */
  readonly width?: number;
  /** Renderer height, also the shell's terminal rows. Default 24. */
  readonly height?: number;
  /** Extra createAppShell options. `terminal` always follows width/height. */
  readonly shell?: AppShellOptions;
}

/** Run `fn` with a mounted AppShell on a test renderer, then dispose it. */
export async function withAppShell(
  fn: (shell: AppShell, harness: Harness) => Promise<void> | void,
  options?: AppShellFixtureOptions,
): Promise<void> {
  const width = options?.width ?? 80;
  const height = options?.height ?? 24;
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        wireKeys: false,
        ...options?.shell,
        terminal: { columns: width, rows: height },
      });
      try {
        await fn(shell, h);
      } finally {
        shell.dispose();
      }
    },
    { width, height },
  );
}

/** 0.6.x leases a session buffer around each presented frame; a capture
 * landing inside that window throws OutputBusy. The poll retries on the
 * next round anyway, so a losing capture keeps polling instead of
 * throwing — the ready predicate, never the trace, decides the outcome. */
function readSpans(h: Harness): CapturedSpan[] {
  try {
    return h.captureSpans().lines.flatMap((line) => line.spans);
  } catch (err) {
    if (err instanceof Error && err.message.includes("OutputBusy")) return [];
    throw err;
  }
}

export async function settleSpans(
  h: Harness,
  ready: (spans: CapturedSpan[]) => boolean,
): Promise<CapturedSpan[]> {
  let spans = readSpans(h);
  for (let i = 0; i < 400 && !ready(spans); i++) {
    await h.renderOnce();
    await new Promise((resolve) => setTimeout(resolve, 25));
    spans = readSpans(h);
  }
  return spans;
}
