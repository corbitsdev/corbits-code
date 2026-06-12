import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { AgentStatus } from "../use-stream.js";
import { color } from "../theme.js";

export type StatusBarProps = {
  provider: string;
  model: string;
  cost: string;
  tokens: number;
  elapsedMs: number;
  status: AgentStatus;
  connectedMCPServers?: string[];
};


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

function Divider(): ReactNode {
  return <Text color={color("muted")}> | </Text>;
}

function terminalStatusColor(status: AgentStatus): string {
  if (status === "failed") return color("danger");
  if (status === "done") return color("success");
  return color("muted");
}

export function StatusBar({
  provider,
  model,
  cost,
  tokens,
  elapsedMs,
  status,
  connectedMCPServers = [],
}: StatusBarProps): ReactNode {
  return (
    <Box flexDirection="row" paddingX={1} overflow="hidden">
      <Text color={color("accent")} wrap="truncate-end">{provider} · {model}</Text>
      <Divider />
      <Text color={color("success")} wrap="truncate-end">{cost}</Text>
      <Divider />
      <Text color={color("muted")} wrap="truncate-end">{tokens} tokens</Text>
      <Divider />
      <Text color={color("muted")} wrap="truncate-end">{formatElapsed(elapsedMs)}</Text>
      {connectedMCPServers.length > 0 && (
        <>
          <Divider />
          <Text color={color("muted")} wrap="truncate-end">MCP: {connectedMCPServers.join(", ")}</Text>
        </>
      )}
      {status !== "running" && (
        <>
          <Divider />
          <Text bold color={terminalStatusColor(status)} wrap="truncate-end">
            {status[0]!.toUpperCase() + status.slice(1)}
          </Text>
        </>
      )}
    </Box>
  );
}
