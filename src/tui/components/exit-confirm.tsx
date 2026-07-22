import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { color } from "../theme.js";
import { PRODUCT_NAME } from "../../branding.js";

export type ExitConfirmProps = {
  onConfirm: () => void;
  onCancel: () => void;
  inline?: boolean;
};

export function ExitConfirm({ onConfirm, onCancel, inline = false }: ExitConfirmProps): ReactNode {
  useInput((input, key) => {
    if (key.return || input === "y" || input === "Y") {
      onConfirm();
      return;
    }
    if (key.escape || input === "n" || input === "N") {
      onCancel();
    }
  });

  if (inline) {
    return (
      <Box flexDirection="row" paddingX={1} paddingY={1} gap={1}>
        <Text bold color={color("danger")}>Exit {PRODUCT_NAME}?</Text>
        <Text color={color("muted")}>(y/n)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="row" gap={2} marginX={1} marginY={1}>
      <Text bold color={color("danger")}>Exit {PRODUCT_NAME}?</Text>
      <Text color={color("muted")}>(y/n)</Text>
    </Box>
  );
}
