import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { AgentStatus } from "../use-stream.js";
import { color } from "../theme.js";

export type HeaderProps = {
  turnsUsed: number;
  status: AgentStatus;
  totalCost: string;
  sessionTitle: string;
  latestUserMessage: string;
  width: number;
};

const TITLE = "Intercode";
const STATUS_CELL = 8;
const COST_CELL = 10;

function statusLabel(status: AgentStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "done":
      return "Done";
    case "blocked":
      return "Blocked";
    case "failed":
      return "Failed";
  }
}

function statusColor(status: AgentStatus): string {
  switch (status) {
    case "running":
      return color("warning");
    case "done":
      return color("success");
    case "blocked":
      return color("accent");
    case "failed":
      return color("danger");
  }
}

function truncate(s: string, max: number): string {
  if (max <= 1) return s.slice(0, Math.max(0, max));
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function pad(s: string, cell: number): string {
  return s.length >= cell ? s : s + " ".repeat(cell - s.length);
}

export function Header({ turnsUsed, status, totalCost, sessionTitle, latestUserMessage, width }: HeaderProps): ReactNode {
  const showCwd = width >= 80;
  const showTurns = width >= 120;
  const cwd = process.cwd();
  const cwdMax = Math.max(12, Math.floor(width * 0.35));

  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" gap={1}>
          <Text bold color={color("brand")}>{TITLE}</Text>
          {sessionTitle.length > 0 && (
            <Text color={color("muted")}>— {truncate(sessionTitle, Math.max(12, Math.floor(width * 0.3)))}</Text>
          )}
        </Box>
        <Box flexDirection="row" gap={2}>
          <Text color={statusColor(status)}>{pad(statusLabel(status), STATUS_CELL)}</Text>
          {showTurns && <Text color={color("muted")}>{turnsUsed} turns</Text>}
          <Text color={color("success")}>{pad(totalCost, COST_CELL)}</Text>
        </Box>
      </Box>
      {showCwd && (
        <Text color={color("muted")}>{truncate(cwd, cwdMax)}</Text>
      )}
      {latestUserMessage.length > 0 && (
        <Text color={color("muted")}>▸ {truncate(latestUserMessage, Math.max(20, width - 4))}</Text>
      )}
    </Box>
  );
}
