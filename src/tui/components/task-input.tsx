import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { ReactNode } from "react";

export type TaskInputProps = {
  onSubmit: (task: string) => void;
};

export function TaskInput({ onSubmit }: TaskInputProps): ReactNode {
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (key.return) {
      onSubmit(value.trim());
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
    <Box flexDirection="column" padding={1}>
      <Text>Enter a task description and press Enter to start:</Text>
      <Box marginTop={1}>
        <Text color="green">{"> "}</Text>
        <Text>{value}</Text>
        <Text color="gray">_</Text>
      </Box>
    </Box>
  );
}
