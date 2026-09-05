/**
 * Pure prompt-composition helpers shared by the OpenTUI shell: path-mention
 * ingestion and @-mention splicing.
 * No renderer access — the shell owns paint and key wiring.
 */

import {
  findDuplicateAttachment,
  findImagePathMentions,
  type AttachImageResult,
  type PendingImageAttachment,
} from "./image-attachments.js";
import { resolveAtMentions } from "./mention-resolution.js";

export type { PendingImageAttachment };

export interface PathMentionIngestion {
  readonly text: string;
  readonly attachments: readonly PendingImageAttachment[];
}

/**
 * Replace image paths written inline in the prompt with attachment markers and
 * return only attachments whose content hash is not already in `pending` or
 * earlier in this batch. Duplicate tokens still rewrite to the kept name.
 * `load` is injected so this stays testable without touching the filesystem.
 */
export async function ingestPathMentions(
  text: string,
  cwd: string,
  load: (path: string) => Promise<AttachImageResult>,
  pending: readonly PendingImageAttachment[] = [],
): Promise<PathMentionIngestion> {
  const mentions = findImagePathMentions(text, cwd);
  if (mentions.length === 0) return { text, attachments: [] };

  const loaded = await Promise.all(mentions.map((m) => load(m.path)));
  const attachments: PendingImageAttachment[] = [];
  let out = text;
  for (const [index, mention] of mentions.entries()) {
    const result = loaded[index];
    if (result === undefined || !result.ok) continue;
    const kept =
      findDuplicateAttachment(pending, result.attachment) ??
      findDuplicateAttachment(attachments, result.attachment) ??
      result.attachment;
    if (kept === result.attachment) attachments.push(result.attachment);
    out = out.replace(mention.raw, `[Attached image: ${kept.name}]`);
  }
  return { text: out, attachments };
}

/**
 * Shared operator-prompt ingest for send and live-steer deliver: inline image
 * paths become attachments and @mentions are expanded. Does not send.
 */
export async function ingestOperatorPrompt(
  text: string,
  cwd: string,
  load: (path: string) => Promise<AttachImageResult>,
  pending: readonly PendingImageAttachment[] = [],
): Promise<PathMentionIngestion> {
  const ingested = await ingestPathMentions(text, cwd, load, pending);
  const resolved = await resolveAtMentions(ingested.text, cwd);
  return { text: resolved, attachments: [...pending, ...ingested.attachments] };
}

export interface MentionSplice {
  readonly value: string;
  readonly cursor: number;
}

/**
 * Replace the @token under the cursor with `completion`, keeping the leading
 * `@`. Directory completions keep their trailing slash so the next open lists
 * that directory.
 */
export function spliceMentionCompletion(
  value: string,
  atStart: number,
  cursor: number,
  completion: string,
): MentionSplice {
  const head = value.slice(0, atStart + 1);
  const tail = value.slice(Math.max(cursor, atStart + 1));
  return { value: `${head}${completion}${tail}`, cursor: head.length + completion.length };
}
