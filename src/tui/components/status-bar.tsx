import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { AgentStatus } from "../use-stream.js";
import { color } from "../theme.js";

export type StatusBarProps = {
  model: string;
  turnsUsed: number;
  planStep: number | null;
  planTotal: number;
  planPending: boolean;
  planDeviated: boolean;
  cost: string;
  tokens: number;
  elapsedMs: number;
  status: AgentStatus;
};

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
    case "stopping":
      return "Stopping";
    case "stopped":
      return "Stopped";
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
    case "stopping":
      return color("warning");
    case "stopped":
      return color("muted");
  }
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatPlan(step: number | null, total: number, pending: boolean, deviated: boolean): string {
  if (pending) return "Plan: pending";
  if (total === 0) return "Plan: none";
  const current = step === null ? total : Math.min(step + 1, total);
  return `Plan: ${current}/${total}${deviated ? " (off-plan)" : ""}`;
}

function Divider(): ReactNode {
  return <Text color={color("muted")}> | </Text>;
}

export function StatusBar({
  model,
  turnsUsed,
  planStep,
  planTotal,
  planPending,
  planDeviated,
  cost,
  tokens,
  elapsedMs,
  status,
}: StatusBarProps): ReactNode {
  return (
    // flexWrap lets the fields reflow onto extra lines when the terminal is
    // narrow, so each field wraps as a whole unit instead of breaking a value
    // like the model name across rows mid-word.
    <Box flexDirection="row" flexWrap="wrap" paddingX={1}>
      <Text color={color("accent")}>{model}</Text>
      <Divider />
      <Text color={planDeviated ? color("danger") : color("text")}>
        {formatPlan(planStep, planTotal, planPending, planDeviated)}
      </Text>
      <Divider />
      <Text color={color("muted")}>{turnsUsed} turns</Text>
      <Divider />
      <Text color={color("success")}>{cost}</Text>
      <Divider />
      <Text color={color("muted")}>{tokens} tok</Text>
      <Divider />
      <Text color={color("muted")}>{formatElapsed(elapsedMs)}</Text>
      <Divider />
      <Text color={statusColor(status)} bold>{statusLabel(status)}</Text>
    </Box>
  );
}
