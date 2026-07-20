import type { ContentBlock } from "./use-stream.js";
import { editDiffFromArgs, renderDiff } from "./diff.js";

// One selectable chunk of the transcript the user can lift to the clipboard.
// `text` is what lands on the clipboard; `preview` is the one-line label shown
// while choosing.
export type CopyTarget = {
  id: string;
  label: string;
  preview: string;
  text: string;
};

function oneLine(text: string, max = 56): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function diffText(block: Extract<ContentBlock, { type: "tool_call" }>): string | null {
  const edit = editDiffFromArgs(block.name, block.arguments);
  if (edit === null) return null;
  // edit_file positions are snippet-relative with no known file offset, so
  // its copies omit the line-number gutter; write_file numbers from 1.
  return renderDiff(edit.oldText, edit.newText, 120, block.name === "write_file" ? {} : { lineNumbers: false })
    .map((line) => line.map((seg) => seg.text).join(""))
    .join("\n");
}

// Walk the transcript and surface the blocks worth copying — user prompts,
// assistant prose, tool output, and edit diffs — oldest first so the selector
// index lines up with reading order.
export function copyTargets(blocks: ContentBlock[]): CopyTarget[] {
  const targets: CopyTarget[] = [];
  for (const block of blocks) {
    if (block.type === "user") {
      targets.push({ id: block.id, label: "your message", preview: oneLine(block.content), text: block.content });
    } else if (block.type === "text" || block.type === "reply") {
      targets.push({ id: block.id, label: "assistant message", preview: oneLine(block.content), text: block.content });
    } else if (block.type === "tool_call") {
      const diff = diffText(block);
      if (diff !== null) {
        targets.push({ id: block.id, label: "edit diff", preview: oneLine(diff), text: diff });
      }
    } else if (block.type === "tool_result" && !block.isError) {
      targets.push({ id: block.id, label: `${block.name} output`, preview: oneLine(block.content), text: block.content });
    }
  }
  return targets;
}

// Render the whole conversation as portable markdown for "copy everything".
export function transcriptMarkdown(blocks: ContentBlock[]): string {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.type === "user") {
      out.push(`## You\n\n${block.content}`);
    } else if (block.type === "text" || block.type === "reply") {
      out.push(`## Assistant\n\n${block.content}`);
    } else if (block.type === "tool_call") {
      const diff = diffText(block);
      out.push(diff !== null ? `### ${block.name}\n\n\`\`\`diff\n${diff}\n\`\`\`` : `### ${block.name}\n\n\`\`\`json\n${block.arguments}\n\`\`\``);
    } else if (block.type === "tool_result") {
      const fence = block.isError ? "error" : "";
      out.push(`\`\`\`${fence}\n${block.content}\n\`\`\``);
    }
  }
  return out.join("\n\n");
}
