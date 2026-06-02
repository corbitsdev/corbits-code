import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { ReactNode } from "react";
import { getCommand } from "../commands/registry.js";
import type { CommandContext, CommandResult } from "../commands/registry.js";

export type ChatInputProps = {
  onSubmit: (message: string) => void;
  onCommand: (result: CommandResult) => void;
  commandContext: CommandContext;
};

export function ChatInput({ onSubmit, onCommand, commandContext }: ChatInputProps): ReactNode {
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (key.return) {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        if (trimmed.startsWith("/")) {
          const spaceIdx = trimmed.indexOf(" ");
          const name = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
          const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);
          const def = getCommand(name);
          if (def !== undefined) {
            onCommand(def.handler(args, commandContext));
          } else {
            onCommand({ type: "message", text: `Unknown command: /${name}` });
          }
        } else {
          onSubmit(trimmed);
        }
        setValue("");
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
    <Box flexDirection="row" paddingX={1} paddingY={1}>
      <Text color="green">{"> "}</Text>
      <Text>{value}</Text>
      <Text color="gray">_</Text>
    </Box>
  );
}
