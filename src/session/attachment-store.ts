// Persist and rehydrate aged image attachments via the context store blob API.

import type {
  ContentBlock,
  ContextTransform,
  ConversationTurn,
  StrategyBlob,
} from "@intx/types/runtime";
import {
  attachmentIdFromBase64,
  attachmentUri,
  formatAgedImageMarker,
  parseAgedImageMarker,
} from "./attachment-uri.js";
import { type CompactionArchive } from "./compaction-archive.js";

export interface AgeImageResult {
  turn: ConversationTurn;
  blobs: StrategyBlob[];
}

/**
 * Replace base64 image blocks with a rehydratable attachment marker and emit
 * blobs the reactor will write via ContextStore.writeBlob.
 */
export interface AgeImageOptions {
  /** When set, record verified attachment blob provenance into the evidence archive. */
  archive?: CompactionArchive;
}

export async function ageImageBlocks(
  turn: ConversationTurn,
  options: AgeImageOptions = {},
): Promise<AgeImageResult> {
  if (!turn.content.some((b) => b.type === "image")) {
    return { turn, blobs: [] };
  }

  const blobs: StrategyBlob[] = [];
  const content: ConversationTurn["content"] = [];

  for (const block of turn.content) {
    if (block.type !== "image") {
      content.push(block);
      continue;
    }
    if (block.source.kind !== "base64") {
      // Already a reference or URL — leave as-is (not a base64 resend risk).
      if (options.archive !== undefined) {
        await options.archive.recordAuthorizedPayload({
          kind: "attachment",
          payload: {
            status:
              block.source.kind === "url" ? "unsupported-url" : "reference",
            sourceKind: block.source.kind,
          },
          provenance: "attachment-age:non-base64",
          gap: block.source.kind === "url",
        });
      }
      content.push(block);
      continue;
    }

    const id = await attachmentIdFromBase64(block.source.data);
    const uri = attachmentUri(id);
    // Store the original base64 as UTF-8 so rehydrate can rebuild the image
    // block without re-encoding. contentType carries the image MIME type.
    const bytes = new TextEncoder().encode(block.source.data);
    blobs.push({
      key: id,
      bytes,
      contentType: block.source.mimeType,
    });
    // recordExistingBlobReference before persistBlobs marks a false gap.
    // Callers that already wrote the blob may record after this returns.
    content.push({
      type: "text",
      text: formatAgedImageMarker({ uri, mimeType: block.source.mimeType }),
    });
  }

  return { turn: { ...turn, content }, blobs };
}

/**
 * Restore aged image markers to base64 image blocks using a blob reader.
 * Missing blobs leave the marker text in place so the turn stays well-formed.
 */
export async function rehydrateAttachmentImages(
  turns: readonly ConversationTurn[],
  readBlob: (key: string) => Promise<Uint8Array>,
): Promise<ConversationTurn[]> {
  const out: ConversationTurn[] = [];
  for (const turn of turns) {
    let changed = false;
    const content: ContentBlock[] = [];
    for (const block of turn.content) {
      if (block.type !== "text") {
        content.push(block);
        continue;
      }
      const marker = parseAgedImageMarker(block.text);
      if (marker === undefined) {
        content.push(block);
        continue;
      }
      try {
        const bytes = await readBlob(marker.id);
        const data = new TextDecoder().decode(bytes);
        content.push({
          type: "image",
          source: {
            kind: "base64",
            mimeType: marker.mimeType,
            data,
          },
        });
        changed = true;
      } catch {
        content.push(block);
      }
    }
    out.push(changed ? { ...turn, content } : turn);
  }
  return out;
}

/**
 * Pre-inference transform: restore aged attachment markers into image blocks
 * for the model prompt only. Durable history keeps the compact marker + blob.
 */
export function createAttachmentRehydrateTransform(
  readBlob: (key: string) => Promise<Uint8Array>,
): ContextTransform {
  return {
    name: "attachment-rehydrate",
    version: "1",
    async apply(turns, _ctx) {
      const output = await rehydrateAttachmentImages(turns, readBlob);
      let restored = 0;
      for (const [i, turn] of turns.entries()) {
        const out = output[i];
        if (out === undefined) {
          throw new Error("attachment rehydrate length mismatch");
        }
        const before = turn.content.filter((b) => b.type === "image").length;
        const after = out.content.filter((b) => b.type === "image").length;
        restored += Math.max(0, after - before);
      }
      return {
        output,
        record: {
          strategy: "attachment-rehydrate",
          version: "1",
          parameters: {},
          reason: restored > 0 ? "restored-attachments" : "noop",
          decisions: { restoredImageCount: restored },
        },
      };
    },
  };
}
