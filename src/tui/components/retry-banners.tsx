import { Box, Text } from "ink";
import type { ReactNode } from "react";

function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const totalSeconds = Math.ceil(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${String(days)}d ${String(hours)}h`;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  if (minutes > 0) return `${String(minutes)}m ${String(seconds)}s`;
  return `${String(seconds)}s`;
}

export function QuotaErrorBanner({ retryAt }: { retryAt: number }): ReactNode {
  const remaining = retryAt - Date.now();
  const expired = remaining <= 0;
  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Text color="yellow">
        {expired
          ? "Rate limit reached — retrying…"
          : `Rate limit reached — auto-retry in ${formatCountdown(remaining)}`}
      </Text>
      <Text color="cyan">{"[/agent] Switch provider"}</Text>
    </Box>
  );
}

export function GatewayRetryBanner({
  attempt,
  retryAt,
}: {
  attempt: number;
  retryAt: number;
}): ReactNode {
  const remaining = retryAt - Date.now();
  const expired = remaining <= 0;
  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Text color="yellow">
        {expired
          ? `Inference gateway overloaded — retrying (attempt ${attempt})…`
          : `Inference gateway overloaded — retrying (attempt ${attempt}) in ${formatCountdown(remaining)}`}
      </Text>
    </Box>
  );
}
