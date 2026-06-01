import { Box, Text } from "ink";
import type { ContentBlock, PlanStep } from "../use-stream.js";
import type { ReactNode } from "react";
import { parseMarkdown } from "../markdown-parser.js";

export type EventLogProps = {
  contentBlocks: ContentBlock[];
  planCollapsed?: boolean;
};

function blockColor(block: ContentBlock): string {
  switch (block.type) {
    case "user":
      return "green";
    case "text":
      return "white";
    case "tool_call":
      return "cyan";
    case "tool_result":
      return block.isError ? "red" : "yellow";
    case "error":
      return "red";
    default:
      return "white";
  }
}

function renderMarkdownSegments(segments: Array<{ text: string; bold?: boolean; italic?: boolean; code?: boolean }>): ReactNode[] {
  return segments.map((seg, i) => {
    const textProps: { bold?: boolean; italic?: boolean; color?: string } = {};
    if (seg.bold) textProps.bold = true;
    if (seg.italic) textProps.italic = true;
    if (seg.code) textProps.color = "gray";
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
      {lines.map((lineSegments, i) => (
        <Box key={`line-${i}`}>
          {renderMarkdownSegments(lineSegments)}
        </Box>
      ))}
    </Box>
  );
}

function formatBlock(block: ContentBlock): string | ReactNode {
  switch (block.type) {
    case "user":
      return `> ${block.content}`;
    case "text":
      return renderMarkdownLines(block.content);
    case "tool_call":
      return `${block.name}(${block.arguments})`;
    case "tool_result":
      return block.isError ? `error: ${block.content}` : renderMarkdownLines(block.content);
    case "error":
      return block.message;
    default:
      return "";
  }
}

function formatPlanStep(step: PlanStep, index: number): string {
  const number = `${index + 1}.`;
  if (step.file.length === 0) return `${number} ${step.action}`;
  if (step.action.length === 0) return `${number} ${step.file}`;
  return `${number} ${step.file} — ${step.action}`;
}

function PlanBlock({ steps, collapsed }: { steps: PlanStep[]; collapsed: boolean }): ReactNode {
  const heading = `plan  ${steps.length} ${steps.length === 1 ? "step" : "steps"}`;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="magenta" bold>
        {heading}
        {collapsed ? "  (Ctrl+O to expand)" : ""}
      </Text>
      {!collapsed && steps.length === 0 ? (
        <Text color="gray">(no steps)</Text>
      ) : null}
      {!collapsed
        ? steps.map((step, i) => (
            <Text key={`plan-step-${i}`} color="white">
              {formatPlanStep(step, i)}
            </Text>
          ))
        : null}
    </Box>
  );
}

export function EventLog({ contentBlocks, planCollapsed = false }: EventLogProps): ReactNode {
  const firstBlock = contentBlocks[0];
  const hasPlan = firstBlock?.type === "plan";
  const planSteps = hasPlan ? (firstBlock as ContentBlock & { type: "plan" }).steps : [];
  const rest = hasPlan ? contentBlocks.slice(1) : contentBlocks;

  const visibleRest = rest.filter(
    (b): b is Exclude<ContentBlock, { type: "thinking" } | { type: "reply" } | { type: "plan" }> =>
      b.type !== "thinking" && b.type !== "reply" && b.type !== "plan",
  );

  if (!hasPlan && visibleRest.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color="gray">Waiting for events...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {hasPlan ? (
        <>
          <PlanBlock steps={planSteps} collapsed={planCollapsed} />
          <Box paddingY={0}>
            <Text color="gray">────────────────────────────────</Text>
          </Box>
        </>
      ) : null}
      {visibleRest.map((block, index) => {
        const formatted = formatBlock(block);
        const isMarkdown = typeof formatted !== "string" && (block.type === "text" || block.type === "tool_result");
        if (isMarkdown) {
          return (
            <Box key={`${block.type}-${index}`}>
              {formatted}
            </Box>
          );
        }
        return (
          <Text key={`${block.type}-${index}`} color={blockColor(block)}>
            {String(formatted)}
          </Text>
        );
      })}
    </Box>
  );
}
