import { Box, Text } from "ink";
import type { ReactNode } from "react";

import type { LifecycleHookStatus } from "../../hooks.js";

export type HookPanelProps = {
  hooks: LifecycleHookStatus[];
};

function formatTimestamp(value: number | undefined): string {
  if (value === undefined) return "never";
  return new Date(value).toLocaleTimeString();
}

function formatExitStatus(hook: LifecycleHookStatus): string {
  const status = hook.lastExitStatus;
  if (status === undefined) return "pending";
  if (status.signal !== null) return `signal ${status.signal}`;
  return status.code === 0 ? "ok" : `exit ${String(status.code)}`;
}

export function HookPanel({ hooks }: HookPanelProps): ReactNode {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        hooks  {hooks.length === 0 ? "none registered" : `${hooks.length} registered`}
      </Text>
      {hooks.length === 0 ? (
        <Text color="gray">~/.interchange-code/hooks</Text>
      ) : null}
      {hooks.map((hook, index) => (
        <Box key={hook.id} flexDirection="column">
          <Text color={hook.enabled ? "white" : "gray"}>
            {index + 1}. {hook.enabled ? "on " : "off"}  {hook.name}  {hook.type}
          </Text>
          <Text color="gray">
            fired {formatTimestamp(hook.lastFiredAt)}  status {formatExitStatus(hook)}
          </Text>
          <Text color="gray">{hook.path}</Text>
        </Box>
      ))}
    </Box>
  );
}
