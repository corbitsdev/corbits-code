/**
 * Standalone single-select modal on the shared shell/list-overlay kit.
 *
 * Satellite surfaces (session resume, session mode) mount their own renderer,
 * collect one choice, and tear down — they never join the live session host.
 */

import { createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core";

import {
  residualIdFromSelection,
  residualListFromCatalog,
  type ResidualCatalogEntry,
} from "./residuals.js";
import {
  appendStreamRow,
  createAppShell,
  openListOverlay,
  type PrimaryOverlayKind,
} from "./shell.js";

export interface ListModalConfig {
  /** Overlay title (also the shell header base title). */
  readonly title: string;
  /** Overlay kind — drives the shell's residual styling. */
  readonly kind?: PrimaryOverlayKind;
  /** Lines shown above the overlay, in the transcript region. */
  readonly heading?: readonly string[];
  readonly options: readonly ResidualCatalogEntry[];
  readonly activeIndex?: number;
  /**
   * Claim printable keys for a `>` filter row so the list narrows as you type.
   * Off by default so other satellite lists keep j/k navigation.
   */
  readonly typeToFilter?: boolean;
  /** Renderer factory override for headless mounting in tests. */
  readonly createRenderer?: () => Promise<CliRenderer>;
}

/**
 * Mount the modal and resolve with the accepted option id, or null when the
 * operator cancels (Esc / Ctrl+C / Ctrl+D).
 */
export async function runListModal(config: ListModalConfig): Promise<string | null> {
  const renderer = config.createRenderer
    ? await config.createRenderer()
    : await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 30,
        // Reporting stays off in this satellite picker, unlike the main
        // shell, so the terminal owns drag-select and its own copy here.
        useMouse: false,
        enableMouseMovement: false,
      });

  const shell = createAppShell(renderer, { title: config.title, run: "idle" });

  for (const line of config.heading ?? []) {
    appendStreamRow(shell, { role: "system", text: line });
  }

  const { items, itemIds } = residualListFromCatalog(config.options);

  let settled = false;
  let resolveChoice: (value: string | null) => void = () => {};
  const choice = new Promise<string | null>((resolve) => {
    resolveChoice = resolve;
  });

  const teardown = (): void => {
    renderer.keyInput.off("keypress", onKey);
    try {
      shell.dispose();
    } catch {
      // already torn down
    }
    try {
      renderer.destroy();
    } catch {
      // already destroyed
    }
  };

  const settle = (id: string | null): void => {
    if (settled) return;
    settled = true;
    teardown();
    resolveChoice(id);
  };

  function onKey(key: KeyEvent): void {
    if (settled) return;
    const cancel =
      key.name === "escape" || (key.ctrl === true && (key.name === "c" || key.name === "d"));
    if (cancel) {
      key.preventDefault();
      settle(null);
    }
  }

  openListOverlay(shell, {
    kind: config.kind ?? "resume",
    title: config.title,
    items,
    itemIds,
    frameId: "overlay-list-modal",
    activeIndex: config.activeIndex ?? 0,
    ...(config.typeToFilter === true ? { typeToFilter: true } : {}),
    onAccept: (selection) => {
      const id = residualIdFromSelection(selection, itemIds);
      // Type-to-filter plants "(no matches)" with an empty id. Stay open.
      if (id === undefined || id.length === 0) return;
      settle(id);
    },
  });

  renderer.keyInput.on("keypress", onKey);

  return choice;
}
