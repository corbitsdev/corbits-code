import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { ReactNode } from "react";

export type TaskPromptProps = {
  onSubmit: (task: string) => void;
};

export function TaskPrompt({ onSubmit }: TaskPromptProps): ReactNode {
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (key.return) {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        onSubmit(trimmed);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (key.ctrl && input === "c") {
      process.exit(0);
      return;
    }
    if (key.ctrl || key.meta || key.tab || key.escape) {
      return;
    }
    if (input.length > 0) {
      setValue((v) => v + input);
    }
  });

  return (
    <Box flexDirection="column" paddingX={2} gap={1}>
      <Text bold>What would you like me to do?</Text>
      <Box flexDirection="row">
        <Text color="green">{"> "}</Text>
        <Text>{value}</Text>
        <Text color="gray">_</Text>
      </Box>
    </Box>
  );
}
