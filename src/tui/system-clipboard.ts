/**
 * Product clipboard port over the @opentui/core clipboard service.
 *
 * The shell's copy surfaces speak the fire-and-forget ClipboardPort contract
 * (void or rejected promise), while OpenTUI reports a structured host/terminal
 * result pair. Helper binaries are the host leg; the renderer's OSC 52 path is
 * the remote-session fallback. A write only fails when both legs failed, so
 * `writeClipboard` never flashes success for text nobody took.
 */

import {
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  type ClipboardService,
  type RendererClipboardBoundary,
} from "@opentui/core";

import type { ClipboardPort } from "./copy-path.js";

export function createSystemClipboard(
  renderer: RendererClipboardBoundary,
  service: ClipboardService = createClipboard({
    host: createHostClipboard(),
    terminal: createRendererClipboardAdapter(renderer),
  }),
): ClipboardPort {
  return {
    writeText: async (text: string) => {
      const result = await service.writeText(text, { destination: "best-available" });
      if (result.host.status !== "written" && result.terminal.status !== "attempted") {
        throw new Error(
          `clipboard write failed (host: ${result.host.status}, terminal: ${result.terminal.status})`,
        );
      }
    },
  };
}
