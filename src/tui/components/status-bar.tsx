import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { AgentStatus } from "../use-stream.js";
import { color } from "../theme.js";
import type { ReasoningEffort } from "../../provider/reasoning-effort.js";

export type StatusBarProps = {
  model: string;
  status: AgentStatus;
  reasoningEffort?: ReasoningEffort | undefined;
  cwd?: string | undefined;
};

const BRAND = "Intercode";

function terminalStatusColor(status: AgentStatus): string {
  if (status === "failed") return color("danger");
  if (status === "done") return color("success");
  return color("muted");
}

function formatPath(cwd: string): string {
  const parts = cwd.split("/").filter((p) => p.length > 0);
  if (parts.length <= 2) return cwd;
  return parts.slice(-2).join("/");
}

export function StatusBar({
  model,
  status,
  reasoningEffort,
  cwd,
}: StatusBarProps): ReactNode {
  return (
    <Box flexDirection="row" paddingX={1} gap={1} overflow="hidden">
      {cwd !== undefined && (
        <>
          <Text color={color("accent")} wrap="truncate-end">{formatPath(cwd)}</Text>
          <Text color={color("dim")} dimColor>·</Text>
        </>
      )}
      <Text color={color("muted")} dimColor wrap="truncate-end">{model}</Text>
      {reasoningEffort !== undefined && <Text color={color("muted")} dimColor>{reasoningEffort}</Text>}
      {status !== "running" && status !== "idle" && (
        <Text color={terminalStatusColor(status)} wrap="truncate-end">
          {status.charAt(0).toUpperCase() + status.slice(1)}
        </Text>
      )}
      <Box flexGrow={1} />
      <Text bold color={color("brand")} wrap="truncate-end">{BRAND}</Text>
    </Box>
  );
}
