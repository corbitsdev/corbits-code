import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import type { PlanStep } from "../use-stream.js";

export type ApprovalModalProps = {
  plan: PlanStep[];
  onApprove: () => void;
  onReject: () => void;
};

export function ApprovalModal({ plan, onApprove, onReject }: ApprovalModalProps): ReactNode {
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
    >
      <Text bold color="yellow">Plan Review — Manager Mode</Text>
      <Box marginTop={1} flexDirection="column">
        {plan.map((step, i) => (
          <Box key={i} flexDirection="row" gap={1}>
            <Text dimColor>{String(i + 1).padStart(2, " ")}.</Text>
            <Text bold>{step.file}</Text>
            <Text dimColor>—</Text>
            <Text>{step.action}</Text>
          </Box>
        ))}
        {plan.length === 0 && (
          <Text dimColor>(no steps)</Text>
        )}
      </Box>
      <Box marginTop={1} flexDirection="row" gap={3}>
        <Text color="green" bold>Enter → Approve</Text>
        <Text color="red" bold>Escape → Reject</Text>
      </Box>
    </Box>
  );
}
