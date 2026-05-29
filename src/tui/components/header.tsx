import { Box, Text } from "ink";
import type { ReactNode } from "react";

export type HeaderProps = {
  turnsUsed: number;
  status: "running" | "done" | "failed";
  totalCost: string;
  sessionTitle: string;
  latestUserMessage: string;
};

function statusColor(status: "running" | "done" | "failed"): string {
  switch (status) {
    case "running":
      return "yellow";
    case "done":
      return "green";
    case "failed":
      return "red";
    default:
      return "white";
  }
}

const TITLE_MAX = 48;
const PROMPT_MAX = 80;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export function Header({ turnsUsed, status, totalCost, sessionTitle, latestUserMessage }: HeaderProps): ReactNode {
  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" gap={1}>
          <Text bold color="cyan">interchange-code</Text>
          {sessionTitle.length > 0 && (
            <Text dimColor>— {truncate(sessionTitle, TITLE_MAX)}</Text>
          )}
        </Box>
        <Box flexDirection="row" gap={2}>
          <Text color={statusColor(status)}>{status}</Text>
          <Text dimColor>{turnsUsed} turns</Text>
          <Text color="green">{totalCost}</Text>
        </Box>
      </Box>
      {latestUserMessage.length > 0 && (
        <Text dimColor>▸ {truncate(latestUserMessage, PROMPT_MAX)}</Text>
      )}
    </Box>
  );
}
