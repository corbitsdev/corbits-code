import { Box, Text, useInput, usePaste } from "ink";
import { useState, useMemo, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { getCommand, listCommands } from "../commands/registry.js";
import type { CommandContext, CommandResult, SubcommandDefinition } from "../commands/registry.js";
import { useAtSuggestions, AtSuggestions } from "./at-mention/index.js";
import { color } from "../theme.js";

export type ChatInputProps = {
  onSubmit: (message: string) => void;
  onCommand: (result: CommandResult) => void;
  commandContext: CommandContext;
  value: string;
  onChange: (value: string) => void;
  cwd: string;
  // Border color for the input box. The slash/@ pickers render above the box.
  borderColor?: string;
  // When false, the input ignores all keystrokes. Set while an overlay or modal
  // is capturing input so keys do not leak into the prompt underneath it.
  active?: boolean;
  // Number of messages queued for delivery at the next inference boundary.
  queuedCount?: number;
  // When true, Enter interrupts the running agent with the current input.
  // Alt+Enter queues the message as a follow-up instead.
  isProcessing?: boolean;
  // Called when the user presses Enter while isProcessing is true.
  onInterrupt?: (message: string) => void;
  /** Recall previously sent messages (readline-style). Return true when handled. */
  onSentHistoryPrevious?: () => boolean;
  onSentHistoryNext?: () => boolean;
  onSentHistoryExitBrowse?: () => void;
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
  home: boolean;
  end: boolean;
  tab: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  super: boolean;
};

export type EditState = {
  value: string;
  cursor: number;
};

const isWordSeparator = (char: string): boolean => /\s/.test(char);

function previousWordStart(value: string, cursor: number): number {
  let next = cursor;
  while (next > 0 && isWordSeparator(value[next - 1]!)) next--;
  while (next > 0 && !isWordSeparator(value[next - 1]!)) next--;
  return next;
}

function nextWordEnd(value: string, cursor: number): number {
  let next = cursor;
  while (next < value.length && isWordSeparator(value[next]!)) next++;
  while (next < value.length && !isWordSeparator(value[next]!)) next++;
  return next;
}

function lineStart(value: string, cursor: number): number {
  const previousBreak = value.lastIndexOf("\n", Math.max(0, cursor - 1));
  return previousBreak === -1 ? 0 : previousBreak + 1;
}

function lineEnd(value: string, cursor: number): number {
  const nextBreak = value.indexOf("\n", cursor);
  return nextBreak === -1 ? value.length : nextBreak;
}

// Pure function: given the current editor state and pasted text, return the
// next editor state. Mirrors the paste-handler logic without the component
// side effects (usePaste, onChange, atMention.refresh).
export function applyPaste(state: EditState, text: string): EditState {
  if (text.length === 0) return state;
  const { value, cursor } = state;
  return {
    value: value.slice(0, cursor) + text + value.slice(cursor),
    cursor: cursor + text.length,
  };
}

export function applyKey(state: EditState, input: string, key: InputKey): EditState {
  // Pure function: given the current editor state, an input character, and the
  // key flags from Ink, return the next editor state. No side effects.
  // Up/down arrows are not handled here — the caller deals with them (suggestion
  // navigation or cursor-line movement) before reaching this function.
  const { value, cursor } = state;

  if (key.meta && input === "b") {
    return { value, cursor: previousWordStart(value, cursor) };
  }

  if (key.meta && input === "f") {
    return { value, cursor: nextWordEnd(value, cursor) };
  }

  if (key.leftArrow) {
    if (key.super) return { value, cursor: lineStart(value, cursor) };
    if (key.meta || input.startsWith("\u001B")) return { value, cursor: previousWordStart(value, cursor) };
    return { value, cursor: Math.max(0, cursor - 1) };
  }

  if (key.rightArrow) {
    if (key.super) return { value, cursor: lineEnd(value, cursor) };
    if (key.meta || input.startsWith("\u001B")) return { value, cursor: nextWordEnd(value, cursor) };
    return { value, cursor: Math.min(value.length, cursor + 1) };
  }

  if (key.home) {
    return { value, cursor: lineStart(value, cursor) };
  }

  if (key.end) {
    return { value, cursor: lineEnd(value, cursor) };
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

type SlashState =
  | { kind: "command"; prefix: string }
  | { kind: "subcommand"; parentName: string; prefix: string };

function parseSlashState(value: string): SlashState | null {
  if (!value.startsWith("/")) return null;
  const spaceIdx = value.indexOf(" ");
  if (spaceIdx === -1) return { kind: "command", prefix: value.slice(1) };
  const parentName = value.slice(1, spaceIdx);
  const cmd = getCommand(parentName);
  if (cmd?.subcommands !== undefined) {
    return { kind: "subcommand", parentName, prefix: value.slice(spaceIdx + 1) };
  }
  return null;
}

type Suggestion =
  | { kind: "command"; name: string; description: string }
  | { kind: "subcommand"; parentName: string; sub: SubcommandDefinition };

function slashPrefix(value: string): string | null {
  if (!value.startsWith("/")) return null;
  const spaceIdx = value.indexOf(" ");
  return spaceIdx === -1 ? value.slice(1) : null;
}

export function ChatInput({
  onSubmit,
  onCommand,
  commandContext,
  value,
  onChange,
  cwd,
  active = true,
  queuedCount = 0,
  isProcessing = false,
  onInterrupt,
  onSentHistoryPrevious,
  onSentHistoryNext,
  onSentHistoryExitBrowse,
  borderColor = color("dim"),
}: ChatInputProps): ReactNode {
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

  const atMention = useAtSuggestions(cwd);

  const slashState = useMemo(() => parseSlashState(value), [value]);
  const suggestions = useMemo((): Suggestion[] => {
    if (slashState === null) return [];
    if (slashState.kind === "command") {
      return listCommands()
        .filter((c) => c.name.startsWith(slashState.prefix))
        .map((c) => ({ kind: "command" as const, name: c.name, description: c.description }));
    }
    const cmd = getCommand(slashState.parentName);
    if (cmd?.subcommands === undefined) return [];
    return cmd.subcommands
      .filter((s) => s.name.startsWith(slashState.prefix))
      .map((s) => ({ kind: "subcommand" as const, parentName: slashState.parentName, sub: s }));
  }, [slashState]);

  // Clamp selectedIdx whenever suggestions change.
  const clampedIdx = suggestions.length > 0 ? Math.min(selectedIdx, suggestions.length - 1) : 0;
  const atClampedIdx = atMention.suggestions.length > 0
    ? Math.min(atMention.selectedIdx, atMention.suggestions.length - 1)
    : 0;

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
    atMention.clear();
  };

  // Splice a completed @path into the input at the current atState position.
  const completeAtSelection = (selected: string) => {
    if (atMention.atState === null) return;
    const { atStart, prefix } = atMention.atState;
    const trailing = selected.endsWith("/") ? "" : " ";
    // Splice replaces the @token span (from atStart to the end of the typed
    // prefix), not up to the cursor — the cursor may have been moved mid-token.
    const tokenEnd = atStart + 1 + prefix.length;
    const completed = value.slice(0, atStart) + "@" + selected + trailing + value.slice(tokenEnd);
    const newCursor = atStart + 1 + selected.length + trailing.length;
    selfSetValue.current = completed;
    onChange(completed);
    setCursor(newCursor);
    atMention.clear();
  };

  useInput((input, key) => {
    // @ picker takes priority over slash suggestions (they are mutually exclusive
    // by construction: slash state only fires when value starts with /).
    if (atMention.suggestions.length > 0) {
      if (key.upArrow) { atMention.selectUp(); return; }
      if (key.downArrow) { atMention.selectDown(); return; }
      if (key.tab || key.return) {
        const sel = atMention.suggestions[atClampedIdx];
        if (sel !== undefined) completeAtSelection(sel);
        return;
      }
      if (key.escape) {
        atMention.clear();
        return;
      }
    }

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
        if (sel !== undefined) {
          if (sel.kind === "command") {
            onChange(`/${sel.name} `);
          } else {
            onChange(`/${sel.parentName} ${sel.sub.name} `);
          }
        }
        setSelectedIdx(0);
        return;
      }
      if (key.return) {
        const sel = suggestions[clampedIdx];
        let completed = value;
        if (sel !== undefined) {
          completed = sel.kind === "command" ? `/${sel.name}` : `/${sel.parentName} ${sel.sub.name}`;
        }
        dispatchCommand(completed);
        resetField();
        return;
      }
      if (key.escape) {
        resetField();
        return;
      }
    }

    if (key.upArrow || key.downArrow) {
      const lineBreaks: number[] = [];
      for (let i = 0; i < value.length; i++) {
        if (value[i] === "\n") lineBreaks.push(i);
      }
      if (lineBreaks.length === 0) {
        if (key.upArrow && cursor === 0 && onSentHistoryPrevious?.()) return;
        if (key.downArrow && cursor === value.length && onSentHistoryNext?.()) return;
      }
      if (lineBreaks.length > 0) {
        const lineStarts: number[] = [0, ...lineBreaks.map((p) => p + 1)];
        const lineEnds: number[] = [...lineBreaks, value.length];
        let li = 0;
        for (let i = 0; i < lineStarts.length; i++) {
          if (cursor >= lineStarts[i]! && cursor <= lineEnds[i]!) { li = i; break; }
        }
        const col = cursor - lineStarts[li]!;
        if (key.upArrow && li > 0) {
          const targetStart = lineStarts[li - 1]!;
          const targetEnd = lineEnds[li - 1]!;
          setCursor(Math.min(targetStart + col, targetEnd));
          return;
        }
        if (key.downArrow && li < lineStarts.length - 1) {
          const targetStart = lineStarts[li + 1]!;
          const targetEnd = lineEnds[li + 1]!;
          setCursor(Math.min(targetStart + col, targetEnd));
          return;
        }
      }
      return;
    }

    if (isProcessing && input.includes("\u001B") && (input.includes("\r") || input.includes("\n"))) {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        onSubmit(trimmed);
        resetField();
      }
      return;
    }

    if (input === "\u001B") return;

    if (key.return && !key.shift && !key.meta) {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        if (isProcessing && onInterrupt !== undefined) {
          // Interrupt the running agent and redirect with this message.
          onInterrupt(trimmed);
        } else if (trimmed.startsWith("/")) {
          dispatchCommand(trimmed);
        } else {
          onSubmit(trimmed);
        }
        resetField();
      }
      return;
    }

    // Alt+Enter while processing queues the message as a follow-up rather than
    // inserting a newline, which is the usual meta+return behaviour.
    if (key.return && key.meta && !key.shift && isProcessing) {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        onSubmit(trimmed);
        resetField();
      }
      return;
    }

    const next = applyKey({ value, cursor }, input, key);
    if (next.value !== value) {
      onSentHistoryExitBrowse?.();
      // Record our own edit so the value-change effect does not treat the
      // echoed prop update as external and yank the cursor to the end.
      selfSetValue.current = next.value;
      onChange(next.value);
      setCursor(next.cursor);
      atMention.refresh(next.value, next.cursor);
    } else if (next.cursor !== cursor) {
      setCursor(next.cursor);
      atMention.refresh(next.value, next.cursor);
    }
  }, { isActive: active });

  // Paste handler: receives the full pasted string as one event (bracketed paste
  // mode from the terminal). Ink's usePaste operates on a separate event channel
  // from useInput, so paste characters never trickle in one-by-one through
  // useInput — this avoids 10K+ individual re-renders on a large paste.
  usePaste((text) => {
    if (!active) return;
    const next = applyPaste({ value, cursor }, text);
    if (next.value === value) return; // empty text — nothing changed
    selfSetValue.current = next.value;
    onChange(next.value);
    setCursor(next.cursor);
    atMention.refresh(next.value, next.cursor);
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

  // Slash and @ pickers are mutually exclusive: slash owns the field when value
  // starts with /, @ picker fires for any other @ token in the input.
  const showSlash = suggestions.length > 0;
  const showAt = !showSlash && atMention.suggestions.length > 0;
  const hasPrompt = value.trim().length > 0;
  const showSteerHint = isProcessing && hasPrompt;

  return (
    <Box flexDirection="column">
      {showSlash && (
        <Box flexDirection="column" paddingX={1} paddingBottom={0}>
          {suggestions.map((s, i) => {
            const label = s.kind === "command" ? `/${s.name}` : `/${s.parentName} ${s.sub.name}`;
            const desc = s.kind === "command" ? s.description : s.sub.description;
            return (
              <Box key={label} flexDirection="row" gap={1}>
                <Box width={22} flexShrink={0}>
                  <Text color={i === clampedIdx ? "cyan" : "white"} bold={i === clampedIdx} wrap="truncate-end">
                    {label}
                  </Text>
                </Box>
                <Text color="gray" wrap="truncate-end">{desc}</Text>
              </Box>
            );
          })}
        </Box>
      )}
      {showAt && (
        <AtSuggestions suggestions={atMention.suggestions} selectedIdx={atClampedIdx} />
      )}
      {showSteerHint && (
        <Box paddingX={1}>
          <Text dimColor>
            {queuedCount > 0 ? `${queuedCount} queued · Enter steer · Alt+Enter queue` : "Enter steer · Alt+Enter queue"}
          </Text>
        </Box>
      )}
      {!showSlash && !showAt && (
        <Box
          borderStyle="single"
          borderColor={borderColor}
          borderTop
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
        />
      )}
      <Box flexDirection="column" paddingX={1} marginBottom={1}>
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
