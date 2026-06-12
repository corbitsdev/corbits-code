import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { AgentStatus } from "../use-stream.js";
import { color } from "../theme.js";

export type StatusBarProps = {
  provider: string;
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
  currentToolName: string | null;
  streamingType: "text" | "thinking" | "tool" | null;
  awaitingResponse: boolean;
  connectedMCPServers?: string[];
};

function statusLabel(status: AgentStatus, currentToolName: string | null, streamingType: string | null, awaitingResponse: boolean): string {
  if (status === "done") return "Done";
  if (status === "failed") return "Failed";
  if (status === "blocked") return "Blocked";
  if (status === "stopping") return "Stopping";
  if (status === "stopped") return "Stopped";
  if (currentToolName) return `Running tool: ${currentToolName}`;
  if (streamingType === "thinking") return "Thinking...";
  if (streamingType === "text") return "Streaming response";
  if (awaitingResponse) return "Waiting for model";
  return "Running";
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

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
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
  provider,
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
  currentToolName,
  streamingType,
  awaitingResponse,
  connectedMCPServers = [],
}: StatusBarProps): ReactNode {
  return (
    // flexWrap lets the fields reflow onto extra lines when the terminal is
    // narrow, so each field wraps as a whole unit instead of breaking a value
    // like the model name across rows mid-word.
    <Box flexDirection="row" flexWrap="wrap" paddingX={1}>
      <Text color={color("accent")}>{provider} · {model}</Text>
      <Divider />
      <Text color={planDeviated ? color("danger") : color("text")}>
        {formatPlan(planStep, planTotal, planPending, planDeviated)}
      </Text>
      <Divider />
      <Text color={color("muted")}>{turnsUsed} turns</Text>
      <Divider />
      <Text color={color("success")}>{cost}</Text>
      <Divider />
      <Text color={color("muted")}>Session: {tokens} tokens</Text>
      <Divider />
      <Text color={color("muted")}>{formatElapsed(elapsedMs)}</Text>
      {connectedMCPServers.length > 0 && (
        <>
          <Divider />
          <Text color={color("muted")}>MCP: {connectedMCPServers.join(", ")}</Text>
        </>
      )}
      <Divider />
      <Text color={statusColor(status)} bold>{statusLabel(status, currentToolName, streamingType, awaitingResponse)}</Text>
    </Box>
  );
}
