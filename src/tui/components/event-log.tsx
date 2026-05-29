import type { ReactNode } from "react";
import { Box, Text } from "ink";
import type { ContentBlock } from "../use-stream.js";

export type EventLogProps = {
  contentBlocks: ContentBlock[];
};

type VisibleBlock = Exclude<ContentBlock, { type: "thinking" } | { type: "reply" }>;

const maxContentLength = 900;
const longArgumentLength = 80;

function eventLabel(type: string): string {
  return type
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function blockColor(block: VisibleBlock): string {
  switch (block.type) {
    case "user":
      return "green";
    case "text":
      return "white";
    case "tool_call":
      return "cyan";
    case "tool_result":
      return block.isError ? "red" : "green";
    case "error":
      return "red";
  }
}

function blockSymbol(block: VisibleBlock): string {
  switch (block.type) {
    case "user":
      return ">";
    case "text":
      return "•";
    case "tool_call":
      return "→";
    case "tool_result":
      return block.isError ? "✕" : "✓";
    case "error":
      return "!";
  }
}

function truncateContent(content: string): string {
  if (content.length <= maxContentLength) {
    return content;
  }

  return `${content.slice(0, maxContentLength).trimEnd()} ... [show more]`;
}

function formatToolCall(block: Extract<VisibleBlock, { type: "tool_call" }>): string {
  const name = eventLabel(block.name);
  const args = truncateContent(block.arguments || "{}");

  if (args.length > longArgumentLength || args.includes("\n")) {
    return `Tool: ${name}\n  Args:\n    ${args.replaceAll("\n", "\n    ")}`;
  }

  return `Tool: ${name}\n  Args: ${args}`;
}

function formatBlock(block: VisibleBlock): string {
  switch (block.type) {
    case "user":
      return truncateContent(block.content);
    case "text":
      return truncateContent(block.content);
    case "tool_call":
      return formatToolCall(block);
    case "tool_result": {
      const status = block.isError ? "Error" : "Success";
      return `Tool: ${eventLabel(block.name)}\n  ${status}: ${truncateContent(block.content)}`;
    }
    case "error":
      return truncateContent(block.message);
  }
}

export function EventLog({ contentBlocks }: EventLogProps): ReactNode {
  const visibleBlocks = contentBlocks.filter(
    (block): block is VisibleBlock => block.type !== "thinking" && block.type !== "reply",
  );

  if (visibleBlocks.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color="gray">Waiting for events...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {visibleBlocks.map((block, index) => (
        <Box key={`${block.type}-${index}`} flexDirection="column" marginBottom={index === visibleBlocks.length - 1 ? 0 : 1}>
          {index > 0 ? <Text color="gray">─</Text> : null}
          <Text color={blockColor(block)} bold>
            {blockSymbol(block)} {eventLabel(block.type)}
          </Text>
          <Box paddingLeft={2}>
            <Text color={blockColor(block)}>{formatBlock(block)}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
