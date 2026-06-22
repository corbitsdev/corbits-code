import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { color } from "../theme.js";

export type HeaderWorkflow = {
  name: string;
  stepIndex: number;
  total: number;
  label: string;
};

export type HeaderProps = {
  latestUserMessage: string;
  width: number;
  profile?: string;
  workflow?: HeaderWorkflow;
};

function truncate(s: string, max: number): string {
  if (max <= 1) return s.slice(0, Math.max(0, max));
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function Header({ latestUserMessage, width, profile, workflow }: HeaderProps): ReactNode {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row">
        <Box flexDirection="row" gap={1} flexWrap="wrap" flexGrow={1}>
          {profile !== undefined && (
            <Text color={color("muted")} dimColor>[{profile}]</Text>
          )}
          {workflow !== undefined && (
            <Box>
              <Text color={color("accent")}>
                ⟳ {truncate(`${workflow.name} · ${workflow.stepIndex + 1}/${workflow.total} ${workflow.label}`, Math.max(16, Math.floor(width * 0.4)))}
              </Text>
            </Box>
          )}
        </Box>
      </Box>
      {latestUserMessage.length > 0 && (
        <Text color={color("muted")} dimColor>▸ {truncate(latestUserMessage, Math.max(20, width - 4))}</Text>
      )}
    </Box>
  );
}
