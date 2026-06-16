import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { AgentStatus } from "../use-stream.js";
import { color } from "../theme.js";
import type { ReasoningEffort } from "../../provider/reasoning-effort.js";

export type StatusBarProps = {
  provider: string;
  model: string;
  cost?: string | undefined;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  contextUsage?: string | undefined;
  status: AgentStatus;
  reasoningEffort?: ReasoningEffort | undefined;
  auto?: boolean;
  agentMode?: "edit" | "auto";
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
  cacheReadTokens = 0,
  contextUsage,
  status,
  reasoningEffort,
  auto = false,
  agentMode,
}: StatusBarProps): ReactNode {
  const modeLabel = agentMode === "auto" || auto ? "AUTO" : null;
  const providerLine = reasoningEffort !== undefined
    ? `${provider} · ${model} · ${reasoningEffort.toUpperCase()}`
    : `${provider} · ${model}`;
  const modeColor = agentMode === "auto" ? color("warning") : color("accent");
  return (
    <Box flexDirection="row" paddingX={1} overflow="hidden">
      <Text color={modeColor} wrap="truncate-end">{providerLine}</Text>
      {modeLabel !== null && (
        <>
          <Divider />
          <Text bold color={modeColor} wrap="truncate-end">{modeLabel}</Text>
        </>
      )}
      {cost !== undefined && cost.length > 0 && (
        <>
          <Divider />
          <Text color={color("success")} wrap="truncate-end">{cost}</Text>
        </>
      )}
      <Divider />
      <Text color={color("muted")} wrap="truncate-end">
        ↑{inputTokens} ↓{outputTokens}{cacheReadTokens > 0 ? ` cR:${cacheReadTokens}` : ""}
      </Text>
      {contextUsage !== undefined && (
        <>
          <Divider />
          <Text color={color("muted")} wrap="truncate-end">{contextUsage}</Text>
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
