import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { AgentStatus } from "../use-stream.js";
import { color } from "../theme.js";
import type { ReasoningEffort } from "../../provider/reasoning-effort.js";

export type StatusBarProps = {
  model: string;
  status: AgentStatus;
  reasoningEffort?: ReasoningEffort | undefined;
};


function terminalStatusColor(status: AgentStatus): string {
  if (status === "failed") return color("danger");
  if (status === "done") return color("success");
  return color("muted");
}

export function StatusBar({
  model,
  status,
  reasoningEffort,
}: StatusBarProps): ReactNode {
  return (
    <Box flexDirection="row" paddingX={1} gap={1} overflow="hidden">
      <Text color={color("muted")} dimColor wrap="truncate-end">{model}</Text>
      {reasoningEffort !== undefined && <Text color={color("muted")} dimColor>{reasoningEffort}</Text>}
      {status !== "running" && status !== "idle" && (
        <Text color={terminalStatusColor(status)} wrap="truncate-end">
          {status}
        </Text>
      )}
    </Box>
  );
}
