import { Box, Text } from "ink";
import type { ReactNode } from "react";

export type HeaderProps = {
  turnsUsed: number;
  status: "running" | "done" | "failed";
  totalCost: string;
  maxTurns: number;
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

export function Header({ turnsUsed, status, totalCost, maxTurns }: HeaderProps): ReactNode {
  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={1} paddingY={1}>
      <Text bold color="cyan">
        interchange-code
      </Text>
      <Box flexDirection="row" gap={2}>
        <Text color={statusColor(status)}>{status}</Text>
        <Text>
          {turnsUsed}/{maxTurns} turns
        </Text>
        <Text color="green">{totalCost}</Text>
      </Box>
    </Box>
  );
}
