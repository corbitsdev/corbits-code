import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { Mode } from "../../config.js";
import type { AgentStatus } from "../use-stream.js";
import { color } from "../theme.js";

export type StatusBarProps = {
  model: string;
  mode: Mode;
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
  mode,
  planStep,
  planTotal,
  planPending,
  planDeviated,
  cost,
  tokens,
  elapsedMs,
  status,
}: StatusBarProps): ReactNode {
  const modeLabel = mode === "manager" ? "Manager" : "Teammate";
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row">
        <Text color={color("accent")}>{model}</Text>
        <Divider />
        <Text color={color("muted")}>{modeLabel}</Text>
        <Divider />
        <Text color={planDeviated ? color("danger") : color("text")}>
          {formatPlan(planStep, planTotal, planPending, planDeviated)}
        </Text>
        <Divider />
        <Text color={color("success")}>{cost}</Text>
        <Divider />
        <Text color={color("muted")}>{tokens} tok</Text>
        <Divider />
        <Text color={color("muted")}>{formatElapsed(elapsedMs)}</Text>
        <Divider />
        <Text color={statusColor(status)} bold>{statusLabel(status)}</Text>
      </Box>
      <Box flexDirection="row">
        <Text color={color("muted")}>Ctrl+C exit · Ctrl+H hooks · Shift+Tab mode</Text>
      </Box>
    </Box>
  );
}
