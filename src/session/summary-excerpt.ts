// Token-budgeted compaction excerpt from the evidence archive.
//
// The live transcript is a clipped view. The archive holds the authorized
// payloads compaction is about to drop, so the summary call should read those
// rather than 400-character stubs. Budget is the control: later kinds yield
// when earlier ones fill the window. Gap rows contribute metadata only.

import type { CompactionArchive } from "./compaction-archive.js";
import type { ArchiveKind, ArchiveOccurrence } from "./compaction-archive-schema.js";
import { formatArchiveRef } from "./archive-uri.js";

export const SUMMARY_EXCERPT_DEFAULT_BUDGET_CHARS = 80_000;

const KIND_PRIORITY: readonly ArchiveKind[] = [
  "user_message",
  "attachment",
  "assistant_text",
  "tool_args",
  "tool_failure",
  "tool_result",
  "overflow_blob",
];

export type SummaryExcerptArchive = Pick<
  CompactionArchive,
  "listOccurrences" | "readAuthorizedPayload"
>;

function heading(occ: ArchiveOccurrence): string {
  const parts = [`### ${occ.kind} ${formatArchiveRef(occ.occurrenceId)}`];
  if (occ.callId !== undefined) parts.push(`call=${occ.callId}`);
  if (occ.lifecycle !== undefined) parts.push(`lifecycle=${occ.lifecycle}`);
  if (occ.gap === true) parts.push("[gap]");
  return parts.join(" ");
}

/**
 * Build a budgeted, kind-prioritized excerpt for the compaction summary call.
 * Empty archives return "" so the caller can fall back to the live transcript.
 */
export async function buildArchiveSummaryExcerpt(
  archive: SummaryExcerptArchive,
  budgetChars = SUMMARY_EXCERPT_DEFAULT_BUDGET_CHARS,
): Promise<string> {
  const occurrences = await archive.listOccurrences();
  if (occurrences.length === 0) return "";

  const byKind = new Map<ArchiveKind, ArchiveOccurrence[]>();
  for (const occ of occurrences) {
    const list = byKind.get(occ.kind);
    if (list !== undefined) list.push(occ);
    else byKind.set(occ.kind, [occ]);
  }

  const sections: string[] = [];
  let used = 0;
  let omitted = 0;

  for (const kind of KIND_PRIORITY) {
    const group = byKind.get(kind);
    if (group === undefined) continue;
    for (const occ of group) {
      const remaining = budgetChars - used;
      if (remaining <= 0) {
        omitted++;
        continue;
      }

      let body: string | undefined;
      if (occ.gap === true) {
        body = "(payload not stored)";
      } else {
        try {
          body = await archive.readAuthorizedPayload(occ.occurrenceId);
        } catch {
          omitted++;
          continue;
        }
      }

      const section = `${heading(occ)}\n${body}`;
      const separator = sections.length > 0 ? 2 : 0;
      if (section.length + separator > remaining) {
        omitted++;
        continue;
      }
      sections.push(section);
      used += section.length + separator;
    }
  }

  const excerpt = sections.join("\n\n");
  if (omitted === 0) return excerpt;
  const note = `${omitted} occurrence${omitted === 1 ? "" : "s"} omitted`;
  if (excerpt.length === 0) return note;
  return `${excerpt}\n\n${note}`;
}
