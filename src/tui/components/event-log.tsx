import { Box, Text } from "ink";
import type { ContentBlock } from "../use-stream.js";
import type { ReactNode } from "react";

export type EventLogProps = {
  contentBlocks: ContentBlock[];
};

function blockColor(block: ContentBlock): string {
  switch (block.type) {
    case "user":
      return "green";
    case "thinking":
      return "gray";
    case "text":
      return "white";
    case "tool_call":
      return "cyan";
    case "tool_result":
      return block.isError ? "red" : "yellow";
    case "reply":
      return "blue";
    case "error":
      return "red";
    default:
      return "white";
  }
}

function formatBlock(block: ContentBlock): string {
  switch (block.type) {
    case "user":
      return `> ${block.content}`;
    case "thinking":
      return block.content;
    case "text":
      return block.content;
    case "tool_call":
      return `${block.name}(${block.arguments})`;
    case "tool_result":
      return block.isError ? `error: ${block.content}` : block.content;
    case "reply":
      return block.content;
    case "error":
      return block.message;
    default:
      return "";
  }
}

export function EventLog({ contentBlocks }: EventLogProps): ReactNode {
  if (contentBlocks.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color="gray">Waiting for events...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {contentBlocks.map((block, index) => (
        <Text key={`${block.type}-${index}`} color={blockColor(block)}>
          {formatBlock(block)}
        </Text>
      ))}
    </Box>
  );
}
