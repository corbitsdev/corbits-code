import { Box, Text, useInput } from "ink";
import { useState, useMemo, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { getCommand, listCommands } from "../commands/registry.js";
import type { CommandContext, CommandResult } from "../commands/registry.js";

export type ChatInputProps = {
  onSubmit: (message: string) => void;
  onCommand: (result: CommandResult) => void;
  commandContext: CommandContext;
  value: string;
  onChange: (value: string) => void;
  // When false, the input ignores all keystrokes. Set while an overlay or modal
  // is capturing input so keys do not leak into the prompt underneath it.
  active?: boolean;
  // Number of messages queued for delivery at the next inference boundary.
  queuedCount?: number;
};

// The subset of Ink's Key type that applyKey needs. Keeping only what we use
// prevents coupling to Ink's full Key shape in test code.
export type InputKey = {
  leftArrow: boolean;
  rightArrow: boolean;
  backspace: boolean;
  delete: boolean;
  return: boolean;
  escape: boolean;
  upArrow: boolean;
  downArrow: boolean;
  tab: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
};

export type EditState = {
  value: string;
  cursor: number;
};

// Pure function: given the current editor state, an input character, and the
// key flags from Ink, return the next editor state. No side effects.
// Up/down arrows are intentionally ignored here — they are consumed upstream
// by suggestion-list navigation before this function is reached.
export function applyKey(state: EditState, input: string, key: InputKey): EditState {
  const { value, cursor } = state;

  if (key.leftArrow) {
    return { value, cursor: Math.max(0, cursor - 1) };
  }

  if (key.rightArrow) {
    return { value, cursor: Math.min(value.length, cursor + 1) };
  }

  if (key.backspace) {
    if (cursor === 0) return state;
    return {
      value: value.slice(0, cursor - 1) + value.slice(cursor),
      cursor: cursor - 1,
    };
  }

  if (key.delete) {
    if (cursor >= value.length) return state;
    return {
      value: value.slice(0, cursor) + value.slice(cursor + 1),
      cursor,
    };
  }

  // Shift+Enter (and Alt/Option+Enter, which some terminals send instead)
  // inserts a newline rather than submitting. Plain Enter is handled by the
  // caller as submit.
  if (key.return && (key.shift || key.meta)) {
    return {
      value: value.slice(0, cursor) + "\n" + value.slice(cursor),
      cursor: cursor + 1,
    };
  }

  // ctrl+a / ctrl+e are the readline Home and End bindings. We treat them as
  // jump-to-start / jump-to-end and ignore all other ctrl combos.
  if (key.ctrl) {
    if (input === "a") return { value, cursor: 0 };
    if (input === "e") return { value, cursor: value.length };
    return state;
  }

  // All remaining modifier combos and structural keys (return, escape, tab,
  // meta) are no-ops in the pure layer. The caller handles them separately.
  if (key.meta || key.return || key.escape || key.tab || key.upArrow || key.downArrow) {
    return state;
  }

  if (input.length === 0) return state;

  return {
    value: value.slice(0, cursor) + input + value.slice(cursor),
    cursor: cursor + input.length,
  };
}

function slashPrefix(value: string): string | null {
  if (!value.startsWith("/")) return null;
  const spaceIdx = value.indexOf(" ");
  return spaceIdx === -1 ? value.slice(1) : null;
}

export function ChatInput({ onSubmit, onCommand, commandContext, value, onChange, active = true, queuedCount = 0 }: ChatInputProps): ReactNode {
  const [cursor, setCursor] = useState(value.length);
  const [selectedIdx, setSelectedIdx] = useState(0);
  // The last value this component produced itself. Used to tell an external
  // value change (tab-completion, a programmatic set) apart from our own edit
  // echoed back through the value prop — only the former should jump the cursor
  // to the end. Without this, every keystroke snaps the cursor away from mid-line.
  const selfSetValue = useRef<string | null>(null);

  // Reset the cursor to the end only when value changes from the OUTSIDE.
  useEffect(() => {
    if (value === selfSetValue.current) return;
    setCursor(value.length);
  }, [value]);

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

  const resetField = () => {
    onChange("");
    setCursor(0);
    setSelectedIdx(0);
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
        if (sel !== undefined) { onChange(`/${sel.name} `); }
        setSelectedIdx(0);
        return;
      }
      if (key.return) {
        const sel = suggestions[clampedIdx];
        const completed = sel !== undefined ? `/${sel.name}` : value;
        dispatchCommand(completed);
        resetField();
        return;
      }
      if (key.escape) {
        resetField();
        return;
      }
    }

    if (key.return && !key.shift && !key.meta) {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        if (trimmed.startsWith("/")) {
          dispatchCommand(trimmed);
        } else {
          onSubmit(trimmed);
        }
        resetField();
      }
      return;
    }

    const next = applyKey({ value, cursor }, input, key);
    if (next.value !== value) {
      // Record our own edit so the value-change effect does not treat the
      // echoed prop update as external and yank the cursor to the end.
      selfSetValue.current = next.value;
      onChange(next.value);
      setCursor(next.cursor);
    } else if (next.cursor !== cursor) {
      setCursor(next.cursor);
    }
  }, { isActive: active });

  // Split the value into display lines and locate the cursor's line and column,
  // so a multi-line prompt (Shift+Enter) renders the caret on the right line.
  // The cursor glyph sits inline: a reverse-video cell over a real character, or
  // a visible caret at end-of-line (never trailing whitespace, which terminals
  // and Ink's test frame trim — which would eat the "> " prompt's trailing space).
  const lines = value.split("\n");
  let remaining = cursor;
  let cursorLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i]!.length;
    if (remaining <= len) {
      cursorLine = i;
      break;
    }
    remaining -= len + 1;
  }
  const cursorCol = remaining;

  return (
    <Box flexDirection="column">
      {queuedCount > 0 && (
        <Box paddingX={1}>
          <Text color="yellow">{queuedCount === 1 ? "(1 message queued)" : `(${queuedCount} messages queued)`}</Text>
        </Box>
      )}
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
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        {lines.map((line, i) => {
          const prefix = i === 0 ? "> " : "  ";
          if (i !== cursorLine) {
            return (
              <Text key={i}>
                <Text color="green">{prefix}</Text>
                {line}
              </Text>
            );
          }
          const head = line.slice(0, cursorCol);
          const atChar = line.slice(cursorCol, cursorCol + 1);
          const tail = line.slice(cursorCol + 1);
          return (
            <Text key={i}>
              <Text color="green">{prefix}</Text>
              <Text>{head}</Text>
              {atChar.length > 0 ? (
                <>
                  <Text backgroundColor="white" color="black">{atChar}</Text>
                  <Text>{tail}</Text>
                </>
              ) : (
                <Text color="green">▏</Text>
              )}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
