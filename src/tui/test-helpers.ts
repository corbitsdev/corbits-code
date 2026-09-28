/**
 * Shared shell fixture for TUI tests: a headless renderer plus an AppShell
 * that is always disposed. Defaults match the common 80×24 / wireKeys-off
 * scaffold the suite used to copy into every file.
 */
import { withTestRenderer, type Harness } from "./harness.js";
import { createAppShell } from "./shell/index.js";
import type { AppShell, AppShellOptions } from "./shell/internals.js";

export interface AppShellFixtureOptions {
  /** Renderer width; also the shell's terminal columns. Default 80. */
  readonly width?: number;
  /** Renderer height; also the shell's terminal rows. Default 24. */
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
