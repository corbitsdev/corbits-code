import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { AgentStatus } from "../use-stream.js";
import { color } from "../theme.js";
import type { ReasoningEffort } from "../../provider/reasoning-effort.js";

export type StatusBarProps = {
  model: string;
  status: AgentStatus;
  reasoningEffort?: ReasoningEffort | undefined;
  auto?: boolean;
  agentMode?: "edit" | "auto";
};


function Divider(): ReactNode {
  return <Text color={color("muted")}> | </Text>;
}

function terminalStatusColor(status: AgentStatus): string {
  if (status === "failed") return color("danger");
  if (status === "done") return color("success");
  return color("muted");
}

export function StatusBar({
  model,
  status,
  reasoningEffort,
  auto = false,
  agentMode,
}: StatusBarProps): ReactNode {
  const modeLabel = agentMode === "auto" || auto ? "AUTO" : null;
  const modeColor = agentMode === "auto" ? color("warning") : color("muted");
  const modelDisplay = reasoningEffort !== undefined ? `${model} · ${reasoningEffort}` : model;
  return (
    <Box flexDirection="row" paddingX={1} overflow="hidden">
      <Text color={color("muted")} dimColor wrap="truncate-end">{modelDisplay}</Text>
      {modeLabel !== null && (
        <>
          <Divider />
          <Text bold color={modeColor} wrap="truncate-end">{modeLabel}</Text>
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
