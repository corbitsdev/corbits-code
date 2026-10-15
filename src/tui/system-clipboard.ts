/**
 * Product clipboard port over the @opentui/core clipboard service.
 *
 * Shell copy surfaces speak the fire-and-forget ClipboardPort contract (void
 * or rejected promise), while OpenTUI reports a structured host/terminal
 * result pair. Helper binaries are the host leg; the renderer's OSC 52 path
 * is the remote-session fallback. A write fails only when both legs failed,
 * so `writeClipboard` never flashes success for text nobody took.
 */

import {
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  type ClipboardService,
  type RendererClipboardBoundary,
} from "@opentui/core";

import type { ClipboardPort } from "./copy-path.js";

const IMAGE_PREFERRED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type ClipboardImageBytes =
  | { readonly ok: true; readonly mimeType: string; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: string };

export async function readSystemClipboardImage(
  service: Pick<ClipboardService, "read"> = createClipboard({
    host: createHostClipboard(),
    terminal: {
      remote: false,
      writeText: () => ({ status: "not-attempted", capability: "unsupported" }),
      clear: () => ({ status: "not-attempted", capability: "unsupported" }),
    },
  }),
): Promise<ClipboardImageBytes> {
  const result = await service.read({
    preferredTypes: IMAGE_PREFERRED_TYPES,
  });
  if (result.status === "read") {
    const mimeType = result.representation.mimeType;
    if (
      !IMAGE_PREFERRED_TYPES.includes(
        mimeType as (typeof IMAGE_PREFERRED_TYPES)[number],
      )
    ) {
      return { ok: false, reason: "clipboard did not contain an image" };
    }
    return { ok: true, mimeType, bytes: result.representation.bytes };
  }
  if (result.status === "empty") {
    return { ok: false, reason: "no image found on the clipboard" };
  }
  if (result.status === "unsupported") {
    return {
      ok: false,
      reason: "clipboard image paste is not supported here",
    };
  }
  if (result.status === "failed") {
    return { ok: false, reason: result.error.message };
  }
  return { ok: false, reason: "could not read an image from the clipboard" };
}

export function createSystemClipboard(
  renderer: RendererClipboardBoundary,
  service: ClipboardService = createClipboard({
    host: createHostClipboard(),
    terminal: createRendererClipboardAdapter(renderer),
  }),
): ClipboardPort {
  return {
    writeText: async (text: string) => {
      const result = await service.writeText(text, {
        destination: "best-available",
      });
      if (
        result.host.status !== "written" &&
        result.terminal.status !== "attempted"
      ) {
        throw new Error(
          `clipboard write failed (host: ${result.host.status}, terminal: ${result.terminal.status})`,
        );
      }
    },
  };
}
