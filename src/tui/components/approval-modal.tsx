import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import type { PlanStep } from "../use-stream.js";

export type ApprovalModalProps = {
  plan: PlanStep[];
  onApprove: () => void;
  onReject: () => void;
  width?: number;
};

export function ApprovalModal({ plan, onApprove, onReject, width = 80 }: ApprovalModalProps): ReactNode {
  useInput((_input, key) => {
    if (key.return) {
      onApprove();
    }
    if (key.escape) {
      onReject();
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={2}
      paddingY={1}
      marginX={1}
      marginY={1}
      width={Math.max(24, width - 2)}
    >
      <Text bold color="yellow">Plan Review</Text>
      <Box marginTop={1} flexDirection="column">
        {plan.map((step, i) => (
          <Box key={i} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text dimColor>{String(i + 1).padStart(2, " ")}.</Text>
              <Text bold wrap="truncate-end">{step.file}</Text>
            </Box>
            <Box paddingLeft={4}>
              <Text wrap="wrap">{step.action}</Text>
            </Box>
          </Box>
        ))}
        {plan.length === 0 && (
          <Text dimColor>(no steps)</Text>
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="green" bold>Enter → Approve</Text>
        <Text color="red" bold>Escape → Reject</Text>
      </Box>
    </Box>
  );
}
