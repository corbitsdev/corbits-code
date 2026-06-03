import { Box, Text } from "ink";
import type { ContentBlock } from "../use-stream.js";
import type { ReactNode } from "react";
import { parseMarkdown } from "../markdown-parser.js";
import type { StyledSegment } from "../markdown-parser.js";
import { describeToolCall, summarizeToolResult } from "../tool-formatter.js";
import { color } from "../theme.js";

export type RenderableBlock = Exclude<ContentBlock, { type: "reply" } | { type: "plan" }>;

export type EventLogProps = {
  contentBlocks: ContentBlock[];
  scrollOffset: number;
  visibleRows: number;
  columns: number;
  thinkingExpanded: boolean;
  expandedTools: ReadonlySet<number>;
  verbose: boolean;
};

const LINE_PADDING = 2;
const SHOW_MORE = "… [show more]";

export function isRenderable(block: ContentBlock): block is RenderableBlock {
  return block.type !== "reply" && block.type !== "plan";
}

export function renderableBlocks(blocks: ContentBlock[]): RenderableBlock[] {
  return blocks.filter(isRenderable);
}

export function clampOffset(offset: number, total: number, visibleRows: number): number {
  const maxOffset = Math.max(0, total - visibleRows);
  if (offset < 0) return 0;
  if (offset > maxOffset) return maxOffset;
  return offset;
}

export function windowBlocks<T>(blocks: T[], scrollOffset: number, visibleRows: number): T[] {
  const start = clampOffset(scrollOffset, blocks.length, visibleRows);
  return blocks.slice(start, start + visibleRows);
}

export function truncateLine(text: string, columns: number, expanded: boolean): string {
  if (expanded) return text;
  const available = Math.max(8, columns - LINE_PADDING);
  if (text.length <= available) return text;
  const head = Math.max(0, available - SHOW_MORE.length);
  return text.slice(0, head) + SHOW_MORE;
}

function renderMarkdownSegments(segments: StyledSegment[]): ReactNode[] {
  return segments.map((seg, i) => {
    const textProps: { bold?: boolean; italic?: boolean; color?: string } = {};
    if (seg.bold) textProps.bold = true;
    if (seg.italic) textProps.italic = true;
    if (seg.heading === 1) {
      textProps.bold = true;
      textProps.color = color("brand");
    } else if (seg.heading === 2) {
      textProps.bold = true;
      textProps.color = color("accent");
    }
    if (seg.bullet && /^\s*•/.test(seg.text)) textProps.color = color("muted");
    if (seg.code) textProps.color = color("muted");
    return (
      <Text key={`seg-${i}`} {...textProps}>
        {seg.text}
      </Text>
    );
  });
}

function renderMarkdownLines(content: string): ReactNode {
  const lines = parseMarkdown(content);
  return (
    <Box flexDirection="column">
      {lines.map((lineSegments, i) =>
        // Each line is ONE Text with nested Text children for inline styles. Ink
        // only wraps within a single Text node, never across sibling nodes in a
        // row Box — so mounting segments as a row makes every styled word an
        // unwrappable atom. Nesting them lets the line flow and wrap normally.
        lineSegments.length === 0 ? (
          <Text key={`line-${i}`}> </Text>
        ) : (
          <Text key={`line-${i}`}>{renderMarkdownSegments(lineSegments)}</Text>
        ),
      )}
    </Box>
  );
}

function renderBlock(
  block: RenderableBlock,
  index: number,
  columns: number,
  expanded: boolean,
  thinkingExpanded: boolean,
): ReactNode {
  const key = `${block.type}-${index}`;
  switch (block.type) {
    case "thinking": {
      if (!thinkingExpanded) {
        return (
          <Text key={key} color={color("muted")} dimColor>
            ▸ thinking…
          </Text>
        );
      }
      return (
        <Box key={key} flexDirection="column">
          <Text color={color("muted")} dimColor>
            ▾ thinking
          </Text>
          <Text color={color("muted")}>{block.content}</Text>
        </Box>
      );
    }
    case "user":
      return (
        <Text key={key} color={color("success")}>
          {truncateLine(`> ${block.content}`, columns, expanded)}
        </Text>
      );
    case "text":
      return <Box key={key}>{renderMarkdownLines(block.content)}</Box>;
    case "tool_call": {
      const { display, role, summary, full, isShell } = describeToolCall(block.name, block.arguments);
      if (isShell) {
        // Lean shell: a dim prompt glyph, then the command as the headline.
        const command = expanded ? full : truncateLine(summary, columns, false);
        return (
          <Box key={key} flexDirection="column">
            <Box flexDirection="row">
              <Text color={color("muted")} dimColor>$ </Text>
              <Text color={color(role)}>{command}</Text>
            </Box>
          </Box>
        );
      }
      const argsLine = expanded ? full : truncateLine(summary, columns, false);
      return (
        <Box key={key} flexDirection="column">
          <Box flexDirection="row">
            <Text color={color(role)}>{display}</Text>
            {summary.length > 0 ? <Text> </Text> : null}
            {!expanded && summary.length > 0 ? (
              <Text color={color("muted")} dimColor>
                {argsLine}
              </Text>
            ) : null}
          </Box>
          {expanded && full.length > 0 ? (
            <Text color={color("muted")}>{full}</Text>
          ) : null}
        </Box>
      );
    }
    case "tool_result": {
      if (block.isError) {
        return (
          <Text key={key} color={color("danger")}>
            error: {truncateLine(block.content, columns, expanded)}
          </Text>
        );
      }
      const { preview, full, isJSONDocument } = summarizeToolResult(block.name, block.content);
      if (isJSONDocument) {
        return <Box key={key}>{renderMarkdownLines(full)}</Box>;
      }
      const line = expanded ? full : truncateLine(preview, columns, false);
      if (expanded) {
        return (
          <Text key={key} color={color("muted")}>
            {line}
          </Text>
        );
      }
      return (
        <Text key={key} color={color("muted")} dimColor>
          {line}
        </Text>
      );
    }
    case "error":
      return (
        <Text key={key} color={color("danger")}>
          {block.message}
        </Text>
      );
    default:
      return null;
  }
}

export function EventLog({
  contentBlocks,
  scrollOffset,
  visibleRows,
  columns,
  thinkingExpanded,
  expandedTools,
  verbose,
}: EventLogProps): ReactNode {
  const blocks = renderableBlocks(contentBlocks);

  if (blocks.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color={color("muted")}>Waiting for events...</Text>
      </Box>
    );
  }

  const start = clampOffset(scrollOffset, blocks.length, visibleRows);
  const visible = blocks.slice(start, start + visibleRows);

  return (
    <Box flexDirection="column" paddingX={1}>
      {visible.map((block, i) => {
        const absoluteIndex = start + i;
        const expanded = verbose || expandedTools.has(absoluteIndex);
        return renderBlock(block, absoluteIndex, columns, expanded, thinkingExpanded);
      })}
    </Box>
  );
}
