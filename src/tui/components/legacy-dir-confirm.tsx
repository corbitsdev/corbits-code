// TEMPORARY: prompt shown once after a `~/.intercode` -> `~/.corbits` settings
// migration, offering to delete the now-unused legacy directory. Delete this
// component alongside ../../config/migrate-legacy-dir.ts once the migration
// window closes.
import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { color } from "../theme.js";

export type LegacyDirConfirmProps = {
  onConfirm: () => void;
  onCancel: () => void;
};

export function LegacyDirConfirm({ onConfirm, onCancel }: LegacyDirConfirmProps): ReactNode {
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
    <Box flexDirection="column" paddingX={1} paddingY={1} gap={0}>
      <Text bold color={color("accent")}>
        Settings migrated from ~/.intercode to ~/.corbits.
      </Text>
      <Box flexDirection="row" gap={1}>
        <Text color={color("text")}>Delete the old ~/.intercode directory now?</Text>
        <Text color={color("muted")}>(y/n)</Text>
      </Box>
    </Box>
  );
}
