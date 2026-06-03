import { Box, Text, useInput } from "ink";
import { useState, useMemo } from "react";
import type { ReactNode } from "react";
import { getCommand, listCommands } from "../commands/registry.js";
import type { CommandContext, CommandResult } from "../commands/registry.js";

export type ChatInputProps = {
  onSubmit: (message: string) => void;
  onCommand: (result: CommandResult) => void;
  commandContext: CommandContext;
  value: string;
  onChange: (value: string) => void;
};

function slashPrefix(value: string): string | null {
  if (!value.startsWith("/")) return null;
  const spaceIdx = value.indexOf(" ");
  return spaceIdx === -1 ? value.slice(1) : null;
}

export function ChatInput({ onSubmit, onCommand, commandContext, value, onChange }: ChatInputProps): ReactNode {
  const setValue = (next: string | ((v: string) => string)): void => {
    onChange(typeof next === "function" ? next(value) : next);
  };
  const [selectedIdx, setSelectedIdx] = useState(0);

  const prefix = slashPrefix(value);
  const suggestions = useMemo(() => {
    if (prefix === null) return [];
    return listCommands().filter((c) => c.name.startsWith(prefix));
  }, [prefix]);

  // Clamp selectedIdx whenever suggestions change.
  const clampedIdx = suggestions.length > 0 ? Math.min(selectedIdx, suggestions.length - 1) : 0;

  const dispatchCommand = (raw: string) => {
    const trimmed = raw.trim();
    const spaceIdx = trimmed.indexOf(" ");
    const name = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
    const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);
    const def = getCommand(name);
    if (def !== undefined) {
      onCommand(def.handler(args, commandContext));
    } else {
      onCommand({ type: "message", text: `Unknown command: /${name}` });
    }
  };

  useInput((input, key) => {
    if (suggestions.length > 0) {
      if (key.upArrow) {
        setSelectedIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIdx((i) => Math.min(suggestions.length - 1, i + 1));
        return;
      }
      if (key.tab) {
        const sel = suggestions[clampedIdx];
        if (sel !== undefined) { setValue(`/${sel.name} `); }
        setSelectedIdx(0);
        return;
      }
      if (key.return) {
        const sel = suggestions[clampedIdx];
        const completed = sel !== undefined ? `/${sel.name}` : value;
        dispatchCommand(completed);
        setValue("");
        setSelectedIdx(0);
        return;
      }
      if (key.escape) {
        setValue("");
        setSelectedIdx(0);
        return;
      }
    }

    if (key.return) {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        if (trimmed.startsWith("/")) {
          dispatchCommand(trimmed);
        } else {
          onSubmit(trimmed);
        }
        setValue("");
        setSelectedIdx(0);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      setSelectedIdx(0);
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
      setSelectedIdx(0);
    }
  });

  return (
    <Box flexDirection="column">
      {suggestions.length > 0 && (
        <Box flexDirection="column" paddingX={1} paddingBottom={0}>
          {suggestions.map((cmd, i) => (
            <Box key={cmd.name} flexDirection="row" gap={1}>
              <Text color={i === clampedIdx ? "cyan" : "white"} bold={i === clampedIdx}>
                {`/${cmd.name}`}
              </Text>
              <Text color="gray">{cmd.description}</Text>
            </Box>
          ))}
        </Box>
      )}
      <Box flexDirection="row" paddingX={1} paddingY={1}>
        <Text color="green">{"> "}</Text>
        <Text>{value}</Text>
        <Text color="gray">_</Text>
      </Box>
    </Box>
  );
}
