import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { color } from "../theme.js";

export type ExitConfirmProps = {
  onConfirm: () => void;
  onCancel: () => void;
};

export function ExitConfirm({ onConfirm, onCancel }: ExitConfirmProps): ReactNode {
  useInput((input, key) => {
    if (key.return || input === "y" || input === "Y") {
      onConfirm();
      return;
    }
    if (key.escape || input === "n" || input === "N") {
      onCancel();
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color("accent")}
      paddingX={2}
      paddingY={1}
      marginX={1}
      marginY={1}
    >
      <Text bold color={color("accent")}>Exit Intercode?</Text>
      <Box marginTop={1}>
        <Text color={color("muted")}>y/N</Text>
      </Box>
    </Box>
  );
}
