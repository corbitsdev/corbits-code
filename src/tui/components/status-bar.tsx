import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { AgentStatus } from "../use-stream.js";
import { color } from "../theme.js";
import type { ReasoningEffort } from "../../provider/reasoning-effort.js";

export type StatusBarProps = {
  provider: string;
  model: string;
  cost: string;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  status: AgentStatus;
  connectedMCPServers?: string[];
  reasoningEffort?: ReasoningEffort | undefined;
  auto?: boolean;
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
  inputTokens,
  outputTokens,
  elapsedMs,
  status,
  connectedMCPServers = [],
  reasoningEffort,
  auto = false,
}: StatusBarProps): ReactNode {
  return (
    <Box flexDirection="row" paddingX={1} overflow="hidden">
      <Text color={color("accent")} wrap="truncate-end">{provider} · {model}</Text>
      {auto && (
        <>
          <Divider />
          <Text bold color={color("warning")} wrap="truncate-end">AUTO</Text>
        </>
      )}
      {reasoningEffort !== undefined && (
        <>
          <Divider />
          <Text bold color={color("warning")} wrap="truncate-end">
            EFFORT:{reasoningEffort.toUpperCase()}
          </Text>
        </>
      )}
      <Divider />
      <Text color={color("success")} wrap="truncate-end">{cost}</Text>
      <Divider />
      <Text color={color("muted")} wrap="truncate-end">↑{inputTokens} ↓{outputTokens}</Text>
      <Divider />
      <Text color={color("muted")} wrap="truncate-end">{formatElapsed(elapsedMs)}</Text>
      {connectedMCPServers.length > 0 && (
        <>
          <Divider />
          <Text color={color("muted")} wrap="truncate-end">MCP: {connectedMCPServers.join(", ")}</Text>
        </>
      )}
      {status !== "running" && status !== "idle" && (
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
