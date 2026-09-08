/**
 * Copy mode, selection copy, mouse capture toggle.
 */
import { RUNTIME_FLASH_MS } from "../runtime-notices.js";
import { buildCopyTargets } from "../copy-path.js";

import { type AppShell } from "./internals.js";
import { openListOverlay } from "./overlay-host.js";
import { setStatusFlash } from "./chrome.js";

/**
 * Enter copy mode (Alt+C / palette copy_active): freeze targets from the
 * active streamLog, open inset overlay with the last target selected.
 * Empty log → status flash only; no stream mutation.
 */
export function enterCopyMode(shell: AppShell): boolean {
  // Single host: do not stack copy over another primary overlay.
  if (shell.overlayList) return false;

  const targets = buildCopyTargets(shell.streamLog);
  if (targets.length === 0) {
    setStatusFlash(shell, "nothing to copy", { ttlMs: RUNTIME_FLASH_MS });
    return false;
  }

  shell.copyTargets = targets;
  const labels = targets.map((t) => `${t.label}: ${t.preview}`);
  openListOverlay(shell, {
    kind: "copy",
    title: "copy · Enter copies the selected item",
    items: labels,
    activeIndex: targets.length - 1,
    frameId: "copy-mode",
  });
  return true;
}

/**
 * Alt+M: take DEC mouse reporting, or hand it back to the terminal.
 * Reporting is on by default so wheel scroll and click-to-expand work;
 * releasing it restores the terminal's own drag-select and copy.
 * Returns the new enabled state, or null when the host exposes no control.
 */
export function toggleMouseCapture(shell: AppShell): boolean | null {
  const port = shell.mouseCapture;
  if (!port) {
    setStatusFlash(shell, "mouse reporting is not controllable here", {
      ttlMs: RUNTIME_FLASH_MS,
    });
    return null;
  }
  const next = !port.get();
  port.set(next);
  setStatusFlash(
    shell,
    next
      ? "Mouse captured · drag text to copy · click to expand · Alt+M for native select"
      : "Mouse released · drag to select and copy as usual · Alt+M to click rows",
    { ttlMs: RUNTIME_FLASH_MS },
  );
  return next;
}
