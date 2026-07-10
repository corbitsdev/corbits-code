import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { color } from "../theme.js";

export type HeaderWorkflow = {
  name: string;
  stepIndex: number;
  total: number;
  label: string;
};

export type HeaderFocusedAgent = {
  agentId: string;
  description: string;
  status: string;
};

export type HeaderProps = {
  latestUserMessage: string;
  width: number;
  profile?: string;
  workflow?: HeaderWorkflow;
  // When set, the operator is observing a sub-agent session (not the parent).
  focusedAgent?: HeaderFocusedAgent;
};

function truncate(s: string, max: number): string {
  if (max <= 1) return s.slice(0, Math.max(0, max));
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function Header({ latestUserMessage, width, profile, workflow, focusedAgent }: HeaderProps): ReactNode {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row">
        <Box flexDirection="row" gap={1} flexWrap="wrap" flexGrow={1}>
          {profile !== undefined && (
            <Text color={color("muted")} dimColor>[{profile}]</Text>
          )}
          {focusedAgent !== undefined && (
            <Text color={color("accent")} bold>
              {truncate(
                `◉ ${focusedAgent.agentId}: ${focusedAgent.description} (${focusedAgent.status})`,
                Math.max(24, Math.floor(width * 0.7)),
              )}
            </Text>
          )}
          {workflow !== undefined && focusedAgent === undefined && (
            <Box>
              <Text color={color("accent")}>
                ⟳ {truncate(`${workflow.name} · ${workflow.stepIndex + 1}/${workflow.total} ${workflow.label}`, Math.max(16, Math.floor(width * 0.4)))}
              </Text>
            </Box>
          )}
        </Box>
      </Box>
      {latestUserMessage.length > 0 && focusedAgent === undefined && (
        <Text color={color("muted")} dimColor>▸ {truncate(latestUserMessage, Math.max(20, width - 4))}</Text>
      )}
      {focusedAgent !== undefined && (
        <Text color={color("muted")} dimColor>
          Observing sub-agent · parent keeps running · esc returns
        </Text>
      )}
    </Box>
  );
}
