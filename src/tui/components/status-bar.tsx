import { Box, Text } from "ink";
import type { ReactNode } from "react";

export function StatusBar(): ReactNode {
  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={1} paddingY={1}>
      <Text color="gray">
        Press <Text bold>Ctrl+C</Text> to exit
      </Text>
      <Text color="gray">
        Use <Text bold>arrow keys</Text> to scroll
      </Text>
    </Box>
  );
}
