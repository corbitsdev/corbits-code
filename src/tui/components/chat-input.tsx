import { Box, Text, useInput } from "ink";
import { useState, useMemo, useEffect } from "react";
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

export function ChatInput({ onSubmit, onCommand, commandContext, value, onChange, active = true }: ChatInputProps): ReactNode {
  const [cursor, setCursor] = useState(value.length);
  const [selectedIdx, setSelectedIdx] = useState(0);

  // When value changes externally (e.g. tab-completion), place cursor at end.
  // We track the previous value to distinguish external changes from our own.
  useEffect(() => {
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

    if (key.return) {
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
      onChange(next.value);
      // useEffect will fire for external value changes, but for our own edits
      // we set cursor directly to avoid a render cycle with a stale cursor.
      setCursor(next.cursor);
    } else if (next.cursor !== cursor) {
      setCursor(next.cursor);
    }
  }, { isActive: active });

  // Render text split at the cursor so the cursor glyph sits inline, not
  // always trailing. Over a real character the cursor is a reverse-video cell;
  // at end-of-input it is a visible caret glyph rather than a styled space, so
  // the prompt line never ends in whitespace (which terminals — and Ink's test
  // frame — trim away, which would erase the trailing space of the "> " prompt).
  const before = value.slice(0, cursor);
  const after = value.slice(cursor);

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
        <Text>{before}</Text>
        {after.length > 0 ? (
          <>
            <Text backgroundColor="white" color="black">{after[0]}</Text>
            <Text>{after.slice(1)}</Text>
          </>
        ) : (
          <Text color="green">▏</Text>
        )}
      </Box>
    </Box>
  );
}
